const BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
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
  getPatient: (did) => request(`/patients/${encodeURIComponent(did)}`),
  matchPatient: (params) => request(`/patients/match?${new URLSearchParams(params).toString()}`),
  linkPatient: (did, data) =>
    request(`/patients/${encodeURIComponent(did)}/link`, { method: 'POST', body: JSON.stringify(data) }),
  registerReference: (did, data) =>
    request(`/patients/${encodeURIComponent(did)}/references`, { method: 'POST', body: JSON.stringify(data) }),
  getReferences: (did) => request(`/patients/${encodeURIComponent(did)}/references`),

  registerProvider: (data) => request('/providers/register', { method: 'POST', body: JSON.stringify(data) }),
  getProvidersForHospital: (hospitalID) => request(`/providers/hospital/${encodeURIComponent(hospitalID)}`),

  requestAccess: (data) => request('/access/request', { method: 'POST', body: JSON.stringify(data) }),
  grantAccess: (grantID, durationMinutes) =>
    request(`/access/${grantID}/grant`, { method: 'POST', body: JSON.stringify({ durationMinutes }) }),
  revokeAccess: (grantID, data) =>
    request(`/access/${grantID}/revoke`, { method: 'POST', body: JSON.stringify(data) }),
  checkAccess: (grantID) => request(`/access/${grantID}`),
  getGrantsForPatient: (did) => request(`/access/patient/${encodeURIComponent(did)}`),
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

  getCostSummary: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/cost/summary${qs ? `?${qs}` : ''}`);
  },

  getSyncStatus: () => request('/sync/status'),
  setConnectivity: (connected) => request('/sync/connectivity', { method: 'POST', body: JSON.stringify({ connected }) }),
  getSyncQueue: () => request('/sync/queue'),
};
