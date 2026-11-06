# Connecting to a hospital's HL7 v2/ADT feed

Unlike the live-FHIR path in `docs/fhir-adapter-live-emr-guide.md` (which is
still a build guide — `liveFhirAdapter.js` doesn't exist yet), the HL7 v2
ADT ingestion path described here **already exists and is tested**:
`backend/src/services/hl7AdtListener.js`, `backend/src/routes/hl7.js`,
`backend/src/services/hospitalIngestionConfig.js`. This doc is about wiring
a real hospital's real interface engine into it, not building it.

HL7 v2 is the right default to reach for first. It's the oldest and most
universal hospital messaging standard — most EMRs speak it, including
ones from the 1990s/2000s that have no FHIR API at all — whereas FHIR
adoption in-country is still uneven. See `docs/fhir-adapter-live-emr-guide.md`
Section 12 for the decision tree on which integration path a given
hospital actually supports.

## 1. What already exists, in one picture

```
Hospital's ADT source (EMR, interface engine, or a manual re-send)
        │
        │  MLLP over TCP (the traditional wire protocol)      ┐
        └─────────────────────────────────────────────────────┤  both converge on
                                                                 │  ingestParsedMessage()
   -- OR, for local/synthetic testing or an engine that can --  │
      only do HTTP --                                           │
                                                                 │
        POST /api/hl7/adt/:hospitalID  (raw HL7 text body)     ┘
                        │
                        ▼
        hl7AdtListener.js: parses MSH/PID/PV1, maps to FHIR
        Patient/Encounter shapes, writes through fhirAdapter's
        existing addLocalPatientRecord() / recordResourceByHospitalNumber()
                        │
                        ▼
        Same roster/record store the REST/DB path and the Admin
        Dashboard's manual-entry form already write to — nothing
        downstream (linkageService.js, routes/records.js, the audit
        trail) can tell which path a given patient's data arrived by.
```

Two transports, one ingestion function (`ingestParsedMessage` /
`ingestRawAdtText`), one destination. You don't need to touch
`fhirAdapter.js`, `linkageService.js`, or any route to onboard a hospital
this way — only configuration.

## 2. What each transport is for

| Transport | Use it when | Entry point |
|---|---|---|
| **MLLP (TCP)** | A real hospital interface engine (Mirth Connect, Rhapsody, Cloverleaf) or the EMR itself pushes ADT natively — this is what "HL7 integration" means to a hospital's IT team by default | `startMllpListener()` in `hl7AdtListener.js`, started from `server.js` when `HL7_MLLP_ENABLED=true` |
| **HTTP POST** | Local development, the synthetic test script, or an integration engine that can only deliver via HTTP (some can) | `POST /api/hl7/adt/:hospitalID`, raw HL7 text body, `routes/hl7.js` |

Real hospitals should be onboarded via MLLP — it's the transport their
interface engine already knows how to send, so you're not asking them to
build anything new on their side.

## 3. Configure one hospital for HL7 ingestion

1. **Copy the example config**, if you haven't already:
   ```bash
   cp backend/config/hospitalIngestion.example.json backend/config/hospitalIngestion.json
   ```
   This file is gitignored, same as `.env` — real facility config never
   gets committed.

2. **Add an entry keyed by that hospital's exact `hospitalID`** (the same
   free-text string typed into the "Hospital ID" field on the Patient
   App / Clinician Portal / Admin Dashboard, and passed to
   `POST /api/providers/register` — pick it once, keep it stable):

   ```json
   {
     "general-hospital-lagos": {
       "mode": "hl7",
       "mllpPort": 5001,
       "hl7Version": "2.5"
     }
   }
   ```

   Give every hospital configured for HL7 its own port — that mirrors how
   real ADT interfaces are provisioned (one interface = one port) and
   keeps one hospital's feed from being able to inject data under
   another's `hospitalID`.

3. **Set `HL7_MLLP_ENABLED=true`** in `backend/.env`. Without it,
   `server.js` never calls `startMllpListener()` for any hospital, even
   if `hospitalIngestion.json` has entries — this is a deliberate
   two-key switch (global enable + per-hospital config) so a stray config
   file can't silently open a listening port.

4. **Start the backend.** You should see, per configured hospital:
   ```
   [hl7AdtListener] general-hospital-lagos: MLLP listener on port 5001
   ```

That's the entire application-side setup. Everything else in this guide
is about the hospital's side and the network path between the two.

## 4. Setting up the hospital side: NextGen Connect (Mirth Connect)

Most hospitals either already run an interface engine or are willing to
stand one up rather than have their EMR talk directly to a new external
system. **NextGen Connect (formerly Mirth Connect)** is free, open
source, and the de facto standard for exactly this — recommend it if the
hospital has nothing already.

### 4.1 If the hospital already runs an interface engine

You don't need to install anything — ask their integration team to add a
new **outbound destination** to their existing ADT channel, pointed at
your backend's MLLP listener:

