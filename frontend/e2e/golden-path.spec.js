import { test, expect } from '@playwright/test';
import { AUTH_FRONTEND_URL } from './config.js';
import {
  H, tag, field, gotoNav, signIn, createHealthId, lookUpFacility, networkPanel,
  addRosterRecord, admitViaHl7, registerClinician, ensureOnline, apiLogin, apiCall,
} from './utils.js';

// The core journey, between two facilities: a patient creates their Health
// ID at their first hospital (Langtang) and adds a second (Wase) to their
// network; a Langtang clinician finds them by Langtang's hospital number
// and asks for their Wase records; the patient approves; the clinician
// opens the Wase records (fetched from Wase, never copied); the patient
// revokes; the clinician is blocked from opening them again.
//
// Runs against the AUTH_MODE=local pair: the Clinician Portal takes the
// clinician's provider ID and hospital from their session. The patient's
// phone and the clinician's terminal are two separate browser contexts.
test.use({ baseURL: AUTH_FRONTEND_URL });

test('golden path: create Health ID, link a second hospital, request, approve, view, revoke, blocked', async ({ browser }) => {
  test.setTimeout(120_000);
  await ensureOnline();

  const t = tag();
  const dob = '1990-04-12';
  const given = `AMINA${t.toUpperCase()}`;
  const family = 'YUSUF';
  const name = `${given} ${family}`;
  const lagNumber = `LAG-${t}`;
  const wasNumber = `WAS-${t}`;
  const attending = { attendingGiven: 'HAUWA', attendingFamily: `WASEDOC${t.toUpperCase()}` };
  const providerID = `dr-gold-${t}`;

  // Each hospital's own systems hold the patient's records; Wase's EMR
  // also sends an admission (an Encounter) over HL7.
  await addRosterRecord(H.langtang.id, { hospitalNumber: lagNumber, name, dob });
  await admitViaHl7(H.wase.id, { hospitalNumber: wasNumber, family, given, dob, ...attending });
  await registerClinician(H.langtang.id, providerID, { name: 'Dr Golden Path' });

  const patientPage = await (await browser.newContext()).newPage();
  const clinicianPage = await (await browser.newContext()).newPage();

  await test.step('the patient confirms their first hospital record and creates a Health ID', async () => {
    await signIn(patientPage, { role: 'patient', subject: `patient-gold-${t}` });
    await createHealthId(patientPage, { hospitalName: H.langtang.name, hospitalNumber: lagNumber, dob, name });
    // A device key was created and its public half registered on-chain.
    await expect(patientPage.locator('.data-row').filter({ hasText: 'Signing key' })).toContainText('on this device ✓');
  });

  await test.step('the patient adds their second hospital to their network', async () => {
    await gotoNav(patientPage, 'My Hospitals');
    await expect(networkPanel(patientPage)).toContainText(H.langtang.name);
    await lookUpFacility(patientPage, { search: 'Wase', hospitalName: H.wase.name, hospitalNumber: wasNumber, name, dob });
    await expect(patientPage.getByText(name, { exact: true })).toBeVisible();
    await patientPage.getByRole('button', { name: 'Yes, add to my network' }).click();
    await expect(networkPanel(patientPage).getByRole('heading')).toHaveText('My Hospital Network (2)');
    await expect(networkPanel(patientPage)).toContainText(`Hospital No: ${wasNumber}`);
  });

  await test.step('a Langtang clinician finds the patient by their Langtang number and requests the Wase records', async () => {
    await signIn(clinicianPage, { role: 'clinician', subject: providerID, hospitalID: H.langtang.id });
    await expect(clinicianPage).toHaveURL(/\/clinician$/);
    await expect(clinicianPage.getByRole('heading', { name: 'Ready to open' })).toBeVisible();
    await gotoNav(clinicianPage, 'Request Access');
    await field(clinicianPage, `Patient’s hospital number at ${H.langtang.name}`).locator('input').fill(lagNumber);
    await clinicianPage.getByRole('button', { name: 'Find patient' }).click();
    await expect(clinicianPage.getByRole('heading', { name: new RegExp(name) })).toBeVisible();

    // Only the patient's OTHER hospitals can be requested; Langtang's own
    // records are in Langtang's EMR.
    const targets = clinicianPage.locator('.cl-hospital');
    await expect(targets).toHaveCount(1);
    await expect(targets).toContainText(H.wase.name);
    await targets.getByRole('checkbox').check();
    await clinicianPage.getByRole('checkbox', { name: 'Encounters' }).check();
    await clinicianPage.getByRole('button', { name: 'Send request to patient (1 hospital)' }).click();
    await expect(clinicianPage.locator('.cl-sent')).toContainText(`✓ Request sent: ${H.wase.name}`);
  });

  await test.step('the patient is notified, sees the request in Access Control and approves it', async () => {
    // The pending-request badge updates from the ledger event stream.
    await expect(patientPage.locator('.sidebar-badge')).toHaveText('1');
    await gotoNav(patientPage, 'Access Control');
    const request = patientPage.locator('.pa-req').filter({ hasText: 'Dr Golden Path' }); // names, not IDs, on screen
    await expect(request).toContainText(`at ${H.langtang.name} asks to see your records from ${H.wase.name}`);
    await expect(request).toContainText('Encounter');
    await request.getByRole('button', { name: 'Approve 24 h' }).click();
    const active = patientPage.locator('.pa-active').filter({ hasText: 'Dr Golden Path' });
    await expect(active).toContainText(`Dr Golden Path (Physician) at ${H.langtang.name}`);
    await expect(active).toContainText('signed by you ✓');
  });

  const card = clinicianPage.locator('.vr-card').filter({ hasText: name });
  await test.step('the clinician opens the Wase records, fetched from Wase and logged', async () => {
    await gotoNav(clinicianPage, 'View Records');
    await expect(card.locator('.vr-status')).toHaveText('Active');
    await expect(card).toContainText(`Records at ${H.wase.name} (No. ${wasNumber})`);
    await card.locator('button.vr-toggle', { hasText: 'Open records' }).click();
    await expect(card.getByText('Access verified on the blockchain and logged')).toBeVisible();
    // The Encounter Wase's EMR sent over HL7, with its attending clinician.
    const encounter = card.locator('.vr-record.type-Encounter');
    await expect(encounter).toHaveCount(1);
    await expect(encounter).toContainText(`${attending.attendingGiven} ${attending.attendingFamily}`);
  });

  await test.step('the access is on the patient\'s audit trail', async () => {
    await gotoNav(patientPage, 'Audit Trail');
    await expect(patientPage.locator('.data-row').filter({ hasText: 'RECORD_ACCESSED — Dr Golden Path' })).toBeVisible();
  });

  await test.step('the patient revokes access', async () => {
    await gotoNav(patientPage, 'Access Control');
    await patientPage.locator('.pa-active').filter({ hasText: 'Dr Golden Path' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(patientPage.locator('.pa-active').filter({ hasText: 'Dr Golden Path' })).toHaveCount(0);
    await expect(patientPage.locator('.data-row').filter({ hasText: 'Dr Golden Path' })).toContainText('REVOKED');
  });

  await test.step('the clinician can no longer open the records', async () => {
    // The open view closes as soon as the ledger reports the revocation,
    // and a revoked grant leaves the "Current" list.
    await expect(card).toHaveCount(0);
    await clinicianPage.locator('.vr-tabs').getByRole('button', { name: /^All/ }).click();
    await expect(card.locator('.vr-status')).toHaveText('Ended by patient');
    await expect(card).toContainText('Ended by patient');
    await expect(card).toContainText('No access');
    await expect(card.locator('button.vr-toggle', { hasText: 'Open records' })).toHaveCount(0);

    // And the gateway itself refuses, whatever the UI shows.
    const token = await apiLogin({ role: 'clinician', subject: providerID, hospitalID: H.langtang.id });
    const grants = (await apiCall(token, 'GET', '/access/provider/me')).body;
    const grant = grants.find((g) => g.hospitalID === H.wase.id && g.patientName === name);
    const res = await apiCall(token, 'GET', `/records/resolve?grantID=${grant.grantID}&hospitalID=${H.wase.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('grant status is REVOKED');
  });

  await patientPage.context().close();
  await clinicianPage.context().close();
});
