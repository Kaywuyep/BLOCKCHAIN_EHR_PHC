import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import '../pages/insights.css';

/**
 * DiagnosisTagger — optional, after a clinician opens a patient's records
 * from another hospital: "What is this visit about?" The clinician types,
 * picks ICD-10 diagnoses (local names like "MP+" work), or adds a term the
 * catalogue lacks. Saving only adds to anonymous counts for Insights,
 * once per episode per patient; nothing is stored in the patient's record.
 *
 * The box lists what has been noted under this access, greys out a
 * diagnosis until its interval has passed, and lets the clinician undo
 * their own tick on the day they made it.
 *
 * `conditionTexts` are diagnosis names found in the opened record; each is
 * matched against the catalogue and offered as a one-click suggestion.
 */
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });

export function DiagnosisTagger({ grantID, conditionTexts = [] }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState([]);
  const [suggested, setSuggested] = useState([]);
  const [notes, setNotes] = useState([]);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    api.getDiagnosisNotes(grantID).then(setNotes).catch(() => setNotes([]));
  }, [grantID]);

  useEffect(() => {
    let alive = true;
    Promise.all([...new Set(conditionTexts)].slice(0, 5).map((t) => api.searchDiagnoses(t, 1).then((r) => r[0]).catch(() => null)))
      .then((found) => alive && setSuggested(found.filter(Boolean).filter((s, i, a) => a.findIndex((x) => x.code === s.code) === i)));
    return () => { alive = false; };
  }, [conditionTexts.join('|')]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return undefined; }
    timer.current = setTimeout(() => {
      api.searchDiagnoses(q.trim(), 8).then((r) => { setResults(r); setActive(0); }).catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(timer.current);
  }, [q]);

  // A diagnosis noted on this access within its interval can't be ticked again yet.
  const blocked = new Map(notes.filter((n) => n.nextAt).map((n) => [n.code, n]));

  const exact = results.some((r) => r.display.toLowerCase() === q.trim().toLowerCase() || r.synonyms?.includes(q.trim().toLowerCase()));
  const options = [...results, ...(q.trim().length >= 3 && !exact ? [{ add: true, display: q.trim() }] : [])];

  function pick(t) {
    setMessage(null);
    if (blocked.has(t.code)) return;
    setPicked((p) => (p.some((x) => x.code === t.code) || p.length >= 10 ? p : [...p, t]));
    setQ('');
    setResults([]);
  }

  async function choose(opt) {
    if (!opt) return;
    if (!opt.add) return pick(opt);
    setError(null);
    try {
      pick(await api.addDiagnosisTerm(opt.display));
    } catch (e) { setError(e.message); }
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(options[active]); }
    else if (e.key === 'Escape') { setResults([]); }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.tagDiagnoses(grantID, picked.map((p) => p.code));
      setNotes(r.notes);
      setPicked([]);
      const skipped = r.results.filter((x) => x.status === 'already-noted');
      setMessage(skipped.length
        ? `Saved. ${skipped.map((x) => `${x.display} was already noted on ${fmtDate(x.notedAt)}`).join('; ')}.`
        : 'Saved.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function undo(code) {
    setError(null);
    try {
      const r = await api.undoDiagnosis(grantID, code);
      setNotes(r.notes);
      setMessage('Removed.');
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="dx-tagger">
      <div className="dx-tagger-head">
        <strong>What is this visit about? <span className="hint">(optional)</span></strong>
        <span className="hint">Counted anonymously for hospital statistics. Not saved to the patient’s record.</span>
      </div>

      {notes.length > 0 && (
        <div className="dx-noted">
          <span className="hint">Noted on this access:</span>
          {notes.map((n) => (
            <span key={`${n.code}-${n.notedAt}`} className={`dx-note ${n.nextAt ? '' : 'old'}`} title={n.nextAt ? `Can be noted again from ${fmtDate(n.nextAt)}` : 'Can be noted again'}>
              {n.display} <span className="mono">{n.code}</span> · {fmtDate(n.notedAt)}{n.byYou ? '' : ' · a colleague'}
              {n.canUndo && <button onClick={() => undo(n.code)} aria-label={`Undo ${n.display}`} title="Undo (today only)">Undo</button>}
            </span>
          ))}
        </div>
      )}

      {suggested.length > 0 && (
        <div className="dx-suggested">
          <span className="hint">From this record:</span>
          {suggested.filter((s) => !picked.some((p) => p.code === s.code)).map((s) => (
            <button key={s.code} disabled={blocked.has(s.code)} onClick={() => pick(s)} title={blocked.has(s.code) ? `Already noted; again from ${fmtDate(blocked.get(s.code).nextAt)}` : undefined}>
              + {s.display} <span className="mono">{s.code}</span>
            </button>
          ))}
        </div>
      )}

      <div className="dx-search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a diagnosis or ICD-10 code, e.g. malaria, MP+, htn, B54"
          aria-label="Search diagnoses"
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={`dx-results-${grantID}`}
        />
        {options.length > 0 && (
          <ul className="dx-results" id={`dx-results-${grantID}`} role="listbox">
            {options.map((o, i) => {
              const b = !o.add && blocked.get(o.code);
              return (
                <li key={o.add ? '__add' : o.code} role="option" aria-selected={i === active} aria-disabled={Boolean(b)}
                  className={`${i === active ? 'active' : ''} ${b ? 'blocked' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); choose(o); }} onMouseEnter={() => setActive(i)}>
                  {o.add ? (
                    <span className="dx-add">+ Add “{o.display}” as a new diagnosis</span>
                  ) : (
                    <>
                      <span className="dx-code">{o.code}</span>
                      <span>
                        {o.display}
                        {o.status === 'pending' && <span className="hint"> · awaiting ICD-10 mapping</span>}
                        {b && <span className="hint"> · noted {fmtDate(b.notedAt)}, again from {fmtDate(b.nextAt)}</span>}
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {picked.length > 0 && (
        <div className="dx-chips">
          {picked.map((p) => (
            <span key={p.code} className={`dx-chip ${p.system === 'LOCAL' ? 'local' : ''}`}>
              {p.display} <span className="mono">{p.code}</span>
              <button aria-label={`Remove ${p.display}`} onClick={() => setPicked((x) => x.filter((y) => y.code !== p.code))}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className="dx-foot">
        <button className="btn btn-primary" disabled={!picked.length || busy} onClick={save}>{busy ? 'Saving…' : 'Save diagnoses'}</button>
        {message && <span className="dx-done">✓ {message}</span>}
        {picked.some((p) => p.system === 'LOCAL') && <span className="hint">New terms get a temporary code until a health records officer maps them to ICD-10.</span>}
        {error && <div className="error-banner" style={{ width: '100%' }}>{error}</div>}
      </div>
    </div>
  );
}
