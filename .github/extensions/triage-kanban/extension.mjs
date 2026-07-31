import { createServer } from "node:http";
import { execFile as rawExecFile } from "node:child_process";
import { promisify } from "node:util";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const execFile = promisify(rawExecFile);
const servers = new Map();

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function parseRepoFullName(remoteUrl) {
    if (!remoteUrl) return null;
    const normalized = remoteUrl.trim().replace(/\.git$/i, "");
    const sshMatch = normalized.match(/[:/]([^/:]+\/[^/]+)$/);
    if (sshMatch?.[1]) {
        return sshMatch[1];
    }
    return null;
}

async function getRepoFullName() {
    if (!session.workspacePath) return null;
    try {
        const { stdout } = await execFile("git", ["config", "--get", "remote.origin.url"], {
            cwd: session.workspacePath,
        });
        return parseRepoFullName(stdout);
    } catch {
        return null;
    }
}

function summarizeBody(body) {
    const text = (body ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "No issue description was provided.";
    if (text.length <= 280) return text;
    return `${text.slice(0, 277)}...`;
}

function scoreIssue(issue) {
    const labels = Array.isArray(issue.labels)
        ? issue.labels.map((label) => String(label?.name ?? "")).filter(Boolean)
        : [];
    const now = Date.now();
    const updatedMs = Date.parse(issue.updated_at ?? "");
    const daysSinceUpdate = Number.isNaN(updatedMs) ? 0 : (now - updatedMs) / 86400000;
    const comments = Number(issue.comments ?? 0);

    let score = 0;
    const reasons = [];
    const labelText = labels.join(" ").toLowerCase();

    if (/(security|vuln|critical)/.test(labelText)) {
        score += 100;
        reasons.push("Security/critical labeling");
    }
    if (/(priority: ?high|p0|p1|high priority|urgent|blocker)/.test(labelText)) {
        score += 70;
        reasons.push("High-priority labeling");
    }
    if (/(bug|regression|incident|outage)/.test(labelText)) {
        score += 45;
        reasons.push("Likely user-impacting defect");
    }
    if (comments >= 6) {
        score += 30;
        reasons.push(`${comments} comments suggest active discussion`);
    } else if (comments >= 2) {
        score += 15;
        reasons.push(`${comments} comments indicate active interest`);
    }
    if (daysSinceUpdate >= 14) {
        score += 20;
        reasons.push("Stale for 2+ weeks and may be slipping");
    } else if (daysSinceUpdate <= 2) {
        score += 12;
        reasons.push("Recently active and likely time-sensitive");
    }
    if (!issue.assignee && (!Array.isArray(issue.assignees) || issue.assignees.length === 0)) {
        score += 10;
        reasons.push("Unassigned, so ownership is unclear");
    }

    if (reasons.length === 0) {
        reasons.push("Baseline triage priority");
    }
    return { score, reasons };
}

async function fetchIssues(repoFullName) {
    if (!repoFullName) return [];
    const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/issues?state=open&sort=updated&direction=desc&per_page=100`,
        {
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "copilot-cli-triage-kanban-extension",
            },
        },
    );

    if (!response.ok) {
        throw new Error(`GitHub API request failed (${response.status})`);
    }

    const items = await response.json();
    if (!Array.isArray(items)) return [];
    return items.filter((issue) => !issue.pull_request);
}

async function loadBoardData(repoFullNameFromInput) {
    const repoFullName = repoFullNameFromInput || (await getRepoFullName());
    const issues = await fetchIssues(repoFullName);
    const ranked = issues
        .map((issue) => ({ issue, triage: scoreIssue(issue) }))
        .sort((a, b) => b.triage.score - a.triage.score);
    const top = ranked.slice(0, 3);
    const remainder = ranked.slice(3);

    return {
        repoFullName,
        generatedAt: new Date().toISOString(),
        totalIssueCount: ranked.length,
        top,
        remainder,
        byNumber: new Map(ranked.map((entry) => [entry.issue.number, entry])),
    };
}

function cardHtml(entry, includeJustification) {
    const issue = entry.issue;
    const title = escapeHtml(issue.title ?? "Untitled");
    const body = escapeHtml(summarizeBody(issue.body));
    const labels = (issue.labels ?? [])
        .map((label) => `<span class="label">${escapeHtml(label.name)}</span>`)
        .join("");
    const url = escapeHtml(issue.html_url ?? "#");
    const reasons = includeJustification
        ? `<p class="meta"><strong>Why now:</strong> ${escapeHtml(entry.triage.reasons.join("; "))}</p>`
        : "";

    return `<article class="card">
        <h3>#${issue.number} ${title}</h3>
        <p>${body}</p>
        ${reasons}
        <div class="labels">${labels || '<span class="label">no-label</span>'}</div>
        <div class="row">
          <a href="${url}" target="_blank" rel="noreferrer noopener">Open on GitHub</a>
          <button data-issue-number="${issue.number}" class="add-btn">Add to session context</button>
        </div>
      </article>`;
}

function renderHtml(state) {
    const topCards = state.top.length
        ? state.top.map((entry) => cardHtml(entry, true)).join("")
        : '<p class="empty">No open issues found.</p>';
    const backlogCards = state.remainder.length
        ? state.remainder.map((entry) => cardHtml(entry, false)).join("")
        : '<p class="empty">No remaining issues beyond the top triage list.</p>';
    const repoText = escapeHtml(state.repoFullName ?? "unknown repository");

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Triage Kanban</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        padding: 16px;
        background: var(--background-color-default, #0f172a);
        color: var(--text-color-default, #e2e8f0);
        font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      }
      .meta { color: var(--text-color-muted, #94a3b8); margin: 0 0 10px; }
      .section-title { margin: 18px 0 10px; font-size: 18px; }
      .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
      .card {
        background: color-mix(in srgb, var(--background-color-default, #0f172a) 72%, white 28%);
        border: 1px solid var(--border-color-default, #334155);
        border-radius: 12px;
        padding: 12px;
      }
      .card h3 { margin: 0 0 8px; font-size: 15px; line-height: 1.4; }
      .card p { margin: 0 0 10px; line-height: 1.5; font-size: 13px; }
      .labels { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
      .label {
        border-radius: 999px;
        padding: 2px 8px;
        border: 1px solid var(--border-color-default, #64748b);
        font-size: 12px;
      }
      .row { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      a { color: var(--true-color-blue, #60a5fa); text-decoration: none; font-size: 13px; }
      button {
        border: 1px solid var(--border-color-default, #64748b);
        background: transparent;
        color: inherit;
        border-radius: 8px;
        padding: 6px 10px;
        cursor: pointer;
      }
      button:hover { border-color: var(--true-color-blue, #60a5fa); }
      .status { min-height: 20px; margin-top: 6px; font-size: 13px; color: var(--text-color-muted, #94a3b8); }
      .empty { border: 1px dashed var(--border-color-default, #64748b); border-radius: 10px; padding: 14px; }
    </style>
  </head>
  <body>
    <h1>Triage Kanban</h1>
    <p class="meta">Repo: <strong>${repoText}</strong> · Open issues: <strong>${state.totalIssueCount}</strong> · Generated: <strong>${escapeHtml(state.generatedAt)}</strong></p>

    <h2 class="section-title">Needs attention now (Top 3)</h2>
    <section class="grid">${topCards}</section>

    <h2 class="section-title">Everything else</h2>
    <section class="grid">${backlogCards}</section>

    <div id="status" class="status" aria-live="polite"></div>
    <script>
      const statusNode = document.getElementById("status");
      document.querySelectorAll(".add-btn").forEach((button) => {
        button.addEventListener("click", async () => {
          const issueNumber = Number(button.dataset.issueNumber);
          statusNode.textContent = "Adding issue #" + issueNumber + " to session context...";
          button.disabled = true;
          try {
            const response = await fetch("/add-to-context", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ issueNumber }),
            });
            const payload = await response.json();
            if (!response.ok) {
              statusNode.textContent = payload.error || "Unable to add issue to session context.";
              button.disabled = false;
              return;
            }
            statusNode.textContent = payload.message || "Issue added to session context.";
          } catch {
            statusNode.textContent = "Unable to add issue to session context.";
            button.disabled = false;
          }
        });
      });
    </script>
  </body>
</html>`;
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}

async function addIssueToSessionContext(instanceId, issueNumber) {
    const entry = servers.get(instanceId);
    const rankedIssue = entry?.state?.byNumber?.get(issueNumber);
    if (!rankedIssue) {
        throw new Error(`Issue #${issueNumber} was not found in the current board.`);
    }

    const issue = rankedIssue.issue;
    const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => label.name).join(", ") : "";
    const summary = summarizeBody(issue.body);
    const reason = rankedIssue.triage.reasons.join("; ");

    await session.send({
        prompt: `Please add this GitHub issue to our current working context and start from it:\n- Repo: ${entry.state.repoFullName}\n- Issue: #${issue.number} ${issue.title}\n- URL: ${issue.html_url}\n- Labels: ${labels || "none"}\n- Summary: ${summary}\n- Triage justification: ${reason}`,
    });
}

