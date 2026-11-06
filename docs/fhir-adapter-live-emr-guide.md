# Connecting the FHIR Adapter to a live EMR

`backend/src/services/fhirAdapter.js` currently simulates a hospital's own
EMR/database in memory. This guide walks through replacing it with a real
connection to a hospital's FHIR server, without changing anything else in
the system — every route, the linkage flow, and the ledger are written
against the adapter's method contract, not its implementation.

## 1. Why this is safe to swap

Nothing outside `fhirAdapter.js` talks to a database directly. Every
caller goes through four methods:

| Method | Called from | Purpose |
|---|---|---|
| `registerLocalPatient(hospitalID, patientDID, mrn)` | `routes/patients.js` (`POST /register`, and `linkageService.confirmLink`) | Write the DID ↔ hospital-number mapping |
| `resolveRecord(hospitalID, patientDID)` | `routes/records.js` (`GET /records/resolve`) | Return `{ mrn, bundles }` for an already-granted, already-RBAC'd request |
| `addLocalPatientRecord(hospitalID, hospitalNumber, { name, dob })` | `routes/patients.js` (`POST /local-records/:hospitalID`) | Add/update a roster entry a patient can later link against |
| `findLocalPatientRecord(hospitalID, hospitalNumber)` | `linkageService.linkFacility` | Look up a roster entry by hospital number alone (no DID yet) |
| `listLocalPatientRecords(hospitalID)` | `routes/patients.js` (`GET /local-records/:hospitalID`) | Admin Dashboard roster view |

`createClinicalRecord(hospitalID, patientDID, record)` exists on the
simulated adapter but **no route calls it** — PatientChain never writes
clinical data, it only reads what the EMR already has. You do not need to
implement it for a live integration.

As long as your replacement class exposes those five methods with the
same signatures and return shapes, `routes/patients.js`, `routes/records.js`,
and `linkageService.js` need zero changes.

## 2. Two things a live adapter must get right

**a. Two very different data sources.** `resolveRecord` and
`findLocalPatientRecord` read from the hospital's real EMR (the source of
truth for clinical data and patient demographics). `registerLocalPatient`
writes to a mapping that must **never** live inside the EMR and must
**never** go on-chain — it's PatientChain-specific state the EMR knows
nothing about. Keep these as two separate stores; don't be tempted to
stash the DID in a custom FHIR extension on the EMR's `Patient` resource
just because it's convenient — that leaks a blockchain identifier into a
system PatientChain doesn't control the retention or access policy of.

**b. Per-hospital configuration.** Each hospital is its own FHIR
endpoint with its own credentials (mirroring how the network already
models `HospitalA`/`HospitalB` as separate Fabric orgs — see
`backend/.env.example`'s `FABRIC_MSP_ID` block). Your live adapter needs a
config lookup keyed by `hospitalID`, not a single global base URL.

## 3. Do you need this deployed on a live server (Render, etc.)?

**No, not for building or testing this integration.** SMART Backend
Services (the client-credentials flow this guide uses) is entirely
outbound: your backend process calls out to the hospital's token endpoint
and FHIR API. Nothing calls back into your machine, so there's no
requirement for your backend to be publicly reachable. You can build and
test the whole `liveFhirAdapter.js` against a real or sandbox FHIR server
from `npm run dev` on your laptop.

There are exactly two reasons you'd need real hosting, and they're
unrelated to each other:

1. **Going live for actual patients/clinicians.** Once you're done
   integrating and want real users hitting the app, the frontend and
   backend need to be reachable by them — same as deploying any web app.
   That's a separate step from the EMR integration, and it comes last,
   not first.
2. **A specific hospital's client-registration process requires a JWKS
   URL.** Some SMART Backend Services registrations let you paste/upload
   a static public key; others require a URL serving your JWK Set that
   they fetch periodically (for key rotation). Ask the hospital's
   integration team which they require — if it's a JWKS URL, you need
   *something* public serving that one JSON file. That can be a small
   static host (e.g. GitHub Pages) — it doesn't require your whole app to
   be deployed.

If you do deploy to Render or similar for reason 1, note that the
`MrnStore` SQLite file from Section 9 lives on disk — most platforms'
default web-service disk is ephemeral and gets wiped on redeploy, so
you'll need a persistent volume (Render's Disk add-on, a mounted volume,
etc.) or to move that store to a managed database instead.

## 4. Recommended shape

