import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api';
import './admin.css';
import './insights.css';

/**
 * Insights — System Admin.
 *
 *   Access activity:  how the system is used, from the ledger's grants and
 *                     audit entries (counts only, no patient identifiers).
 *   Diagnosis trends: anonymous monthly counts of the ICD-10 diagnoses
 *                     clinicians ticked after opening records, small counts
 *                     shown as "<5", and the review queue for new terms.
 */

const DAY = 24 * 3600 * 1000;
const isoDay = (d) => d.toISOString().slice(0, 10);
const isoMonth = (d) => d.toISOString().slice(0, 7);
const monthsBack = (n) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return isoMonth(d);
};
const monthLabel = (p) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-NG', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const cellText = (c) => (c?.suppressed ? '<5' : c?.value ?? '–');

export function Insights() {
  const [tab, setTab] = useState('access');
  const [hospitals, setHospitals] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    api.adminListHospitals().then(setHospitals).catch(() => {});
    api.insightsPendingTerms().then((t) => setPendingCount(t.length)).catch(() => {});
  }, [tab]);
  const nameOf = (id) => hospitals.find((h) => h.hospitalID === id)?.name || id;

  return (
    <div className="insights">
      <div className="dash-welcome">
        <h2>Insights</h2>
        <p>How Cevruni is used across hospitals, and which diagnoses clinicians are treating when they open records from another hospital. Every figure is a count; no patient is identified.</p>
      </div>
      <div className="role-tabs ins-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'access'} className={tab === 'access' ? 'active' : ''} onClick={() => setTab('access')}>Access activity</button>
        <button role="tab" aria-selected={tab === 'diagnoses'} className={tab === 'diagnoses' ? 'active' : ''} onClick={() => setTab('diagnoses')}>
          Diagnosis trends{pendingCount > 0 && <span className="ins-badge" title="New terms awaiting review">{pendingCount}</span>}
        </button>
      </div>
      {tab === 'access' ? <AccessActivity nameOf={nameOf} /> : <DiagnosisTrends nameOf={nameOf} hospitals={hospitals} onReviewed={setPendingCount} />}
    </div>
  );
}

// ───────────────────────────── Access activity ─────────────────────────────

function AccessActivity({ nameOf }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * DAY);
    setData(null);
    api.insightsAccess({ from: isoDay(from), to: isoDay(to) }).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [days]);

  return (
    <>
      <div className="filter-bar">
        <span className="hint">Period</span>
        <div className="role-tabs">
          {[7, 30, 90, 365].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>{d === 365 ? '12 months' : `${d} days`}</button>
          ))}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <p className="hint">Reading the ledger…</p>}
      {data && (
        <>
          <div className="ins-tiles">
            <Tile label="Records opened" value={data.totals.recordViews} sub="cross-hospital record views" />
            <Tile label="Clinicians" value={data.totals.activeClinicians} sub="opened at least one record" />
            <Tile label="Access requests" value={data.totals.requests} sub={data.totals.approvalRate == null ? 'none in this period' : `${data.totals.approvalRate}% approved by patients`} />
            <Tile label="Time to approve" value={data.totals.medianMinutesToApprove == null ? '–' : fmtMinutes(data.totals.medianMinutesToApprove)} sub="median, request to approval" />
            <Tile label="Emergency accesses" value={data.totals.emergencies} sub={`${data.totals.emergenciesReviewed} reviewed`} tone={data.totals.emergencies > data.totals.emergenciesReviewed ? 'warn' : undefined} />
            <Tile label="Revocations" value={data.totals.revocations} sub={`${data.totals.screenshotAttempts} screenshot attempt${data.totals.screenshotAttempts === 1 ? '' : 's'}`} />
          </div>

          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Records opened per day</span><h3>{data.totals.recordViews} in the last {days === 365 ? '12 months' : `${days} days`}</h3></div></div>
            <div className="ins-chart" role="img" aria-label="Line chart of cross-hospital record views per day">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.viewsPerDay} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="var(--line)" strokeDasharray="0" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(d) => new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })} tick={{ fontSize: 11, fill: 'var(--ink-soft)' }} tickLine={false} axisLine={{ stroke: 'var(--line)' }} minTickGap={24} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--ink-soft)' }} tickLine={false} axisLine={false} />
                  <Tooltip
                    cursor={{ stroke: 'var(--ink-soft)', strokeWidth: 1 }}
                    formatter={(v) => [v, 'Records opened']}
                    labelFormatter={(d) => new Date(d).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                  />
                  <Line type="monotone" dataKey="count" stroke="var(--brand-blue)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="ins-grid">
            <BarList title="Between hospitals" sub="requests: requesting hospital → hospital holding the records" empty="No cross-hospital requests"
              rows={data.hospitalPairs.map((p) => ({ key: `${p.requesterHospitalID}-${p.recordsHospitalID}`, label: `${nameOf(p.requesterHospitalID)} → ${nameOf(p.recordsHospitalID)}`, count: p.count }))} />
            <BarList title="Records opened, by hospital" sub="hospital whose records were opened" empty="No records opened"
              rows={data.viewsByRecordsHospital.map((r) => ({ key: r.hospitalID, label: nameOf(r.hospitalID), count: r.count }))} />
            <BarList title="Purpose of access" sub="as declared on each request" empty="No requests"
              rows={data.byPurpose.map((r) => ({ key: r.purpose, label: r.purpose, count: r.count }))} />
            <BarList title="Requesting role" sub="clinician role on the request" empty="No requests"
              rows={data.byRole.map((r) => ({ key: r.role, label: r.role, count: r.count }))} />
            <BarList title="Record types requested" sub="a request can ask for several" empty="No requests"
              rows={data.byRecordType.map((r) => ({ key: r.recordType, label: RECORD_TYPE_LABEL[r.recordType] || r.recordType, count: r.count }))} />
            <BarList title="Request outcomes" sub="standard requests made in this period" empty="No requests"
              rows={data.requestsByStatus.map((r) => ({ key: r.status, label: STATUS_LABEL[r.status] || r.status, count: r.count }))} />
          </div>
        </>
      )}
    </>
  );
}

