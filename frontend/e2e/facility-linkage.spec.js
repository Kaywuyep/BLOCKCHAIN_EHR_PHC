import { test, expect } from '@playwright/test';
import { AUTH_FRONTEND_URL } from './config.js';
import {
  H, tag, field, fieldStarting, gotoNav, signIn, lookUpFirstHospital, createHealthId, lookUpFacility, networkPanel, addRosterRecord,
} from './utils.js';

// Patient-asserted facility linkage. There is no demographic matching: the
// patient names a hospital, gives the hospital number on their card there
// and their date of birth, sees the name on that record, and explicitly
// confirms it. The same check runs before the Health ID (DID) is created
// at their first hospital, and again for each further hospital they add.
// A wrong number and a wrong date of birth get the same generic refusal,
// so the lookup cannot be used to find out which numbers exist.
//
// The backend starts with no data (DEMO_SEED=off); each test seeds the
// hospital rosters it needs, via the API or (last test) the admin UI.
test.use({ baseURL: AUTH_FRONTEND_URL });

const NO_MATCH = 'No matching record found';

test('facility linkage: a wrong hospital number or DOB is refused generically, and a correct one requires explicit confirmation', async ({ page }) => {
  test.setTimeout(60_000);
  const t = tag();
  const dob = '1990-04-12';
  const name = `Test Patient ${t}`;
  const lagNumber = `LAG-${t}`;
  const pshNumber = `PSH-${t}`;
  await addRosterRecord(H.langtang.id, { hospitalNumber: lagNumber, name, dob });
  await addRosterRecord(H.specialist.id, { hospitalNumber: pshNumber, name, dob });

  await signIn(page, { role: 'patient', subject: `patient-link-${t}` });

  await test.step('before a Health ID exists, a wrong date of birth at the first hospital is refused generically', async () => {
    await lookUpFirstHospital(page, { hospitalName: H.langtang.name, hospitalNumber: lagNumber, name, dob: '2000-01-01' });
    await expect(page.locator('.error-banner').first()).toHaveText(NO_MATCH);
    await expect(page.getByRole('button', { name: 'Yes, create my Health ID' })).toHaveCount(0);
    await expect(page.getByText('Not yet registered')).toBeVisible();
  });

  await test.step('the right number and date of birth show the name; confirming creates the Health ID', async () => {
    await createHealthId(page, { hospitalName: H.langtang.name, hospitalNumber: lagNumber, dob, name });
  });

  await gotoNav(page, 'My Hospitals');
  await expect(networkPanel(page).getByRole('heading')).toHaveText('My Hospital Network (1)');

  await test.step('an incorrect hospital number is refused with a generic error', async () => {
    await lookUpFacility(page, { search: 'Specialist', hospitalName: H.specialist.name, hospitalNumber: 'NOT-A-REAL-NUMBER', name, dob });
    await expect(page.locator('.error-banner')).toHaveText(NO_MATCH);
    await expect(page.getByRole('button', { name: 'Yes, add to my network' })).toHaveCount(0);
  });

  await test.step('a correct hospital number with the wrong date of birth is refused with the exact same error', async () => {
    await field(page, 'Your hospital number').locator('input').fill(pshNumber);
    await fieldStarting(page, 'Date of birth').locator('input').fill('2000-01-01');
    await page.getByRole('button', { name: 'Verify & Add to Network' }).click();
    await expect(page.locator('.error-banner')).toHaveText(NO_MATCH);
    await expect(page.getByRole('button', { name: 'Yes, add to my network' })).toHaveCount(0);
  });

  await test.step('a correct number with a name that is not on the record is refused with the same error', async () => {
    await fieldStarting(page, 'Date of birth').locator('input').fill(dob);
    await field(page, 'Your name at this hospital').locator('input').fill('Somebody Else');
    await page.getByRole('button', { name: 'Verify & Add to Network' }).click();
    await expect(page.locator('.error-banner')).toHaveText(NO_MATCH);
  });

  await test.step('a correct number and name show the matched name for confirmation, without linking yet', async () => {
    await field(page, 'Your name at this hospital').locator('input').fill(name);
    await fieldStarting(page, 'Date of birth').locator('input').fill('');
    await page.getByRole('button', { name: 'Verify & Add to Network' }).click();
    await expect(page.getByText('Record found!')).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Is this you\? Confirming will add/)).toBeVisible();
    await expect(networkPanel(page).getByRole('heading')).toHaveText('My Hospital Network (1)');
  });

  await test.step('confirming links the facility', async () => {
    await page.getByRole('button', { name: 'Yes, add to my network' }).click();
    await expect(networkPanel(page).getByRole('heading')).toHaveText('My Hospital Network (2)');
    await expect(networkPanel(page)).toContainText(H.specialist.name);
    await expect(networkPanel(page)).toContainText(`Hospital No: ${pshNumber}`);
    // The link is held by the server, not just this screen.
    await page.reload();
    await gotoNav(page, 'My Hospitals');
    await expect(networkPanel(page)).toContainText(`Hospital No: ${pshNumber}`);
  });
});