```
backend/src/services/
  fhirAdapter.js         # unchanged -- keep for local dev / tests
  liveFhirAdapter.js      # new -- talks to real FHIR servers
  fhirAdapterConfig.js     # new -- per-hospital endpoint + auth config
  getFhirAdapter.js        # new -- picks one, mirrors getLedgerService()
```

`getFhirAdapter.js`, modeled directly on the existing
`services/ledgerService.js`:

```js
'use strict';

const { fhirAdapter } = require('./fhirAdapter');
const { LiveFhirAdapter } = require('./liveFhirAdapter');

let instance = null;

async function getFhirAdapter() {
  if (instance) return instance;

  const mode = (process.env.FHIR_ADAPTER_MODE || 'simulated').toLowerCase();

  if (mode === 'live') {
    instance = new LiveFhirAdapter(); // reads its own per-hospital config, see below
    console.log('[fhir-adapter] connected to live EMR endpoints');
    return instance;
  }

  console.log('[fhir-adapter] running in SIMULATED mode -- no EMR connection required.');
  instance = fhirAdapter;
  return instance;
}

module.exports = { getFhirAdapter };
```

Then in `server.js`, replace the direct `fhirAdapter` import used to build
the routers with `await getFhirAdapter()`, the same way `ledgerPromise`
already works.

## 5. Per-hospital config, step by step

Each hospital is its own FHIR endpoint with its own credentials. Do this
once per hospital:

1. **Get connection details from the hospital's integration/IT team**:
   their FHIR R4 base URL, their OAuth2 token URL, whether they want a
   client secret or a public key/JWKS registration (Section 6), and —
   critically — the `identifier.system` URI they use for their MRN field
   (ask for a sample `Patient` resource if they can share one; see the
   warning in Section 7 about why a bare identifier search can match the
   wrong patient).

2. **Register PatientChain as a backend/system client** in their EMR's
   developer portal or FHIR gateway admin console. You'll come away with
   a `client_id`, and either a client secret or confirmation your
   public key/JWKS was accepted.

3. **Pick the `hospitalID` string this hospital will use everywhere in
   the app.** It must exactly match what gets typed into the "Hospital
   ID" field on the Patient App, Clinician Portal, and Admin Dashboard,
   and what's passed when registering that hospital's clinicians via
   `POST /api/providers/register`. Keep it short and stable, e.g.
   `general-hospital-lagos` — once patients have linked facilities under
   it, renaming it means re-linking them.

4. **Add its secrets to `.env`** (never commit these, same as the
   existing `FABRIC_*` vars in `.env.example`):

   ```
   HOSPITAL_GENERAL_LAGOS_CLIENT_ID=...
   HOSPITAL_GENERAL_LAGOS_CLIENT_SECRET=...   # or a private-key path, if using JWK auth
   ```

5. **Add an entry to `backend/config/hospitals.json`**, keyed by that
   exact `hospitalID`, referencing the env var *names* — not the values
   themselves, so the config file stays safe to commit:

   ```json
   {
     "general-hospital-lagos": {
       "fhirBaseUrl": "https://fhir.generalhospital.example.org/R4",
       "tokenUrl": "https://auth.generalhospital.example.org/oauth2/token",
       "clientIdEnvVar": "HOSPITAL_GENERAL_LAGOS_CLIENT_ID",
       "clientSecretEnvVar": "HOSPITAL_GENERAL_LAGOS_CLIENT_SECRET",
       "mrnIdentifierSystem": "https://generalhospital.example.org/mrn",
       "scope": "system/Patient.read system/Observation.read system/Encounter.read system/MedicationRequest.read system/Condition.read"
     }
   }
   ```

   The `scope` list should match exactly what `ClinicianPortal.jsx`'s
   `SCOPE_OPTIONS` can request (`Observation`, `MedicationRequest`,
   `Encounter`, `Condition`) — request no broader an OAuth scope than the
   resource types the app can ever ask for.

6. **Test the connection in isolation first.** Before touching the app,
   write a throwaway script that constructs your adapter and calls
   `findLocalPatientRecord('general-hospital-lagos', '<a known test MRN>')`
   directly, and log the result:

   ```js
   const { LiveFhirAdapter } = require('./src/services/liveFhirAdapter');
   const adapter = new LiveFhirAdapter();
   adapter.findLocalPatientRecord('general-hospital-lagos', 'TEST-001')
     .then(console.log)
     .catch(console.error);
   ```

   Fix auth/query problems here, where the error is a plain stack trace,
   rather than chasing it through the UI's generic "No matching record
   found" (which, by design per Section 7's security property, won't
   tell you what went wrong).

