import { useId, useState } from 'react';
import Icon from '../../components/Icon';

// The fit-for-service call made when a ticket is closed. It used to be
// implicit (a plain "Close Ticket" silently returned the vehicle to service);
// now the Admin must pick one, with what each choice does spelled out.
export function ReturnToServiceStep({ vehicleName = 'the vehicle', hasIssueReport = false, onCancel, onConfirm }) {
  const id = useId();
  const [fit, setFit] = useState(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const confirm = async () => {
    if (fit === null || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm({ returned_to_service: fit, closing_notes: notes.trim() || undefined });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <fieldset className="rts-step">
      <legend className="rts-title"><Icon name="flag" size={16} /> Is {vehicleName} fit to return to service?</legend>
      <label className={`rts-option${fit === true ? ' is-selected' : ''}`}>
        <input type="radio" name={`${id}-fit`} checked={fit === true} onChange={() => setFit(true)} />
        <span>
          <strong>Yes — fit for service</strong>
          <small>
            It becomes Available again (unless something else still holds it){hasIssueReport ? ' and the issue report is marked Resolved' : ''}.
            Run a readiness check before dispatching it.
          </small>
        </span>
      </label>
      <label className={`rts-option is-danger${fit === false ? ' is-selected' : ''}`}>
        <input type="radio" name={`${id}-fit`} checked={fit === false} onChange={() => setFit(false)} />
        <span>
          <strong>No — keep it out of service</strong>
          <small>
            The ticket closes, but the vehicle stays Under Maintenance (Needs Repair) and can&apos;t be dispatched
            {hasIssueReport ? '; the issue report goes back to Pending for a new ticket' : ''}.
          </small>
        </span>
      </label>
      <label className="readiness-notes" htmlFor={`${id}-notes`}>Closing notes (optional)</label>
      <textarea id={`${id}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="readiness-actions">
        {fit === null && <p className="readiness-hint">Choose whether the vehicle is fit for service.</p>}
        <button type="button" className="ghost-button" onClick={onCancel} disabled={submitting}>Back</button>
        <button type="button" className="primary-button" onClick={confirm} disabled={fit === null || submitting} aria-disabled={fit === null || submitting}>
          {submitting ? 'Closing…' : 'Close ticket'}
        </button>
      </div>
    </fieldset>
  );
}
