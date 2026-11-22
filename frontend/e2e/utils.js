import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { AUTH_BACKEND_URL } from './config.js';

// The synthetic HL7 v2 segment builders the backend's own ADT tests use, so
// fixtures here are field-position-correct rather than hand-typed pipes.
const require = createRequire(import.meta.url);
const { buildMsh, buildPid, buildPv1, buildSegment } = require('../../backend/src/services/hl7AdtListener.fixtures.js');

// Hospitals that exist when the backend starts with DEMO_SEED=off: the
// registry imports backend/config/hospitalDirectory.json (+ ingestion
// settings from hospitalIngestion.json) on first start. Langtang and Wase
// are HL7 hospitals with HTTP delivery enabled, so they can receive
// clinical records in a test; the rest are manual (roster only).
export const H = {
  langtang: { id: 'general-hospital-langtang', name: 'General Hospital Langtang' },
  wase: { id: 'general-hospital-wase', name: 'General Hospital Wase' },
  juth: { id: 'jos-university-teaching-hospital', name: 'Jos University Teaching Hospital (JUTH)' },
  specialist: { id: 'plateau-specialist-hospital', name: 'Plateau Specialist Hospital' },
};

export const tag = () => randomUUID().slice(0, 8);

// Fields in the app pages are `<div class="field"><label>X</label><input/></div>`
// with no `for`/`id` association, so getByLabel can't find them. This
// returns the field's container by its exact label text; call
// .locator('input' | 'select' | 'textarea') on it for the control.
export function field(page, labelText) {
  return page.locator(`div.field:has(> label:text-is(${JSON.stringify(labelText)}))`);
}

/** A form field whose label starts with `labelText` (e.g. "Date of birth" + an "optional" tag). */
export function fieldStarting(page, labelText) {
  return page.locator(`div.field:has(> label:has-text(${JSON.stringify(labelText)}))`);
}

