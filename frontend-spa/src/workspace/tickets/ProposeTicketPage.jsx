import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Icon from '../../components/Icon';
import { CreatableSelect } from '../components/inputs';
import { ModulePanel, SubmitLoadingOverlay } from '../components/ui';
import { useDraftState } from '../hooks/useDraftState';
import { ENTRY_MODE_OPTIONS } from '../lib/fields';
import { clearDraftState } from '../lib/formHelpers';
import { EMPTY_ARR, resolvePhotoUrl } from '../lib/format';
import { FormErrorSummary } from '../components/states';
import { TwoColumnSubIssueEditor } from './TicketDetailPanel';

// A Custodian's "propose a ticket" form — their own diagnosis, including who
// they think should do each repair, submitted for an Admin to review before
// it becomes a real, live ticket (POST /tickets/propose). Deliberately a
// separate component from NewTicketPage above rather than a shared branch:
// Admin's flow is more elaborate (entry mode, cannibalized/external context,
// Assign to Custodian, a single shared sub-issue category) and none of that
// applies here — the backend self-assigns the proposing Custodian, and each
// sub-issue carries its own maintenance type + an optional suggested
// mechanic instead. Keeping it fully separate means Admin's existing form is
// untouched by this addition.
export function ProposeTicketPage({ onBack, ticketLookups, onProposeTicket, onDirty, prefilledTicketData }) {
  // Opened from a flagged Issue Report / Condition Check the form arrives
  // pre-filled and linked; from the chooser's "full repair details" card it
  // starts blank. Separate draft keys so the two never overwrite each other.
  const linkedIssueId = prefilledTicketData?.issue_report_id ?? null;
  const linkedConditionId = prefilledTicketData?.condition_check_id ?? null;
  const fromFlag = Boolean(linkedIssueId || linkedConditionId);
  const draftSuffix = linkedIssueId ? 'issue-' + linkedIssueId : linkedConditionId ? 'condition-' + linkedConditionId : 'blank';
  const draftKeyBase = 'draft:propose-ticket:' + draftSuffix;
  const [liveValues, setLiveValues] = useDraftState(draftKeyBase + ':values', () => (prefilledTicketData ? {
    vehicle_id: prefilledTicketData.vehicle_id ?? '',
    ticket_title: prefilledTicketData.ticket_title ?? '',
    ticket_description: prefilledTicketData.ticket_description ?? '',
    priority: prefilledTicketData.priority ?? '',
    entry_mode: prefilledTicketData.entry_mode ?? null,
  } : {}));
  const [subIssueRows, setSubIssueRows] = useDraftState(draftKeyBase + ':sub-issues', () => {
    const seeded = (prefilledTicketData?.sub_issues_text ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
    return seeded.map((title) => ({ title, maintenance_type: '' }));
  });
  const emptyPartRow = { part_missing: '', part_needed: '', maintenance_type: '' };
  const [partRows, setPartRows] = useDraftState(draftKeyBase + ':part-rows', () => [emptyPartRow]);
  const [submitting, setSubmitting] = useState(false);
  const [validationLines, setValidationLines] = useState(null);

  const clearProposeDraft = () => {
    clearDraftState(`${draftKeyBase}:values`);
    clearDraftState(`${draftKeyBase}:sub-issues`);
    clearDraftState(`${draftKeyBase}:part-rows`);
  };
  const updatePartRow = (index, patch) => {
    setPartRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    onDirty?.();
  };
  const addPartRow = () => setPartRows((rows) => [...rows, emptyPartRow]);
  const removePartRow = (index) => setPartRows((rows) => rows.filter((_, i) => i !== index));

  const setField = (name, value) => { setLiveValues((v) => ({ ...v, [name]: value })); onDirty?.(); };
  const setSubIssueRowsDirty = (rows) => { setSubIssueRows(rows); onDirty?.(); };

  // A proposal always states the repair: in-house, a part taken from another
  // vehicle, or sent to an outside shop. (There is no "needs inspection" —
  // a Custodian only proposes once they know what is wrong; flagging a
  // concern without a plan is what Report Issue is for.)
  // Two choices: In-House Repair, or Sent to External Shop. A part taken from
  // another vehicle ("cannibalized") is still an in-house repair, so it's a
  // checkbox under In-House — it keeps its own mode behind the scenes, which is
  // what triggers the Admin approval and the donor-vehicle report.
  const modeOptions = ENTRY_MODE_OPTIONS.filter((o) => o.value === 'in_house' || o.value === 'external');
  const entryMode = ['in_house', 'cannibalized', 'external'].includes(liveValues.entry_mode) ? liveValues.entry_mode : null;
  const pickerValue = entryMode === 'cannibalized' ? 'in_house' : entryMode;
  const isInHouse = entryMode === 'in_house';
  const isCannibalized = entryMode === 'cannibalized';
  const isExternal = entryMode === 'external';
  const toggleDonorPart = (checked) => {
    setLiveValues((v) => ({ ...v, entry_mode: checked ? 'cannibalized' : 'in_house', source_vehicle_id: '' }));
    onDirty?.();
  };
  const selectEntryMode = (value) => {
    if (value === pickerValue) return;
    setLiveValues((v) => ({
      ...v,
      entry_mode: value,
      source_vehicle_id: '',
      external_vendor: '', external_reason: '', external_work_scope: '', external_shop_contact: '',
      external_sent_by: '', external_contact_person: '', external_estimated_cost: '', external_maintenance_type: '',
    }));
    setPartRows([emptyPartRow]);
    onDirty?.();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errors = [];
    if (!liveValues.vehicle_id) errors.push('Vehicle is required.');
    if (!(liveValues.ticket_description ?? '').trim()) errors.push('Details is required.');
    if (!liveValues.priority) errors.push('Priority is required.');
    if (!entryMode) errors.push('Pick how this is being reported, above.');
    const cleanedRows = subIssueRows.filter((row) => (row.title ?? '').trim());
    if (isInHouse && !cleanedRows.length) errors.push('At least one sub-issue is required.');
    // A part row counts once either field is filled; then both are required.
    const filledPartRows = partRows.filter((r) => (r.part_missing ?? '').trim() || (r.part_needed ?? '').trim());
    if (isCannibalized) {
      if (!liveValues.source_vehicle_id) errors.push('Donor Vehicle is required.');
      if (!filledPartRows.length) errors.push('Add at least one part.');
      filledPartRows.forEach((r, i) => {
        if (!(r.part_missing ?? '').trim()) errors.push(`Part ${i + 1}: Missing / Faulty Part is required.`);
        if (!(r.part_needed ?? '').trim()) errors.push(`Part ${i + 1}: Part to Take From Donor is required.`);
      });
    }
    if (isExternal) {
      if (!liveValues.external_reason) errors.push('Reason for Sending Out is required.');
      if (!(liveValues.external_work_scope ?? '').trim()) errors.push('Work to Be Done at the Shop is required.');
    }
    if (errors.length) {
      setValidationLines(errors);
      return;
    }

    setSubmitting(true);
    try {
      // No title is sent: the server builds "MT-0010 — Vehicle — Issue".
      const out = {
        vehicle_id: liveValues.vehicle_id,
        ticket_description: liveValues.ticket_description,
        priority: liveValues.priority,
        entry_mode: entryMode,
        issue_report_id: linkedIssueId || liveValues.link_issue_id || undefined,
        condition_check_id: linkedConditionId || undefined,
        sub_issues: [],
      };
      if (isInHouse) {
        out.sub_issues = cleanedRows.map((row) => ({
          title: row.title.trim(),
          maintenance_type: row.maintenance_type || null,
          suggested_mechanic_id: row.suggested_mechanic_id || null,
        }));
      }
      // Cannibalized/External are one repair each — their single work item
      // is described by the dedicated fields below, not a free-form row.
      if (isCannibalized) {
        const donor = sourceVehicleOptions.find((v) => String(v.vehicle_id) === String(liveValues.source_vehicle_id));
        out.source_vehicle_id = liveValues.source_vehicle_id;
        out.sub_issues = filledPartRows.map((r) => ({
          title: `Replace ${r.part_missing.trim()} using ${r.part_needed.trim()} from ${donor?.vehicle_name ?? 'donor vehicle'}`.slice(0, 255),
          maintenance_type: r.maintenance_type || null,
          part_missing: r.part_missing.trim(),
          part_needed: r.part_needed.trim(),
        }));
      }
      if (isExternal) {
        Object.assign(out, {
          external_vendor: liveValues.external_vendor?.trim() || undefined,
          external_reason: liveValues.external_reason,
          external_work_scope: liveValues.external_work_scope.trim(),
          external_shop_contact: liveValues.external_shop_contact?.trim() || undefined,
          external_sent_by: liveValues.external_sent_by?.trim() || undefined,
          external_contact_person: liveValues.external_contact_person?.trim() || undefined,
          external_estimated_cost: liveValues.external_estimated_cost || undefined,
        });
        out.sub_issues = [{
          title: `External shop: ${liveValues.external_work_scope.trim().split('\n')[0]}`.slice(0, 255),
          maintenance_type: liveValues.external_maintenance_type || null,
          suggested_mechanic_id: null,
        }];
      }
      const created = await onProposeTicket(out);
      if (created) { clearProposeDraft(); onBack(); }
    } finally {
      setSubmitting(false);
    }
  };

  const vehicleOptions = (ticketLookups.vehicles ?? []).filter((v) => v.status !== 'Inactive' && v.status !== 'Decommissioned');
  const priorityOptions = ticketLookups.priorities ?? [];
  const selectedVehicle = vehicleOptions.find((v) => String(v.vehicle_id) === String(liveValues.vehicle_id)) ?? null;

  // A proposal started from the generic form isn't tied to any report. If the
  // vehicle has open reports, offer them so the ticket can be linked to the one
  // it's for (that's what makes the report's Ticket column and eye icon work).
  const [openReportsResult, setOpenReports] = useState([]);
  const openReports = fromFlag || !liveValues.vehicle_id ? EMPTY_ARR : openReportsResult;
  useEffect(() => {
    if (fromFlag || !liveValues.vehicle_id) return undefined;
    let cancelled = false;
    api.get(`/vehicles/${liveValues.vehicle_id}/open-issues`)
      .then((response) => {
        if (cancelled) return;
        const open = (response.data ?? []).filter((r) => ['Pending', 'Under Review'].includes(r.status));
        setOpenReports(open);
        setLiveValues((v) => (v.link_issue_id && !open.some((r) => String(r.issue_report_id) === String(v.link_issue_id)) ? { ...v, link_issue_id: '' } : v));
      })
      .catch(() => { if (!cancelled) setOpenReports([]); });
    return () => { cancelled = true; };
  }, [liveValues.vehicle_id, fromFlag, setLiveValues]);
  const sourceVehicleOptions = vehicleOptions.filter((v) => String(v.vehicle_id) !== String(liveValues.vehicle_id));


  return (
    <ModulePanel description="Propose a maintenance ticket for Admin review. Pick how it's being reported first — it stays Pending Approval until an Admin approves or declines it.">
      {fromFlag && (
        <div className="info-callout" style={{ marginBottom: '16px', background: 'rgba(59, 130, 246, 0.1)', borderColor: '#3b82f6' }}>
          <span style={{ marginRight: '8px', color: '#3b82f6', display: 'inline-flex' }}><Icon name="link" size={16} /></span>
          <p className="module-description" style={{ color: '#3b82f6', margin: 0 }}>
            Linking this proposal to <strong>{linkedIssueId ? 'Issue Report #' + linkedIssueId : 'Condition Check #' + linkedConditionId}</strong>.
          </p>
        </div>
      )}
      <form className="smart-form ticket-create-form" onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FormErrorSummary errors={validationLines} onDismiss={() => setValidationLines(null)} />

        <section className="veh-card">
          <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>How Is This Being Reported?</h4></div>
          <div style={{ padding: 18 }}>
            <div className="entry-mode-toggle" role="radiogroup" aria-label="Entry mode">
              {modeOptions.map((opt) => {
                const checked = pickerValue === opt.value;
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
            {pickerValue === 'in_house' && (
              // A div, not a <label>: the form's label styles (small caps,
              // stacked layout) fight a checkbox row.
              <div
                role="checkbox"
                aria-checked={isCannibalized}
                tabIndex={0}
                onClick={() => toggleDonorPart(!isCannibalized)}
                onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleDonorPart(!isCannibalized); } }}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 18, padding: '12px 14px', background: isCannibalized ? '#f0fdf4' : '#f8fafc', border: `1px solid ${isCannibalized ? '#86efac' : '#e2e8f0'}`, borderRadius: 8, cursor: 'pointer' }}
              >
                <span
                  aria-hidden="true"
                  style={{ flexShrink: 0, width: 20, height: 20, marginTop: 1, borderRadius: 5, border: `2px solid ${isCannibalized ? '#16a34a' : '#94a3b8'}`, background: isCannibalized ? '#16a34a' : '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
                >
                  {isCannibalized && <Icon name="checkCircle" size={13} />}
                </span>
                <div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0f172a' }}>This repair uses a part taken from another vehicle</div>
                  <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>An Admin approves it before any part is removed from the other (donor) vehicle.</div>
                </div>
              </div>
            )}
            <p className="muted" style={{ margin: '10px 0 0', fontSize: '0.82rem' }}>
              {entryMode == null
                ? 'Pick how this repair will be done.'
                : 'Once an Admin approves, it goes straight to repair — a mechanic gets assigned to each sub-issue.'}
            </p>
          </div>
        </section>

        <section className="veh-card">
          <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicle</h4></div>
          {/* The picker and the selected vehicle's info now sit side by side
              (one .ticket-form-grid-2 row) instead of the preview stacking
              full-width underneath — picker on the left, info on the right. */}
          <div className="ticket-form-grid-2">
            <label>
              <span>Vehicle <span className="required-asterisk">*</span></span>
              <select required value={liveValues.vehicle_id ?? ''} onChange={(e) => setField('vehicle_id', e.target.value)}>
                <option value="">{' '}</option>
                {vehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </select>
            </label>
            {selectedVehicle && (
              <div className="ticket-preview-card ticket-preview-card--lg" style={{ alignSelf: 'start' }}>
                {selectedVehicle.photo_url ? (
                  <img className="ticket-preview-photo ticket-preview-photo--lg" src={resolvePhotoUrl(selectedVehicle.photo_url)} alt={selectedVehicle.vehicle_name} />
                ) : (
                  <span className="ticket-preview-photo ticket-preview-photo--lg ticket-preview-photo-empty"><Icon name="vehicle" size={44} /></span>
                )}
                <div className="ticket-preview-body ticket-preview-body--lg">
                  <strong>{selectedVehicle.vehicle_name}</strong>
                  <span>{selectedVehicle.plate_number} &middot; {selectedVehicle.category?.category_name ?? 'Unclassified'}</span>
                  <span className="muted">{[selectedVehicle.brand, selectedVehicle.model].filter(Boolean).join(' ') || '—'} &middot; {selectedVehicle.current_location ?? 'No location on file'}</span>
                </div>
              </div>
            )}
          </div>
          {!fromFlag && openReports.length > 0 && (
            <div style={{ margin: '0 18px 18px', padding: '12px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8 }}>
              <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: 2 }}>This vehicle has open reports — is this repair for one of them?</div>
              <div className="muted" style={{ fontSize: '0.8rem', marginBottom: 8 }}>Linking it lets the report show its ticket, and the report is closed out when the ticket is.</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {openReports.map((r) => (
                  <div
                    key={r.issue_report_id}
                    role="radio"
                    aria-checked={String(liveValues.link_issue_id) === String(r.issue_report_id)}
                    tabIndex={0}
                    onClick={() => setField('link_issue_id', r.issue_report_id)}
                    onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setField('link_issue_id', r.issue_report_id); } }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#fff', border: `1px solid ${String(liveValues.link_issue_id) === String(r.issue_report_id) ? '#2563eb' : '#e2e8f0'}`, borderRadius: 6, cursor: 'pointer', fontSize: '0.86rem' }}
                  >
                    <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0, border: `2px solid ${String(liveValues.link_issue_id) === String(r.issue_report_id) ? '#2563eb' : '#94a3b8'}`, background: String(liveValues.link_issue_id) === String(r.issue_report_id) ? '#2563eb' : '#fff', boxShadow: String(liveValues.link_issue_id) === String(r.issue_report_id) ? 'inset 0 0 0 3px #fff' : 'none' }} />
                    <span><strong>#{r.issue_report_id} {r.issue_type}</strong> <span className="muted">({r.severity_level} · {r.status}{r.reported_by?.name ? ` · reported by ${r.reported_by.name}` : ''})</span></span>
                  </div>
                ))}
                <div
                  role="radio"
                  aria-checked={!liveValues.link_issue_id}
                  tabIndex={0}
                  onClick={() => setField('link_issue_id', '')}
                  onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setField('link_issue_id', ''); } }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#fff', border: `1px solid ${!liveValues.link_issue_id ? '#2563eb' : '#e2e8f0'}`, borderRadius: 6, cursor: 'pointer', fontSize: '0.86rem' }}
                >
                  <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0, border: `2px solid ${!liveValues.link_issue_id ? '#2563eb' : '#94a3b8'}`, background: !liveValues.link_issue_id ? '#2563eb' : '#fff', boxShadow: !liveValues.link_issue_id ? 'inset 0 0 0 3px #fff' : 'none' }} />
                  <span>None of these — this is something new</span>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="alert" size={16} /><h4>Issue Details</h4></div>
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* No Ticket Title field — it's automatic (vehicle + repair type),
                and the Admin folds the ticket's own # into it on approval. */}
            <label>
              <span>Details <span className="required-asterisk">*</span></span>
              <textarea required rows={3} value={liveValues.ticket_description ?? ''} onChange={(e) => setField('ticket_description', e.target.value)} />
            </label>
            <label style={{ maxWidth: 260 }}>
              <span>Priority <span className="required-asterisk">*</span></span>
              <select required value={liveValues.priority ?? ''} onChange={(e) => setField('priority', e.target.value)}>
                <option value="">{' '}</option>
                {priorityOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>
        </section>

        {isCannibalized && (
        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>Cannibalization Details</h4></div>
          <div style={{ padding: 18 }}>
            <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
              Identify what this vehicle is missing and which part will be taken off the donor to fix it — add a row per part. The Admin reviews this before any part is removed.
            </p>
            <label style={{ maxWidth: 420, marginBottom: 14 }}>
              <span>Donor Vehicle <span className="required-asterisk">*</span></span>
              <select required value={liveValues.source_vehicle_id ?? ''} onChange={(e) => setField('source_vehicle_id', e.target.value)}>
                <option value="">{' '}</option>
                {sourceVehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </select>
            </label>
            <div className="sub-issue-rows sub-issue-rows-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10, alignItems: 'start' }}>
              {partRows.map((row, index) => (
                <div key={index} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span className="sub-issue-row-index" style={{ marginTop: 12 }}>{index + 1}</span>
                  <div className="ticket-form-grid-2" style={{ padding: 0, flex: 1 }}>
                    <label>
                      <span>Missing / Faulty Part (on this vehicle) <span className="required-asterisk">*</span></span>
                      <input type="text" placeholder="e.g. Alternator" value={row.part_missing} onChange={(e) => updatePartRow(index, { part_missing: e.target.value })} />
                    </label>
                    <label>
                      <span>Part to Take From Donor <span className="required-asterisk">*</span></span>
                      <input type="text" placeholder="e.g. Alternator (12V, 90A)" value={row.part_needed} onChange={(e) => updatePartRow(index, { part_needed: e.target.value })} />
                    </label>
                    <label>
                      <span>Maintenance Type</span>
                      <CreatableSelect
                        value={row.maintenance_type ?? ''}
                        onChange={(v) => updatePartRow(index, { maintenance_type: v })}
                        options={ticketLookups?.maintenance_types ?? []}
                        placeholder="Select a category or type to add new"
                        newItemLabel="maintenance type"
                        catalogEndpoint="/maintenance-types"
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="btn-delete-action icon-btn"
                    style={{ marginTop: 10 }}
                    onClick={() => removePartRow(index)}
                    disabled={partRows.length === 1}
                    title="Remove part"
                    aria-label="Remove part"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="primary-button" style={{ marginTop: 10 }} onClick={addPartRow}><Icon name="plus" size={14} /> Add another part</button>
          </div>
        </section>
        )}

        {isExternal && (
        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>External Shop Details</h4></div>
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p className="muted" style={{ margin: 0 }}>
              Give the Admin a verifiable reason for sending this out and exactly what the shop is asked to do.
            </p>
            <div className="ticket-form-grid-2" style={{ padding: 0 }}>
              <label>
                <span>Reason for Sending Out <span className="required-asterisk">*</span></span>
                <select required value={liveValues.external_reason ?? ''} onChange={(e) => setField('external_reason', e.target.value)}>
                  <option value="">{' '}</option>
                  {(ticketLookups.external_reasons ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label>
                <span>Maintenance Type</span>
                <CreatableSelect
                  value={liveValues.external_maintenance_type ?? ''}
                  onChange={(v) => setField('external_maintenance_type', v)}
                  options={ticketLookups?.maintenance_types ?? []}
                  placeholder="Select a category or type to add new"
                  newItemLabel="maintenance type"
                  catalogEndpoint="/maintenance-types"
                />
              </label>
              <label>
                <span>External Shop Name</span>
                <input type="text" placeholder="e.g. Dela Cruz Auto Repair" value={liveValues.external_vendor ?? ''} onChange={(e) => setField('external_vendor', e.target.value)} />
              </label>
              <label>
                <span>Contact Person (at the shop)</span>
                <input type="text" placeholder="e.g. Mang Jun Dela Cruz" value={liveValues.external_contact_person ?? ''} onChange={(e) => setField('external_contact_person', e.target.value)} />
              </label>
              <label>
                <span>Contact Number</span>
                <input type="text" placeholder="e.g. 0917 123 4567" value={liveValues.external_shop_contact ?? ''} onChange={(e) => setField('external_shop_contact', e.target.value)} />
              </label>
              <label>
                <span>Sent By (who takes the vehicle)</span>
                <CreatableSelect
                  value={liveValues.external_sent_by ?? ''}
                  onChange={(v) => setField('external_sent_by', v)}
                  options={[]}
                  newItemLabel="person"
                  catalogEndpoint="/reported-persons"
                />
              </label>
              <label>
                <span>Estimated Cost (PHP)</span>
                <input type="number" min="0" placeholder="e.g. 5000" value={liveValues.external_estimated_cost ?? ''} onChange={(e) => setField('external_estimated_cost', e.target.value)} />
              </label>
            </div>
            <label>
              <span>Work to Be Done at the Shop <span className="required-asterisk">*</span></span>
              <textarea rows={3} placeholder="e.g. Diagnose and recharge A/C system, replace compressor if needed" value={liveValues.external_work_scope ?? ''} onChange={(e) => setField('external_work_scope', e.target.value)} />
            </label>
          </div>
        </section>
        )}

        {isInHouse && (
        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>Sub-Issues</h4></div>
          <div style={{ padding: 18 }}>
            <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
              List each specific problem you found, with its own maintenance type — different problems on the same ticket can need different kinds of repair. The Admin assigns one mechanic to the whole ticket when approving it.
            </p>

            <TwoColumnSubIssueEditor
              items={subIssueRows}
              onChange={setSubIssueRowsDirty}
              maintenanceTypeOptions={ticketLookups?.maintenance_types ?? []}
              mechanicOptions={ticketLookups?.maintenance_personnel ?? []}
              minItems={0}
            />
          </div>
        </section>
        )}

        <div className="form-actions">
          <button className="ghost-button" onClick={() => { clearProposeDraft(); onBack(); }} type="button" disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting}>Submit for Admin Review</button>
        </div>
      </form>
      {submitting && <SubmitLoadingOverlay label="Submitting proposal…" />}
    </ModulePanel>
  );
}
