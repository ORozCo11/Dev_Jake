import { useId, useMemo, useState } from 'react';
import Icon from '../../components/Icon';
import { PassFailChecklist } from '../components/PassFailChecklist';
import { readinessChecklist } from '../lib/fields';

// Pre-dispatch readiness check. Every item must be answered OK / Fail; any
// Fail marks the vehicle NOT ready. A passed check keeps the vehicle
// "verified ready" for 24 hours.
export function ReadinessCheckForm({ vehicle, onCancel, onSubmit }) {
  const formId = useId();
  const items = useMemo(() => readinessChecklist(vehicle), [vehicle]);
  const [results, setResults] = useState(() => items.map((item) => ({ item, passed: null })));
  const [notes, setNotes] = useState('');
  const [attested, setAttested] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const remaining = results.filter((r) => r.passed === null).length;
  const allAnswered = results.length > 0 && remaining === 0;
  const failed = results.filter((r) => r.passed === false);
  const canSubmit = allAnswered && attested && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({ checklist: results.map((r) => ({ item: r.item, passed: r.passed === true })), notes: notes || null });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="readiness-form">
      <p className="readiness-form-intro">
        Physically confirm the vehicle is ready to respond right now — fuelled, equipped and working.
        Any failed item marks it <strong>not ready</strong>. A passed check keeps it verified ready for <strong>24 hours</strong>.
      </p>

      <PassFailChecklist results={results} onChange={setResults} />

      {allAnswered && (
        <div className={`readiness-outcome${failed.length ? ' is-failed' : ' is-ok'}`} role="status">
          <Icon name={failed.length ? 'alert' : 'checkCircle'} size={18} />
          <div>
            <strong>{failed.length ? 'This vehicle will be marked NOT ready to respond' : 'This vehicle will be marked verified ready to respond'}</strong>
            {failed.length > 0 && (
              <ul>
                {failed.map((r) => <li key={r.item}>Failed: {r.item}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      <label className="readiness-notes" htmlFor={`${formId}-notes`}>Notes (optional)</label>
      <textarea id={`${formId}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />

      <label className="readiness-attest">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
        I physically checked {vehicle?.vehicle_name ?? 'this vehicle'} just now.
      </label>

      <div className="readiness-actions">
        {!allAnswered && <p className="readiness-hint">Answer {remaining} more item{remaining === 1 ? '' : 's'} to record the check.</p>}
        {allAnswered && !attested && <p className="readiness-hint">Confirm you checked the vehicle in person.</p>}
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button" onClick={submit} disabled={!canSubmit} aria-disabled={!canSubmit}>
          {submitting ? 'Saving…' : 'Record readiness check'}
        </button>
      </div>
    </div>
  );
}
