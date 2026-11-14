# Cevruni — User Roles & Navigation Guide

> **Your Health. Your Records. Your Control.**

Cevruni is a blockchain-based electronic health record system that gives patients control over who can access their medical records. The platform serves four distinct user roles, each with a tailored dashboard and clear navigation.

---

## Quick Start

### Demo Accounts

| Account       | Role           | User ID      | Hospital ID  | Password |
|--------------|----------------|--------------|--------------|----------|
| Super Admin  | system_admin   | `superadmin` | —            | none*    |
| Clinician    | clinician      | `dr-musa`    | `general-hospital-langtang` | none*    |
| Patient      | patient        | `amina`      | —            | none*    |
| Hospital Admin | hospital_admin | `admin-langtang` | `general-hospital-langtang` | none* |

*AUTH_MODE=local uses development tokens — no password required. In production, authentication goes through the hospital's identity provider (OIDC).*

### Signing In

1. Open the application in your browser
2. On the login page, either:
   - Click a **Quick Access** button to sign in as a demo user instantly
   - Or fill in the manual sign-in form with your role, user ID, and hospital ID
3. After signing in, you'll be taken directly to your role's dashboard

---

## User Roles

### 1. Patient

**Who**: Any individual who wants to manage their health records across multiple hospitals.

**What they can do**:

| Feature | Where to Find It | Description |
|---------|-----------------|-------------|
| Health ID | Sidebar → **My Health ID** | Confirm your record at your first hospital, then create your blockchain identity (DID) and a signing key kept on this device |
| Link Facilities | Sidebar → **My Hospitals** | Connect your identity to other hospitals where you already have records |
| View Records | Sidebar → **My Records** | See all record references (on-chain pointers — clinical data stays at the hospital) |
| Access Control | Sidebar → **Access Control** | Approve or revoke clinician requests to view your records |
| Audit Trail | Sidebar → **Audit Trail** | View every access event, immutably recorded on the blockchain |

**How it works (step by step)**:
1. Sign in as a patient
2. On **My Health ID**, pick the hospital you registered with first, enter the hospital number on your card and your date of birth, and confirm "Is this you?". Your Health ID is then created, and a private signing key is generated on this device (it never leaves it). Demo: General Hospital Langtang, `536728`, born 1995-03-15 (Amina Yusuf).
3. Optionally link other hospitals under **My Hospitals** the same way
4. When a clinician requests access, it appears under **Access Control** straight away (no refresh needed). Approve it for that hospital only, share other hospitals too, or **Approve all** pending requests at once. Every approval and revocation is signed with your key and checked on the blockchain.
5. A grant covers only the record types the clinician asked for (for example lab results only) and only clinicians in the stated role
6. Check **Audit Trail** anytime to see who accessed your records and when

> Your signing key lives on the device where you created your Health ID. Approve and revoke from that device.

---

### 2. Clinician

**Who**: Doctors, nurses, and healthcare providers who need to view patient records for treatment.

**What they can do**:

| Feature | Where to Find It | Description |
|---------|-----------------|-------------|
| Request Access | Sidebar → **Request Access** | Ask a patient for permission to view their records, with a declared purpose and scope |
| Emergency Access | Sidebar → **Emergency Access** | Break-glass access when a patient cannot consent (logged and reviewed) |
| View Records | Sidebar → **View Records** | Pull FHIR bundles from a hospital once an access grant is active |

**How it works (step by step)**:
1. Sign in as a clinician (your provider ID and hospital are pre-filled)
2. Your own hospital's records are in your hospital's EMR. Cevruni is for records held at the patient's **other** hospitals.
3. Find the patient by **your** hospital's number. You see which other hospitals are in their network.
4. Tick the hospital(s), the purpose and the record types, then **Send request to patient**. The patient is notified immediately.
5. Once approved, open the records under **View Records**. They stay at that hospital; you only view them.
6. **Emergency Access** (patient cannot consent): choose the other hospital, enter the patient's number **there** (e.g. from family), the reason and, optionally, the family member who asked. You get 1 hour of emergency record types (allergies, medications, diagnoses, encounters, labs), extendable with a reason up to 24 hours. It only works if the patient has both hospitals in their network. Both hospitals' admins and the patient see it.
6. In emergencies, use **Emergency Access** with a justification — access is immediate but requires admin review

