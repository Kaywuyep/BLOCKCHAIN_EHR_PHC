import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { field, gotoTab, ensureOnline, registerProvider } from './utils.js';

// Section 35.1's emergency override: a clinician gets ACTIVE access
// immediately, with no patient-approval step, but the access is flagged
// distinctly and a hospital administrator must review it after the fact.
// The review queue is process-global (every hospital's pending
// break-glass accesses, not scoped to one patient), so this asserts on
// the presence of *this test's* row rather than the queue being empty.
test('break-glass: emergency access is immediate, then closed out by admin review', async ({ browser }) => {
  await ensureOnline();

  const did = `did:patientchain:e2e-bg-${randomUUID().slice(0, 8)}`;
  const providerID = `dr-e2e-bg-${randomUUID().slice(0, 6)}`;
  await registerProvider(providerID, 'hospital-a');

  const clinicianPage = await browser.newPage();
  const adminPage = await browser.newPage();

  await test.step('a clinician invokes emergency access with a justification', async () => {
    await clinicianPage.goto('/');
    await gotoTab(clinicianPage, 'Clinician Portal');
    await field(clinicianPage, 'Patient DID').locator('input').fill(did);
    await field(clinicianPage, 'Your provider ID').locator('input').fill(providerID);
    await field(clinicianPage, 'Hospital ID').locator('input').fill('hospital-a');

    // The button stays disabled without a justification -- emergency
    // override is not a free pass around accountability.
    const breakGlassButton = clinicianPage.getByRole('button', { name: 'Request emergency access now' });
    await expect(breakGlassButton).toBeDisabled();

    await field(clinicianPage, 'Justification (required)').locator('textarea').fill('Unconscious patient in ER, unknown allergy history');
    await expect(breakGlassButton).toBeEnabled();
    await breakGlassButton.click();

    await expect(clinicianPage.getByText('EMERGENCY OVERRIDE')).toBeVisible();
    await expect(clinicianPage.locator('.data-row').filter({ hasText: 'Status' })).toContainText('ACTIVE');
    // Active immediately, but flagged distinctly and still awaiting review.
    await expect(clinicianPage.getByText('BREAK_GLASS (review pending)')).toBeVisible();
  });

  await test.step('the access is immediately usable, with no patient approval step', async () => {
    await expect(clinicianPage.getByRole('button', { name: 'Pull record via FHIR Adapter' })).toBeVisible();
  });

  let row;
  await test.step('the hospital admin sees it in the pending review queue', async () => {
    await adminPage.goto('/');
    await gotoTab(adminPage, 'Admin Dashboard');
    // .data-row carries the identifying text; its parent is the whole
    // queue entry (data-row + justification + review controls) -- scope
    // to that parent so "Review notes"/"Mark reviewed" resolve to *this*
    // pending entry even if other break-glass accesses are also pending.
    row = adminPage.locator('.data-row').filter({ hasText: `${providerID} @ hospital-a → ${did}` }).locator('xpath=..');
    await expect(row).toBeVisible();
    await expect(row.getByText('Unconscious patient in ER, unknown allergy history')).toBeVisible();
  });

  await test.step('the admin reviews it, and it drops off the pending queue', async () => {
    await row.getByPlaceholder('Review notes').fill('Confirmed legitimate emergency, chart reviewed');
    await row.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(adminPage.locator('.data-row').filter({ hasText: `${providerID} @ hospital-a → ${did}` })).toHaveCount(0);
  });

  await clinicianPage.close();
  await adminPage.close();
});
