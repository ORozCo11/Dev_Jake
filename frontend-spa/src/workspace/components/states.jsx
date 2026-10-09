import { useEffect, useRef } from 'react';
import Icon from '../../components/Icon';

// Shared "nothing here" and "couldn't load" panels, so every module explains
// what happened and what to do next in the same way.

export function EmptyState({ icon = 'clipboard', title, description, action }) {
  return (
    <div className="state-panel" role="status">
      <span className="state-panel-icon" aria-hidden="true"><Icon name={icon} size={22} /></span>
      {title && <p className="state-panel-title">{title}</p>}
      {description && <p className="state-panel-text">{description}</p>}
      {action}
    </div>
  );
}

// `error` is an axios error (or anything with a message). Network failures
// get offline wording; 403s say it's a permission problem, not a bug.
export function ErrorState({ error, title, onRetry }) {
  const status = error?.response?.status;
  const offline = !status && (error?.code === 'ERR_NETWORK' || error?.message === 'Network Error' || (typeof navigator !== 'undefined' && navigator.onLine === false));
  const heading = title
    ?? (offline ? "Can't reach the server" : status === 403 ? "You don't have access to this" : "This couldn't be loaded");
  const text = offline
    ? 'Check your connection, then try again. Nothing you entered was lost.'
    : status === 403
      ? 'Your account role does not include this section. Ask your barangay Admin if you need it.'
      : error?.response?.data?.message || 'Something went wrong on our side. Try again in a moment.';
  return (
    <div className="state-panel is-error" role="alert">
      <span className="state-panel-icon" aria-hidden="true"><Icon name="alert" size={22} /></span>
      <p className="state-panel-title">{heading}</p>
      <p className="state-panel-text">{text}</p>
      {onRetry && status !== 403 && (
        <button type="button" className="primary-button" onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}

// Inline "fix these before saving" panel for hand-built forms (SmartForm has
// its own, field-linked version). Scrolls itself into view and takes focus
// when it appears, so keyboard and screen-reader users land on it too.
export function FormErrorSummary({ errors, onDismiss }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!errors?.length) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [errors]);
  if (!errors?.length) return null;
  return (
    <div ref={ref} className="form-error-summary" role="alert" tabIndex={-1}>
      <p className="form-error-summary-title">
        <Icon name="alert" size={16} />
        {errors.length === 1 ? 'Fix this before submitting:' : `Fix these ${errors.length} things before submitting:`}
      </p>
      <ul>
        {errors.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
      {onDismiss && (
        <button type="button" className="form-error-summary-dismiss" onClick={onDismiss} aria-label="Dismiss these messages">
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
