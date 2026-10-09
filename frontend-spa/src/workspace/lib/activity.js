// Plain helpers behind Vehicle History and the Activity Log (components live
// in workspace/history/activity.jsx).
import { formatDate } from './format';

// vehicle_histories.related_table -> what that record is called on screen and,
// where the app has a read-only page for it, the route segment that opens it.
const HISTORY_RECORD_KINDS = {
  maintenance_tickets: { label: 'Ticket', path: 'tickets' },
  vehicle_issue_reports: { label: 'Issue report', path: 'issues' },
  vehicle_maintenance_records: { label: 'Maintenance record', path: 'maintenance' },
  vehicle_maintenance_schedules: { label: 'Maintenance schedule' },
  vehicle_condition_checks: { label: 'Condition check' },
  vehicle_documents: { label: 'Document' },
  vehicle_locations: { label: 'Location update' },
  vehicle_readiness_checks: { label: 'Readiness check' },
  vehicle_usage_logs: { label: 'Usage log' },
  vehicles: { label: 'Vehicle record', self: true },
};

// activity_logs.module -> the same, for modules whose affected_record_id is
// consistently that record's own id (see the backend log() call sites).
const LOG_RECORD_KINDS = {
  'Maintenance Tickets': { label: 'Ticket', path: 'tickets' },
  'Vehicle Issue Reports': { label: 'Issue report', path: 'issues' },
  'Vehicle Maintenance Records': { label: 'Maintenance record', path: 'maintenance' },
  'Vehicle Maintenance Schedule': { label: 'Maintenance schedule' },
  'Vehicle Condition Monitoring': { label: 'Condition check' },
  'Vehicle Documents': { label: 'Document' },
  'Vehicle Categories': { label: 'Vehicle type' },
  'Vehicle Location': { label: 'Location update' },
  'Vehicle Management': { label: 'Vehicle', path: 'vehicles' },
  Users: { label: 'User account', path: 'users' },
};

export function historyRecordKind(table) {
  return HISTORY_RECORD_KINDS[table] ?? null;
}

export function logRecordKind(module) {
  return LOG_RECORD_KINDS[module] ?? null;
}

// Plain-text label for a related record — never a bare number without context.
export function relatedRecordText(kind, id) {
  if (id == null || id === '') return '';
  if (kind?.self) return 'Vehicle record';
  return `${kind?.label ?? 'Record'} #${id}`;
}

// Activity-log verbs are stored terse ("Add", "Edit") — read them as what
// happened instead. Anything already descriptive passes through unchanged.
const ACTION_LABELS = {
  Add: 'Created',
  Edit: 'Updated',
  Delete: 'Deleted',
  Archive: 'Archived',
  Activate: 'Activated',
  Deactivate: 'Deactivated',
  Decommission: 'Decommissioned',
  Complete: 'Completed',
};

export function actionLabel(action) {
  if (!action) return 'Action';
  return ACTION_LABELS[action] ?? action;
}

const pad = (n) => String(n).padStart(2, '0');
const localDayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function dayHeading(key) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (key === localDayKey(today)) return 'Today';
  if (key === localDayKey(yesterday)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(y, m - 1, d));
}

// Rows arrive newest-first; consecutive rows that share a calendar day are
// grouped under one heading, keeping that order.
export function groupRowsByDay(rows, field = 'created_at') {
  const groups = [];
  rows.forEach((row) => {
    const date = row[field] ? new Date(row[field]) : null;
    const key = date && !Number.isNaN(date.getTime()) ? localDayKey(date) : 'unknown';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, label: key === 'unknown' ? 'Date not recorded' : dayHeading(key), rows: [row] });
  });
  return groups;
}

export function describeDateRange(start, end) {
  if (!start && !end) return 'All dates';
  if (start && end) return `${formatDate(start)} – ${formatDate(end)}`;
  return start ? `From ${formatDate(start)}` : `Up to ${formatDate(end)}`;
}

export function hasActiveScope({ dateStart, dateEnd, filters = [], search }) {
  return Boolean(dateStart || dateEnd || String(search ?? '').trim() || filters.some((f) => f.values?.length));
}