---

### 3. Hospital Admin

**Who**: Administrators of one hospital. They only ever see their own hospital.

**What they can do**:

| Feature | Where to Find It | Description |
|---------|-----------------|-------------|
| Overview | Sidebar → **Overview** | Record accesses this week, break-glass awaiting review, active and pending grants, clinicians, linked patients, screenshot attempts |
| Record Access Log | Sidebar → **Record Access Log** | Every time a clinician opened a patient's records here: who, which patient, when, under which grant. From the immutable audit trail; filter by clinician, search, export CSV |
| Access Grants | Sidebar → **Access Grants** | Every patient grant covering this hospital's records: clinician and role, record types, purpose, status, dates, patient-signed |
| Clinicians | Sidebar → **Clinicians** | Register clinicians, set their role and department, suspend them; see each one's access activity |
| Patients | Sidebar → **Patients** | Patients who linked their Health ID here, with active grants and last access |
| Break-Glass Review | Sidebar → **Break-Glass Review** | Review emergency accesses (mandatory) |
| Patient Roster | Sidebar → **Patient Roster** | The hospital's local demographic records used for linking |
| Hospitals | Sidebar → **Hospitals** | This hospital's connection status (HL7 listener, message counts) |
| Screenshot Attempts | Sidebar → **Screenshot Attempts** | Screenshot attempts by this hospital's staff |

Only clinicians registered and **active** here can use a grant at this hospital. A grant is tied to the clinician's role, so changing someone's role stops their existing grants working.

---

### 4. System Admin (Superuser)

**Who**: The platform administrator with full access to all features.

**What they can do**:
- Access **all three portals** (Patient, Clinician, Admin) via the sidebar section switcher
- Add and configure hospitals (**Hospitals**): HL7 ADT feed, FHIR API (with mutual TLS), both, custom REST push, or manual roster
- See every user and their roles (**Users**)
- Open any hospital's admin pages, choosing the hospital at the top
- View and manage any resource in the system
- Monitor system-wide health and operations

---

## Navigation Guide

### Sidebar (Left Panel)

The sidebar is the primary navigation tool. It has three sections:

1. **Brand & Logo** — Click to return to the home dashboard
2. **Section Switcher** — Switch between Patient, Clinician, and Admin portals (visible sections depend on your role)
3. **Page Navigation** — Navigate to specific pages within your current portal
4. **User Info** — Shows your identity, role, and a sign-out button

The sidebar can be collapsed by clicking the arrow button for more screen space.

### Top Bar

Shows the current section name, backend connectivity status, and ledger mode.

### Dashboard Cards

Each role's home page shows a summary dashboard with key metrics at a glance:
- **Patient**: Health ID status, active grants, pending requests
- **Clinician**: Quick access to request forms
- **Admin**: Hospital count, connectivity, pending reviews, transaction totals

---

## Security Features

| Feature | Description |
|---------|-------------|
| **Blockchain audit** | Every access event is immutably recorded on Hyperledger Fabric |
| **Scoped access** | Clinicians can only request specific FHIR resource types |
| **Time-limited grants** | Access expires automatically after the approved duration |
| **Patient revocation** | Patients can revoke any active grant immediately |
| **Break-glass logging** | Emergency access is distinctly logged and requires mandatory review |
| **Role-based access** | Each user only sees pages and data relevant to their role |
| **Session-based auth** | Tokens expire and are stored only in session storage |

---

## Tips for New Users

1. **Start with the sidebar** — it shows everything you can do
2. **Look at the dashboard first** — the overview cards tell you what needs attention
3. **Hover over cards** — they highlight to show they're interactive
4. **Check the top bar** — the connectivity dot tells you if the backend is reachable
5. **Use Quick Access on login** — the fastest way to explore each role
