import { useCallback, useEffect, useRef, useState } from 'react';
import './ScreenShield.css';

/**
 * ScreenShield
 *
 * Covers the whole app with animated white noise whenever a screen capture
 * is likely, so that a capture shows static rather than patient data.
 *
 * What a web page can and cannot do here:
 * - A browser page gets no event when the operating system takes a
 *   screenshot, and cannot stop one. This component is a best-effort
 *   deterrent, not a guarantee. A phone camera pointed at the screen, or
 *   a capture taken while the window keeps focus, is out of reach.
 * - What it does catch:
 *     1. the window losing focus or being hidden: snipping tools, screen
 *        recorders, screen-share pickers and app switchers usually take
 *        focus first;
 *     2. the screenshot shortcuts the page can see: PrintScreen,
 *        Cmd+Shift+3/4/5/6 (macOS), Win+Shift+S (Windows), and
 *        Ctrl/Cmd+P for printing;
 *     3. printing and "Save as PDF": the print stylesheet swaps the page
 *        for a noise pattern (see ScreenShield.css);
 *   After PrintScreen it also overwrites the clipboard, which is where
 *   Windows puts that capture, when the browser allows it.
 *
 * A shortcut-triggered shield stays up until the user clicks it, so the
 * noise is still on screen while an area-selection tool is open. A
 * focus-triggered shield clears itself once the window is focused again.
 *
 * Set VITE_SCREEN_SHIELD=off to disable it, e.g. for UI screenshots in
 * documentation.
 */

const ENABLED = (import.meta.env.VITE_SCREEN_SHIELD || 'on').toLowerCase() !== 'off';

// Noise is drawn at a fraction of screen resolution and scaled up with
// nearest-neighbour sampling: coarse grain reads as "TV static", and it
// keeps the per-frame cost tiny.
const GRAIN = 3;

function isCaptureShortcut(e) {
  if (e.key === 'PrintScreen' || e.code === 'PrintScreen') return true;
  const key = (e.key || '').toLowerCase();
  // macOS: Cmd+Shift+3 / 4 / 5 / 6
  if (e.metaKey && e.shiftKey && ['3', '4', '5', '6', '#', '$', '%', '^'].includes(key)) return true;
  // Windows Snipping Tool: Win+Shift+S
  if (e.metaKey && e.shiftKey && key === 's') return true;
  // Print / Save as PDF
  if ((e.ctrlKey || e.metaKey) && key === 'p') return true;
  return false;
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
  // null = not shielded; 'focus' = cleared automatically on refocus;
  // 'shortcut' = cleared only by an explicit click.
  const [reason, setReason] = useState(null);

  const shield = useCallback((why) => {
    setReason((current) => (current === 'shortcut' ? current : why));
  }, []);

  useEffect(() => {
    if (!ENABLED) return undefined;

    const onBlur = () => shield('focus');
    const onFocus = () => setReason((current) => (current === 'focus' ? null : current));
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') shield('focus');
    };
    const onKey = (e) => {
      if (!isCaptureShortcut(e)) return;
      setReason('shortcut');
      if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
        // Windows puts a PrintScreen capture on the clipboard; replace it.
        // Browsers only allow this while the page is focused, so it is
        // best-effort.
        navigator.clipboard?.writeText?.('').catch(() => {});
      }
    };
    const onBeforePrint = () => setReason('shortcut');

    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    // Capture phase, so an input that stops propagation can't hide the key.
    window.addEventListener('keydown', onKey, true);
    // Windows often delivers PrintScreen only as a keyup.
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('beforeprint', onBeforePrint);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('beforeprint', onBeforePrint);
    };
  }, [shield]);

  const shielded = ENABLED && reason !== null;

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
          onClick={() => setReason(null)}
        >
          <NoiseCanvas />
          <div className="screen-shield-message">
            <strong>Screen hidden to protect patient data</strong>
            <span>{reason === 'shortcut' ? 'Click anywhere to return.' : 'Return to this window to continue.'}</span>
          </div>
        </div>
      )}
    </>
  );
}
