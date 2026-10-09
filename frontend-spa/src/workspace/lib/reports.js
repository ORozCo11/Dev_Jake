import { reportColumns } from '../columns';
import { options } from './format';
import { READINESS_BADGE } from './workflow';

export const REPORT_CATALOG = [
  {
    category: 'Fleet Reports',
    icon: 'vehicle',
    reports: [
      { type: 'Vehicle Inventory Report', icon: 'grid', description: 'Full list of every registered vehicle.', fields: [] },
      { type: 'Vehicle Type Report', icon: 'list', description: 'Vehicles filtered by vehicle type.', fields: ['category_id'] },
      { type: 'Vehicle Location Report', icon: 'pin', description: 'Vehicles filtered by current location.', fields: ['location'] },
    ],
  },
  {
    category: 'Issue Reports',
    icon: 'alert',
    reports: [
      { type: 'Vehicle Issue Report', icon: 'alert', description: 'Reported issues filtered by type, severity, and date.', fields: ['issue_type', 'severity_level', 'dates'] },
    ],
  },
  {
    category: 'Maintenance Reports',
    icon: 'wrench',
    reports: [
      { type: 'Vehicle Maintenance Report', icon: 'wrench', description: 'Repair records filtered by maintenance type and date.', fields: ['maintenance_type', 'dates'] },
      { type: 'Vehicle Maintenance Schedule Report', icon: 'calendar', description: 'Scheduled maintenance within a date range.', fields: ['dates'] },
    ],
  },
  {
    category: 'History Reports',
    icon: 'clipboard',
    reports: [
      { type: 'Vehicle History Report', icon: 'archive', description: 'Full activity timeline across every vehicle.', fields: [] },
    ],
  },
];

export function reportFieldDefs(lookups, reportDef) {
  if (!reportDef) return [];
  const defs = [];
  if (reportDef.fields.includes('dates')) {
    defs.push({ label: 'Date From', name: 'from', type: 'date' });
    defs.push({ label: 'Date To', name: 'to', type: 'date' });
  }
  if (reportDef.fields.includes('category_id')) {
    defs.push({ label: 'Vehicle Type', name: 'category_id', options: options(lookups.categories, 'category_id', 'category_name'), type: 'select' });
  }
  if (reportDef.fields.includes('location')) {
    defs.push({ label: 'Location', name: 'location', type: 'text' });
  }
  if (reportDef.fields.includes('maintenance_type')) {
    defs.push({ label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types, type: 'select' });
  }
  if (reportDef.fields.includes('issue_type')) {
    defs.push({ label: 'Issue Type', name: 'issue_type', options: lookups.issue_types, type: 'select' });
  }
  if (reportDef.fields.includes('severity_level')) {
    defs.push({ label: 'Severity Level', name: 'severity_level', options: lookups.severity_levels, type: 'select' });
  }
  return defs;
}

// Cycled per category (not stored on REPORT_CATALOG itself) so adding a
// fifth category just wraps back to blue rather than needing a color picked
// for it — same reasoning as the chart palettes elsewhere in this file.
export const REPORT_CATEGORY_TONES = ['blue', 'green', 'purple', 'amber'];

export const VEHICLE_HISTORY_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.history_id },
  { label: 'Vehicle', value: (r) => (r.vehicle ? `${r.vehicle.vehicle_name} (${r.vehicle.plate_number})` : '') },
  { label: 'Activity', value: (r) => r.activity_type },
  { label: 'Related Record', value: (r) => r.related_record_id ?? '' },
  { label: 'Updated By', value: (r) => r.updated_by?.name ?? '' },
  { label: 'Description', value: (r) => r.description ?? '' },
  { label: 'Date', value: (r) => r.created_at },
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
