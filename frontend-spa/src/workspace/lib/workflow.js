import { idOf } from './format';

// Maps a set of selected severity labels back to the [minIndex, maxIndex]
// span DualRangeSlider needs — the inverse of what applyFilters below does
// when it turns the slider's span back into that same selected-labels array
// (the actual filter state stays a plain string array, same shape every
// other multi-select filter in this app already uses).
export function severityRangeFromSelection(selected, levels) {
  if (!selected?.length) return [0, levels.length - 1];
  const indices = selected.map((s) => levels.indexOf(s)).filter((i) => i !== -1);
  if (!indices.length) return [0, levels.length - 1];
  return [Math.min(...indices), Math.max(...indices)];
}

// An unresolved report that no ticket has been started from yet.
export function issueNeedsTicket(row) {
  return ['Pending', 'Under Review'].includes(row.status) && !row.maintenance_ticket;
}

export const MAINTENANCE_PROGRESS_STAGES = ['Assigned', 'Under Repair', 'For Verification', 'Completed'];

// Where a record sits on the stage trail. Shared by the detail page's stepper
// and the card view's progress bar so the two can never disagree. "On Hold -
// Awaiting Parts" isn't its own stage — it's a stalled 'Under Repair'.
export function maintenanceStageIndex(record) {
  if (record.progress_status === 'On Hold - Awaiting Parts') {
    return MAINTENANCE_PROGRESS_STAGES.indexOf('Under Repair');
  }
  return MAINTENANCE_PROGRESS_STAGES.indexOf(record.progress_status);
}

// A record that reached Completed with no verification result was closed on an
// Admin decision, not on verified work (see decisionCloseMaintenance).
export function isClosedUnverified(record) {
  return record.progress_status === 'Completed' && !record.verification_result;
}

export const RECURRENCE_LABEL = { 1: 'Monthly', 3: 'Quarterly', 6: 'Every 6 months', 12: 'Yearly' };

// #11 — a schedule is overdue when it's still 'Scheduled' but its date has
// already passed (compared date-only, so "today" is never overdue).
export function isScheduleOverdue(row) {
  if (row.status !== 'Scheduled' || !row.scheduled_date) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(row.scheduled_date); due.setHours(0, 0, 0, 0);
  return due < today;
}

export const SCHEDULE_URGENCY_KEYS = ['Overdue', 'Due1to3', 'Due4to7', 'Due8plus'];

// How soon a still-Scheduled row is due, in the same 4 buckets the top-row
// urgency stat cards count and filter by. Null for anything that isn't an
// upcoming Scheduled row (Completed/Cancelled rows have no "due in" left).
export function scheduleUrgencyBucket(row) {
  if (row.status !== 'Scheduled' || !row.scheduled_date) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(row.scheduled_date); due.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days <= 0) return 'Overdue';
  if (days <= 3) return 'Due1to3';
  if (days <= 7) return 'Due4to7';
  return 'Due8plus';
}

export function scheduleDueLabel(row) {
  if (row.status !== 'Scheduled' || !row.scheduled_date) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(row.scheduled_date); due.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}


// =========================================================================
// TICKET WORKFLOW FIELD FACTORIES
// =========================================================================

// Flattens a ticket's sub_issues into standalone rows carrying their parent
// ticket's context (vehicle, priority, custodian, etc.) — used by the
// Mechanic Work Order queue and the Custodian Verification queue, which now
// act on one sub-issue at a time instead of a whole ticket. Pass
// `mechanicId` to further restrict to that mechanic's own assigned lines
// (a ticket can carry sub-issues split across several mechanics).
export function flattenSubIssueRows(tickets, mechanicId = null) {
  const rows = [];
  (tickets ?? []).forEach((ticket) => {
    (ticket.sub_issues ?? []).forEach((subIssue) => {
      if (mechanicId && subIssue.assigned_mechanic_id !== mechanicId) return;
      rows.push({
        ...subIssue,
        ticket_id: ticket.ticket_id,
        ticket_title: ticket.ticket_title,
        ticket_description: ticket.ticket_description,
        ticket_status: ticket.status,
        vehicle: ticket.vehicle,
        priority: ticket.priority,
        assigned_custodian: ticket.assigned_custodian,
        created_at: ticket.created_at,
      });
    });
  });
  return rows;
}

// One entry per ticket (a sub-issue belongs to exactly one ticket, which
// belongs to exactly one vehicle) — so a vehicle with several sub-issues
// dispatched to the same mechanic collapses into a single list entry
// instead of a separate table row per Cause. Mirrors groupWorkTrackerByTicket
// below, but tailored to flattenSubIssueRows' shape (no isMechanic/isVerifier
// flags — "needs action" here is just "still Under Repair").
export function groupMechanicRowsByTicket(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.ticket_id)) {
      map.set(row.ticket_id, {
        ticket_id: row.ticket_id,
        ticket_title: row.ticket_title,
        vehicle: row.vehicle,
        subIssues: [],
      });
    }
    map.get(row.ticket_id).subIssues.push(row);
  });
  return Array.from(map.values()).map((group) => ({
    ...group,
    needsAction: group.subIssues.some((s) => s.status === 'Under Repair'),
  }));
}