test('facility linkage: saying "No" to a match discards it without linking', async ({ page }) => {
  test.setTimeout(60_000);
  const t = tag();
  const dob = '1990-04-12';
  const name = `Test Patient ${t}`;
  const lagNumber = `LAG-${t}`;
  const pshNumber = `PSH-${t}`;
  await addRosterRecord(H.langtang.id, { hospitalNumber: lagNumber, name, dob });
  await addRosterRecord(H.specialist.id, { hospitalNumber: pshNumber, name, dob });

  await signIn(page, { role: 'patient', subject: `patient-reject-${t}` });

  await test.step('"No, that’s not me" at the first hospital creates no Health ID', async () => {
    await lookUpFirstHospital(page, { hospitalName: H.langtang.name, hospitalNumber: lagNumber, name, dob });
    await expect(page.getByText(`Is this you: ${name}?`)).toBeVisible();
    await page.getByRole('button', { name: 'No, that’s not me' }).click();
    await expect(page.getByText(`Is this you: ${name}?`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Yes, create my Health ID' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Find my record' })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Not yet registered')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Create your Cevruni Health ID' })).toBeVisible();
  });

  await test.step('the patient then confirms and creates their Health ID', async () => {
    await createHealthId(page, { hospitalName: H.langtang.name, hospitalNumber: lagNumber, dob, name });
  });

  await test.step('"Not me" on a further hospital discards the match without linking', async () => {
    await gotoNav(page, 'My Hospitals');
    await lookUpFacility(page, { search: 'Specialist', hospitalName: H.specialist.name, hospitalNumber: pshNumber, name, dob });
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Not me — cancel' }).click();
    await expect(page.getByText('Record found!')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Find a Hospital' })).toBeVisible();
    await expect(networkPanel(page).getByRole('heading')).toHaveText('My Hospital Network (1)');
    await expect(networkPanel(page)).not.toContainText(pshNumber);
    await page.reload();
    await gotoNav(page, 'My Hospitals');
    await expect(networkPanel(page).getByRole('heading')).toHaveText('My Hospital Network (1)');
  });
});

// End to end through the real UI on both sides: a hospital admin enters a
// patient into their hospital's roster from the Admin Dashboard, and that
// patient adds the hospital to their network from the Patient App.
test('facility linkage: a record added via the Admin Dashboard is immediately linkable by the patient', async ({ browser }) => {
  test.setTimeout(60_000);
  const t = tag();
  const dob = '1988-11-23';
  const name = `Admin-Added Patient ${t}`;
  const lagNumber = `LAG-${t}`;
  const juthNumber = `JUTH-${t}`;
  await addRosterRecord(H.langtang.id, { hospitalNumber: lagNumber, name, dob });

  const adminPage = await (await browser.newContext()).newPage();
  await test.step('the JUTH admin adds a roster record', async () => {
    await signIn(adminPage, { role: 'hospital_admin', subject: `admin-juth-${t}`, hospitalID: H.juth.id });
    await gotoNav(adminPage, 'Patient Roster');
    // The roster form is fixed to the admin's own hospital.
    await expect(field(adminPage, 'Hospital ID').locator('input')).toHaveValue(H.juth.id);
    await field(adminPage, 'Hospital number').locator('input').fill(juthNumber);
    await field(adminPage, 'Full name').locator('input').fill(name);
    await fieldStarting(adminPage, 'Date of birth').locator('input').fill(dob);
    await adminPage.getByRole('button', { name: 'Add record' }).click();
    await expect(adminPage.locator('.data-row').filter({ hasText: `${name} — ${juthNumber}` })).toContainText(`DOB ${dob}`);
  });
  await adminPage.context().close();

  const page = await (await browser.newContext()).newPage();
  await test.step('the patient links it straight away', async () => {
    await signIn(page, { role: 'patient', subject: `patient-admin-${t}` });
    await createHealthId(page, { hospitalName: H.langtang.name, hospitalNumber: lagNumber, dob, name });
    await gotoNav(page, 'My Hospitals');
    await lookUpFacility(page, { search: 'JUTH', hospitalName: H.juth.name, hospitalNumber: juthNumber, name, dob });
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Yes, add to my network' }).click();
    await expect(networkPanel(page)).toContainText(H.juth.name);
    await expect(networkPanel(page)).toContainText(`Hospital No: ${juthNumber}`);
  });
  await page.context().close();
});
