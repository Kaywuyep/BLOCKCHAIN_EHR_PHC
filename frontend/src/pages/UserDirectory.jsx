import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useSession } from '../auth';
import './admin.css';

/**
 * UserDirectory — System Admin: every user and their roles.
 *
 * Users appear when they first sign in, when a clinician is registered, when
 * a patient registers, or when an admin adds them here. Passwords stay with
 * the identity provider; this page manages roles, hospital and access.
 */

const ROLE_INFO = {
  patient: { label: 'Patient', cls: 'role-patient' },
  clinician: { label: 'Clinician', cls: 'role-clinician' },
  hospital_admin: { label: 'Hospital Admin', cls: 'role-hadmin' },
  system_admin: { label: 'System Admin', cls: 'role-sadmin' },
  hl7_interface: { label: 'HL7 Interface', cls: 'role-hl7' },
};
const STAFF = ['clinician', 'hospital_admin', 'hl7_interface'];
const SOURCE_LABEL = {
  seen: 'Signed in',
  created: 'Added by admin',
  'provider-registry': 'Clinician registry',
  'patient-registration': 'Patient registration',
};

const EMPTY = { subject: '', displayName: '', role: 'clinician', hospitalID: '', providerID: '' };

export function UserDirectory() {
  const { session } = useSession();
  const [users, setUsers] = useState([]);
  const [hospitals, setHospitals] = useState([]);
  const [error, setError] = useState(null);
  const [roleFilter, setRoleFilter] = useState('all');
  const [hospitalFilter, setHospitalFilter] = useState('all');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const [u, h] = await Promise.all([api.adminListUsers(), api.adminListHospitals()]);
      setUsers(u);
      setHospitals(h);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => {
    const c = { all: users.length };
    for (const u of users) for (const r of u.roles) c[r] = (c[r] || 0) + 1;
    return c;
  }, [users]);

  const shown = users.filter((u) => {
    if (roleFilter !== 'all' && !u.roles.includes(roleFilter)) return false;
    if (hospitalFilter !== 'all' && (u.hospitalID || '') !== hospitalFilter) return false;
    if (q) {
      const needle = q.toLowerCase();
      return [u.subject, u.displayName, u.hospitalName, u.patientDID, u.department].some((v) => v && v.toLowerCase().includes(needle));
    }
    return true;
  });

  async function addUser() {
    setSaving(true);
    setError(null);
    try {
      await api.adminCreateUser({
        subject: form.subject,
        displayName: form.displayName,
        roles: [form.role],
        hospitalID: STAFF.includes(form.role) ? form.hospitalID : undefined,
        providerID: form.role === 'clinician' ? form.providerID || undefined : undefined,
      });
      setForm(EMPTY);
      setAdding(false);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(u) {
    try {
      await api.adminSetUserStatus(u.subject, u.status === 'disabled' ? 'active' : 'disabled');
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  const needsHospital = STAFF.includes(form.role);

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">System admin</span>
            <h2>Users</h2>
          </div>
          <button className="btn btn-primary" onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : '+ Add user'}</button>
        </div>

        {adding && (
          <div className="config-block">
            <div className="form-grid three">
              <div className="field">
                <label>User ID</label>
                <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value.trim() })} placeholder="their sign-in name" />
              </div>
              <div className="field">
                <label>Full name</label>
                <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
              </div>
              <div className="field">
                <label>Role</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {Object.entries(ROLE_INFO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              {needsHospital && (
                <div className="field">
                  <label>Hospital</label>
                  <select value={form.hospitalID} onChange={(e) => setForm({ ...form, hospitalID: e.target.value })}>
                    <option value="">Select…</option>
                    {hospitals.filter((h) => h.status === 'active').map((h) => <option key={h.hospitalID} value={h.hospitalID}>{h.name}</option>)}
                  </select>
                </div>
              )}
              {form.role === 'clinician' && (
                <div className="field">
                  <label>Provider ID <span className="optional">optional</span></label>
                  <input value={form.providerID} placeholder={form.subject || 'same as user ID'} onChange={(e) => setForm({ ...form, providerID: e.target.value.trim() })} />
                </div>
              )}
            </div>
            <div className="wizard-foot">
              <span className="hint">
                {form.role === 'patient'
                  ? 'Patients normally register themselves in the Patient Portal.'
                  : 'The user signs in through the identity provider; their role and hospital are fixed here.'}
              </span>
              <span className="spacer" />
              <button className="btn btn-primary" onClick={addUser} disabled={saving || !form.subject || (needsHospital && !form.hospitalID)}>
                {saving ? 'Adding…' : 'Add user'}
              </button>
            </div>
          </div>
        )}

        <div className="filter-bar">
          <div className="role-tabs">
            {['all', ...Object.keys(ROLE_INFO)].map((r) => (
              <button key={r} className={roleFilter === r ? 'active' : ''} onClick={() => setRoleFilter(r)}>
                {r === 'all' ? 'All' : ROLE_INFO[r].label} <span className="count">{counts[r] || 0}</span>
              </button>
            ))}
          </div>
          <select value={hospitalFilter} onChange={(e) => setHospitalFilter(e.target.value)}>
            <option value="all">All hospitals</option>
            <option value="">No hospital</option>
            {hospitals.map((h) => <option key={h.hospitalID} value={h.hospitalID}>{h.name}</option>)}
          </select>
          <input className="search" placeholder="Search name, ID, DID…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Roles</th>
                <th>Hospital</th>
                <th>Source</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.subject} className={u.status === 'disabled' ? 'row-muted' : ''}>
                  <td>
                    <div className="cell-title">{u.displayName || u.subject}</div>
                    <div className="cell-sub">
                      {u.displayName && u.subject}
                      {u.patientDID && <span className="mono"> {u.patientDID.length > 28 ? `${u.patientDID.slice(0, 28)}…` : u.patientDID}</span>}
                      {u.department && ` · ${u.department}`}
                    </div>
                  </td>
                  <td>
                    {u.roles.map((r) => <span key={r} className={`pill ${ROLE_INFO[r]?.cls || ''}`}>{ROLE_INFO[r]?.label || r}</span>)}
                    {u.status === 'disabled' && <span className="pill pill-bad">Disabled</span>}
                  </td>
                  <td>{u.hospitalName || u.hospitalID || <span className="cell-sub">—</span>}</td>
                  <td className="cell-sub">{SOURCE_LABEL[u.source] || u.source}</td>
                  <td className="cell-sub">{u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString() : 'never'}</td>
                  <td className="cell-actions">
                    {u.subject !== session?.sub && (
                      <button className={`btn ${u.status === 'disabled' ? 'btn-ghost' : 'btn-danger'}`} onClick={() => toggle(u)}>
                        {u.status === 'disabled' ? 'Enable' : 'Disable'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={6} className="hint">No users match.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
