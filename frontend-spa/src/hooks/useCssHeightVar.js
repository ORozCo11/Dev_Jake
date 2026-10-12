import { useLayoutEffect } from 'react';

// Publishes an element's live height as a CSS custom property on <html>
// (e.g. --topbar-height), so layout that offsets around a fixed header stays
// right when the header wraps to two rows on a phone.
export default function useCssHeightVar(ref, name) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const root = document.documentElement;
    const update = () => root.style.setProperty(name, `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(name);
    };
  }, [ref, name]);
}
