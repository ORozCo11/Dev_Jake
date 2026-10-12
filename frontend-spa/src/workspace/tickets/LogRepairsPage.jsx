import { useEffect, useMemo, useState } from 'react';
import Icon from '../../components/Icon';
import { DateFilterInput } from '../components/inputs';
import { FormErrorSummary } from '../components/states';
import { ModulePanel, RepairLogEntries, TicketStatusBadge } from '../components/ui';
import { useDraftState } from '../hooks/useDraftState';
import { clearDraftState } from '../lib/formHelpers';
import { formatDate } from '../lib/format';

const peso = (n) => `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatFileSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const REPAIR_TYPE_LABEL = { in_house: 'In-House Repair', cannibalized: 'Used Cannibalized Part', external: 'Sent to External Shop' };

// "Record Repair Work" — one two-column workspace: the repair task on the
// left, the supporting record (parts, dates, total) plus the submit action
// in a side column that stays in view while scrolling. The typed work is
// kept as a draft on this device so a reload or a quick detour doesn't
// lose a long entry.
export function LogRepairsPage({ ticket, vehicleOptions = [], onBack, onSubmit, onDirty, onExternalSend, onExternalReturn }) {
  const draftKey = ticket?.sub_issue_id ? `draft:log-repairs:${ticket.ticket_id}:${ticket.sub_issue_id}` : null;
  const [draft, setDraft] = useDraftState(draftKey, () => ({
    repairLogs: '',
    parts: [{ name: '', cost: '' }],
    repairStartedAt: '',
    repairCompletedAt: '',
    // Only used when the sub-issue arrives without a repair type (created
    // via "Needs Inspection"); otherwise the proposed type is shown read-only.
    repairType: ticket?.repair_type ?? '',
    sourceVehicleId: ticket?.source_vehicle_id ?? '',
    externalVendor: ticket?.external_vendor ?? '',
    // date casts serialize as ISO datetimes; date inputs need YYYY-MM-DD.
    warrantyUntil: (ticket?.warranty_until ?? '').slice(0, 10),
    partNeeded: ticket?.part_needed ?? '',
    partQuantity: ticket?.part_quantity ?? '',
    partCondition: ticket?.part_condition ?? '',
    cannibalReason: ticket?.cannibal_reason ?? '',
    partInstalledAt: (ticket?.part_installed_at ?? '').slice(0, 10),
  }));
  const [attachment, setAttachment] = useState(null);
  // One preview URL per chosen file, released when it changes or unmounts
  // (creating it inline leaked a new blob URL on every render).
  const attachmentPreview = useMemo(
    () => (attachment?.type?.startsWith('image/') ? URL.createObjectURL(attachment) : null),
    [attachment],
  );
  useEffect(() => () => { if (attachmentPreview) URL.revokeObjectURL(attachmentPreview); }, [attachmentPreview]);
  const [errors, setErrors] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // External shop stages: send out, then mark returned, then submit.
  const [sendForm, setSendForm] = useState({ external_vendor: ticket?.external_vendor ?? '', external_reason: '', external_work_scope: '', external_shop_contact: '', external_estimated_cost: '' });
  const [returnForm, setReturnForm] = useState({ external_return_notes: '', external_actual_cost: '', warranty_until: '' });

  if (!ticket) {
    return <ModulePanel description="This work order could not be found — it may no longer be assigned to you." />;
  }

  const set = (field, value) => { setDraft((d) => ({ ...d, [field]: value })); onDirty?.(); };
  const { parts } = draft;
  // Decided when the ticket was proposed and not changed here; only a
  // sub-issue that arrived without one gets a picker.
  const repairTypeLocked = Boolean(ticket.repair_type);
  const repairType = repairTypeLocked ? ticket.repair_type : draft.repairType;
  const updatePart = (index, field, value) => set('parts', parts.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  const addPart = () => set('parts', [...parts, { name: '', cost: '' }]);
  const removePart = (index) => set('parts', parts.filter((_, i) => i !== index));

  // Live total — always reflects exactly what's in the rows right now.
  const totalCost = parts.reduce((sum, p) => sum + (Number.parseFloat(p.cost) > 0 ? Number.parseFloat(p.cost) : 0), 0);
  // While a repair is out at the shop, parts/evidence/dates don't apply
  // yet; de-emphasized, not disabled, so an early note is still possible.
  const awaitingShopReturn = repairType === 'external' && !!ticket.external_sent_at && !ticket.external_returned_at;
  const sourceVehicleOptions = vehicleOptions.filter((v) => String(v.vehicle_id) !== String(ticket.vehicle?.vehicle_id));
  const hasDraft = Boolean(draft.repairLogs || parts.some((p) => p.name || p.cost));

  const idBase = `lr-${ticket.sub_issue_id ?? ticket.ticket_id}`;
  const workDescription = ticket.work_order_notes ?? ticket.ticket_description;
  const namedPartCount = parts.filter((p) => p.name.trim()).length;
  const dimWhileAtShop = { opacity: awaitingShopReturn ? 0.5 : 1 };
  const nextStep = repairType === 'cannibalized'
    ? 'Next: Admin approves the part transfer'
    : 'Next: Custodian verifies once every repair on this ticket is logged';

  const validate = () => {
    const list = [];
    if (!draft.repairLogs.trim()) list.push('Describe the work you performed.');
    if (!repairType) list.push('Choose a repair type.');
    if (repairType === 'cannibalized' && !draft.sourceVehicleId) list.push('Choose the source vehicle the part came from.');
    parts.forEach((p, i) => {
      const hasCost = String(p.cost).trim() !== '';
      if (hasCost && !(Number.parseFloat(p.cost) >= 0)) list.push(`Part ${i + 1}: cost must be a number, zero or more.`);
      if (hasCost && !p.name.trim()) list.push(`Part ${i + 1}: add the part name for this cost.`);
    });
    if (draft.repairStartedAt && draft.repairCompletedAt && draft.repairCompletedAt < draft.repairStartedAt) {
      list.push('Completion date can\'t be before the start date.');
    }
    return list;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    const problems = validate();
    if (problems.length) { setErrors(problems); return; }
    setErrors(null);
    const namedParts = parts.filter((p) => p.name.trim());
    const cannibal = repairType === 'cannibalized';
    const external = repairType === 'external';
    setSubmitting(true);
    try {
      const ok = await onSubmit(ticket, {
        repair_logs: draft.repairLogs,
        parts_used: namedParts.map((p) => p.name.trim()).join(', ') || undefined,
        photo: attachment || undefined,
        maintenance_cost: totalCost > 0 ? totalCost : undefined,
        repair_started_at: draft.repairStartedAt || undefined,
        repair_completed_at: draft.repairCompletedAt || undefined,
        repair_type: repairType || undefined,
        source_vehicle_id: cannibal ? draft.sourceVehicleId : undefined,
        external_vendor: external ? (draft.externalVendor || undefined) : undefined,
        warranty_until: external ? (draft.warrantyUntil || undefined) : undefined,
        part_needed: cannibal ? (draft.partNeeded || undefined) : undefined,
        part_quantity: cannibal ? (draft.partQuantity || undefined) : undefined,
        part_condition: cannibal ? (draft.partCondition || undefined) : undefined,
        cannibal_reason: cannibal ? (draft.cannibalReason || undefined) : undefined,
        part_installed_at: cannibal ? (draft.partInstalledAt || undefined) : undefined,
      });
      if (ok) clearDraftState(draftKey);
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = () => { clearDraftState(draftKey); onBack(); };

  return (
    <ModulePanel>
      <header className="lr-header">
        <div className="lr-header-main">
          <h3 className="lr-vehicle">{ticket.vehicle?.vehicle_name ?? 'Vehicle'}</h3>
          <p className="lr-header-meta">
            {[ticket.vehicle?.plate_number, ticket.maintenance_type, `Ticket #${ticket.ticket_id}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <TicketStatusBadge value={ticket.status} />
      </header>

      {ticket.confirmation_verdict === 'Reopened' && (
        <div className="lr-alert lr-alert-danger" role="note">
          <Icon name="alert" size={16} />
          <div>
            <strong>Reopened by Admin ({ticket.confirmed_by?.name ?? 'Admin'})</strong>
            <p>{ticket.confirmation_notes ?? 'No feedback notes provided.'}</p>
          </div>
        </div>
      )}
      {ticket.verification_verdict === 'Rejected' && (
        <div className="lr-alert lr-alert-warning" role="note">
          <Icon name="alert" size={16} />
          <div>
            <strong>Rejected by Custodian ({ticket.verified_by?.name ?? 'Custodian'})</strong>
            <p>{ticket.verification_notes ?? 'No feedback notes provided.'}</p>
          </div>
        </div>
      )}

      <FormErrorSummary errors={errors} onDismiss={() => setErrors(null)} />

      <form className="smart-form lr-workspace" onSubmit={handleSubmit} noValidate>
        <div className="lr-main">
          {/* Work order — only what the header doesn't already say. */}
          <section className="lr-group lr-workorder" aria-labelledby={`${idBase}-wo`}>
            <h4 className="lr-section-label" id={`${idBase}-wo`}>Work Order</h4>
            <dl className="lr-kv">
              <div><dt>Repair Item</dt><dd>{ticket.title}</dd></div>
              <div><dt>Main Issue</dt><dd>{ticket.ticket_title}</dd></div>
              {workDescription && <div className="lr-kv-wide"><dt>Description</dt><dd>{workDescription}</dd></div>}
            </dl>
            {ticket.repair_logs && (
              <div className="lr-history">
                <span className="lr-mini-label">Previous repair</span>
                <RepairLogEntries text={ticket.repair_logs} compact limit={2} />
              </div>
            )}
          </section>

          {/* The primary task — visually the heaviest group on the page. */}
          <section className="lr-group lr-primary" aria-labelledby={`${idBase}-rw`}>
            <h4 className="lr-section-label" id={`${idBase}-rw`}>Repair Work</h4>
            {repairTypeLocked ? (
              <div className="lr-field">
                <span className="lr-label" id={`${idBase}-type`}>Repair Type</span>
                {/* Shown as a value, not a disabled dropdown that looks clickable. */}
                <p className="lr-readonly" aria-labelledby={`${idBase}-type`}>
                  {REPAIR_TYPE_LABEL[repairType] ?? repairType}
                  <span className="lr-hint"> · set when the ticket was proposed</span>
                </p>
              </div>
            ) : (
              <div className="lr-field">
                <label className="lr-label" htmlFor={`${idBase}-type`}>Repair Type <abbr className="required-asterisk" title="required">*</abbr></label>
                <select id={`${idBase}-type`} required aria-required="true" value={draft.repairType} onChange={(e) => set('repairType', e.target.value)}>
                  <option value="">Select a repair type</option>
                  <option value="in_house">{REPAIR_TYPE_LABEL.in_house}</option>
                  <option value="cannibalized">{REPAIR_TYPE_LABEL.cannibalized}</option>
                  <option value="external">{REPAIR_TYPE_LABEL.external}</option>
                </select>
              </div>
            )}

            {repairType === 'cannibalized' && (
              <div className="lr-field">
                <label className="lr-label" htmlFor={`${idBase}-source`}>Source Vehicle <abbr className="required-asterisk" title="required">*</abbr></label>
                <select id={`${idBase}-source`} required aria-required="true" value={draft.sourceVehicleId} onChange={(e) => set('sourceVehicleId', e.target.value)}>
                  <option value="">Select source vehicle</option>
                  {sourceVehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
                </select>
              </div>
            )}
            {repairType === 'external' && (
              <div className="lr-two-col">
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-vendor`}>External Shop Name</label>
                  <input id={`${idBase}-vendor`} type="text" placeholder="e.g. Dela Cruz Auto Repair" value={draft.externalVendor} onChange={(e) => set('externalVendor', e.target.value)} />
                </div>
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-warranty`}>Warranty Until</label>
                  <DateFilterInput id={`${idBase}-warranty`} value={draft.warrantyUntil} onChange={(v) => set('warrantyUntil', v)} />
                </div>
              </div>
            )}

            <div className="lr-field">
              <label className="lr-label" htmlFor={`${idBase}-work`}>Work Performed <abbr className="required-asterisk" title="required">*</abbr></label>
              <textarea
                id={`${idBase}-work`}
                className="lr-textarea"
                required
                aria-required="true"
                rows={4}
                placeholder="Describe what you repaired, what you found, what you replaced, adjustments made, and testing performed."
                value={draft.repairLogs}
                onChange={(e) => set('repairLogs', e.target.value)}
              />
            </div>
          </section>

          {repairType === 'cannibalized' && (
            <section className="lr-group" aria-labelledby={`${idBase}-donor`}>
              <h4 className="lr-section-label" id={`${idBase}-donor`}>Part Taken From Donor</h4>
              <div className="lr-two-col">
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-pn`}>Part</label>
                  <input id={`${idBase}-pn`} type="text" placeholder="e.g. Radiator" value={draft.partNeeded} onChange={(e) => set('partNeeded', e.target.value)} />
                </div>
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-pq`}>Quantity</label>
                  <input id={`${idBase}-pq`} type="number" min="1" inputMode="numeric" value={draft.partQuantity} onChange={(e) => set('partQuantity', e.target.value)} />
                </div>
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-pc`}>Part Condition</label>
                  <input id={`${idBase}-pc`} type="text" value={draft.partCondition} onChange={(e) => set('partCondition', e.target.value)} />
                </div>
                <div className="lr-field">
                  <label className="lr-label" htmlFor={`${idBase}-pi`}>Date Installed</label>
                  <DateFilterInput id={`${idBase}-pi`} value={draft.partInstalledAt} onChange={(v) => set('partInstalledAt', v)} />
                </div>
              </div>
              <div className="lr-field">
                <label className="lr-label" htmlFor={`${idBase}-cr`}>Why this donor / why not buy the part?</label>
                <textarea id={`${idBase}-cr`} className="lr-textarea" rows={2} value={draft.cannibalReason} onChange={(e) => set('cannibalReason', e.target.value)} />
              </div>
            </section>
          )}

          {repairType === 'external' && onExternalSend && (
            <ExternalShopSection
              idBase={idBase}
              ticket={ticket}
              sendForm={sendForm}
              setSendForm={setSendForm}
              returnForm={returnForm}
              setReturnForm={setReturnForm}
              onExternalSend={onExternalSend}
              onExternalReturn={onExternalReturn}
            />
          )}

          {awaitingShopReturn && (
            <p className="lr-note">Evidence, parts and dates apply once the vehicle is back from the shop — mark it Returned above when it comes in.</p>
          )}

          {/* Compact uploader — a button and a single file row. */}
          <section className="lr-group" style={dimWhileAtShop} aria-labelledby={`${idBase}-ev`}>
            <h4 className="lr-section-label" id={`${idBase}-ev`}>Repair Evidence</h4>
            {attachment ? (
              <div className="lr-file-row">
                {attachmentPreview ? (
                  <img src={attachmentPreview} alt="" className="lr-file-thumb" />
                ) : (
                  <span className="lr-file-thumb lr-file-thumb-icon"><Icon name="archive" size={15} /></span>
                )}
                <span className="lr-file-name">{attachment.name}</span>
                <span className="lr-hint">{formatFileSize(attachment.size)}</span>
                <button type="button" className="lr-icon-btn" onClick={() => setAttachment(null)} title="Remove attachment" aria-label={`Remove ${attachment.name}`}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ) : (
              <div className="lr-upload-line">
                <label className="lr-upload-btn">
                  <Icon name="plus" size={14} /> Add Photo / Document
                  <input type="file" className="lr-file-input" accept="image/*,.pdf,.doc,.docx" onChange={(e) => { setAttachment(e.target.files[0] ?? null); onDirty?.(); }} />
                </label>
                <span className="lr-hint">JPG, PNG, PDF, or DOC · up to 8 MB</span>
              </div>
            )}
          </section>
        </div>

        {/* Sticky on desktop, so the record, the next step and Submit stay in view. */}
        <aside className="lr-side" aria-label="Repair record and submission">
          <section className="lr-side-group" style={dimWhileAtShop} aria-labelledby={`${idBase}-parts`}>
            <h4 className="lr-section-label" id={`${idBase}-parts`}>Parts &amp; Materials</h4>
            <div className="lr-parts" role="table" aria-labelledby={`${idBase}-parts`}>
              <div className="lr-parts-head" role="row">
                <span role="columnheader">Part / Material</span>
                <span role="columnheader">Cost (₱)</span>
                <span aria-hidden="true" />
              </div>
              {parts.map((part, index) => (
                <div className="lr-parts-row" role="row" key={index}>
                  <input type="text" aria-label={`Part ${index + 1} name`} placeholder="e.g. A/C compressor" value={part.name} onChange={(e) => updatePart(index, 'name', e.target.value)} />
                  <input type="number" inputMode="decimal" aria-label={`Part ${index + 1} cost in pesos`} placeholder="0.00" min="0" step="0.01" value={part.cost} onChange={(e) => updatePart(index, 'cost', e.target.value)} />
                  <button
                    type="button"
                    className="lr-icon-btn"
                    onClick={() => removePart(index)}
                    disabled={parts.length === 1}
                    title="Remove part"
                    aria-label={`Remove part ${index + 1}`}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="lr-link-btn" onClick={addPart}><Icon name="plus" size={13} /> Add Part</button>
            <div className="lr-total" aria-live="polite">
              <span>Total Repair Cost</span>
              <strong>{peso(totalCost)}</strong>
            </div>
          </section>

          <section className="lr-side-group" style={dimWhileAtShop} aria-labelledby={`${idBase}-dates`}>
            <h4 className="lr-section-label" id={`${idBase}-dates`}>Repair Date</h4>
            <div className="lr-dates">
              <div className="lr-field">
                <label className="lr-label" htmlFor={`${idBase}-start`}>Start</label>
                <DateFilterInput id={`${idBase}-start`} value={draft.repairStartedAt} onChange={(v) => set('repairStartedAt', v)} />
              </div>
              <div className="lr-field">
                <label className="lr-label" htmlFor={`${idBase}-done`}>Completion</label>
                <DateFilterInput id={`${idBase}-done`} value={draft.repairCompletedAt} onChange={(v) => set('repairCompletedAt', v)} />
              </div>
            </div>
          </section>

          <div className="lr-side-actions">
            <p className="lr-hint">
              Recorded under Ticket #{ticket.ticket_id} · {namedPartCount} part{namedPartCount === 1 ? '' : 's'} · {attachment ? '1 file attached' : 'no evidence attached'}
            </p>
            <p className="lr-hint">{nextStep}</p>
            {hasDraft && <p className="work-draft-note"><Icon name="checkCircle" size={14} /> Draft saved on this device. Attachments are not saved in drafts — re-attach before submitting.</p>}
            <button className="primary-button lr-submit" type="submit" disabled={submitting} aria-disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit Repair Log'}
            </button>
            <button className="ghost-button lr-cancel" onClick={cancel} type="button" disabled={submitting}>Cancel</button>
          </div>
        </aside>
      </form>
    </ModulePanel>
  );
}

function ExternalShopSection({ idBase, ticket, sendForm, setSendForm, returnForm, setReturnForm, onExternalSend, onExternalReturn }) {
  const nonEmpty = (form) => Object.fromEntries(Object.entries(form).filter(([, v]) => String(v).trim() !== ''));
  // Blank is fine; anything typed must be a peso amount of zero or more.
  const badCost = (v) => String(v).trim() !== '' && !(Number.parseFloat(v) >= 0);
  const estimateInvalid = badCost(sendForm.external_estimated_cost);
  const actualInvalid = badCost(returnForm.external_actual_cost);
  return (
    <section className="lr-group" aria-labelledby={`${idBase}-shop`}>
      <h4 className="lr-section-label" id={`${idBase}-shop`}>External Shop</h4>
      {!ticket.external_sent_at ? (
        <>
          <div className="lr-two-col">
            <div className="lr-field">
              <label className="lr-label" htmlFor={`${idBase}-sv`}>Shop Name <abbr className="required-asterisk" title="required">*</abbr></label>
              <input id={`${idBase}-sv`} type="text" aria-required="true" value={sendForm.external_vendor} onChange={(e) => setSendForm({ ...sendForm, external_vendor: e.target.value })} />
            </div>
            <div className="lr-field">
              <label className="lr-label" htmlFor={`${idBase}-sr`}>Why Outside? <abbr className="required-asterisk" title="required">*</abbr></label>
              <input id={`${idBase}-sr`} type="text" aria-required="true" value={sendForm.external_reason} onChange={(e) => setSendForm({ ...sendForm, external_reason: e.target.value })} />
            </div>
            <div className="lr-field">
              <label className="lr-label" htmlFor={`${idBase}-sc`}>Shop Contact</label>
              <input id={`${idBase}-sc`} type="text" value={sendForm.external_shop_contact} onChange={(e) => setSendForm({ ...sendForm, external_shop_contact: e.target.value })} />
            </div>
            <div className="lr-field">
              <label className="lr-label" htmlFor={`${idBase}-se`}>Estimated Cost (₱)</label>
              <input
                id={`${idBase}-se`}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                aria-invalid={estimateInvalid ? 'true' : undefined}
                aria-describedby={estimateInvalid ? `${idBase}-se-err` : undefined}
                value={sendForm.external_estimated_cost}
                onChange={(e) => setSendForm({ ...sendForm, external_estimated_cost: e.target.value })}
              />
              {estimateInvalid && <p className="readiness-field-error" id={`${idBase}-se-err`} role="alert">Estimated cost must be zero or more.</p>}
            </div>
          </div>
          <div className="lr-field">
            <label className="lr-label" htmlFor={`${idBase}-sw`}>Work to Be Done <abbr className="required-asterisk" title="required">*</abbr></label>
            <textarea id={`${idBase}-sw`} className="lr-textarea" rows={2} aria-required="true" value={sendForm.external_work_scope} onChange={(e) => setSendForm({ ...sendForm, external_work_scope: e.target.value })} />
          </div>
          <button
            type="button"
            className="primary-button"
            style={{ alignSelf: 'flex-start' }}
            disabled={!sendForm.external_vendor.trim() || !sendForm.external_reason.trim() || !sendForm.external_work_scope.trim() || estimateInvalid}
            onClick={() => onExternalSend(ticket, nonEmpty(sendForm))}
          >
            Mark as Sent to Shop
          </button>
        </>
      ) : !ticket.external_returned_at ? (
        <>
          <p className="lr-note">Sent to <strong>{ticket.external_vendor}</strong> on {formatDate(ticket.external_sent_at)} — waiting for it to come back.</p>
          <div className="lr-field">
            <label className="lr-label" htmlFor={`${idBase}-rn`}>Result / Condition on Return <abbr className="required-asterisk" title="required">*</abbr></label>
            <textarea id={`${idBase}-rn`} className="lr-textarea" rows={2} aria-required="true" value={returnForm.external_return_notes} onChange={(e) => setReturnForm({ ...returnForm, external_return_notes: e.target.value })} />
          </div>
          <div className="lr-two-col">
            <div className="lr-field">
              <label className="lr-label" htmlFor={`${idBase}-ra`}>Actual Cost (₱)</label>
              <input
                id={`${idBase}-ra`}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                aria-invalid={actualInvalid ? 'true' : undefined}
                aria-describedby={actualInvalid ? `${idBase}-ra-err` : undefined}
                value={returnForm.external_actual_cost}
                onChange={(e) => setReturnForm({ ...returnForm, external_actual_cost: e.target.value })}
              />
              {actualInvalid && <p className="readiness-field-error" id={`${idBase}-ra-err`} role="alert">Actual cost must be zero or more.</p>}
            </div>
            <div className="lr-field">
              <label className="lr-label" htmlFor={`${idBase}-rw2`}>Warranty Until</label>
              <DateFilterInput id={`${idBase}-rw2`} value={returnForm.warranty_until} onChange={(v) => setReturnForm({ ...returnForm, warranty_until: v })} />
            </div>
          </div>
          <button
            type="button"
            className="primary-button"
            style={{ alignSelf: 'flex-start' }}
            disabled={!returnForm.external_return_notes.trim() || actualInvalid}
            onClick={() => onExternalReturn(ticket, nonEmpty(returnForm))}
          >
            Mark as Returned
          </button>
        </>
      ) : (
        <p className="lr-note">Returned from <strong>{ticket.external_vendor}</strong> on {formatDate(ticket.external_returned_at)}. {ticket.external_return_notes}</p>
      )}
    </section>
  );
}
