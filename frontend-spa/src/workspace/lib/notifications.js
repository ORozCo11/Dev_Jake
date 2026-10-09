

// Every value the backend actually stamps onto a Notification.type (see
// notifyAdmins/notifyCustodians/notifyUser call sites in TicketController.php
// and FleetController.php) mapped to the bell dropdown's visual category.
// Driven off this reliable field instead of guessing from the title text.
export // Several keys below (inspection_*, work_order_assigned/reassigned,
// repairs_approved, sub_issue_confirmed, ticket_ready_to_close,
// work_order_reopened, sub_issue_deferred) are no longer sent by any live
// code path — their features (inspection, per-sub-issue verify/confirm/
// reassign/defer) were replaced by the one-mechanic-per-ticket workflow.
// Kept here anyway, not pruned: a user's existing notification history may
// still contain rows of these types, and removing the mapping would just
// make old notifications fall back to a plain 'info' style instead of their
// original color.
const NOTIFICATION_STYLE_BY_TYPE = {
  // success — a positive/resolved outcome
  sub_issue_confirmed: 'success',
  repairs_approved: 'success',
  ticket_ready_to_close: 'success',
  ticket_closed: 'success',
  ticket_verified: 'success',
  ticket_approved: 'success',
  cannibalization_approved: 'success',
  schedule_restored: 'success',

  // warning — a rejection, rework, deferral, or reopened/recurring problem
  repairs_rejected: 'warning',
  work_order_reopened: 'warning',
  sub_issue_deferred: 'warning',
  ticket_reopened: 'warning',
  ticket_declined: 'warning',
  cannibalization_rejected: 'warning',
  repair_reopened_for_verification: 'warning',
  recurring_fault: 'warning',

  // info — a neutral assignment/submission with no verdict yet
  ticket_prediagnosed: 'info',
  ticket_proposed: 'info',
  inspection_assigned: 'info',
  inspection_submitted: 'info',
  work_order_assigned: 'info',
  work_order_reassigned: 'info',
  ticket_assigned: 'info',
  ticket_reassigned: 'info',
  repairs_completed: 'info',
  cannibalization_pending: 'info',
  maintenance_recorded: 'info',
  maintenance_verification_withdrawn: 'info',
  schedule_assigned: 'info',
  maintenance_verification_needed: 'info',

  // Super Admin
  pending_admin_approval: 'warning',
};

// Backward-compat only: a notification row created before `type` existed (or
// with a type this map hasn't caught up to yet) has no reliable field to key
// off, so fall back to the old title-sniffing guess rather than mislabeling it.
export function legacyNotificationStyleFromTitle(title) {
  if (/confirmed|approved|completed|verified|done/i.test(title)) return 'success';
  if (/reopened|deferred|rejected|sent back/i.test(title)) return 'warning';
  if (/required|assigned|logged|repairs completed|awaiting|pending/i.test(title)) return 'info';
  if (/failed|error/i.test(title)) return 'error';
  return 'info';
}

export function getNotificationStyle(notification) {
  return NOTIFICATION_STYLE_BY_TYPE[notification.type] ?? legacyNotificationStyleFromTitle(notification.title);
}
