'use strict';

/**
 * metrics.js
 *
 * Minimal Prometheus text exposition, without a client library. Labels
 * hold route templates (/api/access/:grantID), never concrete IDs, so
 * cardinality stays bounded and no identifiers leak into monitoring.
 */
function createMetrics() {
  const requests = new Map(); // `${method} ${route} ${status}` -> count
  const latency = new Map(); // route -> { sum, count }

  function esc(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  return {
    observeRequest(method, route, status, ms) {
      const key = `${method}\u0000${route}\u0000${status}`;
      requests.set(key, (requests.get(key) || 0) + 1);
      const l = latency.get(route) || { sum: 0, count: 0 };
      l.sum += ms / 1000;
      l.count += 1;
      latency.set(route, l);
    },

    render({ uptimeSeconds, offlineQueued, hl7 }) {
      const lines = [];
      lines.push('# HELP patientchain_up 1 while the process is running.', '# TYPE patientchain_up gauge', 'patientchain_up 1');
      lines.push('# TYPE patientchain_uptime_seconds gauge', `patientchain_uptime_seconds ${uptimeSeconds.toFixed(0)}`);
      lines.push('# HELP patientchain_http_requests_total HTTP requests by route and status.', '# TYPE patientchain_http_requests_total counter');
      for (const [key, n] of requests) {
        const [method, route, status] = key.split('\u0000');
        lines.push(`patientchain_http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${status}"} ${n}`);
      }
      lines.push('# TYPE patientchain_http_request_duration_seconds summary');
      for (const [route, { sum, count }] of latency) {
        lines.push(`patientchain_http_request_duration_seconds_sum{route="${esc(route)}"} ${sum.toFixed(6)}`);
        lines.push(`patientchain_http_request_duration_seconds_count{route="${esc(route)}"} ${count}`);
      }
      lines.push('# HELP patientchain_offline_queue_depth Access actions queued while the ledger is unreachable.');
      lines.push('# TYPE patientchain_offline_queue_depth gauge', `patientchain_offline_queue_depth ${offlineQueued}`);
      if (hl7) {
        lines.push('# HELP patientchain_hl7_messages HL7 inbox messages by status (DEAD = dead-letter queue).');
        lines.push('# TYPE patientchain_hl7_messages gauge');
        for (const [status, n] of Object.entries(hl7.counts)) {
          lines.push(`patientchain_hl7_messages{status="${status}"} ${n}`);
        }
        lines.push('# TYPE patientchain_hl7_oldest_pending_age_seconds gauge');
        lines.push(`patientchain_hl7_oldest_pending_age_seconds ${hl7.oldestPendingAgeSeconds}`);
      }
      return `${lines.join('\n')}\n`;
    },
  };
}

module.exports = { createMetrics };
