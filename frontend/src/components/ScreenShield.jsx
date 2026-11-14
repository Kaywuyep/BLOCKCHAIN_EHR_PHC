import { useCallback, useEffect, useRef, useState } from 'react';
import './ScreenShield.css';
import { reportScreenCapture } from './screenCaptureAudit';

/**
 * ScreenShield
 *
 * Covers the whole app with animated white noise whenever a screen capture
 * is likely, so that a capture shows static rather than patient data.
 *
 * What a web page can and cannot do here:
 * - A browser page gets no event when the operating system takes a
 *   screenshot, and cannot stop one. This component is a best-effort
 *   deterrent, not a guarantee. Screenshot tools started from a menu or
 *   button, screen recorders, and phone cameras are out of reach.
 * - What it does catch:
 *     1. the window losing focus or being hidden: snipping tools, screen
 *        recorders, screen-share pickers and app switchers usually take
 *        focus first. This noise clears itself when the window is focused
 *        again;
 *     2. screenshot shortcuts the page can see: PrintScreen, and
 *        Cmd+Shift+3/4/5/6 (macOS) / Win+Shift+S (Windows). The noise is
 *        raised as soon as Cmd/Win+Shift is held, because the OS usually
 *        swallows the final key. If the page then receives a non-capture
 *        key, it was an ordinary shortcut and the noise is removed;
 *     3. printing and "Save as PDF": the print stylesheet swaps the page
 *        for a noise pattern (see ScreenShield.css).
 *   After PrintScreen it also overwrites the clipboard, which is where
 *   Windows puts that capture, when the browser allows it.
 *
 * Every attempt is reported to the backend audit log (screenCaptureAudit.js):
 * "confirmed" when the page saw the capture key, "suspected" when
 * Cmd/Win+Shift was pressed and released with no other key reaching the
 * page, which is what an OS-consumed screenshot shortcut looks like.
 *
 * The noise clears itself after a few seconds, or on click. If a capture
 * tool has taken focus (an area-selection overlay), it stays up until the
 * window is focused again.
 *
 * Set VITE_SCREEN_SHIELD=off to disable it, e.g. for UI screenshots in
 * documentation.
 */

const ENABLED = (import.meta.env.VITE_SCREEN_SHIELD || 'on').toLowerCase() !== 'off';

// Noise is drawn at a fraction of screen resolution and scaled up with
// nearest-neighbour sampling: coarse grain reads as "TV static", and it
// keeps the per-frame cost tiny.
const GRAIN = 3;

// How long the noise stays up after a screenshot shortcut.
const HOLD_MS = 3000;
// Extra delay after the window regains focus from a capture tool.
const REFOCUS_GRACE_MS = 500;

function isPrintScreen(e) {
  return e.key === 'PrintScreen' || e.code === 'PrintScreen';
}

// Which OS shortcut a Cmd/Win+Shift chord belongs to, for the audit log.
const CHORD_METHOD = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '')
  ? 'mac-shortcut'
  : 'windows-snip';

function isModifier(e) {
  return ['Meta', 'OS', 'Shift'].includes(e.key);
}

// macOS: Cmd+Shift+3/4/5/6 (shifted symbols on some layouts);
// Windows Snipping Tool: Win+Shift+S.
function isCaptureKey(e) {
  const key = (e.key || '').toLowerCase();
  return ['3', '4', '5', '6', '#', '$', '%', '^', 's'].includes(key)
    || ['Digit3', 'Digit4', 'Digit5', 'Digit6', 'KeyS'].includes(e.code);
}

function NoiseCanvas() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let frame = 0;
    let image = null;
    let pixels = null;

    const resize = () => {
      canvas.width = Math.max(1, Math.ceil(window.innerWidth / GRAIN));
      canvas.height = Math.max(1, Math.ceil(window.innerHeight / GRAIN));
      image = ctx.createImageData(canvas.width, canvas.height);
      pixels = new Uint32Array(image.data.buffer);
    };

    const draw = () => {
      // One random grey level per pixel, fully opaque (0xff in the alpha byte).
      for (let i = 0; i < pixels.length; i += 1) {
        const v = (Math.random() * 256) | 0;
        pixels[i] = 0xff000000 | (v << 16) | (v << 8) | v;
      }
      ctx.putImageData(image, 0, 0);
      frame = requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="screen-shield-canvas" aria-hidden="true" />;
}

