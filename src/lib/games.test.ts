import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllGames,
    getAllGameIds,
    getGameById,
    getAllCategories,
    getAllPublishers,
} from './games';

async function seedGames(db: Database, count: number): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    // Insert titles in reverse-alphabetical order to prove ordering is applied.
    for (let i = count; i >= 1; i--) {
        await db.insert(games).values({
            title: `Game ${String(i).padStart(2, '0')}`,
            description: `Description ${i}`,
            starRating: 4.2,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One' });
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });
});

describe('getAllCategories', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns an empty array when no categories exist', async () => {
        const result = await getAllCategories(db);
        expect(result).toEqual([]);
    });

    it('returns categories ordered by name', async () => {
        // Insert in reverse alphabetical order to prove ordering is applied.
        await db.insert(categories).values([
            { name: 'Trivia', description: 'cat' },
            { name: 'Adventure', description: 'cat' },
            { name: 'Strategy', description: 'cat' },
        ]);
        const result = await getAllCategories(db);
        expect(result.map((c) => c.name)).toEqual(['Adventure', 'Strategy', 'Trivia']);
    });

    it('returns categories with correct shape', async () => {
        await db.insert(categories).values({ name: 'Puzzle', description: 'cat' });
        const result = await getAllCategories(db);
        expect(result[0]).toEqual({ id: expect.any(Number), name: 'Puzzle' });
    });
});

describe('getAllPublishers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns an empty array when no publishers exist', async () => {
        const result = await getAllPublishers(db);
        expect(result).toEqual([]);
    });

    it('returns publishers ordered by name', async () => {
        // Insert in reverse alphabetical order to prove ordering is applied.
        await db.insert(publishers).values([
            { name: 'Zephyr Games', description: 'pub' },
            { name: 'Alpha Studio', description: 'pub' },
            { name: 'Moon Press', description: 'pub' },
        ]);
        const result = await getAllPublishers(db);
        expect(result.map((p) => p.name)).toEqual(['Alpha Studio', 'Moon Press', 'Zephyr Games']);
    });

    it('returns publishers with correct shape', async () => {
        await db.insert(publishers).values({ name: 'Nova Games', description: 'pub' });
        const result = await getAllPublishers(db);
        expect(result[0]).toEqual({ id: expect.any(Number), name: 'Nova Games' });
    });
});
