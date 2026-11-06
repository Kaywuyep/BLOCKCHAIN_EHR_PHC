import { BACKEND_URL } from './config.js';

// Most fields in this app are `<div class="field"><label>X</label><input/></div>`
// with no `for`/`id` association, so Playwright's getByLabel can't find
// them. This locates the field's own container by its exact label text
// and hands back a locator scoped to just that container -- call
// .locator('input' | 'select' | 'textarea') on the result to get the
// control itself.
export function field(page, labelText) {
  return page.locator(`div.field:has(label:text-is(${JSON.stringify(labelText)}))`);
}

// The top nav is now real <a> links (/patient, /clinician, /admin are each
// their own route, individually bookmarkable/shareable) rather than buttons
// that swapped state in place.
export async function gotoTab(page, tabName) {
  await page.getByRole('link', { name: tabName, exact: true }).click();
}

// The offline-connectivity toggle, the break-glass review queue and the
// cost-model counters are all process-global backend state, not scoped to
// one patient. Force connectivity back online before/after any journey
// that might otherwise inherit a flipped toggle left by a previous spec.
export async function ensureOnline() {
  await fetch(`${BACKEND_URL}/sync/connectivity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connected: true }),
  });
}

// The Clinician Portal only ever creates access *requests* -- it has no UI
// for a hospital to onboard its own staff (that's Section 16/35.1's
// hospital-side responsibility, deliberately kept off-chain and out of
// this patient-facing app). A test provider therefore has to be
// registered directly against the registry before a request naming it
// can pass Level-2 RBAC, exactly as a hospital's own admin system would
// do before a new clinician's first shift.
export async function registerProvider(providerID, hospitalID) {
  await fetch(`${BACKEND_URL}/providers/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerID, hospitalID, status: 'ACTIVE' }),
  });
}

// The backend starts with a completely empty local patient roster (no
// seeded demo data) -- a hospital number is only linkable once someone has
// added it to that hospital's roster, exactly as an Admin Dashboard user
// would via the "Hospital local patient roster" panel. Specs that need a
// pre-existing record to link against create their own fixture here.
export async function addLocalPatientRecord(hospitalID, { hospitalNumber, name, dob }) {
  await fetch(`${BACKEND_URL}/patients/local-records/${encodeURIComponent(hospitalID)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hospitalNumber, name, dob }),
  });
}
