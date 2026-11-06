'use strict';

// MLLP is request/response based rather than a permanently connected
// session, so track listener readiness and the last ADT message observed.
const hospitals = new Map();

function configureHospital({ hospitalID, mode, mllpPort, hl7Version }) {
  hospitals.set(hospitalID, {
    hospitalID,
    mode: mode || 'manual',
    mllpPort: mllpPort || null,
    hl7Version: hl7Version || null,
    status: 'starting',
    messagesReceived: 0,
    messagesAccepted: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastMessageStatus: null,
    error: null,
  });
}

function markDisabled(hospitalID, reason = 'listener disabled') {
  const item = hospitals.get(hospitalID);
  if (!item) return;
  item.status = 'disabled';
  item.error = reason;
}

function markListening(hospitalID) {
  const item = hospitals.get(hospitalID);
  if (!item) return;
  item.status = 'listening';
  item.error = null;
}

function markError(hospitalID, error) {
  const item = hospitals.get(hospitalID);
  if (!item) return;
  item.status = 'error';
  item.error = error?.message || String(error);
}

function recordMessage(hospitalID, result) {
  const item = hospitals.get(hospitalID);
  if (!item) return;
  item.messagesReceived += 1;
  if (result.ok) item.messagesAccepted += 1;
  else item.messagesRejected += 1;
  item.lastMessageAt = new Date().toISOString();
  item.lastMessageStatus = result.ok ? 'accepted' : 'rejected';
}

function getHospitalStatuses() {
  return Array.from(hospitals.values()).map((item) => ({ ...item }));
}

module.exports = {
  configureHospital,
  markDisabled,
  markListening,
  markError,
  recordMessage,
  getHospitalStatuses,
};
