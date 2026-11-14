'use strict';

// MLLP is request/response based rather than a permanently connected
// session, so track listener readiness and the last ADT message observed.
const hospitals = new Map();

function configureHospital({ hospitalID, mode, mllpPort, hl7Version }) {
  const previous = hospitals.get(hospitalID);
  hospitals.set(hospitalID, {
    ...(previous || {}),
    hospitalID,
    mode: mode || 'manual',
    mllpPort: mllpPort || null,
    hl7Version: hl7Version || null,
    status: 'starting',
    // Reconfiguring a hospital keeps its message counters.
    messagesReceived: previous ? previous.messagesReceived : 0,
    messagesAccepted: previous ? previous.messagesAccepted : 0,
    messagesRejected: previous ? previous.messagesRejected : 0,
    lastMessageAt: previous ? previous.lastMessageAt : null,
    lastMessageStatus: previous ? previous.lastMessageStatus : null,
    error: null,
  });
}

function restoreCounters(hospitalID, counters) {
  const item = hospitals.get(hospitalID);
  if (item) Object.assign(item, counters);
}

function removeHospital(hospitalID) {
  hospitals.delete(hospitalID);
}

function getHospitalStatus(hospitalID) {
  const item = hospitals.get(hospitalID);
  return item ? { ...item } : null;
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
  if (item.status === 'starting' || item.status === 'disabled') item.status = item.mllpPort ? item.status : 'receiving';
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
  getHospitalStatus,
  removeHospital,
  restoreCounters,
};
