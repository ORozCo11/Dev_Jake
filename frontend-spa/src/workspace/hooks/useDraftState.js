import { useEffect, useState } from 'react';

// Keeps an in-progress form's values alive across a route change and back
// (e.g. clicking a vehicle/custodian's name to view their profile, then
// hitting Back) — plain useState resets to its initial value on that round
// trip because the page component fully unmounts and remounts. sessionStorage
// survives that; it only clears itself on an explicit submit/cancel (see
// clearDraftState) or when the tab closes, so an abandoned draft doesn't
// resurrect the next time the same "new X" page is opened fresh.
export function useDraftState(key, initialValue) {
  const [state, setState] = useState(() => {
    const fallback = typeof initialValue === 'function' ? initialValue() : initialValue;
    if (!key) return fallback;
    try {
      const saved = sessionStorage.getItem(key);
      return saved != null ? JSON.parse(saved) : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    if (!key) return;
    try { sessionStorage.setItem(key, JSON.stringify(state)); } catch { /* storage full/unavailable */ }
  }, [key, state]);

  return [state, setState];
}
