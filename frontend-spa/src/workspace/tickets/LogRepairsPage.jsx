import { useEffect, useId, useMemo, useState } from 'react';
import Icon from '../../components/Icon';
import { DateFilterInput } from '../components/inputs';
import { FormErrorSummary } from '../components/states';
import { ModulePanel, RepairLogEntries } from '../components/ui';
import { useDraftState } from '../hooks/useDraftState';
import { clearDraftState } from '../lib/formHelpers';
import { formatDate } from '../lib/format';

const peso = (n) => `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// A mechanic's repair log for one sub-issue. Context (what to fix, earlier
// attempts, why it came back) comes first; the typed work is kept as a draft
// in this tab so a reload or a quick detour doesn't lose a long entry.
export function LogRepairsPage({ ticket, vehicleOptions = [], onBack, onSubmit, onDirty, onExternalSend, onExternalReturn }) {
  const id = useId();
  const draftKey = ticket?.sub_issue_id ? `draft:log-repairs:${ticket.ticket_id}:${ticket.sub_issue_id}` : null;
  const [draft, setDraft] = useDraftState(draftKey, () => ({
    repairLogs: '',
    parts: [{ name: '', cost: '' }],
    repairStartedAt: '',
    repairCompletedAt: '',
    // Pre-filled from ticket creation (pre-diagnosed sub-issues); still
    // editable since the actual repair can differ from the plan.
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
  const { parts, repairType } = draft;
  const updatePart = (index, field, value) => set('parts', parts.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  const addPart = () => set('parts', [...parts, { name: '', cost: '' }]);
  const removePart = (index) => set('parts', parts.filter((_, i) => i !== index));

  // Live total — always reflects exactly what's in the rows right now.
  const totalCost = parts.reduce((sum, p) => sum + (Number.parseFloat(p.cost) > 0 ? Number.parseFloat(p.cost) : 0), 0);
  // While a repair is out at the shop, parts/attachment/dates don't apply
  // yet; de-emphasized, not disabled, so an early note is still possible.
  const awaitingShopReturn = repairType === 'external' && !!ticket.external_sent_at && !ticket.external_returned_at;
  const sourceVehicleOptions = vehicleOptions.filter((v) => String(v.vehicle_id) !== String(ticket.vehicle?.vehicle_id));
  const hasDraft = Boolean(draft.repairLogs || parts.some((p) => p.name || p.cost));

  const validate = () => {
    const list = [];
    if (!draft.repairLogs.trim()) list.push('Describe the work you did in the repair log.');
    if (!repairType) list.push('Choose a repair type.');
    if (repairType === 'cannibalized' && !draft.sourceVehicleId) list.push('Choose the donor vehicle the part came from.');
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
    <ModulePanel description="Record the repair you did. Submitting sends it to the Custodian to verify.">
      <section className="work-context" aria-label="Work order">
        <div className="work-context-head">
          <div>
            <span className="work-context-kicker">Ticket #{ticket.ticket_id} · {ticket.maintenance_type}</span>
            <h3>{ticket.title}</h3>
            <p>Main issue: <strong>{ticket.ticket_title}</strong>{ticket.vehicle?.vehicle_name ? <> · {ticket.vehicle.vehicle_name}{ticket.vehicle.plate_number ? ` (${ticket.vehicle.plate_number})` : ''}</> : null}</p>
          </div>
          <span className="work-context-step">Next: Custodian verifies</span>
        </div>
        <p className="work-context-instructions"><strong>What to fix:</strong> {ticket.work_order_notes ?? ticket.ticket_description ?? '—'}</p>
        {ticket.confirmation_verdict === 'Reopened' && (
          <div className="notice danger" role="note">
            <h4><Icon name="alert" size={16} /> Reopened by Admin ({ticket.confirmed_by?.name ?? 'Admin'})</h4>
            <p><strong>Why:</strong> {ticket.confirmation_notes ?? 'No feedback notes provided.'}</p>
          </div>
        )}
        {ticket.verification_verdict === 'Rejected' && (
          <div className="notice warning" role="note">
            <h4><Icon name="alert" size={16} /> Rejected by Custodian ({ticket.verified_by?.name ?? 'Custodian'})</h4>
            <p><strong>Why:</strong> {ticket.verification_notes ?? 'No feedback notes provided.'}</p>
          </div>
        )}
        {ticket.repair_logs && (
          <details className="work-context-logs">
            <summary>Earlier repair logs</summary>
            <RepairLogEntries text={ticket.repair_logs} />
          </details>
        )}
      </section>

      <form className="smart-form log-repairs-form" onSubmit={handleSubmit} noValidate>
        {/* Stays in view while scrolling a long entry, so the job and the
            next step are never off-screen. */}
        <div className="work-sticky-summary" aria-hidden="true">
          <span className="work-sticky-summary-title">#{ticket.ticket_id} · {ticket.title}{ticket.vehicle?.vehicle_name ? ` — ${ticket.vehicle.vehicle_name}` : ''}</span>
          <span className="work-sticky-summary-meta">{totalCost > 0 ? `${peso(totalCost)} · ` : ''}Next: Custodian verifies</span>
        </div>
        <FormErrorSummary errors={errors} onDismiss={() => setErrors(null)} />
        {hasDraft && <p className="work-draft-note"><Icon name="checkCircle" size={14} /> Draft saved on this device. Attachments are not saved in drafts — re-attach before submitting.</p>}

        <div className="work-section">
          <label className="work-label" htmlFor={`${id}-log`}><Icon name="clipboard" size={14} /> Repair log <abbr className="required-asterisk" title="required">*</abbr></label>
          <p className="work-hint" id={`${id}-log-hint`}>What you checked, what you replaced or adjusted, and how you tested it.</p>
          <textarea id={`${id}-log`} rows={4} value={draft.repairLogs} aria-describedby={`${id}-log-hint`} onChange={(e) => set('repairLogs', e.target.value)} />
        </div>

        <div className="work-section">
          <label className="work-label" htmlFor={`${id}-type`}><Icon name="wrench" size={14} /> Repair type <abbr className="required-asterisk" title="required">*</abbr></label>
          <p className="work-hint">In-house: you fixed it with new parts. Cannibalized: a part was taken from another vehicle (needs Admin approval). External: an outside shop did the work.</p>
          <div className="work-row">
            <select id={`${id}-type`} value={repairType} onChange={(e) => set('repairType', e.target.value)}>
              <option value="">Select a repair type</option>
              <option value="in_house">In-house repair</option>
              <option value="cannibalized">Used a part from another vehicle</option>
              <option value="external">Sent to an external shop</option>
            </select>
            {repairType === 'cannibalized' && (
              <select aria-label="Donor vehicle" value={draft.sourceVehicleId} onChange={(e) => set('sourceVehicleId', e.target.value)}>
                <option value="">Donor vehicle…</option>
                {sourceVehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </select>
            )}
            {repairType === 'external' && (
              <>
                <input type="text" aria-label="External shop name" placeholder="External shop name" value={draft.externalVendor} onChange={(e) => set('externalVendor', e.target.value)} />
                <span className="work-inline-field"><span>Warranty until</span><DateFilterInput value={draft.warrantyUntil} onChange={(v) => set('warrantyUntil', v)} /></span>
              </>
            )}
          </div>
        </div>

        {repairType === 'cannibalized' && (
          <div className="work-section">
            <p className="work-label">Part taken from the donor vehicle</p>
            <div className="work-grid">
              <input type="text" aria-label="Part" placeholder="Part (e.g. Radiator)" value={draft.partNeeded} onChange={(e) => set('partNeeded', e.target.value)} />
              <input type="number" min="1" aria-label="Quantity" placeholder="Quantity" value={draft.partQuantity} onChange={(e) => set('partQuantity', e.target.value)} />
              <input type="text" aria-label="Part condition" placeholder="Part condition" value={draft.partCondition} onChange={(e) => set('partCondition', e.target.value)} />
              <span className="work-inline-field"><span>Date installed</span><DateFilterInput value={draft.partInstalledAt} onChange={(v) => set('partInstalledAt', v)} /></span>
            </div>
            <textarea rows={2} aria-label="Why this donor" placeholder="Why this donor / why not buy the part?" value={draft.cannibalReason} onChange={(e) => set('cannibalReason', e.target.value)} />
          </div>
        )}

        {repairType === 'external' && onExternalSend && (
          <ExternalShopSection ticket={ticket} sendForm={sendForm} setSendForm={setSendForm} returnForm={returnForm} setReturnForm={setReturnForm} onExternalSend={onExternalSend} onExternalReturn={onExternalReturn} />
        )}

        {awaitingShopReturn && (
          <p className="work-hint">Parts, attachment and dates apply once the vehicle is back from the shop — mark it Returned above when it comes in.</p>
        )}
        <div className={`work-columns${awaitingShopReturn ? ' is-muted' : ''}`}>
          <div className="work-section">
            <p className="work-label"><Icon name="tools" size={14} /> Parts & materials used</p>
            <div className="work-parts" role="table" aria-label="Parts and materials">
              <div className="work-parts-head" role="row">
                <span role="columnheader">Part / material</span>
                <span role="columnheader">Cost (₱)</span>
                <span aria-hidden="true" />
              </div>
              {parts.map((part, index) => (
                <div key={index} className="work-parts-row" role="row">
                  <input type="text" role="cell" aria-label={`Part ${index + 1} name`} placeholder="e.g. Brake pads" value={part.name} onChange={(e) => updatePart(index, 'name', e.target.value)} />
                  <input type="number" role="cell" inputMode="decimal" aria-label={`Part ${index + 1} cost in pesos`} placeholder="0.00" min="0" step="0.01" value={part.cost} onChange={(e) => updatePart(index, 'cost', e.target.value)} />
                  <button type="button" className="btn-delete-action icon-btn" onClick={() => removePart(index)} disabled={parts.length === 1} aria-label={`Remove part ${index + 1}`}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="ghost-button" onClick={addPart}><Icon name="plus" size={14} /> Add another part</button>
            <div className="work-total"><span>Total recorded cost</span><strong>{peso(totalCost)}</strong></div>
          </div>

          <div className="work-section">
            <p className="work-label"><Icon name="calendar" size={14} /> Repair dates</p>
            <span className="work-inline-field"><span>Started</span><DateFilterInput value={draft.repairStartedAt} onChange={(v) => set('repairStartedAt', v)} /></span>
            <span className="work-inline-field"><span>Completed</span><DateFilterInput value={draft.repairCompletedAt} onChange={(v) => set('repairCompletedAt', v)} /></span>
          </div>

          <div className="work-section">
            <p className="work-label"><Icon name="archive" size={14} /> Photo or document (optional)</p>
            {attachment ? (
              <div className="file-cabinet-drawer">
                {attachmentPreview ? (
                  <img src={attachmentPreview} alt="" className="work-attachment-thumb" />
                ) : (
                  <span className="file-cabinet-drawer-icon"><Icon name="archive" size={17} /></span>
                )}
                <span className="work-attachment-name">{attachment.name}</span>
                <button type="button" className="btn-delete-action icon-btn" onClick={() => setAttachment(null)} aria-label={`Remove ${attachment.name}`}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ) : (
              <label className="file-cabinet-dropzone">
                <span className="file-cabinet-dropzone-icon"><Icon name="archive" size={20} /></span>
                <span className="file-cabinet-dropzone-title">Choose a photo or document</span>
                <span className="file-cabinet-dropzone-hint">JPG, PNG, PDF or DOC — up to 8 MB</span>
                <input type="file" accept="image/*,.pdf,.doc,.docx" onChange={(e) => { setAttachment(e.target.files[0] ?? null); onDirty?.(); }} className="sr-only" />
              </label>
            )}
          </div>
        </div>

        <div className="form-actions">
          <button className="ghost-button" onClick={cancel} type="button" disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting} aria-disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit for verification'}
          </button>
        </div>
      </form>
    </ModulePanel>
  );
}

function ExternalShopSection({ ticket, sendForm, setSendForm, returnForm, setReturnForm, onExternalSend, onExternalReturn }) {
  const nonEmpty = (form) => Object.fromEntries(Object.entries(form).filter(([, v]) => String(v).trim() !== ''));
  // Blank is fine; anything typed must be a peso amount of zero or more.
  const badCost = (v) => String(v).trim() !== '' && !(Number.parseFloat(v) >= 0);
  const estimateInvalid = badCost(sendForm.external_estimated_cost);
  const actualInvalid = badCost(returnForm.external_actual_cost);
  return (
    <div className="work-section is-external">
      <p className="work-label">External shop</p>
      {!ticket.external_sent_at ? (
        <>
          <div className="work-grid">
            <input type="text" aria-label="Shop name (required)" placeholder="Shop name *" value={sendForm.external_vendor} onChange={(e) => setSendForm({ ...sendForm, external_vendor: e.target.value })} />
            <input type="text" aria-label="Why it went to an outside shop (required)" placeholder="Why outside? *" value={sendForm.external_reason} onChange={(e) => setSendForm({ ...sendForm, external_reason: e.target.value })} />
            <input type="text" aria-label="Shop contact" placeholder="Shop contact" value={sendForm.external_shop_contact} onChange={(e) => setSendForm({ ...sendForm, external_shop_contact: e.target.value })} />
            <input type="number" min="0" step="0.01" inputMode="decimal" aria-label="Estimated cost in pesos" placeholder="Estimated cost (₱)" aria-invalid={estimateInvalid ? 'true' : undefined} value={sendForm.external_estimated_cost} onChange={(e) => setSendForm({ ...sendForm, external_estimated_cost: e.target.value })} />
          </div>
          <textarea rows={2} aria-label="Work to be done (required)" placeholder="Work to be done *" value={sendForm.external_work_scope} onChange={(e) => setSendForm({ ...sendForm, external_work_scope: e.target.value })} />
          {estimateInvalid && <p className="readiness-field-error" role="alert">Estimated cost must be zero or more.</p>}
          <button
            type="button"
            className="primary-button"
            disabled={!sendForm.external_vendor.trim() || !sendForm.external_reason.trim() || !sendForm.external_work_scope.trim() || estimateInvalid}
            onClick={() => onExternalSend(ticket, nonEmpty(sendForm))}
          >
            Mark as sent to shop
          </button>
        </>
      ) : !ticket.external_returned_at ? (
        <>
          <p className="work-hint">Sent to <strong>{ticket.external_vendor}</strong> on {formatDate(ticket.external_sent_at)} — waiting for it to come back.</p>
          <textarea rows={2} aria-label="Result or condition on return (required)" placeholder="Result / condition on return *" value={returnForm.external_return_notes} onChange={(e) => setReturnForm({ ...returnForm, external_return_notes: e.target.value })} />
          <div className="work-row">
            <input type="number" min="0" step="0.01" inputMode="decimal" aria-label="Actual cost in pesos" placeholder="Actual cost (₱)" aria-invalid={actualInvalid ? 'true' : undefined} value={returnForm.external_actual_cost} onChange={(e) => setReturnForm({ ...returnForm, external_actual_cost: e.target.value })} />
            <span className="work-inline-field"><span>Warranty until</span><DateFilterInput value={returnForm.warranty_until} onChange={(v) => setReturnForm({ ...returnForm, warranty_until: v })} /></span>
            <button type="button" className="primary-button" disabled={!returnForm.external_return_notes.trim() || actualInvalid} onClick={() => onExternalReturn(ticket, nonEmpty(returnForm))}>
              Mark as returned
            </button>
          </div>
          {actualInvalid && <p className="readiness-field-error" role="alert">Actual cost must be zero or more.</p>}
        </>
      ) : (
        <p className="work-hint">Returned from <strong>{ticket.external_vendor}</strong> on {formatDate(ticket.external_returned_at)}. {ticket.external_return_notes}</p>
      )}
    </div>
  );
}
