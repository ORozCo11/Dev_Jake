import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../components/Icon';
import { VerificationForm } from './VerificationForm';
import { ReturnToServiceStep } from './ReturnToServiceStep';
import useDepsChanged from '../../hooks/useDepsChanged';
import api from '../../api/axios';
import { CreatableSelect } from '../components/inputs';
import { ExpandableText, FormModal, ModuleLoader, ModulePanel, PartsTags, QuietDate, RepairLogEntries, StatusBadge, TicketStageBadge, TicketStatusBadge, UserAvatarName } from '../components/ui';
import { SmartForm } from '../forms/SmartForm';
import { confirmTicketFields, mechanicAssignFields } from '../lib/fields';
import { formatDate, idOf, resolvePhotoUrl } from '../lib/format';
import { canDo, hasRole, roleRoutes } from '../lib/permissions';
import { PHASE_STEP_COLORS, PHASE_STEP_ICONS, phaseOrder, verifySuccessMessage } from '../lib/workflow';


// =========================================================================
// TICKET PROPOSAL REVIEW — Admin's approve/decline screen for a Custodian's
// proposed ticket (status 'Pending Approval'). Kept as its own pair of
// components (not folded into the sub-issue cards below) so the existing
// read-only rendering for every other status stays completely untouched —
// TicketDetailPanel only ever mounts this while ticket.status is exactly
// 'Pending Approval', and swaps in a plain read-only notice instead for
// anyone viewing it without ticket.approve (i.e. the proposing Custodian).
// =========================================================================

