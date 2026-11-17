import { test, expect } from '@playwright/test';
import { navLink } from './utils.js';

// The screen shield covers the app with animated white noise when a screen
// capture is likely (components/ScreenShield.jsx): the window losing focus
// or being hidden, a screenshot shortcut the page can see, or printing.
// A browser can't observe a real OS screenshot, so these tests drive the
// signals the shield listens for. Runs against the AUTH_MODE=off pair,
// where every page opens without signing in.

async function noiseIsAnimating(page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector('[data-testid="screen-shield"] canvas');
    const ctx = canvas.getContext('2d');
    const sample = () => Array.from(ctx.getImageData(0, 0, 8, 1).data);
    const first = sample();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const second = sample();
    const greys = first.filter((_, i) => i % 4 === 0);
    return { changed: first.join() !== second.join(), distinct: new Set(greys).size };
  });
}

async function setVisibility(page, state) {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('losing window focus covers the app with white noise until focus returns', async ({ page }) => {
  await page.goto('/patient');
  await expect(navLink(page, 'My Health ID')).toBeVisible();
  await expect(page.getByTestId('screen-shield')).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const shield = page.getByTestId('screen-shield');
  await expect(shield).toBeVisible();
  await expect(shield).toContainText('Screen hidden to protect patient data');
  await expect(shield).toContainText('Return to this window to continue.');
  // The app underneath is inert while covered.
  await expect(page.locator('.screen-shield-content')).toHaveAttribute('inert', '');

  const noise = await noiseIsAnimating(page);
  expect(noise.changed).toBe(true);
  expect(noise.distinct).toBeGreaterThan(1);

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(shield).toHaveCount(0);
  await expect(page.locator('.screen-shield-content')).not.toHaveAttribute('inert', '');
});

test('a hidden window (app switcher, screen-share picker) is covered until it is visible again', async ({ page }) => {
  await page.goto('/admin');
  await expect(navLink(page, 'Overview')).toBeVisible();
  await setVisibility(page, 'hidden');
  const shield = page.getByTestId('screen-shield');
  await expect(shield).toBeVisible();
  await setVisibility(page, 'visible');
  await expect(shield).toHaveCount(0);
});

test('a screenshot shortcut raises the noise; refocusing does not clear it, a click does, and the attempt is logged', async ({ page }) => {
  await page.goto('/clinician/records');
  await expect(navLink(page, 'View Records')).toBeVisible();
  await page.keyboard.press('PrintScreen');
  const shield = page.getByTestId('screen-shield');
  await expect(shield).toBeVisible();
  await expect(shield).toContainText('Click anywhere to return.');

  // Refocusing does not clear a shortcut-triggered shield...
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(shield).toBeVisible();

  // ...an explicit click does.
  await shield.click();
  await expect(shield).toHaveCount(0);

  // The attempt is on the audit log admins review.
  await navLink(page, 'Admin Dashboard').click();
  await navLink(page, 'Screenshot Attempts').click();
  await expect(page.locator('.data-row').filter({ hasText: 'PrintScreen key · confirmed · /clinician/records' })).toHaveCount(1);
});

test('a shortcut-triggered shield clears itself after a few seconds while the window has focus', async ({ page }) => {
  await page.goto('/patient');
  await expect(navLink(page, 'My Health ID')).toBeVisible();
  await page.keyboard.press('PrintScreen');
  const shield = page.getByTestId('screen-shield');
  await expect(shield).toBeVisible();
  // HOLD_MS is 3 s: still up at 1.5 s, gone shortly after 3 s.
  await page.waitForTimeout(1500);
  await expect(shield).toBeVisible();
  await expect(shield).toHaveCount(0, { timeout: 4000 });
});

test('Cmd/Win+Shift raises the noise before the OS takes the final key; an ordinary shortcut drops it', async ({ page }) => {
  await page.goto('/patient');
  await expect(navLink(page, 'My Health ID')).toBeVisible();
  const shield = page.getByTestId('screen-shield');

  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await expect(shield).toBeVisible();
  // Cmd/Win+Shift+T is not a capture shortcut: the noise goes at once.
  await page.keyboard.press('KeyT');
  await expect(shield).toHaveCount(0);

  // Cmd/Win+Shift+4 is: the noise stays.
  await page.keyboard.press('Digit4');
  await expect(shield).toBeVisible();
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  await shield.click();
  await expect(shield).toHaveCount(0);
});

test('printing shows noise instead of the page', async ({ page }) => {
  await page.goto('/admin');
  await expect(navLink(page, 'Overview')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.screen-shield-content')).toBeHidden();
  await expect(page.locator('.screen-shield-print')).toBeVisible();
  await expect(page.locator('.screen-shield-print')).toContainText('Printing is disabled to protect patient data.');
});
