# Legal basis: access between facilities and emergency (break-glass) access

This note records how Cevruni's access rules were checked against Nigerian law (November 2026). It is a technical reading by the project team, not legal advice; confirm it with the supervisor or a lawyer before relying on it.

Sources read in full:
- National Health Act 2014 (NHA), Part III, ss.20–30. Official gazette copy: <https://faolex.fao.org/docs/pdf/nig162642.pdf>
- Nigeria Data Protection Act 2023 (NDPA), ss.25 and 30. <https://www.dataguidance.com/sites/default/files/data_protection_act_2023.pdf>
- NDPC General Application and Implementation Directive 2025 (GAID), Art. 24. <https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf>

## The model

1. **Each hospital governs its own records.** Its own clinicians read them in its own EMR (NHA s.25 obliges the hospital to keep them). Cevruni is not an EMR and is not involved in that.
2. **Cevruni only mediates access between facilities.** A clinician at hospital A may see records held at hospital B, and only when:
   - the patient has both A and B in their Cevruni network (linked to their Health ID);
   - and either the patient has approved it, or it is a break-glass emergency.

   Records are fetched live from B and never copied to A or to the ledger. On-chain policy rejects any grant where A and B are the same hospital.

## Patient-approved access

- **NHA s.26(1):** all information about a user is confidential.
- **NHA s.26(2)(a):** it may be disclosed with the user's written consent. The patient's approval is signed with a key only the patient holds, and verified on-chain before the grant becomes active.
- **NHA s.27:** a provider may disclose to another provider "as is necessary for any legitimate purpose… where such access or disclosure is in the interest of the user".
- **NHA s.28(1)(a):** a provider may examine a user's records for treatment "with the authorisation of the user".
- **NHA s.29(1):** the hospital in charge of records must have "control measures to prevent unauthorised access". Cevruni provides several:
  - a grant per clinician and role;
  - the record types and purpose the patient approved;
  - expiry;
  - a fresh on-chain check before every record release;
  - the hospital's own register of active clinicians;
  - an audit entry that cannot be altered.

## Emergency (break-glass) access

**Scenario:** a patient of JUTH is brought unresponsive to General Hospital Langtang. Their family gives the JUTH hospital number. A Langtang clinician uses it to see the patient's essential JUTH records.

**Legal basis:**

| Provision | What it says | How Cevruni applies it |
|---|---|---|
| NHA s.20(1) | No provider "shall… refuse a person emergency medical treatment for any reason" | The duty is to treat. If Cevruni refuses emergency access (e.g. the patient never added Langtang to their network), Langtang still treats, with the information it has. The refusal message says so. |
| NHA s.26(2)(d) | Disclosure "in the case of a person who is otherwise unable to grant consent upon the request of a guardian or representative" | The family member who gives the number is recorded: name, relationship and phone, all optional. Their details are kept encrypted off-chain; a salted SHA-256 hash is stored on the grant on-chain, so the record can later be proved unaltered. |
| NHA s.27 | Provider-to-provider disclosure in the user's interest | JUTH's system releases to Langtang only for this patient's emergency care. |
| NDPA s.30(1)(c) | Sensitive (health) data may be processed when "necessary to protect the vital interests of the data subject… where the data subject is physically or legally incapable of giving consent" | Break-glass requires a written justification. It is meant for a patient who cannot consent. |
| NDPA s.30(1)(g) | Processing "for purposes of medical care… by… a professional… owing a duty of confidentiality" | Only registered, active clinicians of the requesting hospital can invoke it. |
| GAID Art. 24(3) | Processing for vital interest "shall be necessary and proportionate" | **1 hour** by default. **Extensions** need a written reason each, at most 1 hour at a time, **24 hours in total**; after that the patient's own permission is needed. **Emergency record types only:** allergies, medications, diagnoses, encounters, lab results/observations. No documents or imaging reports. These limits are fixed in the chaincode, so no client can widen them. |
| GAID Art. 24(4) | The controller "shall give an account of its processing to the affected data subject, his or her representative… or a competent authority upon request" | The patient sees every emergency access prominently: who, which hospital, when, why, which family member asked, and every extension. The record-holding hospital and the requesting hospital both see it, and either can review it. The audit trail is immutable. |
| NHA s.29(2) | Unauthorised access, connecting systems or linking identity to clinical data is an offence | Hospitals join Cevruni through the System Admin onboarding, which is the authority for the connection. Every emergency access is attributed, justified, time-limited, logged on-chain and reviewed. |

**Precondition:** the patient must have **both** hospitals in their Cevruni network. This means the patient chose in advance to connect them (consent under NHA s.26(2)(a)). It also limits break-glass to hospitals the patient knows about.

## Corrections for the thesis

- **The emergency-treatment duty is NHA section 20, not section 21.** Section 21 concerns the rights of health care personnel. Correct this in Section 2.3.8 and Table 3.7.
- **Consent-based disclosure is s.26(2)(a); s.27 is something else.** Section 27 covers disclosure between health workers/providers for a legitimate purpose in the user's interest. Section 1.1 currently attributes consent-based disclosure to s.27. Chapter 1 is supervisor-approved, so raise this with the supervisor rather than editing it; Chapters 2–3 can state it precisely.
