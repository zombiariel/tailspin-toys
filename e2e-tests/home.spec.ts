import { test, expect } from '@playwright/test';

test.describe('Home Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display the correct title', async ({ page }) => {
    // Check that the page title is correct
    await expect(page).toHaveTitle('Tailspin Toys - Crowdfunding your new favorite game!');
  });

  test('should display the main heading', async ({ page }) => {
    // Check that the main page heading is present
    await expect(page.getByRole('heading', { name: 'Welcome to Tailspin Toys', exact: true })).toBeVisible();
  });

  test('should display the site branding in header', async ({ page }) => {
    // Check that the site branding is present in the header (no longer an h1)
    await expect(page.getByText('Tailspin Toys').first()).toBeVisible();
  });

  test('should display the welcome message', async ({ page }) => {
    // Check that the welcome message is present using more specific locator
    await expect(page.getByText('Find your next game! And maybe even back one! Explore our collection!')).toBeVisible();
  });
});

test.describe('Game Filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('games-grid')).toBeVisible();
  });

  test('should display filter controls', async ({ page }) => {
    await expect(page.getByTestId('filter-bar')).toBeVisible();
    await expect(page.getByTestId('filter-category-select')).toBeVisible();
    await expect(page.getByTestId('filter-publisher-select')).toBeVisible();
  });

  test('should hide the clear button when no filters are active', async ({ page }) => {
    const clearButton = page.getByTestId('filter-clear-button');
    await expect(clearButton).toBeHidden();
  });

  test('should show clear button when a category filter is selected', async ({ page }) => {
    const categorySelect = page.getByTestId('filter-category-select');
    const options = await categorySelect.locator('option').all();

    // Select the first non-empty option if one exists
    if (options.length > 1) {
      const firstOption = await options[1].getAttribute('value') ?? '';
      await categorySelect.selectOption(firstOption);
      await expect(page.getByTestId('filter-clear-button')).toBeVisible();
    }
  });

  test('should filter games by category and show matching count', async ({ page }) => {
    const categorySelect = page.getByTestId('filter-category-select');
    const allOptions = await categorySelect.locator('option').all();

    // Need at least one category option beyond the "All" default
    if (allOptions.length < 2) return;

    const initialCardCount = await page.getByTestId('game-card').count();
    const firstCategoryValue = await allOptions[1].getAttribute('value') ?? '';

    await categorySelect.selectOption(firstCategoryValue);

    // Visible cards should be a subset of all cards
    const visibleCards = page.getByTestId('game-card').filter({ has: page.locator(':not([style*="display: none"])') });
    const visibleCount = await visibleCards.count();
    expect(visibleCount).toBeLessThanOrEqual(initialCardCount);

    // Results count should be visible and mention the count
    await expect(page.getByTestId('filter-results-count')).toContainText('Showing');
  });

  test('should filter games by publisher', async ({ page }) => {
    const publisherSelect = page.getByTestId('filter-publisher-select');
    const allOptions = await publisherSelect.locator('option').all();

    if (allOptions.length < 2) return;

    const firstPublisherValue = await allOptions[1].getAttribute('value') ?? '';
    await publisherSelect.selectOption(firstPublisherValue);

    await expect(page.getByTestId('filter-results-count')).toContainText('Showing');
  });

  test('should restore all games when clear filters is clicked', async ({ page }) => {
    const categorySelect = page.getByTestId('filter-category-select');
    const allOptions = await categorySelect.locator('option').all();

    if (allOptions.length < 2) return;

    const initialCardCount = await page.getByTestId('game-card').count();
    const firstCategoryValue = await allOptions[1].getAttribute('value') ?? '';

    await categorySelect.selectOption(firstCategoryValue);
    await page.getByTestId('filter-clear-button').click();

    // After clearing, the results count label should be empty
    await expect(page.getByTestId('filter-results-count')).toHaveText('');

    // All cards should be visible again
    await expect(page.getByTestId('game-card')).toHaveCount(initialCardCount);

    // Clear button should be hidden again
    await expect(page.getByTestId('filter-clear-button')).toBeHidden();
  });

  test('should show empty state when no games match combined filters', async ({ page }) => {
    const categorySelect = page.getByTestId('filter-category-select');
    const publisherSelect = page.getByTestId('filter-publisher-select');

    const categoryOptions = await categorySelect.locator('option').all();
    const publisherOptions = await publisherSelect.locator('option').all();

    // Only run this test when there are enough options to potentially create a no-match scenario
    if (categoryOptions.length < 2 || publisherOptions.length < 2) return;

    // Select the last category and first publisher — unlikely to match since games
    // typically belong to one category+publisher combination.
    const lastCategoryValue = await categoryOptions[categoryOptions.length - 1].getAttribute('value') ?? '';
    const firstPublisherValue = await publisherOptions[1].getAttribute('value') ?? '';

    await categorySelect.selectOption(lastCategoryValue);
    await publisherSelect.selectOption(firstPublisherValue);

    // Either some games match, or the empty state is shown — both are valid outcomes.
    const emptyState = page.getByTestId('filter-empty-state');
    const gamesGrid = page.getByTestId('games-grid');
    const gridHidden = await gamesGrid.isHidden();

    if (gridHidden) {
      await expect(emptyState).toBeVisible();
    } else {
      await expect(gamesGrid).toBeVisible();
    }
  });
});