export function TicketProposalReview({ user, ticket, lookups, onApprove, onDecline }) {
  if (!canDo(user, 'ticket.approve')) {
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
  return <TicketProposalReviewForm key={ticket.ticket_id} ticket={ticket} lookups={lookups} onApprove={onApprove} onDecline={onDecline} />;
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

export function TicketProposalReviewForm({ ticket, lookups, onApprove, onDecline }) {
  const [fields, setFields] = useState({
    ticket_description: ticket.ticket_description ?? '',
    priority: ticket.priority ?? '',
  });
  const [subRows, setSubRows] = useState(() => (ticket.sub_issues ?? []).map((si) => ({
    sub_issue_id: si.sub_issue_id,
    title: si.title ?? '',
    maintenance_type: si.maintenance_type ?? '',
    suggested_mechanic_id: si.suggested_mechanic_id ?? '',
  })));
  const [declining, setDeclining] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const setField = (name, value) => setFields((f) => ({ ...f, [name]: value }));
  const updateSubRow = (index, patch) => setSubRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const submitApprove = async () => {
    setSubmitting(true);
    try {
      await onApprove({
        ticket_description: fields.ticket_description,
        priority: fields.priority,
        sub_issues: subRows.map((r) => ({
          sub_issue_id: r.sub_issue_id,
          title: r.title,
          maintenance_type: r.maintenance_type || null,
          suggested_mechanic_id: r.suggested_mechanic_id || null,
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
        <span className="proposal-review-pill">Pending Approval</span>
      </div>

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
            <span>Description / Details</span>
            <textarea rows={3} value={fields.ticket_description} onChange={(e) => setField('ticket_description', e.target.value)} />
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
          {/* An external-shop repair has no in-house mechanic to pick. */}
          <div className="ticket-form-grid-2" style={{ padding: 0 }}>
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
            {repairType !== 'external' && (
            <label>
              <span>Suggested Mechanic</span>
              <select value={row.suggested_mechanic_id ?? ''} onChange={(e) => updateSubRow(index, { suggested_mechanic_id: e.target.value })}>
                <option value="">Unassigned</option>
                {(lookups.maintenance_personnel ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
            )}
          </div>
          <RepairContextDetails si={original} />
        </div>
        );
      })}
        </div>
      </div>

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
          <p className="proposal-review-hint">Edit anything above before approving. Declining permanently deletes this proposal.</p>
          <div className="proposal-review-buttons">
            <button className="btn-sm danger-button" type="button" onClick={() => setDeclining(true)} disabled={submitting}>
              <Icon name="close" size={14} /> Decline
            </button>
            <button className="primary-button" type="button" onClick={submitApprove} disabled={submitting}>
              <Icon name="checkCircle" size={14} /> Approve & Activate
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// =========================================================================
// TICKET DETAIL PANEL — shown when admin clicks a ticket row
// =========================================================================

export function TicketDetailPanel({ user, userId, ticket, lookups, onAddSubIssue, onEditSubIssue, onDeleteSubIssue, onAssignMechanic, onReassignMechanic, onReassignCustodian, onConfirm, onReopenDone, onDeferSubIssue, onCloseTicket, onLogRepairs, onViewIssue, onCancel, onUncancel, onDelete, onRequestConfirmation, onVerify, onApproveCannibalization, onRejectCannibalization, onApproveProposal, onDeclineProposal, onClose, asPage = false }) {
  const [assigningAll, setAssigningAll] = useState(false);
  const [subDraft, setSubDraft] = useState(null); // { id|null, title, maintenance_type }
  // Which sub-issue's Reassign/Defer inline form is open, if any — replaces
  // the old bulk Reassign/Defer modals with a per-card icon + inline panel
  // (only one sub-issue can have its form open at a time).
  const [subIssuePanel, setSubIssuePanel] = useState(null); // { id, mode: 'reassign' | 'defer' }
  const [confirmingId, setConfirmingId] = useState(null);
  // Admin-only fallback verify (VMS-IMPROVEMENT-PLAN.md Phase A2) — the
  // Custodian's own verify action lives entirely in CustodianVerificationModule;
  // this is the one path Admin has into the same VerificationForm, for
  // whenever the assigned Custodian can't do it themself (most notably:
  // they're also the sub-issue's mechanic, and verifyRepair() blocks that).
  const [verifyingId, setVerifyingId] = useState(null);
  // Cannibalization approval (Phase A3) — tracks which sub-issue's reject
  // form is open; Approve has no form of its own (it needs no input beyond
  // the click itself), so it doesn't need a tracked id.
  const [reviewingCannibalizationId, setReviewingCannibalizationId] = useState(null);
  const [approvingCannibalId, setApprovingCannibalId] = useState(null);
  const [reassigningCustodian, setReassigningCustodian] = useState(false);
  const [editingDoneId, setEditingDoneId] = useState(null);
  const [decisionClosing, setDecisionClosing] = useState(false);
  const [closingClean, setClosingClean] = useState(false);

  if (!ticket) return null;

  const subIssues = ticket.sub_issues ?? [];
  const openSubIssues = subIssues.filter((s) => s.status === 'Open');
  const allOpenHaveType = openSubIssues.every((s) => s.maintenance_type);
  const progress = ticket.progress ?? {
    done: subIssues.filter((s) => s.status === 'Done').length,
    deferred: subIssues.filter((s) => s.status === 'Deferred').length,
    total: subIssues.length,
  };
  // A sub-issue is "resolved" once it's either fixed (Done) or a recorded
  // decision not to fix it now (Deferred). A ticket closes when everything
  // is resolved — not only when everything is Done.
  const isResolvedStatus = (s) => s === 'Done' || s === 'Deferred';
  const deferrableSubIssues = ticket.status === 'Active'
    ? subIssues.filter((s) => !isResolvedStatus(s.status) && s.status !== 'For Confirmation')
    : [];
  const hasUnresolved = subIssues.some((s) => !isResolvedStatus(s.status));
  const allResolved = subIssues.length === 0 || !hasUnresolved;
  const canClose = ticket.status === 'Active' && allResolved;
  const canDecisionClose = ticket.status === 'Active' && hasUnresolved;
  // Kept for the one spot (subissue.verify) that still needs "is this the
  // Admin general-fallback path" separately from the ownership check —
  // every other gate below is a specific ability instead of one shared flag.
  const isAdminUser = hasRole(user, 'Admin');
  const resolvedCount = subIssues.filter((s) => isResolvedStatus(s.status)).length;
  const unresolvedCount = Math.max(0, progress.total - resolvedCount);
  const pendingMechanicCount = subIssues.filter((s) => s.status === 'Open').length;
  const inRepairCount = subIssues.filter((s) => s.status === 'Under Repair').length;
  const awaitingVerificationCount = subIssues.filter((s) => s.status === 'For Inspection').length;
  const awaitingConfirmationCount = subIssues.filter((s) => s.status === 'For Confirmation').length;
  const pendingApprovalCount = subIssues.filter((s) => s.status === 'Pending Approval').length;
  const myRepairCount = subIssues.filter((s) => s.status === 'Under Repair' && String(s.assigned_mechanic_id) === String(userId)).length;
  const myVerifyCount = subIssues.filter((s) => s.status === 'For Inspection' && idOf(s.verification_assigned_to) === userId && String(s.assigned_mechanic_id) !== String(userId)).length;
  const ticketCost = subIssues.reduce((sum, s) => sum + (Number(s.maintenance_cost) || 0), 0);
  const resolvedPercent = progress.total > 0
    ? Math.round((resolvedCount / progress.total) * 100)
    : ticket.status === 'Closed' ? 100 : 0;
  const nextSignal = (() => {
    if (ticket.status === 'Cancelled') return { tone: 'alert', label: 'Ticket cancelled', detail: 'Restore it only if work needs to resume.' };
    if (ticket.status === 'Closed') return { tone: 'ok', label: 'Closed', detail: 'All recorded work is complete.' };
    if (ticket.status === 'Pending Approval') return { tone: 'warn', label: 'Review proposal', detail: 'A Custodian proposed this ticket — review and approve or decline it below.' };
    if (canClose) return { tone: 'ok', label: 'Ready to close', detail: 'Return the vehicle once the final close is recorded.' };
    if (ticket.status === 'Open') return { tone: 'active', label: 'Inspection first', detail: ticket.assigned_custodian?.name ? `${ticket.assigned_custodian.name} owns the inspection step.` : 'Assign and complete the custodian inspection.' };
    // What needs doing NOW, for whoever is looking at the page — specific
    // handoffs first, the generic "Decision needed" only when nothing else fits.
    if (!isAdminUser && myRepairCount > 0) return { tone: 'warn', label: 'Log your repairs', detail: `${myRepairCount} work order${myRepairCount === 1 ? '' : 's'} assigned to you ${myRepairCount === 1 ? 'is' : 'are'} waiting for a repair log.` };
    if (!isAdminUser && myVerifyCount > 0) return { tone: 'warn', label: 'Verify repair', detail: `${myVerifyCount} repair${myVerifyCount === 1 ? '' : 's'} waiting for your verification.` };
    if (awaitingConfirmationCount > 0) return isAdminUser
      ? { tone: 'warn', label: 'Confirm outcome', detail: `${awaitingConfirmationCount} repair${awaitingConfirmationCount === 1 ? '' : 's'} awaiting your final verdict.` }
      : { tone: 'active', label: 'Awaiting Admin confirmation', detail: `${awaitingConfirmationCount} repair${awaitingConfirmationCount === 1 ? '' : 's'} verified — the Admin gives the final verdict.` };
    if (pendingApprovalCount > 0) return isAdminUser
      ? { tone: 'warn', label: 'Approve cannibalized repair', detail: `${pendingApprovalCount} repair${pendingApprovalCount === 1 ? '' : 's'} using a part from another vehicle ${pendingApprovalCount === 1 ? 'needs' : 'need'} your approval.` }
      : { tone: 'active', label: 'Awaiting Admin approval', detail: 'A cannibalized repair is waiting for Admin approval before verification.' };
    if (pendingMechanicCount > 0) return isAdminUser
      ? { tone: 'warn', label: 'Dispatch mechanic', detail: `${pendingMechanicCount} sub-issue${pendingMechanicCount === 1 ? '' : 's'} still need a mechanic assigned.` }
      : { tone: 'active', label: 'Waiting for dispatch', detail: `An Admin still needs to assign a mechanic to ${pendingMechanicCount} sub-issue${pendingMechanicCount === 1 ? '' : 's'}.` };
    if (awaitingVerificationCount > 0) return { tone: 'active', label: 'Awaiting verification', detail: `${awaitingVerificationCount} item${awaitingVerificationCount === 1 ? '' : 's'} awaiting custodian verification.` };
    if (inRepairCount > 0) return { tone: 'active', label: 'Repair in progress', detail: `${inRepairCount} work order${inRepairCount === 1 ? '' : 's'} waiting for repair logs.` };
    if (canDecisionClose) return { tone: 'warn', label: 'Decision needed', detail: `${unresolvedCount} unresolved item${unresolvedCount === 1 ? '' : 's'} must be finished, deferred, or decision-closed.` };
    return { tone: 'active', label: 'Work in motion', detail: 'Follow the active handoff shown in the repair board.' };
  })();
  const processStats = [
    { icon: 'list', label: 'Sub-issues', value: progress.total },
    { icon: 'wrench', label: 'In repair', value: inRepairCount },
    { icon: 'flag', label: 'Confirm', value: awaitingConfirmationCount },
    { icon: 'clipboard', label: 'Cost', value: ticketCost ? `PHP ${ticketCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'PHP 0.00' },
  ];

  // "How long has this been sitting?" — the aging signal. Flagged past 30 days.
  const daysOpen = ticket.days_open;
  const isAging = ticket.status !== 'Closed' && ticket.status !== 'Cancelled' && typeof daysOpen === 'number' && daysOpen >= 30;

  const requestDelete = () => {
    onRequestConfirmation({
      title: 'Delete Ticket',
      message: `Permanently delete Ticket #${ticket.ticket_id}? This cannot be undone. If the ticket should stay on record (for example it was raised by mistake but already worked on), cancel it instead.`,
      confirmLabel: 'Delete Ticket',
      variant: 'danger',
      onConfirm: () => onDelete(ticket),
    });
  };

  const requestCancel = () => {
    onRequestConfirmation({
      title: 'Cancel Ticket',
      message: `Are you sure you want to cancel Ticket #${ticket.ticket_id}? Work on it stops here — it can be uncancelled later if needed.`,
      confirmLabel: 'Cancel Ticket',
      variant: 'primary',
      onConfirm: () => onCancel(ticket),
    });
  };

  const panel = (
      <div className={`ticket-detail-panel${asPage ? ' is-page' : ''}`} aria-labelledby={`ticket-${ticket.ticket_id}-title`} onClick={asPage ? undefined : (e) => e.stopPropagation()}>
        <section className={`ticket-process-hero is-${nextSignal.tone}`} aria-label="Ticket summary">
          <div
            className="ticket-process-meter"
            role="progressbar"
            aria-label="Resolved sub-issues"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={progress.total > 0 ? resolvedPercent : undefined}
            aria-valuetext={progress.total > 0 ? `${resolvedCount} of ${progress.total} sub-issues resolved` : 'No sub-issues'}
            style={{ '--ticket-progress': `${resolvedPercent}%` }}
          >
            <div className="ticket-process-meter-core">
              <span>Resolved</span>
              {/* A zero-sub-issue ticket (inspection found nothing to repair) has
                  nothing to measure progress against — "0%" would read as
                  "nothing done" right next to a "ready to close" banner. */}
              <strong>{progress.total > 0 ? `${resolvedPercent}%` : '—'}</strong>
              <small>{progress.total > 0 ? `${resolvedCount}/${progress.total} items` : 'No sub-issues'}</small>
            </div>
          </div>
          <div className="ticket-process-hero-main">
            <div className="ticket-process-kicker">
              <span>Ticket #{ticket.ticket_id}</span>
              {typeof daysOpen === 'number' && (
                <span>{daysOpen === 0 ? 'Opened today' : `${daysOpen} day${daysOpen === 1 ? '' : 's'} open`}</span>
              )}
            </div>
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
          </div>

          <div className="ticket-process-next-card">
            {asPage ? null : (
              <button className="icon-btn ticket-process-close" onClick={onClose} type="button" title="Close" aria-label="Close"><Icon name="close" size={18} /></button>
            )}
            <span className="ticket-process-next-label">Next best action</span>
            <strong>{nextSignal.label}</strong>
            <p>{nextSignal.detail}</p>
            <div className="ticket-process-stat-grid">
              {processStats.map((stat) => (
                <div key={stat.label} className="ticket-process-stat">
                  <Icon name={stat.icon} size={14} />
                  <span>{stat.label}</span>
                  <strong>{stat.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>

        {ticket.status === 'Cancelled' ? (
          <p className="notice danger ticket-process-cancelled"><Icon name="alert" size={15} /> This ticket was cancelled.</p>
        ) : (
          <div className="ticket-process-flow" role="list" aria-label="Ticket progress">
            {phaseOrder.map((s, i) => {
              const current = phaseOrder.indexOf(ticket.status);
              const state = i < current ? 'done' : i === current ? 'active' : 'upcoming';
              const hint = {
                Open: 'Custodian inspection',
                Active: 'Repair, verify, confirm',
                Closed: 'Return or archive',
              }[s];
              return (
                <div key={s} className={`ticket-process-flow-step is-${state}`} role="listitem" aria-current={state === 'active' ? 'step' : undefined}>
                  <span className="ticket-process-flow-marker" style={state === 'active' ? { background: PHASE_STEP_COLORS[s], borderColor: PHASE_STEP_COLORS[s] } : undefined}>
                    {state === 'done' ? <Icon name="checkCircle" size={15} /> : <Icon name={PHASE_STEP_ICONS[s]} size={15} />}
                  </span>
                  <span className="ticket-process-flow-label" style={state !== 'upcoming' ? { color: PHASE_STEP_COLORS[s] } : undefined}>{s}</span>
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
              <div className="ticket-preview-card" style={{ marginBottom: 10 }}>
                {ticket.vehicle?.photo_url ? (
                  <img className="ticket-preview-photo" style={{ width: 120, height: 120 }} src={resolvePhotoUrl(ticket.vehicle.photo_url)} alt={ticket.vehicle.vehicle_name} />
                ) : (
                  <span className="ticket-preview-photo ticket-preview-photo-empty" style={{ width: 120, height: 120 }}><Icon name="vehicle" size={40} /></span>
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
              {ticket.issue_report_id && onViewIssue && canDo(user, 'issue.view') && (
                <button className="ghost-button" type="button" style={{ marginTop: 10 }} onClick={() => onViewIssue(ticket.issue_report_id)}>
                  <Icon name="alert" size={13} /> From Issue Report #{ticket.issue_report_id}
                </button>
              )}
            </section>

            {ticket.assigned_custodian_id && (
              <section className="ticket-section">
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
            </section>
          </div>

          <div className="ticket-detail-col-right">
          {/* Custodian-proposed ticket awaiting Admin review — a completely
              separate block from the normal sub-issue cards just below
              (which are explicitly excluded for this one status right
              after), so nothing about how every other status renders
              changes. */}
          {ticket.status === 'Pending Approval' && (
            <TicketProposalReview
              user={user}
              ticket={ticket}
              lookups={lookups}
              onApprove={(payload) => onApproveProposal(ticket, payload)}
              onDecline={(payload) => onDeclineProposal(ticket, payload)}
            />
          )}
          {ticket.status !== 'Open' && ticket.status !== 'Pending Approval' && (
            <section className="ticket-section">
              <h4>
                <Icon name="wrench" size={14} /> Sub-Issues
                {progress.total > 0 && <span className="ticket-count-pill">{progress.total}</span>}
                <span
                  className="ticket-section-info-icon"
                  title="Keep sub-issues and the mechanic's Maintenance Type scoped to this Main Issue — an unrelated repair belongs on its own ticket instead."
                >
                  <Icon name="info" size={13} />
                </span>
              </h4>

              {/* The actionable "ready to close" banner lives once, down in
                  ticket-detail-actions, covering both this case (no
                  sub-issues) and the all-resolved-via-defer case — so there's
                  one consistent prompt instead of two different ones. */}
              {subIssues.length === 0 && (
                <p className="muted">No sub-issues — inspection found nothing to repair.</p>
              )}

              {/* Bulk assign — one control for the whole ticket instead of a
                  repeated Assign per sub-issue card below. Reassign/Defer are
                  now per-sub-issue icon buttons on each card instead of bulk
                  actions here (see subissue-icon-btn below). */}
              {canDo(user, 'subissue.assign_mechanic') && openSubIssues.length > 0 && (
                <div className="subissue-bulk-actions">
                  {!assigningAll && (
                    <button className="primary-button" type="button" onClick={() => setAssigningAll(true)}>
                      <Icon name="wrench" size={12} /> Assign Mechanic
                    </button>
                  )}
                </div>
              )}

              {canDo(user, 'subissue.assign_mechanic') && assigningAll && (
                <div className="ticket-inline-form" style={{ marginBottom: 10, padding: '10px 12px' }}>
                  <p className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>Assigns this mechanic to all {openSubIssues.length} open sub-issue{openSubIssues.length > 1 ? 's' : ''} below.</p>
                  <SmartForm
                    fields={allOpenHaveType ? mechanicAssignFields(lookups).filter((f) => f.name !== 'maintenance_type') : mechanicAssignFields(lookups)}
                    onCancel={() => setAssigningAll(false)}
                    onSubmit={(payload) => Promise.all(openSubIssues.map((si) => onAssignMechanic(ticket, si, { ...payload, maintenance_type: si.maintenance_type || payload.maintenance_type }))).then((results) => { if (results.every((ok) => ok !== false)) setAssigningAll(false); })}
                    submitLabel="Assign & Dispatch"
                    title=""
                  />
                </div>
              )}

              {onAddSubIssue && ticket.status === 'Active' && canDo(user, 'subissue.manage') && (hasRole(user, 'Admin') || String(ticket.assigned_custodian_id) === String(userId)) && (
                <div className="ticket-inline-form" style={{ marginBottom: 10, padding: '10px 12px' }}>
                  {!subDraft ? (
                    <button type="button" className="primary-button" onClick={() => setSubDraft({ id: null, title: '', maintenance_type: '' })}>
                      <Icon name="plus" size={12} /> Add Sub-issue
                    </button>
                  ) : (
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
                  )}
                </div>
              )}

              {subIssues.map((si, index) => {
                const stageBanner = {
                  'Pending Approval': { color: '#d97706', bg: '#fffbeb', text: '#92400e', icon: 'alert', label: 'Cannibalized repair — awaiting Admin approval' },
                  'For Inspection':   { color: '#7c3aed', bg: '#f5f3ff', text: '#5b21b6', icon: 'search', label: 'Awaiting Custodian verification' },
                  'For Confirmation': { color: '#db2777', bg: '#fdf2f8', text: '#9d174d', icon: 'flag', label: "Custodian approved — awaiting Admin's final confirmation" },
                }[si.status];
                const canReassignThis = ticket.status === 'Active' && canDo(user, 'subissue.reassign_mechanic') && si.status === 'Under Repair';
                const canDeferThis = canDo(user, 'subissue.defer') && deferrableSubIssues.some((d) => d.sub_issue_id === si.sub_issue_id);
                const panelOpen = subIssuePanel?.id === si.sub_issue_id ? subIssuePanel.mode : null;

                return (
                <article key={si.sub_issue_id} className={`subissue-card is-${String(si.status ?? 'unknown').toLowerCase().replaceAll(' ', '-')}`} aria-labelledby={`subissue-${si.sub_issue_id}-title`}>
                  <div className="subissue-card-head">
                    <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#eff6ff', color: '#2563eb', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, flexShrink: 0 }}>{index + 1}</span>
                    <strong id={`subissue-${si.sub_issue_id}-title`} style={{ fontSize: '0.9rem' }}>{si.title}</strong>
                    <TicketStatusBadge value={si.status} />
                    {onEditSubIssue && ticket.status === 'Active' && si.status === 'Open' && !si.assigned_mechanic_id && canDo(user, 'subissue.manage') && (hasRole(user, 'Admin') || String(ticket.assigned_custodian_id) === String(userId)) && (
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                        <button type="button" className="btn-edit-action icon-btn" title="Edit sub-issue" aria-label="Edit sub-issue" onClick={() => setSubDraft({ id: si.sub_issue_id, title: si.title, maintenance_type: si.maintenance_type ?? '' })}><Icon name="edit" size={13} /></button>
                        {subIssues.length > 1 && (
                          <button type="button" className="btn-delete-action icon-btn" title="Remove sub-issue" aria-label="Remove sub-issue" onClick={() => onDeleteSubIssue(ticket, si)}><Icon name="trash" size={13} /></button>
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
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', marginTop: 8, padding: '6px 9px', background: '#f8fafc', borderRadius: 8, fontSize: '0.8rem' }}>
                      {si.assigned_mechanic && <UserAvatarName user={si.assigned_mechanic} />}
                      {si.maintenance_type && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#475569' }}>
                          <Icon name="wrench" size={11} /> {si.maintenance_type}
                        </span>
                      )}
                      {/* Cannibalized/External are set once, at ticket creation —
                          surfaced here so the donor vehicle/vendor is visible
                          right away instead of only reappearing when a mechanic
                          opens Log Repairs (where it's pre-filled but otherwise
                          invisible on the ticket itself in the meantime). */}
                      {si.source_vehicle && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#475569' }}>
                          <Icon name="vehicle" size={11} /> Donor: {si.source_vehicle.vehicle_name} ({si.source_vehicle.plate_number})
                        </span>
                      )}
                      {si.external_vendor && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#475569' }}>
                          <Icon name="clipboard" size={11} /> External Shop: {si.external_vendor}
                          {si.warranty_until && ` (warranty until ${formatDate(si.warranty_until)})`}
                        </span>
                      )}
                      {si.maintenance_cost !== null && si.maintenance_cost !== undefined && (
                        <strong style={{ color: '#16a34a' }}>₱{Number(si.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
                      )}
                      {si.verification_verdict && <TicketStatusBadge value={si.verification_verdict} />}
                    </div>
                  )}
                  <RepairContextDetails si={si} />

                  {(canReassignThis || canDeferThis) && (
                    <div className="subissue-icon-row">
                      {canReassignThis && (
                        <button
                          type="button"
                          className="icon-btn subissue-icon-btn is-reassign"
                          title="Reassign mechanic"
                          aria-label="Reassign mechanic"
                          onClick={() => setSubIssuePanel(panelOpen === 'reassign' ? null : { id: si.sub_issue_id, mode: 'reassign' })}
                        >
                          <Icon name="undo" size={14} />
                        </button>
                      )}
                      {canDeferThis && (
                        <button
                          type="button"
                          className="icon-btn subissue-icon-btn is-defer"
                          title="Defer (can't finish now)"
                          aria-label="Defer (can't finish now)"
                          onClick={() => setSubIssuePanel(panelOpen === 'defer' ? null : { id: si.sub_issue_id, mode: 'defer' })}
                        >
                          <Icon name="alert" size={14} />
                        </button>
                      )}
                    </div>
                  )}

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
                  {stageBanner && (
                    <div style={{ marginTop: 8 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 11px', background: stageBanner.bg, border: `1px solid ${stageBanner.color}40`, borderRadius: 999, fontSize: '0.76rem', fontWeight: 600, color: stageBanner.text }}>
                        <Icon name={stageBanner.icon} size={12} /> {stageBanner.label}
                      </span>
                    </div>
                  )}

                  {si.repair_logs && <div style={{ marginTop: 8 }}><RepairLogEntries text={si.repair_logs} compact /></div>}
                  {si.parts_used && (
                    <div style={{ marginTop: 8 }}>
                      <span style={{ display: 'block', fontSize: '0.66rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>Parts Used</span>
                      <PartsTags value={si.parts_used} />
                    </div>
                  )}
                  {si.attachment_url && (
                    <p style={{ marginTop: 8 }}>
                      <a href={resolvePhotoUrl(si.attachment_url)} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.85rem' }}>
                        <Icon name="clipboard" size={13} /> View attached photo/document
                      </a>
                    </p>
                  )}
                  {Array.isArray(si.functional_test) && si.functional_test.length > 0 && (
                    <div style={{ marginTop: 8, padding: '8px 10px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                      <span style={{ display: 'block', fontSize: '0.66rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 5 }}>
                        Functional Test{si.test_attested ? ' · operator-attested' : ''}
                      </span>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {si.functional_test.map((t, ti) => (
                          <span key={ti} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.76rem', padding: '2px 8px', borderRadius: 999, background: t.passed ? '#ecfdf5' : '#fef2f2', color: t.passed ? '#065f46' : '#991b1b', border: `1px solid ${t.passed ? '#a7f3d0' : '#fecaca'}` }}>
                            <Icon name={t.passed ? 'checkCircle' : 'alert'} size={11} /> {t.item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {si.confirmation_verdict && si.status !== 'Deferred' && (
                    <p className="muted" style={{ marginTop: 8 }}>Admin verdict: <TicketStatusBadge value={si.confirmation_verdict} /> {si.confirmation_notes}</p>
                  )}

                  {si.reopened_at && si.status === 'For Inspection' && (
                    <div style={{ marginTop: 8, padding: '10px 12px', background: '#fef3c7', borderLeft: '3px solid #f59e0b', borderRadius: 6, fontSize: '0.82rem', color: '#92400e' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <Icon name="alert" size={14} /> <strong>Reopened by {si.reopened_by?.name || 'Admin'}</strong>
                      </div>
                      {si.confirmation_notes && <p style={{ margin: 0 }}><strong>Reason:</strong> {si.confirmation_notes}</p>}
                      <p style={{ margin: '4px 0 0', fontStyle: 'italic', opacity: 0.85 }}>This repair was unconfirmed and needs to be re-verified.</p>
                    </div>
                  )}

                  {si.status === 'Deferred' && (
                    <div style={{ marginTop: 8, padding: '8px 12px', background: '#fffbeb', borderLeft: '3px solid #f59e0b', borderRadius: 6, fontSize: '0.82rem', color: '#92400e' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon name="alert" size={14} /> <strong>Deferred{si.deferred_by?.name ? ` by ${si.deferred_by.name}` : ''}</strong>
                      </div>
                      {si.deferred_reason && <p style={{ margin: '4px 0 0' }}>{si.deferred_reason}</p>}
                      <p style={{ margin: '4px 0 0', fontStyle: 'italic', opacity: 0.85 }}>
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
                      <div className="ticket-inline-form" style={{ marginTop: 8, padding: '10px 12px' }}>
                        <SmartForm
                          fields={[
                            { label: 'Rejection Reason', name: 'cannibalization_rejection_reason', type: 'textarea', rows: 2, required: true, placeholder: 'e.g., Needed on the donor vehicle itself' },
                          ]}
                          key={`reject-cannibalization-${si.sub_issue_id}`}
                          onCancel={() => setReviewingCannibalizationId(null)}
                          onSubmit={(payload) => onRejectCannibalization(ticket, si, payload).then((ok) => { if (ok !== false) setReviewingCannibalizationId(null); })}
                          submitLabel="Reject Repair"
                          title=""
                        />
                      </div>
                    ) : (
                      <div style={{ marginTop: 10 }}>
                        <p className="muted" style={{ marginBottom: 6, fontSize: '0.8rem' }}>
                          Donor vehicle: <strong>{si.source_vehicle?.vehicle_name ?? 'Unknown'}</strong> ({si.source_vehicle?.plate_number ?? '-'}). Approving opens an Issue Report on it for the removed part.
                        </p>
                        <div style={{ display: 'flex', gap: 8 }}>
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
                            <button className="ghost-button" type="button" onClick={() => setReviewingCannibalizationId(si.sub_issue_id)}>
                              Reject
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  )}

                  {/* Verification from within the ticket's own detail page —
                      the Custodian's own verify action also lives in
                      CustodianVerificationModule, this is just a second
                      entry point to the same action. Production-readiness
                      audit finding #2 removed the old "Admin fallback" bypass
                      here (and on the backend) — this is now a plain
                      ownership check, same rule everywhere: you must be the
                      SPECIFIC Custodian this sub-issue's verification is
                      assigned to, and you can never be the one who performed
                      the repair. An unavailable Custodian is handled by
                      reassigning the ticket, not by Admin standing in. */}
                  {ticket.status === 'Active' && canDo(user, 'subissue.verify') && idOf(si.verification_assigned_to) === userId && String(si.assigned_mechanic_id) !== String(userId) && onVerify && si.status === 'For Inspection' && (
                    verifyingId === si.sub_issue_id ? (
                      <div className="ticket-inline-form" style={{ marginTop: 8, padding: '10px 12px' }}>
                        <VerificationForm
                          target={{ ...si, vehicle: ticket.vehicle }}
                          onCancel={() => setVerifyingId(null)}
                          onSubmit={(payload) => onVerify(ticket, si, payload).then((ok) => { if (ok !== false) setVerifyingId(null); })}
                        />
                      </div>
                    ) : (
                      <button className="primary-button" style={{ marginTop: 10 }} type="button" onClick={() => setVerifyingId(si.sub_issue_id)}>
                        <Icon name="checkCircle" size={14} /> Verify Repair
                      </button>
                    )
                  )}

                  {ticket.status === 'Active' && canDo(user, 'subissue.confirm') && si.status === 'For Confirmation' && (
                    confirmingId === si.sub_issue_id ? (
                      <div className="ticket-inline-form" style={{ marginTop: 8, padding: '10px 12px' }}>
                        <SmartForm
                          fields={confirmTicketFields}
                          key={`confirm-${si.sub_issue_id}`}
                          onCancel={() => setConfirmingId(null)}
                          onSubmit={(payload) => onConfirm(ticket, si, payload).then((ok) => { if (ok !== false) setConfirmingId(null); })}
                          submitLabel="Submit Verdict"
                          title=""
                        />
                      </div>
                    ) : (
                      <button className="primary-button" style={{ marginTop: 10 }} type="button" onClick={() => setConfirmingId(si.sub_issue_id)}>Issue Confirmation Verdict</button>
                    )
                  )}

                  {ticket.status === 'Active' && canDo(user, 'subissue.reopen_confirmed') && si.status === 'Done' && (
                    editingDoneId === si.sub_issue_id ? (
                      <div className="ticket-inline-form" style={{ marginTop: 8, padding: '10px 12px' }}>
                        <p className="muted" style={{ marginBottom: 8, fontSize: '0.8rem' }}>Unconfirm this repair so you can make adjustments and re-confirm it.</p>
                        <SmartForm
                          fields={[
                            { label: 'Notes (optional)', name: 'reopen_reason', type: 'textarea', rows: 2, placeholder: 'e.g., Needs adjustment, additional notes' },
                          ]}
                          key={`unconfirm-done-${si.sub_issue_id}`}
                          onCancel={() => setEditingDoneId(null)}
                          onSubmit={(payload) => onReopenDone(ticket, si, payload).then((ok) => { if (ok !== false) setEditingDoneId(null); })}
                          submitLabel="Unconfirm"
                          title=""
                        />
                      </div>
                    ) : (
                      <button className="ghost-button btn-edit-action" style={{ marginTop: 10 }} type="button" onClick={() => setEditingDoneId(si.sub_issue_id)}>
                        <Icon name="undo" size={14} /> Unconfirm
                      </button>
                    )
                  )}

                  </div>

                  {panelOpen && (
                    <div className="subissue-inline-panel">
                      {panelOpen === 'reassign' ? (
                        <SmartForm
                          fields={[
                            { label: 'Reassign to Mechanic', name: 'assigned_mechanic_id', options: (lookups.maintenance_personnel ?? []).filter((m) => m.id !== si.assigned_mechanic_id).map((m) => ({ value: m.id, label: m.name })), required: true, type: 'select' },
                            { label: 'Reason for reassigning', name: 'reassign_reason', required: true, type: 'textarea', rows: 2 },
                          ]}
                          key={`reassign-${si.sub_issue_id}`}
                          onCancel={() => setSubIssuePanel(null)}
                          onSubmit={(payload) => onReassignMechanic(ticket, si, payload).then((ok) => { if (ok !== false) setSubIssuePanel(null); })}
                          submitLabel="Reassign Work Order"
                          title=""
                        />
                      ) : (
                        <SmartForm
                          fields={[{ label: 'Reason for deferring', name: 'deferred_reason', required: true, type: 'textarea', rows: 2 }]}
                          key={`defer-${si.sub_issue_id}`}
                          onCancel={() => setSubIssuePanel(null)}
                          onSubmit={(payload) => onDeferSubIssue(ticket, si, payload).then((ok) => { if (ok !== false) setSubIssuePanel(null); })}
                          submitLabel="Defer This Sub-Issue"
                          title=""
                        />
                      )}
                    </div>
                  )}
                  </div>
                </article>
                );
              })}
            </section>
          )}
          {ticket.status === 'Open' && (
            <p className="empty-state">No sub-issues yet — they'll show up here once the assigned Custodian inspects the vehicle and confirms what's actually wrong.</p>
          )}
          </div>
        </div>

        <div className="ticket-detail-actions">
          {/* Nothing left to do on this ticket — whether because there was
              never anything to fix, everything got Done, or the rest got
              Deferred (e.g. an emergency: "not fixing this now, we need the
              vehicle"). That last case matters most: deferring the LAST
              open sub-issue makes this banner appear immediately, right when
              Admin is most likely to otherwise forget the second click —
              because until Close Ticket is pressed, the vehicle stays stuck
              showing Under Maintenance even though nothing is actually being
              worked on anymore. */}
          {canDo(user, 'ticket.close') && canClose && (
            <div className="notice success" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="checkCircle" size={15} />
                {subIssues.length === 0
                  ? 'Inspection found no issues — nothing to repair.'
                  : 'All sub-issues are resolved (fixed or deferred).'}
                {' '}This ticket is ready to close.
              </span>
              {!closingClean && (
                <button className="primary-button" type="button" onClick={() => setClosingClean(true)}>Close ticket…</button>
              )}
            </div>
          )}
          {canDo(user, 'ticket.close') && canClose && closingClean && (
            <ReturnToServiceStep
              vehicleName={ticket.vehicle?.vehicle_name}
              hasIssueReport={Boolean(ticket.issue_report_id)}
              onCancel={() => setClosingClean(false)}
              onConfirm={(payload) => onCloseTicket(ticket, payload).then((ok) => { if (ok !== false) setClosingClean(false); })}
            />
          )}

          {/* Decision-close: end the ticket with unfinished work. The
              leftovers become Deferred, and the Admin must justify it AND
              make the fit-for-service call — closing a ticket no longer
              blindly returns a possibly-unsafe vehicle to service. */}
          {canDo(user, 'ticket.close') && canDecisionClose && decisionClosing && (
            <div className="ticket-inline-form" style={{ marginBottom: 12, padding: '12px 14px' }}>
              <p className="muted" style={{ marginBottom: 10, fontSize: '0.82rem' }}>
                Closing now will mark the {progress.total - progress.done - progress.deferred} unfinished sub-issue(s) as <strong>Deferred</strong>, each with a follow-up issue report so nothing is forgotten.
              </p>
              <SmartForm
                fields={[
                  { label: 'Reason for closing with unfinished work', name: 'deferral_reason', required: true, type: 'textarea', rows: 2 },
                  { label: 'Is the vehicle fit to return to service?', name: 'returned_to_service', required: true, type: 'select', options: [
                    { value: 'yes', label: 'Yes — safe to dispatch' },
                    { value: 'no', label: 'No — keep it out of service' },
                  ], hint: 'No keeps the vehicle Under Maintenance (Needs Repair) so it can\'t be dispatched; the issue report goes back to Pending. Yes returns it to Available — run a readiness check before dispatch.' },
                ]}
                key="decision-close"
                onCancel={() => setDecisionClosing(false)}
                onSubmit={(payload) => onCloseTicket(ticket, {
                  deferral_reason: payload.deferral_reason,
                  returned_to_service: payload.returned_to_service === 'yes',
                }).then((ok) => { if (ok !== false) setDecisionClosing(false); })}
                submitLabel="Close Ticket as Decision"
                title=""
              />
            </div>
          )}

          {/* Rare / destructive actions sit apart on the left, quieter than
              the forward action on the right, so a mis-tap can't land on them. */}
          <div className="ticket-detail-footer-actions">
            <div className="ticket-detail-footer-secondary">
              {/* Once every sub-issue is resolved (ready to close) or the ticket
                  is already Closed, there's real work on record — Delete is only
                  for genuine mistakes, not for discarding finished repairs. */}
              {canDo(user, 'ticket.delete') && ticket.status !== 'Closed' && ticket.status !== 'Pending Approval' && !canClose && (
                <button className="text-danger-button" type="button" onClick={requestDelete}>
                  <Icon name="trash" size={14} /> Delete ticket
                </button>
              )}
              {/* Cancel is excluded once canClose too: every sub-issue is
                  already resolved at that point, so there's real, confirmed
                  work on record — cancelling would void it instead of just
                  abandoning an unstarted/unfinished ticket. A Pending Approval
                  proposal isn't a live ticket yet — Approve/Decline above are
                  its real actions. */}
              {canDo(user, 'ticket.cancel') && ticket.status !== 'Closed' && ticket.status !== 'Cancelled' && ticket.status !== 'Pending Approval' && !canClose && (
                <button className="ghost-button" type="button" onClick={requestCancel}>Cancel ticket</button>
              )}
            </div>
            <div className="ticket-detail-footer-primary">
              {canDo(user, 'ticket.uncancel') && ticket.status === 'Cancelled' && onUncancel && (
                <button className="primary-button" type="button" onClick={() => onUncancel(ticket)}>Restore ticket</button>
              )}
              {/* Close Ticket itself lives in the green banner above when
                  canClose is true — no need to repeat the same button here. */}
              {canDo(user, 'ticket.close') && canDecisionClose && !decisionClosing && (
                <button className="primary-button" type="button" style={{ background: '#b45309', borderColor: '#b45309' }} onClick={() => setDecisionClosing(true)}>Close as decision</button>
              )}
            </div>
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

export function TicketProfilePage({ ticketId, user, userId, ticketLookups, onBack, onDeleteTicket, onRequestConfirmation, ticketAction: sendTicketAction }) {
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

  return (
    <TicketDetailPanel
      asPage
      user={user}
      userId={userId}
      ticket={ticket}
      lookups={ticketLookups}
      onAddSubIssue={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues`, payload, 'Sub-issue added.', 'post').then(afterAction)}
      onEditSubIssue={(t, id, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${id}`, payload, 'Sub-issue updated.').then(afterAction)}
      onDeleteSubIssue={(t, si) => onRequestConfirmation({ title: 'Remove sub-issue?', message: `"${si.title}" will be removed from this ticket.`, confirmLabel: 'Remove', onConfirm: () => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${si.sub_issue_id}`, {}, 'Sub-issue removed.', 'delete').then(afterAction) })}
      onAssignMechanic={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/assign-mechanic`, payload, 'Mechanic assigned — work order dispatched.').then(afterAction)}
      onReassignMechanic={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/reassign-mechanic`, payload, 'Work order reassigned.').then(afterAction)}
      onReassignCustodian={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/reassign-custodian`, payload, 'Custodian reassigned.').then(afterAction)}
      onConfirm={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/confirm`, payload, 'Confirmation verdict submitted.').then(afterAction)}
      onReopenDone={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/reopen-confirmed`, payload, 'Sub-issue reopened for re-verification.').then(afterAction)}
      onVerify={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/verify`, payload, verifySuccessMessage(payload)).then(afterAction)}
      onApproveCannibalization={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/approve-cannibalization`, payload, 'Cannibalized repair approved — a donor-vehicle issue report was opened.').then(afterAction)}
      onRejectCannibalization={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/reject-cannibalization`, payload, 'Cannibalized repair rejected.').then(afterAction)}
      onDeferSubIssue={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/defer`, payload, 'Sub-issue deferred — a follow-up issue report was opened.').then(afterAction)}
      onViewIssue={(id) => navigate(`${roleRoutes[user.role]}/issues/${id}`)}
      onLogRepairs={(t, si) => navigate(`${roleRoutes[user.role]}/work-orders/${t.ticket_id}/${si.sub_issue_id}/log-repairs`)}
      onCloseTicket={(t, payload = {}) => sendTicketAction(`/tickets/${t.ticket_id}/close`, payload, payload.deferral_reason ? 'Ticket closed as a decision.' : 'Ticket closed.').then(afterAction)}
      onCancel={(t) => sendTicketAction(`/tickets/${t.ticket_id}/cancel`, {}, 'Ticket cancelled.').then(afterAction)}
      onUncancel={(t) => sendTicketAction(`/tickets/${t.ticket_id}/uncancel`, {}, 'Ticket restored.').then(afterAction)}
      onDelete={(t) => onDeleteTicket(t).then(onBack)}
      onApproveProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/approve`, payload, 'Ticket proposal approved.').then(afterAction)}
      // Declining deletes the ticket server-side — nothing left to reload,
      // so this navigates away instead, same as onDelete just above.
      onDeclineProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/decline`, payload, 'Ticket proposal declined.').then((ok) => { if (ok) onBack(); return ok; })}
      onRequestConfirmation={onRequestConfirmation}
      onClose={onBack}
    />
  );
}
