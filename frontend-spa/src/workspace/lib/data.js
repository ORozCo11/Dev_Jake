import api from '../../api/axios';
import { hasRole } from './permissions';

// NOTE: the flat [key, label] list that everything outside the sidebar render
// consumes (default landing module, breadcrumb lookup) is derived from these
// groups in the component via `moduleGroups.flatMap(g => g.items)` — grouping
// the sidebar therefore didn't change any of those call sites.

export const moduleEndpoints = {
  vehicles: '/vehicles',
  categories: '/categories',
  locations: '/locations',
  conditions: '/conditions',
  issues: '/issues',
  maintenance: '/maintenance-records',
  maintenanceStatus: '/maintenance-records',
  schedules: '/maintenance-schedules',
  histories: '/histories',
  logs: '/logs',
  tickets: '/tickets',
  ticketInspections: '/tickets',
  ticketVerifications: '/tickets',
  ticketWorkOrders: '/tickets',
  workTracker: '/tickets',
  ticketArchives: '/ticket-archives',
  users: '/users',
};

// Pure fetchers — they return data and touch no React state, so effects can
// apply the result only if they haven't been cleaned up in the meantime
// (prevents a slow response from overwriting a newer one, or landing after
// unmount).
export const fetchLookups = () => api.get('/lookups').then((response) => response.data);
export const fetchTicketLookups = () => api.get('/tickets/lookups').then((response) => response.data);
export const fetchNotifications = () => api.get('/notifications').then((response) => response.data);
export const fetchHubs = () => api.get('/hubs').then((response) => response.data
  .filter((hub) => !hub.is_hidden)
  .map((hub) => ({
    ...hub,
    matchNames: Array.isArray(hub.match_names) && hub.match_names.length
      ? hub.match_names
      : [hub.name.toLowerCase()],
  })));

// Resolves to a patch for applyModuleData(): `{ dashboard }` or
// `{ records: { [key]: rows, ... } }`, or null when the module has no data.
export async function fetchModuleData(key, user) {
  if (key === 'reports') return null;

  if (key === 'dashboard') {
    const response = await api.get('/dashboard');
    return { dashboard: response.data };
  }

  const endpoint = moduleEndpoints[key];
  if (!endpoint) return null;

  const params = {};

  // A Custodian sees every issue report in the barangay, same as Admin —
  // not just their own (VMS-IMPROVEMENT-PLAN.md Phase B3). Maintenance
  // Personnel gets none at all, enforced server-side regardless of params.

  if (key === 'maintenanceStatus') {
    params.for_verification = 1;
  }

  // Ticket workflow — role-scoped status filters
  // ticketInspections, ticketVerifications, and ticketWorkOrders intentionally
  // fetch every ticket assigned to this user (not just the pending-phase
  // status) so each module can show a "Pending" vs "Submitted" toggle instead
  // of only the pending queue — once submitted, a ticket moves to the next
  // phase and would otherwise vanish from view entirely.

  const response = await api.get(endpoint, { params });
  const records = { [key]: response.data };

  // Phase B4 — Maintenance Personnel's Condition Monitoring and standalone
  // Maintenance Schedule sidebar entries were removed (issue.edit dropped
  // them entirely, and Maintenance Personnel never gets schedule.create
  // either way); their assigned schedules instead surface as a second
  // section on My Work Orders. This
  // piggybacks a second fetch onto that same module load rather than
  // giving Maintenance Personnel back a 'schedules' sidebar entry — the
  // backend already scopes GET /maintenance-schedules to assigned_to = me
  // for a pure Maintenance Personnel account.
  if (key === 'ticketWorkOrders' && hasRole(user, 'Maintenance Personnel')) {
    try {
      const scheduleResponse = await api.get('/maintenance-schedules');
      records.mySchedules = scheduleResponse.data;
    } catch { /* optional secondary fetch — the work orders list still loaded fine */ }
  }

  return { records };
}

export const emptyLookups = {
  categories: [],
  vehicles: [],
  maintenance_personnel: [],
  maintenance_performers: [],
  issue_reports: [],
  issue_types: [],
  maintenance_types: [],
  severity_levels: [],
  vehicle_statuses: [],
  condition_results: [],
  issue_statuses: [],
  maintenance_statuses: [],
  schedule_statuses: [],
};

