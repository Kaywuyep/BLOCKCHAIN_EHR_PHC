import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { field, gotoTab, ensureOnline, registerProvider } from './utils.js';

// Section 3.6 / Figure 5: while a hospital is disconnected, an access
// request is queued locally instead of failing outright; once
// connectivity returns, the queue reconciles automatically and the
// action lands on the ledger exactly as if it had never been offline.
// Connectivity is process-global (every clinician on every device would
// see the same "hospital offline" state at once), so this always
// restores it afterwards -- other specs' requests must not silently
// start queuing because this one forgot to flip the switch back.
test('offline sync: a queued request survives a disconnect and replays on reconnect', async ({ browser }) => {
  await ensureOnline();

  const did = `did:patientchain:e2e-offline-${randomUUID().slice(0, 8)}`;
  const providerID = `dr-e2e-offline-${randomUUID().slice(0, 6)}`;
  await registerProvider(providerID, 'hospital-a');

  const adminPage = await browser.newPage();
  const clinicianPage = await browser.newPage();

  try {
    await test.step('the admin takes the hospital offline', async () => {
      await adminPage.goto('/');
      await gotoTab(adminPage, 'Admin Dashboard');
      await adminPage.getByRole('button', { name: 'Simulate hospital going offline' }).click();
      await expect(adminPage.getByText('Offline', { exact: true })).toBeVisible();
      await expect(adminPage.getByRole('button', { name: 'Restore connectivity (reconcile queue)' })).toBeVisible();
    });

    await test.step('a request made while offline is queued locally instead of failing', async () => {
      await clinicianPage.goto('/');
      await gotoTab(clinicianPage, 'Clinician Portal');
      await field(clinicianPage, 'Patient DID').locator('input').fill(did);
      await field(clinicianPage, 'Your provider ID').locator('input').fill(providerID);
      await field(clinicianPage, 'Hospital ID').locator('input').fill('hospital-a');
      await clinicianPage.getByRole('button', { name: 'Request access' }).click();
      await expect(clinicianPage.getByText(/request queued locally/)).toBeVisible();
    });

    await test.step('the admin dashboard shows the queued action', async () => {
      // AdminDashboard polls every 4s on its own; reload to force an
      // immediate refresh() instead of waiting out that interval. A full
      // reload remounts the whole app back on the default Patient tab,
      // so re-select Admin Dashboard afterwards.
      await adminPage.reload();
      await gotoTab(adminPage, 'Admin Dashboard');
      await expect(adminPage.locator('.data-row').filter({ hasText: 'REQUEST_ACCESS' }).filter({ hasText: 'QUEUED' }).first()).toBeVisible();
    });

    await test.step('restoring connectivity reconciles the queue onto the ledger', async () => {
      await adminPage.getByRole('button', { name: 'Restore connectivity (reconcile queue)' }).click();
      await expect(adminPage.getByText('Online', { exact: true })).toBeVisible();
    });

    await test.step('the request now exists on-chain, visible from the patient side', async () => {
      const patientPage = await browser.newPage();
      await patientPage.goto('/');
      await gotoTab(patientPage, 'Patient App');
      await field(patientPage, 'Patient DID').locator('input').fill(did);
      await patientPage.getByRole('button', { name: 'Load' }).click();
      await expect(patientPage.getByRole('button', { name: 'Approve (30 min)' })).toBeVisible();
      await patientPage.close();
    });
  } finally {
    await ensureOnline();
    await adminPage.close();
    await clinicianPage.close();
  }
});
