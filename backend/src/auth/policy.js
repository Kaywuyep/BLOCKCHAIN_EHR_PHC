'use strict';

const { ROLES } = require('./auth');

/**
 * policy.js
 *
 * Authorization rules shared by the routes. Three layers:
 *   1. role:     what kind of user may call an endpoint at all;
 *   2. hospital: staff act only for the hospital in their token;
 *   3. subject:  patients act only on their own DID and grants, and
 *                clinicians only as the provider named in their token.
 * A superuser (AUTH_MODE=off) passes every check. system_admin passes the
 * hospital check but is still bound by the patient and provider checks.
 */

function hasRole(user, ...roles) {
  return Boolean(user && (user.superuser || roles.some((r) => user.roles.includes(r))));
}

function isSystemAdmin(user) {
  return hasRole(user, ROLES.SYSTEM_ADMIN);
}

/** Staff of `hospitalID` (or a system admin) holding one of `roles`. */
function actsForHospital(user, hospitalID, ...roles) {
  if (!user) return false;
  if (user.superuser || isSystemAdmin(user)) return true;
  return hasRole(user, ...roles) && Boolean(user.hospitalID) && user.hospitalID === hospitalID;
}

/** The patient who owns `patientDID`. */
function isPatientSelf(user, patientDID) {
  if (!user) return false;
  if (user.superuser) return true;
  return user.roles.includes(ROLES.PATIENT) && Boolean(user.patientDID) && user.patientDID === patientDID;
}

/** The clinician named `providerID`, working at `hospitalID`. */
function isProvider(user, providerID, hospitalID) {
  if (!user) return false;
  if (user.superuser) return true;
  return (
    user.roles.includes(ROLES.CLINICIAN) &&
    user.providerID === providerID &&
    Boolean(user.hospitalID) &&
    user.hospitalID === hospitalID
  );
}

function deny(res, message = 'not permitted') {
  return res.status(403).json({ error: message });
}

/** Middleware: the caller must hold at least one of `roles`. */
function requireRole(...roles) {
  return (req, res, next) => (hasRole(req.user, ...roles) ? next() : deny(res, `requires role: ${roles.join(' or ')}`));
}

/** The actor ID written to the audit trail: the authenticated identity
 *  when there is one, otherwise (AUTH_MODE=off) whatever the caller sent. */
function actorID(user, fallback) {
  if (!user || user.superuser) return fallback;
  return user.providerID || user.patientDID || user.sub;
}

module.exports = { ROLES, hasRole, isSystemAdmin, actsForHospital, isPatientSelf, isProvider, deny, requireRole, actorID };
