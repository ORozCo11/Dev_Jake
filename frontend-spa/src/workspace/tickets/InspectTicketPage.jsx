import { useId, useState } from 'react';
import Icon from '../../components/Icon';
import { CatalogOrOtherField } from '../components/inputs';
import { FormErrorSummary } from '../components/states';
import { ExpandableText, ModulePanel, StatusBadge, TicketStatusBadge } from '../components/ui';
import { useDraftState } from '../hooks/useDraftState';
import { CATALOG_OTHER_VALUE, clearDraftState } from '../lib/formHelpers';
import { formatDate, resolvePhotoUrl } from '../lib/format';

const EMPTY_DRAFT = {
  resultValue: '',
  notes: '',
  category: '',
  // Phase B4 — catalog.create (maintenance types) is Admin-only now, and
  // this Inspect page is Custodian-only (ticket.inspect), so the Category
  // picker below no longer offers CreatableSelect's "+ Add New" — "Other"
  // + this note stands in for it, folded into Inspection Notes on submit.
  categoryOtherNote: '',
  // Root causes are "added" one at a time (type on the left, Add commits it)
  // rather than every row being a permanently-editable input — the
  // confirmed list on the right is plain text with its own Edit/Delete per
  // row, so it's clear which ones are actually locked in vs. still being
  // typed.
  subIssueTitles: [],
};

