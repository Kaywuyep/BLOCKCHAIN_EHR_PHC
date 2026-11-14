'use strict';

/**
 * emergencyPolicy.js — break-glass rules (Section 3.4.7), identical to the
 * constants in chaincode/accesscontrol.go.
 *
 * Legal basis (see docs/legal-basis-emergency-access.md):
 *   - National Health Act 2014 s.20 (no refusal of emergency treatment),
 *     s.26(2)(d) (disclosure at the request of a representative of a person
 *     unable to consent), s.27 (provider-to-provider disclosure in the
 *     user's interest), s.29 (control measures against unauthorised access);
 *   - NDPA 2023 s.30(1)(c) (vital interests, data subject incapable of
 *     consent) and s.30(1)(g) (medical care by a professional under a duty of
 *     confidentiality);
 *   - GAID 2025 Art. 24(3) (necessary and proportionate: limited window and
 *     record types) and 24(4) (an account to the data subject: the patient
 *     sees every emergency access, its reason and who asked for it).
 */
module.exports = {
  BREAK_GLASS_MINUTES: 60,
  BREAK_GLASS_MAX_MINUTES: 24 * 60,
  EMERGENCY_SCOPE: ['AllergyIntolerance', 'MedicationRequest', 'Condition', 'Encounter', 'Observation'],
};
