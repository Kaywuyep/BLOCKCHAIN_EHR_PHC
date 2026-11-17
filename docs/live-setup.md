# Running Cevruni for real (no demo)

This is the setup for testing with real hospitals and people: Hyperledger
Fabric, password accounts, no demo data.

## Start

```bash
# 1. Fabric (only when the network is down; a fresh ledger wipes the old one)
cd network
docker compose -f docker-compose.yaml down -v          # fresh ledger only
PATH=$PWD/bin:$PATH FABRIC_CFG_PATH=$PWD/config ./scripts/network-up.sh
PATH=$PWD/bin:$PATH FABRIC_CFG_PATH=$PWD/config ./scripts/deployChaincode.sh

# 2. Backend (Node 22)
cd ../backend && nvm use 22 && npm run start:live

# 3. Frontend
cd ../frontend && npx vite --port 5277
```

`npm run start:live` sets `AUTH_MODE=password`, `LEDGER_MODE=fabric`,
`DEMO_SEED=off`, `HL7_MLLP_ENABLED=true` and `DATA_DIR=backend/data/live`.
The token-signing secret is created once in `data/live/.jwt-secret`.

After a ledger reset, also delete `backend/data/live`. Otherwise the
database still lists accounts the new ledger has never seen.

## Who signs in, and how

| Who | Username | How the account is made |
|---|---|---|
| System admin | `superadmin` | Created on the first start. The temporary password is printed **once** in the backend log (`FIRST START: …`). |
| Hospital admin | `admin@<hospital-id>` | Created with the hospital (System admin → Hospitals → Add hospital). The temporary password is shown once after saving. |
| Clinician | `<staff-id>@<hospital-id>` | Hospital admin → Clinicians → **Add from EMR**, by staff ID. The temporary password is shown once. |
| Patient | their email | They sign up themselves: full name, email, password. |

- **Temporary passwords:** they must be changed at first sign-in, and
  nothing else works until then.
- **Forgotten passwords:** a hospital admin resets their clinicians'
  passwords from the Clinicians page; the system admin resets anyone's from
  Users.
- **Password rules:** at least 10 characters, with a letter and a number,
  and not containing the person's name or username.
- **Lockout:** five wrong passwords lock the account for 15 minutes.

## What goes on the blockchain

Each item below is written to the ledger as an audit entry **before** it is
saved. If Fabric is down, nothing is created.

- `ACCOUNT_CREATED`: every new account. Only the opaque account ID and the
  role go on-chain, never a name or email.
- `HOSPITAL_REGISTERED`: every new hospital.
- `CLINICIAN_STATUS_CHANGED`: a clinician deactivated or re-activated
  after an EMR re-sync, or suspended locally.

A patient's Health ID (DID) is created later, when they confirm their
record at their first hospital (Chapter 3, FR1). Sign-up alone does not
create it.

## Clinicians come from the hospital's EMR

The hospital needs a **FHIR R4** or **Both** connection (System admin →
Hospitals → Connection).

- **Lookup:** Cevruni searches
  `Practitioner?identifier=<staff ID system>|<staff ID>` and reads the
  person's `PractitionerRole` to get their role, department and whether the
  role is active. Set the *Staff ID identifier system* to the hospital's
  `Practitioner.identifier.system`. If it is left blank, the ID is matched
  in any system.
- **The EMR is in charge:** name, role, department and active status are
  copied from it and can't be edited in Cevruni. **Re-sync** applies EMR
  changes. Someone the EMR marks inactive, or who has been removed from it,
  becomes inactive in Cevruni and can no longer sign in.
- **Local suspension:** a hospital admin can suspend a clinician locally,
  which is stricter than the EMR. They can't re-activate someone the EMR
  marks inactive.
- **FHIR scopes:** the OAuth2 scope needs `system/Practitioner.read
  system/PractitionerRole.read`. These are in the default scope for new
  hospitals.
- **Hospitals without a FHIR connection:** clinicians are typed in by hand.

## Hospitals running SmartClinic (Primed E-Health), e.g. JUTH

SmartClinic has no FHIR or HL7 interface. Choose **SmartClinic (Primed
E-Health)** under Hospitals → Add hospital → Connection.

1. **API address:** paste the SmartClinic link staff use, for example
   `http://10.0.0.20:4500/?base=http://10.0.0.20:8001/v1/&…`.
   The `base=` part is picked out for you.
2. **Account:** enter the username and password of the account the hospital
   created for Cevruni. Ask for read-only access: search patients, list
   staff, read records. The password is stored encrypted.
3. **Test:** enter a test patient's hospital number and a staff ID, then
   press **Test connection**. If a lookup fails, open the field list that
   comes back, press **Use the suggested field mapping**, or correct the
   field names by hand.
4. **Save.** From then on:
   - when a patient links this hospital, their hospital number and name are
     checked against SmartClinic at that moment;
   - the hospital admin's **Add from EMR** reads staff from SmartClinic.

Staff IDs with "/" are kept as the hospital writes them; their Cevruni
username uses "-" instead (`JUTH/0042` → `juth-0042@<hospital-id>`).

Not yet available: opening a patient's SmartClinic medical records inside
Cevruni after a grant. Those answers need mapping to FHIR once we have seen
real SmartClinic records.
