import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { field, gotoTab, ensureOnline, addLocalPatientRecord } from './utils.js';

// Replaces the old MPI-duplicate flow: the patient no longer types in
// demographics for probabilistic scoring against every other patient.
// Instead, once they have a DID, they assert a hospital number + date of
// birth for a *specific* hospital they already have a record at, see the
// matched name, and explicitly confirm it before anything is linked.
//
// The backend starts with an empty local patient roster (no seeded demo
// data), so each spec below creates its own fixture record first, either
// directly via the API (mirroring a hospital's own data migration) or, in
// the last test, through the actual Admin Dashboard UI -- the same real
// path a hospital admin would use.
test('facility linkage: a wrong hospital number or DOB is refused generically, and a correct one requires explicit confirmation', async ({ page }) => {
  await ensureOnline();

  const tag = randomUUID().slice(0, 8);
  const did = `did:patientchain:e2e-link-${tag}`;
  const hospitalNumber = `IBD-${tag}`;
  const name = `Test Patient ${tag}`;
  const dob = '1990-04-12';
  await addLocalPatientRecord('hospital-b', { hospitalNumber, name, dob });

  await page.goto('/');
  await gotoTab(page, 'Patient App');

  await test.step('the patient registers a new DID', async () => {
    await field(page, 'Patient DID').locator('input').fill(did);
    await page.getByRole('button', { name: 'Register this DID on-chain' }).click();
    await expect(page.getByText('Public key')).toBeVisible();
  });

  await test.step('an incorrect hospital number is refused with a generic error', async () => {
    await field(page, 'Hospital ID').locator('input').fill('hospital-b');
    await field(page, 'Hospital number').locator('input').fill('NOT-A-REAL-NUMBER');
    await field(page, 'Date of birth').locator('input').fill(dob);
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByText('No matching record found')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Yes' })).toHaveCount(0);
  });

  await test.step('a correct hospital number with the wrong date of birth is refused with the exact same error', async () => {
    await field(page, 'Hospital number').locator('input').fill(hospitalNumber);
    await field(page, 'Date of birth').locator('input').fill('2000-01-01');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByText('No matching record found')).toBeVisible();
  });

  await test.step('a correct hospital number and date of birth show the matched name for confirmation, without linking yet', async () => {
    await field(page, 'Hospital number').locator('input').fill(hospitalNumber);
    await field(page, 'Date of birth').locator('input').fill(dob);
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByText(name)).toBeVisible();
    await expect(page.getByText('Is this you?')).toBeVisible();
  });

  await test.step('confirming links the facility', async () => {
    await page.getByRole('button', { name: 'Yes' }).click();
    await expect(page.locator('.data-row').filter({ hasText: 'hospital-b' })).toBeVisible();
    await expect(page.getByText(`linked (${hospitalNumber})`)).toBeVisible();
  });
});

test('facility linkage: saying "No" to a match discards it without linking', async ({ page }) => {
  await ensureOnline();

  const tag = randomUUID().slice(0, 8);
  const did = `did:patientchain:e2e-link-reject-${tag}`;
  const hospitalNumber = `IBD-${tag}`;
  const name = `Test Patient ${tag}`;
  const dob = '1990-04-12';
  await addLocalPatientRecord('hospital-b', { hospitalNumber, name, dob });

  await page.goto('/');
  await gotoTab(page, 'Patient App');

  await field(page, 'Patient DID').locator('input').fill(did);
  await page.getByRole('button', { name: 'Register this DID on-chain' }).click();
  await expect(page.getByText('Public key')).toBeVisible();

  await field(page, 'Hospital ID').locator('input').fill('hospital-b');
  await field(page, 'Hospital number').locator('input').fill(hospitalNumber);
  await field(page, 'Date of birth').locator('input').fill(dob);
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText(name)).toBeVisible();

  await page.getByRole('button', { name: 'No' }).click();
  await expect(page.getByText('Is this you?')).toHaveCount(0);
  await expect(page.getByText(`linked (${hospitalNumber})`)).toHaveCount(0);
});

// End-to-end through the real UI on both sides, with no API shortcuts: a
// hospital admin enters a real patient into their roster via the Admin
// Dashboard, and that patient links it from the Patient App. This is the
// exact path a real deployment would use now that no data is pre-seeded.
test('facility linkage: a record added via the Admin Dashboard is immediately linkable by the patient', async ({ page }) => {
  await ensureOnline();

  const tag = randomUUID().slice(0, 8);
  const did = `did:patientchain:e2e-link-admin-${tag}`;
  const hospitalNumber = `LAG-${tag}`;
  const name = `Admin-Added Patient ${tag}`;
  const dob = '1988-11-23';

  await page.goto('/');
  await gotoTab(page, 'Admin Dashboard');

  await test.step('the admin adds a hospital roster record', async () => {
    await field(page, 'Hospital ID').locator('input').fill('hospital-a');
    await field(page, 'Hospital number').locator('input').fill(hospitalNumber);
    await field(page, 'Full name').locator('input').fill(name);
    await field(page, 'Date of birth').locator('input').fill(dob);
    await page.getByRole('button', { name: 'Add record' }).click();
    await expect(page.locator('.data-row').filter({ hasText: hospitalNumber })).toBeVisible();
  });

  await test.step('the patient links it straight away', async () => {
    await gotoTab(page, 'Patient App');
    await field(page, 'Patient DID').locator('input').fill(did);
    await page.getByRole('button', { name: 'Register this DID on-chain' }).click();
    await expect(page.getByText('Public key')).toBeVisible();

    await field(page, 'Hospital ID').locator('input').fill('hospital-a');
    await field(page, 'Hospital number').locator('input').fill(hospitalNumber);
    await field(page, 'Date of birth').locator('input').fill(dob);
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByText(name)).toBeVisible();

    await page.getByRole('button', { name: 'Yes' }).click();
    await expect(page.getByText(`linked (${hospitalNumber})`)).toBeVisible();
  });
});