- Protocol: MLLP (LLP)
- Host: your backend's address (see Section 6 on reachability)
- Port: the `mllpPort` you configured for them in step 3 above
- Encoding: HL7 v2.x, ER7 (pipe-delimited) — not XML
- Character encoding: ASCII/UTF-8 (confirm; some legacy engines default
  to a codepage that mangles non-ASCII names)

They keep sending their existing ADT stream; you're just adding a second
destination.

### 4.2 If you're standing up Mirth Connect yourself

1. **Install.** Download NextGen Connect from
   `https://www.nextgen.com/products/connectivity/nextgen-connect-integration-engine`
   (or run the official Docker image: `docker run -p 8443:8443 -p 6661:6661 nextgenhealthcare/connect`).
   Log into the Administrator UI (default `https://localhost:8443`).

2. **Create a channel** (e.g. `PatientChain ADT Forwarder`):
   - **Source connector**: however the hospital can hand you messages —
     an **LLP Listener** if the EMR pushes MLLP directly to Mirth, a
     **File Reader** if they only export batch files, or a **Database
     Reader** if you're polling a reporting view. This is the one part
     that's genuinely hospital-specific; ask their team which source fits
     (see `docs/fhir-adapter-live-emr-guide.md` Section 12 for the same
     "what can they actually give you" decision tree — it applies
     identically here).
   - **Filter** (optional but recommended): drop anything that isn't an
     ADT message (`msg['MSH']['MSH.9']['MSH.9.1'].toString() == 'ADT'`)
     before it reaches the destination, so you're not paying for/logging
     traffic `hl7AdtListener.js` would reject anyway.
   - **Destination connector**: **LLP Sender**, pointed at your backend's
     host and the `mllpPort` from step 3. Leave the message as-is —
     `hl7AdtListener.js` does its own mapping, so no transformer is
     needed on Mirth's side unless the source segments don't match the
     field-position table in Section 7.
   - **Response handling**: set the destination to wait for and log the
     ACK. `hl7AdtListener.js` sends `MSA|AA` on success and `MSA|AE` on a
     rejected message (bad/incomplete message) — Mirth's dashboard will
     show these per-message, which is your first troubleshooting signal.

3. **Deploy the channel** and watch Mirth's dashboard for message counts
   and any errored messages before moving to a real feed.

## 5. Test before touching anything real

Do this in order — each step removes one variable before you add the
next:

1. **Run the existing synthetic test script** against your own backend,
   no network or Mirth involved at all:
   ```bash
   node backend/scripts/sendSyntheticAdt.js
   ```
   This feeds known-good and deliberately-bad fixtures
   (`services/hl7AdtListener.fixtures.js`) through the real HTTP endpoint
   and asserts the expected roster/encounter outcome for each. If this
   doesn't pass, nothing downstream will either — fix here first.

2. **Send one of those same fixtures over real MLLP**, to confirm the TCP
   listener itself (not just the HTTP route) is reachable and ACKing.
   `hl7AdtListener.mllp.test.js` shows the exact framing
   (`\x0b` + message + `\x1c\r`); a quick way to do this by hand is
   `netcat`:
   ```bash
   printf '\x0bMSH|^~\\&|ADTAPP|HOSP|PATIENTCHAIN|HOSP|20240115080000||ADT^A01|MSG1|P|2.5\rPID|1||LAG-00231||OKAFOR^ADAEZE^N||19900412|F\r\x1c\r' \
     | nc localhost 5001
   ```
   Expect a response containing `MSA|AA`. Then confirm the patient landed
   correctly:
   ```bash
   curl http://localhost:4000/api/patients/local-records/general-hospital-lagos
   ```

3. **Point Mirth (or the hospital's engine) at your listener with a
   single hand-crafted test message**, not a live feed — most engines let
   you manually inject one message from the dashboard rather than
   waiting for a real patient event.

4. **Only then connect a real ADT feed**, ideally the hospital's test/UAT
   environment first, not production — same phased order as the FHIR
   guide's Section 10.

5. **Run the e2e suite** (`frontend/e2e/facility-linkage.spec.js`,
   `golden-path.spec.js`) once a hospital is live on this path, to confirm
   the rest of the app behaves identically regardless of which ingestion
   path populated the roster.

## 6. Network reachability and security

MLLP is a bare TCP protocol with **no built-in authentication or
encryption** — this matters more here than for the FHIR path, which rides
on HTTPS/OAuth2 by default.

- **Don't expose the MLLP port to the public internet.** The standard
  pattern is a **site-to-site VPN or a private link** between the
  hospital's network and wherever your backend runs (or, simplest of
  all, run one PatientChain backend instance *inside* the hospital's own
  network, per Section 9 below) — the same posture hospitals already use
  for their existing interface-engine traffic.
