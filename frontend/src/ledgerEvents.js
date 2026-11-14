import { useEffect, useRef } from 'react';
import { getToken } from './auth';

/**
 * ledgerEvents.js — event-driven updates (Section 3.4.4).
 *
 * One shared connection to GET /api/events/stream (Server-Sent Events).
 * The backend forwards Fabric chaincode events (or the simulator's) as they
 * happen, so screens refresh when the ledger changes instead of polling it.
 * fetch() streaming is used rather than EventSource so the sign-in token
 * can be sent. Reconnects with backoff if the connection drops.
 */

const BASE = import.meta.env.VITE_API_BASE || '/api';
const listeners = new Set();
let controller = null;
let connected = false;

async function run() {
  let backoff = 1000;
  while (listeners.size) {
    controller = new AbortController();
    try {
      const token = getToken();
      const res = await fetch(`${BASE}/events/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      connected = true;
      backoff = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          try {
            const evt = JSON.parse(data);
            listeners.forEach((fn) => fn(evt));
          } catch {
            // ignore malformed event
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    } finally {
      connected = false;
    }
    if (!listeners.size) return;
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30000);
  }
}

function subscribe(fn) {
  listeners.add(fn);
  if (listeners.size === 1) run();
  return () => {
    listeners.delete(fn);
    if (!listeners.size && controller) controller.abort();
  };
}

export function isStreamConnected() {
  return connected;
}

/**
 * Calls onEvent for every ledger event visible to the signed-in user.
 * `types` limits it to some event types. Pass enabled=false to pause.
 */
export function useLedgerEvents(onEvent, { types = null, enabled = true } = {}) {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  const key = types ? types.join(',') : '';
  useEffect(() => {
    if (!enabled) return undefined;
    const wanted = key ? new Set(key.split(',')) : null;
    return subscribe((evt) => {
      if (!wanted || wanted.has(evt.type)) ref.current(evt);
    });
  }, [enabled, key]);
}
