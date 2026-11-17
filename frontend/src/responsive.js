import { useEffect, useState } from 'react';

/** True while the media query matches; follows resizes and rotation. */
export function useMediaQuery(query) {
  const get = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * Copies each .admin-table's column headings onto its cells as data-label,
 * so on phones (see shell.css) every row can be shown as a card with each
 * value labelled. Watches the container for tables that render later;
 * only childList changes are observed, so setting attributes does not
 * trigger it again.
 */
export function useTableLabels(root) {
  useEffect(() => {
    if (!root) return undefined;
    const label = () => {
      for (const table of root.querySelectorAll('table.admin-table')) {
        const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        if (!heads.length) continue;
        for (const row of table.querySelectorAll('tbody tr')) {
          let i = 0;
          for (const cell of row.children) {
            const text = heads[i] || '';
            if (cell.getAttribute('data-label') !== text) cell.setAttribute('data-label', text);
            i += Number(cell.getAttribute('colspan')) || 1;
          }
        }
      }
    };
    label();
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; label(); });
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root]);
}
