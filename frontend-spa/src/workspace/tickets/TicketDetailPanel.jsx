import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../components/Icon';
import { TicketVerificationForm } from './VerificationForm';
import useDepsChanged from '../../hooks/useDepsChanged';
import api from '../../api/axios';
import { CreatableSelect } from '../components/inputs';
import { ExpandableText, FormModal, ModuleLoader, ModulePanel, PartsTags, QuietDate, RepairLogEntries, StatusBadge, TicketStageBadge, TicketStatusBadge, UserAvatarName } from '../components/ui';
import { SmartForm } from '../forms/SmartForm';
import { formatDate, resolvePhotoUrl } from '../lib/format';
import { canDo, hasRole, roleRoutes } from '../lib/permissions';
import { PHASE_STEP_COLORS, PHASE_STEP_ICONS, phaseOrder, ticketAwaiting, ticketRepairProgress, verifyOutcomeMessage } from '../lib/workflow';


// =========================================================================
// TICKET PROPOSAL REVIEW — Admin's approve/decline screen for a Custodian's
// proposed ticket (status 'Pending Approval'). Kept as its own pair of
// components (not folded into the sub-issue cards below) so the existing
// read-only rendering for every other status stays completely untouched —
// TicketDetailPanel only ever mounts this while ticket.status is exactly
// 'Pending Approval', and swaps in a plain read-only notice instead for
// anyone viewing it without ticket.approve (i.e. the proposing Custodian).
// =========================================================================

export function TicketProposalReview({ user, ticket, lookups, onApprove, onDecline, onUndecline }) {
  if (!canDo(user, 'ticket.approve')) {
    if (ticket.status === 'Declined') {
      return (
        <section className="ticket-section">
          <h4><Icon name="clipboard" size={14} /> Proposal Status</h4>
          <div className="notice danger" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="alert" size={15} /> Declined{ticket.decline_reason ? ` — ${ticket.decline_reason}` : '.'}
          </div>
        </section>
      );
    }
    return (
      <section className="ticket-section">
        <h4><Icon name="clipboard" size={14} /> Proposal Status</h4>
        <div className="notice warning" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="alert" size={15} /> Awaiting Admin review — you'll be notified once this is approved or declined.
        </div>
      </section>
    );
  }

  // Keyed by ticket id so a fresh mount (a different ticket) always starts
  // from that ticket's own values instead of whatever was last typed here.
  return <TicketProposalReviewForm key={ticket.ticket_id} ticket={ticket} lookups={lookups} onApprove={onApprove} onDecline={onDecline} onUndecline={onUndecline} />;
}

