import api from '../../api/axios';

export function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Formats a plain YYYY-MM-DD date for the Availability Forecast (e.g. "Jul 14, 2026").
export function formatForecastDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function firstName(name = 'User') {
  return (String(name || 'User').trim().split(/\s+/)[0] || 'User').toUpperCase();
}

export const EMPTY_OBJ = {};
export const EMPTY_ARR = [];

// "X ago" — coarse, single-unit relative time (seconds up to years), the
// same granularity a typical activity-feed timestamp uses.
export function timeAgo(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secondsInUnit] of units) {
    const count = Math.floor(seconds / secondsInUnit);
    if (count >= 1) return `${count} ${unit}${count > 1 ? 's' : ''} ago`;
  }
  return 'Just now';
}

// "09/16/26 - 7:05 am" — a single plain-text column combining date and time,
// in place of the DateBadge/Time column pair every other table uses; the
// activity log reads as a dense audit trail, not a dashboard, so the chunky
// colored badge tile is more visual weight than the row needs.
export function formatLogDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  const time = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(date).toLowerCase();
  return `${mm}/${dd}/${yy} - ${time}`;
}

// Common "this is the human-readable name" field on the loaded relation
// objects reports eager-load (Vehicle, VehicleCategory, User, ...) — tried
// in order so a resolved name shows instead of a bare foreign-key id.
export function resolveRelationLabel(value) {
  if (!value || typeof value !== 'object') return null;
  return value.name ?? value.vehicle_name ?? value.category_name ?? value.title ?? (value.id != null ? `#${value.id}` : null);
}

export function prettifyKey(key) {
  return key.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// The backend stores absolute image URLs built from APP_URL, which often points
// at a different host/port than where the API is actually served (e.g. stored as
// localhost:8000 but served on 127.0.0.1:8001). Rewrite local-host URLs to the
// real API origin so images load; leave external URLs (e.g. Supabase) untouched.
export const API_ORIGIN = (api.defaults.baseURL || '').replace(/\/api\/?$/, '');

// Only these protocols may ever reach an href/src. Blocks javascript:, data:,
// vbscript: etc. from rendering live — defense in depth, since these URLs are
// server-generated today but this guarantees it stays safe regardless.
export const SAFE_URL_PROTOCOLS = ['http:', 'https:'];

export function resolvePhotoUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    if (!SAFE_URL_PROTOCOLS.includes(parsed.protocol)) {
      return ''; // unsafe scheme — refuse to render it
    }
    const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname);
    if (isLocalHost && API_ORIGIN) {
      const base = new URL(API_ORIGIN);
      parsed.protocol = base.protocol;
      parsed.host = base.host;
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

export function options(items, valueKey, labelKey) {
  return items.map((item) => ({
    value: item[valueKey],
    label: item[labelKey],
  }));
}

// Inactive (archived) vehicles are excluded from every "pick a vehicle"
// dropdown app-wide — you can't schedule/report/record work against a
// vehicle that's been taken out of service.
export function vehicleOptions(lookups) {
  return lookups.vehicles
    .filter((vehicle) => vehicle.status !== 'Inactive' && vehicle.status !== 'Decommissioned')
    .map((vehicle) => ({
      value: vehicle.vehicle_id,
      label: vehicleLabel(vehicle),
    }));
}

export function vehicleLabel(vehicle) {
  if (!vehicle) {
    return '-';
  }

  return `${vehicle.vehicle_name} (${vehicle.plate_number})`;
}

export function formatDate(value) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: value.includes?.('T') ? 'short' : undefined,
  }).format(new Date(value));
}

// Plain time-of-day text for the "Time" column that sits next to a
// DateBadge column — blank for date-only fields (no time component).
export function formatTime(value) {
  if (!value || typeof value !== 'string' || !value.includes('T')) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('en-PH', { timeStyle: 'short' }).format(date);
}

export function rowKey(row, index) {
  // An explicit override wins — lets a flattened row (e.g. many sub-issues under
  // one ticket) supply a guaranteed-unique key instead of colliding on ticket_id.
  if (row._rowKey != null)            return row._rowKey;
  // Use the most-specific ID first so tickets sharing a vehicle never collide.
  if (row.ticket_id != null)          return `t-${row.ticket_id}`;
  if (row.log_id != null)             return `l-${row.log_id}`;
  if (row.history_id != null)         return `h-${row.history_id}`;
  if (row.schedule_id != null)        return `sc-${row.schedule_id}`;
  if (row.maintenance_id != null)     return `m-${row.maintenance_id}`;
  if (row.issue_report_id != null)    return `ir-${row.issue_report_id}`;
  if (row.condition_check_id != null) return `cc-${row.condition_check_id}`;
  if (row.location_record_id != null) return `loc-${row.location_record_id}`;
  // vehicle_id before category_id: vehicle rows carry both, and keying them by
  // their (shared) category_id collides whenever vehicles share a type.
  if (row.vehicle_id != null)         return `v-${row.vehicle_id}`;
  if (row.category_id != null)        return `cat-${row.category_id}`;
  if (row.id != null)                 return `id-${row.id}`;
  return index;
}

export function moduleLabel(modules, activeModule) {
  return modules.find(([key]) => key === activeModule)?.[1] ?? 'Workspace';
}


export function issueDescription(role) {
  if (role === 'Custodian') {
    return 'Submit vehicle problems and track issues you reported.';
  }

  if (role === 'Maintenance Personnel') {
    return 'Review reported vehicle issues and add technical remarks.';
  }

  return 'Manage reported vehicle problems and update review status.';
}

// =========================================================================
// WORK TRACKER — cross-phase outcome feed (Custodian + Maintenance)
// =========================================================================

// Reads the FK that may arrive either as an eager-loaded relation object or as
// the raw integer column (both serialize under the same snake_case key).
export function idOf(value) {
  return (value && typeof value === 'object') ? value.id : value;
}

// Order-insensitive comparison for the array-valued filter state used by
// FilterBar's multi-select dropdowns.
export const sameSelection = (a = [], b = []) => a.length === b.length && a.every((v) => b.includes(v));

// Naive but good-enough English pluralization for filter placeholders
// ("Priority" -> "Priorities", "Status" -> "Statuses", "Mechanic" -> "Mechanics").
export const pluralizeLabel = (label) => {
  if (label.endsWith('y')) return `${label.slice(0, -1)}ies`;
  if (label.endsWith('s')) return `${label}es`;
  return `${label}s`;
};

export function isoDateToDisplay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '';
  return `${m}/${d}/${y}`;
}

export function displayDateToIso(display) {
  const match = display.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, m, d, y] = match;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
