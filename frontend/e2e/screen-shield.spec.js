import { test, expect } from '@playwright/test';

// The screen shield replaces the app with white noise when a capture is
// likely. A browser can't observe a real OS screenshot, so these tests
// drive the signals the shield listens for.

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

test('losing window focus covers the app with white noise until focus returns', async ({ page }) => {
  await page.goto('/patient');
  await expect(page.getByTestId('screen-shield')).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const shield = page.getByTestId('screen-shield');
  await expect(shield).toBeVisible();
  await expect(shield).toContainText('Screen hidden to protect patient data');

  const noise = await noiseIsAnimating(page);
  expect(noise.changed).toBe(true);
  expect(noise.distinct).toBeGreaterThan(1);

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(shield).toHaveCount(0);
});

test('a screenshot shortcut keeps the noise up until the user clicks', async ({ page }) => {
  await page.goto('/clinician');
  await page.keyboard.press('PrintScreen');
  const shield = page.getByTestId('screen-shield');
  await expect(shield).toBeVisible();

  // Refocusing does not clear a shortcut-triggered shield...
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(shield).toBeVisible();

  // ...an explicit click does.
  await shield.click();
  await expect(shield).toHaveCount(0);
});

test('printing shows noise instead of the page', async ({ page }) => {
  await page.goto('/admin');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.screen-shield-content')).toBeHidden();
  await expect(page.locator('.screen-shield-print')).toBeVisible();
});
