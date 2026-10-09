import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../../components/Icon';
import useDialogA11y from '../../hooks/useDialogA11y';

// The one modal dialog shell: portal + overlay + titled box, with focus trap,
// Escape-to-close and focus restore (see useDialogA11y). Keeps the existing
// .modal-overlay / .modal-box / .modal-header / .modal-body classes, so
// screens moved onto it look exactly as before.
//
// `headerExtra` renders between the title and the close button (e.g. a
// toolbar); `beforeBody` renders above the scrolling body (e.g. a notice).
export default function Modal({
  title,
  onClose,
  children,
  wide = false,
  className = '',
  bodyClassName = '',
  boxStyle,
  headerExtra,
  beforeBody,
  closeOnOverlay = true,
  closeOnEscape = true,
  initialFocusRef,
  ariaLabel,
}) {
  const boxRef = useRef(null);
  const titleId = useId();
  useDialogA11y(boxRef, { onClose, initialFocusRef, closeOnEscape });

  return createPortal(
    <div className="modal-overlay" onClick={closeOnOverlay ? onClose : undefined}>
      <div
        ref={boxRef}
        className={['modal-box', wide ? 'modal-box-wide' : '', className].filter(Boolean).join(' ')}
        style={boxStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          {title && <h3 id={titleId}>{title}</h3>}
          {headerExtra}
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close dialog">
            <Icon name="close" size={18} />
          </button>
        </div>
        {beforeBody}
        <div className={['modal-body', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
