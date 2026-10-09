import { useId, useState } from 'react';
import Icon from '../../components/Icon';

// Pre-dispatch readiness confirmation. Simplified per product direction: a
// plain attestation, not a checklist — if something is actually wrong, the
// Custodian proposes a maintenance ticket instead of confirming readiness.
// The backend (FleetController::storeReadinessCheck) requires `confirmed`
// and keeps the vehicle verified ready for 24 hours.
export function ReadinessCheckForm({ vehicle, onCancel, onSubmit }) {
  const formId = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const vehicleName = vehicle?.vehicle_name ?? 'this vehicle';
  const canSubmit = confirmed && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({ confirmed: true, notes: notes.trim() || null });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="readiness-form">
      <p className="readiness-form-intro">
        Confirm {vehicleName} is ready to respond right now — fuelled, equipped and working.
        A confirmation keeps it verified ready for <strong>24 hours</strong>.
      </p>

      <p className="readiness-hint" role="note">
        <Icon name="alert" size={14} /> Found a problem? Don&apos;t confirm — propose a maintenance ticket instead.
      </p>

      <label className="readiness-attest">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>I <strong>personally checked and operated</strong> {vehicleName} and it is ready to respond.</span>
      </label>

      <label className="readiness-notes" htmlFor={`${formId}-notes`}>Notes (optional)</label>
      <textarea id={`${formId}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />

      <div className="readiness-actions">
        {!confirmed && <p className="readiness-hint">Tick the confirmation to record the check.</p>}
        <button type="button" className="ghost-button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="button" className="primary-button" onClick={submit} disabled={!canSubmit} aria-disabled={!canSubmit}>
          {submitting ? 'Saving…' : 'Confirm ready'}
        </button>
      </div>
    </div>
  );
}
