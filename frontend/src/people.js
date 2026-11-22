/**
 * people.js — names, not IDs, on screen (user decision, 2026-11-18: the
 * doctor's name everywhere, for audit; the ID stays behind the scenes).
 * The server adds providerName / actorName / reviewedByName next to IDs
 * (backend services/nameResolver.js).
 */

/** The clinician on a grant or event. */
export function clinicianName(x) {
  if (!x) return 'A clinician';
  if (x.providerID && x.providerID.startsWith('hospital-staff@')) return x.providerName || `All clinicians at ${x.viewedFromName || 'the hospital'}`;
  return x.providerName || 'A clinician';
}

/** Whoever did something in an audit entry. `selfDID` = the viewing patient's DID ("You"). */
export function actorName(x, { selfDID } = {}) {
  if (!x) return 'Unknown';
  if (x.actorName) return x.actorName;
  const id = String(x.actorID || '');
  if (selfDID && id === selfDID) return 'You';
  if (id.startsWith('did:') || id.startsWith('pt-')) return 'Patient';
  return 'Staff member';
}
