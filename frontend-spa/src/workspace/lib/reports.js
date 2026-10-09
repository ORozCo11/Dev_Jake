import { reportColumns } from '../columns';
import { describeDateRange, historyRecordKind, relatedRecordText } from './activity';
import { formatLogDateTime, options } from './format';
import { READINESS_BADGE } from './workflow';

// Report templates grouped by the question they answer. `type` is the exact
// report_type the backend switches on (FleetController::reports) — never
// rename it. `required` lists the filters Generate waits for; `includes` is
// a short sample of what the report contains; `wide` reports default to
// landscape when printed.
export const REPORT_CATALOG = [
  {
    category: 'Fleet Readiness',
    purpose: 'What vehicles you have, where they are, and whether they can respond.',
    icon: 'vehicle',
    tone: 'blue',
    reports: [
      { type: 'Vehicle Inventory Report', icon: 'grid', description: 'Every registered vehicle with its current status and condition.', includes: 'Vehicle, plate, type, brand/model, status, condition, location', fields: [], wide: true },
      { type: 'Vehicle Type Report', icon: 'list', description: 'All vehicles of one type — e.g. every ambulance — and their status.', includes: 'Vehicle, plate, type, status, condition, location', fields: ['category_id'], required: ['category_id'], wide: true },
      { type: 'Vehicle Location Report', icon: 'pin', description: 'Vehicles currently stationed at one location.', includes: 'Vehicle, plate, type, status, location', fields: ['location'], required: ['location'], wide: true },
    ],
  },
  {
    category: 'Maintenance',
    purpose: 'Repair work done and preventive maintenance coming up.',
    icon: 'wrench',
    tone: 'green',
    reports: [
      { type: 'Vehicle Maintenance Report', icon: 'wrench', description: 'Repair and service records, optionally for one maintenance type or period.', includes: 'Vehicle, maintenance type, personnel, start/completion dates, status', fields: ['maintenance_type', 'dates'], wide: true },
      { type: 'Vehicle Maintenance Schedule Report', icon: 'calendar', description: 'Planned maintenance within a date range.', includes: 'Vehicle, maintenance type, scheduled date/time, assignee, status', fields: ['dates'], wide: true },
    ],
  },
  {
    category: 'Issues',
    purpose: 'Problems reported on vehicles and how severe they are.',
    icon: 'alert',
    tone: 'amber',
    reports: [
      { type: 'Vehicle Issue Report', icon: 'alert', description: 'Reported issues, optionally by type, severity, and period.', includes: 'Vehicle, issue type, severity, status, reporter, date reported', fields: ['issue_type', 'severity_level', 'dates'], wide: true },
    ],
  },
  {
    category: 'Accountability',
    purpose: 'What happened to each vehicle, who did it, and when.',
    icon: 'clipboard',
    tone: 'purple',
    reports: [
      { type: 'Vehicle History Report', icon: 'archive', description: 'The full activity timeline across every vehicle.', includes: 'Vehicle, activity, description, updated by, date', fields: [], wide: true },
    ],
  },
];

// Filter inputs for one report template. Each def: { label, name, type,
// options?, required?, hint? } — rendered by ReportGeneratorForm.
export function reportFieldDefs(lookups, reportDef) {
  if (!reportDef) return [];
  const required = new Set(reportDef.required ?? []);
  const defs = [];
  if (reportDef.fields.includes('category_id')) {
    defs.push({ label: 'Vehicle Type', name: 'category_id', options: options(lookups.categories ?? [], 'category_id', 'category_name'), type: 'select', required: required.has('category_id') });
  }
  if (reportDef.fields.includes('location')) {
    const locations = [...new Set((lookups.vehicles ?? []).map((v) => v.current_location).filter(Boolean))].sort();
    defs.push(locations.length
      ? { label: 'Location', name: 'location', options: locations.map((l) => ({ value: l, label: l })), type: 'select', required: required.has('location') }
      : { label: 'Location', name: 'location', type: 'text', required: required.has('location'), hint: 'Exact location name, as recorded on the vehicle.' });
  }
  if (reportDef.fields.includes('maintenance_type')) {
    defs.push({ label: 'Maintenance Type', name: 'maintenance_type', options: (lookups.maintenance_types ?? []).map((t) => ({ value: t, label: t })), type: 'select', required: required.has('maintenance_type') });
  }
  if (reportDef.fields.includes('issue_type')) {
    defs.push({ label: 'Issue Type', name: 'issue_type', options: (lookups.issue_types ?? []).map((t) => ({ value: t, label: t })), type: 'select', required: required.has('issue_type') });
  }
  if (reportDef.fields.includes('severity_level')) {
    defs.push({ label: 'Severity Level', name: 'severity_level', options: (lookups.severity_levels ?? []).map((t) => ({ value: t, label: t })), type: 'select', required: required.has('severity_level') });
  }
  if (reportDef.fields.includes('dates')) {
    defs.push({ label: 'Date From', name: 'from', type: 'date' });
    defs.push({ label: 'Date To', name: 'to', type: 'date' });
  }
  return defs;
}

