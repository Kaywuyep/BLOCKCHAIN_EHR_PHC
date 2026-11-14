# Cevruni demo guide

The backend loads a complete demo world every time it starts in development (`AUTH_MODE=local`, `LEDGER_MODE=simulated`). It is defined in `backend/src/demo/demoData.js` and loaded by `backend/src/demo/demoSeed.js`.

- Set `DEMO_SEED=off` to start without it. Always do this for evaluation runs (`scripts/evaluate.js`), so the demo activity does not mix with the measurements.
- The demo never loads in production.
- On the simulated ledger, the on-chain part (grants, audit history) is rebuilt fresh on each restart. Anything you did by hand on the ledger is reset; your off-chain changes (hospitals, users, links) stay.

Sign in on the login page with **Quick access**, or with the manual form: pick the role, type the user ID and, for staff, the hospital ID. There are no passwords in development mode.

## The hospitals

| Hospital | ID | Connection | What it shows |
|---|---|---|---|
| General Hospital Langtang | `general-hospital-langtang` | HL7 ADT, MLLP port 5001 + HTTPS | Main demo hospital: every grant state, break-glass, HL7 messages |
| General Hospital Wase | `general-hospital-wase` | HL7 ADT, MLLP port 5002 + HTTPS | Cross-hospital sharing, a reviewed break-glass, a rejected HL7 message |
| Jos University Teaching Hospital | `jos-university-teaching-hospital` | HL7 over HTTPS **and** FHIR API | Records fetched **live** from the hospital's FHIR server (a built-in demo FHIR server stands in for JUTH's EMR) |
| Plateau Specialist Hospital | `plateau-specialist-hospital` | Custom REST push | Records pushed as FHIR JSON to `/api/ingest/...` |
| Our Lady of Apostles Hospital | `our-lady-of-apostles-hospital` | Manual roster | No integration; a patient-granted hospital access |

## The accounts

| User ID | Role | Hospital | Notes |
|---|---|---|---|
| `superadmin` | System admin | — | Hospitals, Users, every hospital's admin pages |
| `admin-langtang` | Hospital admin | Langtang | Also `admin-wase`, `admin-juth`, `admin-psh`, `admin-ola` |
| `dr-musa` | Clinician (Physician) | Langtang | Active grants for Amina at Langtang and Wase; a break-glass on Ibrahim awaiting review |
| `dr-aisha` | Clinician (Physician) | Langtang | Her grant was revoked by Amina |
| `nurse-grace` | Clinician (Nurse) | Langtang | Her grant has expired |
| `lab-sani` | Clinician (Laboratory Scientist) | Langtang | Lab-only grant for Ibrahim |
| `dr-yakubu` | Clinician (Physician) | Langtang | **Suspended**: holds an active grant but is refused at the gateway |
| `dr-chukwu` | Clinician (Physician) | Wase | Pending request to Amina; grant and reviewed break-glass for Fatima |
| `dr-bello` | Clinician (Consultant) | JUTH | Active grant for Ibrahim (live FHIR); pending request to Amina |
| `dr-danladi` | Clinician (Consultant) | Plateau Specialist | Pending request to Amina |
| `dr-okon` | Clinician (Physician) | Our Lady of Apostles | No grants |
| `hl7-langtang` | HL7 interface | Langtang | For sending HL7 over HTTPS |
| `rest-psh` | HL7 interface | Plateau Specialist | For the custom REST push |
| `amina` | Patient | — | Linked to 4 hospitals; grants in every state; 3 pending requests |
| `ibrahim` | Patient | — | Linked to Langtang and JUTH; can still link Wase (see below) |
| `fatima` | Patient | — | Linked to Wase and Our Lady of Apostles |
| `chinedu` | Patient | — | Linked to Our Lady of Apostles only; no grants |

The demo patients have **no signing key** on any device, so they approve and revoke unsigned. To see patient signatures, register a new patient (scenario 1).

## Hospital numbers for trying linking yourself

These records exist in the hospitals' rosters but are **not linked** to anyone:

| Hospital | Hospital number | Name | Date of birth | Use it for |
|---|---|---|---|---|
| Langtang | `LTG-2001` | Hauwa Danjuma | 1993-05-20 | Registering a brand-new patient |
| Wase | `W-3002` | Emeka Obi | 1985-09-30 | Registering a second new patient |
| Wase | `7781234` | Ibrahim Musa | 1988-07-22 | Ibrahim linking Wase under **My Hospitals** |
| Plateau Specialist | `PSH-5510` | Fatima Bello | 1992-11-08 | Fatima linking Plateau Specialist |