const RECORD_TYPE_LABEL = {
  Encounter: 'Visits', Observation: 'Results & vitals', DiagnosticReport: 'Lab & imaging reports', Condition: 'Diagnoses',
  MedicationRequest: 'Medications', DocumentReference: 'Documents', AllergyIntolerance: 'Allergies',
};
const STATUS_LABEL = { ACTIVE: 'Approved, in force', EXPIRED: 'Approved, now expired', REVOKED: 'Revoked by patient', PENDING: 'Awaiting patient' };

function fmtMinutes(m) {
  if (m < 1) return '<1 min';
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 48 * 60) return `${Math.round(m / 6) / 10} h`;
  return `${Math.round(m / 144) / 10} days`;
}

// ───────────────────────────── Diagnosis trends ─────────────────────────────

function DiagnosisTrends({ nameOf, hospitals, onReviewed }) {
  const [months, setMonths] = useState(3);
  const [hospitalID, setHospitalID] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState('');

  async function load() {
    try {
      const d = await api.insightsDiagnoses({ from: monthsBack(months - 1), to: monthsBack(0), hospitalID });
      setData(d);
      setError(null);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { setData(null); load(); }, [months, hospitalID]);

  const rows = useMemo(() => (data?.diagnoses || []).filter((d) => !q || `${d.code} ${d.display}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  const chartRows = (data?.diagnoses || []).filter((d) => !d.views.suppressed).slice(0, 10);

  return (
    <>
      <div className="filter-bar">
        <span className="hint">Period</span>
        <div className="role-tabs">
          {[[1, 'This month'], [3, '3 months'], [6, '6 months'], [12, '12 months']].map(([m, l]) => (
            <button key={m} className={months === m ? 'active' : ''} onClick={() => setMonths(m)}>{l}</button>
          ))}
        </div>
        <select value={hospitalID} onChange={(e) => setHospitalID(e.target.value)} aria-label="Treating hospital">
          <option value="">All treating hospitals</option>
          {hospitals.map((h) => <option key={h.hospitalID} value={h.hospitalID}>{h.name}</option>)}
        </select>
        <input className="search" placeholder="Search diagnosis or ICD-10 code…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <p className="hint">Loading…</p>}
      {data && (
        <>
          <div className="ins-tiles">
            <Tile label="Episodes counted" value={data.totals.taggedViews} sub={`${monthLabel(data.from)}${data.from !== data.to ? ` – ${monthLabel(data.to)}` : ''}`} />
            <Tile label="Distinct diagnoses" value={data.totals.diagnoses} sub="ICD-10 codes and local terms" />
            <Tile label="Clinicians" value={data.totals.clinicians} sub="who ticked a diagnosis" />
          </div>

          <div className="notice-banner ins-privacy">
            An episode is counted when a clinician ticks a diagnosis after opening records from another hospital; the same diagnosis for the same patient counts once per interval (set below). Counts are never linked to a patient, and any count below {data.smallCellThreshold} is shown as “&lt;{data.smallCellThreshold}”. They describe cross-hospital care, not every case a hospital treats.
          </div>

          {chartRows.length > 0 && (
            <div className="panel">
              <div className="panel-head"><div><span className="eyebrow">Most common diagnoses</span><h3>Episodes by diagnosis</h3></div></div>
              <HBars rows={chartRows.map((d) => ({ key: d.code, label: d.display, code: d.code, count: d.views.value }))} />
            </div>
          )}

          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">All diagnoses</span><h3>{rows.length} diagnos{rows.length === 1 ? 'is' : 'es'}</h3></div></div>
            {rows.length === 0 ? <p className="hint">No diagnoses ticked in this period.</p> : (
              <div className="table-wrap">
                <table className="admin-table">
                  <thead><tr><th>Diagnosis</th><th>Code</th><th className="num">Episodes</th><th className="num">Clinicians</th><th className="num">Hospitals</th><th>By month</th><th /></tr></thead>
                  <tbody>
                    {rows.map((d) => (
                      <DiagnosisRow key={d.code} d={d} isOpen={open === d.code} onToggle={() => setOpen(open === d.code ? null : d.code)} nameOf={nameOf} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <ReviewQueue onChange={(n) => { onReviewed(n); load(); }} />
          <IntervalSettings />
        </>
      )}
    </>
  );
}

function DiagnosisRow({ d, isOpen, onToggle, nameOf }) {
  const peak = Math.max(1, ...d.byMonth.map((m) => m.views.value || 0));
  return (
    <>
      <tr>
        <td><div className="cell-title">{d.display}</div>{d.status === 'pending' && <div className="cell-sub warn">Local term, awaiting ICD-10 mapping</div>}</td>
        <td><span className={`pill ${d.system === 'ICD-10' ? 'pill-info' : 'pill-muted'} mono`}>{d.code}</span></td>
        <td className="num">{cellText(d.views)}</td>
        <td className="num">{cellText(d.clinicians)}</td>
        <td className="num">{d.hospitals}</td>
        <td>
          <div className="ins-spark" aria-label={`Episodes by month: ${d.byMonth.map((m) => `${monthLabel(m.period)} ${cellText(m.views)}`).join(', ')}`}>
            {d.byMonth.map((m) => (
              <span key={m.period} title={`${monthLabel(m.period)}: ${cellText(m.views)}`} className={m.views.suppressed ? 'sup' : ''} style={{ height: `${m.views.suppressed ? 3 : Math.max(3, (m.views.value / peak) * 22)}px` }} />
            ))}
          </div>
        </td>
        <td className="cell-actions"><button className="link-btn" onClick={onToggle} aria-expanded={isOpen}>{isOpen ? 'Hide' : 'Details'}</button></td>
      </tr>
      {isOpen && (
        <tr className="ins-detail">
          <td colSpan={7}>
            <div className="ins-detail-grid">
              <div>
                <div className="section-label">By clinician role</div>
                {d.byRole.map((r) => <div key={r.role} className="ins-kv"><span>{r.role}</span><strong>{cellText(r.views)}</strong></div>)}
              </div>
              <div>
                <div className="section-label">By treating hospital</div>
                {d.byHospital.map((r) => <div key={r.hospitalID} className="ins-kv"><span>{nameOf(r.hospitalID)}</span><strong>{cellText(r.views)}</strong></div>)}
              </div>
              <div>
                <div className="section-label">By month</div>
                {d.byMonth.map((r) => <div key={r.period} className="ins-kv"><span>{monthLabel(r.period)}</span><strong>{cellText(r.views)}</strong></div>)}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ReviewQueue({ onChange }) {
  const [terms, setTerms] = useState([]);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({}); // code -> { targetCode, newDisplay }
  const [busy, setBusy] = useState(null);

  async function load() {
    try {
      const t = await api.insightsPendingTerms();
      setTerms(t);
      setError(null);
      return t.length;
    } catch (e) { setError(e.message); return 0; }
  }
  useEffect(() => { load(); }, []);

  async function act(code, fn) {
    setBusy(code);
    setError(null);
    try {
      await fn();
      const n = await load();
      onChange(n);
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  const map = (code, targetCode, newDisplay) => act(code, () => api.insightsMapTerm(code, { targetCode, newDisplay }));
  const reject = (code) => act(code, () => api.insightsRejectTerm(code));

  return (
    <div className="panel">
      <div className="panel-head">
        <div><span className="eyebrow">For health records officers</span><h3>New terms to map to ICD-10 {terms.length > 0 && <span className="pill pill-bad">{terms.length}</span>}</h3></div>
      </div>
      <p className="hint">Clinicians added these because they were not in the catalogue. Map each one to its ICD-10 code. Its counts then join that code, and the next clinician who types the same words gets the ICD-10 code directly. Reject anything that is not a diagnosis.</p>
      {error && <div className="error-banner">{error}</div>}
      {terms.length === 0 ? <p className="hint">Nothing waiting.</p> : (
        <div className="ins-queue">
          {terms.map((t) => {
            const f = form[t.code] || { targetCode: '', newDisplay: '' };
            const set = (patch) => setForm((x) => ({ ...x, [t.code]: { ...f, ...patch } }));
            return (
              <div key={t.code} className="ins-term">
                <div className="ins-term-head">
                  <div>
                    <div className="cell-title">“{t.display}”</div>
                    <div className="cell-sub"><span className="mono">{t.code}</span> · added by {t.createdBy || 'a clinician'} · {new Date(t.createdAt).toLocaleDateString('en-NG')} · ticked {t.views}×</div>
                  </div>
                  <button className="btn btn-ghost" disabled={busy === t.code} onClick={() => reject(t.code)}>Reject</button>
                </div>
                {t.suggestions.length > 0 && (
                  <div className="ins-suggest">
                    <span className="hint">Possible match:</span>
                    {t.suggestions.map((s) => (
                      <button key={s.code} className="btn btn-ghost" disabled={busy === t.code} onClick={() => map(t.code, s.code)}>
                        Map to <span className="mono">{s.code}</span> {s.display}
                      </button>
                    ))}
                  </div>
                )}
                <div className="ins-map-form">
                  <input className="mono" placeholder="e.g. K63.1" value={f.targetCode} onChange={(e) => set({ targetCode: e.target.value.toUpperCase() })} aria-label="ICD-10 code" />
                  <input placeholder="ICD-10 name (only if the code is new to the catalogue)" value={f.newDisplay} onChange={(e) => set({ newDisplay: e.target.value })} aria-label="ICD-10 name" />
                  <button className="btn btn-primary" disabled={busy === t.code || !f.targetCode.trim()} onClick={() => map(t.code, f.targetCode.trim(), f.newDisplay.trim() || undefined)}>Map</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function IntervalSettings() {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [def, setDef] = useState('');
  const [edits, setEdits] = useState({});
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [showAll, setShowAll] = useState(false);

  async function load(query = q) {
    try {
      const d = await api.insightsIntervals(query);
      setData(d);
      setDef(String(d.defaultIntervalDays));
      setError(null);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { const t = setTimeout(() => load(q), 200); return () => clearTimeout(t); }, [q]);

  async function saveDefault() {
    setError(null);
    try { await api.insightsSetDefaultInterval(Number(def)); setSaved('Default saved'); await load(); } catch (e) { setError(e.message); }
  }
  async function saveCode(code, days) {
    setError(null);
    try {
      await api.insightsSetInterval(code, days);
      setEdits((x) => ({ ...x, [code]: undefined }));
      setSaved(`${code} saved`);
      await load();
    } catch (e) { setError(e.message); }
  }

  const custom = (data?.terms || []).filter((t) => t.intervalDays);
  const shown = q || showAll ? data?.terms || [] : custom;

  return (
    <div className="panel">
      <div className="panel-head">
        <div><span className="eyebrow">System admin</span><h3>Episode intervals</h3></div>
      </div>
      <p className="hint">How long after a diagnosis is noted for a patient the same diagnosis for that patient counts as the same episode, whichever clinician or hospital notes it. Chronic conditions start at 30 days so they are counted once a month, not at every visit.</p>
      {error && <div className="error-banner">{error}</div>}
      <div className="ins-interval-default">
        <label htmlFor="ins-default-days">Default for all other diagnoses</label>
        <input id="ins-default-days" type="number" min="1" max="365" value={def} onChange={(e) => setDef(e.target.value)} />
        <span className="hint">days</span>
        <button className="btn btn-primary" disabled={!data || Number(def) === data.defaultIntervalDays} onClick={saveDefault}>Save</button>
        {saved && <span className="dx-done">✓ {saved}</span>}
      </div>
      <div className="filter-bar">
        <input className="search" placeholder="Find a diagnosis to set its interval…" value={q} onChange={(e) => setQ(e.target.value)} />
        {!q && <button className="link-btn" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show only custom intervals' : `Show all ${data?.terms.length || ''} diagnoses`}</button>}
      </div>
      {data && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead><tr><th>Diagnosis</th><th>Code</th><th>Interval</th><th /></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={4} className="hint">{q ? 'No match.' : 'No custom intervals yet; every diagnosis uses the default.'}</td></tr>}
              {shown.map((t) => {
                const v = edits[t.code] ?? (t.intervalDays ? String(t.intervalDays) : '');
                return (
                  <tr key={t.code}>
                    <td className="cell-title">{t.display}</td>
                    <td><span className={`pill ${t.system === 'ICD-10' ? 'pill-info' : 'pill-muted'} mono`}>{t.code}</span></td>
                    <td>
                      <input className="ins-days" type="number" min="1" max="365" placeholder={`${data.defaultIntervalDays} (default)`} value={v}
                        onChange={(e) => setEdits((x) => ({ ...x, [t.code]: e.target.value }))} aria-label={`Interval for ${t.display} in days`} /> <span className="hint">days</span>
                    </td>
                    <td className="cell-actions">
                      <button className="btn btn-primary" disabled={edits[t.code] === undefined || edits[t.code] === '' || Number(edits[t.code]) === t.intervalDays} onClick={() => saveCode(t.code, Number(edits[t.code]))}>Save</button>
                      {t.intervalDays && <button className="btn btn-ghost" onClick={() => saveCode(t.code, null)}>Use default</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Shared pieces ─────────────────────────────

function Tile({ label, value, sub, tone }) {
  return (
    <div className={`dash-card ins-tile ${tone === 'warn' ? 'warn' : ''}`}>
      <h3>{label}</h3>
      <p className="stat-value">{value}</p>
      {sub && <p>{sub}</p>}
    </div>
  );
}

/** A ranked list with a thin proportional bar under each label. */
function BarList({ title, sub, rows, empty }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="panel ins-barlist">
      <div className="panel-head"><div><span className="eyebrow">{sub}</span><h3>{title}</h3></div></div>
      {rows.length === 0 ? <p className="hint">{empty}</p> : (
        <ul>
          {rows.slice(0, 8).map((r) => (
            <li key={r.key} title={`${r.label}: ${r.count}`}>
              <div className="ins-bar-label"><span>{r.label}</span><strong>{r.count}</strong></div>
              <div className="ins-bar-track"><div className="ins-bar" style={{ width: `${(r.count / max) * 100}%` }} /></div>
            </li>
          ))}
          {rows.length > 8 && <li className="hint">and {rows.length - 8} more</li>}
        </ul>
      )}
    </div>
  );
}

/** Horizontal bars for the top diagnoses, labelled directly. */
function HBars({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="ins-hbars">
      {rows.map((r) => (
        <li key={r.key} title={`${r.label} (${r.code}): ${r.count} episodes`}>
          <span className="ins-hbar-name">{r.label} <span className="mono hint">{r.code}</span></span>
          <span className="ins-hbar-track"><span className="ins-bar" style={{ width: `${(r.count / max) * 100}%` }} /></span>
          <strong>{r.count}</strong>
        </li>
      ))}
    </ul>
  );
}
