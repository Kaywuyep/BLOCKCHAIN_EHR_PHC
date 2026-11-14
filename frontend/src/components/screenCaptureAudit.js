import { useEffect } from 'react';
import { api } from '../api';

/**
 * screenCaptureAudit.js
 *
 * Reports screenshot attempts seen by ScreenShield to the backend, which
 * writes a SCREEN_CAPTURE_ATTEMPT entry to the ledger audit trail.
 *
 * Pages that show a patient's data call useScreenCaptureSubject(did) so the
 * attempt is filed under that patient and appears in their audit trail.
 */

let subjectDID = null;

export function useScreenCaptureSubject(patientDID) {
  useEffect(() => {
    if (!patientDID) return undefined;
    subjectDID = patientDID;
    return () => {
      if (subjectDID === patientDID) subjectDID = null;
    };
  }, [patientDID]);
}

// One report per attempt: holding a key, or PrintScreen arriving as both
// keydown and keyup, must not log several times.
const DEDUPE_MS = 2000;
let lastReport = { key: '', at: 0 };

export function reportScreenCapture(method, confidence = 'confirmed') {
  const now = Date.now();
  const key = `${method}:${confidence}`;
  if (lastReport.key === key && now - lastReport.at < DEDUPE_MS) return;
  lastReport = { key, at: now };
  api
    .logScreenCapture({
      method,
      confidence,
      page: window.location.pathname,
      patientDID: subjectDID || undefined,
    })
    .catch(() => {
      // Best effort: a failed report must never block the user.
    });
}