// The same, for the sign-in form (`.login-field`).
export function loginField(page, labelText) {
  return page.locator(`div.login-field:has(> label:text-is(${JSON.stringify(labelText)}))`);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A sidebar link. Each one is an icon span plus a label span (plus, for
// Access Control, a pending-request badge), so its accessible name is
// "<emoji> <label>[ <count>]": match on the label.
export function navLink(page, label) {
  return page.locator('.sidebar').getByRole('link', { name: new RegExp(`(^|\\s)${escapeRe(label)}( \\d+)?$`) });
}

export async function gotoNav(page, label) {
  await navLink(page, label).click();
}

// ── API helpers (AUTH_MODE=local backend) ────────────────────────────────

/** A bearer token from the development login (AUTH_MODE=local). */
export async function apiLogin({ role, subject, hospitalID }) {
  const res = await fetch(`${AUTH_BACKEND_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, subject, hospitalID }),
  });
  if (!res.ok) throw new Error(`login ${subject} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

/** Calls the AUTH_MODE=local backend; returns { status, body }. */
export async function apiCall(token, method, path, body, { text = false } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = text ? 'text/plain' : 'application/json';
  const res = await fetch(`${AUTH_BACKEND_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : text ? body : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed = raw;
  try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

async function ok(promise, what) {
  const r = await promise;
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const adminToken = (hospitalID) => apiLogin({ role: 'hospital_admin', subject: `admin-${hospitalID}`, hospitalID });
export const systemAdminToken = () => apiLogin({ role: 'system_admin', subject: 'e2e-sysadmin' });

/** A hospital's admin adds a demographic record to its local roster. */
export async function addRosterRecord(hospitalID, { hospitalNumber, name, dob }) {
  const token = await adminToken(hospitalID);
  return ok(apiCall(token, 'POST', `/patients/local-records/${encodeURIComponent(hospitalID)}`, { hospitalNumber, name, dob }), 'roster add');
}

/** A hospital's admin registers a clinician on its staff register (Level-2 RBAC). */
export async function registerClinician(hospitalID, providerID, { name, role = 'Physician' } = {}) {
  const token = await adminToken(hospitalID);
  return ok(apiCall(token, 'POST', '/providers/register', { providerID, hospitalID, name: name || providerID, role, status: 'ACTIVE' }), 'clinician register');
}

/**
 * The hospital's interface engine sends an HL7 ADT^A01 admit over HTTP: it
 * creates the roster entry (name from PID-5 as "GIVEN FAMILY") and an
 * Encounter whose attending clinician is "attendingGiven attendingFamily".
 * Only works for hospitals with HL7-over-HTTP enabled (Langtang, Wase).
 */
export async function admitViaHl7(hospitalID, { hospitalNumber, family, given, dob, attendingFamily, attendingGiven }) {
  const token = await adminToken(hospitalID);
  const message = [
    buildMsh({ triggerEvent: 'A01', controlId: `E2E${tag()}` }),
    buildSegment('EVN', { 1: 'A01', 2: '20240115080000' }, 2),
    buildPid({ hospitalNumber, family, given, dob: dob.replaceAll('-', ''), sex: 'F' }),
    buildPv1({ patientClass: 'I', pointOfCare: 'WARD1', room: '101', bed: 'A', attendingId: '9001', attendingFamily, attendingGiven, admitDateTime: '20240115080000' }),
  ].join('\r') + '\r';
  return ok(apiCall(token, 'POST', `/hl7/adt/${encodeURIComponent(hospitalID)}`, message, { text: true }), 'HL7 admit');
}

/**
 * A patient account with a Health ID created through the API, linked to
 * the given hospitals (each needs a roster record with this name and dob). The
 * patient has no device key (keyless), so approvals need no signature.
 */
export async function patientWithNetwork(subject, dob, links, name) {
  const token = await apiLogin({ role: 'patient', subject });
  const [first, ...rest] = links;
  await ok(apiCall(token, 'POST', '/patients/register/lookup', { hospitalID: first.hospitalID, hospitalNumber: first.hospitalNumber, name, dateOfBirth: dob }), 'register lookup');
  const reg = await ok(apiCall(token, 'POST', '/patients/register', { firstFacility: { hospitalID: first.hospitalID, hospitalNumber: first.hospitalNumber } }), 'register');
  const did = reg.patient.patientDID;
  for (const l of rest) {
    await ok(apiCall(token, 'POST', `/patients/${encodeURIComponent(did)}/link-facility`, { hospitalID: l.hospitalID, hospitalNumber: l.hospitalNumber, name, dateOfBirth: dob }), 'link-facility');
    await ok(apiCall(token, 'POST', `/patients/${encodeURIComponent(did)}/confirm-link`, { hospitalID: l.hospitalID, hospitalNumber: l.hospitalNumber }), 'confirm-link');
  }
  return { did, token };
}

/** Connectivity is process-global: force it back online (system admin only). */
export async function ensureOnline() {
  const token = await systemAdminToken();
  await ok(apiCall(token, 'POST', '/sync/connectivity', { connected: true }), 'connectivity');
}

// ── UI helpers ────────────────────────────────────────────────────────────

/** Signs in through the manual form on the login page. */
export async function signIn(page, { role, subject, hospitalID }) {
  await page.goto('/');
  await loginField(page, 'Role').locator('select').selectOption(role);
  await loginField(page, role === 'clinician' ? 'Provider ID' : 'User ID').locator('input').fill(subject);
  if (hospitalID) await loginField(page, 'Hospital ID').locator('input').fill(hospitalID);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.sidebar-user-name')).toHaveText(subject);
  // Staff confirm the confidentiality notice once per sign-in (PrivacyGuard).
  if (role !== 'patient') await acknowledgeConfidentiality(page);
}

/** Staff: confirm the "Confidential patient information" notice shown after sign-in. */
export async function acknowledgeConfidentiality(page) {
  const notice = page.getByRole('dialog', { name: 'Confidentiality notice' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'I understand and agree' }).click();
  await expect(notice).toHaveCount(0);
}

/** My Health ID: look up the first hospital's record (does not confirm). */
export async function lookUpFirstHospital(page, { hospitalName, hospitalNumber, name, dob }) {
  await field(page, 'First hospital').locator('select').selectOption({ label: hospitalName });
  await field(page, 'Hospital number').locator('input').fill(hospitalNumber);
  await field(page, 'Name at the hospital').locator('input').fill(name);
  if (dob) await fieldStarting(page, 'Date of birth').locator('input').fill(dob);
  await page.getByRole('button', { name: 'Find my record' }).click();
}

/** My Health ID: full first-hospital confirmation; returns the new DID. */
export async function createHealthId(page, { hospitalName, hospitalNumber, dob, name }) {
  await lookUpFirstHospital(page, { hospitalName, hospitalNumber, name, dob });
  await expect(page.getByText(`Is this you: ${name}?`)).toBeVisible();
  await page.getByRole('button', { name: 'Yes, create my Health ID' }).click();
  const didRow = page.locator('.data-row').filter({ hasText: 'Health ID (DID)' }).locator('.v');
  await expect(didRow).toHaveText(/^did:patientchain:/);
  return didRow.innerText();
}

/** My Hospitals: pick a hospital from the search and look up a record there. */
export async function lookUpFacility(page, { search, hospitalName, hospitalNumber, name, dob }) {
  await field(page, 'Search by hospital name').locator('input').fill(search);
  await page.getByText(hospitalName, { exact: true }).click();
  await field(page, 'Your hospital number').locator('input').fill(hospitalNumber);
  await field(page, 'Your name at this hospital').locator('input').fill(name);
  if (dob) await fieldStarting(page, 'Date of birth').locator('input').fill(dob);
  await page.getByRole('button', { name: 'Verify & Add to Network' }).click();
}

/** The patient's "My Hospital Network (n)" panel. */
export function networkPanel(page) {
  return page.locator('.panel').filter({ has: page.getByRole('heading', { name: /^My Hospital Network \(\d+\)$/ }) });
}
