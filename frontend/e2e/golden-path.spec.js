import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { field, gotoTab, ensureOnline, registerProvider } from './utils.js';

// The core demo journey (README "Demo mode" walkthrough): a patient
// registers, a clinician requests access, the patient approves it, the
// clinician resolves the record via the FHIR Adapter, the patient revokes
// it, and the clinician is then blocked from resolving it again.
//
// The Patient App and Clinician Portal are modelled as two independent
// devices in real life (a patient's phone, a hospital terminal), and this
// SPA actually unmounts a tab's component state when you switch away from
// it -- so two separate Playwright pages stand in for the two devices,
// exactly as two separate physical devices would behave.
test('golden path: register, request, approve, resolve, revoke, blocked re-resolution', async ({ browser }) => {
  await ensureOnline();

  const did = `did:patientchain:e2e-golden-${randomUUID().slice(0, 8)}`;
  const providerID = `dr-e2e-${randomUUID().slice(0, 6)}`;
  await registerProvider(providerID, 'hospital-a');

  const patientPage = await browser.newPage();
  const clinicianPage = await browser.newPage();

  await test.step('patient registers a new PatientChain DID at their home hospital', async () => {
    await patientPage.goto('/');
    await gotoTab(patientPage, 'Patient App');
    await field(patientPage, 'Patient DID').locator('input').fill(did);
    await field(patientPage, 'Home hospital ID (optional)').locator('input').fill('hospital-a');
    await patientPage.getByRole('button', { name: 'Register this DID on-chain' }).click();
    await expect(patientPage.getByText('Public key')).toBeVisible();
  });

  await test.step('a clinician requests scoped, purpose-limited access', async () => {
    await clinicianPage.goto('/');
    await gotoTab(clinicianPage, 'Clinician Portal');
    await field(clinicianPage, 'Patient DID').locator('input').fill(did);
    await field(clinicianPage, 'Your provider ID').locator('input').fill(providerID);
    await field(clinicianPage, 'Hospital ID').locator('input').fill('hospital-a');
    await clinicianPage.getByRole('button', { name: 'Request access' }).click();
    await expect(clinicianPage.locator('.data-row').filter({ hasText: 'Status' })).toContainText('PENDING');
  });

  await test.step('the patient loads the request and approves it', async () => {
    await gotoTab(patientPage, 'Patient App');
    // Switching tabs remounts the component, so the DID field resets --
    // re-enter it and re-load, exactly as re-opening the patient's own app would.
    await field(patientPage, 'Patient DID').locator('input').fill(did);
    await patientPage.getByRole('button', { name: 'Load' }).click();
    await expect(patientPage.getByRole('button', { name: 'Approve (30 min)' })).toBeVisible();
    await patientPage.getByRole('button', { name: 'Approve (30 min)' }).click();
    await expect(patientPage.getByRole('button', { name: 'Revoke now' })).toBeVisible();
  });

  await test.step('the clinician re-checks status and resolves the record via the FHIR Adapter', async () => {
    await clinicianPage.getByRole('button', { name: 'Re-check status' }).click();
    await expect(clinicianPage.locator('.data-row').filter({ hasText: 'Status' })).toContainText('ACTIVE');
    await clinicianPage.getByRole('button', { name: 'Pull record via FHIR Adapter' }).click();
    await expect(clinicianPage.getByText(/Resolved FHIR bundles from/)).toBeVisible();
    // The bundle must be clearly attributed to the hospital's own database, never the chain.
    await expect(clinicianPage.getByText('This bundle came directly from the hospital')).toBeVisible();
  });

  await test.step('the patient revokes access', async () => {
    await patientPage.getByRole('button', { name: 'Revoke now' }).click();
    await expect(patientPage.locator('.hint').filter({ hasText: 'REVOKED' })).toBeVisible();
    await expect(patientPage.getByRole('button', { name: 'Revoke now' })).toHaveCount(0);
  });

  await test.step('the clinician can no longer resolve the record once revoked', async () => {
    await clinicianPage.getByRole('button', { name: 'Re-check status' }).click();
    await expect(clinicianPage.locator('.data-row').filter({ hasText: 'Status' })).toContainText('REVOKED');
    await expect(clinicianPage.getByRole('button', { name: 'Pull record via FHIR Adapter' })).toHaveCount(0);
  });

  await patientPage.close();
  await clinicianPage.close();
});