- **If a VPN isn't available**, wrap the connection in TLS using
  `stunnel` (or Mirth's own TLS-enabled LLP Sender/Listener option) rather
  than sending raw MLLP over the open internet.
- **Firewall rule**: only the hospital's known interface-engine IP(s)
  should be able to reach the `mllpPort`. Because each hospital gets its
  own port (Section 3), a misconfigured or compromised feed from one
  hospital can't inject messages under another `hospitalID` — but nothing
  stops it from sending garbage under *its own* `hospitalID` if the port
  is open to more than that one source, so restrict by IP regardless.
- **This traffic carries real PHI** (names, DOB, encounter details) in
  plaintext ER7, unless wrapped in TLS as above — treat the transport
  security requirement as non-optional for any real hospital feed, not
  just a hardening nice-to-have.

## 7. Field mapping reference

This is implemented, not aspirational — see the full docstring at the top
of `backend/src/services/hl7AdtListener.js` for the authoritative version
with rationale. Summary:

| HL7 field | Maps to | Notes |
|---|---|---|
| `MSH-9.1` | must equal `ADT` | anything else is logged and skipped |
| `MSH-9.2` | trigger event | `A01`/`A03` get explicit encounter-status handling; any other ADT trigger (`A02`, `A04`, `A11`, ...) still updates the roster |
| `PID-3.1` | hospital number | the key everything is filed under — **required** |
| `PID-5.1/5.2/5.3` | family / given / middle name | **PID-5.1 and a name are required**; message is rejected without them |
| `PID-7` | date of birth | `YYYYMMDD` → `YYYY-MM-DD` |
| `PID-8` | sex → FHIR gender | HL7 Table 0001 → FHIR AdministrativeGender |
| `PV1-2` | patient class → Encounter.class | presence of PV1-2 is what decides whether an Encounter is created at all — no PV1, no encounter (e.g. a demographics-only A08) |
| `PV1-3.1/3.2/3.3` | point of care / room / bed → Encounter.location | joined into one display string |
| `PV1-7.1/7.2/7.3` | attending doctor → Encounter.participant | only added if PV1-7 is present |
| `PV1-44` / `PV1-45` | admit / discharge date-time → Encounter.period | discharge present ⇒ status `finished`, same as A03 |

**If a hospital's feed uses non-standard field positions** (common with
older or heavily customized vendor systems), don't fork
`hl7AdtListener.js` per hospital — add a Mirth transformer step on that
hospital's channel that remaps their fields into the standard positions
above before forwarding, keeping the parser itself hospital-agnostic. If
the divergence is large enough that this becomes unwieldy, that's a
signal to revisit the mapping function to accept an optional per-hospital
field-position override, but don't build that speculatively before a
real feed actually needs it.

## 8. What gets rejected, and why that's by design

A message is logged and skipped (never crashes the listener) when:

- It isn't parseable HL7 at all (garbled/missing MSH) → HTTP path returns
  `400`, MLLP path ACKs `MSA|AE`.
- `MSH-9.1` isn't `ADT` (e.g. an ORU lab result arrives on the same feed)
  → same rejection, this is expected if a hospital's engine routes
  multiple message types to one destination; add the ADT-only filter from
  Section 4.2 on Mirth's side to avoid the noise, or leave it — rejection
  is harmless either way.
- `PID-3` (hospital number) or `PID-5` (name) is missing → can't build a
  usable roster entry.

Unrecognized segments (vendor Z-segments, a stray garbled line elsewhere
in the message) are tolerated and ignored, not rejected — only the
MSH/PID/PV1 fields above are load-bearing.

## 9. Production topology and rollout

Same principle as the FHIR guide's Section 11: **onboard hospitals
independently.** Nothing in `hospitalIngestionConfig.js` or
`startMllpListener()` requires every hospital to use the same ingestion
mode — one hospital can be `"mode": "hl7"` while another is
`"mode": "fhir-rest"` or `"mode": "manual"`, in the same config file, at
the same time.

The more realistic production shape for HL7 specifically: run **one
PatientChain backend process per hospital**, inside or adjacent to that
hospital's own network, with only that hospital's entry in its
`hospitalIngestion.json`. This sidesteps the cross-internet MLLP exposure
problem in Section 6 entirely — the interface engine and the MLLP
listener are both on the hospital's own LAN — at the cost of operating N
backend deployments instead of one central one. Weigh that against a
central deployment + VPN per hospital based on how many facilities you're
actually onboarding; don't build the multi-instance orchestration until a
second real hospital is actually being onboarded.

## 10. Monitoring in production

- **Watch the ACK type, not just "did a connection happen."** An `MSA|AE`
  response means the transport worked but the message was rejected
  (Section 8) — that's a data-quality problem on the sending side, not a
  network problem, and needs a different fix.
- **Log volume vs. expected hospital census.** A sudden drop in ADT
  message volume from a previously-active feed usually means the
  hospital's engine or network link died, not that admissions stopped —
  alert on it the same way you'd alert on any other silent-failure
  integration.
- Nothing in `hl7AdtListener.js` currently emits metrics beyond
  `console.log`/`console.warn` — if you need dashboards or alerting on
  this in production, that's on the same order of work as the
  `getRecentEvents()` gap already noted in the main README's "Honest
  limitations" section, not something this guide's scope covers.
