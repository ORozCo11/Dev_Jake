import { useEffect, useState } from 'react';
import useDepsChanged from '../../hooks/useDepsChanged';

// Persists which columns a table shows and in what order, per browser (one
// localStorage entry per `storageKey`, so e.g. Vehicle Management's choices
// don't bleed into a different table reusing this same hook later).
// `allColumns` must be a stable array of {key, label, locked?, ...} — `key`
// is the identity persisted to storage, `locked` (e.g. ID/Action) hides the
// checkbox instead of letting a table lose its own row identifier or
// actions. Returns the already order-applied, hidden-filtered array to pass
// straight into DataTable/PaginatedTable's `columns` prop.
export function useColumnChooser(storageKey, allColumns) {
  const columnKeys = allColumns.map((c) => c.key);
  // Stable change-detection key — a plain array literal would be a new
  // reference every render even when unchanged.
  const columnKeysSignature = columnKeys.join('|');

  const [order, setOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}_order`) ?? 'null');
      if (Array.isArray(saved) && saved.length) {
        const stillValid = saved.filter((k) => columnKeys.includes(k));
        const newOnes = columnKeys.filter((k) => !stillValid.includes(k));
        return [...stillValid, ...newOnes];
      }
    } catch { /* fall through to default order */ }
    return columnKeys;
  });
  const [hidden, setHidden] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}_hidden`) ?? '[]');
      return new Set(Array.isArray(saved) ? saved.filter((k) => columnKeys.includes(k)) : []);
    } catch {
      return new Set();
    }
  });

  // Keeps a saved preference from a previous session in sync if the column
  // set itself changes shape later (e.g. the role-gated Action column
  // appearing/disappearing) — drops keys that no longer exist, appends any
  // new ones at the end rather than silently hiding them.
  if (useDepsChanged([columnKeysSignature])) {
    setOrder((prev) => {
      const stillValid = prev.filter((k) => columnKeys.includes(k));
      const newOnes = columnKeys.filter((k) => !stillValid.includes(k));
      return newOnes.length || stillValid.length !== prev.length ? [...stillValid, ...newOnes] : prev;
    });
    setHidden((prev) => {
      const next = new Set([...prev].filter((k) => columnKeys.includes(k)));
      return next.size === prev.size ? prev : next;
    });
  }

  useEffect(() => {
    try { localStorage.setItem(`${storageKey}_order`, JSON.stringify(order)); } catch { /* storage unavailable */ }
  }, [storageKey, order]);
  useEffect(() => {
    try { localStorage.setItem(`${storageKey}_hidden`, JSON.stringify([...hidden])); } catch { /* storage unavailable */ }
  }, [storageKey, hidden]);

  const toggleColumn = (key) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  // `side` ('before' | 'after') lets the table header's own drag handler
  // place a column on whichever side of the drop target the cursor was
  // actually over (matching the drop-line indicator DataTable draws there)
  // — the popover's simpler row list never passes it, so it keeps its
  // original "insert at the target's position" behavior.
  const reorderColumn = (dragKey, dropKey, side = 'before') => {
    if (dragKey === dropKey) return;
    setOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(dragKey);
      if (from === -1) return prev;
      next.splice(from, 1);
      let to = next.indexOf(dropKey);
      if (to === -1) return prev;
      if (side === 'after') to += 1;
      next.splice(to, 0, dragKey);
      return next;
    });
  };
  const resetColumns = () => {
    setOrder(columnKeys);
    setHidden(new Set());
  };

  const byKey = new Map(allColumns.map((c) => [c.key, c]));
  const visibleColumns = order.map((k) => byKey.get(k)).filter((c) => c && !hidden.has(c.key));

  return { allColumns, order, hidden, toggleColumn, reorderColumn, resetColumns, visibleColumns };
}
