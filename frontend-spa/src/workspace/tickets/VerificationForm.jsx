import { useId, useMemo, useState } from 'react';
import Icon from '../../components/Icon';
import { PassFailChecklist } from '../components/PassFailChecklist';
import { RepairLogEntries } from '../components/ui';
import { functionalTestChecklist } from '../lib/fields';

const peso = (n) => `₱${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// Custodian's check of a mechanic's repair. Shows what was reported and what
// was done BEFORE asking for a verdict; any failed test rejects it back to
// the mechanic (with a required reason), otherwise it goes to the Admin.
export function VerificationForm({ target, onCancel, onSubmit }) {
  const id = useId();
  const checklist = useMemo(() => functionalTestChecklist(target?.vehicle), [target?.vehicle]);
  const [results, setResults] = useState(() => checklist.map((item) => ({ item, passed: null })));
  const [attested, setAttested] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const remaining = results.filter((r) => r.passed === null).length;
  const allAnswered = results.length > 0 && remaining === 0;
  const failed = results.filter((r) => r.passed === false);
  const verdict = failed.length ? 'Rejected' : 'Approved';
  const needsReason = verdict === 'Rejected' && !notes.trim();
  const canSubmit = allAnswered && !submitting && (verdict === 'Rejected' ? !needsReason : attested);
  const mechanic = target?.assigned_mechanic?.name ?? target?.mechanic?.name ?? null;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({
        verification_verdict: verdict,
        verification_notes: notes.trim() || null,
        functional_test: results.map((r) => ({ item: r.item, passed: r.passed === true })),
        test_attested: verdict === 'Approved' ? attested : false,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const hint = !allAnswered
    ? `Answer ${remaining} more test${remaining === 1 ? '' : 's'}.`
    : verdict === 'Rejected' && needsReason
      ? 'Write what failed so the mechanic knows what to redo.'
      : verdict === 'Approved' && !attested
        ? 'Confirm you operated the vehicle yourself.'
        : null;

  return (
    <div className="readiness-form">
      <section className="verify-context" aria-label="Repair to verify">
        <p className="verify-context-row"><span>Reported problem</span><strong>{target?.title ?? '—'}</strong></p>
        {mechanic && <p className="verify-context-row"><span>Repaired by</span><strong>{mechanic}</strong></p>}
        {target?.parts_used && <p className="verify-context-row"><span>Parts used</span><strong>{target.parts_used}</strong></p>}
        {Number(target?.maintenance_cost) > 0 && <p className="verify-context-row"><span>Recorded cost</span><strong>{peso(target.maintenance_cost)}</strong></p>}
        {target?.repair_logs && (
          <details className="work-context-logs" open>
            <summary>Mechanic&apos;s repair log</summary>
            <RepairLogEntries text={target.repair_logs} />
          </details>
        )}
      </section>

      <p className="readiness-form-intro">
        Operate the vehicle and mark each test. A repair is accepted only once it actually works — any failed test sends it back to the mechanic.
      </p>

      <PassFailChecklist
        results={results}
        onChange={setResults}
        passLabel="Pass"
        allLabel="Mark all as Pass"
        addPlaceholder="Add a custom test…"
        itemNoun="test"
      />

      {allAnswered && (
        <div className={`readiness-outcome${failed.length ? ' is-failed' : ' is-ok'}`} role="status">
          <Icon name={failed.length ? 'alert' : 'checkCircle'} size={18} />
          <div>
            <strong>{failed.length ? 'This repair will be REJECTED and sent back to the mechanic' : 'This repair will be APPROVED and sent to the Admin to confirm'}</strong>
            {failed.length > 0 && <ul>{failed.map((r) => <li key={r.item}>Failed: {r.item}</li>)}</ul>}
          </div>
        </div>
      )}

      {verdict === 'Approved' && (
        <label className="readiness-attest">
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
          <span>I <strong>personally operated and tested</strong> this vehicle — not a paperwork-only sign-off.</span>
        </label>
      )}

      <label className="readiness-notes" htmlFor={`${id}-notes`}>
        {verdict === 'Rejected' ? <>What failed / needs redoing <abbr className="required-asterisk" title="required">*</abbr></> : 'Notes (optional)'}
      </label>
      <textarea
        id={`${id}-notes`}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        aria-invalid={allAnswered && needsReason ? 'true' : undefined}
      />

      <div className="readiness-actions">
        {hint && <p className="readiness-hint">{hint}</p>}
        <button type="button" className="ghost-button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="button" className={failed.length ? 'danger-button' : 'primary-button'} onClick={submit} disabled={!canSubmit} aria-disabled={!canSubmit}>
          {submitting ? 'Submitting…' : failed.length ? 'Reject & send back' : 'Approve repair'}
        </button>
      </div>
    </div>
  );
}
