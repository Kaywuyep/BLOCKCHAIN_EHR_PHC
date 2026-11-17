import { test, expect } from '@playwright/test';
import { AUTH_BACKEND_URL, AUTH_FRONTEND_URL } from './config.js';
import {
  H, tag, field, navLink, gotoNav, signIn, createHealthId, addRosterRecord, apiLogin, apiCall,
} from './utils.js';

// Sign-in and role separation, against the AUTH_MODE=local backend. Each
// role sees only its own section of the app, cannot open another role's
// pages by URL, and is refused by the API outside its role and hospital.
test.use({ baseURL: AUTH_FRONTEND_URL });

const sectionLinks = (page) => page.locator('.sidebar-sections a');

test('without a session the app shows only the sign-in page, and the API refuses calls', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Admin Dashboard/ })).toHaveCount(0);
  const res = await fetch(`${AUTH_BACKEND_URL}/hospitals/status`);
  expect(res.status).toBe(401);
});

test('a patient sees only the Patient Portal, creates a Health ID, and it is bound to their account', async ({ page }) => {
  const t = tag();
  const dob = '1995-03-15';
  const name = `Auth Patient ${t}`;
  const hospitalNumber = `LAG-${t}`;
  await addRosterRecord(H.langtang.id, { hospitalNumber, name, dob });

  await signIn(page, { role: 'patient', subject: `amina-${t}` });
  await expect(page).toHaveURL(/\/patient$/);
  await expect(sectionLinks(page)).toHaveCount(1);
  await expect(sectionLinks(page)).toHaveText(/Patient Portal/);
  for (const label of ['My Health ID', 'My Hospitals', 'My Records', 'Access Control', 'Audit Trail']) {
    await expect(navLink(page, label)).toBeVisible();
  }
  await expect(page.getByRole('link', { name: /Clinician Portal|Admin Dashboard/ })).toHaveCount(0);

  const did = await createHealthId(page, { hospitalName: H.langtang.name, hospitalNumber, dob, name });

  // A reload keeps the session and the DID bound to the account.
  await page.reload();
  await expect(page.locator('.data-row').filter({ hasText: 'Health ID (DID)' }).locator('.v')).toHaveText(did);

  // The DID is the account's: a second registration can't claim another one.
  const token = await apiLogin({ role: 'patient', subject: `amina-${t}` });
  const me = await apiCall(token, 'GET', '/auth/me');
  expect(me.body.patientDID).toBe(did);
  const claim = await apiCall(token, 'POST', '/patients/register', { patientDID: 'did:patientchain:someone-else' });
  expect(claim.status).toBe(403);

  // Other roles' pages are not rendered, by URL or by API.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/patient$/);
  await page.goto('/clinician/emergency');
  await expect(page).toHaveURL(/\/patient$/);
  expect((await apiCall(token, 'GET', '/access/provider/me')).status).toBe(403);
  expect((await apiCall(token, 'GET', '/access/break-glass/pending')).status).toBe(403);

  await page.getByTitle('Sign out').click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('a clinician\'s provider ID and hospital are fixed to their account', async ({ page }) => {
  const t = tag();
  const providerID = `dr-${t}`;
  await signIn(page, { role: 'clinician', subject: providerID, hospitalID: H.langtang.id });
  await expect(page).toHaveURL(/\/clinician$/);
  await expect(sectionLinks(page)).toHaveCount(1);
  await expect(sectionLinks(page)).toHaveText(/Clinician Portal/);
  for (const label of ['Request Access', 'Emergency Access', 'View Records']) {
    await expect(navLink(page, label)).toBeVisible();
  }
  await expect(page.getByRole('link', { name: /Patient Portal|Admin Dashboard/ })).toHaveCount(0);

  // Patients are found by the clinician's OWN hospital's numbers only.
  await expect(field(page, `Patient’s hospital number at ${H.langtang.name}`)).toBeVisible();
  await gotoNav(page, 'Emergency Access');
  const targets = field(page, 'Hospital holding the records').locator('option');
  await expect(targets.filter({ hasText: H.wase.name })).toHaveCount(1);
  await expect(targets.filter({ hasText: H.langtang.name })).toHaveCount(0);

  await page.goto('/patient');
  await expect(page).toHaveURL(/\/clinician$/);

  // The API holds the same lines, whatever the request body claims.
  const token = await apiLogin({ role: 'clinician', subject: providerID, hospitalID: H.langtang.id });
  const asSomeoneElse = await apiCall(token, 'POST', '/access/request', { patientDID: 'did:patientchain:x', providerID: 'dr-someone-else', hospitalID: H.wase.id });
  expect(asSomeoneElse.status).toBe(403);
  const ownHospital = await apiCall(token, 'POST', '/access/request', { patientDID: 'did:patientchain:x', providerID, hospitalID: H.langtang.id, requesterHospitalID: H.wase.id });
  expect(ownHospital.status).toBe(400);
  expect(ownHospital.body.error).toContain("your own hospital's records are in your hospital's EMR");
  const otherRoster = await apiCall(token, 'GET', `/patients/lookup-by-hospital-number/${H.wase.id}/WAS-1`);
  expect(otherRoster.status).toBe(403);
});

test('a hospital admin lands on their hospital\'s Admin Dashboard, without system-admin pages', async ({ page }) => {
  const t = tag();
  await signIn(page, { role: 'hospital_admin', subject: `admin-${t}`, hospitalID: H.langtang.id });
  await expect(page).toHaveURL(/\/admin$/);
  await expect(sectionLinks(page)).toHaveCount(1);
  await expect(sectionLinks(page)).toHaveText(/Admin Dashboard/);
  await expect(page.getByRole('link', { name: /Patient Portal|Clinician Portal/ })).toHaveCount(0);
  for (const label of ['Overview', 'Record Access Log', 'Access Grants', 'Break-Glass Review']) {
    await expect(navLink(page, label)).toBeVisible();
  }
  await expect(navLink(page, 'Users')).toHaveCount(0);
  await expect(page.locator('.main-content').getByRole('heading', { name: H.langtang.name })).toBeVisible();

  await page.goto('/admin/users');
  await expect(page.getByText('Only system admins can manage users.')).toBeVisible();

  // Another hospital's roster is off limits.
  const token = await apiLogin({ role: 'hospital_admin', subject: `admin-${t}`, hospitalID: H.langtang.id });
  expect((await apiCall(token, 'GET', `/patients/local-records/${H.wase.id}`)).status).toBe(403);
  expect((await apiCall(token, 'GET', `/patients/local-records/${H.langtang.id}`)).status).toBe(200);
});

test('a quick-access account signs in with one click: the system admin sees every admin page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Super Admin' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('.sidebar-user-name')).toHaveText('superadmin');
  await expect(page.locator('.sidebar-user-role')).toHaveText('System Admin');
  await expect(navLink(page, 'Users')).toBeVisible();
  await expect(navLink(page, 'Hospitals')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Admin Dashboard', level: 2 })).toBeVisible();
});
