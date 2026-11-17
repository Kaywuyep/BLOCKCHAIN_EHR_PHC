'use strict';

/**
 * accessInsights.js
 *
 * Insights > Access activity: how the system is used, computed from what
 * the ledger already holds (grants and audit entries). It reads no
 * clinical data and returns no patient identifiers, only counts.
 */

const DAY = 24 * 3600 * 1000;

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

const toList = (map, keyName = 'key') =>
  [...map.entries()].map(([k, v]) => ({ [keyName]: k, count: v })).sort((a, b) => b.count - a.count);

/**
 * @param {object} ledger      simulated or Fabric ledger service
 * @param {string[]} hospitalIDs every hospital in the registry
 * @param {{ from: Date, to: Date }} range
 */
async function accessActivity(ledger, hospitalIDs, { from, to }) {
  const grants = new Map();
  const audit = new Map();
  for (const h of hospitalIDs) {
    const [gs, es] = await Promise.all([
      Promise.resolve(ledger.getGrantsForHospital(h)).catch(() => []),
      Promise.resolve(ledger.getAuditTrailForHospital(h)).catch(() => []),
    ]);
    for (const g of gs || []) grants.set(g.grantID, g);
    for (const e of es || []) audit.set(e.entryID || `${e.timestamp}:${e.eventType}:${e.actorID}`, e);
  }

  const inRange = (iso) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
  };

  // ── Requests (grants created in the range) ──
  const byStatus = new Map();
  const byPurpose = new Map();
  const byRole = new Map();
  const byType = new Map();
  const pairs = new Map();
  const approveMinutes = [];
  let requests = 0;
  let emergencies = 0;
  for (const g of grants.values()) {
    if (!inRange(g.requestedAt)) continue;
    if (g.grantType === 'BREAK_GLASS') {
      emergencies += 1;
    } else {
      requests += 1;
      inc(byStatus, g.status);
      if (g.grantedAt) approveMinutes.push((new Date(g.grantedAt) - new Date(g.requestedAt)) / 60000);
    }
    inc(byPurpose, g.grantType === 'BREAK_GLASS' ? 'Emergency' : g.purpose || 'Not stated');
    inc(byRole, g.providerRole || (g.providerID && g.providerID.startsWith('hospital-staff@') ? 'Any clinician (hospital share)' : 'Not stated'));
    for (const t of g.scope && g.scope.length ? g.scope : ['All record types']) inc(byType, t);
    if (g.requesterHospitalID) inc(pairs, `${g.requesterHospitalID}→${g.hospitalID}`);
  }

  // ── Events (audit entries in the range) ──
  const views = [];
  const clinicians = new Set();
  const viewsByRecordsHospital = new Map();
  const viewsByViewerHospital = new Map();
  let revocations = 0;
  let screenshots = 0;
  let reviewed = 0;
  for (const e of audit.values()) {
    if (!inRange(e.timestamp)) continue;
    if (e.eventType === 'RECORD_ACCESSED') {
      views.push(e);
      if (e.actorID) clinicians.add(e.actorID);
      inc(viewsByRecordsHospital, e.hospitalID);
      const m = /via grant (\S+?)(;|$)/.exec(e.detail || '');
      const g = m && grants.get(m[1]);
      if (g && g.requesterHospitalID) inc(viewsByViewerHospital, g.requesterHospitalID);
    } else if (e.eventType === 'GRANT_REVOKED') revocations += 1;
    else if (e.eventType === 'SCREEN_CAPTURE_ATTEMPT') screenshots += 1;
    else if (e.eventType === 'BREAK_GLASS_REVIEWED') reviewed += 1;
  }

  // ── Views per day ──
  const days = Math.max(1, Math.min(366, Math.ceil((to - from) / DAY)));
  const perDay = new Map();
  for (let i = 0; i < days; i += 1) perDay.set(new Date(from.getTime() + i * DAY).toISOString().slice(0, 10), 0);
  for (const e of views) {
    const d = new Date(e.timestamp).toISOString().slice(0, 10);
    if (perDay.has(d)) inc(perDay, d);
  }

  const decided = (byStatus.get('ACTIVE') || 0) + (byStatus.get('EXPIRED') || 0) + (byStatus.get('REVOKED') || 0);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: {
      recordViews: views.length,
      activeClinicians: clinicians.size,
      requests,
      emergencies,
      emergenciesReviewed: reviewed,
      revocations,
      screenshotAttempts: screenshots,
      approvalRate: requests ? Math.round((decided / requests) * 100) : null,
      medianMinutesToApprove: approveMinutes.length ? Math.round(median(approveMinutes) * 10) / 10 : null,
    },
    requestsByStatus: toList(byStatus, 'status'),
    byPurpose: toList(byPurpose, 'purpose'),
    byRole: toList(byRole, 'role'),
    byRecordType: toList(byType, 'recordType'),
    hospitalPairs: toList(pairs, 'pair').map(({ pair, count }) => {
      const [requester, records] = pair.split('→');
      return { requesterHospitalID: requester, recordsHospitalID: records, count };
    }),
    viewsByRecordsHospital: toList(viewsByRecordsHospital, 'hospitalID'),
    viewsByViewerHospital: toList(viewsByViewerHospital, 'hospitalID'),
    viewsPerDay: [...perDay.entries()].map(([date, count]) => ({ date, count })),
  };
}

module.exports = { accessActivity, median };
