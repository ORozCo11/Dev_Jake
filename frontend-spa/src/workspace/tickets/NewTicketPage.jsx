import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import Icon from '../../components/Icon';
import { CreatableSelect, DateFilterInput } from '../components/inputs';
import { ModulePanel, SubmitLoadingOverlay, UserAvatarName } from '../components/ui';
import { useDraftState } from '../hooks/useDraftState';
import { ENTRY_MODE_OPTIONS } from '../lib/fields';
import { clearDraftState } from '../lib/formHelpers';
import { EMPTY_ARR, formatDate, resolvePhotoUrl } from '../lib/format';
import { FormErrorSummary } from '../components/states';

export function NewTicketPage({ onBack, ticketLookups, prefilledTicketData, onCreateTicket, basePath, onDirty }) {
  // Stable across re-renders (only changes if prefilledTicketData itself
  // changes) — resetting on every render would wipe out whatever the user
  // already typed.
  const initialTicketValues = useMemo(() => {
    const base = { entry_mode: 'inspection', ...(prefilledTicketData ?? {}) };
    // 'prediagnosed' no longer exists as its own entry mode — the issue is
    // known (carried over from an Issue Report/Condition Check) but WHICH
    // repair type applies isn't, so leave the toggle unselected instead of
    // guessing one, forcing an explicit pick before submit.
    if (base.entry_mode === 'prediagnosed') base.entry_mode = null;
    return base;
  }, [prefilledTicketData]);
  // Scoped to whichever Issue Report/Condition Check (if any) this ticket is
  // being created from — a fresh "New Ticket" with no prefill, or one from a
  // different source, gets its own key instead of resurrecting an unrelated
  // abandoned draft. Persisted to sessionStorage (not just useState) so
  // clicking a vehicle/custodian link to view their profile, then Back,
  // doesn't wipe out everything already typed here — see useDraftState.
  const draftKeyBase = `draft:new-ticket:${prefilledTicketData?.issue_report_id ?? prefilledTicketData?.condition_check_id ?? 'blank'}`;
  const [liveValues, setLiveValues] = useDraftState(`${draftKeyBase}:values`, initialTicketValues);
  const [subIssueRows, setSubIssueRows] = useDraftState(`${draftKeyBase}:sub-issues`, () => {
    const seeded = (prefilledTicketData?.sub_issues_text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    return seeded.length ? seeded : [''];
  });
  // Captured once here, up front — same reasoning as the Custodian's
  // inspection form: "pre-diagnosed" means the Admin already knows what
  // kind of repair this is, so asking again when a mechanic gets assigned
  // later would just be re-asking something already known.
  const [subIssueCategory, setSubIssueCategory] = useDraftState(`${draftKeyBase}:maintenance-type`, () => '');
  const clearNewTicketDraft = () => {
    clearDraftState(`${draftKeyBase}:values`);
    clearDraftState(`${draftKeyBase}:sub-issues`);
    clearDraftState(`${draftKeyBase}:maintenance-type`);
  };
  const [submitting, setSubmitting] = useState(false);
  const [validationLines, setValidationLines] = useState(null);
  const selectedVehicleId = liveValues.vehicle_id ?? null;
  const [openTicketsResult, setOpenTicketsOnVehicle] = useState([]);
  const openTicketsOnVehicle = selectedVehicleId ? openTicketsResult : EMPTY_ARR;
  // Same reasoning as the open-tickets check above, for recurrence instead of
  // duplicates: this used to only ever reach Admin in a notification sent
  // AFTER the ticket was created — too late to change the decision. Checking
  // it here means "this fault came back a 3rd time" is visible while Admin is
  // still choosing, not after.
  const [recurrenceResult, setRecurrence] = useState(null);
  const recurrenceTitle = (liveValues.ticket_title ?? '').trim();
  const recurrence = selectedVehicleId && recurrenceTitle ? recurrenceResult : null;

  useEffect(() => {
    if (!selectedVehicleId) return undefined;
    let cancelled = false;
    api.get(`/vehicles/${selectedVehicleId}/open-tickets`)
      .then((response) => { if (!cancelled) setOpenTicketsOnVehicle(response.data); })
      .catch(() => { if (!cancelled) setOpenTicketsOnVehicle([]); });
    return () => { cancelled = true; };
  }, [selectedVehicleId]);

  useEffect(() => {
    if (!selectedVehicleId || !recurrenceTitle) return undefined;
    let cancelled = false;
    api.get(`/vehicles/${selectedVehicleId}/recurrence`, { params: { maintenance_types: subIssueCategory ? [subIssueCategory] : undefined, title: recurrenceTitle } })
      .then((r) => { if (!cancelled) setRecurrence(r.data); })
      .catch(() => { if (!cancelled) setRecurrence(null); });
    return () => { cancelled = true; };
  }, [selectedVehicleId, subIssueCategory, recurrenceTitle]);

  const setField = (name, value) => { setLiveValues((v) => ({ ...v, [name]: value })); onDirty?.(); };
  // Any repair-type-specific entry mode means the issue (and how it'll be
  // fixed) is already known — 'inspection' is the only mode where it isn't,
  // and a null/unset mode (only reachable via the legacy prefill case above)
  // means the choice hasn't been made yet.
  const preDiagnosed = Boolean(liveValues.entry_mode) && liveValues.entry_mode !== 'inspection';
  const isCannibalized = liveValues.entry_mode === 'cannibalized';
  const isExternal = liveValues.entry_mode === 'external';
  // Cannibalized/External each carry ONE shared context value (a single
  // donor vehicle, or a single vendor+warranty) for every sub-issue on the
  // ticket — a multi-item list would wrongly imply several distinct
  // problems all used the same donor part or went to the same shop visit,
  // when in practice each would need its own. In-House has no such
  // per-ticket constraint, so a real list of independently assignable
  // problems still makes sense there.
  const isSingleIssueMode = isCannibalized || isExternal;

  // Same add/remove list pattern as Root Causes on the Inspect Ticket page —
  // one consistent way to build a list of findings anywhere in the app,
  // instead of a free-text "one per line" box.
  const updateSubIssue = (index, value) => { setSubIssueRows((rows) => rows.map((r, i) => (i === index ? value : r))); onDirty?.(); };
  const addSubIssueRow = () => setSubIssueRows((rows) => [...rows, '']);
  const removeSubIssueRow = (index) => setSubIssueRows((rows) => rows.filter((_, i) => i !== index));
  // Switching INTO Cannibalized/External drops any extra rows already
  // typed under In-House — those modes only ever submit one sub-issue (see
  // isSingleIssueMode above), so a leftover second/third row would just be
  // silently discarded on submit otherwise.
  const selectEntryMode = (value) => {
    setField('entry_mode', value);
    if (value === 'cannibalized' || value === 'external') {
      setSubIssueRows((rows) => rows.slice(0, 1));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // The submit button used to just stay disabled until every required
    // field (entry mode included) was filled — silent and easy to miss,
    // especially "How Is This Being Reported?", which isn't a native form
    // control the browser could nudge about on its own. Clicking now
    // always works; a toast spells out exactly what's still needed instead.
    const errors = [];
    if (!liveValues.entry_mode) errors.push('Pick how this is being reported, above.');
    if (!liveValues.vehicle_id) errors.push('Vehicle is required.');
    if (!liveValues.assigned_custodian_id) errors.push('Assign to Custodian is required.');
    if (!(liveValues.ticket_title ?? '').trim()) errors.push('Ticket Title is required.');
    if (!(liveValues.ticket_description ?? '').trim()) errors.push('Details is required.');
    if (!liveValues.priority) errors.push('Priority is required.');
    if (preDiagnosed && !subIssueRows.some((row) => row.trim())) {
      errors.push(`At least one ${isSingleIssueMode ? 'issue' : 'sub-issue'} is required.`);
    }
    if (isCannibalized && !liveValues.source_vehicle_id) errors.push('Source Vehicle is required.');
    if (errors.length) {
      setValidationLines(errors);
      return;
    }

    setSubmitting(true);
    try {
      const out = {
        vehicle_id: liveValues.vehicle_id,
        assigned_custodian_id: liveValues.assigned_custodian_id,
        ticket_title: liveValues.ticket_title,
        ticket_description: liveValues.ticket_description,
        priority: liveValues.priority,
        entry_mode: liveValues.entry_mode,
        issue_report_id: prefilledTicketData?.issue_report_id,
        condition_check_id: prefilledTicketData?.condition_check_id,
      };
      if (preDiagnosed) {
        out.sub_issues = subIssueRows.map((t) => t.trim()).filter(Boolean).map((title) => ({ title, maintenance_type: subIssueCategory || null }));
        if (isCannibalized) out.source_vehicle_id = liveValues.source_vehicle_id;
        if (isExternal) {
          out.external_vendor = liveValues.external_vendor || undefined;
          out.warranty_until = liveValues.warranty_until || undefined;
        }
      }
      const created = await onCreateTicket(out);
      if (created) { clearNewTicketDraft(); onBack(); }
    } finally {
      setSubmitting(false);
    }
  };

  const vehicleOptions = (ticketLookups.vehicles ?? []).filter((v) => v.status !== 'Inactive' && v.status !== 'Decommissioned');
  const custodianOptions = ticketLookups.custodians ?? [];
  const priorityOptions = ticketLookups.priorities ?? [];
  const selectedVehicle = vehicleOptions.find((v) => String(v.vehicle_id) === String(liveValues.vehicle_id)) ?? null;
  const selectedCustodian = custodianOptions.find((c) => String(c.id) === String(liveValues.assigned_custodian_id)) ?? null;
  // Can't cannibalize a part from the same vehicle the ticket is for.
  const sourceVehicleOptions = vehicleOptions.filter((v) => String(v.vehicle_id) !== String(liveValues.vehicle_id));

  return (
    <ModulePanel description="Create a new maintenance ticket and assign it to a custodian.">
      {prefilledTicketData?.issue_report_id && (
        <div className="info-callout" style={{ marginBottom: '16px', background: 'rgba(59, 130, 246, 0.1)', borderColor: '#3b82f6' }}>
          <span style={{ marginRight: '8px', color: '#3b82f6', display: 'inline-flex' }}><Icon name="link" size={16} /></span>
          <p className="module-description" style={{ color: '#3b82f6', margin: 0 }}>
            Linking this ticket to <strong>Issue Report #{prefilledTicketData.issue_report_id}</strong>.
          </p>
        </div>
      )}
      {/* Layer 2 duplicate-prevention aid — title-matching alone can't tell
          "Brake Problem" and "Brakes Squeaking" are the same real issue, so
          surface every OTHER open ticket on this vehicle and let the Admin
          judge for themselves. Non-blocking — a vehicle can legitimately
          have two different problems open at once. */}
      {openTicketsOnVehicle.length > 0 && (
        <div className="info-callout" style={{ marginBottom: '16px', background: 'rgba(245, 158, 11, 0.1)', borderColor: '#f59e0b' }}>
          <span style={{ marginRight: '8px', color: '#b45309', display: 'inline-flex', flexShrink: 0 }}><Icon name="alert" size={16} /></span>
          <div>
            <p className="module-description" style={{ color: '#b45309', margin: '0 0 6px', fontWeight: 600 }}>
              This vehicle already has {openTicketsOnVehicle.length} open ticket{openTicketsOnVehicle.length !== 1 ? 's' : ''} — check it isn't the same problem before creating a new one:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {openTicketsOnVehicle.map((t) => (
                <li key={t.ticket_id} style={{ fontSize: '0.85rem', color: '#92400e', display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none', marginLeft: -18 }}>
                  <span>&bull;</span>
                  <span style={{ flex: 1 }}>#{t.ticket_id} "{t.ticket_title}" — {t.status}</span>
                  {/* Opens in a new tab — the Admin is mid-way through this
                      Create Ticket form and shouldn't lose it just to check
                      whether this is the same problem. */}
                  <a
                    href={`${basePath}/tickets/${t.ticket_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.8rem', fontWeight: 600, color: '#b45309', textDecoration: 'underline', whiteSpace: 'nowrap' }}
                  >
                    View <Icon name="link" size={11} style={{ verticalAlign: 'middle' }} />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {recurrence && recurrence.count > 0 && (
        <div className="info-callout" style={{ marginBottom: '16px', background: 'rgba(194, 65, 12, 0.1)', borderColor: '#c2410c' }}>
          <span style={{ marginRight: '8px', color: '#c2410c', display: 'inline-flex', flexShrink: 0 }}><Icon name="undo" size={16} /></span>
          <p className="module-description" style={{ color: '#c2410c', margin: 0 }}>
            <strong>This is the {recurrence.count + 1}{['st', 'nd', 'rd'][recurrence.count] ?? 'th'} time</strong> this fault has come up on this vehicle in the last 90 days
            {recurrence.last_occurred && (
              <> — last fixed via {recurrence.last_type === 'record' ? 'Maintenance Record' : 'Ticket'} #{recurrence.last_id} on {formatDate(recurrence.last_occurred)}</>
            )}
            . Worth considering a deeper fix or a decommission review instead of another routine repair.
          </p>
        </div>
      )}

      {/* Hand-built (not the generic field-array SmartForm) so the layout can
          be grouped into clear sections instead of one long vertical list of
          full-width dropdowns — same reasoning as Inspect Ticket's own
          hand-built form. Reuses the .smart-form input/label styling so
          every field still looks consistent with the rest of the app. */}
      <form className="smart-form ticket-create-form" onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FormErrorSummary errors={validationLines} onDismiss={() => setValidationLines(null)} />

        {/* Entry mode comes first, not last — it decides what the rest of
            the form even asks for, so it shouldn't be buried at the bottom.
            Repair Type used to only exist on the separate Maintenance Record
            form; it's folded in here now instead of asking for it twice —
            "Pre-Diagnosed" as a generic option is gone, since picking a
            specific repair type already implies the issue is diagnosed. */}
        <section className="veh-card">
          <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>How Is This Being Reported?</h4></div>
          <div style={{ padding: 18 }}>
            <div className="entry-mode-toggle" role="radiogroup" aria-label="Entry mode">
              {ENTRY_MODE_OPTIONS.map((opt) => {
                const checked = liveValues.entry_mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    className={`entry-mode-btn entry-mode-btn--${opt.value} ${checked ? 'primary-button' : 'ghost-button'}`}
                    onClick={() => selectEntryMode(opt.value)}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="muted" style={{ margin: '10px 0 0', fontSize: '0.82rem' }}>
              {liveValues.entry_mode == null
                ? 'Pick whichever matches what you already know about this repair.'
                : preDiagnosed
                  ? 'The problem (and how it will be fixed) is already known — this skips straight to a mechanic, no custodian inspection needed.'
                  : "Nobody has confirmed what's wrong yet — the assigned custodian will inspect the vehicle first."}
            </p>
            {isCannibalized && (
              <label style={{ marginTop: 12, maxWidth: 320 }}>
                <span>Source Vehicle (donor) <span className="required-asterisk">*</span></span>
                <select
                  required
                  value={liveValues.source_vehicle_id ?? ''}
                  onChange={(e) => setField('source_vehicle_id', e.target.value)}
                >
                  <option value="">{' '}</option>
                  {sourceVehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
                </select>
              </label>
            )}
            {/* Neither field is required here — the vendor may not be
                picked yet, and there's no warranty to record until the
                repair is actually done. Both stay editable later at Log
                Repairs, once that's known for sure. */}
            {isExternal && (
              <div className="ticket-form-grid-2" style={{ padding: 0, marginTop: 12, maxWidth: 500 }}>
                <label>
                  <span>External Shop Name</span>
                  <input
                    type="text"
                    placeholder="e.g. Dela Cruz Auto Repair"
                    value={liveValues.external_vendor ?? ''}
                    onChange={(e) => setField('external_vendor', e.target.value)}
                  />
                </label>
                <label>
                  <span>Warranty Until</span>
                  <DateFilterInput
                    value={liveValues.warranty_until ?? ''}
                    onChange={(v) => setField('warranty_until', v)}
                  />
                </label>
              </div>
            )}
          </div>
        </section>

        <section className="veh-card">
          <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicle & Assignment</h4></div>
          <div className="ticket-form-grid-2">
            <label>
              <span>Vehicle <span className="required-asterisk">*</span></span>
              <select required value={liveValues.vehicle_id ?? ''} onChange={(e) => setField('vehicle_id', e.target.value)}>
                <option value="">{' '}</option>
                {vehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </select>
            </label>
            <label>
              <span>
                Assign to Custodian ({isExternal ? 'checks the vehicle when it returns' : 'verifies the repair later'})
                {' '}<span className="required-asterisk">*</span>
              </span>
              <select required value={liveValues.assigned_custodian_id ?? ''} onChange={(e) => setField('assigned_custodian_id', e.target.value)}>
                <option value="">{' '}</option>
                {custodianOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          {(selectedVehicle || selectedCustodian) && (
            <div className="ticket-selection-preview">
              {selectedVehicle && (
                <div className="ticket-preview-card">
                  {selectedVehicle.photo_url ? (
                    <img className="ticket-preview-photo" src={resolvePhotoUrl(selectedVehicle.photo_url)} alt={selectedVehicle.vehicle_name} />
                  ) : (
                    <span className="ticket-preview-photo ticket-preview-photo-empty"><Icon name="vehicle" size={32} /></span>
                  )}
                  <div className="ticket-preview-body">
                    <strong>{selectedVehicle.vehicle_name}</strong>
                    <span>{selectedVehicle.plate_number} &middot; {selectedVehicle.category?.category_name ?? 'Unclassified'}</span>
                    <span className="muted">{[selectedVehicle.brand, selectedVehicle.model].filter(Boolean).join(' ') || '—'} &middot; {selectedVehicle.current_location ?? 'No location on file'}</span>
                  </div>
                </div>
              )}
              {selectedCustodian && (
                <div className="ticket-preview-card">
                  <UserAvatarName user={selectedCustodian} />
                  <div className="ticket-preview-body">
                    <span className="muted">Custodian &middot; {selectedCustodian.email}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="alert" size={16} /><h4>Issue Details</h4></div>
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="ticket-form-grid-2" style={{ padding: 0 }}>
              <label style={{ gridColumn: '1 / -1' }}>
                <span>Ticket Title <span className="required-asterisk">*</span></span>
                <input required type="text" value={liveValues.ticket_title ?? ''} onChange={(e) => setField('ticket_title', e.target.value)} />
              </label>
            </div>
            <label>
              <span>Details <span className="required-asterisk">*</span></span>
              <textarea required rows={3} value={liveValues.ticket_description ?? ''} onChange={(e) => setField('ticket_description', e.target.value)} />
            </label>
            <label style={{ maxWidth: 260 }}>
              <span>Priority <span className="required-asterisk">*</span></span>
              <select required value={liveValues.priority ?? ''} onChange={(e) => setField('priority', e.target.value)}>
                <option value="">{' '}</option>
                {priorityOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>
        </section>

        {preDiagnosed && (
          <section className="veh-card veh-card-form">
            <div className="veh-card-head">
              <Icon name="wrench" size={16} />
              <h4>{isSingleIssueMode ? 'Known Issue' : 'Known Sub-Issues'}</h4>
            </div>
            <div style={{ padding: 18 }}>
              <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
                {isCannibalized
                  ? 'Describe the specific problem this cannibalized part fixes — one donor vehicle can only be tied to one problem here.'
                  : isExternal
                    ? 'Describe the problem being sent out. Everything the shop actually finds/fixes gets logged in detail later, once they report back.'
                    : 'List each specific problem already found — a mechanic will be assigned to each one. All sub-issues here share one category.'}
              </p>

              <label style={{ maxWidth: 320 }}>
                <span>Category</span>
                <CreatableSelect
                  value={subIssueCategory}
                  onChange={setSubIssueCategory}
                  options={ticketLookups?.maintenance_types ?? []}
                  placeholder="Select a category or type to add new"
                  newItemLabel="maintenance type"
                  catalogEndpoint="/maintenance-types"
                />
              </label>

              <div className="sub-issue-rows">
                {subIssueRows.map((title, index) => (
                  <div key={index} className="sub-issue-row">
                    {!isSingleIssueMode && <span className="sub-issue-row-index">{index + 1}</span>}
                    <input
                      type="text"
                      placeholder="e.g. Low coolant level"
                      value={title}
                      onChange={(e) => updateSubIssue(index, e.target.value)}
                    />
                    {!isSingleIssueMode && (
                      <button
                        type="button"
                        className="btn-delete-action icon-btn"
                        onClick={() => removeSubIssueRow(index)}
                        disabled={subIssueRows.length === 1}
                        title="Remove sub-issue"
                        aria-label="Remove sub-issue"
                      >
                        <Icon name="close" size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!isSingleIssueMode && (
                <button type="button" className="primary-button" onClick={addSubIssueRow}><Icon name="plus" size={14} /> Add another sub-issue</button>
              )}
            </div>
          </section>
        )}

        <div className="form-actions">
          <button className="ghost-button" onClick={() => { clearNewTicketDraft(); onBack(); }} type="button" disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting}>
            {preDiagnosed ? 'Create Ticket & Assign Mechanic' : 'Create Ticket & Assign'}
          </button>
        </div>
      </form>
      {submitting && <SubmitLoadingOverlay label="Creating ticket…" />}
    </ModulePanel>
  );
}