A wrong number or a wrong date of birth gives the same "No matching record found" message.

## How access works (read this first)

- **Each hospital's own records are in its own EMR.** Cevruni does not show a clinician their own hospital's records.
- **Cevruni only lets a clinician at one hospital view a patient's records held at another hospital**, and only if the patient has **both** hospitals in their network.
- **Two ways in:**
  - the patient approves a request (or shares ahead of time with a whole hospital);
  - **break-glass** in an emergency. This lasts 1 hour, covers emergency record types only (allergies, medications, diagnoses, encounters, labs), and can be extended with a reason up to 24 hours. Both hospitals' admins and the patient see it.

The legal reasoning is in `docs/legal-basis-emergency-access.md`.

## Scenarios to try

1. **New patient with their own key.** Sign in manually as role *Patient*, user ID `hauwa`. On **My Health ID** choose General Hospital Langtang, number `LTG-2001`, date of birth 1993-05-20, then **Find my record**, then **Yes, create my Health ID**. The page shows "Signing key: on this device ✓".
2. **Request records from another hospital.** As `dr-musa` (Langtang), go to **Request Access** and find `104892` (Ibrahim Musa). His network shows JUTH. Tick it and the record types, then send. As `ibrahim` (another window), the request appears at once under **Access Control**: approve or decline.
3. **Record-type scope.** As `dr-musa`, open **View Records**, then Amina's **JUTH** grant (labs, diagnostic reports, medications). Other types are withheld, and the panel says how many.
4. **Live FHIR.** JUTH is connected by FHIR API. Any JUTH records opened (scenario 3, or the emergency in scenario 7) are marked "fetched live from the hospital's FHIR server".
5. **Suspended clinician.** As `dr-yakubu`, **View Records** → Amina's JUTH grant → refused by hospital RBAC.
6. **Approve all / decline.** As `amina`, **Access Control** has three requests (from Wase, JUTH and Plateau Specialist clinicians, for her Langtang records). **Approve all** sends them as one ledger transaction; **Decline** refuses one.
7. **The emergency.** Amina was rushed to Langtang; her husband gave her JUTH number.
   - As `dr-musa`, **View Records** shows the orange **Emergency access** card for her JUTH records. Open it to see her allergies, medications and diagnoses, then **Extend access…** with a reason.
   - As `admin-langtang` and as `admin-juth` (role Hospital Admin, hospital `jos-university-teaching-hospital`), **Break-Glass Review** shows it from each side, with the husband's details and "matches ledger hash".
   - As `amina`, **Access Control** shows it at the top with the reason and who asked.
8. **Make a new emergency yourself.** As `dr-musa`, open **Emergency Access**, choose JUTH, enter `10087654` (Ibrahim), a reason and optionally the family member. Or run `npm run demo:break-glass` in `backend/`; options are in the script, e.g. `-- --clinician dr-chukwu --patient fatima`.
   - **Refused case:** as `dr-musa`, try Our Lady of Apostles number `OLA-1203` (Chinedu). It is refused because Chinedu has not added Langtang to his network.
9. **Hospital admin view.** As `admin-langtang`:
   - **Overview:** our records opened by others, and what our clinicians opened elsewhere.
   - **Record Access Log** and **Access Grants:** both directions.
   - **Clinicians**, **Patients**.
10. **Share ahead of time.** As `amina`, **Access Control → Let a hospital see records from another**. Choose Wase clinicians and Plateau Specialist records, then **Share**. Every active Wase clinician can then open them under **View Records**.
11. **Audit trail.** As `amina`, **Audit Trail** lists every access, grant, decline, revocation, emergency access, extension and screenshot attempt.
12. **System admin.** As `superadmin`: **Hospitals** (JUTH → **Test connection** passes), **Users**, **Screenshot Attempts**, and any hospital's admin pages via the picker.
13. **HL7 feed.** As `superadmin`, **Hospitals**: Langtang shows accepted messages; Wase shows one rejected.
14. **Custom REST push.** As `rest-psh` via the API, `POST /api/ingest/plateau-specialist-hospital` with FHIR R4 JSON (example under **Hospitals → Plateau Specialist → Connection**).
15. **Offline mode.** As `superadmin`, **Sync Status** → go offline. Approve or revoke as a patient (it is queued), then go online again and the queue replays in order.
16. **Screenshot deterrent.** Press PrintScreen (Windows) or Cmd+Shift+4 (Mac): the noise appears and the attempt is logged.
