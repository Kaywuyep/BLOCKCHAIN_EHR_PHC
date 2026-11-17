import { test, expect } from '@playwright/test';
import { AUTH_FRONTEND_URL } from './config.js';
import {
  H, tag, field, gotoNav, signIn, addRosterRecord, registerClinician, patientWithNetwork, ensureOnline,
} from './utils.js';

// Section 3.6 / Figure 5: while the ledger is unreachable, an access
// request is queued locally instead of failing; once connectivity returns,
// the queue reconciles and the request lands on the ledger as if it had
// never been offline. Connectivity is process-global (only a system admin
// can flip the simulation switch), so this always restores it afterwards.
test.use({ baseURL: AUTH_FRONTEND_URL });

test('offline sync: a queued request survives a disconnect and replays on reconnect', async ({ browser }) => {
  test.setTimeout(90_000);
  await ensureOnline();

  const t = tag();
  const dob = '1979-02-14';
  const name = `Offline Patient ${t}`;
  const lagNumber = `LAG-${t}`;
  const wasNumber = `WAS-${t}`;
  const providerID = `dr-offline-${t}`;
  const patientSubject = `patient-offline-${t}`;
  await addRosterRecord(H.langtang.id, { hospitalNumber: lagNumber, name, dob });
  await addRosterRecord(H.wase.id, { hospitalNumber: wasNumber, name, dob });
  await registerClinician(H.langtang.id, providerID);
  await patientWithNetwork(patientSubject, dob, [
    { hospitalID: H.langtang.id, hospitalNumber: lagNumber },
    { hospitalID: H.wase.id, hospitalNumber: wasNumber },
  ], name);

  const adminPage = await (await browser.newContext()).newPage();
  const clinicianPage = await (await browser.newContext()).newPage();
  const queueRow = adminPage.locator('.data-row').filter({ hasText: 'REQUEST_ACCESS' });

  try {
    await test.step('the system admin takes the network offline', async () => {
      await signIn(adminPage, { role: 'system_admin', subject: `sysadmin-${t}` });
      await gotoNav(adminPage, 'Sync Status');
      await adminPage.getByRole('button', { name: 'Simulate offline' }).click();
      await expect(adminPage.locator('.stat').filter({ hasText: 'Connectivity' }).locator('.num')).toHaveText('Offline');
      await expect(adminPage.getByRole('button', { name: 'Restore connectivity' })).toBeVisible();
      // The header polls /api/health every 5 s.
      await expect(adminPage.locator('.top-status').first()).toContainText('offline', { timeout: 10_000 });
    });

    await test.step('a request made while offline is queued locally instead of failing', async () => {
      await signIn(clinicianPage, { role: 'clinician', subject: providerID, hospitalID: H.langtang.id });
      await gotoNav(clinicianPage, 'Request Access');
      await field(clinicianPage, `Patient’s hospital number at ${H.langtang.name}`).locator('input').fill(lagNumber);
      await clinicianPage.getByRole('button', { name: 'Find patient' }).click();
      await clinicianPage.locator('.cl-hospital').filter({ hasText: H.wase.name }).getByRole('checkbox').check();
      await clinicianPage.getByRole('button', { name: 'Send request to patient (1 hospital)' }).click();
      await expect(clinicianPage.locator('.cl-sent')).toContainText(`⏳ Queued (offline): ${H.wase.name}`);
    });

    await test.step('the admin sees the queued action', async () => {
      // The page refreshes on ledger events and a slow timer; nothing hits
      // the ledger while offline, so reload (the session survives).
      await adminPage.reload();
      await expect(queueRow.filter({ hasText: 'QUEUED' })).toHaveCount(1);
      await expect(adminPage.locator('.stat').filter({ hasText: 'Queued' }).locator('.num')).toHaveText('1');
    });

    await test.step('restoring connectivity reconciles the queue onto the ledger', async () => {
      await adminPage.getByRole('button', { name: 'Restore connectivity' }).click();
      await expect(adminPage.locator('.stat').filter({ hasText: 'Connectivity' }).locator('.num')).toHaveText('Online');
      await expect(adminPage.locator('.stat').filter({ hasText: 'Queued' }).locator('.num')).toHaveText('0');
      await expect(queueRow.filter({ hasText: 'SYNCED' })).toHaveCount(1);
    });

    await test.step('the request now exists on-chain: the patient can act on it, and the clinician sees it pending', async () => {
      const patientPage = await (await browser.newContext()).newPage();
      await signIn(patientPage, { role: 'patient', subject: patientSubject });
      await gotoNav(patientPage, 'Access Control');
      const request = patientPage.locator('.pa-req').filter({ hasText: providerID });
      await expect(request).toContainText(`at ${H.langtang.name} asks to see your records from ${H.wase.name}`);
      await expect(request.getByRole('button', { name: 'Approve 24 h' })).toBeVisible();
      await patientPage.context().close();

      await gotoNav(clinicianPage, 'View Records');
      const card = clinicianPage.locator('.vr-card').filter({ hasText: name });
      await expect(card.locator('.vr-status')).toHaveText('PENDING');
      await expect(card).toContainText('Awaiting patient');
    });
  } finally {
    await ensureOnline();
    await adminPage.context().close();
    await clinicianPage.context().close();
  }
});
