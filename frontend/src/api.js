// In development Vite proxies /api to the live backend on port 6000.
// VITE_API_BASE remains available when the frontend is deployed separately.
import { getToken } from './auth';

const BASE = import.meta.env.VITE_API_BASE || '/api';

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401 && token) {
    // Expired or revoked session: back to the sign-in screen.
    window.dispatchEvent(new Event('patientchain:unauthorized'));
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const message = (body && body.error) || `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return body;
}

export const api = {
  health: () => request('/health'),

  registerPatient: (data) => request('/patients/register', { method: 'POST', body: JSON.stringify(data) }),
  registerLookup: (data) => request('/patients/register/lookup', { method: 'POST', body: JSON.stringify(data) }),
  getMyFacilities: (did) => request(`/patients/${encodeURIComponent(did)}/facilities`),
  getPatient: (did) => request(`/patients/${encodeURIComponent(did)}`),
  linkFacility: (did, data) =>
    request(`/patients/${encodeURIComponent(did)}/link-facility`, { method: 'POST', body: JSON.stringify(data) }),
  confirmLink: (did, data) =>
    request(`/patients/${encodeURIComponent(did)}/confirm-link`, { method: 'POST', body: JSON.stringify(data) }),
  registerReference: (did, data) =>
    request(`/patients/${encodeURIComponent(did)}/references`, { method: 'POST', body: JSON.stringify(data) }),
  getReferences: (did) => request(`/patients/${encodeURIComponent(did)}/references`),
  lookupPatientByHospitalNumber: (hospitalID, hospitalNumber) =>
    request(`/patients/lookup-by-hospital-number/${encodeURIComponent(hospitalID)}/${encodeURIComponent(hospitalNumber)}`),

  addLocalPatientRecord: (hospitalID, data) =>
    request(`/patients/local-records/${encodeURIComponent(hospitalID)}`, { method: 'POST', body: JSON.stringify(data) }),
  getLocalPatientRecords: (hospitalID) => request(`/patients/local-records/${encodeURIComponent(hospitalID)}`),
  getHospitalStatuses: () => request('/hospitals/status'),
  searchHospitals: (q) => request(`/hospitals/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`),

  registerProvider: (data) => request('/providers/register', { method: 'POST', body: JSON.stringify(data) }),
  getMyProviderProfile: () => request('/providers/me'),
  getProvidersForHospital: (hospitalID) => request(`/providers/hospital/${encodeURIComponent(hospitalID)}`),

  requestAccess: (data) => request('/access/request', { method: 'POST', body: JSON.stringify(data) }),
  patientGrantHospital: (data) => request('/access/patient-grant', { method: 'POST', body: JSON.stringify(data) }),
  grantAccess: (grantID, durationMinutes, signature) =>
    request(`/access/${grantID}/grant`, { method: 'POST', body: JSON.stringify({ durationMinutes, signature }) }),
  batchGrant: (items) => request('/access/batch-grant', { method: 'POST', body: JSON.stringify({ items }) }),
  approveCrossHospital: (grantID, body) =>
    request(`/access/${grantID}/approve-cross-hospital`, { method: 'POST', body: JSON.stringify(body) }),
  revokeAccess: (grantID, data) =>
    request(`/access/${grantID}/revoke`, { method: 'POST', body: JSON.stringify(data) }),
  checkAccess: (grantID) => request(`/access/${grantID}`),
  getGrantsForPatient: (did) => request(`/access/patient/${encodeURIComponent(did)}`),
  getMyProviderGrants: () => request('/access/provider/me'),
  extendBreakGlass: (grantID, data) => request(`/access/${grantID}/extend`, { method: 'POST', body: JSON.stringify(data) }),
  getEmergencyDetails: (grantID) => request(`/access/${grantID}/emergency-details`),
  getMyGrantsForPatient: (did) => request(`/access/my-grants/${encodeURIComponent(did)}`),
  requestBreakGlass: (data) => request('/access/break-glass', { method: 'POST', body: JSON.stringify(data) }),
  reviewBreakGlass: (grantID, data) =>
    request(`/access/${grantID}/review`, { method: 'POST', body: JSON.stringify(data) }),
  getPendingBreakGlass: () => request('/access/break-glass/pending'),

  resolveRecord: (grantID, hospitalID, params = {}) => {
    const all = { grantID, hospitalID, ...params };
    const clean = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const qs = new URLSearchParams(clean).toString();
    return request(`/records/resolve?${qs}`);
  },

  getAuditTrail: (did) => request(`/audit/patient/${encodeURIComponent(did)}`),
  getRecentEvents: () => request('/audit/events/recent'),
  logScreenCapture: (data) => request('/audit/screen-capture', { method: 'POST', body: JSON.stringify(data) }),
  getScreenCaptures: () => request('/audit/screen-captures'),

  // Hospital admin view (own hospital; system admins pass hospitalID)
  hospitalAdmin: (path, hospitalID, params = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries({ ...params, hospitalID }).filter(([, v]) => v))).toString();
    return request(`/hospital-admin/${path}${qs ? `?${qs}` : ''}`);
  },
  hospitalAdminRegisterClinician: (data) => request('/hospital-admin/clinicians', { method: 'POST', body: JSON.stringify(data) }),

  // System admin: hospitals and users
  adminHospitalOptions: (name) => request(`/admin/hospitals/options${name ? `?name=${encodeURIComponent(name)}` : ''}`),
  adminListHospitals: () => request('/admin/hospitals'),
  adminCreateHospital: (data) => request('/admin/hospitals', { method: 'POST', body: JSON.stringify(data) }),
  adminUpdateHospital: (id, data) => request(`/admin/hospitals/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  adminSetHospitalStatus: (id, status) =>
    request(`/admin/hospitals/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  adminTestFhir: (data) => request('/admin/hospitals/test-fhir', { method: 'POST', body: JSON.stringify(data) }),
  adminTestHl7: (data) => request('/admin/hospitals/test-hl7', { method: 'POST', body: JSON.stringify(data) }),
  adminListUsers: () => request('/admin/users'),
  adminCreateUser: (data) => request('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
  adminUpdateUser: (subject, data) => request(`/admin/users/${encodeURIComponent(subject)}`, { method: 'PUT', body: JSON.stringify(data) }),
  adminSetUserStatus: (subject, status) =>
    request(`/admin/users/${encodeURIComponent(subject)}/status`, { method: 'POST', body: JSON.stringify({ status }) }),

  getCostSummary: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/cost/summary${qs ? `?${qs}` : ''}`);
  },

  getSyncStatus: () => request('/sync/status'),
  setConnectivity: (connected) => request('/sync/connectivity', { method: 'POST', body: JSON.stringify({ connected }) }),
  getSyncQueue: () => request('/sync/queue'),
};