7. **Set `FHIR_ADAPTER_MODE=live` and start the backend.**
   `getFhirAdapter()` now routes every call naming
   `general-hospital-lagos` through the real EMR; any other `hospitalID`
   not present in `hospitals.json` should fail loudly (throw, don't
   silently fall back to simulated) so a typo'd hospital ID is caught
   immediately rather than quietly returning empty results.

8. **Repeat for each additional hospital** — its own block in
   `hospitals.json`, its own env vars. Nothing else in the app changes.

## 6. Authenticating to the EMR: SMART on FHIR backend services

Nearly every EMR that exposes FHIR (Epic, Cerner/Oracle Health, Meditech,
Allscripts, and open platforms like OpenMRS or a HAPI FHIR server) supports
**SMART Backend Services** (client-credentials OAuth2 with a signed JWT
assertion) for exactly this system-to-system use case — no user is
sitting at a browser, so the interactive SMART launch flow doesn't apply.

1. Register PatientChain as a backend client in the hospital's EMR admin
   console (or their FHIR gateway, e.g. an Epic App Orchard / Cerner Code
   listing for production access). You'll receive a client ID and either
   a shared secret or you'll register a public key for JWT signing —
   prefer the asymmetric (JWK) option if the EMR supports it.
2. On each `resolveRecord`/`findLocalPatientRecord` call (or on a timer,
   caching the token for its lifetime), request a token:

   ```js
   async function getAccessToken(hospitalCfg) {
     const assertion = signBackendServicesJwt(hospitalCfg); // RS384 JWT per SMART spec
     const res = await fetch(hospitalCfg.tokenUrl, {
       method: 'POST',
       headers: { 'content-type': 'application/x-www-form-urlencoded' },
       body: new URLSearchParams({
         grant_type: 'client_credentials',
         client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
         client_assertion: assertion,
         scope: hospitalCfg.scope,
       }),
     });
     if (!res.ok) throw new Error(`token request failed: ${res.status}`);
     return res.json(); // { access_token, expires_in, ... }
   }
   ```

3. Use the `smart-on-fhir-client` or `jose` npm packages rather than
   hand-rolling JWT signing; don't add a hand-written crypto
   implementation here.

## 7. Implementing `findLocalPatientRecord`

This is the method `POST /:did/link-facility` depends on for the
generic-error-on-mismatch guarantee (see `linkageService.js`) — get the
query right and the security property (no enumeration) comes for free
from the code that already calls it.

```js
async findLocalPatientRecord(hospitalID, hospitalNumber) {
  const cfg = this.configFor(hospitalID);
  const token = await this.getAccessToken(cfg);
  const res = await fetch(
    `${cfg.fhirBaseUrl}/Patient?identifier=${encodeURIComponent(hospitalNumber)}`,
    { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/fhir+json' } }
  );
  if (!res.ok) return null; // never distinguish "not found" from "error" to the caller
  const bundle = await res.json();
  const patient = bundle.entry?.[0]?.resource;
  if (!patient) return null;

  return {
    name: formatHumanName(patient.name?.[0]), // FHIR HumanName -> "Given Family"
    dob: patient.birthDate, // already YYYY-MM-DD, matches the format the UI collects
  };
}
```

Two details that matter:

- **The `identifier` search parameter must match how the hospital's MRN
  is actually represented in their `Patient.identifier` array.** Confirm
  the identifier `system` URI with the hospital's integration team (e.g.
  `identifier=https://hospital-a.example.org/mrn|LAG-00231` rather than a
  bare value) — a bare-value search can return the wrong patient if the
  EMR holds identifiers from multiple systems (insurance ID, national ID,
  etc.) in the same field.
- **Never let an EMR error response produce a different message than a
  genuine "no such patient"** in what you return — `linkageService.js`
  already collapses both into one generic error before it reaches the
  patient, but only if this method returns `null` for both cases rather
  than throwing a distinguishable error for one of them.

## 8. Implementing `resolveRecord`

Called only after the route has already validated the on-chain grant,
hospital-level RBAC, purpose-of-use, and scope (`routes/records.js`,
steps 1/1a/1b/1c) — by the time this runs, the request is authorized.
Your job is just to fetch and shape the data.

