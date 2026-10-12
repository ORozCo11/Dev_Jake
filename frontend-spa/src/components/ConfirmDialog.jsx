// Shared styled confirmation modal — used anywhere a consequential action
// (deactivate, delete, impersonate, regenerate a code, discard unsaved
// changes...) needs a yes/no gate, instead of the browser's own native
// window.confirm(). `dialog` is null when closed; set it to
// { title?, message, confirmLabel?, variant?: 'primary', onConfirm } to open.
import { useId, useRef } from 'react';
import useDialogA11y from '../hooks/useDialogA11y';
import Icon from './Icon';

export default function ConfirmDialog({ busy, dialog, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();
  const messageId = useId();

  // Focus starts on Cancel — the safe choice for a consequential action.
  useDialogA11y(dialogRef, { open: Boolean(dialog), onClose: onCancel, initialFocusRef: cancelRef, closeOnEscape: !busy });

  if (!dialog) return null;

  return (
    <div className="confirm-overlay" onClick={busy ? undefined : onCancel}>
      <section
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={messageId}
        aria-modal="true"
        className="confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
        tabIndex={-1}
      >
        <div className="confirm-dialog-icon" aria-hidden="true">
          <Icon name="alert" size={24} strokeWidth={2.2} />
        </div>
        <div className="confirm-dialog-copy">
          <p className="eyebrow">Confirmation</p>
          <h3 id={titleId}>{dialog.title ?? 'Confirm Action'}</h3>
          <p id={messageId}>{dialog.message}</p>
        </div>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} className="ghost-button" disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className={dialog.variant === 'primary' ? 'primary-button' : 'danger-button'}
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? 'Working...' : dialog.confirmLabel ?? 'Continue'}
          </button>
        </div>
      </section>
    </div>
  );
}