// Human-readable list of the filters a report was generated with, for the
// preview and the printed header. Lookup ids are resolved to their names.
export function describeReportFilters(filters = {}, lookups = {}) {
  const parts = [];
  if (filters.category_id) {
    const category = (lookups.categories ?? []).find((c) => String(c.category_id) === String(filters.category_id));
    parts.push({ label: 'Vehicle type', value: category?.category_name ?? `Type #${filters.category_id}` });
  }
  if (filters.location) parts.push({ label: 'Location', value: filters.location });
  if (filters.maintenance_type) parts.push({ label: 'Maintenance type', value: filters.maintenance_type });
  if (filters.issue_type) parts.push({ label: 'Issue type', value: filters.issue_type });
  if (filters.severity_level) parts.push({ label: 'Severity', value: filters.severity_level });
  if (filters.from || filters.to) parts.push({ label: 'Period', value: describeDateRange(filters.from, filters.to) });
  return parts;
}

export function findReportDef(type) {
  for (const group of REPORT_CATALOG) {
    const found = group.reports.find((r) => r.type === type);
    if (found) return found;
  }
  return null;
}

export const VEHICLE_HISTORY_EXPORT_COLUMNS = [
  { label: 'Entry #', value: (r) => r.history_id },
  { label: 'Date and Time', value: (r) => formatLogDateTime(r.created_at) },
  { label: 'Vehicle', value: (r) => (r.vehicle ? `${r.vehicle.vehicle_name} (${r.vehicle.plate_number})` : '') },
  { label: 'Activity', value: (r) => r.activity_type },
  { label: 'Description', value: (r) => r.description ?? '' },
  { label: 'Related Record', value: (r) => relatedRecordText(historyRecordKind(r.related_table), r.related_record_id) },
  { label: 'Updated By', value: (r) => r.updated_by?.name ?? 'System' },
  { label: 'Role', value: (r) => r.updated_by?.role ?? '' },
];

// Flat, CSV-exportable version of the same columns `reportColumns` renders
// for on-screen/print display — `exportRowsToCsv` needs a `value(row)`
// shape rather than `render(row)`.
export function reportExportColumns(rows) {
  return reportColumns(rows).map((col) => ({ label: col.label, value: (row) => col.render(row) }));
}

// Builds a CSV file from `columns` (each { label, value(row) }) and `rows`,
// then triggers a browser download named `filename`.
export function exportRowsToCsv(filename, columns, rows) {
  const escapeCell = (value) => {
    const str = String(value ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [columns.map((c) => escapeCell(c.label)).join(',')];
  rows.forEach((row) => {
    lines.push(columns.map((c) => escapeCell(c.value(row))).join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const VEHICLE_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.vehicle_id },
  { label: 'Vehicle Name', value: (r) => r.vehicle_name },
  { label: 'Plate Number', value: (r) => r.plate_number },
  { label: 'Type', value: (r) => r.category?.category_name ?? 'Unassigned' },
  { label: 'Brand', value: (r) => r.brand },
  { label: 'Model', value: (r) => r.model },
  { label: 'Capacity', value: (r) => r.capacity },
  { label: 'Location', value: (r) => r.current_location },
  { label: 'Status', value: (r) => r.status },
  { label: 'Condition', value: (r) => r.condition },
  { label: 'Ready to Respond', value: (r) => READINESS_BADGE[r.readiness_state]?.label ?? '' },
];

export const USER_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.id },
  { label: 'Name', value: (r) => r.name },
  { label: 'Email', value: (r) => r.email },
  { label: 'Phone', value: (r) => r.phone ?? '' },
  { label: 'Role', value: (r) => ((Array.isArray(r.roles) && r.roles.length) ? r.roles : [r.role].filter(Boolean)).join(', ') },
  { label: 'Status', value: (r) => (r.is_active ? 'Active' : 'Inactive') },
];

export const SCHEDULE_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.schedule_id },
  { label: 'Vehicle', value: (r) => (r.vehicle ? `${r.vehicle.vehicle_name} (${r.vehicle.plate_number})` : '') },
  { label: 'Type', value: (r) => r.maintenance_type },
  { label: 'Date', value: (r) => r.scheduled_date },
  { label: 'Time', value: (r) => r.scheduled_time },
  { label: 'Location', value: (r) => r.service_location },
  { label: 'Status', value: (r) => r.status },
];