```js
async resolveRecord(hospitalID, patientDID) {
  const mrn = await this.mrnStore.get(hospitalID, patientDID); // see section 8
  if (!mrn) throw new Error(`no local patient index entry for ${patientDID} at ${hospitalID}`);

  const cfg = this.configFor(hospitalID);
  const token = await this.getAccessToken(cfg);
  const patientRef = await this.findPatientRef(cfg, token, mrn); // Patient?identifier=... -> "Patient/123"

  const resourceTypes = ['Observation', 'Encounter', 'MedicationRequest', 'Condition'];
  const bundles = [];
  for (const type of resourceTypes) {
    const res = await fetch(
      `${cfg.fhirBaseUrl}/${type}?patient=${patientRef}`,
      { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/fhir+json' } }
    );
    if (res.ok) bundles.push(await res.json());
  }
  return { mrn, bundles };
}
```

The simulated adapter returns one synthetic `Bundle` per clinical event;
a live adapter can return the EMR's own search-result `Bundle`s directly
— `ClinicianPortal.jsx`'s rendering already reads
`bundle.entry[0].resource.resourceType` generically, so real FHIR bundles
render without frontend changes. If you want scope-filtered fetching
(only query the resource types the grant actually covers) rather than
always fetching all four, thread `grant.scope` through from
`routes/records.js` into this call — that's a small, optional
optimization, not required for correctness.

## 9. The DID ↔ MRN mapping: local, off-chain, durable

The simulated `didToMrn` is an in-memory `Map` that's wiped on restart —
fine for a demo, not for production. Replace it with the same SQLite
pattern `backend/src/sync/offlineQueue.js` already uses
(`better-sqlite3` is already a dependency):

```js
'use strict';
const Database = require('better-sqlite3');
const path = require('path');

class MrnStore {
  constructor(dbPath) {
    this.db = new Database(dbPath || path.join(__dirname, '..', '..', 'data', 'mrn-links.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mrn_links (
        hospital_id TEXT NOT NULL,
        patient_did TEXT NOT NULL,
        mrn TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (hospital_id, patient_did)
      );
    `);
  }

  set(hospitalID, patientDID, mrn) {
    this.db.prepare(
      `INSERT INTO mrn_links (hospital_id, patient_did, mrn, linked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(hospital_id, patient_did) DO UPDATE SET mrn = excluded.mrn`
    ).run(hospitalID, patientDID, mrn, new Date().toISOString());
  }

  get(hospitalID, patientDID) {
    const row = this.db.prepare(
      `SELECT mrn FROM mrn_links WHERE hospital_id = ? AND patient_did = ?`
    ).get(hospitalID, patientDID);
    return row ? row.mrn : null;
  }
}

module.exports = { MrnStore };
```

This file — not the EMR, not the chain — is the one place that ever
holds the DID ↔ MRN mapping. Back it up like any other production
database; losing it doesn't lose clinical data (the EMR still has it) but
does mean affected patients have to re-run the facility-linking flow.

If you're running one PatientChain backend process per hospital (the
more realistic production topology, each hospital operating its own
node against its own EMR), this file naturally never leaves that
hospital's infrastructure — reinforcing the "never replicated to another
facility" property the design calls for.

## 10. Testing before you touch a production EMR

1. Point `FHIR_ADAPTER_MODE=live` at a public HAPI FHIR test server
   (`https://hapi.fhir.org/baseR4`) or your own local HAPI FHIR JPA server
   (`docker run -p 8080:8080 hapiproject/hapi:latest`) first. No auth
   needed against the public sandbox, so you can validate the request
   shapes before adding SMART auth into the mix.
2. Create a handful of test `Patient` resources with known identifiers
   there, and confirm `findLocalPatientRecord`/`resolveRecord` round-trip
   correctly — then run the existing e2e suite
   (`frontend/e2e/facility-linkage.spec.js`, `golden-path.spec.js`)
   against that backend instead of the simulated one to confirm the whole
   flow still passes.
3. Only then move to the hospital's actual sandbox/UAT FHIR environment,
   and finally production, per their integration process.

## 11. Rollout