// `relatedTickets` — the vehicle's other open tickets, shown so a root cause
// that's already being worked on isn't logged a second time.
export function InspectTicketPage({ ticket, relatedTickets = [], onBack, onSubmit, ticketLookups, onDirty }) {
  const id = useId();
  // Kept in this tab so a detour (e.g. opening the vehicle profile) or a
  // reload doesn't wipe a half-written inspection.
  const draftKey = ticket?.ticket_id ? `draft:inspect:${ticket.ticket_id}` : null;
  const [draft, setDraft] = useDraftState(draftKey, () => ({
    ...EMPTY_DRAFT,
    resultValue: ticket?.inspection_result ?? '',
    notes: ticket?.inspection_notes ?? '',
  }));
  const [newRootCause, setNewRootCause] = useState('');
  const [editingIndex, setEditingIndex] = useState(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [errors, setErrors] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!ticket) {
    return (
      <ModulePanel description="This inspection assignment could not be found — it may no longer be assigned to you.">
      </ModulePanel>
    );
  }

  const { resultValue, notes, category, categoryOtherNote, subIssueTitles } = draft;
  const set = (field, value) => { setDraft((d) => ({ ...d, [field]: value })); setReviewing(false); onDirty?.(); };
  const setTitles = (update) => set('subIssueTitles', update(subIssueTitles));

  const commitNewRootCause = () => {
    const title = newRootCause.trim();
    if (!title) return;
    setTitles((rows) => [...rows, title]);
    setNewRootCause('');
  };
  const startEdit = (index) => { setEditingIndex(index); setEditingDraft(subIssueTitles[index]); };
  const cancelEdit = () => setEditingIndex(null);
  const saveEdit = () => {
    const title = editingDraft.trim();
    if (!title) return;
    setTitles((rows) => rows.map((row, i) => (i === editingIndex ? title : row)));
    setEditingIndex(null);
  };
  const removeRow = (index) => {
    setTitles((rows) => rows.filter((_, i) => i !== index));
    if (editingIndex === index) setEditingIndex(null);
  };

  const needsMaintenance = resultValue === 'Needs Maintenance';
  const pendingRootCause = newRootCause.trim();
  // A root cause still sitting in the "type a new one" box (not yet clicked
  // Add) shouldn't be silently lost just because Submit was pressed instead.
  const allTitles = (pendingRootCause ? [...subIssueTitles, pendingRootCause] : subIssueTitles).filter((t) => t.trim());
  const categoryLabel = category === CATALOG_OTHER_VALUE ? `Other — ${categoryOtherNote.trim()}` : (category || 'Not set');
  const vehicleName = ticket.vehicle?.vehicle_name ?? 'the vehicle';
  const report = ticket.issue_report;

  const validate = () => {
    const problems = [];
    if (!resultValue) problems.push('Choose an inspection result.');
    if (needsMaintenance && allTitles.length === 0) problems.push('Add at least one root cause you found.');
    if (needsMaintenance && category === CATALOG_OTHER_VALUE && !categoryOtherNote.trim()) problems.push('Describe the "Other" category.');
    return problems;
  };

  // First press validates and shows the review summary; the actual submit is
  // the confirm button inside that summary.
  const handleReview = (e) => {
    e.preventDefault();
    const problems = validate();
    if (problems.length) { setErrors(problems); setReviewing(false); return; }
    setErrors(null);
    setReviewing(true);
  };

  const handleSubmit = async () => {
    if (submitting) return;
    // Category is "Other" + a typed note instead of a real catalog value —
    // fold the note into Inspection Notes (the one free-text field this
    // form already sends) rather than inventing a new backend field.
    const otherNote = category === CATALOG_OTHER_VALUE ? categoryOtherNote.trim() : '';
    const finalNotes = otherNote ? `${notes ? `${notes}\n` : ''}Other (specified type): ${otherNote}` : notes;
    const payload = { inspection_result: resultValue, inspection_notes: finalNotes };
    if (needsMaintenance) {
      payload.sub_issues = allTitles.map((title) => ({ title: title.trim(), maintenance_type: category || undefined }));
    }
    setSubmitting(true);
    try {
      const ok = await onSubmit(ticket, payload);
      if (ok) clearDraftState(draftKey);
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = () => { clearDraftState(draftKey); onBack(); };

  return (
    <ModulePanel description="Review the vehicle in person and submit your physical inspection findings.">
      <div className="vehicle-profile-header">
        <h3 className="ticket-detail-title" style={{ margin: 0 }}>Inspect Ticket #{ticket.ticket_id}</h3>
        {ticket.priority && <TicketStatusBadge value={ticket.priority} />}
      </div>

      {/* Same rich vehicle-preview card the New Ticket page uses when a
          vehicle is picked — bigger photo (with a proper icon fallback
          instead of just omitting the box), plus type/brand/location, not
          just name and plate — so there's something to actually look at
          here, not just text. */}
      <section className="ticket-section" style={{ marginBottom: 16 }}>
        <h4><Icon name="vehicle" size={14} /> Overview</h4>
        {ticket.ticket_title && <p className="muted" style={{ marginTop: -4, marginBottom: 12 }}>{ticket.ticket_title}</p>}
        <div className="ticket-preview-card" style={{ marginBottom: 12 }}>
          {ticket.vehicle?.photo_url ? (
            <img className="ticket-preview-photo" style={{ width: 140, height: 140 }} src={resolvePhotoUrl(ticket.vehicle.photo_url)} alt={ticket.vehicle.vehicle_name} />
          ) : (
            <span className="ticket-preview-photo ticket-preview-photo-empty" style={{ width: 140, height: 140 }}><Icon name="vehicle" size={48} /></span>
          )}
          <div className="ticket-preview-body">
            <strong>{ticket.vehicle?.vehicle_name}</strong>
            <span>{ticket.vehicle?.plate_number} &middot; {ticket.vehicle?.category?.category_name ?? 'Unclassified'}</span>
            <span className="muted">{[ticket.vehicle?.brand, ticket.vehicle?.model].filter(Boolean).join(' ') || '—'} &middot; {ticket.vehicle?.current_location ?? 'No location on file'}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <StatusBadge value={ticket.vehicle?.status} />
              <StatusBadge value={ticket.vehicle?.condition} />
            </div>
          </div>
        </div>
        <div className="ticket-detail-description-box">
          <span className="ticket-detail-label">Description</span>
          <ExpandableText text={ticket.ticket_description} className="muted" lines={3} />
        </div>
      </section>

      {/* The defect as originally reported — what to look for first. */}
      {report && (
        <section className="inspect-reported" aria-label="Reported problem">
          <h4><Icon name="alert" size={14} /> What was reported</h4>
          <div className="inspect-reported-meta">
            {report.issue_type && <span>{report.issue_type}</span>}
            {report.severity_level && <StatusBadge value={report.severity_level} />}
            {report.created_at && <span className="muted">Reported {formatDate(report.created_at)}</span>}
          </div>
          {report.issue_description && <ExpandableText text={report.issue_description} lines={3} />}
          {report.photo_url && (
            <a className="inspect-reported-photo" href={resolvePhotoUrl(report.photo_url)} target="_blank" rel="noreferrer">
              <img src={resolvePhotoUrl(report.photo_url)} alt={`Photo attached to the issue report for ${vehicleName}`} />
            </a>
          )}
        </section>
      )}

      {relatedTickets.length > 0 && (
        <section className="inspect-related" aria-label="Already open on this vehicle">
          <h4><Icon name="clipboard" size={14} /> Already open on this vehicle</h4>
          <p className="work-hint">Don&apos;t add these again as root causes — they&apos;re being handled on their own ticket.</p>
          <ul>
            {relatedTickets.map((t) => (
              <li key={t.ticket_id}>
                <strong>#{t.ticket_id} {t.ticket_title}</strong>
                {(t.sub_issues ?? []).length > 0 && (
                  <span className="muted"> — {t.sub_issues.map((si) => si.title).join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* One continuous form — Cancel/Submit sit at the very end, after every
          field (including Category/Root Causes), never in the middle. */}
      <form className="smart-form inspection-workspace-form" onSubmit={handleReview} noValidate>
        <FormErrorSummary errors={errors} onDismiss={() => setErrors(null)} />
        {draftKey && (resultValue || notes || subIssueTitles.length > 0) && (
          <p className="work-draft-note"><Icon name="checkCircle" size={14} /> Draft saved on this device.</p>
        )}
        <div className={needsMaintenance ? 'inspect-form-grid' : undefined}>
        <div className="inspect-form-left">
        <label>
          <span>Inspection Result</span>
          <select required value={resultValue} onChange={(e) => set('resultValue', e.target.value)}>
            <option value="">{' '}</option>
            <option value="Needs Maintenance">Needs Maintenance</option>
            <option value="No Issues">No Issues</option>
          </select>
        </label>
        {resultValue && (
          <p className={`inspect-consequence${needsMaintenance ? ' is-warn' : ' is-ok'}`} role="status">
            <Icon name={needsMaintenance ? 'alert' : 'checkCircle'} size={15} />
            {needsMaintenance
              ? `On submit, ${vehicleName} is set to Under Maintenance (Needs Repair) and taken out of dispatch. Each root cause becomes a sub-issue, and the Admin is notified to assign a mechanic.`
              : `On submit, ${vehicleName}'s condition is cleared to Good${ticket.issue_report_id ? ', the issue report that triggered this is marked Resolved' : ''}, and the Admin is notified.`}
          </p>
        )}
        <div className="inspect-notes">
          <label htmlFor={`${id}-notes`} className="work-label">
            Inspection notes <small className="muted">(optional)</small>
          </label>
          <p className="work-hint" id={`${id}-notes-hint`}>What you checked and what you saw — e.g. readings, sounds, leaks, wear.</p>
          <textarea id={`${id}-notes`} rows={3} value={notes} aria-describedby={`${id}-notes-hint`} onChange={(e) => set('notes', e.target.value)} />
        </div>
        </div>

        {needsMaintenance && (
          <div className="inspect-rootcause-card">
            <h4><Icon name="wrench" size={16} /> Root Causes Found</h4>
            <p className="muted">All root causes here belong to the same ticket, so they share one category.</p>

            <label style={{ marginBottom: 16 }}>
              <span>Category</span>
              <CatalogOrOtherField
                value={category}
                onChange={(v) => set('category', v)}
                note={categoryOtherNote}
                onNoteChange={(v) => set('categoryOtherNote', v)}
                options={ticketLookups?.maintenance_types ?? []}
                placeholder="Select a category"
                otherNoteLabel="Describe the issue/type"
              />
            </label>

            <span className="inspect-rootcause-label">Root Causes</span>
            <div className="root-cause-builder">
              <div className="root-cause-input-col">
                <input
                  type="text"
                  aria-label="New root cause"
                  placeholder="Describe a root cause (e.g. low coolant level)"
                  value={newRootCause}
                  onChange={(e) => { setNewRootCause(e.target.value); setReviewing(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitNewRootCause(); } }}
                />
                <button type="button" className="primary-button" onClick={commitNewRootCause} disabled={!newRootCause.trim()}>
                  <Icon name="plus" size={14} /> Add
                </button>
              </div>

              <div className="root-cause-list-col">
                {subIssueTitles.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>No root causes added yet.</p>
                ) : subIssueTitles.map((title, index) => (
                  <div key={index} className="root-cause-list-item">
                    {editingIndex === index ? (
                      <>
                        <input
                          type="text"
                          aria-label={`Edit root cause ${index + 1}`}
                          value={editingDraft}
                          onChange={(e) => setEditingDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } if (e.key === 'Escape') cancelEdit(); }}
                          style={{ flex: 1 }}
                          autoFocus
                        />
                        <button type="button" className="btn-confirm-action icon-btn" onClick={saveEdit} disabled={!editingDraft.trim()} title="Save" aria-label="Save"><Icon name="checkCircle" size={14} /></button>
                        <button type="button" className="btn-delete-action icon-btn" onClick={cancelEdit} title="Cancel edit" aria-label="Cancel edit"><Icon name="close" size={14} /></button>
                      </>
                    ) : (
                      <>
                        <span className="muted" style={{ flex: '0 0 20px', textAlign: 'right' }}>{index + 1}.</span>
                        <span style={{ flex: 1 }}>{title}</span>
                        <button type="button" className="btn-edit-action icon-btn" onClick={() => startEdit(index)} title="Edit root cause" aria-label={`Edit root cause ${index + 1}`}><Icon name="edit" size={14} /></button>
                        <button type="button" className="btn-delete-action icon-btn" onClick={() => removeRow(index)} title="Remove root cause" aria-label={`Remove root cause ${index + 1}`}><Icon name="trash" size={14} /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        </div>

        {reviewing ? (
          <section className="inspect-review-card" aria-labelledby={`${id}-review-title`} role="region">
            <h4 id={`${id}-review-title`}><Icon name="clipboard" size={15} /> Check before submitting</h4>
            <dl>
              <dt>Result</dt>
              <dd><strong>{resultValue}</strong></dd>
              {needsMaintenance && (
                <>
                  <dt>Category</dt>
                  <dd>{categoryLabel}</dd>
                  <dt>Root causes ({allTitles.length})</dt>
                  <dd><ol>{allTitles.map((t, i) => <li key={i}>{t}</li>)}</ol></dd>
                </>
              )}
              <dt>Notes</dt>
              <dd>{notes.trim() || <span className="muted">None</span>}</dd>
            </dl>
            <p className="inspect-review">
              {needsMaintenance
                ? `${vehicleName} will be taken out of dispatch and the Admin will be asked to assign a mechanic.`
                : `${vehicleName} will be cleared to Good condition.`}
            </p>
            <div className="form-actions">
              <button className="ghost-button" type="button" onClick={() => setReviewing(false)} disabled={submitting}>Back to edit</button>
              <button className="primary-button" type="button" onClick={handleSubmit} disabled={submitting} aria-disabled={submitting} autoFocus>
                {submitting ? 'Submitting…' : 'Confirm & submit'}
              </button>
            </div>
          </section>
        ) : (
          <div className="form-actions">
            <button className="ghost-button" onClick={cancel} type="button" disabled={submitting}>Cancel</button>
            <button className="primary-button" type="submit" disabled={submitting}>Review inspection</button>
          </div>
        )}
      </form>
    </ModulePanel>
  );
}
