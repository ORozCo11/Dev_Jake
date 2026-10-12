

export const ISSUE_STATUS_COLORS = {
  'Pending': '#f59e0b',
  'Under Review': '#a855f7',
  'In Maintenance': '#2563eb',
  'Resolved': '#22c55e',
};

// NOTE: no "In Use" card — the status exists in the DB enum but this system
// tracks availability only (no dispatch flow ever sets a vehicle to In Use).
export const VEHICLE_STAT_CARDS = [
  { key: 'Available', label: 'Available', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
  { key: 'Under Maintenance', label: 'Under Maintenance', icon: 'wrench', bg: '#fef3c7', color: '#b45309' },
  // Distinct from "Available" — a vehicle can be Available yet never (or no
  // longer) proven ready by an actual readiness check. See responseReadinessState().
  { key: 'NotReady', label: 'Not Ready to Respond', icon: 'alert', bg: '#fee2e2', color: '#b91c1c' },
];

export const ISSUE_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'alert', bg: '#fef3c7', color: '#b45309' },
  { key: 'Under Review', label: 'Under Review', icon: 'search', bg: '#e0f2fe', color: '#0369a1' },
  { key: 'In Maintenance', label: 'In Maintenance', icon: 'wrench', bg: '#fee2e2', color: '#b91c1c' },
  { key: 'Resolved', label: 'Resolved', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
];

// Severity filter chips — same colors as the Issue Reports bar chart's own
// High/Medium/Low segments (see the StackedBarChart segments).
export const ISSUE_SEVERITY_CHIP_BG = { High: '#fee2e2', Medium: '#fef3c7', Low: '#e0f2fe' };
export const ISSUE_SEVERITY_CHIP_COLOR = { High: '#b91c1c', Medium: '#b45309', Low: '#0369a1' };