// What a cannibalized / external-shop sub-issue actually involves — the
// Admin's basis for approving it, shown wherever that sub-issue is reviewed.
export function RepairContextDetails({ si }) {
  if (!si) return null;
  const rows = si.repair_type === 'cannibalized'
    ? [
      ['Donor Vehicle', si.source_vehicle ? `${si.source_vehicle.vehicle_name} (${si.source_vehicle.plate_number})` : null],
      ['Missing / Faulty Part', si.part_missing],
      ['Part From Donor', si.part_needed],
    ]
    : si.repair_type === 'external'
      ? [
        ['Reason for Sending Out', si.external_reason],
        ['External Shop', si.external_vendor],
        ['Contact Person', si.external_contact_person],
        ['Contact Number', si.external_shop_contact],
        ['Sent By', si.external_sent_by],
        ['Estimated Cost', si.external_estimated_cost != null ? `₱${Number(si.external_estimated_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : null],
        ['Work to Be Done', si.external_work_scope],
      ]
      : [];
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return (
    <dl className="veh-kv" style={{ marginTop: 8, padding: '8px 10px', background: si.repair_type === 'cannibalized' ? '#fff7ed' : '#f5f3ff', borderRadius: 8, fontSize: '0.8rem' }}>
      {shown.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{value}</dd></div>
      ))}
    </dl>
  );
}

export function TicketProposalReviewForm({ ticket, lookups, onApprove, onDecline, onUndecline }) {
  const isDeclined = ticket.status === 'Declined';
  // Pre-fill from whatever the Custodian suggested when adding sub-issues
  // (if any) — Admin can still change it before approving.
  const suggestedMechanicId = (ticket.sub_issues ?? []).map((si) => si.suggested_mechanic_id).find(Boolean) ?? '';
  const [fields, setFields] = useState({
    ticket_description: ticket.ticket_description ?? '',
    priority: ticket.priority ?? '',
    assigned_mechanic_id: suggestedMechanicId ? String(suggestedMechanicId) : '',
  });
  const [subRows, setSubRows] = useState(() => (ticket.sub_issues ?? []).map((si) => ({
    sub_issue_id: si.sub_issue_id,
    title: si.title ?? '',
    maintenance_type: si.maintenance_type ?? '',
  })));
  const [declining, setDeclining] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationLine, setValidationLine] = useState(null);

  const setField = (name, value) => setFields((f) => ({ ...f, [name]: value }));
  const updateSubRow = (index, patch) => setSubRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  // One mechanic does the whole ticket now — approving is the single
  // moment the ticket gets both activated AND dispatched, in one step.
  const submitApprove = async () => {
    if (!fields.assigned_mechanic_id) {
      setValidationLine('Pick who will do this repair before approving.');
      return;
    }
    setValidationLine(null);
    setSubmitting(true);
    try {
      await onApprove({
        ticket_description: fields.ticket_description,
        priority: fields.priority,
        assigned_mechanic_id: fields.assigned_mechanic_id,
        sub_issues: subRows.map((r) => ({
          sub_issue_id: r.sub_issue_id,
          title: r.title,
          maintenance_type: r.maintenance_type || null,
        })),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const custodianName = ticket.assigned_custodian?.name ?? 'the Custodian';
  const repairTypeLabel = { in_house: 'In-House', cannibalized: 'Cannibalized Part', external: 'External Shop' };

  return (
    <section className="ticket-section smart-form proposal-review">
      <div className="proposal-review-head">
        <span className="proposal-review-head-icon"><Icon name="checkCircle" size={18} /></span>
        <div className="proposal-review-head-text">
          <h4>Review Proposal</h4>
          <p>Proposed by <strong>{custodianName}</strong></p>
        </div>
        <span className={`proposal-review-pill${isDeclined ? ' is-declined' : ''}`}>{isDeclined ? 'Declined' : 'Pending Approval'}</span>
      </div>

      {isDeclined && (
        <div className="notice danger" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
          <Icon name="alert" size={15} /> You declined this proposal{ticket.decline_reason ? `: ${ticket.decline_reason}` : '.'} Reopen it to put it back in Pending Approval, or approve it as-is below.
        </div>
      )}

      <div className="proposal-review-body">
        <div className="proposal-review-group">
          <div className="proposal-review-group-title"><Icon name="clipboard" size={14} /> Ticket Details</div>
          <div className="ticket-form-grid-2" style={{ padding: 0, marginBottom: 12 }}>
            <label>
              <span>Ticket</span>
              <input type="text" value={ticket.ticket_title ?? ''} readOnly title="Generated by the system" />
            </label>
            <label>
              <span>Priority</span>
              <select value={fields.priority} onChange={(e) => setField('priority', e.target.value)}>
                {(lookups.priorities ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>
          <label>
            <span>Details</span>
            <textarea rows={3} value={fields.ticket_description} onChange={(e) => setField('ticket_description', e.target.value)} />
          </label>
          <label>
            <span>Assign Mechanic <span className="required-asterisk">*</span></span>
            <select value={fields.assigned_mechanic_id} onChange={(e) => setField('assigned_mechanic_id', e.target.value)}>
              <option value="">Select who will do this repair</option>
              {(lookups.maintenance_personnel ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        </div>

        <div className="proposal-review-group">
          <div className="proposal-review-group-title">
            <Icon name="wrench" size={14} /> Sub-Issues
            {subRows.length > 0 && <span className="proposal-review-count">{subRows.length}</span>}
          </div>
      {subRows.map((row, index) => {
        const original = (ticket.sub_issues ?? []).find((s) => s.sub_issue_id === row.sub_issue_id);
        const repairType = original?.repair_type;
        return (
        <div key={row.sub_issue_id} className={`proposal-subissue is-${repairType ?? 'none'}`}>
          <div className="proposal-subissue-head">
            <span className="proposal-subissue-num">{index + 1}</span>
            <input className="proposal-subissue-title" type="text" aria-label="Sub-issue title" value={row.title} onChange={(e) => updateSubRow(index, { title: e.target.value })} />
            {repairType && <span className={`proposal-subissue-type is-${repairType}`}>{repairTypeLabel[repairType] ?? repairType}</span>}
          </div>
          <label>
            <span>Maintenance Type</span>
            <CreatableSelect
              value={row.maintenance_type}
              onChange={(v) => updateSubRow(index, { maintenance_type: v })}
              options={lookups.maintenance_types ?? []}
              newItemLabel="maintenance type"
              catalogEndpoint="/maintenance-types"
            />
          </label>
          <RepairContextDetails si={original} />
        </div>
        );
      })}
        </div>
      </div>

      {validationLine && <p className="notice danger" style={{ margin: '0 0 12px' }}><Icon name="alert" size={14} /> {validationLine}</p>}

      {declining ? (
        <div className="proposal-review-actions is-declining">
          <SmartForm
            fields={[{ label: 'Decline Reason', name: 'decline_reason', type: 'textarea', rows: 2, required: true, placeholder: 'Let the Custodian know why this was declined' }]}
            key={`decline-proposal-${ticket.ticket_id}`}
            onCancel={() => setDeclining(false)}
            onSubmit={(payload) => onDecline(payload)}
            submitLabel="Decline Proposal"
            title=""
          />
        </div>
      ) : (
        <div className="proposal-review-actions">
          <p className="proposal-review-hint">
            {isDeclined
              ? 'Reopen this proposal to put it back in Pending Approval, or approve it directly below.'
              : 'Edit anything above before approving or declining.'}
          </p>
          <div className="proposal-review-buttons">
            {isDeclined ? (
              <button className="btn-sm ghost-button" type="button" onClick={onUndecline} disabled={submitting}>
                <Icon name="undo" size={14} /> Reopen Proposal
              </button>
            ) : (
              <button className="text-danger-button" type="button" onClick={() => setDeclining(true)} disabled={submitting}>
                <Icon name="close" size={14} /> Decline
              </button>
            )}
            <button className="primary-button" type="button" onClick={submitApprove} disabled={submitting}>
              <Icon name="checkCircle" size={14} /> {submitting ? 'Approving…' : 'Approve & Assign'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// Two-column sub-issue builder: left is a single add/edit form, right is the
// numbered list of what's saved so far. Replaces the old "N open rows, each
// editable live" grid — a sub-issue is either being drafted or it's saved,
// never both at once, which is what makes Edit/Delete on the right
// unambiguous. Shared by the Custodian's Propose form and the ticket's own
// "Add Sub-issue" panel so both look and behave the same way.
export function TwoColumnSubIssueEditor({ items, onChange, maintenanceTypeOptions, mechanicOptions, minItems = 1 }) {
  const [draft, setDraft] = useState({ index: null, title: '', maintenance_type: '', suggested_mechanic_id: '' });
  const isEditing = draft.index !== null;

  const startEdit = (index) => setDraft({
    index,
    title: items[index].title ?? '',
    maintenance_type: items[index].maintenance_type ?? '',
    suggested_mechanic_id: items[index].suggested_mechanic_id ?? '',
  });
  const resetDraft = () => setDraft({ index: null, title: '', maintenance_type: '', suggested_mechanic_id: '' });

  const draftRow = () => ({ title: draft.title.trim(), maintenance_type: draft.maintenance_type || null, suggested_mechanic_id: draft.suggested_mechanic_id || null });

  // "Save" commits whatever's currently typed — appends it as a new
  // sub-issue, or updates the one being edited if a row's pencil icon was
  // clicked. "+ Add" doesn't commit anything; it just clears the fields
  // (and drops out of edit mode) so a fresh sub-issue can be typed next.
  const save = () => {
    if (!draft.title.trim()) return;
    const row = draftRow();
    if (isEditing) {
      onChange(items.map((it, i) => (i === draft.index ? { ...it, ...row } : it)));
    } else {
      onChange([...items, row]);
    }
    resetDraft();
  };

  const remove = (index) => {
    onChange(items.filter((_, i) => i !== index));
    if (draft.index === index) resetDraft();
  };

  const subissueBoxStyle = { border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, background: '#fff' };
  const subissueBoxHeadStyle = { display: 'block', fontSize: '0.8rem', fontWeight: 700, color: '#0f172a', marginBottom: 10 };

  return (
    <div className="subissue-two-col" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 18, alignItems: 'start' }}>
      <div style={subissueBoxStyle}>
        <span style={subissueBoxHeadStyle}>Sub-Issue</span>
        <label>
          <span>Subissue</span>
          <input
            type="text"
            placeholder="e.g. Low coolant level"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
          />
        </label>
        <label style={{ marginTop: 10 }}>
          <span>Maintenance Type</span>
          <CreatableSelect
            value={draft.maintenance_type}
            onChange={(v) => setDraft((d) => ({ ...d, maintenance_type: v }))}
            options={maintenanceTypeOptions ?? []}
            placeholder="Select a category or type to add new"
            newItemLabel="maintenance type"
            catalogEndpoint="/maintenance-types"
          />
        </label>
        {mechanicOptions && (
          <label style={{ marginTop: 10 }}>
            <span>Maintenance Personnel <span className="muted" style={{ fontWeight: 400 }}>(optional — Admin can change this)</span></span>
            <select
              value={draft.suggested_mechanic_id}
              onChange={(e) => setDraft((d) => ({ ...d, suggested_mechanic_id: e.target.value }))}
            >
              <option value="">Unassigned — Admin will decide</option>
              {mechanicOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="primary-button" disabled={!draft.title.trim()} onClick={save}>
            <Icon name="plus" size={13} /> Add
          </button>
        </div>
      </div>

      <div style={subissueBoxStyle}>
        <span style={subissueBoxHeadStyle}>Saved Subissues</span>
        {items.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.85rem' }}>Nothing added yet.</p>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((it, index) => (
              <li key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#eff6ff', color: '#2563eb', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, flexShrink: 0 }}>{index + 1}</span>
                <span style={{ flex: 1, fontSize: '0.85rem' }}>
                  {it.title}
                  {it.maintenance_type && <span className="muted"> — {it.maintenance_type}</span>}
                  {mechanicOptions && it.suggested_mechanic_id && (
                    <span className="muted"> · suggested: {mechanicOptions.find((m) => String(m.id) === String(it.suggested_mechanic_id))?.name ?? '—'}</span>
                  )}
                </span>
                <button type="button" className="icon-btn" title="Edit" aria-label={`Edit sub-issue ${index + 1}: ${it.title}`} onClick={() => startEdit(index)}><Icon name="edit" size={13} /></button>
                <button type="button" className="icon-btn btn-delete-action" title="Delete" aria-label={`Delete sub-issue ${index + 1}: ${it.title}`} disabled={items.length <= minItems} onClick={() => remove(index)}><Icon name="trash" size={13} /></button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// TICKET DETAIL PANEL — shown when admin clicks a ticket row
// =========================================================================

export function TicketDetailPanel({ user, userId, ticket, lookups, onAddSubIssue, onEditSubIssue, onDeleteSubIssue, onAssignTicketMechanic, onReassignCustodian, onReopenDone, onLogRepairs, onSubmitForVerification, onVerifyTicket, onViewIssue, onCancel, onUncancel, onDelete, onRequestConfirmation, onApproveCannibalization, onRejectCannibalization, onApproveProposal, onDeclineProposal, onUndeclineProposal, onClose, relatedTickets, onOpenTicket, asPage = false }) {
  const [subDraft, setSubDraft] = useState(null); // { id|null, title, maintenance_type }
  // Activity History shows the latest few entries until expanded.
  const [showAllActivity, setShowAllActivity] = useState(false);
  // Cannibalization approval — tracks which sub-issue's reject form is
  // open; Approve has no form of its own (it needs no input beyond the
  // click itself), so it doesn't need a tracked id.
  const [reviewingCannibalizationId, setReviewingCannibalizationId] = useState(null);
  const [approvingCannibalId, setApprovingCannibalId] = useState(null);
  const [reassigningCustodian, setReassigningCustodian] = useState(false);
  const [reassigningMechanic, setReassigningMechanic] = useState(false);
  const [editingDoneId, setEditingDoneId] = useState(null);
  // The ticket's one assigned Custodian giving their plain attestation —
  // replaces the old per-sub-issue verify/confirm pair with a single
  // ticket-level step.
  const [verifying, setVerifying] = useState(false);
  const [submittingForVerification, setSubmittingForVerification] = useState(false);
  // Which sub-issue cards show their full repair details. null = untouched,
  // so a short list starts open and a long one starts collapsed.
  const [expandedSubIds, setExpandedSubIds] = useState(null);

  if (!ticket) return null;

  const subIssues = ticket.sub_issues ?? [];
  const progress = ticket.progress ?? {
    done: subIssues.filter((s) => s.status === 'Done').length,
    deferred: subIssues.filter((s) => s.status === 'Deferred').length,
    total: subIssues.length,
  };
  const defaultExpandedSubs = subIssues.length <= 3 ? subIssues.map((s) => s.sub_issue_id) : [];
  const expandedSubs = expandedSubIds ?? defaultExpandedSubs;
  const isSubExpanded = (id) => expandedSubs.includes(id);
  const allSubsExpanded = subIssues.length > 0 && subIssues.every((s) => expandedSubs.includes(s.sub_issue_id));
  const toggleSubExpanded = (id) => setExpandedSubIds((prev) => {
    const ids = prev ?? defaultExpandedSubs;
    return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  });
  const isAdminUser = hasRole(user, 'Admin');
  const isAssignedMechanic = ticket.assigned_mechanic_id != null && String(ticket.assigned_mechanic_id) === String(userId);
  const isAssignedCustodian = ticket.assigned_custodian_id != null && String(ticket.assigned_custodian_id) === String(userId);
  const inRepairCount = subIssues.filter((s) => s.status === 'Under Repair').length;
  const loggedCount = subIssues.filter((s) => s.status === 'For Inspection').length;
  const pendingApprovalCount = subIssues.filter((s) => s.status === 'Pending Approval').length;
  // Every sub-issue has to have its repair logged (For Inspection) before
  // the mechanic can hand the whole ticket to the Custodian — a cannibalized
  // line item still sitting at Pending Approval naturally blocks this,
  // since it isn't at For Inspection yet either.
  const allLogged = subIssues.length > 0 && subIssues.every((s) => s.status === 'For Inspection');
  const canSubmitForVerification = ticket.status === 'Active' && isAssignedMechanic && allLogged && canDo(user, 'ticket.submit_for_verification');
  const canVerifyTicket = ticket.status === 'For Verification' && isAssignedCustodian && canDo(user, 'ticket.verify');
  const ticketCost = subIssues.reduce((sum, s) => sum + (Number(s.maintenance_cost) || 0), 0);
  // Progress that actually moves while the ticket is Active: repairs the
  // mechanic has logged (sub-issues only become Done when the ticket closes).
  const repairProgress = ticketRepairProgress(ticket);
  const resolvedPercent = repairProgress.percent;
  const awaiting = ticketAwaiting(ticket);
  const awaitingIsMe = awaiting.person?.id != null && String(awaiting.person.id) === String(userId);
  const awaitingWho = awaiting.role
    ? `${awaiting.role}${awaitingIsMe ? ' · You' : awaiting.person?.name ? ` · ${awaiting.person.name}` : ''}`
    : 'No one';
  const remainingToLog = Math.max(0, repairProgress.total - repairProgress.logged);
  // Why the mechanic's Submit button is unavailable, when it is.
  const submitBlockedReason = subIssues.length === 0
    ? 'This ticket has no sub-issues to log yet.'
    : pendingApprovalCount > 0
      ? `${pendingApprovalCount} cannibalized repair${pendingApprovalCount === 1 ? '' : 's'} still ${pendingApprovalCount === 1 ? 'needs' : 'need'} Admin approval.`
      : `Log the remaining ${remainingToLog} repair${remainingToLog === 1 ? '' : 's'} first (${repairProgress.label}).`;
  const showSubmitBlocked = ticket.status === 'Active' && isAssignedMechanic && !allLogged && canDo(user, 'ticket.submit_for_verification') && Boolean(onSubmitForVerification);
  const showVerifyBlocked = ticket.status === 'Active' && isAssignedCustodian && canDo(user, 'ticket.verify');
  const ticketLabel = `Ticket #${ticket.ticket_id}${ticket.ticket_title ? ` "${ticket.ticket_title}"` : ''}${ticket.vehicle?.vehicle_name ? ` on ${ticket.vehicle.vehicle_name}${ticket.vehicle.plate_number ? ` (${ticket.vehicle.plate_number})` : ''}` : ''}`;
  const otherOpenTickets = Array.isArray(relatedTickets) ? relatedTickets : null;
  const activity = Array.isArray(ticket.activity) ? ticket.activity : [];
  const ACTIVITY_PREVIEW = 5;
  const shownActivity = showAllActivity ? activity : activity.slice(-ACTIVITY_PREVIEW);
  const nextSignal = (() => {
    if (ticket.status === 'Cancelled') return { tone: 'alert', label: 'Ticket cancelled', detail: 'Reopen it only if work needs to resume.' };
    if (ticket.status === 'Closed') return { tone: 'ok', label: 'Closed', detail: 'The Custodian verified the repair. Closed tickets stay on record and can no longer be cancelled or deleted.' };
    if (ticket.status === 'Declined') return canDo(user, 'ticket.approve')
      ? { tone: 'alert', label: 'Declined', detail: 'Reopen the proposal to reconsider it, or approve it as-is below.' }
      : { tone: 'alert', label: 'Declined', detail: 'An Admin declined this proposal. They can reopen it if anything changes.' };
    if (ticket.status === 'Pending Approval') return canDo(user, 'ticket.approve')
      ? { tone: 'warn', label: 'Review proposal', detail: 'A Custodian proposed this ticket — review and approve or decline it below.' }
      : { tone: 'active', label: 'Awaiting Admin review', detail: "You'll be notified once an Admin approves or declines it." };
    if (ticket.status === 'For Verification') return isAssignedCustodian
      ? { tone: 'warn', label: 'Verify repair', detail: 'The mechanic says this is done — confirm it before the ticket closes.' }
      : { tone: 'active', label: 'Awaiting verification', detail: `${ticket.assigned_custodian?.name ?? 'The assigned Custodian'} needs to verify this repair.` };
    if (canSubmitForVerification) return { tone: 'warn', label: 'Submit for verification', detail: 'Every sub-issue is logged — submit the ticket for the Custodian to verify.' };
    if (isAdminUser && pendingApprovalCount > 0) return { tone: 'warn', label: 'Approve cannibalized repair', detail: `${pendingApprovalCount} repair${pendingApprovalCount === 1 ? '' : 's'} using a part from another vehicle ${pendingApprovalCount === 1 ? 'needs' : 'need'} your approval.` };
    if (pendingApprovalCount > 0) return { tone: 'active', label: 'Awaiting Admin approval', detail: 'A cannibalized repair is waiting for Admin approval before it can be logged as done.' };
    if (!isAdminUser && isAssignedMechanic && inRepairCount > 0) return { tone: 'warn', label: 'Log your repairs', detail: `${inRepairCount} sub-issue${inRepairCount === 1 ? '' : 's'} still ${inRepairCount === 1 ? 'needs' : 'need'} a repair log.` };
    if (inRepairCount > 0) return { tone: 'active', label: 'Repair in progress', detail: `${ticket.assigned_mechanic?.name ?? 'The assigned mechanic'} is still working on ${inRepairCount} sub-issue${inRepairCount === 1 ? '' : 's'}.` };
    return { tone: 'active', label: 'Work in motion', detail: 'Follow the active handoff shown in the repair board.' };
  })();
  const processStats = [
    { icon: 'list', label: 'Sub-issues', value: subIssues.length },
    { icon: 'wrench', label: 'In repair', value: inRepairCount },
    { icon: 'search', label: 'Logged', value: loggedCount },
    { icon: 'clipboard', label: 'Cost', value: ticketCost ? `PHP ${ticketCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'PHP 0.00' },
  ];

  // "How long has this been sitting?" — the aging signal. Flagged past 30 days.
  const daysOpen = ticket.days_open;
  const isAging = ticket.status !== 'Closed' && ticket.status !== 'Cancelled' && typeof daysOpen === 'number' && daysOpen >= 30;

  // Confirmations name the exact ticket (number, Main Issue and vehicle) so
  // nobody cancels or deletes the wrong one from a similar-looking page.
  const requestDelete = () => {
    onRequestConfirmation({
      title: `Delete Ticket #${ticket.ticket_id}?`,
      message: `Delete ${ticketLabel}? It leaves the active ticket list and is kept in Archives as Deleted, where only an Admin can reopen it. If it should stay on record as-is (for example it was raised by mistake but already worked on), cancel it instead.`,
      confirmLabel: `Delete Ticket #${ticket.ticket_id}`,
      variant: 'danger',
      onConfirm: () => onDelete(ticket),
    });
  };

  const requestCancel = () => {
    onRequestConfirmation({
      title: `Cancel Ticket #${ticket.ticket_id}?`,
      message: `Cancel ${ticketLabel}? All work on it stops and the assigned people are no longer waited on. It stays on record and can be reopened later if needed.`,
      confirmLabel: `Cancel Ticket #${ticket.ticket_id}`,
      variant: 'danger',
      onConfirm: () => onCancel(ticket),
    });
  };

  const requestUncancel = () => {
    onRequestConfirmation({
      title: `Reopen Ticket #${ticket.ticket_id}?`,
      message: `Reopen ${ticketLabel}? It goes back to Active so work can resume.`,
      confirmLabel: `Reopen Ticket #${ticket.ticket_id}`,
      variant: 'primary',
      onConfirm: () => onUncancel(ticket),
    });
  };

  const panel = (
      <div className={`ticket-detail-panel${asPage ? ' is-page' : ''}`} aria-labelledby={`ticket-${ticket.ticket_id}-title`} onClick={asPage ? undefined : (e) => e.stopPropagation()}>
        <section className={`ticket-process-hero is-${nextSignal.tone}`} aria-label="Ticket summary">
          <div
            className="ticket-process-meter"
            role="progressbar"
            aria-label="Repairs logged"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={repairProgress.total > 0 ? resolvedPercent : undefined}
            aria-valuetext={repairProgress.label}
            style={{ '--ticket-progress': `${resolvedPercent}%` }}
          >
            <div className="ticket-process-meter-core">
              <span>{ticket.status === 'Closed' ? 'Verified' : 'Logged'}</span>
              {/* A zero-sub-issue ticket (inspection found nothing to repair) has
                  nothing to measure progress against — "0%" would read as
                  "nothing done" right next to a "ready to close" banner. */}
              <strong>{repairProgress.total > 0 ? `${resolvedPercent}%` : '—'}</strong>
              <small>{repairProgress.total > 0 ? `${repairProgress.logged}/${repairProgress.total} repairs` : 'No sub-issues'}</small>
            </div>
          </div>
          <div className="ticket-process-hero-main">
            <div className="ticket-process-kicker">
              <span>Ticket #{ticket.ticket_id}</span>
              {typeof daysOpen === 'number' && (
                <span>{daysOpen === 0 ? 'Opened today' : `${daysOpen} day${daysOpen === 1 ? '' : 's'} open`}</span>
              )}
            </div>
            <span className="p23-eyebrow">Main Issue</span>
            <h3 className="ticket-detail-title" id={`ticket-${ticket.ticket_id}-title`}>{ticket.ticket_title}</h3>
            <div className="ticket-detail-meta">
              <TicketStatusBadge value={ticket.priority} />
              <TicketStageBadge ticket={ticket} variant="pill" />
              {isAging && (
                <span className="status-badge ticket-cancelled" title="This ticket has been open a long time; resolve or close it.">
                  <Icon name="alert" size={12} /> Aging: {daysOpen} days
                </span>
              )}
              {ticket.recurrence_count > 0 && (
                <span className="status-badge rework-warning" title="This Main Issue was already fixed on this vehicle recently; a recurring failure.">
                  <Icon name="undo" size={12} /> Recurring: {ticket.recurrence_count + 1}
                  {['st', 'nd', 'rd'][ticket.recurrence_count] ?? 'th'} time
                </span>
              )}
            </div>
            {progress.deferred > 0 && (
              <div className="ticket-detail-subline">
                <span><Icon name="alert" size={12} /> {progress.deferred} deferred</span>
              </div>
            )}
            {/* One-glance summary: what, where, which phase, whose turn and
                how far along — so nobody has to scan the cards below for it. */}
            <dl className="p23-ticket-facts">
              <div>
                <dt>Vehicle</dt>
                <dd>{ticket.vehicle?.vehicle_name ?? '—'}{ticket.vehicle?.plate_number ? ` · ${ticket.vehicle.plate_number}` : ''}</dd>
              </div>
              <div>
                <dt>Phase</dt>
                <dd>{ticket.status ?? '—'}</dd>
              </div>
              <div>
                <dt>Custodian (owner)</dt>
                <dd>{ticket.assigned_custodian?.name ?? '—'}</dd>
              </div>
              <div>
                <dt>Mechanic</dt>
                <dd>{ticket.assigned_mechanic?.name ?? 'Not assigned yet'}</dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd>{repairProgress.label}</dd>
              </div>
            </dl>
          </div>

          <div className="ticket-process-next-card">
            {asPage ? null : (
              <button className="icon-btn ticket-process-close" onClick={onClose} type="button" title="Close" aria-label="Close"><Icon name="close" size={18} /></button>
            )}
            <span className="ticket-process-next-label">Next step</span>
            <strong>{nextSignal.label}</strong>
            <p>{nextSignal.detail}</p>
            <p className={`p23-awaiting${awaitingIsMe ? ' is-me' : ''}${awaiting.role ? '' : ' is-none'}`} role="status">
              <Icon name="flag" size={13} />
              <span>
                {awaiting.role ? 'Awaiting ' : ''}<strong>{awaiting.role ? awaitingWho : awaiting.task}</strong>
                {awaiting.role && awaiting.task ? ` — ${awaitingIsMe ? 'your turn to ' : 'to '}${awaiting.task}` : ''}
              </span>
            </p>
            <div className="ticket-process-stat-grid">
              {processStats.map((stat) => (
                <div key={stat.label} className="ticket-process-stat">
                  <span className="ticket-process-stat-icon"><Icon name={stat.icon} size={14} /></span>
                  <strong className="ticket-process-stat-value">{stat.value}</strong>
                  <span className="ticket-process-stat-label">{stat.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {ticket.status === 'Cancelled' ? (
          <p className="notice danger ticket-process-cancelled"><Icon name="alert" size={15} /> This ticket was cancelled.</p>
        ) : ticket.status === 'Declined' ? (
          <p className="notice danger ticket-process-cancelled">
            <Icon name="alert" size={15} /> This proposal was declined.{ticket.decline_reason ? ` Reason: ${ticket.decline_reason}` : ''}
          </p>
        ) : (
          <div className="ticket-process-flow" role="list" aria-label="Ticket progress">
            {phaseOrder.map((s, i) => {
              const current = phaseOrder.indexOf(ticket.status);
              const state = i < current ? 'done' : i === current ? 'active' : 'upcoming';
              const hint = {
                'Pending Approval': 'Admin approves & assigns a mechanic',
                Active: 'Mechanic repairs, logs, submits',
                'For Verification': 'Custodian verifies or returns for repair',
                Closed: 'Verified & archived',
              }[s];
              return (
                <div key={s} className={`ticket-process-flow-step is-${state}`} role="listitem" aria-current={state === 'active' ? 'step' : undefined} style={state === 'active' ? { '--ticket-flow-active-color': PHASE_STEP_COLORS[s] } : undefined}>
                  <span className="ticket-process-flow-marker" style={state === 'active' ? { background: PHASE_STEP_COLORS[s], borderColor: PHASE_STEP_COLORS[s] } : undefined}>
                    {state === 'done' ? <Icon name="checkCircle" size={16} /> : <Icon name={PHASE_STEP_ICONS[s]} size={16} />}
                  </span>
                  <span className="ticket-process-flow-label p23-flow-label" style={state !== 'upcoming' ? { '--p23-step-color': PHASE_STEP_COLORS[s] } : undefined}>{s}</span>
                  <span className="sr-only">{state === 'done' ? ' (done)' : state === 'active' ? ' (current phase)' : ' (upcoming)'}</span>
                  <small>{hint}</small>
                </div>
              );
            })}
          </div>
        )}
        <div className="ticket-detail-body ticket-detail-body-columns">
          <div className="ticket-detail-col-left">
            <section className="ticket-section">
              <h4><Icon name="vehicle" size={14} /> Overview</h4>
              <div className="ticket-preview-card ticket-preview-card--detail ticket-preview-card--stacked">
                {ticket.vehicle?.photo_url ? (
                  <img className="ticket-preview-photo" src={resolvePhotoUrl(ticket.vehicle.photo_url)} alt={ticket.vehicle.vehicle_name} />
                ) : (
                  <span className="ticket-preview-photo ticket-preview-photo-empty"><Icon name="vehicle" size={34} /></span>
                )}
                <div className="ticket-preview-body">
                  <strong>{ticket.vehicle?.vehicle_name}</strong>
                  <span>{ticket.vehicle?.plate_number} &middot; {ticket.vehicle?.category?.category_name ?? 'Unclassified'}</span>
                  <span className="muted">{[ticket.vehicle?.brand, ticket.vehicle?.model].filter(Boolean).join(' ') || '—'} &middot; {ticket.vehicle?.current_location ?? 'No location on file'}</span>
                  <div className="ticket-preview-badges">
                    <StatusBadge value={ticket.vehicle?.status} />
                    <StatusBadge value={ticket.vehicle?.condition} />
                  </div>
                </div>
              </div>
              <div className="ticket-detail-description-box">
                <span className="ticket-detail-label">Description</span>
                <ExpandableText text={ticket.ticket_description} className="muted" lines={3} />
              </div>
              {ticket.issue_report_id && onViewIssue && canDo(user, 'issue.view') && (
                <button className="ghost-button" type="button" style={{ marginTop: 10 }} onClick={() => onViewIssue(ticket.issue_report_id)}>
                  <Icon name="alert" size={13} /> From Issue Report #{ticket.issue_report_id}
                </button>
              )}
              {/* Other unfinished tickets on the same vehicle — from the ticket
                  list already loaded for this page, so it costs no request.
                  Hidden entirely when that list isn't available. */}
              {otherOpenTickets && (
                <div className="p23-related">
                  <span className="ticket-detail-label">
                    Other open tickets on this vehicle{!isAdminUser ? ' (assigned to you)' : ''}
                    <span className="ticket-count-pill">{otherOpenTickets.length}</span>
                  </span>
                  {otherOpenTickets.length === 0 ? (
                    <p className="muted p23-related-empty">None — this is the only open ticket for this vehicle.</p>
                  ) : (
                    <ul className="p23-related-list">
                      {otherOpenTickets.map((t) => (
                        <li key={t.ticket_id}>
                          <button type="button" className="p23-related-item" onClick={() => onOpenTicket?.(t)} disabled={!onOpenTicket}>
                            <span className="p23-related-id">#{t.ticket_id}</span>
                            <span className="p23-related-title">{t.ticket_title}</span>
                            <TicketStatusBadge value={t.status} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

            {ticket.assigned_custodian_id && (
              <section className={`ticket-section${ticket.inspection_result === 'Needs Maintenance' ? ' ticket-section--flag-warn' : ticket.inspection_result === 'No Issues' ? ' ticket-section--flag-ok' : ''}`}>
                <h4><Icon name="search" size={14} /> Custodian Inspection</h4>
                <div className="ticket-kv-row" style={{ marginBottom: (ticket.inspection_notes ? 8 : 0) }}>
                  <div>
                    <span>Assigned To</span>
                    <UserAvatarName user={ticket.assigned_custodian} />
                  </div>
                  {ticket.inspection_result && (
                    <div>
                      <span>Result</span>
                      <TicketStatusBadge value={ticket.inspection_result} />
                    </div>
                  )}
                </div>
                {ticket.inspection_notes && <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>{ticket.inspection_notes}</p>}

                {/* This Custodian is hard-locked as both the inspector AND the
                    verifier of every repair on this ticket. If they become
                    unavailable the ticket is otherwise unworkable — and if it's
                    still Open it can't even be closed. Same escape hatch the
                    mechanic work orders already have. */}
                {canDo(user, 'ticket.reassign_custodian') && onReassignCustodian && !['Closed', 'Cancelled'].includes(ticket.status) && (
                  <button className="ghost-button btn-reassign-action" style={{ marginTop: 10 }} type="button" onClick={() => setReassigningCustodian(true)}>
                    <Icon name="undo" size={12} /> Reassign Custodian
                  </button>
                )}
              </section>
            )}

            {canDo(user, 'ticket.reassign_custodian') && onReassignCustodian && (
              <FormModal open={reassigningCustodian} title="Reassign Custodian" onClose={() => setReassigningCustodian(false)}>
                <p className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>
                  Hand this ticket to a different Custodian (e.g. the current one is on leave). Any repairs already awaiting verification move with it.
                </p>
                <SmartForm
                  fields={[
                    { label: 'Reassign to Custodian', name: 'assigned_custodian_id', options: (lookups.custodians ?? []).filter((c) => c.id !== ticket.assigned_custodian_id).map((c) => ({ value: c.id, label: c.name })), required: true, type: 'select' },
                    { label: 'Reason for reassigning', name: 'reassign_reason', required: true, type: 'textarea', rows: 2 },
                  ]}
                  key={`reassign-custodian-${ticket.ticket_id}`}
                  onCancel={() => setReassigningCustodian(false)}
                  onSubmit={(payload) => onReassignCustodian(ticket, payload).then((ok) => { if (ok !== false) setReassigningCustodian(false); })}
                  submitLabel="Reassign Custodian"
                  title=""
                />
              </FormModal>
            )}

            {ticket.assigned_mechanic_id && (
              <section className="ticket-section">
                <h4><Icon name="wrench" size={14} /> Assigned Mechanic</h4>
                <div className="ticket-kv-row">
                  <div>
                    <span>Doing the repair</span>
                    <div className="ticket-person-row">
                      <UserAvatarName user={ticket.assigned_mechanic} />
                      <span className="ticket-role-tag">Maintenance Personnel</span>
                    </div>
                  </div>
                </div>
                {canDo(user, 'ticket.assign_mechanic') && onAssignTicketMechanic && !['Closed', 'Cancelled'].includes(ticket.status) && (
                  <button className="ghost-button btn-reassign-action" style={{ marginTop: 10 }} type="button" onClick={() => setReassigningMechanic(true)}>
                    <Icon name="undo" size={12} /> Reassign Mechanic
                  </button>
                )}
              </section>
            )}

            {canDo(user, 'ticket.assign_mechanic') && onAssignTicketMechanic && (
              <FormModal open={reassigningMechanic} title="Reassign Mechanic" onClose={() => setReassigningMechanic(false)}>
                <p className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>
                  Hand the whole ticket to a different mechanic (e.g. the current one is out sick). If it was already submitted for verification, this sends it back to Active — the new mechanic's work is what needs verifying.
                </p>
                <SmartForm
                  fields={[
                    { label: 'Reassign to Mechanic', name: 'assigned_mechanic_id', options: (lookups.maintenance_personnel ?? []).filter((m) => m.id !== ticket.assigned_mechanic_id).map((m) => ({ value: m.id, label: m.name })), required: true, type: 'select' },
                    { label: 'Reason for reassigning', name: 'reassign_reason', required: true, type: 'textarea', rows: 2 },
                  ]}
                  key={`reassign-mechanic-${ticket.ticket_id}`}
                  onCancel={() => setReassigningMechanic(false)}
                  onSubmit={(payload) => onAssignTicketMechanic(ticket, payload).then((ok) => { if (ok !== false) setReassigningMechanic(false); })}
                  submitLabel="Reassign Mechanic"
                  title=""
                />
              </FormModal>
            )}

            {/* Recaps the ticket's own lifecycle dates in one place — also
                fills the left column so it doesn't end in a large empty gap
                below the (usually taller) Sub-Issues column on the right. */}
            <section className="ticket-section">
              <h4><Icon name="calendar" size={14} /> Ticket Timeline</h4>
              <div className="ticket-timeline">
                {[
                  { label: 'Created', at: ticket.created_at, by: ticket.created_by, icon: 'clipboard' },
                  ticket.assigned_at && { label: 'Assigned to Custodian', at: ticket.assigned_at, by: ticket.assigned_custodian, icon: 'search' },
                  // Pre-Diagnosed skips inspection entirely — inspected_by is
                  // stamped with whoever CREATED the ticket (usually Admin),
                  // not the Custodian above, so it's labelled by what actually
                  // happened instead of implying an inspection that didn't.
                  ticket.inspected_at && { label: ticket.inspected_by?.id === ticket.assigned_custodian_id ? 'Inspected' : 'Pre-diagnosed', at: ticket.inspected_at, by: ticket.inspected_by, icon: 'search' },
                  ticket.closed_at && { label: 'Closed', at: ticket.closed_at, by: ticket.closed_by, icon: 'checkCircle' },
                ].filter(Boolean).map((ev, i, all) => (
                  <div key={ev.label} className="ticket-timeline-item">
                    <div className="ticket-timeline-marker">
                      <span className="ticket-timeline-dot"><Icon name={ev.icon} size={11} /></span>
                      {i < all.length - 1 && <span className="ticket-timeline-line" />}
                    </div>
                    <div className="ticket-timeline-content">
                      <p>{ev.label}</p>
                      <div className="ticket-timeline-meta">
                        {ev.by?.name && <span>by {ev.by.name}</span>}
                        <QuietDate value={ev.at} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Every recorded action on this ticket (approve, log, submit,
                  verify, return for repair...), oldest first, each with its
                  full date and time — from the ticket's own Activity Log. */}
              {activity.length > 0 && (
                <div className="p23-activity">
                  <h5 id={`ticket-${ticket.ticket_id}-activity`}>Activity History <span className="ticket-count-pill">{activity.length}</span></h5>
                  {activity.length > ACTIVITY_PREVIEW && (
                    <button
                      type="button"
                      className="p23-link-button"
                      aria-expanded={showAllActivity}
                      onClick={() => setShowAllActivity((v) => !v)}
                    >
                      {showAllActivity ? `Show latest ${ACTIVITY_PREVIEW} only` : `Show all ${activity.length} entries`}
                    </button>
                  )}
                  <ol className="p23-activity-list" aria-labelledby={`ticket-${ticket.ticket_id}-activity`}>
                    {shownActivity.map((entry) => (
                      <li key={entry.log_id} className="p23-activity-item">
                        <div className="p23-activity-head">
                          <strong>{entry.action}</strong>
                          {entry.created_at && <time dateTime={entry.created_at}>{formatDate(entry.created_at)}</time>}
                        </div>
                        {entry.details && <p>{entry.details}</p>}
                        <span className="p23-activity-by">
                          by {entry.user?.name ?? 'System'}{entry.role ? ` (${entry.role})` : ''}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>
          </div>

          <div className="ticket-detail-col-right">
          {/* Custodian-proposed ticket awaiting Admin review — a completely
              separate block from the normal sub-issue cards just below
              (which are explicitly excluded for this one status right
              after), so nothing about how every other status renders
              changes. */}
          {(ticket.status === 'Pending Approval' || ticket.status === 'Declined') && (
            <TicketProposalReview
              user={user}
              ticket={ticket}
              lookups={lookups}
              onApprove={(payload) => onApproveProposal(ticket, payload)}
              onDecline={(payload) => onDeclineProposal(ticket, payload)}
              onUndecline={() => onUndeclineProposal(ticket)}
            />
          )}
          {ticket.status !== 'Open' && ticket.status !== 'Pending Approval' && ticket.status !== 'Declined' && (
            <section className="ticket-section">
              <h4>
                <Icon name="wrench" size={14} /> Sub-Issues
                {progress.total > 0 && <span className="ticket-count-pill">{progress.total}</span>}
                {repairProgress.total > 0 && <span className="p23-subissue-progress">{repairProgress.label}</span>}
                <span
                  className="ticket-section-info-icon"
                  title="Keep sub-issues and the mechanic's Maintenance Type scoped to this Main Issue — an unrelated repair belongs on its own ticket instead."
                  role="img"
                  aria-label="Keep sub-issues scoped to this Main Issue — an unrelated repair belongs on its own ticket instead."
                >
                  <Icon name="info" size={13} />
                </span>
                {subIssues.length > 1 && (
                  <button
                    type="button"
                    className="ticket-subissue-toggle-all"
                    aria-expanded={allSubsExpanded}
                    onClick={() => setExpandedSubIds(allSubsExpanded ? [] : subIssues.map((s) => s.sub_issue_id))}
                  >
                    {allSubsExpanded ? 'Collapse all' : 'Expand all'}
                  </button>
                )}
              </h4>

              {/* The actionable "ready to close" banner lives once, down in
                  ticket-detail-actions, covering both this case (no
                  sub-issues) and the all-resolved-via-defer case — so there's
                  one consistent prompt instead of two different ones. */}
              {subIssues.length === 0 && (
                <p className="muted">No sub-issues — inspection found nothing to repair.</p>
              )}

              {/* Adding a brand-new sub-issue to an already-Active ticket is
                  deliberately not offered — every sub-issue is supposed to be
                  settled at Admin approval, before repair starts. This inline
                  form still renders for editing an existing sub-issue (the
                  pencil icon below sets subDraft with its id), since that's
                  unchanged — only the "Add Sub-issue" entry point is gone. */}
              {subDraft && (
                <div className="ticket-inline-form" style={{ marginBottom: 10, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      type="text"
                      autoFocus
                      placeholder="What else is wrong?"
                      value={subDraft.title}
                      onChange={(e) => setSubDraft({ ...subDraft, title: e.target.value })}
                      style={{ flex: '2 1 240px' }}
                    />
                    <input
                      type="text"
                      list="subissue-maintenance-types"
                      placeholder="Maintenance type (optional)"
                      value={subDraft.maintenance_type}
                      onChange={(e) => setSubDraft({ ...subDraft, maintenance_type: e.target.value })}
                      style={{ flex: '1 1 180px' }}
                    />
                    <datalist id="subissue-maintenance-types">
                      {(lookups.maintenance_types ?? []).map((t) => <option key={t.name ?? t} value={t.name ?? t} />)}
                    </datalist>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!subDraft.title.trim()}
                      onClick={async () => {
                        const payload = { title: subDraft.title.trim(), maintenance_type: subDraft.maintenance_type.trim() || null };
                        const ok = subDraft.id ? await onEditSubIssue(ticket, subDraft.id, payload) : await onAddSubIssue(ticket, payload);
                        if (ok !== false) setSubDraft(null);
                      }}
                    >
                      {subDraft.id ? 'Save' : 'Add'}
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setSubDraft(null)}>Cancel</button>
                  </div>
                </div>
              )}

              <div className="ticket-subissue-scroll">
              {subIssues.map((si, index) => {
                const stageBanner = {
                  'Pending Approval': { color: '#d97706', bg: '#fffbeb', text: '#92400e', icon: 'alert', label: 'Cannibalized repair — awaiting Admin approval' },
                  'For Inspection':   { color: '#7c3aed', bg: '#f5f3ff', text: '#5b21b6', icon: 'search', label: ticket.status === 'For Verification' ? 'Repair logged — awaiting Custodian verification' : 'Repair logged — waiting on the rest of the ticket' },
                }[si.status];
                const open = isSubExpanded(si.sub_issue_id);
                const detailsId = `subissue-details-${si.sub_issue_id}`;

                return (
                <article key={si.sub_issue_id} className={`subissue-card is-${String(si.status ?? 'unknown').toLowerCase().replaceAll(' ', '-')}${open ? ' is-open' : ' is-collapsed'}`} aria-labelledby={`subissue-${si.sub_issue_id}-title`}>
                  <div className="subissue-card-head">
                    <button
                      type="button"
                      className="subissue-toggle"
                      aria-expanded={open}
                      aria-controls={detailsId}
                      title={open ? 'Hide repair details' : 'Show repair details'}
                      aria-label={`${open ? 'Hide' : 'Show'} repair details for sub-issue ${index + 1}: ${si.title}`}
                      onClick={() => toggleSubExpanded(si.sub_issue_id)}
                    >
                      <Icon name="chevronDown" size={14} />
                    </button>
                    <span className="subissue-index">{index + 1}</span>
                    <strong className="subissue-title" id={`subissue-${si.sub_issue_id}-title`}>{si.title}</strong>
                    <TicketStatusBadge value={si.status} />
                    {onEditSubIssue && ticket.status === 'Active' && ['Open', 'Under Repair'].includes(si.status) && canDo(user, 'subissue.manage') && (hasRole(user, 'Admin') || String(ticket.assigned_custodian_id) === String(userId)) && (
                      <span className="subissue-card-head-actions">
                        <button type="button" className="btn-edit-action icon-btn" title="Edit sub-issue" aria-label={`Edit sub-issue ${index + 1}: ${si.title}`} onClick={() => setSubDraft({ id: si.sub_issue_id, title: si.title, maintenance_type: si.maintenance_type ?? '' })}><Icon name="edit" size={13} /></button>
                        {subIssues.length > 1 && (
                          <button type="button" className="btn-delete-action icon-btn" title="Remove sub-issue" aria-label={`Remove sub-issue ${index + 1}: ${si.title}`} onClick={() => onDeleteSubIssue(ticket, si)}><Icon name="trash" size={13} /></button>
                        )}
                      </span>
                    )}                  </div>

                  <div className="subissue-body-grid">
                  <div className="subissue-body-main">
                  {/* Compact single-line meta strip — was a 4-box label/value
                      grid; each value is now self-descriptive (avatar =
                      mechanic, wrench icon = category, ₱ = cost, colored
                      badge = verdict), which cuts the block's height by more
                      than half without losing any information. */}
                  {(si.assigned_mechanic || si.maintenance_type || si.verification_verdict || si.source_vehicle || si.external_vendor || (si.maintenance_cost !== null && si.maintenance_cost !== undefined)) && (
                    <div className="subissue-meta-strip">
                      {si.assigned_mechanic && <UserAvatarName user={si.assigned_mechanic} />}
                      {si.maintenance_type && (
                        <span className="subissue-meta-chip">
                          <Icon name="wrench" size={11} /> {si.maintenance_type}
                        </span>
                      )}
                      {/* Cannibalized/External are set once, at ticket creation —
                          surfaced here so the donor vehicle/vendor is visible
                          right away instead of only reappearing when a mechanic
                          opens Log Repairs (where it's pre-filled but otherwise
                          invisible on the ticket itself in the meantime). */}
                      {si.source_vehicle && (
                        <span className="subissue-meta-chip">
                          <Icon name="vehicle" size={11} /> Donor: {si.source_vehicle.vehicle_name} ({si.source_vehicle.plate_number})
                        </span>
                      )}
                      {si.external_vendor && (
                        <span className="subissue-meta-chip">
                          <Icon name="clipboard" size={11} /> External Shop: {si.external_vendor}
                          {si.warranty_until && ` (warranty until ${formatDate(si.warranty_until)})`}
                        </span>
                      )}
                      {si.maintenance_cost !== null && si.maintenance_cost !== undefined && (
                        <strong className="subissue-meta-cost">₱{Number(si.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
                      )}
                      {si.verification_verdict && <TicketStatusBadge value={si.verification_verdict} />}
                    </div>
                  )}
                  {open && <RepairContextDetails si={si} />}

                  {onLogRepairs && ticket.status === 'Active' && canDo(user, 'subissue.log_repair') && si.status === 'Under Repair' && String(si.assigned_mechanic_id) === String(userId) && (
                    <div className="subissue-head-right">
                      <button className="primary-button" type="button" onClick={() => onLogRepairs(ticket, si)}>
                        <Icon name="wrench" size={14} /> Log Repairs
                      </button>
                    </div>
                  )}

                  {/* Makes every handoff visible — in particular, the Custodian's
                      verification step between the mechanic's repair and the
                      Admin's final confirmation, so it never looks skipped. */}
                  {open && stageBanner && (
                    <span className="subissue-stage-banner" style={{ '--stage-color': stageBanner.color, '--stage-bg': stageBanner.bg, '--stage-text': stageBanner.text }}>
                      <Icon name={stageBanner.icon} size={12} /> {stageBanner.label}
                    </span>
                  )}

                  {open && (
                  <div className="subissue-details" id={detailsId}>
                  {si.repair_logs && <RepairLogEntries text={si.repair_logs} compact />}
                  {si.parts_used && (
                    <div className="subissue-field">
                      <span className="subissue-field-label">Parts Used</span>
                      <PartsTags value={si.parts_used} />
                    </div>
                  )}
                  {si.attachment_url && (
                    <a className="subissue-attachment-link" href={resolvePhotoUrl(si.attachment_url)} target="_blank" rel="noreferrer">
                      <Icon name="clipboard" size={13} /> View attached photo/document
                    </a>
                  )}
                  {Array.isArray(si.functional_test) && si.functional_test.length > 0 && (
                    <div className="subissue-functional-test">
                      <span className="subissue-field-label">
                        Functional Test{si.test_attested ? ' · operator-attested' : ''}
                      </span>
                      <div className="subissue-test-chip-row">
                        {si.functional_test.map((t, ti) => (
                          <span key={ti} className={`subissue-test-chip ${t.passed ? 'is-pass' : 'is-fail'}`}>
                            <Icon name={t.passed ? 'checkCircle' : 'alert'} size={11} /> {t.item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {si.confirmation_verdict && si.status !== 'Deferred' && (
                    <p className="muted">Admin verdict: <TicketStatusBadge value={si.confirmation_verdict} /> {si.confirmation_notes}</p>
                  )}
                  </div>
                  )}

                  {si.reopened_at && si.status === 'For Inspection' && (
                    <div className="subissue-alert-banner">
                      <div className="subissue-alert-banner-head">
                        <Icon name="alert" size={14} /> <strong>Reopened by {si.reopened_by?.name || 'Admin'}</strong>
                      </div>
                      {si.confirmation_notes && <p><strong>Reason:</strong> {si.confirmation_notes}</p>}
                      <p className="subissue-alert-banner-footnote">This repair was reopened and needs to be verified again.</p>
                    </div>
                  )}

                  {si.status === 'Deferred' && (
                    <div className="subissue-alert-banner">
                      <div className="subissue-alert-banner-head">
                        <Icon name="alert" size={14} /> <strong>Deferred{si.deferred_by?.name ? ` by ${si.deferred_by.name}` : ''}</strong>
                      </div>
                      {si.deferred_reason && <p>{si.deferred_reason}</p>}
                      <p className="subissue-alert-banner-footnote">
                        A follow-up issue report{si.deferred_issue_report_id ? ` (Issue #${si.deferred_issue_report_id})` : ''} was opened so this defect isn't forgotten — the Custodian can propose a ticket from it.
                      </p>
                    </div>
                  )}

                  {/* Cannibalization approval (Phase A3) — a repair that used
                      a part taken from another vehicle waits here for an
                      Admin's sign-off before it's allowed on to Custodian
                      verification. Approving auto-opens an Issue Report on
                      the donor vehicle (backend side effect); rejecting
                      requires a reason and sends the sub-issue back to the
                      mechanic. */}
                  {ticket.status === 'Active' && (canDo(user, 'repair.approve_cannibalized') || canDo(user, 'repair.reject_cannibalized')) && si.status === 'Pending Approval' && (
                    reviewingCannibalizationId === si.sub_issue_id ? (
                      <div className="ticket-inline-form subissue-inline-form">
                        <SmartForm
                          fields={[
                            { label: 'Reason for declining', name: 'cannibalization_rejection_reason', type: 'textarea', rows: 2, required: true, placeholder: 'e.g., Needed on the donor vehicle itself' },
                          ]}
                          key={`reject-cannibalization-${si.sub_issue_id}`}
                          onCancel={() => setReviewingCannibalizationId(null)}
                          onSubmit={(payload) => onRejectCannibalization(ticket, si, payload).then((ok) => { if (ok !== false) setReviewingCannibalizationId(null); })}
                          submitLabel="Decline Cannibalized Part"
                          title=""
                        />
                      </div>
                    ) : (
                      <div className="subissue-cannibal-approval">
                        <p className="muted">
                          Donor vehicle: <strong>{si.source_vehicle?.vehicle_name ?? 'Unknown'}</strong> ({si.source_vehicle?.plate_number ?? '-'}). Approving opens an Issue Report on it for the removed part; declining sends this repair back to the mechanic.
                        </p>
                        <div className="subissue-cannibal-approval-actions">
                          {canDo(user, 'repair.approve_cannibalized') && (
                            <button
                              className="primary-button"
                              type="button"
                              disabled={approvingCannibalId === si.sub_issue_id}
                              onClick={async () => {
                                setApprovingCannibalId(si.sub_issue_id);
                                try { await onApproveCannibalization(ticket, si, {}); } finally { setApprovingCannibalId(null); }
                              }}
                            >
                              <Icon name="checkCircle" size={14} /> Approve Cannibalization
                            </button>
                          )}
                          {canDo(user, 'repair.reject_cannibalized') && (
                            <button className="text-danger-button" type="button" onClick={() => setReviewingCannibalizationId(si.sub_issue_id)}>
                              <Icon name="close" size={14} /> Decline
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  )}

                  {ticket.status === 'Active' && canDo(user, 'subissue.reopen_confirmed') && si.status === 'Done' && (
                    editingDoneId === si.sub_issue_id ? (
                      <div className="ticket-inline-form subissue-inline-form">
                        <p className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>Reopen this repair so it can be adjusted and verified again.</p>
                        <SmartForm
                          fields={[
                            { label: 'Notes (optional)', name: 'reopen_reason', type: 'textarea', rows: 2, placeholder: 'e.g., Needs adjustment, additional notes' },
                          ]}
                          key={`unconfirm-done-${si.sub_issue_id}`}
                          onCancel={() => setEditingDoneId(null)}
                          onSubmit={(payload) => onReopenDone(ticket, si, payload).then((ok) => { if (ok !== false) setEditingDoneId(null); })}
                          submitLabel="Reopen Repair"
                          title=""
                        />
                      </div>
                    ) : (
                      <button className="ghost-button btn-edit-action" type="button" onClick={() => setEditingDoneId(si.sub_issue_id)}>
                        <Icon name="undo" size={14} /> Reopen Repair
                      </button>
                    )
                  )}

                  </div>
                  </div>
                </article>
                );
              })}
              </div>
            </section>
          )}
          {ticket.status === 'Open' && (
            <p className="empty-state">No sub-issues yet — they'll show up here once the assigned Custodian inspects the vehicle and confirms what's actually wrong.</p>
          )}

          {/* The mechanic's one handoff for the whole ticket — every
              sub-issue is logged, so there's nothing left but to tell the
              Custodian it's ready. */}
          {/* Explains why Submit isn't available yet, instead of the
              mechanic wondering where the button went. */}
          {showSubmitBlocked && (
            <section className="ticket-section p23-blocked-action">
              <h4><Icon name="checkCircle" size={14} /> Submit for Verification</h4>
              <p className="muted" id={`submit-blocked-${ticket.ticket_id}`}>
                <Icon name="info" size={13} /> Not available yet — {submitBlockedReason}
              </p>
              <button className="primary-button" type="button" disabled aria-describedby={`submit-blocked-${ticket.ticket_id}`}>
                <Icon name="checkCircle" size={14} /> Submit for Verification
              </button>
            </section>
          )}

          {canSubmitForVerification && (
            <section className="ticket-section">
              <h4><Icon name="checkCircle" size={14} /> Ready for Verification</h4>
              <p className="muted" style={{ fontSize: '0.85rem' }}>Every sub-issue on this ticket has its repair logged. Submit it so {ticket.assigned_custodian?.name ?? 'the assigned Custodian'} can verify the work.</p>
              <button
                className="primary-button"
                type="button"
                disabled={submittingForVerification}
                onClick={async () => {
                  setSubmittingForVerification(true);
                  try { await onSubmitForVerification(ticket); } finally { setSubmittingForVerification(false); }
                }}
              >
                <Icon name="checkCircle" size={14} /> {submittingForVerification ? 'Submitting…' : 'Submit for Verification'}
              </button>
            </section>
          )}

          {/* The assigned Custodian sees where verification will happen and
              why it isn't open to them yet. */}
          {showVerifyBlocked && (
            <section className="ticket-section p23-blocked-action">
              <h4><Icon name="search" size={14} /> Verify Repair</h4>
              <p className="muted" id={`verify-blocked-${ticket.ticket_id}`}>
                <Icon name="info" size={13} /> Not available yet — you can verify once {ticket.assigned_mechanic?.name ?? 'the mechanic'} submits the ticket ({repairProgress.label} so far).
              </p>
              <button className="primary-button" type="button" disabled aria-describedby={`verify-blocked-${ticket.ticket_id}`}>
                <Icon name="checkCircle" size={14} /> Verify Repair
              </button>
            </section>
          )}

          {/* The Custodian's verification for the whole ticket: the vehicle-type
              functional test, then Approve (closes it) or Return for Repair. */}
          {canVerifyTicket && (
            <section className="ticket-section">
              <h4><Icon name="checkCircle" size={14} /> Verify Repair</h4>
              {!verifying && (
                <p className="muted">Operate the vehicle and run the checks. Approving closes the ticket; any failed check returns it to {ticket.assigned_mechanic?.name ?? 'the mechanic'} for repair.</p>
              )}
              {verifying ? (
                <TicketVerificationForm
                  ticket={ticket}
                  vehicle={ticket.vehicle}
                  onCancel={() => setVerifying(false)}
                  onSubmit={(payload) => onVerifyTicket(ticket, payload).then((ok) => { if (ok !== false) setVerifying(false); })}
                />
              ) : (
                <button className="primary-button" type="button" onClick={() => setVerifying(true)}>
                  <Icon name="checkCircle" size={14} /> Verify Repair
                </button>
              )}
            </section>
          )}
          </div>
        </div>

        <div className="ticket-detail-actions">
          {/* Closing happens only one way: the Custodian's verification
              above. These are the rare, administrative actions — kept apart
              from the workflow's one primary action, on the left and quiet,
              each behind a confirmation that names the ticket. */}
          <div className="ticket-detail-footer-actions">
            <div className="ticket-detail-footer-secondary" role="group" aria-label="Rare ticket actions">
              {/* A Pending Approval or Declined proposal isn't a live ticket
                  yet — Approve/Decline/Reopen in the Review Proposal block
                  above are its real actions. */}
              {canDo(user, 'ticket.cancel') && onCancel && !['Closed', 'Cancelled', 'Pending Approval', 'Declined'].includes(ticket.status) && (
                <button className="text-danger-button" type="button" onClick={requestCancel}>
                  <Icon name="close" size={14} /> Cancel Ticket
                </button>
              )}
              {/* Once Closed there's verified work on record — Delete is only
                  for genuine mistakes, not for discarding finished repairs. */}
              {canDo(user, 'ticket.delete') && onDelete && ticket.status !== 'Closed' && ticket.status !== 'Pending Approval' && (
                <button className="text-danger-button" type="button" onClick={requestDelete}>
                  <Icon name="trash" size={14} /> Delete Ticket
                </button>
              )}
            </div>
            {canDo(user, 'ticket.uncancel') && ticket.status === 'Cancelled' && onUncancel && (
              <div className="ticket-detail-footer-primary">
                <button className="primary-button" type="button" onClick={requestUncancel}>
                  <Icon name="undo" size={14} /> Reopen Ticket
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
  );

  if (asPage) return panel;

  return (
    <div className="ticket-detail-overlay" onClick={onClose}>
      {panel}
    </div>
  );
}

export function TicketProfilePage({ ticketId, user, userId, ticketLookups, knownTickets, onBack, onDeleteTicket, onRequestConfirmation, ticketAction: sendTicketAction }) {
  const navigate = useNavigate();
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  if (useDepsChanged([ticketId])) setLoading(true);

  useEffect(() => {
    let cancelled = false;
    api.get(`/tickets/${ticketId}`)
      .then((response) => {
        if (cancelled) return;
        setTicket(response.data);
        setNotFound(false);
      })
      .catch(() => { if (!cancelled) setNotFound(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticketId]);

  // After an action: refresh in place (no full-page spinner, which would
  // unmount the panel and wipe whatever the user typed if it failed) and
  // hand the action's success flag on so forms only close on success.
  const afterAction = (ok) => api.get(`/tickets/${ticketId}`)
    .then((response) => setTicket(response.data))
    .catch(() => {})
    .then(() => ok);

  // Silent background refresh — same request as loadTicket, but doesn't
  // flip the page back to the loading spinner, so it can run on an interval
  // without being disruptive. This is what makes the board reflect a
  // mechanic's or custodian's action on this same ticket while it's still
  // open on screen, instead of only updating on this viewer's own actions
  // (which already refetch via the .then(afterAction) chains below) or the
  // next time they happen to reopen it.
  useEffect(() => {
    const interval = setInterval(() => {
      api.get(`/tickets/${ticketId}`)
        .then((response) => setTicket(response.data))
        .catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, [ticketId]);

  if (loading) return <ModuleLoader label="Loading ticket" />;

  if (notFound || !ticket) {
    return (
      <ModulePanel description="This ticket could not be found — it may have been deleted or archived.">
      </ModulePanel>
    );
  }

  // Other unfinished tickets on this vehicle, from whatever ticket list the
  // workspace already has loaded (role-scoped for non-Admins). null = no
  // list available, so the panel hides the block instead of claiming "none".
  const vehicleIdOf = (t) => t?.vehicle_id ?? t?.vehicle?.vehicle_id ?? null;
  const relatedTickets = Array.isArray(knownTickets) && vehicleIdOf(ticket) != null
    ? knownTickets.filter((t) => t && t.ticket_id != null
      && String(t.ticket_id) !== String(ticket.ticket_id)
      && String(vehicleIdOf(t)) === String(vehicleIdOf(ticket))
      && !['Closed', 'Cancelled', 'Declined'].includes(t.status))
    : null;

  return (
    <TicketDetailPanel
      key={ticket.ticket_id}
      asPage
      relatedTickets={relatedTickets}
      onOpenTicket={(t) => navigate(`${roleRoutes[user.role]}/tickets/${t.ticket_id}`)}
      user={user}
      userId={userId}
      ticket={ticket}
      lookups={ticketLookups}
      onAddSubIssue={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues`, payload, 'Sub-issue added.', 'post').then(afterAction)}
      onEditSubIssue={(t, id, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${id}`, payload, 'Sub-issue updated.').then(afterAction)}
      onDeleteSubIssue={(t, si) => onRequestConfirmation({ title: 'Remove sub-issue?', message: `"${si.title}" will be removed from Ticket #${t.ticket_id} "${t.ticket_title}". This can't be undone.`, confirmLabel: 'Remove Sub-issue', variant: 'danger', onConfirm: () => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${si.sub_issue_id}`, {}, 'Sub-issue removed.', 'delete').then(afterAction) })}
      onAssignTicketMechanic={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/assign-mechanic`, payload, 'Mechanic reassigned.').then(afterAction)}
      onReassignCustodian={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/reassign-custodian`, payload, 'Custodian reassigned.').then(afterAction)}
      onReopenDone={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/reopen-confirmed`, payload, 'Repair reopened — it needs to be verified again.').then(afterAction)}
      onSubmitForVerification={(t) => sendTicketAction(`/tickets/${t.ticket_id}/submit-for-verification`, {}, 'Ticket submitted for verification.').then(afterAction)}
      onVerifyTicket={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/verify`, payload, verifyOutcomeMessage(payload)).then(afterAction)}
      onApproveCannibalization={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/approve-cannibalization`, payload, 'Cannibalized repair approved — a donor-vehicle issue report was opened.').then(afterAction)}
      onRejectCannibalization={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/reject-cannibalization`, payload, 'Cannibalized part declined — the repair went back to the mechanic.').then(afterAction)}
      onViewIssue={(id) => navigate(`${roleRoutes[user.role]}/issues/${id}`)}
      onLogRepairs={(t, si) => navigate(`${roleRoutes[user.role]}/work-orders/${t.ticket_id}/${si.sub_issue_id}/log-repairs`)}
      onCancel={(t) => sendTicketAction(`/tickets/${t.ticket_id}/cancel`, {}, 'Ticket cancelled.').then(afterAction)}
      onUncancel={(t) => sendTicketAction(`/tickets/${t.ticket_id}/uncancel`, {}, 'Ticket reopened.').then(afterAction)}
      onDelete={(t) => onDeleteTicket(t).then(onBack)}
      onApproveProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/approve`, payload, 'Ticket proposal approved.').then(afterAction)}
      // Declining no longer deletes the ticket — it becomes a visible,
      // reversible Declined status, so this stays on the page and refreshes
      // in place, same as every other action here.
      onDeclineProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/decline`, payload, 'Ticket proposal declined.').then(afterAction)}
      onUndeclineProposal={(t) => sendTicketAction(`/tickets/${t.ticket_id}/undecline`, {}, 'Proposal reopened — back to Pending Approval.').then(afterAction)}
      onRequestConfirmation={onRequestConfirmation}
      onClose={onBack}
    />
  );
}