export function ScreenShield({ children }) {
  // null = not shielded; 'focus' = window lost focus, cleared on refocus;
  // 'shortcut' = screenshot shortcut or print, cleared by timer or click.
  const [mode, setMode] = useState(null);
  const shielded = ENABLED && mode !== null;
  const timerRef = useRef(null);
  const waitingForFocusRef = useRef(false);

  const hide = useCallback(() => {
    clearTimeout(timerRef.current);
    waitingForFocusRef.current = false;
    setMode(null);
  }, []);

  // Show the noise for HOLD_MS. If a capture tool has taken focus by then
  // (e.g. an area-selection overlay), keep it up until the window is
  // focused again, then clear shortly after.
  const show = useCallback(() => {
    clearTimeout(timerRef.current);
    waitingForFocusRef.current = false;
    setMode('shortcut');
    timerRef.current = setTimeout(() => {
      if (document.hasFocus()) hide();
      else waitingForFocusRef.current = true;
    }, HOLD_MS);
  }, [hide]);

  useEffect(() => {
    if (!ENABLED) return undefined;

    // True while Cmd/Win+Shift is held and no other key has reached the
    // page yet: a screenshot shortcut whose final key the OS may consume.
    let chordPending = false;
    const resolveChordAsSuspected = () => {
      if (!chordPending) return;
      chordPending = false;
      reportScreenCapture(CHORD_METHOD, 'suspected');
    };

    // Losing focus or being hidden: show the noise until the window is
    // back. A shortcut-triggered shield keeps its own timing.
    const shieldForFocus = () => setMode((m) => m ?? 'focus');
    const onFocus = () => {
      setMode((m) => (m === 'focus' ? null : m));
      if (!waitingForFocusRef.current) return;
      waitingForFocusRef.current = false;
      timerRef.current = setTimeout(hide, REFOCUS_GRACE_MS);
    };
    // A capture overlay (Cmd+Shift+5, Win+Shift+S) takes focus before any
    // key-up arrives.
    const onBlur = () => {
      resolveChordAsSuspected();
      shieldForFocus();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') shieldForFocus();
      else if (document.hasFocus()) onFocus();
    };

    const onKeyDown = (e) => {
      if (isPrintScreen(e)) {
        show();
        reportScreenCapture('print-screen');
        // Windows puts a PrintScreen capture on the clipboard; replace it.
        // Browsers only allow this while the page is focused, so it is
        // best-effort.
        navigator.clipboard?.writeText?.('').catch(() => {});
        return;
      }
      if (!(e.metaKey && e.shiftKey)) return;
      if (isModifier(e)) {
        // Cmd+Shift (macOS) / Win+Shift (Windows) is held: the OS usually
        // swallows the final 3/4/5/6/S key, so raise the noise now, before
        // the capture happens.
        chordPending = true;
        show();
      } else if (isCaptureKey(e)) {
        chordPending = false;
        show();
        reportScreenCapture(CHORD_METHOD, 'confirmed');
      } else {
        // The page received a non-capture key (e.g. Cmd+Shift+T), so this
        // was an ordinary shortcut, not a screenshot.
        chordPending = false;
        hide();
      }
    };
    const onKeyUp = (e) => {
      // Windows often delivers PrintScreen only as a keyup.
      if (isPrintScreen(e)) {
        show();
        reportScreenCapture('print-screen');
        return;
      }
      // The chord was released with no other key reaching the page.
      if (chordPending && !(e.metaKey && e.shiftKey)) resolveChordAsSuspected();
    };
    const onBeforePrint = () => {
      show();
      reportScreenCapture('print');
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    // Capture phase, so an input that stops propagation can't hide the key.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('beforeprint', onBeforePrint);
    return () => {
      clearTimeout(timerRef.current);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('beforeprint', onBeforePrint);
    };
  }, [show, hide]);

  return (
    <>
      <div className="screen-shield-content" aria-hidden={shielded || undefined} inert={shielded || undefined}>
        {children}
      </div>
      {ENABLED && (
        <div className="screen-shield-print" aria-hidden="true">
          Printing is disabled to protect patient data.
        </div>
      )}
      {shielded && (
        <div
          className="screen-shield"
          role="alertdialog"
          aria-label="Screen hidden to protect patient data"
          data-testid="screen-shield"
          onClick={hide}
        >
          <NoiseCanvas />
          <div className="screen-shield-message">
            <strong>Screen hidden to protect patient data</strong>
            <span>{mode === 'focus' ? 'Return to this window to continue.' : 'Click anywhere to return.'}</span>
          </div>
        </div>
      )}
    </>
  );
}
