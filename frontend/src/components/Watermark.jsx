import { useEffect, useMemo, useRef, useState } from 'react';
import './Watermark.css';

/**
 * Watermark
 *
 * A faint Cevruni logo in the centre of the screen plus a faint,
 * repeating, tilted label over every signed-in screen: who is
 * viewing, their role and hospital, and the current date and time. It
 * cannot stop a screenshot (no web page can on every OS; see
 * ScreenShield.jsx), but it makes any leaked screenshot or phone photo
 * traceable to the account that took it.
 *
 * - It never blocks clicks or text selection (pointer-events: none).
 * - The time refreshes every 30 seconds, so a capture shows when it was taken.
 * - If the overlay is removed or restyled in the browser's developer tools,
 *   it puts itself back.
 * - Printing is already replaced by noise (ScreenShield.css), so it is not printed.
 *
 * Set VITE_WATERMARK=off to hide it, e.g. for UI screenshots in docs.
 */

const ENABLED = (import.meta.env.VITE_WATERMARK || 'on').toLowerCase() !== 'off';
const TILE_W = 420;
const TILE_H = 220;

function formatNow(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

/** A tile of two text lines, rotated, as an SVG data URI for a repeating background. */
function tileUri(line1, line2) {
  const text = (y, value, weight) =>
    `<text x="50%" y="${y}" text-anchor="middle" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="15" font-weight="${weight}" fill="#0f172a" fill-opacity="0.09" stroke="#ffffff" stroke-opacity="0.07" stroke-width="2" paint-order="stroke">${escapeXml(value)}</text>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}">` +
    `<g transform="rotate(-24 ${TILE_W / 2} ${TILE_H / 2})">` +
    text(TILE_H / 2 - 4, line1, 600) +
    text(TILE_H / 2 + 18, line2, 400) +
    `</g></svg>`;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

const ROLE_LABELS = {
  patient: 'Patient',
  clinician: 'Clinician',
  hospital_admin: 'Hospital Admin',
  system_admin: 'System Admin',
  hl7_interface: 'HL7 Interface',
};

export function Watermark({ session, demo = false }) {
  const [now, setNow] = useState(() => new Date());
  const ref = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const identity = useMemo(() => {
    if (!session) return demo ? 'Demo session · not signed in' : null;
    const roles = (session.roles || []).map((r) => ROLE_LABELS[r] || r).join(', ');
    return [session.sub, roles, session.hospitalID].filter(Boolean).join(' · ');
  }, [session, demo]);

  const background = identity ? tileUri(identity, `Cevruni · ${formatNow(now)} · Confidential`) : null;

  // Latest background, read by the tamper guard so React's own updates
  // (the clock) are never mistaken for tampering.
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  const visible = Boolean(background);

  // Put the overlay back if it is deleted, hidden or restyled.
  useEffect(() => {
    if (!ENABLED || !visible) return undefined;
    const el = ref.current;
    const parent = el && el.parentNode;
    if (!el || !parent) return undefined;
    const ATTRS = { attributes: true, attributeFilter: ['style', 'class', 'hidden'] };
    let selfObserver;
    const restore = () => {
      selfObserver.disconnect();
      el.className = 'cevruni-watermark';
      el.removeAttribute('hidden');
      el.style.cssText = '';
      el.style.backgroundImage = backgroundRef.current;
      if (!el.isConnected) parent.appendChild(el);
      selfObserver.observe(el, ATTRS);
    };
    selfObserver = new MutationObserver(restore);
    selfObserver.observe(el, ATTRS);
    const parentObserver = new MutationObserver(() => {
      if (!el.isConnected) restore();
    });
    parentObserver.observe(parent, { childList: true });
    return () => {
      selfObserver.disconnect();
      parentObserver.disconnect();
    };
  }, [visible]);

  if (!ENABLED || !background) return null;
  return <div ref={ref} className="cevruni-watermark" aria-hidden="true" style={{ backgroundImage: background }} />;
}
