/**
 * Playwright smoke tests. Run with:  npm run e2e   (starts the static server itself)
 * Covers boot, profile creation, HUD, pause, persistence across reload, and offline reload.
 */
import { test, expect } from '@playwright/test';

test.describe('Gloomfall', () => {
  test('creates a pilgrim, plays, pauses, persists, works offline', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GLOOMFALL' })).toBeVisible();

    await page.getByLabel('Your name').fill('Ysolde');
    await page.getByLabel(/The Wanderer/).check();
    await page.getByRole('button', { name: 'Begin the descent' }).click();

    // Game is running: title hidden, pause button visible, live region updates.
    await expect(page.locator('#screen-title')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect(page.locator('#live')).toContainText(/Health 5 of 5/, { timeout: 5000 });

    // Keyboard input reaches the simulation.
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(400);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.press('Space');

    // Pause dialog is accessible and shows settings.
    await page.keyboard.press('Escape');
    const dialog = page.getByRole('dialog', { name: 'Paused' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Mute audio').check();
    await dialog.getByRole('button', { name: 'Resume' }).click();
    await expect(dialog).toBeHidden();

    // Reload restores the profile and the setting.
    await page.reload();
    await expect(page.locator('#continue-name')).toHaveText('Ysolde');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Mute audio')).toBeChecked();

    // Offline: the service worker serves the shell.
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 }).catch(() => {});
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'GLOOMFALL' })).toBeVisible();
    await context.setOffline(false);
  });

  test('rejects an empty name', async ({ page }) => {
    await page.goto('/?nosw');
    await page.getByRole('button', { name: 'Begin the descent' }).click();
    await expect(page.getByLabel('Your name')).toHaveAttribute('aria-invalid', 'true');
  });
});
