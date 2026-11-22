import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { reportScreenCapture } from './screenCaptureAudit';
import './PrivacyGuard.css';

/**
 * PrivacyGuard — protections for every signed-in Cevruni screen
 * (user decision, 2026-11-18: "fix the gap for the entire Cevruni system").
 *
 * No web page can stop a phone photo of the screen, so these discourage
 * copying, limit how long patient data stays visible, and make misuse
 * traceable (together with the named Watermark and ScreenShield):
 *
 *  1. Copy guard: selecting, copying, cutting, right-click, dragging,
 *     Ctrl/Cmd+A and Ctrl/Cmd+S are blocked outside typing fields and
 *     places marked data-allow-copy (temporary passwords, connection
 *     details, the patient's own emergency code). Copy and save attempts
 *     are logged to the ledger audit trail like screenshot attempts.
 *  2. Privacy lock: after IDLE_MS without activity the screen is hidden
 *     until the person chooses to continue. Leaving the tab or window, or
 *     the lock, sends "cevruni:privacy-close": pages showing records close
 *     them (opening again re-checks access on the ledger and is logged).
 *  3. Confidentiality notice: staff confirm it once per sign-in before
 *     using Cevruni; the confirmation is written to the ledger.
 */

const IDLE_MS = Number(import.meta.env.VITE_PRIVACY_IDLE_MS) || 5 * 60 * 1000;
const STAFF_ROLES = ['clinician', 'hospital_admin', 'system_admin'];

export const PRIVACY_CLOSE = 'cevruni:privacy-close';

function allowed(target) {
  const el = target && target.nodeType === 1 ? target : target && target.parentElement;
  if (!el || !el.closest) return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"], [data-allow-copy]'));
}

function closeRecords(reason) {
  window.dispatchEvent(new CustomEvent(PRIVACY_CLOSE, { detail: { reason } }));
}

export function PrivacyGuard({ session, enabled = true }) {
  const [notice, setNotice] = useState('');
  const [locked, setLocked] = useState(false);
  const [needsAck, setNeedsAck] = useState(false);
  const noticeTimer = useRef(null);
  const sub = session?.sub || '';
  const isStaff = Boolean(session?.roles?.some((r) => STAFF_ROLES.includes(r)));
  const ackKey = `cevruni.confidentiality.${sub}`;

  // 3. Confidentiality notice, once per sign-in (per browser tab session).
  useEffect(() => {
    if (!enabled || !isStaff || !sub) return;
    let seen = false;
    try {
      seen = sessionStorage.getItem(ackKey) === '1';
    } catch {
      seen = false;
    }
    setNeedsAck(!seen);
  }, [enabled, isStaff, sub, ackKey]);

  function acknowledge() {
    try {
      sessionStorage.setItem(ackKey, '1');
    } catch {
      // storage blocked: the notice shows again next time, which is fine
    }
    setNeedsAck(false);
    api.acceptConfidentiality().catch(() => {});
  }

  function flash(text) {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 3500);
  }

  // 1. Copy guard.
  useEffect(() => {
    if (!enabled) return undefined;
    const onCopy = (e) => {
      if (allowed(e.target)) return;
      const sel = window.getSelection && String(window.getSelection() || '');
      e.preventDefault();
      if (sel && sel.trim()) {
        reportScreenCapture('copy', 'confirmed');
        flash('Copying patient information is not allowed. This attempt has been recorded.');
      }
    };
    const onContext = (e) => {
      if (allowed(e.target)) return;
      e.preventDefault();
      flash('Right-click is turned off to protect patient information.');
    };
    const onDrag = (e) => {
      if (allowed(e.target)) return;
      e.preventDefault();
    };
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = String(e.key || '').toLowerCase();
      if (k === 's') {
        e.preventDefault();
        reportScreenCapture('save-page', 'confirmed');
        flash('Saving this page is not allowed. This attempt has been recorded.');
      } else if (k === 'a' && !allowed(e.target)) {
        e.preventDefault();
      }
    };
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('cut', onCopy, true);
    document.addEventListener('contextmenu', onContext, true);
    document.addEventListener('dragstart', onDrag, true);
    document.addEventListener('keydown', onKey, true);
    document.documentElement.classList.add('privacy-guard');
    return () => {
      document.removeEventListener('copy', onCopy, true);
      document.removeEventListener('cut', onCopy, true);
      document.removeEventListener('contextmenu', onContext, true);
      document.removeEventListener('dragstart', onDrag, true);
      document.removeEventListener('keydown', onKey, true);
      document.documentElement.classList.remove('privacy-guard');
    };
  }, [enabled]);

  // 2. Privacy lock and closing records when the screen is left.
  useEffect(() => {
    if (!enabled) return undefined;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setLocked(true);
        closeRecords('idle');
      }, IDLE_MS);
    };
    const activity = () => {
      if (!document.hidden) arm();
    };
    const onHidden = () => {
      if (document.hidden) closeRecords('hidden');
      else arm();
    };
    const onBlur = () => closeRecords('blur');
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll'];
    events.forEach((ev) => window.addEventListener(ev, activity, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', onBlur);
    arm();
    return () => {
      clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, activity, { capture: true }));
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <>
      {notice && <div className="privacy-toast" role="alert">{notice}</div>}
      {locked && (
        <div className="privacy-lock" role="dialog" aria-modal="true" aria-label="Screen hidden for privacy">
          <div className="privacy-card">
            <div className="privacy-icon">{'\u{1F512}'}</div>
            <h2>Hidden for privacy</h2>
            <p>Cevruni hid this screen after {Math.round(IDLE_MS / 60000)} minutes without activity. Any open records were closed; opening them again re-checks your access.</p>
            <button className="btn btn-primary" onClick={() => setLocked(false)} autoFocus>Continue</button>
          </div>
        </div>
      )}
      {needsAck && !locked && (
        <div className="privacy-lock" role="dialog" aria-modal="true" aria-label="Confidentiality notice">
          <div className="privacy-card">
            <div className="privacy-icon">{'\u{1F6E1}'}</div>
            <h2>Confidential patient information</h2>
            <ul>
              <li>Patient records are confidential. Use them only to care for the patient, within the access the patient gave.</li>
              <li>Everything you open is recorded on the blockchain with your name, hospital and the time, and the patient can see it.</li>
              <li>Copying, saving, printing, screenshotting or photographing patient information is not allowed (Nigeria Data Protection Act 2023; National Health Act s.26).</li>
            </ul>
            <button className="btn btn-primary" onClick={acknowledge} autoFocus>I understand and agree</button>
          </div>
        </div>
      )}
    </>
  );
}
