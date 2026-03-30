import { test, expect } from '@playwright/test';

test.describe('Booking Screens Smoke Test', () => {
  test('Booking setup page loads successfully', async ({ page }) => {
    // Navigate to the booking setup page
    const response = await page.goto('/booking-setup.html');

    // Check that the page loaded successfully (either 200 or 30x redirect to auth)
    expect(response.status()).toBeLessThan(400);

    // Check for the presence of the main heading
    await expect(page.locator('h1')).toContainText('Event Types');
  });

  test('Booking availability page loads successfully', async ({ page }) => {
    // Navigate to the booking availability page
    const response = await page.goto('/booking-availability.html');

    // Check that the page loaded successfully
    expect(response.status()).toBeLessThan(400);

    // Check for the presence of the main heading
    await expect(page.locator('h1')).toContainText('Availability');
  });
});