async function startServer(instanceId, input) {
    const state = await loadBoardData(input?.repoFullName);
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "POST" && req.url === "/add-to-context") {
                const body = await readJsonBody(req);
                const issueNumber = Number(body?.issueNumber);
                if (!Number.isInteger(issueNumber)) {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "application/json; charset=utf-8");
                    res.end(JSON.stringify({ error: "issueNumber must be an integer." }));
                    return;
                }
                await addIssueToSessionContext(instanceId, issueNumber);
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ message: `Issue #${issueNumber} added to session context.` }));
                return;
            }

            if (req.method === "GET" && req.url === "/") {
                const entry = servers.get(instanceId);
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(renderHtml(entry.state));
                return;
            }

            res.statusCode = 404;
            res.end("Not found");
        } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected server error" }));
        }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, state, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "triage-kanban-board",
            displayName: "Triage Kanban Board",
            description: "Highlights the top 3 issues needing immediate attention and lets you add any issue into this session context.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    repoFullName: { type: "string", description: "Optional owner/repo override to fetch issues from." },
                },
            },
            actions: [
                {
                    name: "refresh_issues",
                    description: "Refresh the issue ranking and board content.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            return { ok: false, message: "Canvas instance is not open." };
                        }
                        entry.state = await loadBoardData(entry.state?.repoFullName);
                        return {
                            ok: true,
                            topIssues: entry.state.top.map((item) => ({
                                number: item.issue.number,
                                title: item.issue.title,
                                reasons: item.triage.reasons,
                            })),
                            remainingCount: entry.state.remainder.length,
                        };
                    },
                },
                {
                    name: "add_issue_to_context",
                    description: "Programmatically add an issue from this board into the current session context.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            issueNumber: { type: "integer", minimum: 1 },
                        },
                        required: ["issueNumber"],
                    },
                    handler: async (ctx) => {
                        await addIssueToSessionContext(ctx.instanceId, ctx.input.issueNumber);
                        return { ok: true, issueNumber: ctx.input.issueNumber };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, ctx.input);
                    servers.set(ctx.instanceId, entry);
                } else if (ctx.input?.repoFullName && ctx.input.repoFullName !== entry.state.repoFullName) {
                    entry.state = await loadBoardData(ctx.input.repoFullName);
                }

                return {
                    title: "Issue Triage Kanban",
                    status: `${entry.state.top.length} urgent · ${entry.state.remainder.length} remaining`,
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (!entry) {
                    return;
                }
                servers.delete(ctx.instanceId);
                await new Promise((resolve) => entry.server.close(() => resolve()));
            },
        }),
    ],
});
