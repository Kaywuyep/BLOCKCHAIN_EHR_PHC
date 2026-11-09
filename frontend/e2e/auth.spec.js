import { test, expect } from '@playwright/test';
import { AUTH_BACKEND_URL, AUTH_FRONTEND_URL } from './config.js';
import { field } from './utils.js';

// Sign-in and role-based access, against the AUTH_MODE=local backend.

test.use({ baseURL: AUTH_FRONTEND_URL });

const unique = () => Math.random().toString(36).slice(2, 8);

async function signIn(page, { role, subject, hospitalID }) {
  await page.goto('/');
  await field(page, 'Role').locator('select').selectOption(role);
  await field(page, role === 'clinician' ? 'Provider ID' : 'User ID').locator('input').fill(subject);
  if (hospitalID) await field(page, 'Hospital ID').locator('input').fill(hospitalID);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('without a session the app shows only the sign-in form, and the API refuses calls', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Admin Dashboard' })).toHaveCount(0);
  const res = await fetch(`${AUTH_BACKEND_URL}/hospitals/status`);
  expect(res.status).toBe(401);
});

test('a patient sees only the Patient App, registers, and their DID is bound to their account', async ({ page }) => {
  const subject = `amina-${unique()}`;
  await signIn(page, { role: 'patient', subject });

  await expect(page).toHaveURL(/\/patient$/);
  await expect(page.getByRole('link', { name: 'Patient App' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Clinician Portal' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Admin Dashboard' })).toHaveCount(0);

  const didInput = field(page, 'Patient DID').locator('input');
  await expect(didInput).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Register this DID on-chain' }).click();
  await expect(didInput).toHaveValue(/^did:patientchain:/);
  const did = await didInput.inputValue();

  // A reload keeps the session and the bound DID.
  await page.reload();
  await expect(field(page, 'Patient DID').locator('input')).toHaveValue(did);

  // Opening an admin URL directly does not render the admin page.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/patient$/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a clinician\'s provider and hospital are fixed to their account', async ({ page }) => {
  await signIn(page, { role: 'clinician', subject: `dr-${unique()}`, hospitalID: 'hospital-a' });
  await expect(page).toHaveURL(/\/clinician$/);
  await expect(page.getByRole('link', { name: 'Patient App' })).toHaveCount(0);
  await expect(page.locator('input[readonly][value="hospital-a"]')).toHaveCount(1);
});

test('a hospital admin lands on the Admin Dashboard', async ({ page }) => {
  await signIn(page, { role: 'hospital_admin', subject: `admin-${unique()}`, hospitalID: 'hospital-a' });
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('link', { name: 'Clinician Portal' })).toHaveCount(0);
});
