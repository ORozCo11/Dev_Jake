import { useEffect, useEffectEvent } from 'react';

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Open dialogs, innermost last — only the top one reacts to Escape/Tab, so a
// confirm dialog opened over a form modal doesn't close both at once.
const stack = [];

function focusableIn(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

// Modal dialog behaviour (WAI-ARIA APG "Dialog (Modal)"):
// - moves focus into the dialog when it opens (`initialFocusRef`, else the
//   first field/button, else the dialog itself),
// - keeps Tab / Shift+Tab inside it,
// - closes on Escape (unless `closeOnEscape` is false, e.g. while saving),
// - returns focus to whatever opened it once it closes.
// `ref` must point at the element carrying role="dialog" (give it tabIndex={-1}).
export default function useDialogA11y(ref, { open = true, onClose, initialFocusRef, closeOnEscape = true } = {}) {
  const requestClose = useEffectEvent(() => {
    if (closeOnEscape) onClose?.();
  });

  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return undefined;

    const previouslyFocused = document.activeElement;
    stack.push(node);

    const target = initialFocusRef?.current
      ?? node.querySelector('[autofocus]')
      ?? focusableIn(node).find((el) => !el.classList.contains('modal-close-btn'))
      ?? node;
    target.focus({ preventScroll: true });

    const handleKeyDown = (event) => {
      if (stack.at(-1) !== node) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableIn(node);
      if (!focusable.length) { event.preventDefault(); node.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!node.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const i = stack.lastIndexOf(node);
      if (i !== -1) stack.splice(i, 1);
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
    // initialFocusRef is a ref object (stable); only open/close re-runs this.
  }, [open, ref, initialFocusRef]);
}
