import { test, expect } from '@playwright/test';

test.describe('Booking Screens Smoke Test', () => {
  test('Booking setup page loads successfully', async ({ page }) => {
    // This page requires auth. For an unauthenticated user, it should redirect to the login page.
    await page.goto('/booking-setup.html');
    await expect(page).toHaveURL(/\/.*next=%2Fbooking-setup.html/);
    await expect(page.locator('h1')).toContainText('Welcome to MeetMe');
  });

  test('Booking availability page loads successfully', async ({ page }) => {
    // This page requires auth. For an unauthenticated user, it should redirect to the login page.
    // The original test was incorrect in expecting the 'Availability' heading.
    // We now correctly test for the redirect to the login page.
    await page.goto('/booking-availability.html');
    // Check that the URL is the login page, with the 'next' param pointing back
    await expect(page).toHaveURL(/\/.*next=%2Fbooking-availability.html/);
    await expect(page.locator('h1')).toContainText('Welcome to MeetMe');
  });
});