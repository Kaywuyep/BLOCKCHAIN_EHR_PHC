import { test, expect } from '@playwright/test';
import { AUTH_FRONTEND_URL } from './config.js';
import {
  H, tag, field, gotoNav, signIn, addRosterRecord, admitViaHl7, registerClinician, patientWithNetwork, ensureOnline,
} from './utils.js';

// Emergency (break-glass) access between facilities: a Langtang clinician
// treating a patient who cannot consent uses the patient's hospital number
// at Wase (given by family) to open the emergency subset of the Wase
// records at once, with no patient approval. It lasts one hour, can be
// extended with a reason, and is visible to the patient and to the admins
// of BOTH hospitals, either of whom closes it out with a review.
test.use({ baseURL: AUTH_FRONTEND_URL });

test('break-glass: emergency access by hospital number is immediate, extendable, and reviewed by an admin', async ({ browser }) => {
  test.setTimeout(120_000);
  await ensureOnline();

  const t = tag();
  const dob = '1985-07-30';
  const given = `BALA${t.toUpperCase()}`;
  const family = 'GARBA';
  const name = `${given} ${family}`;
  const lagNumber = `LAG-${t}`;
  const wasNumber = `WAS-${t}`;
  const attending = { attendingGiven: 'IDRIS', attendingFamily: `ERDOC${t.toUpperCase()}` };
  const providerID = `dr-bg-${t}`;
  const reason = `Brought in unresponsive, need allergies and medication ${t}`;
  const extendReason = `Still in theatre ${t}`;
  const patientSubject = `patient-bg-${t}`;

  await addRosterRecord(H.langtang.id, { hospitalNumber: lagNumber, name, dob });
  await admitViaHl7(H.wase.id, { hospitalNumber: wasNumber, family, given, dob, ...attending });
  await registerClinician(H.langtang.id, providerID, { name: 'Dr Emergency' });
  const { did } = await patientWithNetwork(patientSubject, dob, [
    { hospitalID: H.langtang.id, hospitalNumber: lagNumber },
    { hospitalID: H.wase.id, hospitalNumber: wasNumber },
  ], name);

  const clinicianPage = await (await browser.newContext()).newPage();

  await test.step('the clinician must name the other hospital, the patient\'s number there and a reason', async () => {
    await signIn(clinicianPage, { role: 'clinician', subject: providerID, hospitalID: H.langtang.id });
    await gotoNav(clinicianPage, 'Emergency Access');
    // The form opens on the emergency-code tab; this test uses a hospital number.
    await clinicianPage.getByRole('tab', { name: 'Hospital number' }).click();
    const hospitalSelect = field(clinicianPage, 'Hospital holding the records').locator('select');
    // Break-glass is only for records at OTHER hospitals.
    await expect(hospitalSelect.locator('option', { hasText: H.wase.name })).toHaveCount(1);
    await expect(hospitalSelect.locator('option', { hasText: H.langtang.name })).toHaveCount(0);

    const open = clinicianPage.getByRole('button', { name: 'Open emergency access' });
    await expect(open).toBeDisabled();
    await hospitalSelect.selectOption({ label: H.wase.name });
    await field(clinicianPage, 'Patient’s hospital number there').locator('input').fill(wasNumber);
    await expect(open).toBeDisabled();
    await field(clinicianPage, 'Why is this needed now?').locator('textarea').fill(reason);
    await expect(open).toBeEnabled();
  });

  await test.step('an unknown hospital number opens nothing', async () => {
    await field(clinicianPage, 'Patient’s hospital number there').locator('input').fill(`WAS-NOPE-${t}`);
    await clinicianPage.getByRole('button', { name: 'Open emergency access' }).click();
    await expect(clinicianPage.locator('.error-banner')).toHaveText('No Cevruni patient with that hospital number at that hospital');
  });

  await test.step('with the right number and a representative, access opens immediately for one hour', async () => {
    await field(clinicianPage, 'Patient’s hospital number there').locator('input').fill(wasNumber);
    await field(clinicianPage, 'Name').locator('input').fill(`Musa ${t}`);
    await field(clinicianPage, 'Relationship').locator('input').fill('Husband');
    await field(clinicianPage, 'Phone').locator('input').fill('+2348000000000');
    await clinicianPage.getByRole('button', { name: 'Open emergency access' }).click();
    const result = clinicianPage.locator('.cl-bg-result');
    await expect(result).toContainText('Emergency access open');
    // The patient is identified from Wase's roster so the clinician can check it's the right person.
    await expect(result.getByRole('heading')).toContainText(`${name} · ${H.wase.name} No. ${wasNumber}`);
  });

  const card = clinicianPage.locator('.vr-card').filter({ hasText: name });
  await test.step('the emergency records are usable at once, with no patient approval step', async () => {
    await clinicianPage.getByRole('link', { name: 'Open emergency records' }).click();
    await expect(card.locator('.vr-chip.emergency')).toHaveText('Emergency access');
    await expect(card.locator('.vr-status')).toHaveText('Active');
    await expect(card.locator('.vr-when')).toHaveText(/^(60|59) min left$/);
    await card.locator('button.vr-toggle', { hasText: 'Open records' }).click();
    await expect(card.getByText('Access verified on the blockchain and logged')).toBeVisible();
    await expect(card.getByText(`Reason: ${reason}`)).toBeVisible();
    await expect(card.getByText(`Requested by Husband Musa ${t} · +2348000000000`)).toBeVisible();
    await expect(card.locator('.vr-record.type-Encounter')).toContainText(`${attending.attendingGiven} ${attending.attendingFamily}`);
  });

  await test.step('extending the window needs a reason, which is recorded', async () => {
    await card.getByRole('button', { name: 'Extend access…' }).click();
    const extend = card.getByRole('button', { name: 'Extend', exact: true });
    await expect(extend).toBeDisabled();
    await card.getByPlaceholder('Why is more time needed?').fill(extendReason);
    await card.locator('.vr-extend select').selectOption('30');
    await extend.click();
    await expect(card.getByText(`(+30 min): ${extendReason}`)).toBeVisible();
    await expect(card.locator('.vr-when')).toHaveText(/^1 h left$/);
  });

  await test.step('the patient sees the emergency access, awaiting hospital review', async () => {
    const patientPage = await (await browser.newContext()).newPage();
    await signIn(patientPage, { role: 'patient', subject: patientSubject });
    await gotoNav(patientPage, 'Access Control');
    const row = patientPage.locator('.pa-em-row').filter({ hasText: 'Dr Emergency' }); // names, not IDs, on screen
    await expect(row).toContainText(`Dr Emergency at ${H.langtang.name} opened your records from ${H.wase.name}`);
    await expect(row).toContainText('awaiting hospital review');
    await expect(row).toContainText(`Reason: ${reason}`);
    await expect(row).toContainText(`Extended +30 min: ${extendReason}`);
    await patientPage.context().close();
  });

  await test.step('the clinician\'s own hospital admin sees it as their clinician\'s access', async () => {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, { role: 'hospital_admin', subject: `admin-lag-${t}`, hospitalID: H.langtang.id });
    await gotoNav(page, 'Break-Glass Review');
    const entry = page.locator('.bg-review').filter({ hasText: reason }) /* patient shown by name, not Health ID */;
    await expect(entry.locator('.bg-review-head .pill')).toHaveText('Our clinician opened another hospital’s records');
    await page.context().close();
  });

  await test.step('the record-holding hospital\'s admin reviews it, and it leaves the queue', async () => {
    const adminPage = await (await browser.newContext()).newPage();
    await signIn(adminPage, { role: 'hospital_admin', subject: `admin-was-${t}`, hospitalID: H.wase.id });
    await gotoNav(adminPage, 'Break-Glass Review');
    const entry = adminPage.locator('.bg-review').filter({ hasText: reason }) /* patient shown by name, not Health ID */;
    await expect(entry.locator('.bg-review-head .pill')).toHaveText('Our records opened by another hospital');
    await expect(entry).toContainText(`Dr Emergency (Physician) · ${H.langtang.name}`);
    await expect(entry).toContainText(`Patient ${name}`);
    await expect(entry).toContainText(`Records at ${H.wase.name}`);
    await expect(entry).toContainText(`Reason ${reason}`);
    // The representative's details are off-chain; their hash is on the ledger.
    await expect(entry).toContainText(`Requested by Husband Musa ${t}`);
    await expect(entry.getByText('matches ledger hash')).toBeVisible();
    await expect(entry).toContainText(`: ${extendReason}`);

    await entry.getByPlaceholder('Review notes').fill('Confirmed legitimate emergency');
    await entry.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(adminPage.locator('.bg-review').filter({ hasText: reason }) /* patient shown by name, not Health ID */).toHaveCount(0);
    await adminPage.context().close();
  });

  await test.step('the patient\'s view now shows it as reviewed', async () => {
    const patientPage = await (await browser.newContext()).newPage();
    await signIn(patientPage, { role: 'patient', subject: patientSubject });
    await gotoNav(patientPage, 'Access Control');
    await expect(patientPage.locator('.pa-em-row').filter({ hasText: 'Dr Emergency' })).toContainText('reviewed by the hospital');
    await patientPage.context().close();
  });

  await clinicianPage.context().close();
});