// Simplified per product direction: the urgency breakdown (Overdue/1-3
// Days/4-7 Days) was its own set of cards here — removed in favor of a
// plain upcoming list elsewhere on the dashboard. Row-level "Overdue"
// badges (isScheduleOverdue) still show urgency per-row; this stat row now
// only tracks status.
export const SCHEDULE_STAT_CARDS = [
  { key: 'Pending Approval', label: 'Pending Approval', icon: 'alert', bg: '#fef3c7', color: '#b45309' },
  { key: 'Declined', label: 'Declined', icon: 'close', bg: '#fee2e2', color: '#b91c1c' },
  { key: 'Completed', label: 'Completed', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
  // A schedule marked "Completed" only means the calendar task is done —
  // its record might still be sitting unverified. Its own filter so those
  // rows are findable instead of scrolling through fully-verified ones.
  { key: 'AwaitingVerification', label: 'Awaiting Verification', icon: 'search', bg: '#fef9c3', color: '#854d0e' },
  { key: 'Cancelled', label: 'Cancelled', icon: 'close', bg: '#f1f5f9', color: '#64748b' },
];

// Only shown to a Maintenance-Personnel-only viewer — "how many vehicles do
// I still need to do", not the fleet-wide count everyone else also sees.
export const MY_ASSIGNED_SCHEDULE_CARD = { key: 'MyAssigned', label: 'Assigned to You', icon: 'wrench', bg: '#eff6ff', color: '#1d4ed8' };

export const CONDITION_STAT_CARDS = [
  { key: 'Good', label: 'Good', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
  // Same tones as the .status-badge result pills (amber = look closer,
  // red = needs repair), so a result reads the same colour on every page.
  { key: 'Needs Inspection', label: 'Needs Inspection', icon: 'search', bg: '#fef3c7', color: '#b45309' },
  { key: 'Needs Repair', label: 'Needs Repair', icon: 'wrench', bg: '#fee2e2', color: '#b91c1c' },
  { key: 'Not Checked', label: 'Not Checked', icon: 'eyeOff', bg: '#f1f5f9', color: '#64748b' },
];

export const MAINTENANCE_RECORD_STAT_CARDS = [
  { key: 'Assigned', label: 'Assigned', icon: 'clipboard', bg: '#e0f2fe', color: '#0369a1' },
  { key: 'Under Repair', label: 'Under Repair', icon: 'wrench', bg: '#fef3c7', color: '#b45309' },
  { key: 'For Verification', label: 'For Verification', icon: 'search', bg: '#ede9fe', color: '#7c3aed' },
  { key: 'Completed', label: 'Completed', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
];

// 'Open' removed — no new ticket ever reaches that status (propose goes
// straight to Pending Approval); it only ever existed on tickets created
// before the one-mechanic-per-ticket redesign.
export const TICKET_STAT_CARDS = [
  { key: 'Pending Approval', label: 'Proposals', icon: 'clipboard', bg: '#fef9c3', color: '#a16207' },
  // "For Verification" was here, but that's a Custodian action, not
  // something Admin does anything with — Declined is the one Admin needs a
  // quick count of, since those proposals are waiting on a reconsider.
  { key: 'Declined', label: 'Declined', icon: 'close', bg: '#fee2e2', color: '#b91c1c' },
  { key: 'Active', label: 'Active', icon: 'wrench', bg: '#fef3c7', color: '#b45309' },
  { key: 'Closed', label: 'Closed', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
  { key: 'Cancelled', label: 'Cancelled', icon: 'close', bg: '#f1f5f9', color: '#475569' },
];

export const TICKET_INSPECTION_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'search', bg: '#fef3c7', color: '#b45309' },
  // Label says "Diagnosed", not "Inspected" — this bucket also holds
  // Pre-Diagnosed tickets this Custodian never actually inspected (the key
  // stays 'Inspected' since that's what the status !== 'Open' filter above
  // keys off of).
  { key: 'Inspected', label: 'Diagnosed', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
];

export const TICKET_WORK_ORDER_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'wrench', bg: '#fef3c7', color: '#b45309' },
  { key: 'Submitted', label: 'Submitted', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
];

// 'Pending' relabeled 'To Verify' — this is the Custodian's verification
// queue (For Verification tickets), same term the Dashboard's own stat uses
// for it; the old label read as just another ticket-status bucket instead
// of the one that needs this Custodian's action.
export const TICKET_VERIFICATION_STAT_CARDS = [
  { key: 'Active', label: 'Active', icon: 'wrench', bg: '#fef9c3', color: '#a16207' },
  { key: 'Pending', label: 'To Verify', icon: 'checkCircle', bg: '#fef3c7', color: '#b45309' },
  { key: 'Verified', label: 'Verified', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
];

// My Tasks -> History: a closed book, not a live board — every bucket here
// is already finished, so the cards break down HOW it finished rather than
// repeating "needs action"/"in progress" counts that would always read 0.
export const WORK_TRACKER_STAT_CARDS = [
  { key: 'Done', label: 'Done', icon: 'checkCircle', bg: '#dcfce7', color: '#15803d' },
  { key: 'Deferred', label: 'Deferred', icon: 'alert', bg: '#fef3c7', color: '#b45309' },
];

// One consistent pill color per module string, picked deterministically (a
// hash of the name) from a fixed palette — so "Vehicle Management" is always
// the same color everywhere it appears, without hand-maintaining a lookup
// table for every module string the backend might ever log.
export const MODULE_BADGE_PALETTE = [
  { bg: '#fef3c7', color: '#92400e' },
  { bg: '#dbeafe', color: '#1d4ed8' },
  { bg: '#dcfce7', color: '#166534' },
  { bg: '#fce7f3', color: '#9d174d' },
  { bg: '#ede9fe', color: '#5b21b6' },
  { bg: '#e0f2fe', color: '#075985' },
  { bg: '#fee2e2', color: '#991b1b' },
  { bg: '#f1f5f9', color: '#334155' },
];
export function moduleBadgeTone(moduleName = '') {
  let hash = 0;
  for (let i = 0; i < moduleName.length; i += 1) hash = (hash * 31 + moduleName.charCodeAt(i)) >>> 0;
  return MODULE_BADGE_PALETTE[hash % MODULE_BADGE_PALETTE.length];
}

// "Card View / List View" selector — a labeled dropdown (Realcore-style) that
// replaces the old two-icon toggle in panel header bars.
export const VIEW_MODE_OPTIONS = [
  { value: 'card', label: 'Card View', icon: 'grid' },
  { value: 'table', label: 'List View', icon: 'list' },
];

// Fleet Capability & Readiness Impact — final feature pass (2026-10-10).
// The per-vehicle Criticality Watch above, rolled up to "which emergency
// capability is at risk?" per Vehicle Type. Entirely server-computed
// (capability_impact on the dashboard response) — this component only
// renders what it's given, it never recomputes readiness/criticality itself.
export const CAPABILITY_STATE_LABEL = { LIMITED: 'Limited', AT_RISK: 'At Risk', NO_COVERAGE: 'No Coverage' };
