import { useCallback, useSyncExternalStore } from 'react';

// True while `query` matches (e.g. '(max-width: 768px)'). Re-renders only
// when the match flips, not on every resize.
export default function useMediaQuery(query) {
  const subscribe = useCallback((onChange) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