export const emptyTicketLookups = {
  vehicles: [],
  custodians: [],
  maintenance_personnel: [],
  priorities: [],
  maintenance_types: [],
  ticket_statuses: [],
  sub_issue_statuses: [],
};

export function moduleRequest(moduleKey, editTarget, payload) {
  const clean = cleanPayload(payload);

  if (moduleKey === 'vehicles') {
    return (editTarget && editTarget.vehicle_id)
      ? { method: 'put', path: `/vehicles/${editTarget.vehicle_id}`, success: 'Vehicle updated.' }
      : { method: 'post', path: '/vehicles', success: 'Vehicle added.' };
  }

  if (moduleKey === 'categories') {
    return (editTarget && editTarget.category_id)
      ? { method: 'put', path: `/categories/${editTarget.category_id}`, success: 'Vehicle type updated.' }
      : { method: 'post', path: '/categories', success: 'Vehicle type added.' };
  }

  if (moduleKey === 'users') {
    return (editTarget && editTarget.id)
      ? { method: 'put', path: `/users/${editTarget.id}`, success: 'User updated.' }
      : { method: 'post', path: '/users', success: 'User added.' };
  }

  if (moduleKey === 'conditions') {
    return (editTarget && editTarget.condition_check_id)
      ? { method: 'put', path: `/conditions/${editTarget.condition_check_id}`, success: 'Condition check updated.' }
      : { method: 'post', path: '/conditions', success: 'Condition check recorded.' };
  }

  if (moduleKey === 'issues') {
    return (editTarget && editTarget.issue_report_id)
      ? { method: 'put', path: `/issues/${editTarget.issue_report_id}`, success: 'Issue updated.' }
      : { method: 'post', path: '/issues', success: 'Issue report submitted.' };
  }

  if (moduleKey === 'maintenance') {
    return (editTarget && editTarget.maintenance_id)
      ? { method: 'put', path: `/maintenance-records/${editTarget.maintenance_id}`, success: 'Maintenance record updated.' }
      : { method: 'post', path: '/maintenance-records', success: 'Maintenance record added.' };
  }

  if (moduleKey === 'schedules') {
    return (editTarget && editTarget.schedule_id)
      ? { method: 'put', path: `/maintenance-schedules/${editTarget.schedule_id}`, success: 'Schedule updated.' }
      : { method: 'post', path: '/maintenance-schedules', success: 'Schedule added.' };
  }

  return { method: 'post', path: moduleEndpoints[moduleKey], payload: clean, success: 'Saved.' };
}

export async function sendPayload(method, path, payload) {
  // A 'multi-file' field's value is an array of File objects, not a single
  // File — checked here too so a payload whose ONLY file-shaped field is one
  // of these (e.g. new attachments with no single-file field alongside)
  // still switches this request into FormData/multipart mode.
  const hasFile = Object.values(payload).some((value) => (
    Array.isArray(value) ? value.some((item) => isFile(item) && item.size > 0) : isFile(value) && value.size > 0
  ));

  if (hasFile) {
    const formData = new FormData();
    Object.entries(payload).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        // Send arrays (e.g. multi-role `roles`) as roles[] so PHP parses a list.
        value.forEach((item) => formData.append(`${key}[]`, item));
      } else {
        formData.append(key, value);
      }
    });
    if (method !== 'post') {
      formData.append('_method', method.toUpperCase());
      return api.post(path, formData);
    }

    return api.post(path, formData);
  }

  return api[method](path, cleanPayload(payload));
}

export function cleanPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== '' && value !== undefined && !(isFile(value) && value.size === 0))
      .map(([key, value]) => [key, value === '' ? null : value]),
  );
}

export function isFile(value) {
  return typeof File !== 'undefined' && value instanceof File;
}

export function showError(error, setNotice) {
  const validation = error.response?.data?.errors;
  if (validation) {
    const lines = Object.values(validation).flat();
    setNotice({ type: 'error', text: lines.join(' '), lines });
    return;
  }

  const message = error.response?.data?.message ?? 'Something went wrong while saving.';
  const openTickets = error.response?.data?.open_tickets;
  setNotice(
    openTickets?.length
      ? { type: 'error', text: message, openTickets }
      : { type: 'error', text: message }
  );
}