Because `getFhirAdapter()` resolves per-process at startup (mirroring
`getLedgerService()`), you can cut hospitals over independently: run one
backend instance per hospital, each with its own `.env`
(`FHIR_ADAPTER_MODE=live` + that hospital's config), while others still
run `FHIR_ADAPTER_MODE=simulated` during rollout. Nothing in the frontend
or the ledger needs to know which mode any given hospital is in.

## 12. When there's no FHIR API to connect to

This is common, not the exception — plenty of EMRs, especially older or
homegrown ones, don't expose FHIR at all. The good news: the method
contract in Section 1 doesn't require a live API on the other end — it
only requires that `findLocalPatientRecord`/`resolveRecord` return the
right shape when the request needs them. Nothing says the underlying data
has to come from a live network call made at that moment. That opens up
real options short of "the hospital must stand up a FHIR server."

### Figure out which category the hospital is in

Ask their IT/informatics team, in this order — roughly most to least
likely to get a "yes," including at older or lower-resource deployments
(the kind Section 5 of `docs/design.md` has in mind):

1. **"Do you have an interface engine or ADT feed?"** HL7 v2 (not FHIR)
   is what most hospital systems actually speak, even ones built in the
   90s/2000s — it's the oldest and most universal healthcare messaging
   standard. A "yes" here usually means they already push ADT
   (admit/discharge/transfer) and ORU (lab result) messages to
   *something*, often via a product like Mirth Connect/NextGen Connect,
   Rhapsody, or Cloverleaf.
2. **"Can we get read access to a reporting database or view?"** Many
   legacy EMRs are, underneath, just a SQL Server/Oracle/MySQL database.
   A read-only account or a nightly reporting replica is a common, if
   inelegant, integration point.
3. **"Can you export patient/encounter data as files?"** CSV,
   pipe-delimited, or HL7v2 batch files dropped on a shared drive or
   SFTP on a schedule.
4. **None of the above.** Some facilities are genuinely still
   paper-based, or only run a standalone billing system with no clinical
   data export at all.

### Option A — HL7 v2 via an interface engine

Stand up (or point at, if the hospital already runs one) an interface
engine like **NextGen Connect (Mirth Connect)** — free/open-source, and
built exactly for this. It receives HL7v2 messages over MLLP; you write a
small channel/transformer that converts ADT (demographics) and ORU
(results) segments into the shape your adapter needs, then writes them
into your own local store — the same SQLite-backed pattern as `MrnStore`
in Section 9, just populated by an inbound message listener instead of an
outbound HTTP call. `findLocalPatientRecord`/`resolveRecord` then read
from that local store synchronously, and don't depend on the EMR being
reachable at request time.

### Option B — direct database read access

If the hospital will grant a read-only account against their EMR's
database (a replica/reporting instance — never their live transactional
primary), write an adapter that queries their schema directly and maps
it to the same contract. Treat this as the least stable option: unlike
FHIR or HL7v2, there's no versioning contract, so a vendor patch or
schema change can break you silently. Isolate all vendor-specific SQL
behind this one adapter class so the rest of the system never sees it,
and add integration tests that would catch schema drift early.

### Option C — scheduled file import

If all they can offer is periodic CSV/HL7-batch exports, write a small
importer (a cron job or scheduled task) that reads the latest export and
calls `addLocalPatientRecord` for each patient — literally the same
method `POST /local-records/:hospitalID` already calls from the Admin
Dashboard's manual-entry form. The importer is just a second, automated
caller of that existing method.

### Option D — no digital source at all

If the hospital has nothing to integrate with, the **Admin Dashboard's
"Hospital local patient roster" panel is the production path**, not a
demo convenience — staff key in each patient's hospital number, name,
and date of birth by hand as they register them, exactly the flow
already built. `resolveRecord` has nothing to actually fetch in this
case: PatientChain's value for that hospital is limited to the
authorization/audit layer (grant a clinician access, log it immutably),
not automated retrieval of the record itself — the clinician still pulls
the physical chart or calls the other facility, same as before
PatientChain existed. That's a legitimate, honest scope for a facility
with no digital record system — set that expectation with the hospital
up front rather than promising record retrieval you can't deliver.

### The common thread

In every option except a live FHIR API, the adapter doesn't query the
source *at request time* — it queries a local store that something else
(an HL7v2 listener, a DB sync job, a file importer, or a human) populated
ahead of time. Structure it as two pieces regardless of source: a
**populator** (however data gets in) and the **adapter** (the same five
methods from Section 1, reading from local storage). That split is why
the method contract matters more than any specific implementation — it's
what lets a hospital with a modern FHIR API and a hospital with nothing
but paper charts both plug into the same PatientChain deployment.