// Flattens role-scoped tickets into one row per sub-issue THIS user is tied to,
// tagged with how they're involved (Mechanic / Custodian / both). A ticket may
// carry sibling sub-issues owned by other people — those are skipped.
export function flattenWorkTrackerRows(tickets, user) {
  const uid = user?.id;
  const rows = [];
  (tickets ?? []).forEach((ticket) => {
    (ticket.sub_issues ?? []).forEach((si) => {
      const isMechanic = si.assigned_mechanic_id === uid;
      const isVerifier = ticket.assigned_custodian_id === uid || idOf(si.verification_assigned_to) === uid;
      if (!isMechanic && !isVerifier) return;

      const relationship = (isMechanic && isVerifier) ? 'Mechanic + Custodian'
        : isMechanic ? 'Mechanic' : 'Custodian';

      // Latest timestamp across every event that could have touched this line,
      // so "Last Update" reflects real activity rather than row creation.
      const stamps = [
        si.reopened_at, si.confirmed_at, si.verified_at, si.repair_completed_at,
        si.mechanic_assigned_at, si.deferred_at, ticket.created_at,
      ].filter(Boolean);
      let lastIso = ticket.created_at ?? null;
      let lastTs = 0;
      stamps.forEach((s) => {
        const t = new Date(s).getTime();
        if (t >= lastTs) { lastTs = t; lastIso = s; }
      });

      rows.push({
        _rowKey: `wt-${ticket.ticket_id}-${si.sub_issue_id}`,
        ticket_id: ticket.ticket_id,
        ticket_title: ticket.ticket_title,
        sub_issue_id: si.sub_issue_id,
        title: si.title,
        status: si.status,
        vehicle: ticket.vehicle,
        relationship,
        isMechanic,
        isVerifier,
        maintenance_type: si.maintenance_type,
        assigned_mechanic: si.assigned_mechanic,
        verification_verdict: si.verification_verdict,
        confirmation_verdict: si.confirmation_verdict,
        reopened_at: si.reopened_at,
        confirmed_at: si.confirmed_at,
        deferred_at: si.deferred_at,
        lastActivityIso: lastIso,
        lastActivityTs: lastTs,
      });
    });
  });
  return rows;
}

// The single outcome label a user cares about at a glance, plus a tone that
// drives its color. Ordered from most-final (Confirmed) to earliest (Open).
export function workTrackerOutcome(row) {
  const { status, verification_verdict, confirmation_verdict, reopened_at } = row;
  if (status === 'Done' && confirmation_verdict === 'Confirmed') return { label: 'Confirmed — Done', tone: 'success' };
  if (reopened_at && status === 'For Inspection')                return { label: 'Reopened by Admin', tone: 'warning' };
  if (status === 'For Confirmation')                             return { label: 'Approved — awaiting Admin', tone: 'info' };
  if (status === 'Under Repair' && verification_verdict === 'Rejected') return { label: 'Rejected — redo repair', tone: 'warning' };
  if (status === 'For Inspection')                               return { label: 'Awaiting your verification', tone: 'info' };
  if (status === 'Under Repair')                                 return { label: 'In repair', tone: 'info' };
  if (status === 'Deferred')                                     return { label: 'Deferred', tone: 'warning' };
  if (status === 'Open')                                         return { label: 'Awaiting assignment', tone: 'neutral' };
  return { label: status ?? '—', tone: 'neutral' };
}

// True when the item is sitting in THIS user's court needing action — the
// mechanic still owes a repair log, or the verifier still owes a verification.
export function workTrackerNeedsAction(row) {
  if (row.isMechanic && row.status === 'Under Repair') return true;
  if (row.isVerifier && row.status === 'For Inspection') return true;
  return false;
}

export function workTrackerBucket(row) {
  if (workTrackerNeedsAction(row)) return 'attention';
  if (row.status === 'Done' || row.status === 'Deferred') return 'completed';
  return 'progress';
}

// Master-detail grouping: one entry per ticket (a sub-issue belongs to exactly
// one ticket, which belongs to exactly one vehicle), so a vehicle with many
// sub-issues collapses to a single list entry instead of many table rows.
// Sorted the same way the old flat list was — action-needed first, then most
// recently active — so the master list surfaces what matters without scrolling.
export function groupWorkTrackerByTicket(rows) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.ticket_id)) {
      map.set(row.ticket_id, {
        ticket_id: row.ticket_id,
        ticket_title: row.ticket_title,
        vehicle: row.vehicle,
        subIssues: [],
        lastActivityTs: 0,
        lastActivityIso: null,
      });
    }
    const group = map.get(row.ticket_id);
    group.subIssues.push(row);
    if (row.lastActivityTs >= group.lastActivityTs) {
      group.lastActivityTs = row.lastActivityTs;
      group.lastActivityIso = row.lastActivityIso;
    }
  });

  return Array.from(map.values())
    .map((group) => ({ ...group, needsAction: group.subIssues.some(workTrackerNeedsAction) }))
    .sort((a, b) => {
      const an = a.needsAction ? 1 : 0;
      const bn = b.needsAction ? 1 : 0;
      if (an !== bn) return bn - an;
      return b.lastActivityTs - a.lastActivityTs;
    });
}

