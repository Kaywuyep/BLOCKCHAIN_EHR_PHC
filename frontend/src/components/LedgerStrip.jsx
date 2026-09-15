import './LedgerStrip.css';

const STATUS_STYLES = {
  PENDING: { bg: 'var(--amber-bg)', fg: 'var(--amber)' },
  ACTIVE: { bg: 'var(--sage-bg)', fg: 'var(--sage)' },
  REVOKED: { bg: 'var(--rust-bg)', fg: 'var(--rust)' },
  EXPIRED: { bg: '#eee', fg: 'var(--ink-soft)' },
  DEFAULT: { bg: 'var(--sage-bg)', fg: 'var(--sage)' },
};

function shortId(id) {
  if (!id) return '--------';
  return id.replace(/-/g, '').slice(0, 8);
}

/**
 * LedgerStrip renders a vertical chain of entries, each visually
 * "appended" as a linked block -- the project's signature element,
 * standing in for what an append-only ledger feels like without
 * pretending to render an actual Merkle chain.
 */
export function LedgerStrip({ entries, emptyLabel = 'No entries yet.' }) {
  if (!entries || entries.length === 0) {
    return <p className="ledger-empty">{emptyLabel}</p>;
  }
  return (
    <div className="ledger-strip">
      {entries.map((entry, i) => {
        const status = STATUS_STYLES[entry.status] || STATUS_STYLES.DEFAULT;
        return (
          <div className="ledger-block" key={entry.id || i}>
            <div className="ledger-block-rail">
              <span className="ledger-block-dot" />
              {i < entries.length - 1 && <span className="ledger-block-link" />}
            </div>
            <div className="ledger-block-card">
              <div className="ledger-block-head">
                <span className="data ledger-block-id">#{shortId(entry.id)}</span>
                <span
                  className="ledger-block-badge"
                  style={{ background: status.bg, color: status.fg }}
                >
                  {entry.status || entry.type}
                </span>
              </div>
              <div className="ledger-block-title">{entry.title}</div>
              {entry.subtitle && <div className="ledger-block-subtitle">{entry.subtitle}</div>}
              {entry.timestamp && (
                <div className="data ledger-block-time">{new Date(entry.timestamp).toLocaleString()}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