export const READINESS_BADGE = {
  ready:          { label: 'Ready to respond', bg: '#ecfdf5', color: '#065f46', border: '#a7f3d0', icon: 'checkCircle' },
  stale:          { label: 'Readiness check', bg: '#fef3c7', color: '#92400e', border: '#fde68a', icon: 'alert' },
  not_ready:      { label: 'NOT ready to respond', bg: '#fee2e2', color: '#b91c1c', border: '#fecaca', icon: 'alert' },
  unchecked:      { label: 'Never checked', bg: '#f1f5f9', color: '#475569', border: '#cbd5e1', icon: 'alert' },
  in_maintenance: { label: 'In maintenance', bg: '#fff7ed', color: '#9a3412', border: '#fed7aa', icon: 'wrench' },
  retired:        { label: 'Out of fleet', bg: '#f1f5f9', color: '#475569', border: '#cbd5e1', icon: 'alert' },
};

// =========================================================================
// TICKET CARD
// =========================================================================

// A ticket's broad status (Open/Active/Closed/Cancelled) doesn't say whose
// turn it is right now — "Active" alone looks the same whether a mechanic
// is still mid-repair, or the Custodian/Admin already responded and it's
// sitting untouched waiting for someone. This derives the actual next step
// from the ticket + its sub-issues, so that's visible at a glance instead of
// hiding behind a generic unread-notification counter.
export function ticketWorkflowStage(ticket) {
  if (ticket.status === 'Open') {
    return { label: 'Awaiting Custodian Inspection', tone: 'waiting' };
  }
  if (ticket.status !== 'Active') {
    return null; // Closed/Cancelled — the status badge alone already says enough.
  }
  const subIssues = ticket.sub_issues ?? [];
  if (subIssues.some((s) => s.status === 'For Confirmation')) {
    return { label: 'Awaiting Your Confirmation', tone: 'action' };
  }
  if (subIssues.some((s) => s.status === 'Open')) {
    return { label: 'Diagnosed — Assign a Mechanic', tone: 'action' };
  }
  // The mechanic already submitted repair logs (logRepairs sets this) — the
  // ball is in the Custodian's court now, not stuck/idle like the generic
  // "In Repair" fallback below implies.
  if (subIssues.some((s) => s.status === 'For Inspection')) {
    return { label: 'Awaiting Custodian Verification', tone: 'waiting' };
  }
  const total = ticket.progress?.total ?? subIssues.length;
  const done = ticket.progress?.done ?? subIssues.filter((s) => s.status === 'Done').length;
  if (total > 0 && done === total) {
    return { label: 'Ready to Close', tone: 'action' };
  }
  return { label: 'In Repair', tone: 'info' };
}

// Deliberately NOT another rounded status-badge capsule — Priority and
// Status already share that exact look (and, in this app's dark/light
// theme CSS, Medium/High priority and Active status even share the same
// amber color), so a third pill in the same shape just reads as more of
// the same noise. A flat-edged strip with a left accent bar reads as its
// own distinct thing: a callout, not another label.
export const TICKET_STAGE_STYLE = {
  action:  { bg: 'linear-gradient(90deg,#faf5ff,#ede9fe)', color: '#5b21b6', icon: 'alert' },
  waiting: { bg: 'linear-gradient(90deg,#eff6ff,#dbeafe)', color: '#1d4ed8', icon: 'search' },
  info:    { bg: 'linear-gradient(90deg,#f8fafc,#f1f5f9)', color: '#475569', icon: 'wrench' },
};

// =========================================================================
// TICKET PHASE HELPERS
// =========================================================================

// A ticket now only moves through 3 stages at the ticket level — the real
// work happens per sub-issue (see TicketDetailPanel's sub-issue checklist,
// which uses this same TicketStatusBadge for each line's own status).
export const phaseOrder = ['Open', 'Active', 'Closed'];

export const PHASE_STEP_ICONS = {
  'Open': 'clipboard',
  'Active': 'wrench',
  'Closed': 'checkCircle',
};

export const PHASE_STEP_COLORS = {
  'Open': '#2563eb',
  'Active': '#d97706',
  'Closed': '#16a34a',
};

// Toast after a Custodian's repair verification — names who was notified
// (TicketController::verifyRepair: Admins on approval, the mechanic on
// rejection) so the next step is clear.
export function verifySuccessMessage(payload) {
  return payload?.verification_verdict === 'Rejected'
    ? 'Repair rejected and sent back. The mechanic has been notified to redo it.'
    : 'Repair approved. The Admin has been notified to confirm it.';
}
