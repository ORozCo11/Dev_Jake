import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, createContext, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../api/axios';
import LocationDensityMap from '../components/LocationDensityMap';
import VehicleLocationMap from '../components/VehicleLocationMap';
import AddLocationMap from '../components/AddLocationMap';
import Icon from '../components/Icon';
import TextType from '../components/TextType';
import WorkspaceFooter from '../components/WorkspaceFooter';
import ConfirmDialog from '../components/ConfirmDialog';
import { DonutChart, HorizontalBarChart, ColumnChart } from '../components/charts';
import { AuthContext } from '../context/AuthContextObject';
import { groupLocationRowsByHub, PAKNAAN_POLYGON } from '../data/paknaanLocationDensity';
import { geoJsonToRings, isPointWithinBoundaryRings } from '../utils/boundary';
import { geocodeAddress, reverseGeocode } from '../utils/geocode';

const FormNoticeContext = createContext(null);
// Lets shared table cells (VehicleCell, UserAvatarName) open the right detail
// view for what was actually clicked — a vehicle cell opens the vehicle, a user
// cell opens that user — instead of the whole row always going to the vehicle.
const RowActionsContext = createContext(null);

// Every value the backend actually stamps onto a Notification.type (see
// notifyAdmins/notifyCustodians/notifyUser call sites in TicketController.php
// and FleetController.php) mapped to the bell dropdown's visual category.
// Driven off this reliable field instead of guessing from the title text.
const NOTIFICATION_STYLE_BY_TYPE = {
  // success — a positive/resolved outcome
  sub_issue_confirmed: 'success',
  repairs_approved: 'success',
  ticket_ready_to_close: 'success',
  ticket_closed: 'success',
  schedule_restored: 'success',

  // warning — a rejection, rework, deferral, or reopened/recurring problem
  repairs_rejected: 'warning',
  work_order_reopened: 'warning',
  sub_issue_deferred: 'warning',
  ticket_reopened: 'warning',
  repair_reopened_for_verification: 'warning',
  recurring_fault: 'warning',

  // info — a neutral assignment/submission with no verdict yet
  ticket_prediagnosed: 'info',
  inspection_assigned: 'info',
  inspection_submitted: 'info',
  work_order_assigned: 'info',
  work_order_reassigned: 'info',
  ticket_reassigned: 'info',
  repairs_completed: 'info',
  maintenance_recorded: 'info',
  maintenance_verification_withdrawn: 'info',
  schedule_assigned: 'info',
  maintenance_verification_needed: 'info',
};

// Backward-compat only: a notification row created before `type` existed (or
// with a type this map hasn't caught up to yet) has no reliable field to key
// off, so fall back to the old title-sniffing guess rather than mislabeling it.
function legacyNotificationStyleFromTitle(title) {
  if (/confirmed|approved|completed|verified|done/i.test(title)) return 'success';
  if (/reopened|deferred|rejected|sent back/i.test(title)) return 'warning';
  if (/required|assigned|logged|repairs completed/i.test(title)) return 'info';
  if (/failed|error/i.test(title)) return 'error';
  return 'info';
}

function getNotificationStyle(notification) {
  return NOTIFICATION_STYLE_BY_TYPE[notification.type] ?? legacyNotificationStyleFromTitle(notification.title);
}

const roleRoutes = {
  Admin: '/admin',
  Custodian: '/custodian',
  'Maintenance Personnel': '/maintenance',
  'Super Admin': '/superadmin',
};

// Sidebar structure, grouped into collapsible sections. `section: null` means
// the items render at the top with no header (Dashboard) — everything else
// sits under a labelled, collapsible group. The groupings themselves aren't
// new: they existed as comments here long before they were rendered.
const modulesByRole = {
  Admin: [
    { section: null, items: [['dashboard', 'Dashboard']] },
    { section: 'Fleet', icon: 'vehicle', items: [
      ['vehicles', 'Vehicles'],
      ['categories', 'Vehicle Types'],
      ['locations', 'Vehicle Location'],
    ] },
    { section: 'Maintenance', icon: 'clipboard', items: [
      ['tickets', 'Maintenance Tickets'],
      ['schedules', 'Maintenance Schedule'],
    ] },
    { section: 'Administration', icon: 'key', items: [
      ['users', 'Users'],
      ['reports', 'Reports'],
      ['logs', 'Activity Log'],
    ] },
  ],
  // The simple flow: a Custodian proposes a ticket (from a vehicle, a due
  // schedule or a check), then verifies the finished repair. Checks, history,
  // documents and usage all live on the vehicle itself.
  Custodian: [
    { section: null, items: [['dashboard', 'Dashboard']] },
    { section: null, items: [
      ['vehicles', 'Vehicles'],
      ['myTasks', 'My Work'],
    ] },
  ],
  'Maintenance Personnel': [
    { section: null, items: [['dashboard', 'Dashboard']] },
    { section: null, items: [
      ['ticketWorkOrders', 'My Work'],
      ['vehicles', 'Vehicles'],
    ] },
  ],
};
// Multi-role helpers. `role` is the primary (portal/routing); `roles` is
// every hat the account may wear. Permission checks use hasRole so a person
// holding several roles is allowed to act under any of them.
function hasRole(user, role) {
  if (!user) return false;
  const roles = user.roles;
  if (Array.isArray(roles) && roles.length) return roles.includes(role);
  return user.role === role; // fall back to primary role
}

// Ability-based permission check. The backend computes `user.abilities` from
// config/permissions.php (role -> abilities) and returns it on login/GET user.
// Prefer this over hasRole()/raw role checks for authorization decisions —
// role checks should be reserved for display-only logic (e.g. label copy).
function canDo(user, ability) {
  if (!user) return false;
  return Array.isArray(user.abilities) && user.abilities.includes(ability);
}

// Production-readiness audit finding #6 — mirrors User::canRegisterVehicles()
// on the backend. canDo(user, 'vehicle.create') alone can't express this: the
// ability only says Admin/Custodian are the eligible ROLES, not which
// specific Custodian accounts an Admin has actually delegated it to.
function canRegisterVehicles(user) {
  if (hasRole(user, 'Admin')) return true;
  return hasRole(user, 'Custodian') && !!user?.can_register_vehicles;
}

function userRoles(user) {
  if (!user) return [];
  const roles = (Array.isArray(user.roles) && user.roles.length) ? [...user.roles] : (user.role ? [user.role] : []);
  // Keep the primary role first so it drives the default landing module.
  if (user.role && roles.includes(user.role)) {
    return [user.role, ...roles.filter((r) => r !== user.role)];
  }
  return roles;
}

// The sidebar a user sees is the UNION of every module across all their
// roles — a Custodian + Maintenance person gets both portals' modules.
// Sections with the same label merge into one group rather than appearing
// twice. First occurrence of a module key wins, and userRoles() puts the
// primary role first, so a module defined by two roles keeps the label from
// the user's primary portal (e.g. "Report Vehicle Issue" vs "View Vehicle
// Issues" for a Custodian+Maintenance account).
function resolveModuleGroups(user) {
  const roles = userRoles(user);
  const source = roles.length ? roles : [user?.role].filter(Boolean);
  const seenKeys = new Set();
  const order = [];
  const bySection = new Map();
  const iconBySection = new Map();

  source.forEach((r) => (modulesByRole[r] ?? []).forEach(({ section, icon, items }) => {
    if (!bySection.has(section)) { bySection.set(section, []); order.push(section); }
    if (icon && !iconBySection.has(section)) iconBySection.set(section, icon);
    const bucket = bySection.get(section);
    items.forEach((item) => {
      if (seenKeys.has(item[0])) return;
      seenKeys.add(item[0]);
      bucket.push(item);
    });
  }));

  // A section can end up empty when every module in it was already claimed by
  // an earlier role's section — don't render a header with nothing under it.
  return order
    .map((section) => ({ section, icon: iconBySection.get(section), items: bySection.get(section) }))
    .filter((g) => g.items.length > 0);
}

// NOTE: the flat [key, label] list that everything outside the sidebar render
// consumes (default landing module, breadcrumb lookup) is derived from these
// groups in the component via `moduleGroups.flatMap(g => g.items)` — grouping
// the sidebar therefore didn't change any of those call sites.

const moduleEndpoints = {
  vehicles: '/vehicles',
  categories: '/categories',
  schedules: '/maintenance-schedules',
  logs: '/logs',
  tickets: '/tickets',
  ticketVerifications: '/tickets',
  ticketWorkOrders: '/tickets',
  workTracker: '/tickets',
  users: '/users',
};

const moduleIcons = {
  dashboard: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  vehicles: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
      <circle cx="7" cy="17" r="2" />
      <path d="M9 17h6" />
      <circle cx="17" cy="17" r="2" />
    </svg>
  ),
  categories: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h16M4 18h7" />
    </svg>
  ),
  locations: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
  conditions: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  issues: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  maintenance: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  maintenanceStatus: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  // Merged "Maintenance Status" + "Maintenance Records" — reuses the
  // ledger's own wrench icon, since that's the entry's primary identity.
  maintenanceLedger: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  schedules: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  tickets: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  ticketArchives: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  ),
  // Custodian's Issue Reports entry point — reuses the `issues`
  // warning-triangle glyph since it's the same list/module.
  reportOrPropose: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  // Merged Custodian "queues waiting on me" container (Task 1) — a simple
  // checklist glyph, distinct from the three it now groups (ticketInspections/
  // ticketVerifications/workTracker keep their own icons below, still used
  // for the page-heading icon whenever one of those keys is the active tab
  // but reached from OUTSIDE this container, e.g. Maintenance Personnel's
  // own separate Work Tracker entry).
  myTasks: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 3v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3" />
      <path d="m8 12.5 2 2 4-4.5" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  ),
  // Custodian's "propose a ticket" entry point — the same document shape as
  // `tickets`, with a plus instead of the two summary lines, so it reads as
  // "start a new one" rather than "view the list". Kept for the (now
  // unreachable in practice) fallback path in breadcrumbModule below.
  ticketPropose: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  ),
  ticketInspections: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <polyline points="11 8 11 11 13 13" />
    </svg>
  ),
  ticketVerifications: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  ticketWorkOrders: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  workTracker: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11H3v10h6V11z" />
      <path d="M15 3H9v18h6V3z" />
      <path d="M21 7h-6v14h6V7z" />
      <path d="m8 8 1.5 1.5L12 7" />
    </svg>
  ),
  histories: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8v4l3 3" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  ),
  reports: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  logs: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  ),
  users: (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
};

function Workspace() {
  const navigate = useNavigate();
  const location = useLocation();
  const vehicleUrlMatch = location.pathname.match(/\/vehicles\/(new|\d+)$/);
  const vehicleProfileId = vehicleUrlMatch && vehicleUrlMatch[1] !== 'new' ? vehicleUrlMatch[1] : null;
  const isNewVehiclePage = vehicleUrlMatch?.[1] === 'new';
  // Vehicle "edit" isn't its own path — VehicleProfilePage seeds its Edit
  // tab from ?tab=edit on the profile URL itself (see its `editing` state).
  const isVehicleEditPage = Boolean(vehicleProfileId) && new URLSearchParams(location.search).get('tab') === 'edit';
  const ticketUrlMatch = location.pathname.match(/\/tickets\/(new|\d+)$/);
  const ticketProfileId = ticketUrlMatch && ticketUrlMatch[1] !== 'new' ? ticketUrlMatch[1] : null;
  const isNewTicketPage = ticketUrlMatch?.[1] === 'new';
  const isNewCategoryPage = /\/categories\/new$/.test(location.pathname);
  const editCategoryId = location.pathname.match(/\/categories\/(\d+)\/edit$/)?.[1] ?? null;
  const isNewSchedulePage = /\/schedules\/new$/.test(location.pathname);
  const editScheduleId = location.pathname.match(/\/schedules\/(\d+)\/edit$/)?.[1] ?? null;
  const isNewIssuePage = /\/issues\/new$/.test(location.pathname);
  const editIssueId = location.pathname.match(/\/issues\/(\d+)\/edit$/)?.[1] ?? null;
  const viewIssueId = location.pathname.match(/\/issues\/(\d+)$/)?.[1] ?? null;
  const isNewConditionPage = /\/conditions\/new$/.test(location.pathname);
  const editConditionId = location.pathname.match(/\/conditions\/(\d+)\/edit$/)?.[1] ?? null;
  const isNewMaintenancePage = /\/maintenance\/new$/.test(location.pathname);
  const editMaintenanceId = location.pathname.match(/\/maintenance\/(\d+)\/edit$/)?.[1] ?? null;
  const maintenanceProfileId = location.pathname.match(/\/maintenance\/(\d+)$/)?.[1] ?? null;
  const isNewUserPage = /\/users\/new$/.test(location.pathname);
  const editUserId = location.pathname.match(/\/users\/(\d+)\/edit$/)?.[1] ?? null;
  const viewUserId = location.pathname.match(/\/users\/(\d+)$/)?.[1] ?? null;
  const isNewLocationPage = /\/locations\/new$/.test(location.pathname);
  const editLocationVehicleId = location.pathname.match(/\/locations\/(\d+)\/edit$/)?.[1] ?? null;
  const logRepairsMatch = location.pathname.match(/\/work-orders\/(\d+)\/(\d+)\/log-repairs$/);
  const logRepairsTicketId = logRepairsMatch?.[1] ?? null;
  const logRepairsSubIssueId = logRepairsMatch?.[2] ?? null;
  const inspectTicketId = location.pathname.match(/\/inspections\/(\d+)\/inspect$/)?.[1] ?? null;
  const isProfilePage = /\/profile$/.test(location.pathname);
  const isOnSpecialPage = Boolean(
    isNewVehiclePage || vehicleProfileId || isNewTicketPage || ticketProfileId
    || isNewCategoryPage || editCategoryId || isNewSchedulePage || editScheduleId
    || isNewIssuePage || editIssueId || viewIssueId || isNewConditionPage || editConditionId
    || isNewMaintenancePage || editMaintenanceId || maintenanceProfileId || isNewUserPage || editUserId || viewUserId
    || logRepairsTicketId || inspectTicketId || isProfilePage || isNewLocationPage || editLocationVehicleId
  );
  // The bold page title for whichever create/edit/view sub-page is active —
  // null when just looking at a module's own list, in which case the heading
  // falls back to plain "{Module Name}" with no breadcrumb line above it.
  const subPageTitle =
    (isNewVehiclePage && 'Add Vehicle')
    || (vehicleProfileId && 'Vehicle Profile')
    || (isNewTicketPage && 'Create New Ticket')
    || (ticketProfileId && 'Ticket Details')
    || (isNewCategoryPage && 'Add Vehicle Type')
    || (editCategoryId && 'Edit Vehicle Type')
    || (isNewSchedulePage && 'Add Maintenance Schedule')
    || (editScheduleId && 'Update Schedule')
    || (isNewIssuePage && 'Report Vehicle Issue')
    || (editIssueId && 'Update Issue Status')
    || (viewIssueId && 'Issue Details')
    || (isNewConditionPage && 'Add Condition Check')
    || (editConditionId && 'Edit Condition Check')
    || (isNewMaintenancePage && 'Add Maintenance Record')
    || (editMaintenanceId && 'Update Maintenance Record')
    || (maintenanceProfileId && 'Maintenance Record')
    || (isNewUserPage && 'Add User')
    || (editUserId && 'Update User')
    || (viewUserId && 'User Profile')
    || (logRepairsTicketId && 'Log Repairs')
    || (inspectTicketId && 'Inspect Vehicle')
    || (isProfilePage && 'My Profile')
    || (isNewLocationPage && 'Add Location')
    || (editLocationVehicleId && 'Update Location')
    || null;
  const { user, logout, refreshUser } = useContext(AuthContext);
  // Phase B2 — UX-only redirect for every full-page create/edit route: the
  // backend independently (and exhaustively) enforces each of these
  // abilities on the actual endpoint, so this just keeps someone without the
  // ability from sitting on a form that can only ever 403 on submit, instead
  // of silently rendering it. Mirrors ProtectedRoute's own /unauthorized
  // bounce rather than inventing a second pattern.
  useEffect(() => {
    const deniedNewOrEdit = (
      (isNewVehiclePage && !canRegisterVehicles(user))
      || (isVehicleEditPage && !canDo(user, 'vehicle.edit'))
      || (isNewCategoryPage && !canDo(user, 'vehicle_type.create'))
      || (editCategoryId && !canDo(user, 'vehicle_type.edit'))
      || (isNewSchedulePage && !canDo(user, 'schedule.create'))
      || (editScheduleId && !canDo(user, 'schedule.edit'))
      || (isNewIssuePage && !canDo(user, 'issue.create'))
      || (editIssueId && !canDo(user, 'issue.edit'))
      || (isNewConditionPage && !canDo(user, 'condition.create'))
      || (editConditionId && !canDo(user, 'condition.edit'))
      || (isNewMaintenancePage && !canDo(user, 'record.create'))
      || (editMaintenanceId && !canDo(user, 'record.edit'))
      || (isNewUserPage && !canDo(user, 'user.create'))
      || (editUserId && !canDo(user, 'user.edit'))
      || (isNewLocationPage && !canDo(user, 'vehicle.update_location'))
      || (editLocationVehicleId && !canDo(user, 'vehicle.update_location'))
    );
    if (deniedNewOrEdit) navigate('/unauthorized', { replace: true });
  }, [
    navigate, user,
    isNewVehiclePage, isVehicleEditPage, isNewCategoryPage, editCategoryId,
    isNewSchedulePage, editScheduleId, isNewIssuePage, editIssueId,
    isNewConditionPage, editConditionId, isNewMaintenancePage, editMaintenanceId,
    isNewUserPage, editUserId, isNewLocationPage, editLocationVehicleId,
  ]);
  const moduleGroups = useMemo(() => resolveModuleGroups(user), [user.role, user.roles]);
  const modules = useMemo(() => moduleGroups.flatMap((g) => g.items), [moduleGroups]);
  // A fresh mount (hard refresh, a bookmarked/shared link, opening a new tab)
  // always used to default this to the first sidebar module — losing which
  // ticket/record the URL actually pointed at, since these special sub-pages
  // read their record out of `records[activeModule]`, which is only fetched
  // once loadModule(activeModule) runs. Seeding activeModule from the URL
  // itself (instead of always modules[0]) means that fetch fires for the
  // right module on the very first render, so the page renders instead of
  // sitting blank until the user happens to click the matching sidebar item.
  const [activeModule, setActiveModule] = useState(() => {
    if (ticketProfileId || isNewTicketPage) return user.role === 'Admin' ? 'tickets' : 'workTracker';
    if (maintenanceProfileId || isNewMaintenancePage || editMaintenanceId) return 'maintenance';
    if (isNewVehiclePage || vehicleProfileId) return 'vehicles';
    if (isNewCategoryPage || editCategoryId) return 'categories';
    if (isNewSchedulePage || editScheduleId) return 'schedules';
    if (isNewIssuePage || editIssueId || viewIssueId) return 'issues';
    if (isNewConditionPage || editConditionId) return 'conditions';
    if (isNewUserPage || editUserId || viewUserId) return 'users';
    if (isNewLocationPage || editLocationVehicleId) return 'locations';
    if (logRepairsTicketId) return 'ticketWorkOrders';
    if (inspectTicketId) return 'ticketInspections';
    return modules[0]?.[0] ?? 'dashboard';
  });
  // Custodian's merged "My Tasks" sidebar entry (Task 1 of the sidebar
  // consolidation) is a thin navigation wrapper, not a real module —
  // `activeModule` still ends up literally 'ticketInspections' /
  // 'ticketVerifications' / 'workTracker' exactly as before (so every
  // existing fetch/filter/stat/render keyed off those strings keeps working
  // completely unchanged), this just remembers which of the three tabs was
  // last open so re-clicking the "My Tasks" sidebar row returns you to it.
  const [myTasksLastTab, setMyTasksLastTab] = useState('ticketVerifications');
  // 'workTracker' is the one key shared between Custodian's My Tasks
  // ("History" tab) and Maintenance Personnel's own separate, untouched
  // "Work Tracker" sidebar entry — this disambiguates which context set it,
  // since both simply set activeModule to the same string. Defaults true
  // (Custodian is the only role this whole file's new My Tasks flow
  // targets); Maintenance Personnel's own Work Tracker click flips it false.
  const [workTrackerViaMyTasks, setWorkTrackerViaMyTasks] = useState(true);
  // Jumps into (or switches tabs within) the merged My Tasks container —
  // used by both the sidebar's "My Tasks" row and the in-page tab bar.
  const setMyTasksTab = useCallback((key) => {
    setMyTasksLastTab(key);
    setWorkTrackerViaMyTasks(true);
    setActiveModule(key);
  }, []);
  // Same thin-wrapper pattern as My Tasks above, merging Custodian's
  // "Maintenance Status" (records awaiting their verification) and
  // "Maintenance Records" (the full ledger) — same underlying data
  // (GET /maintenance-records), just a different filter, so this is a pure
  // navigation/presentation merge with zero change to either module.
  const [maintenanceLedgerLastTab, setMaintenanceLedgerLastTab] = useState('maintenanceStatus');
  const setMaintenanceLedgerTab = useCallback((key) => {
    setMaintenanceLedgerLastTab(key);
    setActiveModule(key);
  }, []);
  // Which sidebar sections the user has folded away, remembered per browser.
  // Stored as the collapsed set. Unlike a brand-new section defaulting open,
  // a first-ever visit (nothing in localStorage yet) starts every section
  // collapsed — an accordion, matching the reference nav's closed-by-default
  // look — rather than the old always-expanded list. Whichever group holds
  // the current module still force-expands below regardless of this set.
  const [collapsedNavGroups, setCollapsedNavGroups] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('vms_nav_collapsed_groups') ?? 'null');
      if (Array.isArray(raw)) return raw;
    } catch { /* fall through to default: everything collapsed */ }
    return moduleGroups.map((g) => g.section).filter(Boolean);
  });
  const toggleNavGroup = (section) => {
    setCollapsedNavGroups((current) => {
      const next = current.includes(section) ? current.filter((s) => s !== section) : [...current, section];
      localStorage.setItem('vms_nav_collapsed_groups', JSON.stringify(next));
      return next;
    });
  };
  // Any special page can be reached from places that never touch
  // setActiveModule — a notification click, a shared link opened in a new
  // tab, a direct URL/refresh — so `activeModule` itself can't be trusted
  // for the heading icon/breadcrumb or the sidebar's own highlight while on
  // one of these. Computed directly (not synced via an effect) so it's
  // never wrong even for a single frame. Falls back to `activeModule` only
  // for the plain module-list pages, where that state is authoritative.
  // Whether these two merged Custodian entries actually exist in THIS user's
  // sidebar — true for a Custodian, false for Admin/Maintenance Personnel
  // (who keep their own separate, unmerged 'issues'/'ticketInspections'/
  // 'ticketVerifications'/'workTracker' entries untouched). Drives every
  // "should this special page/tab highlight the merged entry instead of the
  // real key" decision below.
  const hasMyTasksNav = modules.some(([k]) => k === 'myTasks');
  const hasReportOrProposeNav = modules.some(([k]) => k === 'reportOrPropose');
  const hasMaintenanceLedgerNav = modules.some(([k]) => k === 'maintenanceLedger');
  const breadcrumbModule = ticketProfileId || isNewTicketPage
    ? (user.role === 'Admin'
      ? 'tickets'
      // The propose form is a brand-new entry point (never reachable before
      // this), so — unlike the ticketProfileId case just below it, which
      // keeps its long-established 'workTracker' fallback — this can safely
      // highlight its own sidebar item instead (now the merged
      // 'reportOrPropose' chooser entry, replacing the old direct-link
      // 'ticketPropose' row it used to point at).
      : (isNewTicketPage && canDo(user, 'ticket.propose')
        ? (hasReportOrProposeNav ? 'reportOrPropose' : 'ticketPropose')
        : (hasMyTasksNav ? 'myTasks' : (modules.some(([k]) => k === 'ticketWorkOrders') ? 'ticketWorkOrders' : 'workTracker'))))
    : maintenanceProfileId || isNewMaintenancePage || editMaintenanceId ? (hasMaintenanceLedgerNav ? 'maintenanceLedger' : 'maintenance')
    : isNewVehiclePage || vehicleProfileId ? 'vehicles'
    : isNewCategoryPage || editCategoryId ? 'categories'
    : isNewSchedulePage || editScheduleId ? 'schedules'
    : isNewIssuePage || editIssueId || viewIssueId ? (hasReportOrProposeNav ? 'reportOrPropose' : 'issues')
    : isNewConditionPage || editConditionId ? 'conditions'
    : isNewUserPage || editUserId || viewUserId ? 'users'
    : isNewLocationPage || editLocationVehicleId ? 'locations'
    : logRepairsTicketId ? 'ticketWorkOrders'
    : inspectTicketId ? (hasMyTasksNav ? 'myTasks' : 'ticketInspections')
    // Plain module-list view (no special sub-page open) for one of the three
    // merged "My Tasks" queues — 'ticketInspections'/'ticketVerifications'
    // are Custodian-only regardless, 'workTracker' also covers Maintenance
    // Personnel's own separate entry, disambiguated by workTrackerViaMyTasks.
    : (hasMyTasksNav && (
        activeModule === 'ticketInspections'
        || activeModule === 'ticketVerifications'
        || (activeModule === 'workTracker' && workTrackerViaMyTasks)
      )) ? 'myTasks'
    : (hasReportOrProposeNav && activeModule === 'issues') ? 'reportOrPropose'
    : (hasMaintenanceLedgerNav && (activeModule === 'maintenanceStatus' || activeModule === 'maintenance')) ? 'maintenanceLedger'
    : activeModule;
  // Always starts expanded — a collapsed sidebar should only ever be a
  // deliberate, in-session choice (the toggle button), never the default a
  // returning user lands on.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [lookups, setLookups] = useState(emptyLookups);
  const [ticketLookups, setTicketLookups] = useState(emptyTicketLookups);
  const [records, setRecords] = useState({});
  const [prefilledScheduleData, setPrefilledScheduleData] = useState(null);
  // Memoized so the object reference stays stable across unrelated re-renders
  // — SmartForm resets its values whenever this reference changes, which
  // would otherwise wipe out whatever the user has already typed.
  const scheduleInitialValues = useMemo(() => (
    editScheduleId
      ? (records.schedules ?? []).find((s) => String(s.schedule_id) === String(editScheduleId))
      // Default to tomorrow — a schedule is always plotted ahead, so this
      // saves a click for the common case; still fully editable.
      : { scheduled_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), ...(prefilledScheduleData ?? {}) }
  ), [editScheduleId, records.schedules, prefilledScheduleData]);
  // Legacy rows may have no `roles` list yet — seed it from the primary role.
  // Memoized (not an inline IIFE) for the same reason as scheduleInitialValues
  // above — otherwise this object gets a new reference on every render and
  // SmartForm keeps resetting the form back over whatever was just typed.
  const editUserInitialValues = useMemo(() => {
    if (!editUserId) return EMPTY_OBJ;
    let u = (records.users ?? []).find((x) => String(x.id) === String(editUserId));
    if (!u) return u;
    if ((!Array.isArray(u.roles) || !u.roles.length) && u.role) u = { ...u, roles: [u.role] };
    // The field renders as a single-item checkboxes group (see userFields());
    // that type always stores/reads an array, converted back to a plain
    // boolean on submit (see submitFormPage's 'users' branch).
    return { ...u, can_register_vehicles: u.can_register_vehicles ? ['Allow vehicle registration'] : [] };
  }, [records.users, editUserId]);
  const [dashboard, setDashboard] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [completeScheduleTarget, setCompleteScheduleTarget] = useState(null);
  // Admin's "Reassign" action on a Scheduled row (schedule.reassign ability,
  // Admin-only) — hands a still-open schedule to a different Maintenance
  // Personnel without cancelling and re-booking it.
  const [reassignScheduleTarget, setReassignScheduleTarget] = useState(null);
  // After a Custodian passes a verification they're already standing at the
  // vehicle — offer the Readiness Check right then instead of making them
  // come back for a second visit. Holds the vehicle to check, or null.
  const [readinessPromptTarget, setReadinessPromptTarget] = useState(null);
  const [scheduleViewMode, setScheduleViewMode] = useState(
    () => localStorage.getItem('vms_schedule_view') || 'table'
  );
  const changeScheduleViewMode = (mode) => {
    setScheduleViewMode(mode);
    localStorage.setItem('vms_schedule_view', mode);
  };
  // List/Recent-Activities tab for the Activity Log — not persisted, since
  // "recent activities" is a quick-glance view you'd want defaulting back
  // to the full list on your next visit rather than staying sticky.
  const [logsView, setLogsView] = useState('list');
  const [usersViewMode, setUsersViewMode] = useState('list');
  // Drives the conditional External Shop / Vendor / Receipt fields in the
  // Mark Done form below — reset wherever the modal is opened (see
  // openCompleteSchedule) rather than in an effect.
  const [completeScheduleExternal, setCompleteScheduleExternal] = useState(false);
  const openCompleteSchedule = (row) => {
    setCompleteScheduleExternal(false);
    setCompleteScheduleTarget(row);
  };
  const [report, setReport] = useState(null);
  const [notice, setNotice] = useState(null);
  const [vehicleImportOpen, setVehicleImportOpen] = useState(false);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.lines ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [loading, setLoading] = useState(false);
  const [userInfoTarget, setUserInfoTarget] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Tracks whether the form on whatever special page is currently open has
  // been touched — set true the moment a field changes, cleared on submit,
  // on an explicit Cancel, or after the user confirms discarding it. Lets
  // the sidebar (and anything else that can navigate away) warn before an
  // accidental click wipes out something like a half-filled Log Repairs or
  // Inspect Vehicle form.
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // Runs `action` only after confirming with the user if a form is dirty —
  // used anywhere navigation could otherwise silently discard unsaved input.
  // Reuses the same styled ConfirmDialog every other consequential action in
  // this app goes through, instead of the browser's own native confirm().
  const guardedNavigate = useCallback((action) => {
    if (!hasUnsavedChanges) {
      action();
      return;
    }
    setConfirmDialog({
      title: 'Unsaved Changes',
      message: 'You have unsaved changes on this page. Discard them and leave?',
      confirmLabel: 'Discard & Leave',
      onConfirm: () => {
        setHasUnsavedChanges(false);
        action();
      },
    });
  }, [hasUnsavedChanges]);
  // Any route change means whatever page we're now on starts clean — this
  // is what actually clears the flag after a successful save (submitting
  // navigates away on its own, outside guardedNavigate), and also covers
  // navigating directly from one edit form straight into another.
  useEffect(() => {
    setHasUnsavedChanges(false);
  }, [location.pathname]);
  // First-time approval only — a pending self-registration's role is a
  // request, not yet real, so Admin reviews/confirms it here instead of
  // the plain yes/no ConfirmDialog every other activate/deactivate uses.
  const [approvalTarget, setApprovalTarget] = useState(null);
  // The Staff Registration Code the barangay office hands to real staff —
  // Admin-only, fetched once so it's ready whenever they open Users.
  const [registrationCode, setRegistrationCode] = useState(null);
  useEffect(() => {
    if (!hasRole(user, 'Admin')) return;
    api.get('/registration-settings').then((res) => setRegistrationCode(res.data.staff_code)).catch(() => {});
  }, [user]);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState([]);
  const [filterCapacity, setFilterCapacity] = useState([]);
  const [filterStatus, setFilterStatus] = useState([]);
  const [filterPriority, setFilterPriority] = useState([]);
  // Location/Domain filters — Vehicle Management only (FilterBar shows
  // these whenever it's given the setters, so only this module's own call
  // site passing them determines whether they render).
  const [filterLocation, setFilterLocation] = useState([]);
  const [filterDomain, setFilterDomain] = useState([]);
  // Module-specific extra filter dimensions — each only read/written by its
  // own activeModule branch below, but declared centrally alongside the
  // rest so the module-switch reset effect can clear them all in one place.
  const [filterReadiness, setFilterReadiness] = useState([]); // vehicles: Ready to Respond
  const [filterIssueType, setFilterIssueType] = useState([]); // issues
  const [filterNoTicket, setFilterNoTicket] = useState(false); // issues: still needs a ticket
  const [filterMaintType, setFilterMaintType] = useState([]); // maintenance
  const [filterSource, setFilterSource] = useState([]); // maintenance
  const [filterActive, setFilterActive] = useState([]); // users
  const [filterAssignedTo, setFilterAssignedTo] = useState([]); // schedules
  const [filterVerdict, setFilterVerdict] = useState([]); // ticketVerifications
  const [filterCheckedBy, setFilterCheckedBy] = useState([]); // conditions
  const [filterActivityType, setFilterActivityType] = useState([]); // histories
  const [filterVehicle, setFilterVehicle] = useState([]); // tickets
  const [filterMechanic, setFilterMechanic] = useState([]); // tickets — any sub-issue assigned to
  const [filterCustodian, setFilterCustodian] = useState([]); // tickets
  const [filterDateStart, setFilterDateStart] = useState(''); // issues/maintenance/tickets/histories
  const [filterDateEnd, setFilterDateEnd] = useState('');

  const [archiveStart, setArchiveStart] = useState('');
  const [archiveEnd, setArchiveEnd] = useState('');
  const [archiveStatusFilter, setArchiveStatusFilter] = useState('');

  // Condition Monitoring Filters
  const [condFilterStartDate, setCondFilterStartDate] = useState('');
  const [condFilterEndDate, setCondFilterEndDate] = useState('');
  const [prefilledTicketData, setPrefilledTicketData] = useState(null);
  // A form page that finishes by switching module wants its success notice to
  // survive the module-change reset below.
  const keepNoticeRef = useRef(false);
  // Pre-filled proposal data (from a flagged issue / condition check) only
  // lives while the ticket form is open — leaving it by ANY route (sidebar,
  // back button, submit) drops it so the next form never re-links stale data.
  useEffect(() => {
    if (!isNewTicketPage) setPrefilledTicketData(null);
  }, [isNewTicketPage]);
  const [allHubs, setAllHubs] = useState([]);
  const [locationsTab] = useState('map');
  const [selectedMapVehicleId, setSelectedMapVehicleId] = useState(null);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'light'; } catch { return 'light'; }
  });
  const notificationsRef = useRef(null);
  const profileMenuRef = useRef(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const loadNotifications = useCallback(async () => {
    try {
      const response = await api.get('/notifications');
      setNotifications(response.data);
    } catch (error) {
      console.error('Failed to load notifications:', error);
    }
  }, []);

  const markNotificationAsRead = async (id) => {
    try {
      await api.put(`/notifications/${id}/read`);
      await loadNotifications();
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  };

  const markAllNotificationsAsRead = async () => {
    try {
      await api.put('/notifications/read-all');
      await loadNotifications();
    } catch (error) {
      console.error('Failed to mark all as read:', error);
    }
  };

  const deleteNotification = async (id) => {
    try {
      await api.delete(`/notifications/${id}`);
      await loadNotifications();
    } catch (error) {
      console.error('Failed to delete notification:', error);
    }
  };

  const loadLookups = useCallback(async () => {
    const response = await api.get('/lookups');
    setLookups(response.data);
  }, []);

  const loadHubs = useCallback(async () => {
    const response = await api.get('/hubs');
    setAllHubs(
      response.data
        .filter((hub) => !hub.is_hidden)
        .map((hub) => ({
          ...hub,
          matchNames: Array.isArray(hub.match_names) && hub.match_names.length
            ? hub.match_names
            : [hub.name.toLowerCase()],
        }))
    );
  }, []);

  const loadTicketLookups = useCallback(async () => {
    const response = await api.get('/tickets/lookups');
    setTicketLookups(response.data);
  }, []);

  const loadModule = useCallback(async (key) => {
    if (key === 'reports') {
      return;
    }

    if (key === 'dashboard') {
      const response = await api.get('/dashboard');
      setDashboard(response.data);
      return;
    }

    const endpoint = moduleEndpoints[key];

    if (!endpoint) {
      return;
    }

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
    setRecords((current) => ({ ...current, [key]: response.data }));

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
        setRecords((current) => ({ ...current, mySchedules: scheduleResponse.data }));
      } catch { /* optional secondary fetch — the work orders list still loaded fine */ }
    }
  }, [user]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    loadLookups().catch((error) => showError(error, setNotice));
    loadTicketLookups().catch(() => {});
    loadHubs().catch(() => {});
  }, [loadLookups, loadTicketLookups, loadHubs]);

  useEffect(() => {
    loadNotifications().catch(() => {});
    const interval = setInterval(() => {
      loadNotifications().catch(() => {});
    }, 10000); // Poll every 10 seconds
    return () => clearInterval(interval);
  }, [loadNotifications]);

  // Sidebar badge counts (dashboard.badge_counts) are visible on every module,
  // but were only ever fetched by loadModule('dashboard') — which only runs
  // when the Dashboard module itself is the active one. Anyone who lands on
  // (or navigates to) a different module first saw stale/zeroed badges until
  // they happened to visit Dashboard. Poll them independently so they reflect
  // live counts no matter what module is currently open.
  useEffect(() => {
    loadModule('dashboard').catch(() => {});
    const interval = setInterval(() => {
      loadModule('dashboard').catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, [loadModule]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target)) {
        setShowNotifications(false);
      }
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target)) {
        setShowProfileMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setActiveModule(modules[0]?.[0] ?? 'dashboard');
  }, [modules]);

  useEffect(() => {
     setEditTarget(null);
     setReport(null);
     if (keepNoticeRef.current) keepNoticeRef.current = false; else setNotice(null);
     setSearchQuery('');
     setFilterCategory([]);
     setFilterCapacity([]);
     setFilterStatus([]);
     setFilterPriority([]);
     setFilterLocation([]);
     setFilterDomain([]);
     setFilterReadiness([]);
     setFilterIssueType([]);
     setFilterNoTicket(false);
     setFilterMaintType([]);
     setFilterSource([]);
     setFilterActive([]);
     setFilterAssignedTo([]);
     setFilterVerdict([]);
     setFilterCheckedBy([]);
     setFilterActivityType([]);
     setFilterVehicle([]);
     setFilterMechanic([]);
     setFilterCustodian([]);
     setFilterDateStart('');
     setFilterDateEnd('');
     setCondFilterStartDate('');
     setCondFilterEndDate('');
     setArchiveStart('');
     setArchiveEnd('');
     setArchiveStatusFilter('');
     setLoading(true);
     loadModule(activeModule)
       .catch((error) => showError(error, setNotice))
       .finally(() => setLoading(false));
   }, [activeModule, loadModule]);

  const refreshCurrent = async () => {
    await Promise.all([
      loadLookups(),
      loadTicketLookups(),
      loadHubs(),
      loadModule(activeModule),
      loadModule('dashboard'),
      loadNotifications(),
    ]);
  };

  const submitModuleForm = async (payload) => {
    setNotice(null);

    try {
      if (activeModule === 'reports') {
        const response = await api.get('/reports', { params: cleanPayload(payload) });
        setReport(response.data);
        setNotice({ type: 'success', text: `${payload.report_type} generated.` });
        return;
      }

      const request = moduleRequest(activeModule, editTarget, payload);
      await sendPayload(request.method, request.path, payload);
      setEditTarget(null);
      setNotice({ type: 'success', text: request.success });
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // ── Ticket workflow action dispatchers ──────────────────────────────

  const ticketAction = async (path, payload, successMsg, method = 'put') => {
    setNotice(null);
    try {
      const response = await sendPayload(method, path, payload);
      setEditTarget(null);
      // assign-mechanic/reassign-custodian can succeed while also flagging a
      // self-verification conflict they just created (e.g. the mechanic
      // being assigned is also this ticket's Custodian) — see
      // TicketController's `warning` responses (VMS-IMPROVEMENT-PLAN.md
      // Phase A2). Not an error: the action went through, but it's worth a
      // distinct amber notice instead of blending into an ordinary success.
      const warning = response?.data?.warning;
      setNotice(warning
        ? { type: 'warning', text: `${successMsg} ⚠ ${warning}` }
        : { type: 'success', text: successMsg });
      await refreshCurrent();
      return true;
    } catch (error) {
      showError(error, setNotice);
      return false;
    }
  };

  // Custodian's "propose a ticket" path — a separate endpoint from Admin's
  // createTicket() above (POST /tickets/propose instead of POST /tickets):
  // the backend self-assigns the proposing Custodian and parks it at
  // 'Pending Approval' instead of dispatching an inspection immediately.
  const proposeTicket = async (payload) => {
    setNotice(null);
    try {
      await api.post('/tickets/propose', cleanPayload(payload));
      setNotice({ type: 'success', text: 'Ticket proposal submitted — an Admin will review it.' });
      await refreshCurrent();
      return true;
    } catch (error) {
      showError(error, setNotice);
      return false;
    }
  };

  // Readiness check submitted from the post-verification prompt. Separate from
  // the Maintenance Record entirely — two different questions ("was this
  // repair done?" vs "can this vehicle respond right now?") kept as two
  // honest records, just collected in one visit.
  const submitReadinessFromPrompt = async (vehicleId, payload) => {
    setNotice(null);
    try {
      await api.post(`/vehicles/${vehicleId}/readiness-check`, payload);
      setNotice({ type: 'success', text: 'Readiness check recorded.' });
      setReadinessPromptTarget(null);
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const deleteRecord = async (path, success, confirmMessage) => {
    setConfirmDialog({
      title: 'Confirm Action',
      message: confirmMessage ?? 'Continue with this action?',
      confirmLabel: 'Continue',
      variant: 'danger',
      onConfirm: async () => {
        try {
          await api.delete(path);
          setNotice({ type: 'success', text: success });
          await refreshCurrent();
        } catch (error) {
          showError(error, setNotice);
        }
      },
    });
  };

  const toggleUserActive = (row, activate) => {
    // First-time approval (never approved before) — review the requested
    // role instead of blindly activating. Re-activating an already-once-
    // approved account, or deactivating, stays the plain confirm dialog.
    if (activate && !row.approved_at) {
      setApprovalTarget(row);
      return;
    }
    setConfirmDialog({
      title: 'Confirm Action',
      message: activate
        ? `Reactivate ${row.name}'s account? They will be able to log in again.`
        : `Deactivate ${row.name}'s account? They won't be able to log in until reactivated.`,
      confirmLabel: activate ? 'Activate' : 'Deactivate',
      variant: activate ? 'primary' : 'danger',
      onConfirm: async () => {
        try {
          await api.put(`/users/${row.id}/${activate ? 'activate' : 'deactivate'}`);
          setNotice({ type: 'success', text: activate ? 'User activated.' : 'User deactivated.' });
          await refreshCurrent();
        } catch (error) {
          showError(error, setNotice);
        }
      },
    });
  };

  const regenerateRegistrationCode = () => {
    setConfirmDialog({
      title: 'Regenerate Staff Registration Code',
      message: 'This immediately invalidates the current code — anyone who still has the old one won\'t be able to register until you share the new one.',
      confirmLabel: 'Regenerate',
      variant: 'danger',
      onConfirm: async () => {
        try {
          const res = await api.post('/registration-settings/regenerate');
          setRegistrationCode(res.data.staff_code);
          setNotice({ type: 'success', text: 'Staff registration code regenerated.' });
        } catch (error) {
          showError(error, setNotice);
        }
      },
    });
  };

  // `message` defaults to the vehicle wording this was originally written for,
  // so existing callers are unchanged, but a schedule restore can say what it
  // actually does instead of claiming to restore a vehicle.
  const restoreRecord = async (path, success, message = 'Restore this vehicle to active service?') => {
    setConfirmDialog({
      title: 'Confirm Action',
      message,
      confirmLabel: 'Restore',
      variant: 'primary',
      onConfirm: async () => {
        try {
          await api.post(path);
          setNotice({ type: 'success', text: success });
          await refreshCurrent();
        } catch (error) {
          showError(error, setNotice);
        }
      },
    });
  };

  const handleConfirmDialog = async () => {
    if (!confirmDialog?.onConfirm || confirmBusy) {
      return;
    }

    setConfirmBusy(true);
    try {
      await confirmDialog.onConfirm();
      setConfirmDialog(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const openVehicleProfile = useCallback((vehicle, tab) => {
    if (vehicle?.vehicle_id) {
      const query = tab ? `?tab=${tab}` : '';
      navigate(`${roleRoutes[user.role]}/vehicles/${vehicle.vehicle_id}${query}`);
    }
  }, [navigate, user.role]);

  // Clears a ticket's "unread updates" badge (Maintenance Tickets card/table
  // view) the moment it's opened directly from that list — without this,
  // the badge only ever clears via the notification bell, so opening the
  // ticket itself wouldn't acknowledge the updates you just saw on it.
  // Best-effort: a failed mark-as-read just leaves the badge until the next
  // notifications poll picks it up, not worth surfacing as an error.
  const markTicketNotificationsRead = useCallback(async (ticketId) => {
    const toMark = notifications.filter((n) => !n.read_at && String(n.ticket_id) === String(ticketId));
    if (!toMark.length) return;
    try {
      await Promise.all(toMark.map((n) => api.put(`/notifications/${n.notification_id}/read`)));
      await loadNotifications();
    } catch { /* best-effort */ }
  }, [notifications, loadNotifications]);

  // Per-cell click targets shared with tables via context. A user cell opens
  // that user's own profile page (carrying the row's user object as fallback so
  // it renders even for roles that can't list all users).
  const openTicketProfile = useCallback((ticket) => {
    if (ticket?.ticket_id) {
      navigate(`${roleRoutes[user.role]}/tickets/${ticket.ticket_id}`);
      markTicketNotificationsRead(ticket.ticket_id);
    }
  }, [navigate, user.role, markTicketNotificationsRead]);

  const rowActions = useMemo(
    () => ({
      viewVehicle: openVehicleProfile,
      viewTicket: openTicketProfile,
      viewUser: (u) => {
        if (u?.id) navigate(`${roleRoutes[user.role]}/users/${u.id}`, { state: { user: u } });
      },
    }),
    [openVehicleProfile, openTicketProfile, navigate, user.role]
  );

  // Regular sidebar modules never get their own URL — switching between them
  // only flips `activeModule` in local state, so browser history never has a
  // real entry for e.g. "/vehicles". That makes navigate(-1) unreliable after
  // an Add/Edit page: it pops back to whatever real URL happened to precede
  // it (usually just the bare dashboard route), not "the module the user was
  // on". This is the deterministic replacement — go to the base route AND
  // explicitly set the module, instead of trusting history.
  const returnToModule = useCallback((moduleKey, filter) => {
    if (filter !== undefined) setFilterStatus(filter);
    navigate(roleRoutes[user.role]);
    setActiveModule(moduleKey);
  }, [navigate, user.role]);

  const handleCreateVehicle = async (payload) => {
    setNotice(null);
    try {
      const request = moduleRequest('vehicles', null, payload);
      const response = await sendPayload(request.method, request.path, payload);
      await refreshCurrent();
      setNotice({ type: 'success', text: 'Vehicle added.' });
      const newVehicleId = response?.data?.vehicle_id;
      // Arrived here via another page's "+ Add Vehicle" shortcut (e.g.
      // Report Vehicle Issue) — go back there with the new vehicle already
      // selected, instead of landing on its profile page.
      const returnTo = location.state?.returnTo;
      if (returnTo) {
        navigate(returnTo, { state: newVehicleId ? { prefillVehicleId: newVehicleId } : undefined });
      } else if (newVehicleId) {
        navigate(`${roleRoutes[user.role]}/vehicles/${newVehicleId}`);
      } else {
        returnToModule('vehicles');
      }
      return true;
    } catch (error) {
      showError(error, setNotice);
      return false;
    }
  };

  // Shared submit handler for the simple single-form pages (Vehicle Types,
  // Maintenance Schedules, Condition Checks, Issue Reports) — moduleKey picks
  // the endpoint/method, existing (or null) picks create vs update.
  // Gap 2 — close the loop on a scheduled PM: one call marks it done, logs the
  // record, and (if recurring) seeds the next occurrence.
  const completeSchedule = async (target, payload) => {
    setNotice(null);
    try {
      await sendPayload('put', `/maintenance-schedules/${target.schedule_id}/complete`, payload);
      await refreshCurrent();
      setNotice({ type: 'success', text: target.recurrence_months ? 'Marked done — next service scheduled.' : 'Marked done.' });
      setCompleteScheduleTarget(null);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // Admin's "Reassign" action (schedule.reassign ability, Admin only): hand a
  // Scheduled row to a different Maintenance Personnel without having to
  // cancel it and book a new one.
  const reassignSchedule = async (target, payload) => {
    setNotice(null);
    try {
      await api.put(`/maintenance-schedules/${target.schedule_id}/reassign`, { assigned_to: payload.assigned_to });
      await refreshCurrent();
      setNotice({ type: 'success', text: 'Schedule reassigned.' });
      setReassignScheduleTarget(null);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // Shared success tail for submitFormPage, below — pulled out so the
  // confirm-and-resubmit branch (a Maintenance Schedule conflict warning)
  // can reach the exact same "what happens after this actually saves" path
  // as an ordinary submit.
  const finishFormPageSuccess = async (moduleKey, existing, successMessage) => {
    await refreshCurrent();
    // If the admin just edited their OWN account, re-pull the logged-in user
    // so the topbar name/avatar/photo update immediately (no reload needed).
    if (moduleKey === 'users' && existing?.id != null && String(existing.id) === String(user.id)) {
      await refreshUser();
    }
    setNotice({ type: 'success', text: successMessage });
    returnToModule(moduleKey);
  };

  const submitFormPage = async (moduleKey, existing, payload) => {
    setNotice(null);
    let finalPayload = payload;
    let request;
    try {
      // "+ Add New Issue" was picked on the maintenance form instead of an
      // existing report — file the Issue Report first, then point the
      // maintenance record at the ID it comes back with. The new report's
      // required description/severity aren't asked for a second time in the
      // "Add New Issue" popup — description reuses this same form's
      // Problem/Reason (already describing what's wrong), and severity
      // defaults to Medium since this form has no better signal for it.
      // userFields() renders vehicle-registration delegation as a one-item
      // checkboxes group (array in, array out) purely so it can reuse the
      // generic field renderer — the API wants a plain boolean.
      if (moduleKey === 'users' && Array.isArray(payload.can_register_vehicles)) {
        finalPayload = { ...payload, can_register_vehicles: payload.can_register_vehicles.includes('Allow vehicle registration') };
      }

      request = moduleRequest(moduleKey, existing, finalPayload);
      await sendPayload(request.method, request.path, finalPayload);

      await finishFormPageSuccess(moduleKey, existing, request.success);
      return true;
    } catch (error) {
      // A Maintenance Schedule create/update that lands on a same-vehicle or
      // barangay daily-volume conflict comes back as a 409 warning, not a
      // hard block — the backend never refuses outright, it just wants an
      // explicit "yes, anyway" first. Surface that as the same confirm
      // dialog used elsewhere in this file, and resubmit the exact same
      // payload with confirm_conflicts: true if the user confirms.
      if (moduleKey === 'schedules' && error.response?.status === 409 && error.response?.data?.warning) {
        setConfirmDialog({
          title: 'Scheduling Conflict',
          message: error.response.data.message,
          confirmLabel: existing ? 'Save Anyway' : 'Add Anyway',
          variant: 'primary',
          onConfirm: async () => {
            try {
              await sendPayload(request.method, request.path, { ...finalPayload, confirm_conflicts: true });
              await finishFormPageSuccess(moduleKey, existing, request.success);
            } catch (confirmError) {
              showError(confirmError, setNotice);
            }
          },
        });
        return false;
      }
      showError(error, setNotice);
      return false;
    }
  };

  // Work Orders and Verifications now act per sub-issue, not per ticket —
  // flatten each ticket's sub_issues into standalone rows so the existing
  // status filters below (which check row.status) keep working unchanged.
  const rawRows = activeModule === 'ticketWorkOrders'
    ? flattenSubIssueRows(records[activeModule], user.id)
    : activeModule === 'ticketVerifications'
      ? flattenSubIssueRows(records[activeModule])
      : records[activeModule] ?? [];
  const visibleRows = useMemo(() => {
    let result = rawRows;

    if (filterCategory.length) {
      result = result.filter((row) => {
        const vehicleObj = row.vehicle || (activeModule === 'vehicles' ? row : null);
        if (!vehicleObj) return false;
        return filterCategory.includes(String(vehicleObj.category_id));
      });
    }

    if (filterCapacity.length) {
      result = result.filter((row) => {
        const vehicleObj = row.vehicle || (activeModule === 'vehicles' ? row : null);
        if (!vehicleObj) return false;
        return filterCapacity.includes(vehicleObj.capacity);
      });
    }

    // Location/Domain filters — shared by Vehicle Management and any module
    // whose rows carry the same fields (Vehicle Location's own current
    // location; Vehicle Types' own domain).
    if ((activeModule === 'vehicles' || activeModule === 'locations') && filterLocation.length) {
      result = result.filter((row) => filterLocation.includes(row.current_location));
    }
    if (activeModule === 'schedules' && filterLocation.length) {
      result = result.filter((row) => filterLocation.includes(row.service_location));
    }
    if (activeModule === 'vehicles' && filterDomain.length) {
      result = result.filter((row) => filterDomain.includes(row.category?.domain));
    }
    if (activeModule === 'categories' && filterDomain.length) {
      result = result.filter((row) => filterDomain.includes(row.domain));
    }

    // Ready to Respond — a real dropdown, independent of the Status filter
    // above and the stat-card quick toggles (which write pseudo-values into
    // filterStatus instead). Retired vehicles stay excluded from both
    // buckets, matching vehicleStats' own count.
    if (activeModule === 'vehicles' && filterReadiness.length) {
      result = result.filter((row) => {
        if (row.readiness_state === 'retired') return false;
        return filterReadiness.includes(row.readiness_state === 'ready' ? 'Ready' : 'Not Ready');
      });
    }

    if (activeModule === 'vehicles' && !filterStatus.length) {
      result = result.filter((row) => row.status !== 'Inactive');
    }

    if (activeModule === 'schedules' && !filterStatus.length) {
      // Recurring schedules auto-regenerate every time one is completed
      // (Workflow 15), so Completed rows pile up indefinitely otherwise —
      // default view stays to just what's actually upcoming/actionable.
      // Click the Completed or Cancelled stat card to see the rest.
      result = result.filter((row) => row.status === 'Scheduled');
    }

    if (activeModule === 'schedules' && filterStatus.includes('MyAssigned')) {
      result = result.filter((row) => row.status === 'Scheduled' && String(row.assigned_to) === String(user.id));
    } else if (activeModule === 'schedules' && filterStatus.includes('AwaitingVerification')) {
      result = result.filter((row) => (
        row.status === 'Completed' && row.resulting_maintenance && row.resulting_maintenance.progress_status !== 'Completed'
      ));
    } else if (activeModule === 'schedules' && filterStatus.some((s) => SCHEDULE_URGENCY_KEYS.includes(s))) {
      result = result.filter((row) => filterStatus.includes(scheduleUrgencyBucket(row)));
    } else if (activeModule === 'ticketInspections') {
      result = result.filter((row) => (
        filterStatus.includes('Inspected') ? row.status !== 'Open' : row.status === 'Open'
      ));
    } else if (activeModule === 'ticketWorkOrders') {
      result = result.filter((row) => (
        filterStatus.includes('Submitted') ? row.status !== 'Under Repair' : row.status === 'Under Repair'
      ));
    } else if (activeModule === 'ticketVerifications') {
      result = result.filter((row) => (
        filterStatus.includes('Verified') ? row.status !== 'For Inspection' : row.status === 'For Inspection'
      ));
    } else if (activeModule === 'vehicles' && (filterStatus.includes('ReadyToRespond') || filterStatus.includes('NotReady'))) {
      // Retired vehicles are excluded from both buckets up in vehicleStats —
      // match that here too, or "Not Ready" would list units the card's own
      // count didn't include.
      result = result.filter((row) => row.readiness_state !== 'retired').filter((row) => (
        filterStatus.includes('ReadyToRespond') ? row.readiness_state === 'ready' : row.readiness_state !== 'ready'
      ));
    } else if (filterStatus.length && activeModule === 'users') {
      result = result.filter((row) => filterStatus.includes(row.role));
    } else if (filterStatus.length && activeModule === 'locations') {
      // Location records nest the vehicle status under `.vehicle`, not on
      // the row itself (the row IS a location snapshot, not a vehicle).
      result = result.filter((row) => filterStatus.includes(row.vehicle?.status));
    } else if (filterStatus.length) {
      result = result.filter((row) => {
        const statusVal = row.status ?? row.progress_status ?? row.final_status;
        return filterStatus.includes(statusVal);
      });
    }

    if (filterPriority.length) {
      result = result.filter((row) => {
        if (activeModule === 'vehicles') {
          return filterPriority.includes(row.condition);
        }
        if (activeModule === 'issues') {
          return filterPriority.includes(row.severity_level);
        }
        if (activeModule === 'maintenance') {
          return filterPriority.includes(row.maintenance_personnel?.name);
        }
        // Verification queue reuses the Priority slot as a Mechanic filter —
        // the sub-issue's assigned mechanic, not a priority level.
        if (activeModule === 'ticketVerifications') {
          return filterPriority.includes(row.assigned_mechanic?.name);
        }
        // Work Order queue reuses it as a Maintenance Type filter.
        if (activeModule === 'ticketWorkOrders') {
          return filterPriority.includes(row.maintenance_type);
        }
        return filterPriority.includes(row.priority);
      });
    }

    // Maintenance Schedule's own "Assigned To" filter — a dedicated
    // dimension since Schedules doesn't otherwise use the Priority slot.
    if (activeModule === 'schedules' && filterAssignedTo.length) {
      result = result.filter((row) => filterAssignedTo.includes(row.assigned_to_user?.name));
    }

    if (activeModule === 'tickets' && filterVehicle.length) {
      result = result.filter((row) => filterVehicle.includes(String(row.vehicle?.vehicle_id)));
    }

    // A ticket has no single mechanic of its own — it's assigned per
    // sub-issue — so this matches any ticket with at least one sub-issue
    // assigned to the selected mechanic(s).
    if (activeModule === 'tickets' && filterMechanic.length) {
      result = result.filter((row) => (row.sub_issues ?? []).some((si) => filterMechanic.includes(si.assigned_mechanic?.name)));
    }

    if (activeModule === 'tickets' && filterCustodian.length) {
      result = result.filter((row) => filterCustodian.includes(row.assigned_custodian?.name));
    }

    if (activeModule === 'maintenance') {
      if (filterMaintType.length) {
        result = result.filter((row) => filterMaintType.includes(row.maintenance_type));
      }
      if (filterSource.length) {
        result = result.filter((row) => filterSource.includes(row.source));
      }
    }

    if (activeModule === 'users' && filterActive.length) {
      result = result.filter((row) => filterActive.includes(row.is_active ? 'Active' : 'Inactive'));
    }

    if (activeModule === 'ticketVerifications' && filterVerdict.length) {
      result = result.filter((row) => filterVerdict.includes(row.verification_verdict));
    }

    if (activeModule === 'histories' && filterActivityType.length) {
      result = result.filter((row) => filterActivityType.includes(row.activity_type));
    }

    // Date range — same two fields, applied to whichever date column is
    // meaningful for the active module.
    if (filterDateStart || filterDateEnd) {
      const dateField = activeModule === 'maintenance' ? 'date_started'
        : activeModule === 'tickets' ? 'created_at'
        : activeModule === 'issues' ? 'created_at'
        : activeModule === 'histories' ? 'created_at'
        : null;
      if (dateField) {
        result = result.filter((row) => {
          const raw = row[dateField];
          if (!raw) return false;
          const rowDate = raw.substring(0, 10);
          if (filterDateStart && rowDate < filterDateStart) return false;
          if (filterDateEnd && rowDate > filterDateEnd) return false;
          return true;
        });
      }
    }

    if (activeModule === 'conditions') {
      if (filterCategory.length) {
        result = result.filter((row) => {
          const catId = row.vehicle?.category_id;
          return catId && filterCategory.includes(String(catId));
        });
      }

      if (filterStatus.length) {
        result = result.filter((row) => {
          return filterStatus.includes(row.condition_result);
        });
      }

      if (filterCheckedBy.length) {
        result = result.filter((row) => filterCheckedBy.includes(row.checked_by?.name));
      }

      if (condFilterStartDate) {
        result = result.filter((row) => {
          const rowDate = row.created_at ? row.created_at.substring(0, 10) : '';
          return rowDate >= condFilterStartDate;
        });
      }

      if (condFilterEndDate) {
        result = result.filter((row) => {
          const rowDate = row.created_at ? row.created_at.substring(0, 10) : '';
          return rowDate <= condFilterEndDate;
        });
      }
    }

    if (activeModule === 'ticketArchives') {
      if (archiveStart) {
        result = result.filter((row) => row.archived_at && row.archived_at.substring(0, 10) >= archiveStart);
      }
      if (archiveEnd) {
        result = result.filter((row) => row.archived_at && row.archived_at.substring(0, 10) <= archiveEnd);
      }
      if (archiveStatusFilter) {
        result = result.filter((row) => row.final_status === archiveStatusFilter);
      }
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter((row) => {
        const matchesField = (val) => val && String(val).toLowerCase().includes(query);

        if (
          matchesField(row.vehicle_name) ||
          matchesField(row.plate_number) ||
          matchesField(row.ticket_title) ||
          matchesField(row.ticket_description) ||
          matchesField(row.problem_reason) ||
          matchesField(row.action_taken) ||
          matchesField(row.activity) ||
          matchesField(row.description) ||
          matchesField(row.observations) ||
          matchesField(row.address_area) ||
          matchesField(row.current_location) ||
          matchesField(row.category_name) ||
          matchesField(row.brand) ||
          matchesField(row.model) ||
          matchesField(row.status) ||
          matchesField(row.progress_status) ||
          matchesField(row.ticket_id) ||
          matchesField(row.maintenance_id) ||
          matchesField(row.issue_report_id) ||
          matchesField(row.schedule_id) ||
          matchesField(row.action) ||
          matchesField(row.module) ||
          matchesField(row.role) ||
          matchesField(row.details) ||
          matchesField(row.affected_record_id) ||
          matchesField(row.log_id)
        ) {
          return true;
        }

        if (row.user && matchesField(row.user.name)) return true;

        if (row.vehicle) {
          if (
            matchesField(row.vehicle.vehicle_name) ||
            matchesField(row.vehicle.plate_number) ||
            matchesField(row.vehicle.brand) ||
            matchesField(row.vehicle.model)
          ) {
            return true;
          }
        }

        if (row.reported_by && matchesField(row.reported_by.name)) return true;
        if (row.checked_by && matchesField(row.checked_by.name)) return true;
        if (row.updated_by && matchesField(row.updated_by.name)) return true;
        if (row.assigned_custodian && matchesField(row.assigned_custodian.name)) return true;
        if (row.assigned_mechanic && matchesField(row.assigned_mechanic.name)) return true;
        if (row.maintenance_personnel && matchesField(row.maintenance_personnel.name)) return true;

        return false;
      });
    }

    // A "Completed" schedule only means the calendar task is done — the
    // record it produced might still need Custodian verification. Float
    // those to the top instead of leaving them buried among rows that are
    // genuinely finished, so the ones still needing attention are the
    // first thing Admin sees.
    if (activeModule === 'schedules') {
      const needsAttention = (row) => (
        row.status === 'Completed' && row.resulting_maintenance && row.resulting_maintenance.progress_status !== 'Completed' ? 0 : 1
      );
      result = [...result].sort((a, b) => needsAttention(a) - needsAttention(b));
    }

    return result;
  }, [rawRows, searchQuery, filterCategory, filterCapacity, filterLocation, filterDomain, filterStatus, filterPriority, filterReadiness, filterIssueType, filterNoTicket, filterMaintType, filterSource, filterActive, filterAssignedTo, filterVerdict, filterCheckedBy, filterActivityType, filterVehicle, filterMechanic, filterCustodian, filterDateStart, filterDateEnd, activeModule, condFilterStartDate, condFilterEndDate, archiveStart, archiveEnd, archiveStatusFilter]);

  // Status breakdown for the Vehicle Management stat cards — counted from the
  // full unfiltered fetch so the cards stay accurate regardless of the active
  // search/filter selection.
  // Generic "total + count per value" helper reused by every module's stat
  // card row (Issue Reports, Maintenance Schedule, Condition Monitoring, etc.).
  const countByValues = (rows, getField, values) => {
    const counts = { total: rows.length };
    values.forEach((v) => { counts[v] = rows.filter((r) => getField(r) === v).length; });
    return counts;
  };

  const scheduleStats = useMemo(() => {
    const base = countByValues(records.schedules ?? [], (r) => r.status, ['Scheduled', 'Completed', 'Cancelled']);
    // A schedule marked "Completed" only means the calendar task is done —
    // the record it produced might still be sitting unverified. Surface
    // that as its own count so it's findable instead of buried among
    // fully-verified rows.
    const awaitingVerification = (records.schedules ?? []).filter(
      (r) => r.status === 'Completed' && r.resulting_maintenance && r.resulting_maintenance.progress_status !== 'Completed'
    ).length;
    // A mechanic's own pending workload — how many vehicles THEY still need
    // to do, not the fleet-wide total everyone else also sees.
    const myAssigned = (records.schedules ?? []).filter(
      (r) => r.status === 'Scheduled' && String(r.assigned_to) === String(user.id)
    ).length;
    // How soon each still-scheduled row is due — same buckets the top-row
    // urgency cards show and filter by (see scheduleUrgencyBucket).
    const urgency = { Overdue: 0, Due1to3: 0, Due4to7: 0, Due8plus: 0 };
    (records.schedules ?? []).forEach((r) => {
      const bucket = scheduleUrgencyBucket(r);
      if (bucket) urgency[bucket] += 1;
    });
    return { ...base, ...urgency, AwaitingVerification: awaitingVerification, MyAssigned: myAssigned };
  }, [records.schedules, user.id]);

  const userStats = useMemo(
    () => countByValues(records.users ?? [], (r) => r.role, ['Admin', 'Custodian', 'Maintenance Personnel']),
    [records.users]
  );
  const userStatusStats = useMemo(
    () => countByValues(records.users ?? [], (r) => (r.is_active ? 'Active' : 'Inactive'), ['Active', 'Inactive']),
    [records.users]
  );

  const workOrderStats = useMemo(() => {
    const rows = flattenSubIssueRows(records.ticketWorkOrders, user.id);
    const pending = rows.filter((r) => r.status === 'Under Repair').length;
    return { total: rows.length, Pending: pending, Submitted: rows.length - pending };
  }, [records.ticketWorkOrders, user.id]);

  const verificationStats = useMemo(() => {
    const rows = flattenSubIssueRows(records.ticketVerifications);
    const pending = rows.filter((r) => r.status === 'For Inspection').length;
    return { total: rows.length, Pending: pending, Verified: rows.length - pending };
  }, [records.ticketVerifications]);

  const vehicleStats = useMemo(() => {
    const rows = records.vehicles ?? [];
    const countByStatus = (status) => rows.filter((row) => row.status === status).length;
    // Retired (Inactive/Decommissioned) vehicles were never expected to
    // respond, so they're excluded from both sides of this split — otherwise
    // a fleet that's mostly retired reads as "not ready to respond" when
    // it's really just not in service.
    const inServiceRows = rows.filter((row) => row.readiness_state !== 'retired');
    return {
      total: rows.length,
      Available: countByStatus('Available'),
      'Under Maintenance': countByStatus('Under Maintenance'),
      Inactive: countByStatus('Inactive'),
      ReadyToRespond: inServiceRows.filter((row) => row.readiness_state === 'ready').length,
      NotReady: inServiceRows.filter((row) => row.readiness_state !== 'ready').length,
    };
  }, [records.vehicles]);

  // "All Vehicles" is the pilot table for the Choose Columns toolbar button
  // (show/hide + drag to reorder, persisted per browser) — see
  // ColumnChooserButton/useColumnChooser below.
  const vehicleColumnDefs = useMemo(
    () => vehicleColumns(user, (row) => openVehicleProfile(row, 'edit'), deleteRecord, restoreRecord, filterStatus, openTicketProfile, (row) => setReadinessPromptTarget(row)),
    [user, openVehicleProfile, deleteRecord, restoreRecord, filterStatus, openTicketProfile],
  );
  const vehicleColumnChooser = useColumnChooser('vms_vehicle_columns', vehicleColumnDefs);

  // Every other module's table gets the same Choose Columns / drag-to-reorder
  // treatment as Vehicle Management above — one useColumnChooser call per
  // table, hoisted up here (not inside renderModule's per-module branches)
  // because hooks can't run conditionally; renderModule only executes the
  // branch matching the current activeModule.
  const categoryColumnDefs = useMemo(
    () => categoryColumns((row) => navigate(`${roleRoutes[user.role]}/categories/${row.category_id}/edit`), deleteRecord),
    [navigate, user.role, deleteRecord],
  );
  const categoryColumnChooser = useColumnChooser('vms_category_columns', categoryColumnDefs);

  const userColumnDefs = useMemo(
    () => userColumns((row) => navigate(`${roleRoutes[user.role]}/users/${row.id}/edit`), toggleUserActive, user.id),
    [navigate, user.role, toggleUserActive, user.id],
  );
  const userColumnChooser = useColumnChooser('vms_user_columns', userColumnDefs);

  const scheduleColumnDefs = useMemo(
    () => scheduleColumns((row) => navigate(`${roleRoutes[user.role]}/schedules/${row.schedule_id}/edit`), deleteRecord, openCompleteSchedule, user, (row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.resulting_maintenance_id}`), restoreRecord, setReassignScheduleTarget, openTicketProfile),
    [navigate, user, deleteRecord, restoreRecord],
  );
  const scheduleColumnChooser = useColumnChooser('vms_schedule_columns', scheduleColumnDefs);

  const logColumnDefs = useMemo(
    () => logColumns(lookups.vehicles, openVehicleProfile, openTicketProfile),
    [lookups.vehicles, openVehicleProfile, openTicketProfile],
  );
  const logColumnChooser = useColumnChooser('vms_activity_log_columns', logColumnDefs);

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  const toggleSidebar = () => {
    setIsSidebarCollapsed((prev) => !prev);
  };

  // DEV-ONLY impersonation — a fast way to switch accounts while testing,
  // without logging out and back in. import.meta.env.DEV is compile-time, so
  // this entire block (and its UI below) is stripped from a production build;
  // the backend also 404s the endpoint outside local/testing.
  //
  // Deliberately reuses the map boundary selector's own Province/Barangay
  // dropdowns below (mapProvinceId/mapBarangayId) instead of adding its own
  // — one barangay picker driving two things is simpler than two pickers
  // sitting side by side doing almost the same job.
  const [impersonateCandidates, setImpersonateCandidates] = useState([]);
  const [impersonateId, setImpersonateId] = useState(user?.id ?? '');
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    api.get('/impersonate/candidates').then((r) => setImpersonateCandidates(r.data)).catch(() => {});
    // Re-fetch whenever the Users list itself refreshes (add/edit/delete a
    // user) — otherwise a newly-created account never appears here until a
    // full page reload, since this effect would otherwise only ever run once
    // on mount.
  }, [records.users]);
  // {key, label, users[]} per barangay — key matches mapBarangayId's value
  // so the same dropdown selection resolves which staff list to show here.
  const impersonateGroups = useMemo(() => {
    const groups = {};
    impersonateCandidates.forEach((u) => {
      const key = String(u.barangay_id ?? '');
      const label = u.province_name && u.barangay_name ? `${u.province_name} — ${u.barangay_name}` : 'Unassigned';
      (groups[key] ??= { label, users: [] }).users.push(u);
    });
    return Object.entries(groups).map(([key, g]) => ({ key, ...g }));
  }, [impersonateCandidates]);
  const doImpersonate = async () => {
    if (!impersonateId) return;
    try {
      // Phase A5 — a reason is now required on every impersonation, even
      // this dev-only shortcut; a fixed one keeps the "quick account
      // switch while testing" flow frictionless instead of adding another
      // field to a tool that's already stripped out of production.
      const res = await api.post(`/impersonate/${impersonateId}`, { reason: 'Dev testing (local impersonate control)' });
      // Stash the acting account's own token before it's overwritten below —
      // otherwise there was no way back into it short of logging out and back
      // in. Keyed off role so "Return to..." can route straight to the right
      // dashboard without an extra round-trip to figure out who they were.
      const ownToken = localStorage.getItem('token');
      if (ownToken) {
        localStorage.setItem('impersonator_token', ownToken);
        localStorage.setItem('impersonator_name', user.name);
        localStorage.setItem('impersonator_role', user.role);
      }
      localStorage.setItem('token', res.data.access_token);
      sessionStorage.removeItem('token');
      // Full reload → axios picks up the new token and AuthContext reloads the
      // impersonated user cleanly (no stale state from the previous account).
      window.location.assign(roleRoutes[res.data.user?.role] ?? '/admin');
    } catch {
      setNotice({ type: 'error', text: 'Could not impersonate that account.' });
    }
  };
  // Vehicle Location map boundary selector — lets an Admin swap which
  // barangay outline the map draws. Scoped to Province + Barangay only
  // (no City/Municipality step) since Mandaue City is the only city with
  // real per-barangay boundary data today — defaults to Cebu so the
  // Barangay dropdown is immediately usable. This is purely cosmetic:
  // hubs/vehicles aren't scoped by barangay, so switching only changes the
  // drawn outline + camera framing, not which hubs/vehicles show.
  const [mapProvinces, setMapProvinces] = useState([]);
  const [mapProvinceId, setMapProvinceId] = useState('');
  const [mapBarangays, setMapBarangays] = useState([]);
  const [mapBarangayId, setMapBarangayId] = useState('');
  const [mapBoundaryOverride, setMapBoundaryOverride] = useState(null);
  // Same "what counts as inside the service area" boundary the map draws,
  // recomputed here so the Add Location form can reject a geocoded address
  // that falls outside it — mirrors LocationDensityMap's own fallback (the
  // hardcoded Paknaan outline when no barangay override is selected, or the
  // override has no boundary geometry on file).
  const locationBoundaryRings = useMemo(() => {
    const overrideRings = geoJsonToRings(mapBoundaryOverride?.geometry);
    return overrideRings.length ? overrideRings : [PAKNAAN_POLYGON];
  }, [mapBoundaryOverride]);
  const locationBoundaryLabel = mapBoundaryOverride?.label ?? 'Paknaan';
  // Guards the one-time "default to Paknaan" seed below from re-firing on a
  // second effect invocation (React's dev-only StrictMode double-invokes
  // effects on mount) — without this, a second run would call
  // loadBarangaysForProvince(cebu.id, 'Paknaan') again.
  const mapDefaultAppliedRef = useRef(false);
  // The bigger race: that seed is 2 sequential API calls deep (province ->
  // barangay list -> boundary fetch), slow enough on the local dev server
  // that an admin can pick a real barangay from the dropdown WHILE it's
  // still in flight. When it finally resolves, it must not overwrite a
  // selection made in the meantime — this ref is the source of truth for
  // "has the admin touched this dropdown themselves".
  const userPickedBarangayRef = useRef(false);

  // DEV-only: the same two dropdowns also drive Impersonate below, so a
  // barangay with registered staff but no boundary polygon (anything other
  // than Paknaan today) still needs to show up here, not just barangays
  // the map can actually draw. Merged in, never replacing the boundary-
  // sourced list — production keeps working with zero impersonation data.
  const provinceOptions = useMemo(() => {
    const byId = new Map(mapProvinces.map((p) => [String(p.id), p]));
    impersonateCandidates.forEach((u) => {
      if (u.province_id && !byId.has(String(u.province_id))) {
        byId.set(String(u.province_id), { id: u.province_id, name: u.province_name });
      }
    });
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [mapProvinces, impersonateCandidates]);
  const barangayOptions = useMemo(() => {
    const byId = new Map(mapBarangays.map((b) => [String(b.id), b]));
    impersonateCandidates.forEach((u) => {
      if (u.barangay_id && String(u.province_id) === String(mapProvinceId) && !byId.has(String(u.barangay_id))) {
        byId.set(String(u.barangay_id), { id: u.barangay_id, name: u.barangay_name });
      }
    });
    // Guarantee the currently-selected barangay always has an entry — in
    // production, impersonateCandidates above is always empty (that merge
    // is dev-only), so a barangay outside Mandaue City (the only city with
    // a real /barangays/registered list) would otherwise vanish from its
    // own dropdown the moment it's selected, e.g. every non-Paknaan admin
    // landing on their own barangay by default.
    if (mapBarangayId && !byId.has(String(mapBarangayId)) && mapBoundaryOverride?.label) {
      byId.set(String(mapBarangayId), { id: mapBarangayId, name: mapBoundaryOverride.label });
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [mapBarangays, impersonateCandidates, mapProvinceId, mapBarangayId, mapBoundaryOverride]);
  // Keeps the Impersonate staff dropdown valid for whichever barangay is
  // currently selected above — re-runs whenever the barangay changes or the
  // candidate list itself first loads.
  const impersonateGroupUsers = impersonateGroups.find((g) => g.key === String(mapBarangayId))?.users ?? [];
  useEffect(() => {
    const stillValid = impersonateGroupUsers.some((u) => String(u.id) === String(impersonateId));
    if (!stillValid) {
      // The barangay/candidate chain resolves over several async calls, so
      // this can fire once against a still-loading (wrong) group before
      // landing on the real one. Falling back to "whoever's first" there
      // would silently pick a coworker instead of yourself — prefer your
      // own account if it's in this group at all, only falling further
      // back to "first" when you genuinely aren't a candidate here.
      const self = impersonateGroupUsers.find((u) => String(u.id) === String(user.id));
      setImpersonateId(self?.id ?? impersonateGroupUsers[0]?.id ?? '');
    }
    // impersonateGroupUsers is a derived array (new reference every render);
    // keying off mapBarangayId/impersonateCandidates instead avoids re-running
    // this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapBarangayId, impersonateCandidates]);

  // Fetches one barangay's boundary and sets it as the map override.
  const selectBarangayBoundary = useCallback(async (barangayId) => {
    if (!barangayId) { setMapBoundaryOverride(null); return; }
    try {
      const res = await api.get(`/barangays/${barangayId}`);
      // Always carry the picked barangay's own name, even when it has no
      // boundary polygon on file (only Mandaue City barangays do today) —
      // otherwise the map silently falls back to Paknaan's shape AND label,
      // which reads as "the dropdown did nothing" instead of "no data yet".
      // Qualified with the city name whenever we have one — several
      // barangay names repeat across neighboring cities (e.g. "Banilad"
      // exists in both Mandaue City and Cebu City), so a bare name on the
      // map reads as ambiguous, or worse, as the wrong city's barangay.
      const label = res.data.city_name ? `${res.data.name}, ${res.data.city_name}` : res.data.name;
      setMapBoundaryOverride({ geometry: res.data.boundary ?? null, label });
    } catch {
      setMapBoundaryOverride(null);
    }
  }, []);

  // Loads the barangays that actually have a registered user (plus Paknaan,
  // always included — the system's built-in home barangay) for the one
  // city within a province that has a registered barangay list. Which city
  // that is comes straight from `/provinces/with-barangays`'
  // `city_with_barangays_id` (see ProvinceController::withBarangays) rather
  // than being re-derived here — this used to search the province's city
  // list for one literally named "Mandaue City", which only worked because
  // that was the sole seeded example; a second city with real barangay data
  // in any province would have silently produced an empty dropdown. A
  // province with no such city (falsy `cityId`) simply ends up with an
  // empty Barangay dropdown. `defaultBarangayName` pre-selects a barangay
  // once the list loads — used to land on Paknaan on first load.
  const loadBarangaysForProvince = useCallback(async (cityId, defaultBarangayName) => {
    if (!cityId) {
      setMapBarangays([]);
      return;
    }
    try {
      const barangaysRes = await api.get('/barangays/registered', { params: { city_id: cityId } });
      setMapBarangays(barangaysRes.data);

      // Skip applying the default if the admin has already picked a real
      // barangay themselves while this chain was still in flight — this
      // check happens as late as possible (right before acting on it) so
      // it catches a pick made at any point during the 3-call chain above.
      const defaultBarangay = defaultBarangayName && !userPickedBarangayRef.current
        ? barangaysRes.data.find((b) => b.name === defaultBarangayName)
        : null;
      if (defaultBarangay) {
        setMapBarangayId(String(defaultBarangay.id));
        selectBarangayBoundary(defaultBarangay.id);
      }
    } catch {
      setMapBarangays([]);
    }
  }, [selectBarangayBoundary]);

  useEffect(() => {
    // Narrower than the registration form's /provinces — only provinces
    // that actually have registered barangay/boundary data, so the
    // dropdown doesn't list 80+ provinces with nothing behind them.
    api.get('/provinces/with-barangays').then((response) => {
      setMapProvinces(response.data);
      const cebu = response.data.find((p) => p.name === 'Cebu');
      if (cebu) {
        setMapProvinceId(String(cebu.id));
        if (!mapDefaultAppliedRef.current) {
          mapDefaultAppliedRef.current = true;
          // Land every admin on THEIR OWN barangay by default, not always
          // Paknaan — that hardcoded default only ever made sense back when
          // Paknaan was the only barangay in the system. Falls back to
          // Paknaan only for an account with no barangay of its own (there
          // isn't one today, but this keeps old behavior as the fallback).
          if (user.barangay_id && !userPickedBarangayRef.current) {
            setMapBarangayId(String(user.barangay_id));
            selectBarangayBoundary(user.barangay_id);
            loadBarangaysForProvince(cebu.city_with_barangays_id, null);
          } else {
            loadBarangaysForProvince(cebu.city_with_barangays_id, 'Paknaan');
          }
        } else {
          // Still populate the barangay list for this province — just
          // don't re-seed the default selection over a real one.
          loadBarangaysForProvince(cebu.city_with_barangays_id, null);
        }
      }
    }).catch(() => {});
  }, [loadBarangaysForProvince, selectBarangayBoundary, user.barangay_id]);

  const handleMapProvinceChange = (e) => {
    userPickedBarangayRef.current = true;
    const provinceId = e.target.value;
    setMapProvinceId(provinceId);
    setMapBarangayId('');
    setMapBoundaryOverride(null);
    setMapBarangays([]);
    if (provinceId) {
      const province = mapProvinces.find((p) => String(p.id) === String(provinceId));
      loadBarangaysForProvince(province?.city_with_barangays_id ?? null);
    }
  };

  const handleMapBarangayChange = (e) => {
    userPickedBarangayRef.current = true;
    const barangayId = e.target.value;
    setMapBarangayId(barangayId);
    selectBarangayBoundary(barangayId);
  };

  // Sidebar badge for a given module key — 'myTasks' has no badge_counts
  // entry of its own (it's not a real module), so it's the sum of the two
  // real queues it groups. Shared by each row's own badge and by a
  // collapsed group header's summed badge below.
  const badgeCountFor = (key) => (
    key === 'myTasks'
      ? (dashboard?.badge_counts?.ticketInspections ?? 0) + (dashboard?.badge_counts?.ticketVerifications ?? 0)
      : (dashboard?.badge_counts?.[key] ?? 0)
  );

  return (
    <FormNoticeContext.Provider value={notice}>
    <RowActionsContext.Provider value={rowActions}>
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-brand-cluster">
            <button
              aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="sidebar-toggle-btn"
              onClick={toggleSidebar}
              title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              type="button"
            >
              <Icon name="menu" size={24} />
            </button>
            <Icon name="gear" size={28} className="topbar-gear-icon" filled />
            <span className="vms-wordmark vms-wordmark-sm">vms</span>
          </div>
          <div className="map-boundary-selector" title="Choose which registered barangay outline the Vehicle Location map draws.">
            <select
              aria-label="Map boundary province"
              onChange={handleMapProvinceChange}
              value={mapProvinceId}
            >
              {provinceOptions.map((province) => (
                <option key={province.id} value={province.id}>{province.name}</option>
              ))}
            </select>
            <select
              aria-label="Map boundary barangay"
              disabled={barangayOptions.length === 0}
              onChange={handleMapBarangayChange}
              value={mapBarangayId}
            >
              {barangayOptions.length > 0 ? (
                barangayOptions.map((barangay) => (
                  <option key={barangay.id} value={barangay.id}>{barangay.name}</option>
                ))
              ) : (
                <option value="">No registered barangay</option>
              )}
            </select>
          </div>
          {import.meta.env.DEV && impersonateGroupUsers.length > 0 && (
            <div className="dev-impersonate" title="Dev only — switch account without logging out. Not present in production. Staff list follows the barangay picked above.">
              <select value={impersonateId} onChange={(e) => setImpersonateId(e.target.value)} aria-label="Impersonate account">
                {impersonateGroupUsers.map((u) => (
                  <option key={u.id} value={u.id} disabled={!u.is_active}>
                    {u.name} · {u.role}{u.is_active ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
              <button type="button" onClick={doImpersonate}>Impersonate</button>
            </div>
          )}
        </div>

        <div className="topbar-right">
          {/* The Return control now lives in the persistent banner below the
              topbar (Phase A5) — a single, more visible home for it instead
              of duplicating the button here too. */}
          <div className="notifications-dropdown-container" ref={notificationsRef}>
            <button
              className="icon-btn notification-btn"
              title="Notifications"
              type="button"
              onClick={() => setShowNotifications(!showNotifications)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
              </svg>
              {unreadCount > 0 && (
                <span className="notification-indicator">{unreadCount}</span>
              )}
            </button>

            {showNotifications && (
              <div className="notifications-dropdown">
                <div className="notifications-header">
                  <h4>Notifications</h4>
                  {unreadCount > 0 && (
                    <button type="button" onClick={markAllNotificationsAsRead}>Mark all as read</button>
                  )}
                </div>
                <div className="notifications-list">
                  {notifications.length === 0 ? (
                    <div className="notifications-empty">
                      <span style={{ display: 'inline-flex', opacity: 0.6 }}><Icon name="bell" size={26} /></span>
                      <span>No notifications yet.</span>
                    </div>
                  ) : (
                    notifications.map((n) => {
                      const notificationType = getNotificationStyle(n);
                      return (
                      <div
                        key={n.notification_id}
                        className={`notification-item notification-${notificationType} ${!n.read_at ? 'unread' : ''}`}
                        onClick={async () => {
                          await markNotificationAsRead(n.notification_id);
                          // Production-readiness audit finding #10 — open the
                          // exact record this notification is about, not just
                          // mark it read and leave the user where they were.
                          if (n.ticket_id) {
                            openTicketProfile({ ticket_id: n.ticket_id });
                          } else if (n.vehicle_id) {
                            navigate(`${roleRoutes[user.role]}/vehicles/${n.vehicle_id}`);
                          } else if (n.schedule_id && n.type === 'schedule_due' && canDo(user, 'ticket.propose')) {
                            // A due schedule opens the Propose Ticket form pre-filled
                            // from it — the single way a schedule becomes a ticket.
                            try {
                              const res = await api.get('/maintenance-schedules');
                              const sch = (res.data ?? []).find((x) => x.schedule_id === n.schedule_id);
                              if (sch) {
                                setPrefilledTicketData({
                                  vehicle_id: sch.vehicle_id,
                                  problem: `Scheduled ${sch.maintenance_type}`,
                                  maintenance_type: sch.maintenance_type,
                                  details: `Scheduled maintenance (${sch.maintenance_type}) due ${sch.scheduled_date}.${sch.notes ? ` ${sch.notes}` : ''}`,
                                  priority: 'Medium',
                                  schedule_id: sch.schedule_id,
                                  suggested_mechanic_id: sch.assigned_to ?? '',
                                });
                                navigate(`${roleRoutes[user.role]}/tickets/new`);
                              }
                            } catch {
                              returnToModule('schedules');
                            }
                          } else if (n.schedule_id) {
                            // Not every role that can receive this (e.g. a
                            // Maintenance Personnel assignee) holds
                            // schedule.edit — land on the shared list instead
                            // of a specific /edit page that could redirect
                            // them away.
                            returnToModule('schedules');
                          }
                          setShowNotifications(false);
                        }}
                      >
                        <div className="notification-content">
                          <span className="notification-title">{n.title}</span>
                          <span className="notification-msg">{n.message}</span>
                          <span className="notification-time">{formatDate(n.created_at)}</span>
                      </div>
                      <div className="notification-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="notification-close-btn"
                          type="button"
                          title="Delete notification"
                          onClick={() => deleteNotification(n.notification_id)}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    </div>
                    );
                    })
                )}
              </div>
            </div>
          )}
        </div>

        <button
          className="icon-btn theme-toggle-btn"
          type="button"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle light and dark mode"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        <div className="profile-menu-container" ref={profileMenuRef}>
          <ProfileMenu
            user={user}
            open={showProfileMenu}
            setOpen={setShowProfileMenu}
            onLogout={handleLogout}
            onOpenNotifications={() => setShowNotifications(true)}
            onOpenSettings={() => navigate(`${roleRoutes[user.role]}/profile`)}
          />
        </div>
      </div>
      </header>

      <main className={`workspace${isSidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <aside className={`sidebar${isSidebarCollapsed ? ' collapsed' : ''}`}>
          <nav className="module-nav" aria-label="Workspace modules">
            {moduleGroups.map(({ section, icon, items }) => {
              const renderItem = ([key, label]) => {
                const badgeCount = badgeCountFor(key);
                // Admin's "Maintenance Tickets" badge (badge_counts.tickets)
                // already counts every non-Closed/Cancelled ticket, Pending
                // Approval proposals included — adding ticketProposals on top
                // would double-count them. Shown as its own small pill
                // instead, so "N open tickets" and "M awaiting your review"
                // stay two distinct, addable-up-in-your-head signals.
                // 'ticketPropose' isn't a real module (no list view/endpoint
                // of its own) — it's a direct link straight to the Propose
                // Ticket form, same URL Admin's own Create Ticket flow uses.
                // Every other item here just flips `activeModule` in place.
                const isDirectRouteLink = key === 'ticketPropose';
                // 'myTasks' also isn't a real module — clicking it jumps
                // straight to whichever of its three tabs was last open
                // (see setMyTasksTab / myTasksLastTab above).
                const isMyTasksContainer = key === 'myTasks';
                // 'maintenanceLedger' is the same kind of thin wrapper —
                // jumps to whichever of its two tabs was last open (see
                // setMaintenanceLedgerTab / maintenanceLedgerLastTab above).
                const isMaintenanceLedgerContainer = key === 'maintenanceLedger';
                return (
                  <button
                    className={key === breadcrumbModule ? 'active' : ''}
                    key={key}
                    onClick={() => guardedNavigate(() => {
                      if (isDirectRouteLink) {
                        navigate(`${roleRoutes[user.role]}/tickets/new`);
                        return;
                      }
                      if (isMyTasksContainer) {
                        setMyTasksTab(myTasksLastTab);
                      } else if (isMaintenanceLedgerContainer) {
                        setMaintenanceLedgerTab(maintenanceLedgerLastTab);
                      } else {
                        // 'workTracker' is the one real key both My Tasks'
                        // own "History" tab and Maintenance Personnel's
                        // separate, untouched "Work Tracker" row can set —
                        // landing here via THIS plain entry (not the My
                        // Tasks tab bar above) means it's the latter.
                        if (key === 'workTracker') setWorkTrackerViaMyTasks(false);
                        // 'reportOrPropose' is a relabeled alias for the
                        // Issue Reports list — its "Report Vehicle Issue" and
                        // "Propose Ticket" actions both live inline there.
                        setActiveModule(key === 'reportOrPropose' ? 'issues' : key);
                      }
                      if (isOnSpecialPage) {
                        navigate(roleRoutes[user.role]);
                      }
                    })}
                    title={isSidebarCollapsed ? label : undefined}
                    type="button"
                  >
                    {moduleIcons[key]}
                    <span>{label}</span>
                    {badgeCount > 0 && <span className="module-nav-badge">{badgeCount}</span>}
                  </button>
                );
              };

              // Ungrouped (Dashboard) — no header, always visible.
              if (!section) return <div key="__top" className="module-nav-group">{items.map(renderItem)}</div>;

              // Collapsing must never hide an alert: the header carries the
              // sum of its children's badges so a folded group still shows
              // there's something inside needing attention.
              const groupBadge = items.reduce((sum, [key]) => sum + badgeCountFor(key), 0);
              // The icon-only rail forces every group open (no room for
              // headers there, and hiding icons would leave no way to reach
              // them). Otherwise this is a plain accordion — a group holding
              // the active module used to also force itself open, which made
              // clicking that group's own header look broken (the click
              // toggled the stored state, but this override kept rendering
              // it expanded regardless) — the user's explicit collapse now
              // always wins.
              const expanded = isSidebarCollapsed || !collapsedNavGroups.includes(section);

              return (
                <div key={section} className="module-nav-group">
                  <button
                    type="button"
                    className="module-nav-section"
                    onClick={() => toggleNavGroup(section)}
                    aria-expanded={expanded}
                  >
                    {icon && <Icon name={icon} size={16} className="nav-icon" />}
                    <span className="module-nav-section-label">{section}</span>
                    {!expanded && groupBadge > 0 && <span className="module-nav-badge">{groupBadge}</span>}
                    <Icon name="chevronDown" size={14} className={`module-nav-section-chevron${expanded ? ' is-expanded' : ''}`} />
                  </button>
                  {expanded && items.map(renderItem)}
                </div>
              );
            })}
          </nav>
        </aside>

        <section className="content-area">
          {/* Dashboard has its own greeting banner right below (name, role,
              date) — this generic icon+title bar would just repeat "Dashboard"
              redundantly above it, so it's skipped for that one page only. */}
          {(activeModule !== 'dashboard' || isOnSpecialPage) && (
            <div className="page-heading-row">
              <span className="page-heading-icon">{moduleIcons[breadcrumbModule]}</span>
              <div className="page-heading-text">
                {subPageTitle && !isProfilePage && (
                  <p className="breadcrumb-path">{moduleLabel(modules, breadcrumbModule)} »</p>
                )}
                {/* breadcrumbModule (not activeModule) — for the merged
                    My Tasks / Report-Propose entries, activeModule is still
                    the real underlying key (e.g. 'ticketInspections'), which
                    isn't a literal sidebar item any more so moduleLabel
                    couldn't resolve it; breadcrumbModule already maps those
                    to the merged entry's own key/label for exactly this. */}
                <h2>{subPageTitle ?? moduleLabel(modules, breadcrumbModule)}</h2>
              </div>
            </div>
          )}

        {notice && notice.lines ? (
          <div className="toast-notice-overlay" onClick={() => setNotice(null)}>
            <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
              <Icon name="alert" size={17} className="toast-notice-icon" />
              <div className="toast-notice-lines">
                {notice.lines.map((line, i) => <span key={i}>{line}</span>)}
              </div>
              <button type="button" className="toast-notice-close" onClick={() => setNotice(null)} aria-label="Dismiss">
                <Icon name="close" size={13} />
              </button>
            </div>
          </div>
        ) : notice && (
          <div className={`toast-notice ${notice.type}`} role="alert">
            <div className="toast-notice-body">
              <Icon name={notice.type === 'success' ? 'checkCircle' : 'alert'} size={16} />
              <span>{notice.text}</span>
            </div>
            {notice.openTickets?.length ? (
              <div className="toast-notice-ticket-links">
                {notice.openTickets.map((t) => (
                  <button
                    key={t.ticket_id}
                    type="button"
                    className="toast-notice-ticket-link"
                    onClick={() => {
                      setNotice(null);
                      navigate(`${roleRoutes[user.role]}/tickets/${t.ticket_id}`);
                    }}
                  >
                    Ticket #{t.ticket_id}{t.ticket_title ? ` — ${t.ticket_title}` : ''}
                  </button>
                ))}
              </div>
            ) : null}
            <button type="button" className="toast-notice-close" onClick={() => setNotice(null)} aria-label="Dismiss">
              <Icon name="close" size={13} />
            </button>
          </div>
        )}
        <div className="content-body">
          {isProfilePage ? (
            <ProfilePage
              user={user}
              onBack={() => navigate(roleRoutes[user.role])}
              setNotice={setNotice}
              refreshUser={refreshUser}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : isNewVehiclePage ? (
            <NewVehiclePage
              onBack={() => (location.state?.returnTo ? navigate(location.state.returnTo) : returnToModule('vehicles'))}
              lookups={lookups}
              allHubs={allHubs}
              onSubmit={handleCreateVehicle}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : isNewLocationPage ? (
            <NewLocationPage
              onBack={() => returnToModule('locations')}
              boundaryRings={locationBoundaryRings}
              boundaryLabel={locationBoundaryLabel}
              onSubmit={async (hub) => {
                await api.post('/hubs', hub);
                setNotice({ type: 'success', text: 'Location added.' });
                await refreshCurrent();
                returnToModule('locations');
              }}
            />
          ) : isNewTicketPage ? (
            // Same /tickets/new URL, two entirely separate components: a
            // role with ticket.create gets NewTicketPage untouched; Custodian
            // (ticket.propose) gets ProposeTicketPage — a simpler, purpose-
            // built form for POST /tickets/propose, kept fully separate
            // rather than a shared branch. Nobody currently holds
            // ticket.create (Admin only reviews/edits/approves a Custodian's
            // proposal now — every ticket must originate from one), so the
            // third branch below is what a stray deep-link to this URL hits.
            canDo(user, 'ticket.propose') ? (
              <ProposeTicketPage
                onBack={() => {
                  setPrefilledTicketData(null);
                  // Back to where proposals start (the Issue Reports list, which
                  // now shows this report's ticket), keeping the success notice.
                  keepNoticeRef.current = true;
                  returnToModule('workTracker');
                }}
                ticketLookups={ticketLookups}
                prefilledTicketData={prefilledTicketData}
                onProposeTicket={proposeTicket}
                onDirty={() => setHasUnsavedChanges(true)}
              />
            ) : (
              <ModulePanel description="Tickets can only be started by a Custodian's proposal.">
                <p className="empty-state">
                  You don't have permission to start a ticket from scratch. Ask the assigned Custodian to propose one from Report / Propose — it'll show up here for you to review, edit, and approve or decline.
                </p>
                <button className="ghost-button" type="button" onClick={() => returnToModule('tickets')}>Back to Maintenance Tickets</button>
              </ModulePanel>
            )
          ) : vehicleProfileId ? (
            <VehicleProfilePage
              vehicleId={vehicleProfileId}
              lookups={lookups}
              allHubs={allHubs}
              basePath={roleRoutes[user.role]}
              canManage={hasRole(user, 'Admin')}
              // 2026-10-06 spec reversal — Maintenance Personnel can now view
              // documents and upload repair evidence (edit only their own
              // upload); Custodian keeps upload + edit-own (VehicleFiles/
              // VehicleFilesModal enforce the ownership half via added_by);
              // Admin unrestricted; delete stays Admin-only everywhere.
              canManageDocuments={canDo(user, 'document.create')}
              canViewDocuments={canDo(user, 'document.view')}
              canViewUsage={canDo(user, 'usage.view')}
              canLogUsage={canDo(user, 'usage.log')}
              canCheckReadiness={canDo(user, 'vehicle.readiness_check')}
              canRecordCondition={canDo(user, 'condition.create')}
              canProposeTicket={canDo(user, 'ticket.propose')}
              onProposeMaintenance={(prefill) => { setPrefilledTicketData(prefill); navigate(`${roleRoutes[user.role]}/tickets/new`); }}
              canViewHistory={canDo(user, 'vehicle.view_history')}
              // Production-readiness audit finding #8 — the reliability
              // endpoint was fully built with no UI anywhere; surfaced here
              // (an existing Admin page) rather than a new sidebar module.
              canViewReliability={hasRole(user, 'Admin')}
              setNotice={setNotice}
              onSaved={refreshCurrent}
              onRequestConfirmation={setConfirmDialog}
            />
          ) : ticketProfileId ? (
            <TicketProfilePage
              ticketId={ticketProfileId}
              user={user}
              userId={user.id}
              ticketLookups={ticketLookups}
              onBack={() => returnToModule('tickets')}
              onRequestConfirmation={setConfirmDialog}
              ticketAction={ticketAction}
            />
          ) : (isNewCategoryPage || editCategoryId) ? (
            <>
            <FormPage
              description="Maintain standard vehicle type choices used across dropdowns."
              onBack={() => returnToModule('categories')}
              fields={categoryFields}
              initialValues={editCategoryId ? (records.categories ?? []).find((c) => String(c.category_id) === String(editCategoryId)) : EMPTY_OBJ}
              onSubmit={(payload) => submitFormPage('categories', editCategoryId ? { category_id: editCategoryId } : null, payload)}
              submitLabel={editCategoryId ? 'Update Type' : 'Add Type'}
              wrapperClassName="category-form-grid"
              categoryVehicleCount={editCategoryId ? (records.categories ?? []).find((c) => String(c.category_id) === String(editCategoryId))?.vehicles_count : null}
              onDirty={() => setHasUnsavedChanges(true)}
              showDomainPreview
            />
            {editCategoryId && canDo(user, 'vehicle_type.edit') && (
              <CategoryFieldsManager categoryId={editCategoryId} onChanged={loadLookups} />
            )}
            </>
          ) : (isNewSchedulePage || editScheduleId) ? (
            <FormPage
              description="Plan preventative maintenance and track schedule status."
              onBack={() => { setPrefilledScheduleData(null); returnToModule('schedules'); }}
              fields={scheduleFields(lookups, allHubs, Boolean(editScheduleId), !editScheduleId && !canDo(user, 'schedule.create'))}
              initialValues={scheduleInitialValues}
              onSubmit={(payload) => submitFormPage('schedules', editScheduleId ? { schedule_id: editScheduleId } : null, payload)}
              submitLabel={editScheduleId ? 'Update Schedule' : (canDo(user, 'schedule.create') ? 'Add Schedule' : 'Send Suggestion')}
              contextVehicles={lookups.vehicles}
              hubs={allHubs}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : viewUserId ? (
            <UserViewPage
              userId={viewUserId}
              users={records.users}
              currentUser={user}
              onEdit={() => navigate(`${roleRoutes[user.role]}/users/${viewUserId}/edit`)}
            />
          ) : (isNewUserPage || editUserId) ? (
            <FormPage
              description="Create and manage user accounts — Admin, Custodian, and Maintenance Personnel."
              onBack={() => returnToModule('users')}
              fields={(vals) => userFields(Boolean(editUserId), vals)}
              initialValues={editUserInitialValues}
              onSubmit={(payload) => submitFormPage('users', editUserId ? { id: editUserId } : null, payload)}
              submitLabel={editUserId ? 'Update User' : 'Add User'}
              wrapperClassName="user-form-grid"
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : logRepairsTicketId ? (
            <LogRepairsPage
              key={flattenSubIssueRows(records.ticketWorkOrders).some((r) => String(r.ticket_id) === String(logRepairsTicketId) && String(r.sub_issue_id) === String(logRepairsSubIssueId)) ? 'ready' : 'loading'}
              ticket={flattenSubIssueRows(records.ticketWorkOrders).find((r) => String(r.ticket_id) === String(logRepairsTicketId) && String(r.sub_issue_id) === String(logRepairsSubIssueId))}
              vehicleOptions={lookups.vehicles ?? []}
              onBack={() => returnToModule('ticketWorkOrders')}
              onSubmit={(subIssueRow, payload) => ticketAction(`/tickets/${subIssueRow.ticket_id}/sub-issues/${subIssueRow.sub_issue_id}/log-repairs`, payload, 'Repair logs submitted. Sent for Custodian verification.').then((ok) => { if (ok) returnToModule('ticketWorkOrders'); })}
              onExternalSend={(row, payload) => ticketAction(`/tickets/${row.ticket_id}/sub-issues/${row.sub_issue_id}/external-sent`, payload, 'Marked as sent to the shop.')}
              onExternalReturn={(row, payload) => ticketAction(`/tickets/${row.ticket_id}/sub-issues/${row.sub_issue_id}/external-returned`, payload, 'Marked as returned from the shop.')}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : (loading ? <ModuleLoader /> : renderModule())}
        </div>
        <WorkspaceFooter />
      </section>
    </main>
    <ConfirmDialog
      busy={confirmBusy}
      dialog={confirmDialog}
      onCancel={() => setConfirmDialog(null)}
      onConfirm={handleConfirmDialog}
    />
    {userInfoTarget && <UserInfoModal user={userInfoTarget} onClose={() => setUserInfoTarget(null)} />}
    <FormModal open={!!approvalTarget} title={`Approve ${approvalTarget?.name ?? ''}`} onClose={() => setApprovalTarget(null)}>
      {approvalTarget && (
        <SmartForm
          fields={[
            {
              label: 'Role',
              name: 'role',
              options: ['Custodian', 'Maintenance Personnel', 'Admin'],
              required: true,
              type: 'select',
              hint: `${approvalTarget.name} requested "${approvalTarget.role}" at signup — confirm it or pick a different role before activating their account.`,
            },
          ]}
          initialValues={{ role: approvalTarget.role }}
          onCancel={() => setApprovalTarget(null)}
          onSubmit={async (payload) => {
            setNotice(null);
            try {
              await api.put(`/users/${approvalTarget.id}/activate`, { role: payload.role });
              setNotice({ type: 'success', text: 'User activated.' });
              setApprovalTarget(null);
              await refreshCurrent();
            } catch (error) {
              showError(error, setNotice);
            }
          }}
          submitLabel="Activate"
          title=""
        />
      )}
    </FormModal>
    </RowActionsContext.Provider>
    </FormNoticeContext.Provider>
  );

  // Shared "Mark Done" modal for a Maintenance Schedule — used both from the
  // Schedules module (Admin/Custodian) and from My Work Orders (Phase B4 —
  // a Maintenance Personnel account's assigned schedules now surface there
  // too), so completing a schedule works identically regardless of which
  // page it was opened from. Pulled out of the Schedules module's own render
  // branch so it isn't limited to only appearing there.
  function renderCompleteScheduleModal() {
    return (
      <FormModal open={!!completeScheduleTarget} title={`Mark Done — ${completeScheduleTarget?.maintenance_type ?? ''}`} onClose={() => setCompleteScheduleTarget(null)}>
        {completeScheduleTarget && (
          <>
            <p className="muted" style={{ marginBottom: 12, fontSize: '0.85rem' }}>
              This logs a maintenance record for the work and closes the schedule
              {completeScheduleTarget.recurrence_months ? `, then auto-schedules the next one (${RECURRENCE_LABEL[completeScheduleTarget.recurrence_months] ?? `every ${completeScheduleTarget.recurrence_months} months`}).` : '.'}
            </p>
            <SmartForm
              fields={[
                { label: 'Date Completed', name: 'date_completed', type: 'date' },
                { label: 'Cost (optional)', name: 'maintenance_cost', type: 'number' },
                // Sometimes a scheduled job turns out to need a
                // third-party shop instead of in-house work.
                { label: 'Sent to External Shop?', name: 'is_external', type: 'select', options: [
                  { value: 0, label: 'No — done in-house' },
                  { value: 1, label: 'Yes — external shop repair' },
                ] },
                // Vendor/warranty only matter when it went external.
                ...(completeScheduleExternal ? [
                  { label: 'External Shop', name: 'external_vendor', type: 'text', placeholder: 'e.g. Bautista Auto Shop' },
                  { label: 'Warranty Until', name: 'warranty_until', type: 'date' },
                ] : []),
                {
                  label: 'Receipt / Proof of Completion',
                  name: 'receipt',
                  type: 'file',
                  accept: 'image/*,.pdf',
                  // Final senior system review (2026-10-05, §2) — only the
                  // assigned Maintenance Personnel can even open this modal
                  // now, and a receipt/photo is evidence only; it never skips
                  // the Custodian check, for anyone.
                  hint: 'Attach a receipt or a photo of the completed repair so the Custodian verifying this has proof.',
                },
                { label: 'Notes (what was done)', name: 'notes', type: 'textarea', rows: 2 },
              ]}
              key={`complete-${completeScheduleTarget.schedule_id}`}
              initialValues={{ date_completed: new Date().toISOString().slice(0, 10) }}
              onValuesChange={(vals) => setCompleteScheduleExternal(vals.is_external === 1 || vals.is_external === '1' || vals.is_external === true)}
              onCancel={() => setCompleteScheduleTarget(null)}
              onSubmit={(payload) => completeSchedule(completeScheduleTarget, payload)}
              submitLabel="Mark as Done"
              title=""
            />
          </>
        )}
      </FormModal>
    );
  }

  // Phase B4 — Admin-only "Reassign" action on a Scheduled row (new
  // schedule.reassign ability): hands the job to a different Maintenance
  // Personnel without cancelling and re-booking it. Reuses the same
  // maintenance_personnel picker the Add/Edit Schedule form already uses for
  // Assigned To.
  function renderReassignScheduleModal() {
    return (
      <FormModal open={!!reassignScheduleTarget} title={`Reassign — ${reassignScheduleTarget?.maintenance_type ?? ''}`} onClose={() => setReassignScheduleTarget(null)}>
        {reassignScheduleTarget && (
          <SmartForm
            fields={[
              {
                label: 'Assigned To',
                name: 'assigned_to',
                // The backend 422s if "reassigned" to whoever already has
                // it — leave the current assignee out of the picker rather
                // than let that be a click away.
                options: options((lookups.maintenance_personnel ?? []).filter((p) => String(p.id) !== String(reassignScheduleTarget.assigned_to)), 'id', 'name'),
                required: true,
                type: 'select',
              },
            ]}
            key={`reassign-${reassignScheduleTarget.schedule_id}`}
            initialValues={{ assigned_to: '' }}
            onCancel={() => setReassignScheduleTarget(null)}
            onSubmit={(payload) => reassignSchedule(reassignScheduleTarget, payload)}
            submitLabel="Reassign"
            title=""
          />
        )}
      </FormModal>
    );
  }

  function renderModule() {
    // Task 1 of the sidebar consolidation — Custodian's merged "My Tasks"
    // container. `activeModule` is still the literal real key here
    // ('ticketInspections'/'ticketVerifications'/'workTracker'); this only
    // decides whether to also show the tab bar above that unchanged module
    // component, reusing the same segmented tab-bar pattern already used for
    // Vehicle Location's Map/Records toggle (see .locations-tab-bar below).
    const showMyTasksContainer = hasMyTasksNav && (
      activeModule === 'ticketVerifications'
      || (activeModule === 'workTracker' && workTrackerViaMyTasks)
    );
    const myTasksTabBar = showMyTasksContainer && (
      <div className="locations-tab-bar" role="tablist" aria-label="My Tasks">
        <button
          type="button"
          role="tab"
          aria-selected={activeModule === 'ticketVerifications'}
          className={`locations-tab-button ${activeModule === 'ticketVerifications' ? 'active' : ''}`}
          onClick={() => setMyTasksTab('ticketVerifications')}
        >
          To Verify
          {(dashboard?.badge_counts?.ticketVerifications ?? 0) > 0 && (
            <span className="count-badge">{dashboard.badge_counts.ticketVerifications}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeModule === 'workTracker'}
          className={`locations-tab-button ${activeModule === 'workTracker' ? 'active' : ''}`}
          onClick={() => setMyTasksTab('workTracker')}
        >
          My Tickets
        </button>
        {canDo(user, 'ticket.propose') && (
          <button
            type="button"
            className="primary-button"
            style={{ marginLeft: 'auto' }}
            onClick={() => { setPrefilledTicketData(null); navigate(`${roleRoutes[user.role]}/tickets/new`); }}
          >
            <Icon name="plus" size={14} /> Propose Ticket
          </button>
        )}
      </div>
    );

    if (activeModule === 'dashboard') {
      return (
        <Dashboard
          data={dashboard}
          hubs={allHubs}
          user={user}
          basePath={roleRoutes[user.role]}
          onNavigate={navigate}
          onGoToSchedules={() => returnToModule(modules.some(([k]) => k === 'schedules') ? 'schedules' : 'ticketWorkOrders')}
          onGoToModule={returnToModule}
        />
      );
    }

    if (activeModule === 'vehicles') {
      return (
        <ModulePanel
          description={((hasRole(user, 'Custodian') && !hasRole(user, 'Admin')) ? 'View-only fleet information.' : 'Register, edit, and archive vehicle records.') + ' Status = availability (can it be dispatched right now?). Condition = physical state (does it need repair or inspection?). Click a row to see full vehicle details.'}
          statCards={
            <ModuleStatCards
              totalLabel="Total Vehicles"
              total={vehicleStats.total}
              cards={VEHICLE_STAT_CARDS}
              counts={vehicleStats}
              activeFilter={filterStatus}
              onFilterChange={setFilterStatus}
            />
          }
          filterBar={
            <FilterBar
              categories={lookups.categories}
              vehicles={lookups.vehicles}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterCapacity={filterCapacity}
              setFilterCapacity={setFilterCapacity}
              filterStatus={filterStatus}
              setFilterStatus={setFilterStatus}
              filterPriority={filterPriority}
              setFilterPriority={setFilterPriority}
              statusOptions={lookups.vehicle_statuses}
              priorityOptions={lookups.condition_results}
              priorityLabel="Condition"
              filterLocation={filterLocation}
              setFilterLocation={setFilterLocation}
              filterDomain={filterDomain}
              setFilterDomain={setFilterDomain}
              extraFilters={[{
                key: 'readiness',
                label: 'Ready to Respond',
                options: ['Ready', 'Not Ready'],
                selected: filterReadiness,
                setSelected: setFilterReadiness,
              }]}
            />
          }
        >
          <div className="panel-header-bar">
            <h3>All Vehicles <span className="count-badge">{visibleRows.length}</span></h3>
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search vehicles..."
              columnChooser={vehicleColumnChooser}
              onAdd={canRegisterVehicles(user) ? () => navigate(`${roleRoutes[user.role]}/vehicles/new`) : undefined}
              addLabel="Add Vehicle"
              onImport={canDo(user, 'vehicle.import') && canRegisterVehicles(user) ? () => setVehicleImportOpen(true) : undefined}
              onExport={() => exportRowsToCsv('vehicles.csv', VEHICLE_EXPORT_COLUMNS, visibleRows)}
            />
          </div>
          <PaginatedTable columns={vehicleColumnChooser.visibleColumns} rows={visibleRows} onRowClick={openVehicleProfile} onReorderColumn={vehicleColumnChooser.reorderColumn} emptyMessage="No vehicles here yet — click the + button to register one." />
          <VehicleImportModal open={vehicleImportOpen} onClose={() => setVehicleImportOpen(false)} onImported={refreshCurrent} />
          <FormModal
            open={!!readinessPromptTarget}
            title={`Readiness Check — ${readinessPromptTarget?.vehicle_name ?? ''}`}
            onClose={() => setReadinessPromptTarget(null)}
          >
            {readinessPromptTarget && (
              <ReadinessCheckForm
                vehicle={readinessPromptTarget}
                onCancel={() => setReadinessPromptTarget(null)}
                onSubmit={(payload) => submitReadinessFromPrompt(readinessPromptTarget.vehicle_id, payload)}
              />
            )}
          </FormModal>
        </ModulePanel>
      );
    }

    if (activeModule === 'categories') {
      return (
        <ModulePanel
          description="Maintain standard vehicle type choices used across dropdowns."
          filterBar={
            <div className="filter-bar-container">
              <div className="filter-label"><span>Filters:</span></div>
              <div className="filter-date-group">
                <span>Domain</span>
                <MultiSelectDropdown
                  placeholder="All Domains (Land/Water)"
                  options={['Land', 'Water']}
                  selected={filterDomain}
                  onChange={setFilterDomain}
                />
              </div>
            </div>
          }
        >
          <div className="panel-header-bar">
            <h3>Vehicle Types <span className="count-badge">{visibleRows.length}</span></h3>
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search types..."
              columnChooser={categoryColumnChooser}
              onAdd={() => navigate(`${roleRoutes[user.role]}/categories/new`)}
              addLabel="Add Type"
            />
          </div>
          <DataTable columns={categoryColumnChooser.visibleColumns} onReorderColumn={categoryColumnChooser.reorderColumn} rows={visibleRows} emptyMessage="No vehicle types yet — click the + button to add one." />
        </ModulePanel>
      );
    }

    if (activeModule === 'users') {
      const userRoleSegments = [
        { label: 'Admin', value: userStats.Admin, color: '#7c3aed' },
        { label: 'Custodian', value: userStats.Custodian, color: '#0284c7' },
        { label: 'Maintenance Personnel', value: userStats['Maintenance Personnel'], color: '#d97706' },
      ];
      const userStatusSegments = [
        { label: 'Active', value: userStatusStats.Active, color: '#2563eb' },
        { label: 'Inactive', value: userStatusStats.Inactive, color: '#cbd5e1' },
      ];
      return (
        <ModulePanel
          description="Create and manage user accounts — Admin, Custodian, and Maintenance Personnel."
          statCards={
            <div className="user-analytics-grid">
              <div className="panel user-analytics-card">
                <h4 className="user-analytics-title">Users by Status</h4>
                <div className="dashboard-condition-core">
                  <div className="dashboard-condition-donut">
                    <DonutChart centerLabel={userStatusStats.total} centerSubLabel="Users" segments={userStatusSegments} />
                  </div>
                  <ChartLegend rows={userStatusSegments} />
                </div>
              </div>
              <div className="panel user-analytics-card">
                <h4 className="user-analytics-title">Users by Role</h4>
                <SegmentedBar segments={userRoleSegments} />
                <ChartLegend rows={userRoleSegments} />
              </div>
            </div>
          }
          filterBar={
            <div className="filter-bar-container">
              <div className="filter-label"><span>Filters:</span></div>
              <div className="filter-date-group">
                <span>Role</span>
                <MultiSelectDropdown
                  placeholder="All Roles"
                  options={['Admin', 'Custodian', 'Maintenance Personnel']}
                  selected={filterStatus}
                  onChange={setFilterStatus}
                />
              </div>
              <div className="filter-date-group">
                <span>Status</span>
                <MultiSelectDropdown
                  placeholder="All Statuses"
                  options={['Active', 'Inactive']}
                  selected={filterActive}
                  onChange={setFilterActive}
                />
              </div>
            </div>
          }
        >
          {hasRole(user, 'Admin') && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', marginBottom: 14, border: '1px solid var(--border-subtle, #e2e8f0)', borderRadius: 8 }}>
              <div>
                <strong style={{ display: 'block', fontSize: '0.8rem' }}>Staff Registration Code</strong>
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  Share this with real staff — they need it to register. Regenerating it locks out anyone who only has the old one.
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <code style={{ fontSize: '0.95rem', fontWeight: 700, padding: '6px 12px', background: 'var(--surface-2, #f8fafc)', borderRadius: 6 }}>
                  {registrationCode ?? '…'}
                </code>
                <button className="ghost-button" type="button" onClick={regenerateRegistrationCode}>Regenerate</button>
              </div>
            </div>
          )}
          <div className="panel-header-bar">
            <h3>Users <span className="count-badge">{visibleRows.length}</span></h3>
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search users..."
              columnChooser={usersViewMode === 'card' ? undefined : userColumnChooser}
              onAdd={() => navigate(`${roleRoutes[user.role]}/users/new`)}
              addLabel="Add User"
              onExport={() => exportRowsToCsv('users.csv', USER_EXPORT_COLUMNS, visibleRows)}
            />
          </div>
          <div className="view-tabs">
            <button type="button" className={usersViewMode === 'list' ? 'active' : ''} onClick={() => setUsersViewMode('list')}>List View</button>
            <button type="button" className={usersViewMode === 'card' ? 'active' : ''} onClick={() => setUsersViewMode('card')}>Card View</button>
          </div>
          {usersViewMode === 'card' ? (
            <PaginatedCardGrid
              items={visibleRows}
              keyOf={(row) => row.id}
              emptyMessage="No user accounts yet — click the + button to create one."
              renderItem={(row) => (
                <UserCard user={row} onClick={() => navigate(`${roleRoutes[user.role]}/users/${row.id}/edit`)} />
              )}
            />
          ) : (
            <PaginatedTable
              columns={userColumnChooser.visibleColumns}
              onReorderColumn={userColumnChooser.reorderColumn}
              emptyMessage="No user accounts yet — click the + button to create one."
              rows={visibleRows}
            />
          )}
        </ModulePanel>
      );
    }

    if (activeModule === 'locations') {
      return (
        <>
          <ModulePanel description="Record current vehicle stationing and keep a location history.">
            {locationsTab === 'map' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
                <div className="map-container-full">
                  <LocationDensityMap
                    selectedVehicleId={selectedMapVehicleId}
                    vehicles={lookups.vehicles ?? []}
                    onClearSelectedVehicle={() => setSelectedMapVehicleId(null)}
                    onHubsChange={setAllHubs}
                    canManageHubs={hasRole(user, 'Admin')}
                    boundaryOverride={mapBoundaryOverride}
                    onAddHub={() => navigate(`${roleRoutes[user.role]}/locations/new`)}
                  />
                </div>
              </div>
            )}

          </ModulePanel>
        </>
      );
    }

    if (activeModule === 'schedules') {
      // A mechanic's own assignments surface first — the shared list still
      // shows everyone's schedules for context, but their own work isn't
      // buried in it. Computed once so the table and card views can't drift
      // into showing different orderings.
      const scheduleRows = (!hasRole(user, 'Admin') && hasRole(user, 'Maintenance Personnel'))
        ? [...visibleRows].sort((a, b) => {
            const aMine = String(a.assigned_to) === String(user.id) ? 0 : 1;
            const bMine = String(b.assigned_to) === String(user.id) ? 0 : 1;
            return aMine - bMine;
          })
        : visibleRows;

      return (
        <ModulePanel
          description="Plan preventative maintenance and track schedule status."
          statCards={
            <ModuleStatCards
              totalLabel="Total Schedules"
              total={scheduleStats.total}
              cards={(hasRole(user, 'Maintenance Personnel') && !hasRole(user, 'Admin')) ? [...SCHEDULE_STAT_CARDS, MY_ASSIGNED_SCHEDULE_CARD] : SCHEDULE_STAT_CARDS}
              counts={scheduleStats}
              activeFilter={filterStatus}
              onFilterChange={setFilterStatus}
              gridClassName="schedule-stat-grid"
            />
          }
          filterBar={
            <FilterBar
              categories={lookups.categories}
              vehicles={lookups.vehicles}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterCapacity={filterCapacity}
              setFilterCapacity={setFilterCapacity}
              filterPriority={filterAssignedTo}
              setFilterPriority={setFilterAssignedTo}
              priorityOptions={(lookups.maintenance_personnel ?? []).map((p) => p.name)}
              priorityLabel="Mechanic"
              extraFilters={[{
                key: 'serviceLocation',
                label: 'Locations',
                options: [...new Set((records.schedules ?? []).map((r) => r.service_location).filter(Boolean))],
                selected: filterLocation,
                setSelected: setFilterLocation,
              }]}
            />
          }
        >
          <div className="panel-header-bar">
            <h3>Maintenance Schedules <span className="count-badge">{visibleRows.length}</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <ViewModeDropdown value={scheduleViewMode} onChange={changeScheduleViewMode} />
              {/* Custodian books directly (schedule.create) — they have the
                  day-to-day visibility into a vehicle's condition. Admin keeps
                  oversight (edit any/reassign/cancel) without originating one;
                  Maintenance Personnel never booked schedules directly. */}
              <LocalSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search schedules..."
                onAdd={canDo(user, 'schedule.create')
                  ? () => navigate(`${roleRoutes[user.role]}/schedules/new`)
                  : undefined}
                addLabel="Add Schedule"
                onExport={() => exportRowsToCsv('maintenance-schedules.csv', SCHEDULE_EXPORT_COLUMNS, visibleRows)}
                columnChooser={scheduleViewMode === 'card' ? undefined : scheduleColumnChooser}
              />
            </div>
          </div>
          {scheduleViewMode === 'card' ? (
            <PaginatedCardGrid
              items={scheduleRows}
              keyOf={(row) => row.schedule_id}
              emptyMessage="No maintenance scheduled — click the + button to plan one."
              renderItem={(row) => (
                <MaintenanceScheduleCard
                  row={row}
                  currentUser={user}
                  onComplete={openCompleteSchedule}
                  onEdit={(r) => navigate(`${roleRoutes[user.role]}/schedules/${r.schedule_id}/edit`)}
                  onDelete={(r) => deleteRecord(`/maintenance-schedules/${r.schedule_id}`, 'Schedule cancelled.', `Cancel the ${r.maintenance_type} schedule for ${r.vehicle?.vehicle_name ?? 'this vehicle'}? It can be restored later if needed.`)}
                  onRestore={(r) => restoreRecord(`/maintenance-schedules/${r.schedule_id}/restore`, 'Schedule restored.', 'Restore this cancelled schedule back to Scheduled?')}
                  onViewRecord={(r) => navigate(`${roleRoutes[user.role]}/maintenance/${r.resulting_maintenance_id}`)}
                  onReassign={setReassignScheduleTarget}
                  onViewTicket={openTicketProfile}
                />
              )}
            />
          ) : (
            <PaginatedTable
              columns={scheduleColumnChooser.visibleColumns}
              onReorderColumn={scheduleColumnChooser.reorderColumn}
              emptyMessage="No maintenance scheduled — click the + button to plan one."
              rows={scheduleRows}
              onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
            />
          )}

          {renderCompleteScheduleModal()}
          {renderReassignScheduleModal()}
        </ModulePanel>
      );
    }

    if (activeModule === 'reports') {
      return (
        <ModulePanel description="Pick a report below, then narrow it down with the filters that apply to it.">
          <div className="panel-header-bar">
            <h3>Reports</h3>
          </div>
          <ReportsModule lookups={lookups} onGenerate={submitModuleForm} />
          {report && <ReportPreview report={report} />}
        </ModulePanel>
      );
    }

    if (activeModule === 'logs') {
      return (
        <ModulePanel description="Read-only accountability log of user actions.">
          <div className="panel-header-bar">
            <h3>Activity Log <span className="count-badge">{visibleRows.length}</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <GenerateReportButton rows={visibleRows} />
              <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search logs..." columnChooser={logsView === 'list' ? logColumnChooser : undefined} />
            </div>
          </div>
          <div className="view-tabs">
            <button type="button" className={logsView === 'list' ? 'active' : ''} onClick={() => setLogsView('list')}>List View</button>
            <button type="button" className={logsView === 'recent' ? 'active' : ''} onClick={() => setLogsView('recent')}>Recent Activities</button>
          </div>
          {logsView === 'list' ? (
            <PaginatedTable columns={logColumnChooser.visibleColumns} onReorderColumn={logColumnChooser.reorderColumn} rows={visibleRows} emptyMessage="No activity logged yet." />
          ) : (
            <ActivityTimeline rows={visibleRows} />
          )}
        </ModulePanel>
      );
    }

    // ── TICKET WORKFLOW MODULES ─────────────────────────────────────────

    // Phase 1 + 4 Tier 2: Admin ticket management
    if (activeModule === 'tickets') {
      return (
        <TicketModule
          tickets={visibleRows}
          allTickets={rawRows}
          ticketLookups={ticketLookups}
          notifications={notifications}
          onViewTicket={openTicketProfile}
          onCreateNew={canDo(user, 'ticket.create') ? () => navigate(`${roleRoutes[user.role]}/tickets/new`) : undefined}
          onViewArchives={canDo(user, 'ticket.view_archives') ? () => setActiveModule('ticketArchives') : undefined}
          notice={notice}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          categories={lookups.categories}
          vehicles={lookups.vehicles}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterCapacity={filterCapacity}
          setFilterCapacity={setFilterCapacity}
          filterVehicle={filterVehicle}
          setFilterVehicle={setFilterVehicle}
          filterMechanic={filterMechanic}
          setFilterMechanic={setFilterMechanic}
          filterCustodian={filterCustodian}
          setFilterCustodian={setFilterCustodian}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
          filterPriority={filterPriority}
          setFilterPriority={setFilterPriority}
          filterDateStart={filterDateStart}
          setFilterDateStart={setFilterDateStart}
          filterDateEnd={filterDateEnd}
          setFilterDateEnd={setFilterDateEnd}
        />
      );
    }

    // Phase 5: Admin archive view
    // Phase 4 Tier 1: Custodian — verify completed repairs
    if (activeModule === 'ticketVerifications') {
      return (
          <CustodianVerificationModule
            tabBar={myTasksTabBar}
            user={user}
            tickets={visibleRows}
            editTarget={editTarget}
            setEditTarget={setEditTarget}
            onVerify={(subIssueRow, payload) => ticketAction(`/tickets/${subIssueRow.ticket_id}/sub-issues/${subIssueRow.sub_issue_id}/verify`, payload, 'Repair verification submitted.')}
            onCancelEdit={() => setEditTarget(null)}
            categories={lookups.categories}
            vehicles={lookups.vehicles}
            filterCategory={filterCategory}
            setFilterCategory={setFilterCategory}
            filterCapacity={filterCapacity}
            setFilterCapacity={setFilterCapacity}
            filterPriority={filterPriority}
            setFilterPriority={setFilterPriority}
            mechanicOptions={(lookups.maintenance_personnel ?? []).map((p) => p.name)}
            filterVerdict={filterVerdict}
            setFilterVerdict={setFilterVerdict}
            onViewVehicle={openVehicleProfile}
            stats={verificationStats}
            activeFilter={filterStatus}
            onFilterChange={setFilterStatus}
          />
      );
    }

    // Phase 3: Mechanic — view work orders and log repairs
    if (activeModule === 'ticketWorkOrders') {
      return (
        <>
          <MechanicWorkOrderModule
            tickets={visibleRows}
            onViewTicket={openTicketProfile}
            categories={lookups.categories}
            vehicles={lookups.vehicles}
            filterCategory={filterCategory}
            setFilterCategory={setFilterCategory}
            filterCapacity={filterCapacity}
            setFilterCapacity={setFilterCapacity}
            filterPriority={filterPriority}
            setFilterPriority={setFilterPriority}
            maintTypeOptions={lookups.maintenance_types}
            onViewVehicle={openVehicleProfile}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            stats={workOrderStats}
            activeFilter={filterStatus}
            onFilterChange={setFilterStatus}
            // Phase B4 — Maintenance Personnel's Condition Monitoring and
            // standalone Maintenance Schedule sidebar entries were removed;
            // their assigned schedules surface here instead, as a second
            // section on the same page (see loadModule's mySchedules fetch).
            mySchedules={hasRole(user, 'Maintenance Personnel') ? (records.mySchedules ?? []) : null}
            onCompleteSchedule={openCompleteSchedule}
            currentUser={user}
          />
          {renderCompleteScheduleModal()}
        </>
      );
    }

    // Cross-phase outcome feed — "vehicles I've worked on and where they stand
    // now" — so Custodians/Mechanics see verdicts (Approved/Rejected/Confirmed/
    // Reopened) without hunting for the ticket or relying on a notification.
    if (activeModule === 'workTracker') {
      return (
          <WorkTrackerModule
            tabBar={myTasksTabBar}
            tickets={records.workTracker ?? []}
            user={user}
            categories={lookups.categories}
            vehicles={lookups.vehicles}
            onViewTicket={openTicketProfile}
          />
      );
    }

    return null;
  }
}

// Maps an Action Queue item's type to where clicking it should go, and what
// it should look like — one place to keep type/icon/route in sync.
const ACTION_QUEUE_META = {
  ticket_proposal:         { icon: 'clipboard',   color: '#2563eb', route: (basePath, id) => `${basePath}/tickets/${id}` },
  subissue_needs_mechanic: { icon: 'wrench',      color: '#7c3aed', route: (basePath, id) => `${basePath}/tickets/${id}` },
  recurring_fault_review:  { icon: 'undo',        color: '#c2410c', route: (basePath, id) => `${basePath}/tickets/${id}` },
  readiness_check:         { icon: 'search',      color: '#0369a1', route: (basePath, id) => `${basePath}/vehicles/${id}` },
  schedule_overdue:        { icon: 'wrench',      color: '#b91c1c', route: null },
};
function ActionQueueRow({ item, basePath, onNavigate, onGoToSchedules }) {
  const meta = ACTION_QUEUE_META[item.type] ?? ACTION_QUEUE_META.ticket_proposal;
  const goTo = () => (meta.route ? onNavigate(meta.route(basePath, item.id)) : onGoToSchedules());
  return (
    <button
      type="button"
      onClick={goTo}
      className="action-queue-row"
      style={{ '--aq-color': meta.color }}
    >
      <span className="action-queue-row-icon"><Icon name={meta.icon} size={15} /></span>
      <span className="action-queue-row-body">
        <span className="action-queue-row-label">{item.label}</span>
        {item.vehicle_name && <span className="action-queue-row-vehicle">{item.vehicle_name}</span>}
      </span>
      {item.severity && <span className="action-queue-row-severity">{item.severity}</span>}
      <Icon name="chevronRight" size={14} className="action-queue-row-chevron" />
    </button>
  );
}

// A mechanic's personal task list — the counterpart to the Admin's Action
// Queue, but scoped to "what's assigned to ME" instead of "what needs an
// Admin decision". Same visual language (reuses .action-queue-* styles) so
// it reads as part of the same "here's what to do" pattern on the dashboard.
function MyScheduledWorkRow({ item, onClick }) {
  const overdue = isScheduleOverdue(item);
  return (
    <button
      type="button"
      onClick={onClick}
      className="action-queue-row"
      style={{ '--aq-color': overdue ? '#b91c1c' : '#0369a1' }}
    >
      <span className="action-queue-row-icon"><Icon name="wrench" size={15} /></span>
      <span className="action-queue-row-body">
        <span className="action-queue-row-label">{item.maintenance_type}</span>
        {item.vehicle && <span className="action-queue-row-vehicle">{item.vehicle.vehicle_name}</span>}
      </span>
      <span className="action-queue-row-severity">{overdue ? 'OVERDUE' : item.scheduled_date}</span>
      <Icon name="chevronRight" size={14} className="action-queue-row-chevron" />
    </button>
  );
}

// A compact "tap to see everything" tile — Action Queue, Emergency
// Readiness, and Risk & Readiness Watch used to each be a full list
// permanently on the dashboard; now they're one glance-able number that
// opens the full list in a popup instead of claiming that much vertical
// space all the time.
function DashboardQuickCard({ icon, title, stat, tone, preview, onClick }) {
  return (
    <button type="button" className="dashboard-quick-card" onClick={onClick}>
      <div className="dashboard-quick-card-head">
        <span className="dashboard-quick-card-icon"><Icon name={icon} size={16} /></span>
        <span className="dashboard-quick-card-title">{title}</span>
        <Icon name="chevronRight" size={14} className="dashboard-quick-card-chevron" />
      </div>
      <strong className={`dashboard-quick-card-stat${tone ? ` is-${tone}` : ''}`}>{stat}</strong>
      {preview && <span className="dashboard-quick-card-preview">{preview}</span>}
    </button>
  );
}

// Lightweight read-only popup — no form/notice machinery like FormModal,
// just the same modal-overlay/modal-box chrome so it looks consistent with
// every other modal in the app.
function DashboardListModal({ title, tag, onClose, children }) {
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        {tag && <div className="dashboard-list-modal-tag">{tag}</div>}
        <div className="modal-body dashboard-list-modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

// Shared row for both the Emergency Readiness modal and the compact
// "Readiness by Vehicle Type" dashboard panel — a status dot + fill bar so
// which categories are covered is readable at a glance, not just from text.
function ReadinessRow({ r }) {
  const verifiedReady = typeof r.verified_ready === 'number' ? r.verified_ready : r.ready;
  const unverified = r.ready - verifiedReady;
  const state = verifiedReady > 0 ? 'ready' : r.ready > 0 ? 'unverified' : 'none';
  const pct = r.total > 0 ? Math.max(4, Math.round((verifiedReady / r.total) * 100)) : 0;

  return (
    <div className={`emergency-readiness-row is-${state}`}>
      <span className={`emergency-readiness-row-dot is-${state}`} />
      <div className="emergency-readiness-row-main">
        <span className="emergency-readiness-row-name">{r.category}</span>
        <span className="emergency-readiness-row-detail">
          {r.ready} available
          {unverified > 0 && <> · <span className="emergency-readiness-row-unverified">{unverified} unverified</span></>}
        </span>
      </div>
      <div className="emergency-readiness-row-stat">
        <span className={`emergency-readiness-row-tag${verifiedReady > 0 ? ' is-ready' : ''}`}>
          {verifiedReady}/{r.total} READY
        </span>
        <span className="emergency-readiness-row-bar">
          <span className={`emergency-readiness-row-bar-fill is-${state}`} style={{ width: `${pct}%` }} />
        </span>
      </div>
    </div>
  );
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function DashboardMicroMetric({ icon, label, value, tone = 'neutral', onClick }) {
  const content = (
    <>
      <span><Icon name={icon} size={15} /></span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`dashboard-micro-metric is-${tone} is-clickable`} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={`dashboard-micro-metric is-${tone}`}>{content}</div>;
}

function DashboardSignalCard({ icon, label, value, detail, tone = 'neutral', meter = 0, onClick }) {
  const content = (
    <>
      <div className="dashboard-signal-card-head">
        <span className="dashboard-signal-card-icon"><Icon name={icon} size={16} /></span>
        <span>{label}</span>
        {onClick && <Icon name="chevronRight" size={14} className="dashboard-signal-card-chevron" />}
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
      <span className="dashboard-signal-meter" aria-hidden="true">
        <span style={{ width: `${clampPercent(meter)}%` }} />
      </span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`dashboard-signal-card is-${tone}`} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <article className={`dashboard-signal-card is-${tone}`}>{content}</article>;
}

function DashboardStatusStrip({ rows }) {
  return (
    <div className="dashboard-status-strip">
      {rows.map((row) => (
        <div key={row.label} style={{ '--strip-color': row.color }}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}

function Dashboard({ data, hubs = null, user, basePath, onNavigate, onGoToSchedules, onGoToModule }) {
  const [weather, setWeather] = useState(null);
  const [greeting, setGreeting] = useState(() => buildLocalGreeting(user?.name));
  const [greetingRole, setGreetingRole] = useState(() => dashboardRoleLabel(user?.role));
  const [now, setNow] = useState(() => new Date());
  // Dashboard = summary, not the complete list — Action Queue, Emergency
  // Readiness, and Risk & Readiness Watch each collapse to one glance-able
  // card; tapping one opens its full list in a popup instead of the list
  // living permanently on the page. null = no modal open.
  const [openDashboardModal, setOpenDashboardModal] = useState(null);

  useEffect(() => {
    // Displayed time is minute-precision (no seconds), so a 1s tick would
    // just be wasted re-renders — once a minute is enough to stay current.
    const interval = setInterval(() => setNow(new Date()), 60000);

    // Fetch Mandaue City, Cebu, Philippines (10.3446, 123.9392) weather
    fetch('https://api.open-meteo.com/v1/forecast?latitude=10.3446&longitude=123.9392&current=temperature_2m,relative_humidity_2m,weather_code')
      .then((res) => res.json())
      .then((resData) => {
        if (resData && resData.current) {
          const temp = Math.round(resData.current.temperature_2m);
          const code = resData.current.weather_code;
          const humidity = resData.current.relative_humidity_2m;
          
          let desc = 'Sunny';
          let icon = '☀️';
          
          if (code === 0) { desc = 'Clear Sky'; icon = '☀️'; }
          else if ([1, 2, 3].includes(code)) { desc = 'Partly Cloudy'; icon = '⛅'; }
          else if ([45, 48].includes(code)) { desc = 'Foggy'; icon = '🌫️'; }
          else if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) { desc = 'Rainy'; icon = '🌧️'; }
          else if ([95, 96, 99].includes(code)) { desc = 'Thunderstorm'; icon = '⛈️'; }
          
          setWeather({ temp, desc, icon, humidity });
        }
      })
      .catch(() => {
        setWeather({ temp: 33, desc: 'Partly Cloudy', icon: '⛅', humidity: 68 });
      });

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadGreeting = async () => {
      try {
        const response = await api.get('/greeting');
        if (!cancelled) {
          setGreeting(response.data.greeting ?? buildLocalGreeting(user?.name));
          setGreetingRole(response.data.role_label ?? dashboardRoleLabel(user?.role));
        }
      } catch {
        if (!cancelled) {
          setGreeting(buildLocalGreeting(user?.name));
          setGreetingRole(dashboardRoleLabel(user?.role));
        }
      }
    };

    loadGreeting();
    const interval = setInterval(loadGreeting, 60000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.name, user?.role]);

  if (!data) {
    return <p className="empty-state">No dashboard data available yet.</p>;
  }

  const metricValue = (label) => dashboardMetricValue(data.metrics, label);
  const totalVehicles = metricValue('Total Vehicles');
  const availableVehicles = metricValue('Available Vehicles');
  const underMaintenanceVehicles = metricValue('Vehicles Under Maintenance');
  const inactiveVehicles = metricValue('Inactive Vehicles');
  const reportedIssues = data.badge_counts?.ticketProposals ?? 0; // proposals waiting for review
  const upcomingMaintenance = metricValue('Upcoming Maintenance');
  const overdueMaintenanceCount = metricValue('Overdue Maintenance');
  const maintenanceExpenses = data.metrics.find((metric) => metric.label === 'Total Maintenance Expenses')?.value ?? '0';

  // Re-group raw location rows into the same hubs the map shows, so the
  // "Vehicles by Location" chart always matches the map's pins.
  const locationsByHub = groupLocationRowsByHub(data.vehicles_by_location ?? [], hubs);

  // Availability Forecast — vehicles currently out and when they're due back.
  const forecast = data.availability_forecast ?? { available_now: availableVehicles, under_maintenance: [] };
  const forecastOut = forecast.under_maintenance ?? [];
  const overdueSchedules = data.overdue_schedules ?? [];

  // Gap 1 — readiness/coverage by vehicle type; Gap 2 — preventive watch.
  const readiness = data.readiness ?? [];
  const noCoverage = readiness.filter((r) => r.no_coverage);
  const fleetSummary = data.fleet_readiness_summary ?? null;
  const preventiveWatch = data.preventive_watch ?? [];
  // Gap A — readiness watch; Gap B — fragility; Gap C — failure patterns.
  const readinessWatch = data.readiness_watch ?? [];
  const criticalityWatch = data.criticality_watch ?? [];
  // Final feature pass — Fleet Capability & Readiness Impact: the same
  // signals above, rolled up to "which emergency capability is at risk?".
  const capabilityImpact = data.capability_impact ?? [];
  const fragility = data.fragility ?? [];
  const failurePatterns = data.failure_patterns ?? [];
  const showBreakingMost = hasRole(user, 'Admin') && failurePatterns.length > 0;

  // Action Queue — everything currently waiting on an Admin decision,
  // ranked and pulled from across the whole system, so the dashboard
  // answers "what do I do right now" instead of just "what's currently
  // true". Admin-only (the backend already returns [] for other roles).
  const actionQueue = data.action_queue ?? [];
  const criticalActionCount = actionQueue.filter((item) => item.severity === 'Critical').length;

  // My Scheduled Work — a mechanic's own assigned schedules, surfaced right
  // on their dashboard instead of only living in the shared schedule table.
  const myScheduledWork = data.my_scheduled_work ?? [];

  // Fleet health (Good/Needs Inspection/Needs Repair) — a different
  // signal than Available/Under Maintenance/Inactive, which already have
  // their own KPI tiles just below this card, so this donut wouldn't just
  // be re-drawing the same three numbers. Colors match the same condition
  // badges used everywhere else (Condition Monitoring's stat cards, etc).
  const vehicleCondition = (data.vehicles_by_condition ?? []).map((row) => ({
    label: row.label,
    value: row.value,
    color: CONDITION_STAT_CARDS.find((c) => c.key === row.label)?.color ?? '#94a3b8',
  }));
  const goodConditionCount = vehicleCondition.find((c) => c.label === 'Good')?.value ?? 0;
  const goodConditionRate = totalVehicles ? Math.round((goodConditionCount / totalVehicles) * 100) : 0;

  const operationalTotal = fleetSummary?.operational_total ?? totalVehicles;
  const verifiedReady = fleetSummary?.verified_ready ?? Math.max(0, availableVehicles - readinessWatch.length);
  const readinessRate = operationalTotal ? clampPercent((verifiedReady / operationalTotal) * 100) : 0;
  const atRiskCount = noCoverage.length + readinessWatch.length + fragility.length + forecastOut.length + preventiveWatch.length + overdueMaintenanceCount;
  const notReadyVehicles = Math.max(0, totalVehicles - availableVehicles);
  const opsTone = notReadyVehicles === 0 ? 'ok' : availableVehicles === 0 ? 'alert' : 'warn';
  const maintenanceLoad = underMaintenanceVehicles + upcomingMaintenance + overdueMaintenanceCount;
  const statusSegments = [
    { label: 'Available', value: availableVehicles, color: '#16a34a' },
    { label: 'In shop', value: underMaintenanceVehicles, color: '#d97706' },
    { label: 'Inactive', value: inactiveVehicles, color: '#64748b' },
  ];
  const operationsQueue = [
    { label: 'Proposals', value: reportedIssues, color: '#ef4444' },
    { label: 'Upcoming', value: upcomingMaintenance, color: '#f59e0b' },
    { label: 'Overdue', value: overdueMaintenanceCount, color: '#dc2626' },
    { label: 'Ready', value: availableVehicles, color: '#22c55e' },
  ];
  const topFailurePattern = failurePatterns[0];
  const visibleReadiness = readiness.slice(0, 5);
  const visibleLocationRows = locationsByHub.slice(0, 4);
  const visibleTypeRows = (data.vehicles_by_type ?? []).slice(0, 5);
  const isAdminDashboard = hasRole(user, 'Admin');
  const isMaintenanceDashboard = hasRole(user, 'Maintenance Personnel') && !isAdminDashboard;
  // Phase A4 — one departure away from an orphaned barangay (nobody left
  // who can manage users, vehicles, or approvals). GuardsLastAdmin blocks
  // that departure from happening through deactivate/role-change, but not
  // e.g. this Admin simply leaving with no successor ever promoted — this
  // is the "before it happens" half of that protection.
  const primaryActionCount = isAdminDashboard
    ? actionQueue.length
    : isMaintenanceDashboard
      ? myScheduledWork.length
      : reportedIssues;
  const primaryActionLabel = isAdminDashboard
    ? (actionQueue[0]?.label ?? 'No urgent action')
    : isMaintenanceDashboard
      ? (myScheduledWork[0]?.maintenance_type ?? 'Nothing assigned')
      : 'Nothing waiting on you';
  const primaryActionTitle = isAdminDashboard ? 'Action Queue' : isMaintenanceDashboard ? 'My Work' : 'My Tasks';
  const primaryActionIcon = isMaintenanceDashboard ? 'wrench' : reportedIssues > 0 ? 'alert' : 'checkCircle';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Custodian / Maintenance Personnel get their own, leaner dashboard: their
  // own queues first, then only the fleet context their job actually uses.
  // The fleet-wide analytics (expenses, risk watch, sites/types, maintenance
  // load) are Admin's — the backend doesn't even send those numbers to these
  // roles, so they used to render as misleading zeroes.
  if (!isAdminDashboard) {
    const badges = data.badge_counts ?? {};
    const isCustodianView = hasRole(user, 'Custodian');
    const needsCheck = readinessWatch.slice(0, 5);
    const toneFor = (n, hot = 'warn') => (n > 0 ? hot : 'ok');
    const quick = [];
    if (isCustodianView) {
      quick.push(
        { icon: 'checkCircle', label: 'To Verify', value: badges.ticketVerifications ?? 0, go: () => onGoToModule('ticketVerifications', []) },
        { icon: 'alert', label: 'Needs Attention', value: metricValue('Vehicles Needing Attention'), go: () => onGoToModule('vehicles', []) },
      );
    }
    if (isMaintenanceDashboard) {
      quick.push(
        { icon: 'wrench', label: 'Work Orders', value: badges.ticketWorkOrders ?? 0, go: () => onGoToModule('ticketWorkOrders', []) },
        { icon: 'calendar', label: 'My Schedule', value: myScheduledWork.length, go: onGoToSchedules },
        { icon: 'alert', label: 'Needs Attention', value: metricValue('Vehicles Needing Attention'), go: () => onGoToModule('vehicles', []) },
      );
    }

    return (
      <div className="dashboard-grid dashboard-grid-smart">
        <section className={`dashboard-command-center full-span is-${opsTone}`}>
          <div className="dashboard-command-copy">
            <span className="dashboard-command-role">{greetingRole}</span>
            <TextType
              key={greeting}
              as="h2"
              text={[greeting]}
              typingSpeed={150}
              pauseDuration={1500}
              loop={false}
              showCursor={true}
              cursorCharacter="|"
            />
            <p>{dateStr || 'Today'}</p>
          </div>

          <div className="dashboard-ready-split">
            <div className="dashboard-ready-stat" style={{ '--ready-pct': `${totalVehicles ? (availableVehicles / totalVehicles) * 100 : 0}%` }}>
              <span className="dashboard-hologram-scan" />
              <div className="dashboard-ready-stat-inner">
                <div className="dashboard-ready-row is-ready">
                  <strong>{availableVehicles}</strong>
                  <span>Ready</span>
                </div>
                <div className="dashboard-ready-row is-not-ready">
                  <strong>{notReadyVehicles}</strong>
                  <span>Not Ready</span>
                </div>
              </div>
            </div>
          </div>

          <div className="dashboard-command-side">
            <div className="dashboard-live-chips">
              <div>
                <span>Local time</span>
                <strong>{timeStr}</strong>
              </div>
              {weather && (
                <div>
                  <span>Mandaue City, Cebu</span>
                  <strong><span className="dashboard-weather-mark">{weather.icon}</span>{weather.temp}C</strong>
                  <small>{weather.desc} / {weather.humidity}% humidity</small>
                </div>
              )}
            </div>
            <div className="dashboard-command-mini-grid">
              {quick.slice(0, 4).map((q) => (
                <DashboardMicroMetric key={q.label} icon={q.icon} label={q.label} value={q.value} tone={toneFor(q.value)} onClick={q.go} />
              ))}
            </div>
          </div>
        </section>

        {isMaintenanceDashboard && (
          <section className="panel col-span-7 action-queue-panel dashboard-lean-panel">
            <div className="panel-header-bar">
              <h3><Icon name="wrench" size={16} /> My Scheduled Work</h3>
              {myScheduledWork.length > 0 && <span className="area-chart-tag">{myScheduledWork.length} assigned to you</span>}
            </div>
            {myScheduledWork.length === 0 ? (
              <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> Nothing scheduled for you right now.</p>
            ) : (
              <div className="action-queue-list action-queue-list-compact">
                {myScheduledWork.map((item) => (
                  <MyScheduledWorkRow key={item.schedule_id} item={item} onClick={onGoToSchedules} />
                ))}
              </div>
            )}
          </section>
        )}

        {isCustodianView && (
          <section className="panel col-span-7 dashboard-lean-panel">
            <div className="panel-header-bar">
              <h3><Icon name="checkCircle" size={16} /> Needs a Readiness Check</h3>
              {readinessWatch.length > 0 && <span className="area-chart-tag">{readinessWatch.length} vehicle{readinessWatch.length === 1 ? '' : 's'}</span>}
            </div>
            {needsCheck.length === 0 ? (
              <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> Every available vehicle has a current readiness check.</p>
            ) : (
              <div className="risk-watch-col">
                {needsCheck.map((r) => (
                  <button
                    key={r.vehicle_id}
                    type="button"
                    className={`risk-watch-item risk-watch-item-clickable${r.state === 'not_ready' ? ' is-critical' : ''}`}
                    onClick={() => onNavigate(`${basePath}/vehicles/${r.vehicle_id}`)}
                  >
                    <span className={`risk-watch-item-dot${r.state === 'not_ready' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{r.vehicle_name}</span>
                        <span className={`risk-watch-tag${r.state === 'not_ready' ? ' is-critical' : ''}`}>
                          {(READINESS_BADGE[r.state]?.label ?? r.state).toUpperCase()}
                        </span>
                      </span>
                      <span className="risk-watch-item-sub">{r.category ?? '—'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {readinessWatch.length > needsCheck.length && (
              <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.78rem' }}>+ {readinessWatch.length - needsCheck.length} more — open Vehicles to see them all.</p>
            )}
          </section>
        )}

        <CriticalityWatchCard items={criticalityWatch} onNavigate={onNavigate} basePath={basePath} />
        <CapabilityImpactCard items={capabilityImpact} onNavigate={onNavigate} basePath={basePath} />

        <section className="panel col-span-5 dashboard-lean-panel">
          <div className="panel-header-bar">
            <h3>Fleet Condition</h3>
            <span className="area-chart-tag">{goodConditionRate}% in good condition</span>
          </div>
          <div className="fleet-status-compact">
            <div className="donut-chart-small">
              <DonutChart centerLabel={totalVehicles} centerSubLabel="Vehicles" segments={vehicleCondition} />
            </div>
            <div className="fleet-status-legend-col">
              <ChartLegend rows={vehicleCondition} />
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="dashboard-grid dashboard-grid-smart">
      <section className={`dashboard-command-center full-span is-${opsTone}`}>
        <div className="dashboard-command-copy">
          <span className="dashboard-command-role">{greetingRole}</span>
          <TextType
            key={greeting}
            as="h2"
            text={[greeting]}
            typingSpeed={150}
            pauseDuration={1500}
            loop={false}
            showCursor={true}
            cursorCharacter="|"
          />
          <p>{dateStr || 'Today'}</p>
          <div className="dashboard-command-pills">
            <button type="button" onClick={() => onGoToModule('vehicles', [])}>{totalVehicles} fleet units</button>
            <button type="button" onClick={() => onGoToModule('locations', [])}>{locationsByHub.length} active sites</button>
            <button type="button" onClick={() => onGoToModule('categories', [])}>{data.vehicles_by_type?.length ?? 0} vehicle types</button>
          </div>
        </div>

        <div className="dashboard-ready-split">
          <div className="dashboard-ready-stat" style={{ '--ready-pct': `${totalVehicles ? (availableVehicles / totalVehicles) * 100 : 0}%` }}>
            <span className="dashboard-hologram-scan" />
            <div className="dashboard-ready-stat-inner">
              <div className="dashboard-ready-row is-ready">
                <strong>{availableVehicles}</strong>
                <span>Ready</span>
              </div>
              <div className="dashboard-ready-row is-not-ready">
                <strong>{notReadyVehicles}</strong>
                <span>Not Ready</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-command-side">
          <div className="dashboard-live-chips">
            <div>
              <span>Local time</span>
              <strong>{timeStr}</strong>
            </div>
            {weather && (
              <div>
                <span>Mandaue City, Cebu</span>
                <strong><span className="dashboard-weather-mark">{weather.icon}</span>{weather.temp}C</strong>
                <small>{weather.desc} / {weather.humidity}% humidity</small>
              </div>
            )}
          </div>
          <div className="dashboard-command-mini-grid">
            <DashboardMicroMetric icon="vehicle" label="Available" value={availableVehicles} tone="ok" onClick={() => onGoToModule('vehicles', ['Available'])} />
            <DashboardMicroMetric icon="wrench" label="In Shop" value={underMaintenanceVehicles} tone="warn" onClick={() => onGoToModule('vehicles', ['Under Maintenance'])} />
            <DashboardMicroMetric icon="alert" label="Proposals" value={reportedIssues} tone={reportedIssues > 0 ? 'alert' : 'ok'} onClick={() => onGoToModule('tickets', [])} />
            <DashboardMicroMetric icon="calendar" label="Overdue" value={overdueMaintenanceCount} tone={overdueMaintenanceCount > 0 ? 'alert' : 'neutral'} onClick={onGoToSchedules} />
          </div>
        </div>
      </section>

      <section className="dashboard-signal-grid full-span" aria-label="Dashboard signals">
        <DashboardSignalCard
          icon={primaryActionIcon}
          label={primaryActionTitle}
          value={primaryActionCount === 0 ? 'Clear' : primaryActionCount}
          detail={primaryActionLabel}
          tone={criticalActionCount > 0 ? 'alert' : primaryActionCount > 0 ? 'warn' : 'ok'}
          meter={primaryActionCount > 0 ? Math.min(100, primaryActionCount * 18) : 100}
          onClick={isAdminDashboard ? () => setOpenDashboardModal('actionQueue') : undefined}
        />
        <DashboardSignalCard
          icon="checkCircle"
          label="Emergency Coverage"
          value={operationalTotal ? `${verifiedReady}/${operationalTotal}` : '0/0'}
          detail={noCoverage.length > 0 ? `No coverage: ${noCoverage.map((r) => r.category).join(', ')}` : `${readinessRate}% verified ready`}
          tone={noCoverage.length > 0 ? 'alert' : readinessRate >= 75 ? 'ok' : 'warn'}
          meter={readinessRate}
          onClick={readiness.length > 0 ? () => setOpenDashboardModal('emergencyReadiness') : undefined}
        />
        <DashboardSignalCard
          icon="flag"
          label="Risk Watch"
          value={atRiskCount === 0 ? 'Stable' : atRiskCount}
          detail={fragility.length > 0 ? `${fragility.length} no-backup categories` : `${readinessWatch.length} available but unverified`}
          tone={atRiskCount > 0 ? 'alert' : 'ok'}
          meter={atRiskCount > 0 ? Math.min(100, atRiskCount * 12) : 100}
          onClick={atRiskCount > 0 ? () => setOpenDashboardModal('riskWatch') : undefined}
        />
        <DashboardSignalCard
          icon="calendar"
          label="Maintenance Load"
          value={maintenanceLoad}
          detail={`${underMaintenanceVehicles} in shop / ${upcomingMaintenance} upcoming / ${overdueMaintenanceCount} overdue`}
          tone={overdueMaintenanceCount > 0 ? 'alert' : maintenanceLoad > 0 ? 'warn' : 'ok'}
          meter={totalVehicles ? Math.min(100, (maintenanceLoad / Math.max(totalVehicles, 1)) * 100) : 0}
          onClick={onGoToSchedules}
        />
      </section>

      <section className="dashboard-intelligence-grid full-span">
        <article className="dashboard-smart-panel dashboard-readiness-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Response Matrix</span>
              <h3>Readiness by Vehicle Type</h3>
            </div>
            <strong>{readinessRate}%</strong>
          </div>
          {readiness.length === 0 ? (
            <p className="empty-state">No vehicle types to show yet.</p>
          ) : (
            <div className="dashboard-readiness-compact-list">
              {visibleReadiness.map((r) => <ReadinessRow key={r.category} r={r} />)}
            </div>
          )}
          {readiness.length > visibleReadiness.length && (
            <button type="button" className="dashboard-inline-action" onClick={() => setOpenDashboardModal('emergencyReadiness')}>
              View all {readiness.length} types
            </button>
          )}
        </article>

        <article className="dashboard-smart-panel dashboard-condition-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Fleet Health</span>
              <h3>Condition and Status</h3>
            </div>
            <strong>{goodConditionRate}%</strong>
          </div>
          <div className="dashboard-condition-core">
            <div className="dashboard-condition-donut">
              <DonutChart centerLabel={totalVehicles} centerSubLabel="Vehicles" segments={vehicleCondition} />
            </div>
            <ChartLegend rows={vehicleCondition} />
          </div>
          <DashboardStatusStrip rows={statusSegments} />
        </article>

        <article className="dashboard-smart-panel dashboard-operations-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Operations Pulse</span>
              <h3>Workload Pressure</h3>
            </div>
            <strong>{maintenanceExpenses}</strong>
          </div>
          <ColumnChart rows={operationsQueue} />
          <p className="dashboard-panel-note">
            {topFailurePattern
              ? `${topFailurePattern.type} leads the last 12 months with ${topFailurePattern.count} case${topFailurePattern.count === 1 ? '' : 's'}.`
              : 'No recurring failure pattern logged yet.'}
          </p>
        </article>

        <article className="dashboard-smart-panel dashboard-distribution-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Fleet Distribution</span>
              <h3>Sites and Types</h3>
            </div>
            <strong>{totalVehicles}</strong>
          </div>
          <div className="dashboard-dual-bars">
            <div>
              <h4>Sites</h4>
              <HorizontalBarChart rows={visibleLocationRows} />
            </div>
            <div>
              <h4>Types</h4>
              <HorizontalBarChart rows={visibleTypeRows} />
            </div>
          </div>
        </article>
      </section>
      {/* SECTION 1: Welcome Header — compressed, and paired with Fleet
          Status instead of stretching full-width alone at the top. */}
      <div className="dashboard-banner dashboard-banner-compact col-span-7">
        <div className="dashboard-banner-welcome">
          <span className="dashboard-greeting-role">{greetingRole}</span>
          <TextType
            key={greeting}
            as="h2"
            text={[greeting]}
            typingSpeed={150}
            pauseDuration={1500}
            loop={false}
            showCursor={true}
            cursorCharacter="|"
          />
          <p>{dateStr || 'Today'}</p>
        </div>
        <div className="dashboard-banner-widgets">
          <div className="dashboard-banner-time">
            <span className="time-label">Local time</span>
            <strong>{timeStr}</strong>
          </div>
          {weather && (
            <div className="dashboard-banner-weather">
              <span className="weather-icon">{weather.icon}</span>
              <div className="weather-details">
                <span className="weather-city">Mandaue City, Cebu</span>
                <span className="weather-desc">{weather.desc}</span>
                <span className="weather-extra">Humidity: {weather.humidity}%</span>
              </div>
              <p className="weather-temp">{weather.temp}°C</p>
            </div>
          )}
        </div>
      </div>

      <section className="panel col-span-5 dashboard-fleet-status-panel">
        <div className="panel-header-bar">
          <h3>Fleet Condition</h3>
          <span className="area-chart-tag">{goodConditionRate}% in good condition</span>
        </div>
        <div className="fleet-status-compact">
          <div className="donut-chart-small">
            <DonutChart centerLabel={totalVehicles} centerSubLabel="Vehicles" segments={vehicleCondition} />
          </div>
          <div className="fleet-status-legend-col">
            {/* Verified-ready deliberately lives only in the Action Center's
                Emergency Readiness card below — it was previously repeated
                here, in an alert tile, in a quick card, and twice more in the
                Readiness section, so the same 0/7 read five times on one page. */}
            <ChartLegend rows={vehicleCondition} />
          </div>
        </div>
      </section>

      {/* SECTION 2 — Action Center: what needs a decision right now, placed
          directly under the banner instead of below eight KPI tiles, since
          "what do I do" outranks "what is currently true". This absorbs the
          old Critical Action / Emergency Ready alert strip, which showed
          these same two numbers one row higher in a different card style. */}
      {hasRole(user, 'Admin') && (
        <div className="dashboard-quick-cards full-span">
          <DashboardQuickCard
            icon="alert"
            title="Action Queue"
            stat={actionQueue.length === 0 ? 'All clear' : `${actionQueue.length} need${actionQueue.length === 1 ? 's' : ''} you`}
            tone={criticalActionCount > 0 ? 'alert' : actionQueue.length > 0 ? 'warn' : 'ok'}
            preview={criticalActionCount > 0
              ? `${criticalActionCount} critical · ${actionQueue[0]?.label ?? ''}`
              : actionQueue[0]?.label}
            onClick={() => setOpenDashboardModal('actionQueue')}
          />
          {readiness.length > 0 && (
            <DashboardQuickCard
              icon="checkCircle"
              title="Emergency Readiness"
              stat={fleetSummary ? `${fleetSummary.verified_ready}/${fleetSummary.operational_total} ready` : '—'}
              tone={fleetSummary?.coverage_alert ? 'alert' : fleetSummary && fleetSummary.verified_ready < fleetSummary.operational_total ? 'warn' : 'ok'}
              preview={noCoverage.length > 0
                ? `No coverage: ${noCoverage.map((r) => r.category).join(', ')}`
                : `Across ${readiness.length} vehicle type${readiness.length === 1 ? '' : 's'}`}
              onClick={() => setOpenDashboardModal('emergencyReadiness')}
            />
          )}
          {(fragility.length > 0 || readinessWatch.length > 0 || forecastOut.length > 0 || preventiveWatch.length > 0 || overdueSchedules.length > 0) && (
            <DashboardQuickCard
              icon="alert"
              title="Risk & Readiness Watch"
              stat={fragility.length > 0 ? `${fragility.length} single point${fragility.length === 1 ? '' : 's'} of failure` : `${readinessWatch.length} unverified`}
              tone={fragility.length > 0 ? 'alert' : 'warn'}
              preview={forecastOut.length > 0 ? `${forecastOut.length} vehicle${forecastOut.length === 1 ? '' : 's'} in the shop` : undefined}
              onClick={() => setOpenDashboardModal('riskWatch')}
            />
          )}
        </div>
      )}

      {/* SECTION 3 — Fleet KPIs. Every headline number in one consistent tile
          style, including the three "watch" counts (issues / upcoming /
          overdue) that used to sit right below in a third, slimmer card style
          for no reason other than to de-emphasise them. */}
      <section className="metric-grid dashboard-headline-grid full-span">
        {data.metrics.map((metric) => {
          const style = DASHBOARD_METRIC_STYLES[metric.label] ?? DASHBOARD_METRIC_STYLE_DEFAULT;

          return (
            <article
              className="metric-card metric-card-iconic dashboard-metric-card"
              key={metric.label}
            >
              <span className="metric-card-icon" style={{ background: style.bg, color: style.color }}>
                <Icon name={style.icon} size={16} />
              </span>
              <div className="metric-card-body">
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </div>
            </article>
          );
        })}
      </section>

      {hasRole(user, 'Maintenance Personnel') && (
        <section className="panel col-span-7 action-queue-panel">
          <div className="panel-header-bar">
            <h3><Icon name="wrench" size={16} /> My Scheduled Work</h3>
            {myScheduledWork.length > 0 && <span className="area-chart-tag">{myScheduledWork.length} assigned to you</span>}
          </div>
          {myScheduledWork.length === 0 ? (
            <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> Nothing scheduled for you right now.</p>
          ) : (
            <div className="action-queue-list action-queue-list-compact">
              {myScheduledWork.map((item) => (
                <MyScheduledWorkRow
                  key={item.schedule_id}
                  item={item}
                  onClick={onGoToSchedules}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {openDashboardModal === 'actionQueue' && (
        <DashboardListModal
          title="Action Queue"
          tag={actionQueue.length > 0 ? `${actionQueue.length} need${actionQueue.length === 1 ? 's' : ''} you` : undefined}
          onClose={() => setOpenDashboardModal(null)}
        >
          {actionQueue.length === 0 ? (
            <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> All clear — nothing needs your attention right now.</p>
          ) : (
            <div className="action-queue-list">
              {actionQueue.map((item) => (
                <ActionQueueRow
                  key={`${item.type}-${item.id}`}
                  item={item}
                  basePath={basePath}
                  onNavigate={(path) => { setOpenDashboardModal(null); onNavigate(path); }}
                  onGoToSchedules={() => { setOpenDashboardModal(null); onGoToSchedules(); }}
                />
              ))}
            </div>
          )}
        </DashboardListModal>
      )}

      {openDashboardModal === 'emergencyReadiness' && (
        <DashboardListModal
          title="Emergency Readiness"
          tag={fleetSummary ? `${fleetSummary.verified_ready} of ${fleetSummary.operational_total} verified ready` : undefined}
          onClose={() => setOpenDashboardModal(null)}
        >
          <div className="emergency-readiness-rows">
            {readiness.map((r) => <ReadinessRow key={r.category} r={r} />)}
          </div>
          {fragility.length > 0 && fragility.length === readiness.length && (
            <p className="emergency-readiness-note">
              <Icon name="alert" size={13} /> Every emergency type has exactly one vehicle — no backup if any of the {readiness.length} goes down. Verify all {readiness.length} to clear this panel.
            </p>
          )}
          {noCoverage.length > 0 && (
            <p className="emergency-readiness-alert"><Icon name="alert" size={13} /> No coverage: {noCoverage.map((r) => r.category).join(', ')}</p>
          )}
        </DashboardListModal>
      )}

      {openDashboardModal === 'riskWatch' && (
        <DashboardListModal
          title="Risk & Readiness Watch"
          tag={fragility.length > 0 ? `${fragility.length} single point${fragility.length === 1 ? '' : 's'} of failure` : undefined}
          onClose={() => setOpenDashboardModal(null)}
        >
          <div className="risk-watch-columns">
            {criticalityWatch.some((r) => r.criticality !== 'Normal') && (
              <div className="risk-watch-col">
                <h4>Critical &amp; high-priority vehicles not ready</h4>
                {criticalityWatch.filter((r) => r.criticality !== 'Normal').map((r) => (
                  <div key={r.vehicle_id} className={`risk-watch-item${r.criticality === 'Critical' ? ' is-critical' : ''}`}>
                    <span className={`risk-watch-item-dot${r.criticality === 'Critical' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{r.vehicle_name}</span>
                        <span className={`risk-watch-tag${r.criticality === 'Critical' ? ' is-critical' : ''}`}>{r.criticality.toUpperCase()}</span>
                      </span>
                      <span className="risk-watch-item-sub">{r.category ?? '—'} · {r.reason}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {fragility.length > 0 && (
              <div className="risk-watch-col">
                <h4>No backup if it goes down</h4>
                {fragility.map((f) => (
                  <div key={f.category} className={`risk-watch-item${f.critical ? ' is-critical' : ''}`}>
                    <span className={`risk-watch-item-dot${f.critical ? ' is-critical' : ''}`} />
                    Only 1 {f.category}
                  </div>
                ))}
              </div>
            )}
            {capabilityImpact.length > 0 && (
              <div className="risk-watch-col">
                <h4>Capability impact by type</h4>
                {capabilityImpact.map((row) => (
                  <button
                    key={row.category}
                    type="button"
                    className={`risk-watch-item risk-watch-item-clickable${row.criticality === 'Critical' ? ' is-critical' : ''}`}
                    onClick={() => { setOpenDashboardModal(null); onNavigate(`${basePath}/vehicles`); }}
                  >
                    <span className={`risk-watch-item-dot${row.criticality === 'Critical' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{row.category}</span>
                        <span className={`risk-watch-tag${row.coverage_state === 'NO_COVERAGE' ? ' is-critical' : ''}`}>
                          {CAPABILITY_STATE_LABEL[row.coverage_state] ?? row.coverage_state}
                        </span>
                      </span>
                      <span className="risk-watch-item-sub">{row.ready}/{row.total} ready · {row.primary_reason ?? 'Based on current records.'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {readinessWatch.length > 0 && (
              <div className="risk-watch-col">
                <h4>Available, not verified</h4>
                {readinessWatch.map((r) => (
                  <button
                    key={r.vehicle_id}
                    type="button"
                    className={`risk-watch-item risk-watch-item-clickable${r.state === 'not_ready' ? ' is-critical' : ''}`}
                    onClick={() => { setOpenDashboardModal(null); onNavigate(`${basePath}/vehicles/${r.vehicle_id}`); }}
                  >
                    <span className={`risk-watch-item-dot${r.state === 'not_ready' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{r.vehicle_name}</span>
                        <span className={`risk-watch-tag${r.state === 'not_ready' ? ' is-critical' : ''}`}>
                          {(READINESS_BADGE[r.state]?.label ?? r.state).toUpperCase()}
                        </span>
                      </span>
                      <span className="risk-watch-item-sub">{r.category ?? '—'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {forecastOut.length === 0 && preventiveWatch.length === 0 && overdueSchedules.length === 0 ? (
            <p className="risk-watch-footer-ok">
              <Icon name="checkCircle" size={13} /> All vehicles available — nothing out for maintenance.
              <span className="area-chart-tag">{forecast.available_now} ready</span>
            </p>
          ) : (
            <div className="risk-watch-footer-list">
              {forecastOut.map((v) => (
                <div key={v.vehicle_id} className="risk-watch-footer-row">
                  <span>{v.vehicle_name}</span>
                  <span>{v.estimated_return_date ? `Ready by ${formatForecastDate(v.estimated_return_date)}` : 'No estimate yet'}</span>
                </div>
              ))}
              {(preventiveWatch.length > 0 ? preventiveWatch : overdueSchedules).map((s) => (
                <div key={s.schedule_id} className="risk-watch-footer-row">
                  <span>{s.vehicle_name ?? s.vehicle?.vehicle_name ?? '—'} · {s.maintenance_type}</span>
                  <span className={(s.state ? s.state === 'overdue' : true) ? 'is-overdue' : ''}>
                    {(s.state ? s.state === 'overdue' : true) ? 'OVERDUE' : 'DUE SOON'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </DashboardListModal>
      )}

      {/* SECTION 4 — Can we respond, and why do vehicles keep going down?
          Readiness used to be a full-width band with a half-empty right
          side; pairing it with the failure-cause chart fills the row and
          puts the cause right next to the consequence. */}
      <section className="panel col-span-7">
        <div className="panel-header-bar">
          <h3><Icon name="checkCircle" size={16} /> Readiness by Vehicle Type</h3>
          {fleetSummary && (
            <span className="area-chart-tag">
              {fleetSummary.verified_ready} of {fleetSummary.operational_total} verified ready
            </span>
          )}
        </div>
        {readiness.length === 0 ? (
          <p className="empty-state">No vehicle types to show yet.</p>
        ) : (
          <div className="emergency-readiness-rows">
            {readiness.map((r) => <ReadinessRow key={r.category} r={r} />)}
          </div>
        )}
        {noCoverage.length > 0 && (
          <p className="emergency-readiness-alert">
            <Icon name="alert" size={13} /> No coverage: {noCoverage.map((r) => r.category).join(', ')}
          </p>
        )}
      </section>

      {showBreakingMost ? (
        <section className="panel col-span-5">
          <div className="panel-header-bar">
            <h3><Icon name="wrench" size={16} /> What's Breaking Most</h3>
            <span className="area-chart-tag">Last 12 months</span>
          </div>
          <div className="dashboard-panel-chart-body">
            <HorizontalBarChart rows={failurePatterns.map((p) => ({ label: p.type, value: p.count }))} />
            <p className="muted" style={{ marginTop: 8, fontSize: '0.78rem' }}>{failurePatterns[0]?.type ?? 'This'} affects {failurePatterns[0]?.count ?? 0} vehicles — a common cause worth fixing at the root.</p>
          </div>
        </section>
      ) : (
        <section className="panel col-span-5">
          <div className="panel-header-bar">
            <h3>Operations Queue</h3>
            <span className="area-chart-tag">{maintenanceExpenses}</span>
          </div>
          <div className="dashboard-panel-chart-body">
            <ColumnChart rows={operationsQueue} />
            <div className="graph-footnote">
              <span>Total maintenance expenses</span>
              <strong>{maintenanceExpenses}</strong>
            </div>
          </div>
        </section>
      )}

      {/* SECTION 5 — Fleet composition: where the vehicles are, and what
          kinds exist. Two halves of one question, so they share a row
          instead of stacking as two more full-width bands. */}
      <section className="panel col-span-6">
        <div className="panel-header-bar">
          <h3><Icon name="pin" size={16} /> Vehicles by Location</h3>
          <span className="area-chart-tag">{locationsByHub.length} sites</span>
        </div>
        <div className="dashboard-panel-chart-body">
          <HorizontalBarChart rows={locationsByHub} />
        </div>
      </section>

      <section className="panel col-span-6">
        <div className="panel-header-bar">
          <h3><Icon name="vehicle" size={16} /> Vehicles by Type</h3>
          <span className="area-chart-tag">{data.vehicles_by_type?.length ?? 0} types</span>
        </div>
        <div className="dashboard-panel-chart-body">
          <HorizontalBarChart rows={data.vehicles_by_type} />
        </div>
      </section>
    </div>
  );
}

// Formats a plain YYYY-MM-DD date for the Availability Forecast (e.g. "Jul 14, 2026").
function formatForecastDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildLocalGreeting(name = 'User', date = new Date()) {
  const displayName = firstName(name);
  const hour = date.getHours();

  if (hour >= 5 && hour < 12) {
    return randomGreeting([
      `Rise and shine, ${displayName}!`,
      `A bright morning to you, ${displayName}!`,
      `Fresh start, ${displayName}! Let's keep the fleet moving.`,
      `Morning momentum is here, ${displayName}!`,
    ]);
  }

  if (hour === 12) {
    return randomGreeting([
      `Happy noon, ${displayName}!`,
      `Midday check-in, ${displayName}! The fleet is ready.`,
      `It's noon, ${displayName}! Keep the day rolling.`,
      `A steady noon to you, ${displayName}!`,
    ]);
  }

  if (hour >= 13 && hour < 15) {
    return randomGreeting([
      `A pleasant afternoon, ${displayName}!`,
      `Good energy this afternoon, ${displayName}!`,
      `Afternoon focus is on, ${displayName}!`,
      `Keep the dashboard sharp this afternoon, ${displayName}!`,
    ]);
  }

  if (hour >= 15 && hour < 18) {
    return randomGreeting([
      `It's late afternoon, ${displayName}!`,
      `Late afternoon focus, ${displayName}!`,
      `A strong late afternoon to you, ${displayName}!`,
      `The day is still moving, ${displayName}!`,
    ]);
  }

  if (hour >= 18 && hour < 22) {
    return randomGreeting([
      `A calm evening to you, ${displayName}!`,
      `Evening check-in, ${displayName}! The fleet is in view.`,
      `Good evening, ${displayName}! Keep things steady.`,
      `The evening shift is looking sharp, ${displayName}!`,
    ]);
  }

  return randomGreeting([
    `Working late, ${displayName}? The dashboard is ready.`,
    `Quiet night watch, ${displayName}!`,
    `Late-night focus, ${displayName}!`,
    `The fleet rests easier with you here, ${displayName}!`,
  ]);
}

function randomGreeting(messages) {
  return messages[Math.floor(Math.random() * messages.length)];
}

function firstName(name = 'User') {
  return (String(name || 'User').trim().split(/\s+/)[0] || 'User').toUpperCase();
}

function dashboardRoleLabel(role = 'User') {
  const labels = {
    Admin: 'Administrator',
    Custodian: 'Custodian',
    'Maintenance Personnel': 'Maintenance',
  };

  return labels[role] ?? role;
}

function dashboardMetricValue(metrics, label) {
  const rawValue = metrics.find((metric) => metric.label === label)?.value ?? 0;
  if (typeof rawValue === 'number') {
    return rawValue;
  }
  const parsed = Number.parseFloat(String(rawValue).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// One filled horizontal bar split proportionally into colored segments (e.g.
// role breakdown) — paired with ChartLegend below it for the label/count per
// segment, rather than HorizontalBarChart's stack of separate per-row bars.
// A dual-handle range slider over a small fixed set of labeled stops (e.g.
// severity levels), not a continuous 0-100 value — built from two overlaid
// native <input type="range"> elements (a well-worn CSS trick: both share
// the same track, but only their thumbs are clickable, via pointer-events
// stripped from the input itself and restored on ::-webkit/-moz-range-thumb)
// rather than hand-rolling pointer-drag math.
function DualRangeSlider({ labels, minIndex, maxIndex, onChange }) {
  const lastIndex = labels.length - 1;
  const percentOf = (i) => (lastIndex === 0 ? 0 : (i / lastIndex) * 100);

  return (
    <div className="dual-range-slider">
      <div className="dual-range-track">
        <div
          className="dual-range-fill"
          style={{ left: `${percentOf(minIndex)}%`, right: `${100 - percentOf(maxIndex)}%` }}
        />
        <input
          type="range"
          className="dual-range-input"
          min={0}
          max={lastIndex}
          step={1}
          value={minIndex}
          // Stacked on top of the max thumb once they meet at the same stop
          // (e.g. narrowing the filter down to "Medium" only) — otherwise,
          // since it's first in the DOM, the max thumb always paints over it
          // and permanently swallows the drag, leaving the min thumb stuck
          // and the range impossible to widen back out.
          style={{ zIndex: minIndex >= maxIndex ? 2 : 1 }}
          onChange={(e) => onChange(Math.min(Number(e.target.value), maxIndex), maxIndex)}
        />
        <input
          type="range"
          className="dual-range-input"
          min={0}
          max={lastIndex}
          step={1}
          value={maxIndex}
          style={{ zIndex: minIndex >= maxIndex ? 1 : 2 }}
          onChange={(e) => onChange(minIndex, Math.max(Number(e.target.value), minIndex))}
        />
      </div>
      <div className="dual-range-labels">
        {labels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </div>
  );
}

function SegmentedBar({ segments }) {
  const total = segments.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  return (
    <div className="segmented-bar">
      {total === 0
        ? <span style={{ width: '100%', background: 'var(--surface-2, #f1f5f9)' }} />
        : segments.filter((s) => s.value > 0).map((s) => (
          <span key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />
        ))}
    </div>
  );
}

function ChartLegend({ rows }) {
  return (
    <ul className="chart-legend">
      {rows.map((row) => (
        <li key={row.label}>
          <span style={{ '--legend-color': row.color }}></span>
          <small>{row.label}</small>
          <strong>{row.value}</strong>
        </li>
      ))}
    </ul>
  );
}

// The "what this page does" hint banner (blue info callout) was removed from
// every module per user request — kept as a no-op rather than touched at
// every call site, so ModulePanel and the 4 ticket-workflow pages that use it
// don't need to change.
function DismissibleHint() {
  return null;
}

function ModulePanel({ children, description, statCards, filterBar, tabBar }) {
  return (
    <div className="module-grid">
      <DismissibleHint description={description} />
      {/* Tabs switch the whole view (stats, filters, list), so they live at
          the top — same spot on every tab — not between filters and list. */}
      {tabBar}
      {statCards}
      {filterBar && (
        <section className="panel module-filter-panel">
          {filterBar}
        </section>
      )}
      <section className="panel">
        {children}
      </section>
    </div>
  );
}

/** Generic modal wrapper that hosts a SmartForm popup. */
function FormModal({ open, title, onClose, children, wide = false }) {
  const notice = useContext(FormNoticeContext);

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal-box${wide ? ' modal-box-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        {notice && notice.type === 'error' && (
          <div className="notice error" style={{ margin: '12px 28px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', textAlign: 'center', flexDirection: 'column' }}>
            <span style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name="alert" size={16} /></span>
            <span>{notice.text}</span>
          </div>
        )}
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function UserInfoModal({ user, onClose }) {
  const initials = user.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U';

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Reporter Information</h3>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        <div className="modal-body">
          <div className="user-info-card">
            <div className="profile-avatar user-info-avatar">{initials}</div>
            <div>
              <p className="user-info-name">{user.name}</p>
              {user.role && <span className="user-info-role">{user.role}</span>}
            </div>
          </div>
          <dl className="user-info-details">
            {user.email && (
              <div>
                <dt>Email</dt>
                <dd>{user.email}</dd>
              </div>
            )}
            {user.id != null && (
              <div>
                <dt>User ID</dt>
                <dd>#{user.id}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Full-page user profile — clicking a user anywhere (any table, any role) opens
// this instead of a popup. Uses the loaded users list when available, otherwise
// the user object carried on navigation state (so non-admins can view it too).
function UserViewPage({ userId, users = [], currentUser, onEdit }) {
  const location = useLocation();
  const user = (users ?? []).find((u) => String(u.id) === String(userId)) || location.state?.user || null;

  if (!user) {
    return (
      <ModulePanel description="This user account could not be found.">
      </ModulePanel>
    );
  }

  const initials = user.name ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'U';
  const isActive = user.is_active !== false;

  return (
    <ModulePanel description="User account profile and contact details.">
      <div className="vehicle-profile-header">
        <div className="vehicle-profile-identity">
          <span className="ticket-detail-id">User ID #{user.id}</span>
          <h3 className="ticket-detail-title">{user.name}</h3>
        </div>
        {canDo(currentUser, 'user.edit') && (
          <button className="primary-button" type="button" onClick={onEdit}><Icon name="edit" size={14} /> Edit User</button>
        )}
      </div>

      <div className="user-view-dash">
        <section className="veh-card">
          <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>User Information</h4></div>
          <div className="user-view-body">
            <div className="user-view-avatar">
              {user.photo_url ? <img src={resolvePhotoUrl(user.photo_url)} alt={user.name} /> : <span>{initials}</span>}
            </div>
            <dl className="veh-kv">
              <div><dt>Full Name</dt><dd>{user.name}</dd></div>
              <div><dt>Role</dt><dd>{user.role ?? '-'}</dd></div>
              <div><dt>Account Status</dt><dd><StatusBadge value={isActive ? 'Active' : 'Inactive'} /></dd></div>
            </dl>
          </div>
        </section>

        <section className="veh-card">
          <div className="veh-card-head"><Icon name="key" size={16} /><h4>Contact &amp; Login</h4></div>
          <dl className="veh-kv">
            <div><dt>Email</dt><dd>{user.email ?? '-'}</dd></div>
            <div><dt>Phone</dt><dd>{user.phone || '-'}</dd></div>
            <div><dt>Address</dt><dd>{user.address || '-'}</dd></div>
          </dl>
        </section>
      </div>
    </ModulePanel>
  );
}

function ProfileMenu({ user, open, setOpen, onLogout, onOpenNotifications, onOpenSettings }) {
  const initials = user.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U';
  // Show the uploaded profile photo when there is one; fall back to initials.
  const avatarInner = user.photo_url
    ? <img className="profile-menu-avatar-img" src={resolvePhotoUrl(user.photo_url)} alt={user.name} />
    : initials;

  return (
    <>
      <button className="profile-menu-trigger" type="button" onClick={() => setOpen((v) => !v)} aria-label="Account menu">
        <span className="profile-menu-avatar">{avatarInner}</span>
      </button>

      {open && (
        <div className="profile-menu-dropdown">
          <div className="profile-menu-user">
            <span className="profile-menu-avatar">{avatarInner}</span>
            <div className="profile-menu-user-info">
              <span className="profile-menu-name">{user.name}</span>
              <span className="profile-menu-role">{user.role}</span>
            </div>
          </div>

          <div className="profile-menu-divider" />

          <button className="profile-menu-item" type="button" onClick={() => { onOpenSettings(); setOpen(false); }}>
            <Icon name="key" size={15} /> My Settings
          </button>
          <button className="profile-menu-item" type="button" onClick={() => { onOpenNotifications(); setOpen(false); }}>
            <Icon name="bell" size={15} /> Notifications
          </button>

          <div className="profile-menu-divider" />

          <button className="profile-menu-item profile-menu-item-danger" type="button" onClick={onLogout}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            Logout
          </button>
        </div>
      )}
    </>
  );
}

function profileFields(existingPhotoUrl) {
  return [
    { label: 'Full Name', name: 'name', required: true, type: 'text' },
    { label: 'Email', name: 'email', required: true, type: 'text', placeholder: 'name@barangay.gov' },
    { label: 'Phone', name: 'phone', type: 'tel', pattern: '[0-9]{10}', placeholder: '09XXXXXXXXX', title: 'Phone must be exactly 10 digits' },
    { label: 'Address', name: 'address', type: 'text' },
    { label: 'Profile Photo', name: 'photo', accept: 'image/*', type: 'file', existingUrl: existingPhotoUrl },
  ];
}

/** Self-service profile page (all roles) — editable details (same fields/layout
 * an Admin uses on Update User) plus a separate password-change section, since
 * that one stays gated behind old-password verification. */
function ProfilePage({ user, onBack, setNotice, refreshUser, onDirty }) {
  const initials = user.name ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'U';
  const roles = (Array.isArray(user.roles) && user.roles.length) ? user.roles : [user.role].filter(Boolean);

  const updateDetails = async (payload) => {
    setNotice(null);
    try {
      await sendPayload('put', '/profile', payload);
      await refreshUser();
      setNotice({ type: 'success', text: 'Profile updated.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const updatePassword = async (payload) => {
    setNotice(null);
    try {
      await api.put('/profile/password', cleanPayload(payload));
      setNotice({ type: 'success', text: 'Password updated.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  return (
    <ModulePanel description="Your account details and password.">
      <div className="vehicle-profile-header">
        <div className="vehicle-profile-identity">
          <span className="ticket-detail-id">My Profile</span>
          <h3 className="ticket-detail-title">{user.name}</h3>
        </div>
      </div>

      <div className="profile-page">
        <div className="profile-hero">
          <div className="profile-hero-avatar">
            {user.photo_url
              ? <img src={resolvePhotoUrl(user.photo_url)} alt={user.name} />
              : <span>{initials}</span>}
          </div>
          <div className="profile-hero-info">
            <h2>{user.name}</h2>
            <p className="muted">{user.email}</p>
            <div className="profile-hero-roles">{roles.map((r) => <StatusBadge key={r} value={r} />)}</div>
          </div>
        </div>

        <div className="profile-section">
          <h4 className="profile-section-title"><Icon name="edit" size={15} /> Edit Details</h4>
          <p className="muted profile-section-hint">Keep your contact information up to date.</p>
          <div className="form-grid-2col user-form-grid">
            <SmartForm
              fields={profileFields(user.photo_url)}
              initialValues={user}
              key="profile-details"
              onCancel={onBack}
              onSubmit={updateDetails}
              onValuesChange={() => onDirty?.()}
              submitLabel="Save Changes"
              title=""
            />
          </div>
        </div>

        <div className="profile-section">
          <h4 className="profile-section-title"><Icon name="key" size={15} /> Change Password</h4>
          <p className="muted profile-section-hint">Use a strong password you don't reuse on other sites.</p>
          <div className="profile-form">
            <SmartForm
              fields={passwordFields}
              key="profile-password"
              onCancel={onBack}
              onSubmit={updatePassword}
              onValuesChange={() => onDirty?.()}
              submitLabel="Update Password"
              title=""
            />
          </div>
        </div>
      </div>
    </ModulePanel>
  );
}

const EMPTY_OBJ = {};

// Keeps an in-progress form's values alive across a route change and back
// (e.g. clicking a vehicle/custodian's name to view their profile, then
// hitting Back) — plain useState resets to its initial value on that round
// trip because the page component fully unmounts and remounts. sessionStorage
// survives that; it only clears itself on an explicit submit/cancel (see
// clearDraftState) or when the tab closes, so an abandoned draft doesn't
// resurrect the next time the same "new X" page is opened fresh.
function useDraftState(key, initialValue) {
  const [state, setState] = useState(() => {
    const fallback = typeof initialValue === 'function' ? initialValue() : initialValue;
    if (!key) return fallback;
    try {
      const saved = sessionStorage.getItem(key);
      return saved != null ? JSON.parse(saved) : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    if (!key) return;
    try { sessionStorage.setItem(key, JSON.stringify(state)); } catch { /* storage full/unavailable */ }
  }, [key, state]);

  return [state, setState];
}

function clearDraftState(key) {
  if (!key) return;
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}

function splitQuantityValue(value, units) {
  const str = String(value ?? '').trim();
  if (!str) return { amount: '', unit: units[0] };
  const lastSpace = str.lastIndexOf(' ');
  if (lastSpace === -1) {
    // No "<amount> <unit>" shape found. If the whole string is actually
    // just a unit name (e.g. the user picked a unit before typing an
    // amount, so the field's value is only that unit), treat it as
    // "no amount yet" with that unit preserved — don't misread the unit
    // name itself as the amount and silently reset the dropdown.
    if (units.includes(str)) return { amount: '', unit: str };
    return { amount: str, unit: units[0] };
  }
  const amount = str.slice(0, lastSpace).trim();
  const unitCandidate = str.slice(lastSpace + 1).trim();
  return units.includes(unitCandidate) ? { amount, unit: unitCandidate } : { amount: str, unit: units[0] };
}

// A quantity field's amount only counts as filled in when it's a genuine
// number — a bare unit string (e.g. "Gallons" picked before any amount was
// typed) must not pass as a valid amount.
function isQuantityAmountFilled(amount) {
  return amount !== '' && amount != null && !Number.isNaN(Number(amount));
}

// Generic required-check: treat only "no value" (empty string/null/undefined)
// as missing, so a legitimate falsy value like the number 0 (e.g. latitude
// 0, longitude 0) still counts as filled in.
function isValueMissing(value) {
  return value === '' || value === null || value === undefined;
}

const SELECT_OR_OTHER_SENTINEL = '__other__';

// A dropdown of presets plus an "Other" option that reveals a free-text box —
// e.g. Service Location: pick a known hub, or specify an outside repair shop.
// Tracks "other mode" locally (not in the form's values), seeded from whether
// the incoming value already fails to match any preset.
// Same look/interaction as CreatableSelect's combobox (single bordered
// input that opens a dropdown panel with a pinned "add new" row) — but for
// a small fixed set of preset numeric options (e.g. recurrence intervals)
// with an inline custom-number row instead of a full catalog: there's
// nothing to persist/rename/delete here, just a value on this one record.
function SelectOrAddNumberField({ field, value, onChange }) {
  const options = field.options ?? [];
  const matchesPreset = options.some((o) => String(o?.value ?? o) === String(value ?? ''));
  const isCustomActive = Boolean(value) && !matchesPreset;
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const selectedLabel = matchesPreset
    ? (options.find((o) => String(o?.value ?? o) === String(value ?? ''))?.label ?? '')
    : (isCustomActive ? `${value}${field.otherSuffix ? ` ${field.otherSuffix}` : ''}` : '');

  const openPanel = () => {
    setCustomDraft(isCustomActive ? String(value) : '');
    setOpen(true);
  };
  const pick = (option) => {
    onChange(String(option?.value ?? option ?? ''));
    setOpen(false);
  };
  const applyCustom = () => {
    if (!customDraft) return;
    onChange(customDraft);
    setOpen(false);
  };

  return (
    <div className="creatable-select" ref={containerRef}>
      <input
        type="text"
        readOnly
        value={selectedLabel}
        placeholder={field.placeholder ?? 'Select or add a custom interval'}
        required={field.required}
        onFocus={openPanel}
        onClick={openPanel}
      />
      {open && (
        <div className="creatable-select-panel">
          <div className="creatable-select-add creatable-select-add-pinned" onMouseDown={(e) => e.preventDefault()}>
            <Icon name="plus" size={13} />
            <input
              type={field.otherType ?? 'number'}
              className="creatable-select-custom-input"
              min={field.otherMin}
              max={field.otherMax}
              placeholder={field.otherPlaceholder ?? 'Specify'}
              value={customDraft}
              onChange={(e) => setCustomDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom(); } }}
            />
            {field.otherSuffix && <span className="muted">{field.otherSuffix}</span>}
            <button type="button" className="ghost-button" disabled={!customDraft} onClick={applyCustom}>
              {field.otherLabel ?? 'Add'}
            </button>
          </div>
          <div className="creatable-select-option-list">
            {options.map((option, i) => (
              <div key={option?.value != null ? option.value : `opt-${i}`} className="creatable-select-option-row">
                <button type="button" className="creatable-select-option" onClick={() => pick(option)}>
                  {option?.label ?? option}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SelectOrOtherField({ field, value, onChange }) {
  const options = field.options ?? [];
  const matchesPreset = options.some((o) => String(o?.value ?? o) === String(value ?? ''));
  const [otherMode, setOtherMode] = useState(Boolean(value) && !matchesPreset);

  if (field.otherType === 'number') {
    return <SelectOrAddNumberField field={field} value={value} onChange={onChange} />;
  }

  return (
    <>
      <select
        required={field.required}
        value={otherMode ? SELECT_OR_OTHER_SENTINEL : (value ?? '')}
        onChange={(e) => {
          if (e.target.value === SELECT_OR_OTHER_SENTINEL) {
            setOtherMode(true);
            onChange('');
          } else {
            setOtherMode(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">{' '}</option>
        {options.map((option, i) => (
          <option key={option?.value != null ? option.value : `opt-${i}`} value={option?.value ?? option ?? ''}>
            {option?.label ?? option}
          </option>
        ))}
        <option value={SELECT_OR_OTHER_SENTINEL}>{field.otherLabel ?? 'Other (specify)'}</option>
      </select>
      {otherMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            type={field.otherType ?? 'text'}
            min={field.otherMin}
            max={field.otherMax}
            placeholder={field.otherPlaceholder ?? 'Specify'}
            required={field.required}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            style={{ flex: 1 }}
          />
          {field.otherSuffix && <span className="muted" style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>{field.otherSuffix}</span>}
        </div>
      )}
    </>
  );
}

// Phase B4 — catalog.create (fault categories / maintenance types) is
// Admin-only now. Everywhere a Custodian or Maintenance Personnel used to
// get CreatableSelect's "+ Add New" affordance on one of these two
// catalogs, this replaces it: a plain select with "Other" pinned as the
// last option. Picking it reveals a free-text note below — `value` stays a
// real catalog name, or the literal CATALOG_OTHER_VALUE sentinel; `note` is
// kept separate, meant to be folded into whichever description/notes field
// the parent form already sends to the backend (rather than trying to mint
// a new catalog value, which only Admin can still do). Admin keeps the
// original CreatableSelect wherever this replaces it — this component is
// never shown to Admin.
const CATALOG_OTHER_VALUE = 'Other';

function CatalogOrOtherField({ value, onChange, note, onNoteChange, options = [], required = false, placeholder = 'Select an option', otherNoteLabel = 'Describe the issue/type' }) {
  const isOther = value === CATALOG_OTHER_VALUE;
  return (
    <>
      <select
        required={required}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((option, i) => (
          <option key={option?.value != null ? option.value : `opt-${i}`} value={option?.value ?? option ?? ''}>
            {option?.label ?? option}
          </option>
        ))}
        <option value={CATALOG_OTHER_VALUE}>Other</option>
      </select>
      {isOther && (
        <input
          type="text"
          placeholder={otherNoteLabel}
          value={note ?? ''}
          onChange={(e) => onNoteChange(e.target.value)}
          style={{ marginTop: 8 }}
        />
      )}
    </>
  );
}

// Every required/pattern/confirm-match check SmartForm used to hand off to
// the browser's own constraint validation (native tooltip, positioned and
// styled by the browser, not this app). Re-implemented here so every form
// reports through the same in-app, styled validation card the server-side
// (422) errors already use — one consistent message UI instead of two.
function collectValidationErrors(fields, values) {
  const lines = [];
  fields.forEach((field) => {
    const value = values[field.name];

    if (field.type === 'checkboxes') {
      if (field.required && !(Array.isArray(value) && value.length > 0)) {
        lines.push(`${field.label}: select at least one.`);
      }
      return;
    }

    if (field.type === 'list') {
      const rows = Array.isArray(value) ? value : [];
      if (field.required && !rows.some((row) => row.trim())) {
        lines.push(`${field.label} is required.`);
      }
      return;
    }

    if (field.type === 'quantity') {
      // Require the amount portion specifically — a combined value like
      // "Gallons" (unit picked, no amount typed) must not pass just because
      // the raw string is non-empty.
      if (field.required) {
        const { amount } = splitQuantityValue(value, field.units);
        if (!isQuantityAmountFilled(amount)) {
          lines.push(`${field.label} is required.`);
        }
      }
      return;
    }

    if (field.confirmOf) {
      if (field.required && isValueMissing(value)) {
        lines.push(`${field.label} is required.`);
      } else if (value && value !== values[field.confirmOf]) {
        lines.push(`${field.label} does not match.`);
      }
      return;
    }

    if (field.required && isValueMissing(value)) {
      lines.push(`${field.label} is required.`);
      return;
    }

    if (field.type === 'number' && value !== '' && value != null) {
      const num = Number(value);
      if (field.min != null && num < Number(field.min)) {
        lines.push(`${field.label} must be at least ${field.min}.`);
      }
      if (field.max != null && num > Number(field.max)) {
        lines.push(`${field.label} must be at most ${field.max}.`);
      }
    }

    if (field.pattern && value && !new RegExp(`^(?:${field.pattern})$`).test(value)) {
      lines.push(field.title || `${field.label} is invalid.`);
    }
  });
  return lines;
}

// Opt-in field grouping: fields carrying a `group` label render inside their
// own titled sub-card (Maintenance Records today) instead of one flat list —
// so the section header says what those fields are about at a glance,
// mirroring the realcore reference's "Select Fee Type" / "Other" cards.
// Fields with no `group` fall into a single nameless bucket, which the
// caller renders unwrapped — so forms that never set `group` are unaffected.
function groupFields(fields) {
  const groups = [];
  fields.forEach((field) => {
    const key = field.group ?? null;
    let bucket = groups.find((g) => g.name === key);
    if (!bucket) {
      bucket = { name: key, fields: [] };
      groups.push(bucket);
    }
    bucket.fields.push(field);
  });
  return groups;
}

function SmartForm({ fields, initialValues = EMPTY_OBJ, onCancel, cancelLabel = 'Cancel', onSubmit, submitLabel, title, onValuesChange }) {
  const [values, setValues] = useState(() => valuesFromFields(fields, initialValues));
  const [submitting, setSubmitting] = useState(false);
  // Per-field show/hide toggle for password inputs — keyed by field name so
  // e.g. Old/New/Confirm Password on the same form toggle independently.
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const [validationLines, setValidationLines] = useState(null);

  useEffect(() => {
    setValues(valuesFromFields(fields, initialValues));
  }, [initialValues]);

  const handleChange = (event) => {
    const { name, type, files, value } = event.target;
    const field = fields.find((f) => f.name === name);
    let nextValue = field?.uppercase ? value.toUpperCase() : value;
    if (field?.type === 'tel' && name === 'phone') {
      nextValue = value.replace(/[^0-9]/g, '').slice(0, 10);
    }
    // 'multi-file' fields render their own dropzone/input with a dedicated
    // onChange (see the field renderer below) — this generic handler only
    // ever sees single-file and non-file fields.
    const finalValue = type === 'file' ? files[0] : nextValue;
    const next = { ...values, [name]: finalValue };
    setValues(next);
    onValuesChange?.(next);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const lines = collectValidationErrors(fields, values);
    if (lines.length) {
      setValidationLines(lines);
      return;
    }

    setSubmitting(true);
    try {
      // 'list' fields edit as an array of rows; flatten back to the
      // newline-joined string the backend column actually stores.
      // 'confirmOf' fields are sent through as-is (not stripped) — some
      // backends (e.g. the self-service password change) rely on Laravel's
      // `confirmed` rule convention, which expects the `{field}_confirmation`
      // value to actually be present in the request; others just ignore it.
      const payload = { ...values };
      fields.forEach((field) => {
        if (field.type === 'list') {
          payload[field.name] = (Array.isArray(payload[field.name]) ? payload[field.name] : [])
            .map((row) => row.trim())
            .filter(Boolean)
            .join('\n');
        }
      });
      // Phase B4 — a 'catalog-or-other' field's typed note never has a
      // backend column of its own (Custodian/Maintenance Personnel can no
      // longer mint a new catalog value, so "Other" + a note stands in for
      // it). Runs as its own pass, after the 'list' join above, so folding
      // the note into another field this same form owns (e.g. a textarea
      // that started as an array) appends to the already-joined string, not
      // the raw array.
      fields.forEach((field) => {
        if (field.type !== 'catalog-or-other') return;
        const noteKey = `${field.name}__other_note`;
        const note = String(payload[noteKey] ?? '').trim();
        delete payload[noteKey];
        if (payload[field.name] === CATALOG_OTHER_VALUE && note && field.otherNoteField) {
          const prefixed = `Other (specified type): ${note}`;
          const existing = String(payload[field.otherNoteField] ?? '').trim();
          payload[field.otherNoteField] = existing ? `${existing}\n${prefixed}` : prefixed;
        }
      });
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="smart-form" onSubmit={handleSubmit} noValidate autoComplete="off">
      {validationLines && (
        <div className="toast-notice-overlay" onClick={() => setValidationLines(null)}>
          <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
            <Icon name="alert" size={17} className="toast-notice-icon" />
            <div className="toast-notice-lines">
              {validationLines.map((line, i) => <span key={i}>{line}</span>)}
            </div>
            <button type="button" className="toast-notice-close" onClick={() => setValidationLines(null)} aria-label="Dismiss">
              <Icon name="close" size={13} />
            </button>
          </div>
        </div>
      )}
      {submitting && createPortal(
        <div className="loading-overlay">
          <div className="loading-overlay-card">
            <Icon name="gear" size={34} className="loading-overlay-gear" filled />
            <span>Loading…</span>
          </div>
        </div>,
        document.body
      )}
      <h3>{title}</h3>
      {(() => {
        const renderField = (field) => {
        const quantity = field.type === 'quantity' ? splitQuantityValue(values[field.name], field.units) : null;
        // Drives the floating-label float-up: a value counts even for an
        // array (checkboxes/list), so those fields' captions float too
        // once at least one row/option is filled in.
        const rawFieldValue = values[field.name];
        const fieldHasValue = Array.isArray(rawFieldValue)
          ? rawFieldValue.some((v) => String(v ?? '').trim() !== '')
          : rawFieldValue !== undefined && rawFieldValue !== null && String(rawFieldValue).trim() !== '';
        return (
        <Fragment key={field.name}>
        <label
          className={[field.compactFile ? 'file-inline' : null, fieldHasValue ? 'has-value' : null].filter(Boolean).join(' ') || undefined}
          style={field.fullWidth ? { gridColumn: '1 / -1' } : undefined}
        >
          <span style={field.action ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } : undefined}>
            <span>{field.label}{field.required ? <span className="required-asterisk"> *</span> : null}</span>
            {field.action && (
              <button
                type="button"
                className="link-button"
                onClick={field.action.onClick}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline', fontWeight: 600, fontSize: '0.78rem', whiteSpace: 'nowrap' }}
              >
                {field.action.label}
              </button>
            )}
          </span>
          {field.type === 'quantity' ? (
            <div className="quantity-field">
              <input
                min="0"
                onChange={(e) => setValues((current) => ({
                  ...current,
                  [field.name]: `${e.target.value} ${quantity.unit}`.trim(),
                }))}
                placeholder={field.placeholder}
                required={field.required}
                step="any"
                type="number"
                value={quantity.amount}
              />
              <select
                onChange={(e) => setValues((current) => ({
                  ...current,
                  [field.name]: `${quantity.amount} ${e.target.value}`.trim(),
                }))}
                value={quantity.unit}
              >
                {field.units.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          ) : null}
          {field.type === 'textarea' ? (
            <textarea
              name={field.name}
              onChange={handleChange}
              placeholder={field.placeholder ?? field.label}
              required={field.required}
              rows={field.rows ?? 3}
              value={values[field.name] ?? ''}
            />
          ) : null}
          {field.type === 'select' ? (
            <select
              name={field.name}
              onChange={handleChange}
              required={field.required}
              value={values[field.name] ?? ''}
            >
              {/* Blank rather than "Select" — at rest the floating label
                  sits centered over the field like a placeholder, so a
                  visible option here would double up with it. */}
              <option value="">{' '}</option>
              {field.options.map((option, i) => (
                <option
                  key={option?.value != null ? option.value : `opt-${i}`}
                  value={option?.value ?? option ?? ''}
                >
                  {option?.label ?? option}
                </option>
              ))}
            </select>
          ) : null}
          {field.type === 'select-or-other' ? (
            <SelectOrOtherField
              field={field}
              value={values[field.name]}
              onChange={(v) => {
                const next = { ...values, [field.name]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
            />
          ) : null}
          {field.type === 'creatable-select' ? (
            <CreatableSelect
              value={values[field.name] ?? ''}
              onChange={(v) => {
                const next = { ...values, [field.name]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
              options={field.options ?? []}
              required={field.required}
              newItemLabel={field.newItemLabel}
              catalogEndpoint={field.catalogEndpoint}
              idField={field.idField}
              nameField={field.nameField}
              valueIsId={field.valueIsId}
              extraFields={field.extraFields}
            />
          ) : null}
          {field.type === 'catalog-or-other' ? (
            <CatalogOrOtherField
              value={values[field.name] ?? ''}
              onChange={(v) => {
                const next = { ...values, [field.name]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
              note={values[`${field.name}__other_note`] ?? ''}
              onNoteChange={(v) => {
                const next = { ...values, [`${field.name}__other_note`]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
              options={field.options ?? []}
              required={field.required}
              placeholder={field.placeholder}
              otherNoteLabel={field.otherNoteLabel}
            />
          ) : null}
          {field.type === 'checkboxes' ? (
            <div className="checkbox-group" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(() => {
                const groupHasSelection = Array.isArray(values[field.name]) && values[field.name].length > 0;
                // A native checkbox's `required` only ever means "this exact
                // box must be checked" — there's no built-in "at least one of
                // these" semantic. Marking every box required only while the
                // group is empty gets that behavior for free: checking any
                // one of them clears `required` from the whole group on the
                // very next render, so the browser's own validation bubble
                // (same one every other required field already uses) fires
                // correctly instead of a confusing raw backend error surfacing
                // after a round-trip.
                return field.options.map((option) => {
                  const val = option?.value ?? option;
                  const label = option?.label ?? option;
                  const selected = Array.isArray(values[field.name]) && values[field.name].includes(val);
                  return (
                    <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, cursor: 'pointer', margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={selected}
                        required={field.required && !groupHasSelection}
                        title={field.required ? 'Select at least one.' : undefined}
                        onChange={() => setValues((current) => {
                          const list = Array.isArray(current[field.name]) ? current[field.name] : [];
                          const next = selected ? list.filter((r) => r !== val) : [...list, val];
                          const merged = { ...current, [field.name]: next };
                          onValuesChange?.(merged);
                          return merged;
                        })}
                        style={{ width: 'auto' }}
                      />
                      <span style={{ margin: 0 }}>{label}</span>
                    </label>
                  );
                });
              })()}
            </div>
          ) : null}
          {field.type === 'list' ? (
            <div className="list-field">
              {(Array.isArray(values[field.name]) ? values[field.name] : ['']).map((row, index) => {
                const rows = Array.isArray(values[field.name]) ? values[field.name] : [''];
                return (
                  <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
                    <span className="muted" style={{ flex: '0 0 20px', textAlign: 'right' }}>{index + 1}.</span>
                    <input
                      type="text"
                      placeholder={field.placeholder}
                      value={row}
                      required={field.required && index === 0}
                      onChange={(e) => setValues((current) => {
                        const list = [...(Array.isArray(current[field.name]) ? current[field.name] : [''])];
                        list[index] = e.target.value;
                        const merged = { ...current, [field.name]: list };
                        onValuesChange?.(merged);
                        return merged;
                      })}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="btn-delete-action icon-btn"
                      onClick={() => setValues((current) => {
                        const list = (Array.isArray(current[field.name]) ? current[field.name] : ['']).filter((_, i) => i !== index);
                        const merged = { ...current, [field.name]: list.length ? list : [''] };
                        onValuesChange?.(merged);
                        return merged;
                      })}
                      disabled={rows.length === 1}
                      title={`Remove ${field.removeLabel ?? 'issue'}`}
                      aria-label={`Remove ${field.removeLabel ?? 'issue'}`}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="primary-button"
                onClick={() => setValues((current) => {
                  const merged = { ...current, [field.name]: [...(Array.isArray(current[field.name]) ? current[field.name] : ['']), ''] };
                  onValuesChange?.(merged);
                  return merged;
                })}
              >
                <Icon name="plus" size={14} /> {field.addLabel ?? 'Add another issue'}
              </button>
            </div>
          ) : null}
          {field.type === 'password' ? (
            <div className="password-field">
              <input
                autoComplete="new-password"
                name={field.name}
                onChange={handleChange}
                placeholder={field.placeholder ?? field.label}
                required={field.required}
                title={field.title}
                type={visiblePasswords[field.name] ? 'text' : 'password'}
                value={values[field.name] ?? ''}
              />
              <button
                type="button"
                className="password-field-toggle"
                onClick={() => setVisiblePasswords((current) => ({ ...current, [field.name]: !current[field.name] }))}
                title={visiblePasswords[field.name] ? 'Hide password' : 'Show password'}
                aria-label={visiblePasswords[field.name] ? 'Hide password' : 'Show password'}
              >
                <Icon name={visiblePasswords[field.name] ? 'eyeOff' : 'eye'} size={16} />
              </button>
            </div>
          ) : null}
          {!['textarea', 'select', 'quantity', 'checkboxes', 'select-or-other', 'creatable-select', 'catalog-or-other', 'list', 'password', 'file', 'multi-file'].includes(field.type) ? (
            <input
              accept={field.accept}
              autoComplete="off"
              maxLength={field.maxLength}
              name={field.name}
              onChange={handleChange}
              pattern={field.pattern}
              placeholder={field.placeholder ?? field.label}
              required={field.required}
              title={field.title}
              type={field.type}
              value={values[field.name] ?? ''}
            />
          ) : null}
          {field.type === 'file' ? (
            <div className={`photo-box${isFile(values[field.name]) || field.existingUrl ? ' has-file' : ''}`}>
              <input
                accept={field.accept}
                className="photo-box-input"
                id={`photo-box-input-${field.name}`}
                name={field.name}
                onChange={handleChange}
                required={field.required}
                type="file"
              />
              <label className="photo-box-add-btn" htmlFor={`photo-box-input-${field.name}`}>
                <Icon name="plus" size={10} />
                {isFile(values[field.name]) || field.existingUrl ? 'Change Image' : 'Add Image'}
              </label>
              {isFile(values[field.name]) ? (
                <button
                  type="button"
                  className="photo-box-remove"
                  onClick={() => {
                    const next = { ...values, [field.name]: null };
                    setValues(next);
                    onValuesChange?.(next);
                  }}
                  title="Remove image"
                  aria-label="Remove image"
                >
                  <Icon name="trash" size={13} />
                </button>
              ) : null}
              {isFile(values[field.name]) ? (
                values[field.name].type.startsWith('image/') ? (
                  <img alt={field.label} className="photo-box-fill" src={URL.createObjectURL(values[field.name])} />
                ) : (
                  <div className="photo-box-file">
                    <Icon name="clipboard" size={28} />
                    <span>{values[field.name].name}</span>
                  </div>
                )
              ) : field.existingUrl ? (
                // Not a freshly-picked File — the vehicle's already-saved photo,
                // shown so editing doesn't look like it wiped out the photo that
                // was there all along. No remove button here: the backend only
                // ever replaces photo_url when a new file is uploaded, it has no
                // "clear the photo" path, so offering removal would be a lie.
                <img alt={field.label} className="photo-box-fill" src={resolvePhotoUrl(field.existingUrl)} />
              ) : (
                <div className="photo-box-empty">
                  <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="15" rx="2" />
                    <circle cx="9" cy="10" r="1.8" />
                    <path d="M4.5 17.5 9 13l3 3 4-4.5 3.5 4" />
                  </svg>
                  <span>No image available</span>
                </div>
              )}
            </div>
          ) : null}
          {field.type === 'multi-file' ? (() => {
            const existingFiles = Array.isArray(field.existingAttachments) ? field.existingAttachments : [];
            const pendingFiles = Array.isArray(values[field.name]) ? values[field.name] : [];
            const addFiles = (incoming) => {
              const list = Array.from(incoming ?? []).filter(Boolean);
              if (!list.length) return;
              const next = { ...values, [field.name]: [...pendingFiles, ...list] };
              setValues(next);
              onValuesChange?.(next);
            };
            const inputId = `multi-file-input-${field.name}`;
            return (
              <div className="multi-file-field file-card-like">
                <div className="multi-file-body">
                  {existingFiles.length || pendingFiles.length ? (
                    <div className="multi-file-list">
                      {existingFiles.map((att) => (
                        <div key={`existing-${att.attachment_id}`} className="multi-file-item is-existing">
                          <Icon name="clipboard" size={14} />
                          <a className="multi-file-name" href={resolvePhotoUrl(att.file_url)} target="_blank" rel="noreferrer">
                            {att.original_name || 'File'}
                          </a>
                          {field.onRemoveExisting && (
                            <button type="button" className="multi-file-remove" onClick={() => field.onRemoveExisting(att)} title="Remove file" aria-label="Remove file">
                              <Icon name="close" size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                      {pendingFiles.map((file, i) => (
                        <div key={`pending-${file.name}-${i}`} className="multi-file-item">
                          <Icon name="clipboard" size={14} />
                          <span className="multi-file-name">{file.name}</span>
                          <button
                            type="button"
                            className="multi-file-remove"
                            onClick={() => {
                              const next = { ...values, [field.name]: pendingFiles.filter((_, fi) => fi !== i) };
                              setValues(next);
                              onValuesChange?.(next);
                            }}
                            title="Remove file"
                            aria-label="Remove file"
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="file-card-empty">No data</div>
                  )}
                  <label
                    className="file-card-dropzone multi-file-dropzone"
                    htmlFor={inputId}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
                  >
                    <input
                      accept={field.accept}
                      className="multi-file-input"
                      id={inputId}
                      multiple
                      name={field.name}
                      onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                      type="file"
                    />
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 18a4.5 4.5 0 0 1-1-8.9A5.5 5.5 0 0 1 16.7 7 4.5 4.5 0 0 1 18 18" />
                      <path d="M12 12v7" />
                      <path d="M9.5 14.5 12 12l2.5 2.5" />
                    </svg>
                    <span>Drag file here</span>
                  </label>
                </div>
              </div>
            );
          })() : null}
          {field.inlineExtra ? (
            <div className="field-extra field-extra-inline">
              {typeof field.inlineExtra === 'function' ? field.inlineExtra(values) : field.inlineExtra}
            </div>
          ) : null}
          {field.hint ? <small className="field-hint">{field.hint}</small> : null}
        </label>
        {field.extra ? (
          <div className="field-extra" style={{ gridColumn: field.extraGridColumn ?? '1 / -1' }}>
            {typeof field.extra === 'function' ? field.extra(values) : field.extra}
          </div>
        ) : null}
        </Fragment>
        );
        };

        return fields.some((f) => f.group) ? (
          groupFields(fields).map((group) => (
            <section className="form-group" key={group.name ?? 'ungrouped'}>
              {group.name ? <h4 className="form-group-title">{group.name}</h4> : null}
              <div className="form-group-body">{group.fields.map(renderField)}</div>
            </section>
          ))
        ) : (
          fields.map(renderField)
        );
      })()}
      <div className="form-actions">
        {onCancel ? <button className="ghost-button" onClick={onCancel} type="button">{cancelLabel}</button> : null}
        <button className="primary-button" type="submit">{submitLabel}</button>
      </div>
    </form>
  );
}

// Its own page (not a modal/inline panel) reached at .../locations/new —
// typing a Complete Address geocodes it and drops/moves the map pin there;
// clicking the map instead reverse-geocodes the click back into the Address
// field. Either path has to land inside the active service-area boundary
// (the same polygon the fleet map draws) before Save is allowed — an
// out-of-bounds result shows why instead of silently creating a hub nobody
// can find on the map. Saving POSTs to /hubs, same endpoint and shape the
// map's own "Add Hub" flow uses.
// Shared by NewLocationPage ("Add Location", defines a brand-new hub) and
// EditLocationPage ("Update Location", reassigns a vehicle — to an existing
// hub OR, same as Add, a brand-new one typed/clicked in) — both need the
// exact same address<->map sync and boundary check; only the extra
// Address/Area + Remarks fields and the submit wiring differ by mode.
function LocationAddressMapForm({
  mode = 'add',
  initialName = '',
  initialAddress = '',
  initialMarker = null,
  initialAddressArea = '',
  initialRemarks = '',
  boundaryRings,
  boundaryLabel,
  onBack,
  onSubmit,
}) {
  const isEdit = mode === 'edit';
  const [name, setName] = useState(initialName);
  const [address, setAddress] = useState(initialAddress);
  const [marker, setMarker] = useState(initialMarker);
  const [addressArea, setAddressArea] = useState(initialAddressArea);
  const [remarks, setRemarks] = useState(initialRemarks);
  const [error, setError] = useState(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Distinguishes "the map just moved the pin, don't re-geocode the address
  // that produced it" from "the admin is typing" — without it, a map click
  // (which fills Address via reverse geocoding) would immediately trigger
  // the address-typing effect below and re-geocode right back, wasting a
  // lookup and risking a slightly different point than the one clicked.
  const addressFromMapRef = useRef(false);
  // Edit mode starts with `address` already non-empty (the hub's own
  // internal name/address, paired with a marker we already know is correct
  // from initialMarker) — without this, mounting immediately re-triggers
  // the geocode effect below on that pre-filled value, which usually isn't
  // a real searchable address string, showing a spurious "couldn't find
  // that address" error over a perfectly valid pin. Compared by VALUE
  // (not a one-shot consumed flag) so React StrictMode's dev-only double
  // effect invocation — same address, effect body run twice — still skips
  // both times instead of geocoding on the second pass.
  const skipGeocodeForAddressRef = useRef(initialAddress || null);

  // Debounced geocode-as-you-type — waits for a pause in typing so it's not
  // firing a lookup on every keystroke.
  useEffect(() => {
    if (addressFromMapRef.current) {
      addressFromMapRef.current = false;
      return undefined;
    }
    if (skipGeocodeForAddressRef.current !== null && address === skipGeocodeForAddressRef.current) {
      return undefined;
    }
    skipGeocodeForAddressRef.current = null;
    const trimmed = address.trim();
    if (!trimmed) return undefined;

    const timer = setTimeout(async () => {
      setLookingUp(true);
      setError(null);
      try {
        const match = await geocodeAddress(trimmed);
        if (!match) {
          setError(`Couldn't find that address yet — keep typing, or click the map instead.`);
          return;
        }
        setMarker({ lat: match.lat, lng: match.lng });
        if (!isPointWithinBoundaryRings(match, boundaryRings)) {
          setError(`That address is outside the ${boundaryLabel} boundary — only locations within ${boundaryLabel} can be added.`);
        }
      } catch (err) {
        setError(err.message || 'Address lookup failed.');
      } finally {
        setLookingUp(false);
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [address, boundaryRings, boundaryLabel]);

  const handleMapPick = useCallback(async (latLng) => {
    setMarker(latLng);
    setError(null);

    if (!isPointWithinBoundaryRings(latLng, boundaryRings)) {
      setError(`That spot is outside the ${boundaryLabel} boundary — only locations within ${boundaryLabel} can be added.`);
      return;
    }

    setLookingUp(true);
    try {
      const displayName = await reverseGeocode(latLng.lat, latLng.lng);
      if (displayName) {
        addressFromMapRef.current = true;
        setAddress(displayName);
      }
    } catch {
      // Reverse geocoding is a convenience, not a requirement — a failed
      // lookup still leaves a valid, in-bounds pin; the admin can type the
      // address in by hand instead.
    } finally {
      setLookingUp(false);
    }
  }, [boundaryRings, boundaryLabel]);

  const isPinValid = marker && isPointWithinBoundaryRings(marker, boundaryRings);
  const canSubmit = name.trim() && isPinValid && !lookingUp && !submitting;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        lat: marker.lat,
        lng: marker.lng,
        label: name.trim().substring(0, 2).toUpperCase(),
        addressArea: addressArea.trim(),
        remarks: remarks.trim(),
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message || `Failed to ${isEdit ? 'update' : 'add'} location.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModulePanel description={
      isEdit
        ? 'Type the complete address or click the map — either one fills in the other. Pick where this vehicle already is, or move it to a brand-new location the same way you would add one.'
        : 'Type the complete address or click the map — either one fills in the other.'
    }>
      <form className="add-location-page" onSubmit={handleSubmit} noValidate>
        <div className="add-location-fields smart-form">
          {error && (
            <div className="toast-notice toast-notice-validation error" role="alert">
              <Icon name="alert" size={17} className="toast-notice-icon" />
              <div className="toast-notice-lines"><span>{error}</span></div>
            </div>
          )}
          <label className={name.trim() ? 'has-value' : undefined}>
            <span>Location Name <span className="required-asterisk">*</span></span>
            <input
              type="text"
              required
              placeholder="e.g. Paknaan Health Center"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {isEdit && <small className="field-hint">An existing name reuses that location; a new one creates it.</small>}
          </label>
          <label className={address.trim() ? 'has-value' : undefined}>
            <span>Complete Address <span className="required-asterisk">*</span></span>
            <input
              type="text"
              required
              placeholder="e.g. Purok 5, Paknaan, Mandaue City, Cebu"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <small className="field-hint">
              {lookingUp ? 'Looking up…' : `Must be within the ${boundaryLabel} boundary — you can also click the map to pinpoint it.`}
            </small>
          </label>
          {isEdit && (
            <>
              <label className={addressArea.trim() ? 'has-value' : undefined}>
                <span>Address / Area</span>
                <input
                  type="text"
                  placeholder="e.g. Bay 3, near the north gate"
                  value={addressArea}
                  onChange={(e) => setAddressArea(e.target.value)}
                />
              </label>
              <label className={remarks.trim() ? 'has-value' : undefined}>
                <span>Remarks</span>
                <textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
              </label>
            </>
          )}
          <div className="form-actions">
            <button className="ghost-button" onClick={onBack} type="button" disabled={submitting}>Cancel</button>
            <button className="primary-button" type="submit" disabled={!canSubmit}>
              {submitting ? 'Saving…' : (isEdit ? 'Update Location' : 'Add Location')}
            </button>
          </div>
        </div>
        <div className="add-location-map-shell">
          <AddLocationMap marker={marker} boundaryRings={boundaryRings} onPick={handleMapPick} />
        </div>
      </form>
    </ModulePanel>
  );
}

function NewLocationPage({ onBack, boundaryRings, boundaryLabel, onSubmit }) {
  return (
    <LocationAddressMapForm
      mode="add"
      boundaryRings={boundaryRings}
      boundaryLabel={boundaryLabel}
      onBack={onBack}
      onSubmit={({ name, lat, lng, label }) => onSubmit({ name, lat, lng, label })}
    />
  );
}

function PartsTags({ value }) {
  if (!value) return <span style={{ color: '#94a3b8' }}>-</span>;
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return <span style={{ color: '#94a3b8' }}>-</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxWidth: '240px' }}>
      {parts.map((part, idx) => (
        <span key={idx} className="part-tag" title={part}>{part}</span>
      ))}
    </div>
  );
}

// Column headers are drag-reorderable in-place whenever `onReorderColumn`
// is passed AND the columns carry a stable `key` (only some tables' column
// functions set one so far, e.g. vehicleColumns — the rest render exactly
// as before, since a column with no `key` just never becomes draggable).
// Mirrors the same reorder semantics ColumnChooserButton's popover list
// uses, so dragging a header does the same thing as dragging its row there
// — just without opening the popover first.
function DataTable({ columns, rows, compact = false, onRowClick, onReorderColumn, emptyMessage = 'No records found.', renderSubRow }) {
  // Which side of which header the dragged column would land on — drawn as
  // a thin vertical line right on that edge (matching the realcore
  // reference), so there's no guessing where a drop will actually land.
  // Declared before the early return below so the hook itself is always
  // called regardless of whether `rows` is empty on a given render.
  const [dropIndicator, setDropIndicator] = useState(null);

  if (!rows?.length) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  const hasWidths = columns.some((column) => column.width);
  const sideOf = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
  };

  return (
    <div className={`table-shell${compact ? ' is-compact' : ''}${hasWidths ? ' is-fixed' : ''}`}>
      <table>
        {hasWidths && (
          <colgroup>
            {columns.map((column) => (
              <col key={column.label} style={column.width ? { width: column.width } : undefined} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {columns.map((column) => {
              const draggable = Boolean(onReorderColumn && column.key && !column.locked);
              const isDropTarget = draggable && dropIndicator?.key === column.key;
              return (
                <th
                  key={column.label}
                  className={[
                    column.className,
                    draggable ? 'is-draggable-column' : null,
                    isDropTarget ? `is-drop-${dropIndicator.side}` : null,
                  ].filter(Boolean).join(' ') || undefined}
                  draggable={draggable}
                  title={draggable ? `Drag to move "${column.label}"` : undefined}
                  onDragStart={draggable ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', column.key); } : undefined}
                  onDragOver={draggable ? (e) => {
                    e.preventDefault();
                    const side = sideOf(e);
                    setDropIndicator((prev) => (prev?.key === column.key && prev.side === side ? prev : { key: column.key, side }));
                  } : undefined}
                  onDragLeave={draggable ? () => setDropIndicator((prev) => (prev?.key === column.key ? null : prev)) : undefined}
                  onDragEnd={draggable ? () => setDropIndicator(null) : undefined}
                  onDrop={draggable ? (e) => {
                    e.preventDefault();
                    const dragKey = e.dataTransfer.getData('text/plain');
                    if (dragKey) onReorderColumn(dragKey, column.key, sideOf(e));
                    setDropIndicator(null);
                  } : undefined}
                >
                  {column.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const subContent = renderSubRow ? renderSubRow(row) : null;
            return (
              <Fragment key={rowKey(row, index)}>
                <tr
                  className={onRowClick ? 'is-clickable' : undefined}
                  onClick={onRowClick ? (e) => { if (!e.target.closest('button, a')) onRowClick(row); } : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.label} className={column.className}>{column.render ? column.render(row) : row[column.key]}</td>
                  ))}
                </tr>
                {subContent && (
                  <tr className="table-subrow">
                    <td colSpan={columns.length}>{subContent}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModuleLoader({ label = 'Loading module data' }) {
  return (
    <div className="module-loader" role="status" aria-live="polite">
      <div className="module-loader-card">
        <span className="module-loader-spinner" aria-hidden="true">
          <svg viewBox="0 0 50 50" width="44" height="44">
            <circle className="module-loader-track" cx="25" cy="25" r="20" fill="none" strokeWidth="5" />
            <circle className="module-loader-arc" cx="25" cy="25" r="20" fill="none" strokeWidth="5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="module-loader-label">{label}<span className="module-loader-dots" /></span>
      </div>

      <div className="skeleton-table" aria-hidden="true">
        <div className="skeleton-row skeleton-head">
          {Array.from({ length: 5 }).map((_, i) => <span className="skeleton-cell" key={i} />)}
        </div>
        {Array.from({ length: 5 }).map((_, r) => (
          <div className="skeleton-row" key={r} style={{ animationDelay: `${r * 0.08}s` }}>
            {Array.from({ length: 5 }).map((_, c) => <span className="skeleton-cell" key={c} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportPreview({ report }) {
  if (!report) {
    return <p className="empty-state">Choose a report type and filters to generate a preview.</p>;
  }

  const rows = report.rows ?? [];
  const columns = reportColumns(rows);

  return (
    <section>
      <div className="report-heading">
        <div>
          <h3>{report.report_type}</h3>
          <p>Generated by {report.generated_by} on {formatDate(report.generated_at)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="ghost-button"
            onClick={() => exportRowsToCsv(`${report.report_type.toLowerCase().replaceAll(' ', '-')}.csv`, reportExportColumns(rows), rows)}
            type="button"
          >
            Export CSV
          </button>
          <button className="ghost-button" onClick={() => window.print()} type="button">Print</button>
        </div>
      </div>
      <DataTable columns={columns} rows={rows} />

      {/* Print-only — kept off-screen (see .report-print-view), shown by the
          Print button above. Portaled to <body>, same reasoning as the
          vehicle profile's .veh-print-report: the app's @media print rule
          hides #root entirely, so the printable content has to live outside
          it or Print produces a blank page. */}
      {createPortal(
        <div className="report-print-view">
          <div className="veh-print-header">
            <div className="veh-print-header-left">
              <h2>{report.report_type}</h2>
              <p>Generated by {report.generated_by} on {formatDate(report.generated_at)}</p>
            </div>
            <div className="veh-print-header-right">
              <Icon name="gear" size={48} className="topbar-gear-icon" filled />
              <span className="vms-wordmark">vms</span>
            </div>
          </div>
          <table className="report-print-table">
            <thead>
              <tr>{columns.map((col) => <th key={col.label}>{col.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((row, i) => (
                <tr key={row.id ?? i}>{columns.map((col) => <td key={col.label}>{col.render(row)}</td>)}</tr>
              )) : (
                <tr><td colSpan={columns.length || 1}>No records</td></tr>
              )}
            </tbody>
          </table>
        </div>,
        document.body,
      )}
    </section>
  );
}

const emptyLookups = {
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

const emptyTicketLookups = {
  vehicles: [],
  custodians: [],
  maintenance_personnel: [],
  priorities: [],
  maintenance_types: [],
  ticket_statuses: [],
  sub_issue_statuses: [],
};

const CRITICALITY_LEVELS = ['Critical', 'High', 'Normal'];

// Colours for the fleet-condition donut on the dashboard.
const CONDITION_STAT_CARDS = [
  { key: 'Good', color: '#16a34a' },
  { key: 'Needs Inspection', color: '#0284c7' },
  { key: 'Needs Repair', color: '#d97706' },
  { key: 'Not Checked', color: '#64748b' },
];

function defaultCriticalityFor(vehicle, lookups) {
  return (lookups.categories ?? []).find((c) => String(c.category_id) === String(vehicle.category_id))?.default_criticality ?? 'Normal';
}

function vehicleCriticality(vehicle, lookups) {
  return vehicle.criticality ? `${vehicle.criticality} (set for this vehicle)` : `${defaultCriticalityFor(vehicle, lookups)} (from vehicle type)`;
}

const categoryFields = [
  { label: 'Vehicle Type Name', name: 'category_name', required: true, type: 'text', placeholder: 'e.g. Fire Truck, Rescue Boat' },
  {
    label: 'Domain', name: 'domain', options: ['Land', 'Water'], required: true, type: 'select',
    hint: 'Water changes what a vehicle of this type asks for elsewhere — hull material and engine type instead of the usual land specs.',
  },
  {
    label: 'Default Criticality', name: 'default_criticality', options: CRITICALITY_LEVELS, type: 'select',
    hint: 'How much a vehicle of this type matters operationally. Critical vehicles surface first on the readiness watch. Admin can override it per vehicle.',
  },
  { label: 'Description', name: 'description', type: 'textarea', placeholder: 'Optional notes about when to use this type' },
];

// `liveValues` lets Confirm Password become required only once a new
// password has actually been typed — editing an Admin resets someone
// else's password, so unlike the self-service My Profile flow there's
// deliberately no Current Password field: the whole point of an admin
// reset is that they don't (and shouldn't need to) know the old one.
function userFields(isEditing, liveValues = EMPTY_OBJ) {
  return [
    { label: 'Full Name', name: 'name', required: true, type: 'text' },
    { label: 'Email', name: 'email', required: true, type: 'text', placeholder: 'name@barangay.gov' },
    { label: 'Phone', name: 'phone', type: 'tel', pattern: '[0-9]{10}', placeholder: '09XXXXXXXXX', title: 'Phone must be exactly 10 digits' },
    { label: 'Address', name: 'address', type: 'text' },
    // Deliberately paired side by side, in this order, both NOT full-width:
    // the grid's dense auto-flow (App.css .form-grid-2col .smart-form)
    // only backfills gaps when one exists — keeping every field here a
    // plain single-column item, in strict declared order, means each row
    // fills left-then-right with no gaps for later fields to jump into
    // (which is what previously stranded Confirm Password alone).
    { label: 'Roles (a person can hold more than one — the first is their primary)', name: 'roles', options: ['Admin', 'Custodian', 'Maintenance Personnel'], required: true, type: 'checkboxes' },
    // Production-readiness audit finding #6 — vehicle registration is a
    // per-account delegation an Admin grants a specific Custodian, not a
    // blanket role grant. Only shown once Custodian is actually selected
    // above; Admin already always registers regardless of this flag.
    ...(Array.isArray(liveValues.roles) && liveValues.roles.includes('Custodian')
      ? [{
          label: 'Vehicle Registration',
          name: 'can_register_vehicles',
          options: ['Allow vehicle registration'],
          type: 'checkboxes',
        }]
      : []),
    { label: 'Profile Photo', name: 'photo', accept: 'image/*', type: 'file' },
    {
      label: isEditing ? 'New Password (leave blank to keep current)' : 'Password',
      name: 'password',
      required: !isEditing,
      type: 'password',
    },
    {
      label: isEditing ? 'Confirm New Password' : 'Confirm Password',
      name: 'password_confirmation',
      required: isEditing ? Boolean(liveValues.password) : true,
      type: 'password',
      confirmOf: 'password',
    },
  ];
}

const passwordFields = [
  { label: 'Old Password', name: 'old_password', required: true, type: 'password' },
  { label: 'New Password', name: 'new_password', required: true, type: 'password' },
  { label: 'Confirm New Password', name: 'new_password_confirmation', required: true, type: 'password', confirmOf: 'new_password' },
];

const FUEL_TYPE_OPTIONS = ['Diesel', 'Gasoline', 'Electric', 'Hybrid', 'CNG', 'LPG'];
const HULL_MATERIAL_OPTIONS = ['Fiberglass', 'Aluminum', 'Steel', 'Wood', 'Rubber/Inflatable'];

function capacityUnits(domain) {
  // 'pax' matters for a Water vehicle too — a rescue boat's key spec is how
  // many people it can carry, same reason it matters for an Ambulance.
  return domain === 'Water' ? ['L', 'gal', 'm³', 'pax'] : ['kg', 'tons', 'L', 'pax'];
}

// Same underlying column (plate_number) either way — a boat has no LTO
// plate, so the label/placeholder/validation just read right for whichever
// domain the vehicle actually is.
function plateFieldLabel(domain) {
  return domain === 'Water' ? 'Registration / Hull No.' : 'Plate Number';
}

function vehicleIconName(domain) {
  return domain === 'Water' ? 'boat' : 'vehicle';
}

function vehicleDomainFields(domain) {
  return domain === 'Water'
    ? [
        { label: 'Hull Material', name: 'hull_material', options: HULL_MATERIAL_OPTIONS, required: true, type: 'select' },
        { label: 'Engine Type', name: 'engine_type', required: true, type: 'text' },
        { label: 'Fuel Type', name: 'fuel_type', options: FUEL_TYPE_OPTIONS, required: true, type: 'select' },
      ]
    : [{ label: 'Fuel Type', name: 'fuel_type', options: FUEL_TYPE_OPTIONS, required: true, type: 'select' }];
}

// Admin-defined per-Vehicle-Type fields, rendered as ordinary form inputs
// named cf_<key> (the API folds them into custom_values).
function customFieldInputs(category, group) {
  return (category?.fields ?? []).filter((f) => f.is_active).map((f) => ({
    label: f.unit ? `${f.label} (${f.unit})` : f.label,
    name: `cf_${f.key}`,
    required: f.is_required,
    type: f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : (f.field_type === 'dropdown' || f.field_type === 'yes_no') ? 'select' : 'text',
    options: f.field_type === 'yes_no' ? ['Yes', 'No'] : (f.options ?? undefined),
    ...(group ? { group } : {}),
  }));
}

function vehicleWithCustomInitials(vehicle) {
  return { ...vehicle, ...Object.fromEntries(Object.entries(vehicle?.custom_values ?? {}).map(([k, v]) => [`cf_${k}`, v])) };
}

// Profile rows for a vehicle's custom values (archived fields still show what they hold).
function customValueRows(vehicle, lookups) {
  const category = (lookups.categories ?? []).find((c) => String(c.category_id) === String(vehicle.category_id));
  return (category?.fields ?? [])
    .filter((f) => vehicle.custom_values?.[f.key] != null && vehicle.custom_values[f.key] !== '')
    .map((f) => (
      <div key={f.key}><dt>{f.label}</dt><dd>{vehicle.custom_values[f.key]}{f.unit ? ` ${f.unit}` : ''}</dd></div>
    ));
}

const VEHICLE_WIZARD_STEP_LABELS = ['Basic Information', 'Specs', 'Photo & Location'];
const VEHICLE_WIZARD_STEP_ICONS = ['clipboard', 'wrench', 'pin'];

function NewVehiclePage({ onBack, lookups, allHubs, onSubmit, onDirty }) {
  // Persisted across a route change and back (e.g. adding a new Vehicle
  // Type mid-wizard opens its own page/modal) — see useDraftState.
  const [step, setStep] = useDraftState('draft:new-vehicle:step', 1);
  const [wizardData, setWizardData] = useDraftState('draft:new-vehicle:data', EMPTY_OBJ);
  const clearNewVehicleDraft = () => {
    clearDraftState('draft:new-vehicle:step');
    clearDraftState('draft:new-vehicle:data');
  };
  // Live-tracks the in-progress Category pick within step 1 (before it's
  // merged into wizardData on "Next") so the Vehicle Type options can
  // filter immediately, without resetting anything else the user has
  // already typed on this step. Re-synced from wizardData wherever `step`
  // actually changes (see setStep call sites below), not via an effect.
  const [domainFilter, setDomainFilter] = useState(wizardData.vehicle_domain ?? '');

  const domain = lookups.categories.find(
    (c) => String(c.category_id) === String(wizardData.category_id)
  )?.domain ?? 'Land';

  // Derived from the actual vehicle types on file, not hardcoded — so a
  // newly added domain (beyond today's Land/Water) just works here too.
  const domainOptions = [...new Set(lookups.categories.map((c) => c.domain).filter(Boolean))].sort();

  const stepFields = {
    1: [
      // Asked first, before the vehicle even has a name — everything else on
      // this step (the plate/registration field's label and pattern, which
      // vehicle types are offered below) depends on Land vs Water, so this
      // has to be answered before those can make sense.
      { label: 'Land or Water Vehicle', name: 'vehicle_domain', options: domainOptions, required: true, type: 'select' },
      { label: 'Vehicle Name', name: 'vehicle_name', required: true, type: 'text' },
      domainFilter === 'Water'
        ? {
            label: plateFieldLabel('Water'), name: 'plate_number', required: true, type: 'text',
            placeholder: 'e.g. HULL-24-01', uppercase: true, maxLength: 10,
          }
        : {
            label: plateFieldLabel('Land'), name: 'plate_number', required: true, type: 'text',
            // NOTE: browsers compile `pattern` with the strict `v` flag, where `\s`
            // inside a character class is invalid — use a literal space instead.
            placeholder: 'e.g. ABC 1234', pattern: '^[A-Za-z]{2,6}[ \\-]?\\d{2,6}[A-Za-z]?$',
            title: 'Enter a valid plate number, e.g. ABC 1234 or ABC-1234', uppercase: true, maxLength: 10,
          },
      {
        label: 'Vehicle Type',
        name: 'category_id',
        options: lookups.categories.filter((c) => c.domain === domainFilter),
        required: true,
        type: 'creatable-select',
        newItemLabel: 'vehicle type',
        catalogEndpoint: '/categories',
        idField: 'category_id',
        nameField: 'category_name',
        valueIsId: true,
        // Pre-fills the add-new-type modal's Domain field to match the
        // domain already picked above, instead of leaving it blank.
        extraFields: [{ name: 'domain', label: 'Domain', options: domainOptions.length ? domainOptions : ['Land', 'Water'], required: true, default: domainFilter || 'Land' }],
      },
    ],
    2: [
      { label: 'Brand', name: 'brand', required: true, type: 'text' },
      { label: 'Model', name: 'model', required: true, type: 'text' },
      { label: 'Year Model', name: 'year_model', required: true, type: 'number' },
      { label: 'Capacity', name: 'capacity', required: true, type: 'quantity', units: capacityUnits(domain) },
      // Optional — without it, the per-vehicle reliability lens' lifetime-
      // cost-vs-value (decommission signal) has nothing to compare against
      // and is just skipped for this vehicle (production-readiness audit
      // finding #7 — same field already existed on the Edit Vehicle form,
      // just never on registration itself).
      { label: 'Acquisition Cost (optional)', name: 'acquisition_cost', type: 'number', placeholder: 'e.g. 850000' },
      { label: 'Vehicle Color', name: 'vehicle_color', required: true, type: 'text' },
      ...vehicleDomainFields(domain),
      ...customFieldInputs(lookups.categories.find((c) => String(c.category_id) === String(wizardData.category_id))),
    ],
    3: [
      { label: 'Vehicle Photo', name: 'photo', accept: 'image/*', type: 'file', compactFile: true },
      {
        label: 'Current Location', name: 'current_location', options: allHubs, required: true, type: 'creatable-select',
        newItemLabel: 'location', catalogEndpoint: '/hubs', idField: 'hub_id', nameField: 'name',
        // A hub needs real coordinates to ever show up on the map, so
        // unlike Vehicle Type's Domain (a plain preset dropdown), these are
        // free-typed numbers with no sensible default to pre-fill.
        extraFields: [
          { name: 'lat', label: 'Latitude', type: 'number', required: true, placeholder: 'e.g. 10.3378' },
          { name: 'lng', label: 'Longitude', type: 'number', required: true, placeholder: 'e.g. 123.9422' },
        ],
        // Shows exactly where the hub is as soon as one is picked, instead
        // of leaving the location as just a name in a dropdown. Rendered
        // inline (inside this field's own cell, right under the select)
        // rather than as a separate full-width row, so it sits directly
        // beneath the dropdown and top-aligns with the photo box beside it
        // instead of leaving a gap where a taller sibling row would go.
        inlineExtra: (vals) => {
          const hub = allHubs.find((h) => h.name === vals.current_location);
          return hub ? (
            <div className="veh-map-wrap" style={{ height: 220 }}>
              <VehicleLocationMap lat={hub.lat} lng={hub.lng} label={hub.name} />
            </div>
          ) : null;
        },
      },
      { label: 'Remarks (optional)', name: 'remarks', type: 'textarea' },
    ],
  };

  const isLastStep = step === 3;

  // Also used by the wizard-step-pill "go back" clicks below, so
  // domainFilter always reflects whatever step 1 last had, whichever way
  // the user navigates back to it.
  const goToStep = (n) => {
    setDomainFilter(wizardData.vehicle_domain ?? '');
    setStep(n);
  };

  const handleStepSubmit = async (values) => {
    const merged = { ...wizardData, ...values };
    if (isLastStep) {
      const ok = await onSubmit(merged);
      if (ok !== false) clearNewVehicleDraft();
    } else {
      setWizardData(merged);
      setStep((s) => s + 1);
    }
  };

  return (
    <ModulePanel description="Register a new vehicle in the fleet — complete all three steps to add it.">
      <div className="wizard-steps" role="list" aria-label="Add vehicle steps">
        {VEHICLE_WIZARD_STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const state = step === n ? 'active' : step > n ? 'done' : 'upcoming';
          if (state === 'done') {
            return (
              <button
                key={label}
                type="button"
                className="wizard-step-pill is-done"
                role="listitem"
                onClick={() => goToStep(n)}
                title={`Go back to ${label}`}
              >
                <Icon name="checkCircle" size={16} />
                {label}
              </button>
            );
          }
          return (
            <div key={label} className={`wizard-step-pill is-${state}`} role="listitem">
              <Icon name={VEHICLE_WIZARD_STEP_ICONS[i]} size={16} />
              {label}
            </div>
          );
        })}
      </div>
      <div className={`form-grid-2col${step === 3 ? ' wizard-photo-location-grid' : ''}`}>
        <SmartForm
          fields={stepFields[step]}
          initialValues={wizardData}
          key={step}
          cancelLabel={step === 1 ? 'Cancel' : 'Back'}
          onCancel={step === 1 ? () => { clearNewVehicleDraft(); onBack(); } : () => goToStep(step - 1)}
          onSubmit={handleStepSubmit}
          onValuesChange={(vals) => { setDomainFilter(vals.vehicle_domain ?? ''); onDirty?.(); }}
          submitLabel={isLastStep ? 'Add Vehicle' : 'Next'}
          title=""
        />
      </div>
    </ModulePanel>
  );
}

// Formats one form field's live value for the Entry Summary card — resolves a
// select's option label and pretty-prints dates; returns null when unanswered.
function formSummaryValue(field, raw) {
  if (raw == null || raw === '') return null;
  if (field.type === 'select' && Array.isArray(field.options)) {
    const opt = field.options.find((o) => String(o?.value ?? o) === String(raw));
    const label = opt?.label ?? opt;
    if (label != null) return String(label);
  }
  if (field.type === 'date') return formatForecastDate(raw) || String(raw);
  if (field.type === 'list') {
    const rows = (Array.isArray(raw) ? raw : [raw]).map((r) => String(r).trim()).filter(Boolean);
    return rows.length ? rows.join(' · ') : null;
  }
  if (field.type === 'multi-file') {
    const count = Array.isArray(raw) ? raw.length : 0;
    return count ? `${count} file${count === 1 ? '' : 's'} selected` : null;
  }
  return String(raw);
}

// Generic single-form page — used for every simple create/edit flow (Vehicle
// Types, Maintenance Schedules, Condition Checks, Issue Reports) that doesn't
// need its own multi-tab profile like vehicles/tickets do.
// When `contextVehicles` is provided, the page renders Realcore-style: the form
// fields sit in a card on the right, and the left side live-previews the
// selected vehicle (photo, info, location map) as the user picks one.
function FormPage({ description, onBack, fields, initialValues, onSubmit, submitLabel, contextVehicles, hubs, warnEndpoint, warnRender, reviewStep = false, wrapperClassName, formTitle = '', onDirty, showDomainPreview = false, categoryVehicleCount = null }) {
  // Scoped to this exact route (new-X vs. editing record #N are different
  // paths) so a form's in-progress values survive clicking a "view" link
  // (e.g. the selected vehicle/custodian's name) and coming Back, instead of
  // resetting because the page component fully unmounted and remounted —
  // see useDraftState.
  const location = useLocation();
  const draftKey = `draft:form:${location.pathname}`;
  const [liveValues, setLiveValues] = useDraftState(draftKey, initialValues ?? EMPTY_OBJ);
  // SmartForm keeps its own internal `values`, seeded once from whatever
  // `initialValues` prop it's given — passing the plain `initialValues` prop
  // straight through (as before) would silently discard the restored draft,
  // since SmartForm would seed itself from the pre-draft original instead.
  // This snapshot starts as the restored `liveValues` but, unlike liveValues,
  // does NOT track every keystroke (only the reset effect below updates it),
  // so it stays a stable reference SmartForm won't re-sync against mid-typing.
  const [smartFormSeed, setSmartFormSeed] = useState(() => liveValues);
  const [warnRows, setWarnRows] = useState([]);
  // Opt-in two-step flow (Maintenance Records today): fill the fields, hit
  // Next, then review everything on its own full-width step before it
  // actually saves — instead of a live summary sidebar fighting the form for
  // space the whole time it's being filled in. Every other FormPage caller
  // leaves reviewStep unset and keeps the original single-step behavior.
  const [step, setStep] = useState(1);
  const [confirming, setConfirming] = useState(false);

  // Skips its first run (which would otherwise immediately overwrite a
  // restored draft with the plain initialValues right after mount) — still
  // resets on every later change, e.g. once `initialValues` itself finishes
  // loading in from the server.
  const skippedFirstReset = useRef(false);
  useEffect(() => {
    if (!skippedFirstReset.current) { skippedFirstReset.current = true; return; }
    setLiveValues(initialValues ?? EMPTY_OBJ);
    setSmartFormSeed(initialValues ?? EMPTY_OBJ);
    setStep(1);
  }, [initialValues]);

  const hasContext = Boolean(contextVehicles?.length);
  const vehicle = hasContext
    ? contextVehicles.find((v) => String(v.vehicle_id) === String(liveValues?.vehicle_id))
    : null;
  const hub = vehicle ? (hubs ?? []).find((h) => h.name === vehicle.current_location) : null;

  // #7 — when a warn endpoint is provided (e.g. open issues on this vehicle),
  // fetch it as the vehicle is picked so the form can show a duplicate warning.
  const warnVehicleId = liveValues?.vehicle_id ?? null;
  useEffect(() => {
    if (!warnEndpoint || !warnVehicleId) { setWarnRows([]); return; }
    let cancelled = false;
    api.get(warnEndpoint(warnVehicleId))
      .then((r) => { if (!cancelled) setWarnRows(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (!cancelled) setWarnRows([]); });
    return () => { cancelled = true; };
  }, [warnEndpoint, warnVehicleId]);

  // `fields` may be a function of the live values so a form can grow extra
  // fields in response to what the user picked (e.g. "+ Add New Issue").
  const resolvedFields = typeof fields === 'function' ? fields(liveValues) : fields;

  const handleReviewConfirm = async () => {
    setConfirming(true);
    try {
      const ok = await onSubmit(liveValues);
      if (ok !== false) clearDraftState(draftKey);
    } finally {
      setConfirming(false);
    }
  };

  // Reused on its own in the plain sidebar layout, and folded into the
  // review step (together with the field summary) when reviewStep is on —
  // "put this together with the summary in the next section" instead of it
  // sitting in a separate persistent side panel throughout.
  const vehicleInfoCard = vehicle ? (
    <section className="veh-card">
      <div className="veh-card-head"><Icon name={vehicleIconName(vehicle.category?.domain)} size={16} /><h4>Selected Vehicle</h4></div>
      {vehicle.photo_url && (
        <div className="form-context-photo">
          <img src={resolvePhotoUrl(vehicle.photo_url)} alt={vehicle.vehicle_name} />
        </div>
      )}
      <dl className="veh-kv">
        <div><dt>Vehicle</dt><dd>{vehicle.vehicle_name}</dd></div>
        <div><dt>{plateFieldLabel(vehicle.category?.domain)}</dt><dd>{vehicle.plate_number}</dd></div>
        <div><dt>Type</dt><dd>{vehicle.category?.category_name ?? 'Unassigned'}</dd></div>
        <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
        <div><dt>Status</dt><dd><StatusBadge value={vehicle.status} /></dd></div>
        <div><dt>Condition</dt><dd><StatusBadge value={vehicle.condition} /></dd></div>
      </dl>
    </section>
  ) : null;

  const form = reviewStep && step === 2 ? (
    <div className="form-review-step">
      <h3 className="form-review-title">Review before saving</h3>
      {vehicleInfoCard}
      <dl className="veh-kv form-review-grid">
        {resolvedFields.filter((f) => f.name !== 'vehicle_id' && f.type !== 'file').map((f) => {
          const val = formSummaryValue(f, liveValues?.[f.name]);
          return (
            <div key={f.name}>
              <dt>{f.label}</dt>
              <dd className={val ? 'summary-val' : 'summary-empty'}>{val ?? '—'}</dd>
            </div>
          );
        })}
      </dl>
      <div className="form-review-actions">
        <button type="button" className="ghost-button" onClick={() => setStep(1)} disabled={confirming}>Back</button>
        <button type="button" className="primary-button" onClick={handleReviewConfirm} disabled={confirming}>
          {confirming ? 'Saving…' : `Confirm & ${submitLabel}`}
        </button>
      </div>
    </div>
  ) : (
    <>
      {warnRender && warnRows.length > 0 ? warnRender(warnRows) : null}
      <SmartForm
        fields={resolvedFields}
        initialValues={smartFormSeed}
        onCancel={() => { clearDraftState(draftKey); onBack(); }}
        onSubmit={reviewStep ? (payload) => { setLiveValues(payload); setStep(2); } : async (payload) => {
          const ok = await onSubmit(payload);
          if (ok !== false) clearDraftState(draftKey);
          return ok;
        }}
        onValuesChange={(vals) => { setLiveValues(vals); onDirty?.(); }}
        submitLabel={reviewStep ? 'Next' : submitLabel}
        title={formTitle}
      />
    </>
  );

  // reviewStep forms skip the persistent side panel entirely — step 1 gets
  // the form full-width (no vehicle card competing for space while typing),
  // and step 2 (above) folds the vehicle card back in alongside the summary.
  const useSideLayout = (hasContext || showDomainPreview) && !reviewStep;

  // Live preview of what a vehicle's own Add/Edit form will ask for once
  // it's assigned this Vehicle Type — so picking Land vs Water here shows
  // its consequence immediately, instead of only being discovered later
  // when actually adding a vehicle of this type.
  const previewDomain = liveValues?.domain || 'Land';
  const domainPreviewFields = [
    { label: plateFieldLabel(previewDomain), note: previewDomain === 'Water' ? 'registration / hull number' : 'plate number' },
    { label: 'Capacity', note: `in ${capacityUnits(previewDomain).join(', ')}` },
    ...vehicleDomainFields(previewDomain).map((f) => ({ label: f.label, note: f.options ? f.options.slice(0, 3).join(', ') + (f.options.length > 3 ? '…' : '') : 'free text' })),
  ];

  return (
    <ModulePanel description={description}>
      {useSideLayout ? (
        <div className="form-context-layout">
          <div className="form-context-side">
            {showDomainPreview ? (
              <section className="veh-card">
                <div className="veh-card-head"><Icon name={vehicleIconName(previewDomain)} size={16} /><h4>{previewDomain} Vehicle Fields</h4></div>
                <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.8rem' }}>
                  A vehicle assigned this type will additionally ask for:
                </p>
                <dl className="veh-kv">
                  {domainPreviewFields.map((f) => (
                    <div key={f.label}><dt>{f.label}</dt><dd>{f.note}</dd></div>
                  ))}
                </dl>
              </section>
            ) : null}
            {/* Edit only — so a rename/domain change doesn't blindly affect
                a whole fleet without the Admin realizing it first. */}
            {showDomainPreview && categoryVehicleCount != null && (
              <section className="veh-card">
                <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicles Using This Type</h4></div>
                <p style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>{categoryVehicleCount}</p>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.8rem' }}>
                  {categoryVehicleCount ? 'Renaming or switching domain affects every one of these.' : 'No vehicles assigned this type yet.'}
                </p>
              </section>
            )}
            {showDomainPreview ? null : vehicle ? (
              vehicleInfoCard
            ) : (
              <section className="veh-card form-context-empty">
                <Icon name="vehicle" size={30} />
                <p>Select a vehicle in the form and its photo, details, and location will show here.</p>
              </section>
            )}

            {vehicle && !showDomainPreview && (
              <section className="veh-card">
                <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Entry Summary</h4></div>
                <dl className="veh-kv">
                  {resolvedFields.filter((f) => f.name !== 'vehicle_id' && f.type !== 'file').map((f) => {
                    const val = formSummaryValue(f, liveValues?.[f.name]);
                    return (
                      <div key={f.name}>
                        <dt>{f.label}</dt>
                        <dd className={val ? 'summary-val' : 'summary-empty'}>{val ?? '—'}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            )}

          </div>
          <div className="form-context-form-col">
            <div className={`form-grid-2col form-context-form${wrapperClassName ? ` ${wrapperClassName}` : ''}`}>{form}</div>
            {/* Stacked below the form fields, inside the same column, so it
                fills the free space the form's shorter height leaves behind
                instead of floating full-width beneath both columns. */}
            {vehicle && !showDomainPreview && (
              <section className="veh-card form-context-map-inline">
                <div className="veh-card-head"><Icon name="pin" size={16} /><h4>{vehicle.current_location ?? 'Location unknown'}</h4></div>
                <div className="veh-map-wrap form-context-map-expanded">
                  <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} />
                </div>
              </section>
            )}
          </div>
        </div>
      ) : (
        <div className={`form-grid-2col${wrapperClassName ? ` ${wrapperClassName}` : ''}`}>{form}</div>
      )}
    </ModulePanel>
  );
}

function vehicleFields(lookups, allHubs = [], domain = 'Land', existingPhotoUrl = null, category = null) {
  const hubOptions = allHubs.map((hub) => ({ value: hub.name, label: hub.name }));

  return [
    { label: 'Vehicle Name', name: 'vehicle_name', required: true, type: 'text', group: 'Vehicle identity' },
    { label: plateFieldLabel(domain), name: 'plate_number', required: true, type: 'text', maxLength: 10, group: 'Vehicle identity' },
    { label: 'Vehicle Type', name: 'category_id', options: lookups.categories ?? [], required: true, type: 'creatable-select', group: 'Vehicle identity',
      newItemLabel: 'vehicle type', catalogEndpoint: '/categories', idField: 'category_id', nameField: 'category_name', valueIsId: true,
      extraFields: [{ name: 'domain', label: 'Domain', options: ['Land', 'Water'], required: true, default: domain }],
    },
    { label: 'Operational Criticality (override)', name: 'criticality', options: [...CRITICALITY_LEVELS, 'Inherit'], type: 'select', group: 'Vehicle identity', hint: 'Choose Inherit to use the Vehicle Type default.' },
    { label: 'Vehicle Photo', name: 'photo', accept: 'image/*', type: 'file', existingUrl: existingPhotoUrl, group: 'Vehicle photo' },
    { label: 'Brand', name: 'brand', required: true, type: 'text', group: 'Technical details' },
    { label: 'Model', name: 'model', required: true, type: 'text', group: 'Technical details' },
    { label: 'Year Model', name: 'year_model', required: true, type: 'number', group: 'Technical details' },
    { label: 'Capacity', name: 'capacity', required: true, type: 'quantity', units: capacityUnits(domain), group: 'Technical details' },
    // #10 — optional; without it, lifetime-cost-vs-value (decommission signal)
    // simply has nothing to compare against and is skipped for this vehicle.
    { label: 'Acquisition Cost (optional)', name: 'acquisition_cost', type: 'number', placeholder: 'e.g. 850000', group: 'Technical details' },
    { label: 'Vehicle Color', name: 'vehicle_color', required: true, type: 'text', group: 'Technical details' },
    ...vehicleDomainFields(domain).map((field) => ({ ...field, group: 'Technical details' })),
    ...customFieldInputs(category, 'Technical details'),
    {
      label: 'Current Location', name: 'current_location', options: hubOptions, required: true, type: 'select', group: 'Location & service availability',
      // Full-width (not inline in the select's own half-column) — this map
      // needs real width to read as a map, not a cramped strip. Reflects
      // whatever is currently picked, not just what the vehicle loaded
      // with — re-looks-up the hub from the live form value on every
      // change, so switching the dropdown always re-populates it.
      extra: (vals) => {
        const hub = allHubs.find((h) => h.name === vals.current_location);
        return hub ? (
          <div className="veh-map-wrap" style={{ height: 320 }}>
            <VehicleLocationMap lat={hub.lat} lng={hub.lng} label={hub.name} />
          </div>
        ) : null;
      },
    },
    // Production-readiness audit finding #7 — was accepted by the API and
    // shown read-only on the profile, but had no way to actually be edited.
    { label: 'Remarks (optional)', name: 'remarks', type: 'textarea', group: 'Location & service availability' },
  ];
}

function scheduleFields(lookups, allHubs = [], isEdit = false, suggestOnly = false) {
  const hubOptions = allHubs.map((hub) => ({ value: hub.name, label: hub.name }));

  // A Custodian's suggestion only needs what Admin must see: which vehicle,
  // what, roughly when, and why.
  const keep = suggestOnly ? ['vehicle_id', 'maintenance_type', 'scheduled_date', 'notes'] : null;
  const all = [
    { label: 'Vehicle', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select' },
    { label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types, required: true, type: 'creatable-select', newItemLabel: 'maintenance type', catalogEndpoint: '/maintenance-types' },
    { label: 'Scheduled Date', name: 'scheduled_date', required: true, type: 'date' },
    { label: 'Scheduled Time', name: 'scheduled_time', type: 'time' },
    // Recurring PM: completing this schedule auto-creates the next at the chosen
    // interval. Left blank = one-time (the default "Select" option).
    {
      label: 'Repeat Every (optional)',
      name: 'recurrence_months',
      type: 'select-or-other',
      options: [
        { value: 1, label: 'Month' },
        { value: 3, label: 'Quarter (3 months)' },
        { value: 6, label: '6 Months' },
        { value: 12, label: 'Year' },
      ],
      otherLabel: 'Add Custom Month',
      otherPlaceholder: 'e.g. 4',
      otherSuffix: 'months',
      otherType: 'number',
      otherMin: 1,
      otherMax: 60,
    },
    // A known hub, or "Other" for an outside repair shop not in that list.
    { label: 'Service Location', name: 'service_location', type: 'select-or-other', options: hubOptions, otherLabel: 'Other / External Shop', otherPlaceholder: 'e.g. Toyota Service Center' },
    // Full-width only on create: with Status hidden there, it's the trailing
    // odd-one-out in the 2-column grid — spanning the full row reads as
    // intentional instead of leaving an empty cell beside it. On edit, Status
    // sits next to it instead, making the pair even again.
    { label: 'Assigned To', name: 'assigned_to', options: options(lookups.maintenance_personnel, 'id', 'name'), type: 'select', fullWidth: !isEdit },
    // Completed is deliberately never offered here — marking a schedule done
    // goes through the dedicated "Mark Done" action (creates the proof-of-work
    // record and, if recurring, the next occurrence); this field only ever
    // needs to cancel an existing one. Not shown at all when creating new.
    ...(isEdit ? [{ label: 'Status', name: 'status', options: ['Scheduled', 'Cancelled'], type: 'select' }] : []),
    { label: 'Notes', name: 'notes', type: 'textarea' },
  ];
  return keep ? all.filter((f) => keep.includes(f.name)) : all;
}

const REPORT_CATALOG = [
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

function reportFieldDefs(lookups, reportDef) {
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
const REPORT_CATEGORY_TONES = ['blue', 'green', 'purple', 'amber'];

function ReportsModule({ lookups, onGenerate }) {
  // Only one report's form is open at a time, across all categories — same
  // "pick one thing to act on" feel as the reference's report catalog,
  // and it means Generate only ever appears once on screen.
  const [expandedType, setExpandedType] = useState(null);

  return (
    <div className="report-catalog-grid">
      {REPORT_CATALOG.map((group, i) => (
        <section key={group.category} className={`report-category-card tone-${REPORT_CATEGORY_TONES[i % REPORT_CATEGORY_TONES.length]}`}>
          <div className="report-category-card-head">
            <span className="report-category-card-icon"><Icon name={group.icon} size={16} /></span>
            <h4>{group.category}</h4>
            <span className="report-category-count">{group.reports.length}</span>
          </div>
          <div className="report-category-card-body">
            {group.reports.map((r) => {
              const isOpen = expandedType === r.type;
              return (
                <div key={r.type} className={`report-type-row${isOpen ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="report-type-item"
                    onClick={() => setExpandedType((t) => (t === r.type ? null : r.type))}
                    aria-expanded={isOpen}
                  >
                    <span className="report-type-icon"><Icon name={r.icon} size={15} /></span>
                    <span className="report-type-text">
                      <strong>{r.type}</strong>
                      <span>{r.description}</span>
                    </span>
                    <Icon name="chevronDown" size={14} className={isOpen ? 'is-expanded' : ''} />
                  </button>
                  {isOpen && (
                    <div className="report-generator-panel">
                      <SmartForm
                        fields={reportFieldDefs(lookups, r)}
                        key={r.type}
                        onSubmit={(values) => onGenerate({ report_type: r.type, ...values })}
                        submitLabel="Generate Report"
                        title=""
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// Icon/color per dashboard top-metric label, keyed by the exact label text the
// backend returns (varies per role) — falls back to a plain blue chip for any
// label not explicitly mapped.
const DASHBOARD_METRIC_STYLES = {
  'Total Vehicles': { icon: 'grid', bg: '#dbeafe', color: '#2563eb' },
  'Available Vehicles': { icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  'Vehicles Under Maintenance': { icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  'Inactive Vehicles': { icon: 'archive', bg: '#fee2e2', color: '#dc2626' },
  'Reported Issues': { icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
  'Reported Vehicle Issues': { icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
  'My Reported Issues': { icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
  'Upcoming Maintenance': { icon: 'calendar', bg: '#ede9fe', color: '#7c3aed' },
  'Overdue Maintenance': { icon: 'alert', bg: '#fef3c7', color: '#d97706' },
  'Total Maintenance Expenses': { icon: 'clipboard', bg: '#e0f2fe', color: '#0284c7' },
  'Maintenance Records': { icon: 'clipboard', bg: '#e0f2fe', color: '#0284c7' },
  'Recently Completed Maintenance': { icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  'Vehicles Needing Attention': { icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
};
const DASHBOARD_METRIC_STYLE_DEFAULT = { icon: 'grid', bg: '#dbeafe', color: '#2563eb' };

// NOTE: no "In Use" card — the status exists in the DB enum but this system
// tracks availability only (no dispatch flow ever sets a vehicle to In Use).
const VEHICLE_STAT_CARDS = [
  { key: 'Available', label: 'Available', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'Under Maintenance', label: 'Under Maintenance', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'Inactive', label: 'Inactive', icon: 'archive', bg: '#fee2e2', color: '#dc2626' },
  // Distinct from "Available" — a vehicle can be Available yet never (or no
  // longer) proven ready by an actual readiness check. See responseReadinessState().
  { key: 'ReadyToRespond', label: 'Ready to Respond', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'NotReady', label: 'Not Ready to Respond', icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
];

// "Scheduled" used to be one bucket — now split into 4 urgency buckets (how
// soon each row is due) so an Admin/Mechanic can spot what needs attention
// today vs what's still days out, instead of one undifferentiated count.
const SCHEDULE_STAT_CARDS = [
  { key: 'Overdue', label: 'Due Today / Overdue', icon: 'alert', bg: '#fee2e2', color: '#dc2626' },
  { key: 'Due1to3', label: '1 - 3 Days', icon: 'calendar', bg: '#ffedd5', color: '#c2410c' },
  { key: 'Due4to7', label: '4 - 7 Days', icon: 'calendar', bg: '#fef3c7', color: '#d97706' },
  { key: 'Completed', label: 'Completed', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  // A schedule marked "Completed" only means the calendar task is done —
  // its record might still be sitting unverified. Its own filter so those
  // rows are findable instead of scrolling through fully-verified ones.
  { key: 'AwaitingVerification', label: 'Awaiting Verification', icon: 'search', bg: '#fef9c3', color: '#854d0e' },
  { key: 'Cancelled', label: 'Cancelled', icon: 'close', bg: '#f1f5f9', color: '#64748b' },
];

// Only shown to a Maintenance-Personnel-only viewer — "how many vehicles do
// I still need to do", not the fleet-wide count everyone else also sees.
const MY_ASSIGNED_SCHEDULE_CARD = { key: 'MyAssigned', label: 'Assigned to You', icon: 'wrench', bg: '#eff6ff', color: '#1d4ed8' };

const TICKET_STAT_CARDS = [
  { key: 'Open', label: 'Open', icon: 'alert', bg: '#e0f2fe', color: '#0284c7' },
  // Custodian-proposed tickets awaiting Admin approve/decline — a distinct
  // bucket from 'Open' (Admin-created, already dispatched for inspection).
  { key: 'Pending Approval', label: 'Proposals', icon: 'clipboard', bg: '#fef9c3', color: '#a16207' },
  { key: 'Active', label: 'Active', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'Closed', label: 'Closed', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
  { key: 'Cancelled', label: 'Cancelled', icon: 'close', bg: '#fee2e2', color: '#dc2626' },
];

const TICKET_WORK_ORDER_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'wrench', bg: '#fef3c7', color: '#d97706' },
  { key: 'Submitted', label: 'Submitted', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

const TICKET_VERIFICATION_STAT_CARDS = [
  { key: 'Pending', label: 'Pending', icon: 'checkCircle', bg: '#fef3c7', color: '#d97706' },
  { key: 'Verified', label: 'Verified', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

const WORK_TRACKER_STAT_CARDS = [
  { key: 'attention', label: 'Needs Your Action', icon: 'alert', bg: '#fef3c7', color: '#d97706' },
  { key: 'progress', label: 'In Progress', icon: 'wrench', bg: '#e0f2fe', color: '#0284c7' },
  { key: 'completed', label: 'Completed', icon: 'checkCircle', bg: '#dcfce7', color: '#16a34a' },
];

// Reusable "Total + clickable status breakdown" card row, sitting above a
// module's table, matching the Vehicle Management stat cards exactly.
// `cards` is [{ key, label, icon, bg, color }]; `counts` maps key -> number;
// clicking a card toggles `activeFilter` via `onFilterChange`.
function ModuleStatCards({ totalLabel = 'Total', total, cards, counts, activeFilter, onFilterChange, gridClassName = '' }) {
  const isFilterMulti = Array.isArray(activeFilter);
  const isTotalActive = isFilterMulti ? activeFilter.length === 0 : !activeFilter;
  return (
    <section className={`metric-grid${gridClassName ? ` ${gridClassName}` : ''}`} aria-label="Status summary" style={{ marginBottom: '16px' }}>
      <button
        type="button"
        className={`metric-card metric-card-iconic stat-filter-card${isTotalActive ? ' is-active' : ''}`}
        style={{
          cursor: 'pointer',
          boxShadow: isTotalActive ? '0 0 0 2px #2563eb' : undefined,
        }}
        onClick={() => onFilterChange(isFilterMulti ? [] : '')}
        title={`Show all ${totalLabel.replace(/^Total\s*/i, '') || 'items'}`.trim()}
      >
        <span className="metric-card-icon is-total">
          <Icon name="grid" size={18} />
        </span>
        <div className="metric-card-body">
          <span>{totalLabel}</span>
          <strong>{total}</strong>
        </div>
      </button>
      {cards.map(({ key, label, icon, bg, color }) => {
        // activeFilter is a plain string in some modules (a dedicated
        // single-purpose bucket filter) and an array in others (the shared
        // filter state now that FilterBar's dropdowns are multi-select) —
        // support both without forcing every caller to convert.
        const isMulti = Array.isArray(activeFilter);
        const isActive = isMulti ? (activeFilter.length === 1 && activeFilter[0] === key) : activeFilter === key;
        return (
          <button
            key={key}
            type="button"
            className={`metric-card metric-card-iconic stat-filter-card${isActive ? ' is-active' : ''}`}
            style={{
              cursor: 'pointer',
              boxShadow: isActive ? `0 0 0 2px ${color}` : undefined,
            }}
            onClick={() => onFilterChange(isActive ? (isMulti ? [] : '') : (isMulti ? [key] : key))}
            title={`Filter: ${label}`}
          >
            <span className="metric-card-icon" style={{ background: bg, color }}>
              <Icon name={icon} size={18} />
            </span>
            <div className="metric-card-body">
              <span>{label}</span>
              <strong>{counts[key] ?? 0}</strong>
            </div>
          </button>
        );
      })}
    </section>
  );
}

function vehicleColumns(user, onEdit, deleteRecord, restoreRecord, filterStatus, onViewTicket, onReadinessCheck) {
  const columns = [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.vehicle_id },
    {
      key: 'vehicle',
      label: 'Vehicle',
      locked: true,
      render: (row) => (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <PhotoCell alt={row.vehicle_name} url={row.photo_url} />
          <span className="row-title-text">{row.vehicle_name}</span>
        </div>
      ),
    },
    { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.plate_number },
    { key: 'type', label: 'Type', render: (row) => row.category?.category_name ?? 'Unassigned' },
    { key: 'brand_model', label: 'Brand / Model', render: (row) => `${row.brand} ${row.model}` },
    { key: 'capacity', label: 'Capacity', className: 'cell-center', render: (row) => row.capacity },
    { key: 'location', label: 'Location', render: (row) => row.current_location },
    {
      key: 'status',
      label: 'Status',
      className: 'cell-center',
      render: (row) => (
        // centered (not flex-start) so it lines up with every other badge
        // column — a plain <StatusBadge> centers on its own (see
        // `tbody td:has(> .status-badge)` in App.css), but wrapping it in
        // this div to stack the optional second badge below it opts back
        // out of that automatic centering, so it's set explicitly here.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
          <StatusBadge value={row.status} />
          {/* "Under Maintenance" alone doesn't say whether a mechanic is
              still actively working on it, or the ticket has nothing left
              to do and is just waiting on Admin to click Close — often
              because the last item was deferred for an emergency and
              nobody circled back. This makes that second case visible at a
              glance instead of looking identical to genuine active repair. */}
          {row.awaiting_closure && (
            <span
              className="status-badge awaiting-closure"
              title="Every sub-issue on this vehicle's open ticket is resolved (done or deferred) — it's just waiting for Admin to click Close Ticket to return it to Available."
            >
              <Icon name="checkCircle" size={11} /> Awaiting Closure
            </span>
          )}
        </div>
      ),
    },
    { key: 'condition', label: 'Condition', className: 'cell-center', render: (row) => <StatusBadge value={row.condition} /> },
    {
      key: 'ready',
      label: 'Ready to Respond',
      // A custom-styled pill, not <StatusBadge>, so it misses the
      // `tbody td:has(> .status-badge)` auto-centering — centered
      // explicitly instead.
      className: 'cell-center',
      render: (row) => {
        const badge = READINESS_BADGE[row.readiness_state];
        if (!badge) return <span className="muted">—</span>;
        return (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.74rem', fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: badge.bg, color: badge.color, border: `1px solid ${badge.border}`, whiteSpace: 'nowrap' }}
            title={row.readiness_last_checked ? `Last checked ${formatDate(row.readiness_last_checked)}` : undefined}
          >
            <Icon name={badge.icon} size={11} /> {badge.label}
          </span>
        );
      },
    },
    {
      key: 'usage',
      label: 'Usage',
      className: 'cell-center',
      // Usage is its own indicator — never a fleet status. Blank for a vehicle
      // that can't be used at all (retired / in maintenance).
      render: (row) => {
        if (row.usage_state === 'out') {
          return (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.74rem', fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', whiteSpace: 'nowrap' }}
              title={row.usage_purpose ? `${row.usage_purpose} — out since ${formatDate(row.usage_since)}` : undefined}
            >
              Currently Out
            </span>
          );
        }
        if (row.readiness_state === 'retired' || row.status === 'Under Maintenance') return <span className="muted">—</span>;
        return <span style={{ display: 'inline-flex', fontSize: '0.74rem', fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', whiteSpace: 'nowrap' }}>At Base</span>;
      },
    },
  ];

  if (filterStatus?.includes?.('Inactive')) {
    columns.push(
      { key: 'archived_at', label: 'Archived At', className: 'cell-center', render: (row) => <DateBadge value={row.archived_at} /> },
      { key: 'archived_by', label: 'Archived By', className: 'cell-center', render: (row) => <UserAvatarName user={row.archived_by} fallback="—" /> },
    );
  }

  const canEditVehicle = canDo(user, 'vehicle.edit');
  const canRestoreVehicle = canDo(user, 'vehicle.restore');
  const canArchiveVehicle = canDo(user, 'vehicle.archive');
  // Readiness checks are a Custodian's hands-on job — give them an Action
  // column even though they can't edit/restore/archive vehicles.
  const canCheckReadiness = canDo(user, 'vehicle.readiness_check') && !!onReadinessCheck;
  if (canEditVehicle || canRestoreVehicle || canArchiveVehicle || canCheckReadiness) {
    columns.push({
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions">
          {/* Jumps straight to whatever ticket is keeping this vehicle
              unavailable — no need to go hunt for it in Maintenance Tickets.
              A same-size invisible spacer holds this slot when absent, so
              Edit/Delete always land in the same column across rows instead
              of shifting depending on whether a row has this button. */}
          {row.open_ticket_id && onViewTicket ? (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.open_ticket_id })} type="button" title={`View Ticket #${row.open_ticket_id}`} aria-label={`View Ticket #${row.open_ticket_id}`}><Icon name="ticket" size={14} /></button>
          ) : (
            <span className="icon-btn-spacer" aria-hidden="true" />
          )}
          {canCheckReadiness && (
            (row.status === 'Inactive' || row.status === 'Decommissioned') ? (
              <span className="icon-btn-spacer" aria-hidden="true" />
            ) : (
              <button className="btn-confirm-action icon-btn" onClick={() => onReadinessCheck(row)} type="button" title="Record Readiness Check" aria-label="Record Readiness Check"><Icon name="checkCircle" size={14} /></button>
            )
          )}
          {(row.status === 'Inactive' || row.status === 'Decommissioned') ? (
            canRestoreVehicle && (
              <button className="btn-edit-action icon-btn" onClick={() => restoreRecord(`/vehicles/${row.vehicle_id}/restore`, row.status === 'Decommissioned' ? 'Vehicle recommissioned.' : 'Vehicle restored.')} type="button" title={row.status === 'Decommissioned' ? 'Recommission' : 'Restore'} aria-label="Restore"><Icon name="undo" size={14} /></button>
            )
          ) : (
            canArchiveVehicle && (
              <button className="btn-archive-action icon-btn" onClick={() => deleteRecord(`/vehicles/${row.vehicle_id}`, 'Vehicle marked inactive.', `Deactivate ${row.vehicle_name}? It will be marked Inactive and can be restored later.`)} type="button" title="Deactivate (reversible)" aria-label="Deactivate"><Icon name="archive" size={14} /></button>
            )
          )}
        </div>
      ),
    });
  }

  return columns;
}

function categoryColumns(onEdit, deleteRecord) {
  return [
    { key: 'id', label: 'ID', width: '6%', locked: true, className: 'cell-center', render: (row) => row.category_id },
    { key: 'category', label: 'Vehicle Type', width: '18%', render: (row) => row.category_name },
    { key: 'domain', label: 'Domain', width: '10%', className: 'cell-center', render: (row) => <StatusBadge value={row.domain ?? 'Land'} /> },
    { key: 'vehicles', label: 'Vehicles', width: '9%', className: 'cell-center', render: (row) => row.vehicles_count ?? 0 },
    { key: 'description', label: 'Description', width: '49%', render: (row) => row.description ?? '-' },
    {
      key: 'action',
      label: 'Action',
      width: '8%',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions">
          <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          <button className="btn-delete-action icon-btn" onClick={() => deleteRecord(`/categories/${row.category_id}`, 'Category deleted.', `Delete the "${row.category_name}" vehicle type? This cannot be undone.`)} type="button" title="Delete" aria-label="Delete"><Icon name="trash" size={14} /></button>
        </div>
      ),
    },
  ];
}

function userColumns(onEdit, onToggleActive, currentUserId) {
  return [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.id },
    { key: 'user', label: 'User', locked: true, render: (row) => <UserAvatarName user={row} /> },
    { key: 'email', label: 'Email', render: (row) => row.email },
    { key: 'phone', label: 'Phone', className: 'cell-center', render: (row) => row.phone ?? '-' },
    { key: 'role', label: 'Role', className: 'cell-center', render: (row) => {
      const roles = (Array.isArray(row.roles) && row.roles.length) ? row.roles : [row.role].filter(Boolean);
      return (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
          {roles.map((r) => <StatusBadge key={r} value={r} />)}
        </span>
      );
    } },
    { key: 'status', label: 'Status', className: 'cell-center', render: (row) => <StatusBadge value={row.is_active ? 'Active' : 'Inactive'} /> },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions">
          <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          {row.id !== currentUserId && (
            row.is_active ? (
              <button className="btn-archive-action icon-btn" onClick={() => onToggleActive(row, false)} type="button" title="Deactivate (reversible)" aria-label="Deactivate"><Icon name="archive" size={14} /></button>
            ) : (
              <button className="btn-edit-action icon-btn" onClick={() => onToggleActive(row, true)} type="button" title="Activate" aria-label="Activate"><Icon name="undo" size={14} /></button>
            )
          )}
        </div>
      ),
    },
  ];
}

// Card-view counterpart to the Users table row — avatar, name, role(s), and
// contact details on a single clickable tile, mirroring TicketCard/
// MaintenanceRecordCard's click-to-edit convention for this module's card view.
function UserCard({ user: person, onClick }) {
  const initials = (person.name || '?').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  const roles = (Array.isArray(person.roles) && person.roles.length) ? person.roles : [person.role].filter(Boolean);

  return (
    <div className="user-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="user-card-avatar">
        {person.photo_url ? <img src={resolvePhotoUrl(person.photo_url)} alt={person.name} /> : <span>{initials}</span>}
      </div>
      <strong className="user-card-name">{person.name}</strong>
      <span className="user-card-role">{roles.join(', ') || '—'}</span>
      <span className="user-card-underline" />
      <div className="user-card-contact">
        <span>{person.phone || 'No phone on file'}</span>
        <a href={`mailto:${person.email}`} onClick={(e) => e.stopPropagation()}>{person.email}</a>
      </div>
      <StatusBadge value={person.is_active ? 'Active' : 'Inactive'} />
    </div>
  );
}

// "X ago" — coarse, single-unit relative time (seconds up to years), the
// same granularity a typical activity-feed timestamp uses.
function timeAgo(value) {
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

// Maps a set of selected severity labels back to the [minIndex, maxIndex]
// span DualRangeSlider needs — the inverse of what applyFilters below does
// when it turns the slider's span back into that same selected-labels array
// (the actual filter state stays a plain string array, same shape every
// other multi-select filter in this app already uses).
function severityRangeFromSelection(selected, levels) {
  if (!selected?.length) return [0, levels.length - 1];
  const indices = selected.map((s) => levels.indexOf(s)).filter((i) => i !== -1);
  if (!indices.length) return [0, levels.length - 1];
  return [Math.min(...indices), Math.max(...indices)];
}

// Same bespoke filter panel design as IssueFilterPanel, adapted for
// Maintenance Tickets: no Issue Type dropdown (tickets don't have one),
// the range slider covers ticket Priority (Low/Medium/High) instead of
// Severity, and the status chips use TICKET_STAT_CARDS (Open/Active/
// Closed/Cancelled) instead of ISSUE_STAT_CARDS.
function TicketFilterPanel({
  categories = [],
  vehicles = [],
  custodians = [],
  maintenancePersonnelRoster = [],
  priorityLevels = [],
  statusOptions = [],
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterVehicle,
  setFilterVehicle,
  filterMechanic,
  setFilterMechanic,
  filterCustodian,
  setFilterCustodian,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  filterDateStart,
  setFilterDateStart,
  filterDateEnd,
  setFilterDateEnd,
}) {
  const capacities = useMemo(() => {
    const caps = new Set();
    vehicles.forEach((v) => { if (v.capacity) caps.add(v.capacity.trim()); });
    return Array.from(caps).sort();
  }, [vehicles]);

  const maintenancePersonnelNames = useMemo(
    () => maintenancePersonnelRoster.map((p) => p.name).sort(),
    [maintenancePersonnelRoster],
  );
  const custodianNames = useMemo(() => custodians.map((c) => c.name).sort(), [custodians]);

  const statusKeys = useMemo(
    () => TICKET_STAT_CARDS.filter((c) => statusOptions.includes(c.key)).map((c) => c.key),
    [statusOptions],
  );

  // Same default window every time the applied filter is unset — both on
  // first mount AND after "Clear Filters" resets filterDateStart/End back
  // to '' — instead of only seeding it once and then collapsing to a blank
  // "dd/mm/yyyy" the moment this effect's first resync runs.
  const [draft, setDraft] = useState({
    category: filterCategory ?? [],
    capacity: filterCapacity ?? [],
    vehicle: filterVehicle ?? [],
    mechanic: filterMechanic ?? [],
    custodian: filterCustodian ?? [],
    status: filterStatus ?? [],
    priorityRange: severityRangeFromSelection(filterPriority, priorityLevels),
    dateStart: filterDateStart || '2026-01-01',
    dateEnd: filterDateEnd || '2026-12-31',
  });

  useEffect(() => {
    setDraft({
      category: filterCategory ?? [],
      capacity: filterCapacity ?? [],
      vehicle: filterVehicle ?? [],
      mechanic: filterMechanic ?? [],
      custodian: filterCustodian ?? [],
      status: filterStatus ?? [],
      priorityRange: severityRangeFromSelection(filterPriority, priorityLevels),
      dateStart: filterDateStart || '2026-01-01',
      dateEnd: filterDateEnd || '2026-12-31',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCategory, filterCapacity, filterVehicle, filterMechanic, filterCustodian, filterStatus, filterPriority, filterDateStart, filterDateEnd]);

  // An empty draft.status means "no filter" — every chip should read as
  // checked, the same "everything's included" state the Total/All stat
  // card represents. Unchecking one FROM that implicit-all state has to
  // expand it into an explicit "every status except this one" list first —
  // otherwise toggling off a single chip would (wrongly) read as toggling
  // it on, since d.status.includes(key) is false for all of them.
  const toggleDraftStatus = (key) => {
    setDraft((d) => {
      const current = d.status.length === 0 ? statusKeys : d.status;
      const next = current.includes(key) ? current.filter((s) => s !== key) : [...current, key];
      return { ...d, status: next.length === statusKeys.length ? [] : next };
    });
  };

  const applyFilters = () => {
    setFilterCategory(draft.category);
    setFilterCapacity(draft.capacity);
    setFilterVehicle(draft.vehicle);
    setFilterMechanic(draft.mechanic);
    setFilterCustodian(draft.custodian);
    setFilterStatus(draft.status);
    setFilterPriority(priorityLevels.slice(draft.priorityRange[0], draft.priorityRange[1] + 1));
    setFilterDateStart(draft.dateStart);
    setFilterDateEnd(draft.dateEnd);
  };

  const isFullPriorityRange = draft.priorityRange[0] === 0 && draft.priorityRange[1] === priorityLevels.length - 1;
  const isDirty = !sameSelection(draft.category, filterCategory ?? [])
    || !sameSelection(draft.capacity, filterCapacity ?? [])
    || !sameSelection(draft.vehicle, filterVehicle ?? [])
    || !sameSelection(draft.mechanic, filterMechanic ?? [])
    || !sameSelection(draft.custodian, filterCustodian ?? [])
    || !sameSelection(draft.status, filterStatus ?? [])
    || !isFullPriorityRange && !sameSelection(priorityLevels.slice(draft.priorityRange[0], draft.priorityRange[1] + 1), filterPriority ?? [])
    || draft.dateStart !== (filterDateStart || '2026-01-01')
    || draft.dateEnd !== (filterDateEnd || '2026-12-31');

  return (
    <div className="issue-filter-panel">
      <div className="issue-filter-row">
        <div className="filter-date-group">
          <span>Category</span>
          <MultiSelectDropdown
            placeholder="All Categories"
            options={categories.map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
            selected={draft.category}
            onChange={(vals) => setDraft((d) => ({ ...d, category: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Capacity</span>
          <MultiSelectDropdown
            placeholder="All Capacities"
            options={capacities}
            selected={draft.capacity}
            onChange={(vals) => setDraft((d) => ({ ...d, capacity: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Vehicle</span>
          <MultiSelectDropdown
            placeholder="All Vehicles"
            options={vehicles.map((v) => ({ value: String(v.vehicle_id), label: `${v.vehicle_name} · ${v.plate_number}` }))}
            selected={draft.vehicle}
            onChange={(vals) => setDraft((d) => ({ ...d, vehicle: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Maintenance Personnel</span>
          <MultiSelectDropdown
            placeholder="All Maintenance Personnel"
            options={maintenancePersonnelNames}
            selected={draft.mechanic}
            onChange={(vals) => setDraft((d) => ({ ...d, mechanic: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Custodian</span>
          <MultiSelectDropdown
            placeholder="All Custodians"
            options={custodianNames}
            selected={draft.custodian}
            onChange={(vals) => setDraft((d) => ({ ...d, custodian: vals }))}
          />
        </div>
      </div>
      <div className="issue-filter-dates">
        <div className="filter-date-group issue-filter-date-input">
          <span>From Date</span>
          <DateFilterInput value={draft.dateStart} onChange={(val) => setDraft((d) => ({ ...d, dateStart: val }))} />
        </div>
        <div className="filter-date-group issue-filter-date-input">
          <span>To Date</span>
          <DateFilterInput value={draft.dateEnd} onChange={(val) => setDraft((d) => ({ ...d, dateEnd: val }))} />
        </div>
      </div>

      <div className="issue-filter-severity-card">
        <span className="issue-filter-severity-label">Priority</span>
        <DualRangeSlider
          labels={priorityLevels}
          minIndex={draft.priorityRange[0]}
          maxIndex={draft.priorityRange[1]}
          onChange={(min, max) => setDraft((d) => ({ ...d, priorityRange: [min, max] }))}
        />
      </div>
      <div className="issue-filter-right-cluster">
        <div className="issue-filter-status-grid">
          {TICKET_STAT_CARDS.filter((c) => statusOptions.includes(c.key)).map((c) => (
            <label key={c.key} className="issue-filter-status-chip" style={{ background: c.bg }}>
              <input type="checkbox" checked={draft.status.length === 0 || draft.status.includes(c.key)} onChange={() => toggleDraftStatus(c.key)} />
              <span style={{ color: c.color }}>{c.label}</span>
            </label>
          ))}
        </div>
        <div className="issue-filter-actions">
          <button type="button" className="filter-apply-btn issue-filter-apply-btn" onClick={applyFilters} disabled={!isDirty}>Filter</button>
        </div>
      </div>
    </div>
  );
}

function scheduleColumns(onEdit, deleteRecord, onComplete, currentUser, onViewRecord, restoreRecord, onReassign, onViewTicket) {
  const isAdmin = hasRole(currentUser, 'Admin');
  const currentUserId = currentUser?.id;
  return [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.schedule_id },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'type', label: 'Type', className: 'cell-center', render: (row) => row.maintenance_type },
    {
      key: 'assigned_to',
      label: 'Assigned To',
      className: 'cell-center',
      render: (row) => {
        const name = row.assigned_to_user?.name;
        if (!name) return <span className="muted">Unassigned</span>;
        const isMe = currentUserId != null && String(row.assigned_to) === String(currentUserId);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {name}
            {isMe && <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>YOU</span>}
          </span>
        );
      },
    },
    { key: 'date', label: 'Date', className: 'cell-center', render: (row) => <DateBadge value={row.scheduled_date} /> },
    { key: 'time', label: 'Time', className: 'cell-center', render: (row) => row.scheduled_time ?? '-' },
    // "One-time" (plain text, no badge) needs the same explicit centering the
    // recurring branch gets for free from <StatusBadge> — otherwise it'd
    // sit flush left while every other row in this column is centered.
    { key: 'repeat', label: 'Repeat', className: 'cell-center', render: (row) => row.recurrence_months ? <StatusBadge value={RECURRENCE_LABEL[row.recurrence_months] ?? `Every ${row.recurrence_months} mo`} /> : <span className="muted">One-time</span> },
    { key: 'location', label: 'Location', render: (row) => row.service_location ?? '-' },
    {
      key: 'status',
      label: 'Status',
      // Wrapping <StatusBadge> to add the optional OVERDUE/Done tags beside
      // it opts out of the `tbody td:has(> .status-badge)` auto-centering
      // (the badge is no longer a direct child of the <td>) — centered
      // explicitly instead.
      className: 'cell-center',
      render: (row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <StatusBadge value={row.status} />
          {/* #11 — a scheduled PM whose date has passed is overdue: flag it
              loudly instead of leaving it to sit silently on the calendar. */}
          {isScheduleOverdue(row) && (
            <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>OVERDUE</span>
          )}
          {/* Traceability — the schedule row only ever showed "Completed" as
              a label with nothing to verify it against. This shows what the
              linked Maintenance Record actually reached: still awaiting
              Custodian verification, or genuinely Completed with a real
              date (only fast-closed records get date_completed immediately;
              others get it once verification/confirmation goes through). */}
          {row.status === 'Completed' && row.resulting_maintenance && (
            row.resulting_maintenance.progress_status === 'Completed' ? (
              <span
                style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}
                title={`Verification: ${row.resulting_maintenance.verification_result ?? 'Pending'}`}
              >
                Done {formatDate(row.resulting_maintenance.date_completed)}
              </span>
            ) : (
              <span
                style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a' }}
                title="The calendar task is done, but the record it created still needs Custodian verification before it's fully closed."
              >
                Record: {row.resulting_maintenance.progress_status}
              </span>
            )
          )}
        </span>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions" style={{ flexWrap: 'wrap' }}>
          {row.status === 'Scheduled' && row.resulting_ticket_id && onViewTicket && (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.resulting_ticket_id })} type="button" title={`This schedule became Ticket #${row.resulting_ticket_id} — open it`} aria-label={`Open Ticket #${row.resulting_ticket_id}`}><Icon name="ticket" size={14} /></button>
          )}
          {row.status === 'Scheduled' && !row.resulting_ticket_id && onComplete && (currentUserId != null && String(row.assigned_to) === String(currentUserId)) && (
            <button className="btn-confirm-action icon-btn" onClick={() => onComplete(row)} type="button" title="Mark as Done" aria-label="Mark as Done"><Icon name="checkCircle" size={14} /></button>
          )}
          {row.status === 'Completed' && row.resulting_maintenance_id && onViewRecord && (
            <button className="btn-view-action icon-btn" onClick={() => onViewRecord(row)} type="button" title="View Maintenance Record" aria-label="View Maintenance Record"><Icon name="wrench" size={14} /></button>
          )}
          {/* Admin edits any schedule; a Custodian may only edit the one they
              themselves created (matches the backend's ownership check on
              schedule.edit). A Maintenance Personnel assigned to it only ever
              gets to act on it via Mark as Done above. */}
          {isAdmin && (
            <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          )}
          {/* Reassigning/cancelling a schedule stays an Admin-only planning
              decision, unaffected by the ownership change above. */}
          {isAdmin && (
            <>
              {/* schedule.reassign ability (Admin only): hand a still-open
                  Scheduled row to a different Maintenance Personnel without
                  cancelling and re-booking it. */}
              {row.status === 'Scheduled' && onReassign && (
                <button className="btn-view-action icon-btn" onClick={() => onReassign(row)} type="button" title="Reassign" aria-label="Reassign"><Icon name="undo" size={14} /></button>
              )}
              {/* Cancelling a schedule is a soft cancel — the row survives — so a
                  cancelled one gets Restore instead of a Delete that would do
                  nothing. Same swap vehicleColumns makes for archived vehicles. */}
              {row.status === 'Cancelled' && restoreRecord ? (
                <button className="btn-confirm-action icon-btn" onClick={() => restoreRecord(`/maintenance-schedules/${row.schedule_id}/restore`, 'Schedule restored.', 'Restore this cancelled schedule back to Scheduled?')} type="button" title="Restore" aria-label="Restore"><Icon name="undo" size={14} /></button>
              ) : (
                <button className="btn-delete-action icon-btn" onClick={() => deleteRecord(`/maintenance-schedules/${row.schedule_id}`, 'Schedule cancelled.', `Cancel the ${row.maintenance_type} schedule for ${row.vehicle?.vehicle_name ?? 'this vehicle'}? It can be restored later if needed.`)} type="button" title="Cancel Schedule" aria-label="Cancel Schedule"><Icon name="trash" size={14} /></button>
              )}
            </>
          )}
        </div>
      ),
    },
  ];
}

const RECURRENCE_LABEL = { 1: 'Monthly', 3: 'Quarterly', 6: 'Every 6 mo', 12: 'Yearly' };

// #11 — a schedule is overdue when it's still 'Scheduled' but its date has
// already passed (compared date-only, so "today" is never overdue).
function isScheduleOverdue(row) {
  if (row.status !== 'Scheduled' || !row.scheduled_date) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(row.scheduled_date); due.setHours(0, 0, 0, 0);
  return due < today;
}

const SCHEDULE_URGENCY_KEYS = ['Overdue', 'Due1to3', 'Due4to7', 'Due8plus'];

// How soon a still-Scheduled row is due, in the same 4 buckets the top-row
// urgency stat cards count and filter by. Null for anything that isn't an
// upcoming Scheduled row (Completed/Cancelled rows have no "due in" left).
function scheduleUrgencyBucket(row) {
  if (row.status !== 'Scheduled' || !row.scheduled_date) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(row.scheduled_date); due.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days <= 0) return 'Overdue';
  if (days <= 3) return 'Due1to3';
  if (days <= 7) return 'Due4to7';
  return 'Due8plus';
}

// Card-view counterpart to scheduleColumns — same information and the same
// action affordances, so neither view can do something the other can't.
// Deliberately NOT one big click target: unlike a Maintenance Record, a
// schedule has no detail page to open, and a whole-card click would fight
// with the action buttons it needs to carry.
function MaintenanceScheduleCard({ row, currentUser, onComplete, onEdit, onDelete, onViewRecord, onRestore, onReassign, onViewTicket }) {
  const isAdmin = hasRole(currentUser, 'Admin');
  const currentUserId = currentUser?.id;
  const isMine = currentUserId != null && String(row.assigned_to) === String(currentUserId);
  const overdue = isScheduleOverdue(row);
  const resulting = row.resulting_maintenance;
  // Once a due schedule has become a ticket, the ticket is where the work is
  // done — completing the schedule directly would be refused. Final senior
  // system review (2026-10-05, §2) — Admin no longer completes a schedule
  // directly (that's physically performing the work); only the assigned
  // Maintenance Personnel can.
  const canComplete = row.status === 'Scheduled' && !row.resulting_ticket_id && onComplete && isMine;
  const becameTicket = row.status === 'Scheduled' && row.resulting_ticket_id && onViewTicket;

  return (
    <div className="ticket-card" style={{ cursor: 'default' }}>
      <div className="ticket-card-content-wrapper">
        <div className="ticket-card-info">
          <div className="ticket-card-top">
            <span className="ticket-card-id">#{row.schedule_id}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <StatusBadge value={row.status} />
              {overdue && (
                <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>OVERDUE</span>
              )}
            </span>
          </div>
          <p className="ticket-card-title">{row.maintenance_type}</p>
          <p className="ticket-card-vehicle" style={{ marginBottom: 8 }}>
            {row.vehicle?.vehicle_name}{row.vehicle?.plate_number ? ` · ${row.vehicle.plate_number}` : ''}
          </p>
        </div>
        {row.vehicle?.photo_url && (
          <div className="ticket-card-photo">
            <img src={resolvePhotoUrl(row.vehicle.photo_url)} alt={row.vehicle.vehicle_name} />
          </div>
        )}
      </div>

      {/* The date is the whole point of a schedule, so it leads here rather
          than being one column among many. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: '0.78rem', margin: '2px 0 8px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 700, color: overdue ? '#b91c1c' : undefined }}>
          <Icon name="calendar" size={13} /> {formatDate(row.scheduled_date)}{row.scheduled_time ? ` · ${row.scheduled_time}` : ''}
        </span>
        <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="undo" size={13} /> {row.recurrence_months ? (RECURRENCE_LABEL[row.recurrence_months] ?? `Every ${row.recurrence_months} mo`) : 'One-time'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', marginBottom: 8, flexWrap: 'wrap' }}>
        {row.assigned_to_user?.name
          ? (
            <>
              <UserAvatarName user={row.assigned_to_user} />
              {isMine && <span style={{ fontSize: '0.64rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>YOU</span>}
            </>
          )
          : <span className="muted">Unassigned</span>}
      </div>

      {row.service_location && (
        <p className="muted" style={{ fontSize: '0.74rem', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 5 }}>
          <Icon name="pin" size={12} /> {row.service_location}
        </p>
      )}

      {/* Traceability, same as the table's Status column: "Completed" alone
          doesn't say whether the record it produced was ever verified. */}
      {row.status === 'Completed' && resulting && (
        <div style={{ marginBottom: 8 }}>
          {resulting.progress_status === 'Completed' ? (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}>
              Done {formatDate(resulting.date_completed)}
            </span>
          ) : (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a' }} title="The calendar task is done, but the record it created still needs Custodian verification.">
              Record: {resulting.progress_status}
            </span>
          )}
        </div>
      )}

      <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
        {canComplete && (
          <button className="btn-confirm-action icon-btn" onClick={() => onComplete(row)} type="button" title="Mark as Done" aria-label="Mark as Done"><Icon name="checkCircle" size={14} /></button>
        )}
        {becameTicket && (
          <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.resulting_ticket_id })} type="button" title={`This schedule became Ticket #${row.resulting_ticket_id} — open it`} aria-label={`Open Ticket #${row.resulting_ticket_id}`}><Icon name="ticket" size={14} /></button>
        )}
        {row.status === 'Completed' && row.resulting_maintenance_id && onViewRecord && (
          <button className="btn-view-action icon-btn" onClick={() => onViewRecord(row)} type="button" title="View Maintenance Record" aria-label="View Maintenance Record"><Icon name="wrench" size={14} /></button>
        )}
        {/* Admin edits any schedule; a Custodian may only edit the one they
            themselves created — see scheduleColumns' matching Action column. */}
        {(isAdmin || (currentUserId != null && String(row.createdBy?.id) === String(currentUserId))) && (
          <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
        )}
        {/* Reassign/cancel stay Admin-only, unaffected by the ownership edit above. */}
        {isAdmin && (
          <>
            {/* schedule.reassign ability (Admin only). */}
            {row.status === 'Scheduled' && onReassign && (
              <button className="btn-view-action icon-btn" onClick={() => onReassign(row)} type="button" title="Reassign" aria-label="Reassign"><Icon name="undo" size={14} /></button>
            )}
            {/* Same swap as the table: a cancelled schedule offers Restore, not a
                Delete that would just re-cancel something already cancelled. */}
            {row.status === 'Cancelled' && onRestore ? (
              <button className="btn-confirm-action icon-btn" onClick={() => onRestore(row)} type="button" title="Restore" aria-label="Restore"><Icon name="undo" size={14} /></button>
            ) : (
              <button className="btn-delete-action icon-btn" onClick={() => onDelete(row)} type="button" title="Cancel Schedule" aria-label="Cancel Schedule"><Icon name="trash" size={14} /></button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// "09/16/26 - 7:05 am" — a single plain-text column combining date and time,
// in place of the DateBadge/Time column pair every other table uses; the
// activity log reads as a dense audit trail, not a dashboard, so the chunky
// colored badge tile is more visual weight than the row needs.
function formatLogDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  const time = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(date).toLowerCase();
  return `${mm}/${dd}/${yy} - ${time}`;
}

// One consistent pill color per module string, picked deterministically (a
// hash of the name) from a fixed palette — so "Vehicle Management" is always
// the same color everywhere it appears, without hand-maintaining a lookup
// table for every module string the backend might ever log.
const MODULE_BADGE_PALETTE = [
  { bg: '#fef3c7', color: '#92400e' },
  { bg: '#dbeafe', color: '#1d4ed8' },
  { bg: '#dcfce7', color: '#166534' },
  { bg: '#fce7f3', color: '#9d174d' },
  { bg: '#ede9fe', color: '#5b21b6' },
  { bg: '#e0f2fe', color: '#075985' },
  { bg: '#fee2e2', color: '#991b1b' },
  { bg: '#f1f5f9', color: '#334155' },
];
function moduleBadgeTone(moduleName = '') {
  let hash = 0;
  for (let i = 0; i < moduleName.length; i += 1) hash = (hash * 31 + moduleName.charCodeAt(i)) >>> 0;
  return MODULE_BADGE_PALETTE[hash % MODULE_BADGE_PALETTE.length];
}

function logColumns(vehicles, onViewVehicle, onViewTicket) {
  return [
    { key: 'datetime', label: 'Date and Time', className: 'cell-center', render: (row) => formatLogDateTime(row.created_at) },
    {
      key: 'item',
      label: 'Item',
      render: (row) => {
        if (row.affected_record_id == null) return <span className="muted">—</span>;
        // Only these two modules have an affected_record_id guaranteed to be
        // that record's own id (a vehicle_id / ticket_id) — every other
        // module logs a mix of ids (issue/maintenance/schedule/category ids)
        // that would need their own lookup dataset to resolve safely.
        if (row.module === 'Vehicle Management') {
          const vehicle = vehicles.find((v) => String(v.vehicle_id) === String(row.affected_record_id));
          return vehicle
            ? <button type="button" className="issue-reporter-link" onClick={() => onViewVehicle(vehicle)}>{vehicle.vehicle_name}</button>
            : `Vehicle #${row.affected_record_id}`;
        }
        if (row.module === 'Maintenance Tickets') {
          return <button type="button" className="issue-reporter-link" onClick={() => onViewTicket({ ticket_id: row.affected_record_id })}>Ticket #{row.affected_record_id}</button>;
        }
        return `#${row.affected_record_id}`;
      },
    },
    {
      key: 'module',
      label: 'Category',
      className: 'cell-center',
      render: (row) => {
        const tone = moduleBadgeTone(row.module ?? '');
        return <span className="log-category-tag" style={{ background: tone.bg, color: tone.color }}>{row.module ?? '-'}</span>;
      },
    },
    { key: 'action', label: 'Action', className: 'cell-text', render: (row) => row.details || row.action },
    {
      key: 'user',
      label: 'User',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="log-user-cell">
          <UserAvatarName user={row.user} />
          {row.role && <div className="log-user-role">{row.role}</div>}
        </div>
      ),
    },
  ];
}

// Toolbar button + popover offering a few pre-shaped CSV exports over
// whatever activity rows are currently in view (same filtered/searched set
// the table shows) — a raw chronological dump, and two rollups (by user, by
// module) that are actually useful for "who's been doing what" questions a
// raw log dump doesn't answer directly.
function GenerateReportButton({ rows }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const runReport = (type) => {
    setOpen(false);
    const stamp = new Date().toISOString().slice(0, 10);

    if (type === 'timeline') {
      exportRowsToCsv(`activity-timeline-${stamp}.csv`, [
        { label: 'Date and Time', value: (r) => formatLogDateTime(r.created_at) },
        { label: 'User', value: (r) => r.user?.name ?? 'System' },
        { label: 'Role', value: (r) => r.role ?? '-' },
        { label: 'Module', value: (r) => r.module ?? '-' },
        { label: 'Action', value: (r) => r.action },
        { label: 'Details', value: (r) => r.details ?? '' },
      ], rows);
      return;
    }

    if (type === 'user') {
      const byUser = new Map();
      rows.forEach((r) => {
        const key = r.user?.name ?? 'System';
        const entry = byUser.get(key) ?? { user: key, role: r.role ?? '-', total: 0, last: r.created_at };
        entry.total += 1;
        if (r.created_at && (!entry.last || new Date(r.created_at) > new Date(entry.last))) entry.last = r.created_at;
        byUser.set(key, entry);
      });
      exportRowsToCsv(`activity-by-user-${stamp}.csv`, [
        { label: 'User', value: (r) => r.user },
        { label: 'Role', value: (r) => r.role },
        { label: 'Total Actions', value: (r) => r.total },
        { label: 'Last Active', value: (r) => formatLogDateTime(r.last) },
      ], [...byUser.values()].sort((a, b) => b.total - a.total));
      return;
    }

    if (type === 'module') {
      const byModule = new Map();
      rows.forEach((r) => {
        const key = r.module ?? 'Other';
        byModule.set(key, (byModule.get(key) ?? 0) + 1);
      });
      exportRowsToCsv(`activity-by-module-${stamp}.csv`, [
        { label: 'Module', value: (r) => r.module },
        { label: 'Total Actions', value: (r) => r.total },
      ], [...byModule.entries()].map(([module, total]) => ({ module, total })).sort((a, b) => b.total - a.total));
    }
  };

  return (
    <div className="column-chooser generate-report" ref={containerRef}>
      <button type="button" className={`primary-button generate-report-btn${open ? ' is-active' : ''}`} onClick={() => setOpen((v) => !v)}>
        Generate Report <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div className="column-chooser-panel generate-report-panel" role="menu">
          <button type="button" className="generate-report-option" onClick={() => runReport('timeline')}>
            <strong>Timeline Report</strong>
            <span>Every action, in order, exactly as shown below.</span>
          </button>
          <button type="button" className="generate-report-option" onClick={() => runReport('user')}>
            <strong>User Report</strong>
            <span>Action counts per user, most active first.</span>
          </button>
          <button type="button" className="generate-report-option" onClick={() => runReport('module')}>
            <strong>Module Report</strong>
            <span>Action counts per module, busiest first.</span>
          </button>
        </div>
      )}
    </div>
  );
}

// Same rows as the List View table, rendered as a connected vertical
// timeline instead — its own pagination via the same usePagination hook, so
// switching tabs doesn't lose your place in a 14,000-row activity log.
function ActivityTimeline({ rows }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(rows.length, { pageSizeOptions: [10, 25, 50, 100], initialPageSize: 10 });

  if (!rows.length) {
    return <p className="empty-state">No activity yet.</p>;
  }

  const pageRows = rows.slice(start, end);

  return (
    <div className="activity-timeline-wrap">
      <h3 className="activity-timeline-title">Recent Activities</h3>
      <ol className="activity-timeline">
        {pageRows.map((row) => (
          <li key={row.log_id} className="activity-timeline-item">
            <span className="activity-timeline-dot" aria-hidden="true">
              <Icon name="link" size={13} />
            </span>
            <div className="activity-timeline-body">
              <strong>{row.user?.name ?? 'System'} {row.action}</strong>
              <p>{row.details}</p>
            </div>
            <span className="activity-timeline-time">{timeAgo(row.created_at)}</span>
          </li>
        ))}
      </ol>
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={[10, 25, 50, 100]} totalPages={totalPages} />
    </div>
  );
}

// Shared paging state for PaginatedTable/PaginatedCardGrid/any future
// paginated view (e.g. an activity timeline) — one hook so all of them page
// identically and reset to page 1 the same way when the row count/page size
// changes out from under them (a filter narrowing results, etc).
function usePagination(count, { pageSizeOptions, initialPageSize }) {
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [count, pageSize]);

  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const end = Math.min(start + pageSize, count);

  return { page: clampedPage, setPage, pageSize, setPageSize, pageSizeOptions, totalPages, start, end };
}

// Numbered-page pager (‹ 1 2 [3] 4 5 … N ›) + a page-size picker rendered as
// its own row of circular buttons — replaces the old Prev/Next + dropdown
// footer to match the reference pagination design. Windows 2 pages on each
// side of the current one, always keeping page 1 and the last page visible
// with a single-ellipsis gap between, since jumping straight to the last of
// hundreds of pages is common (e.g. "578" in the activity log).
function paginationPageList(current, total) {
  const delta = 2;
  const pages = [];
  for (let i = 1; i <= total; i += 1) {
    if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) pages.push(i);
  }
  const withGaps = [];
  let prev;
  pages.forEach((p) => {
    if (prev != null && p - prev > 1) withGaps.push('…');
    withGaps.push(p);
    prev = p;
  });
  return withGaps;
}

function PaginationControls({ page, setPage, pageSize, setPageSize, pageSizeOptions, totalPages }) {
  if (totalPages <= 1 && pageSizeOptions.length <= 1) return null;
  const pageList = paginationPageList(page, totalPages);
  return (
    <div className="table-pagination">
      <div className="table-pagination-pages">
        <button type="button" className="pagination-arrow" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">‹</button>
        {pageList.map((p, i) => (
          p === '…'
            ? <span key={`gap-${i}`} className="pagination-ellipsis">…</span>
            : <button key={p} type="button" className={`pagination-page${p === page ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>
        ))}
        <button type="button" className="pagination-arrow" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">›</button>
      </div>
      <div className="table-pagination-size">
        <span className="muted">Page size:</span>
        {pageSizeOptions.map((n) => (
          <button key={n} type="button" className={`pagination-page${n === pageSize ? ' active' : ''}`} onClick={() => setPageSize(n)}>{n}</button>
        ))}
      </div>
    </div>
  );
}

function PaginatedTable({ columns, rows, onRowClick, onReorderColumn, emptyMessage, compact = false, pageSizeOptions = [10, 25, 50, 100], initialPageSize = 25, renderSubRow }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(rows?.length ?? 0, { pageSizeOptions, initialPageSize });

  if (!rows?.length) {
    return <DataTable columns={columns} rows={rows} onRowClick={onRowClick} onReorderColumn={onReorderColumn} emptyMessage={emptyMessage} compact={compact} renderSubRow={renderSubRow} />;
  }

  const pageRows = rows.slice(start, end);

  return (
    <>
      <DataTable columns={columns} rows={pageRows} onRowClick={onRowClick} onReorderColumn={onReorderColumn} compact={compact} renderSubRow={renderSubRow} />
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={pageSizeOptions} totalPages={totalPages} />
    </>
  );
}

// Card-grid counterpart to PaginatedTable — same PaginationControls footer,
// so switching between List and Card view doesn't change how paging looks or
// behaves. Page size defaults lower than the table's: cards are much taller,
// so 25 of them is a very long scroll.
function PaginatedCardGrid({ items, renderItem, keyOf, emptyMessage, pageSizeOptions = [12, 24, 48, 96], initialPageSize = 12 }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(items?.length ?? 0, { pageSizeOptions, initialPageSize });

  if (!items?.length) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  const pageItems = items.slice(start, end);

  return (
    <>
      <div className="ticket-card-grid">
        {pageItems.map((item, i) => (
          <div key={keyOf ? keyOf(item) : i}>{renderItem(item)}</div>
        ))}
      </div>
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={pageSizeOptions} totalPages={totalPages} />
    </>
  );
}

// Common "this is the human-readable name" field on the loaded relation
// objects reports eager-load (Vehicle, VehicleCategory, User, ...) — tried
// in order so a resolved name shows instead of a bare foreign-key id.
function resolveRelationLabel(value) {
  if (!value || typeof value !== 'object') return null;
  return value.name ?? value.vehicle_name ?? value.category_name ?? value.title ?? (value.id != null ? `#${value.id}` : null);
}

function prettifyKey(key) {
  return key.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function reportColumns(rows) {
  if (!rows?.length) {
    return [{ label: 'Result', render: () => 'No records' }];
  }

  const sample = rows[0];
  // A loaded relation (e.g. `category`, `maintenance_personnel`) is an
  // object in the row — resolve it to a readable name instead of hiding it
  // outright, and hide its matching raw `<key>_id` column so the report
  // shows "Fire Truck" instead of a bare category_id number.
  const relationKeys = Object.keys(sample).filter((key) => sample[key] && typeof sample[key] === 'object' && !Array.isArray(sample[key]));
  const hiddenKeys = new Set(relationKeys.map((key) => `${key}_id`));

  const relationColumns = relationKeys.map((key) => ({
    label: prettifyKey(key),
    render: (row) => resolveRelationLabel(row[key]) ?? '-',
  }));

  const plainKeys = Object.keys(sample).filter((key) => !relationKeys.includes(key) && !hiddenKeys.has(key));
  const plainColumns = plainKeys.slice(0, 8).map((key) => ({
    label: prettifyKey(key),
    render: (row) => String(row[key] ?? '-'),
  }));

  return [...relationColumns, ...plainColumns];
}

// Flat, CSV-exportable version of the same columns `reportColumns` renders
// for on-screen/print display — `exportRowsToCsv` needs a `value(row)`
// shape rather than `render(row)`.
function reportExportColumns(rows) {
  return reportColumns(rows).map((col) => ({ label: col.label, value: (row) => col.render(row) }));
}

function StatusBadge({ value }) {
  return <span className={`status-badge ${String(value).toLowerCase().replaceAll(' ', '-')}`}>{value ?? '-'}</span>;
}

// Clamps long free-text table cells to a fixed number of lines so they can't
// stretch the row/table. A "Show more" chevron only appears when the text
// actually overflows the clamp (measured via scrollHeight vs clientHeight),
// so short text that already fits gets no dead-looking toggle affordance.
function ExpandableText({ text, lines = 2, className = '' }) {
  const [expanded, setExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const textRef = useRef(null);

  useLayoutEffect(() => {
    if (expanded) return;
    const el = textRef.current;
    if (el) setIsTruncated(el.scrollHeight > el.clientHeight + 1);
  }, [text, lines, expanded]);

  if (!text) return '-';

  const toggle = () => setExpanded((prev) => !prev);
  const canToggle = isTruncated || expanded;

  return (
    <span className="expandable-text-wrap">
      <span
        ref={textRef}
        className={`expandable-text ${canToggle ? 'is-clickable' : ''} ${expanded ? 'is-expanded' : ''} ${className}`.trim()}
        style={{ WebkitLineClamp: expanded ? 'unset' : lines }}
        onClick={canToggle ? (event) => { event.stopPropagation(); toggle(); } : undefined}
        onKeyDown={canToggle ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            toggle();
          }
        } : undefined}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        title={canToggle ? (expanded ? 'Click to collapse' : 'Click to view full text') : undefined}
      >
        {text}
      </span>
      {canToggle && (
        <button
          type="button"
          className={`expandable-text-toggle${expanded ? ' is-expanded' : ''}`}
          onClick={(event) => { event.stopPropagation(); toggle(); }}
          title={expanded ? 'Collapse' : 'Show full text'}
        >
          {expanded ? 'Show less' : 'Show more'}
          <Icon name="chevronDown" size={11} />
        </button>
      )}
    </span>
  );
}

// The backend stores absolute image URLs built from APP_URL, which often points
// at a different host/port than where the API is actually served (e.g. stored as
// localhost:8000 but served on 127.0.0.1:8001). Rewrite local-host URLs to the
// real API origin so images load; leave external URLs (e.g. Supabase) untouched.
const API_ORIGIN = (api.defaults.baseURL || '').replace(/\/api\/?$/, '');

// Only these protocols may ever reach an href/src. Blocks javascript:, data:,
// vbscript: etc. from rendering live — defense in depth, since these URLs are
// server-generated today but this guarantees it stays safe regardless.
const SAFE_URL_PROTOCOLS = ['http:', 'https:'];

function resolvePhotoUrl(url) {
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

function PhotoCell({ url, alt }) {
  if (!url) {
    return '-';
  }

  const resolved = resolvePhotoUrl(url);

  return (
    <a className="photo-cell" href={resolved} rel="noreferrer" target="_blank">
      <img alt={alt} className="photo-thumb" src={resolved} loading="lazy" />
    </a>
  );
}

// Consistent "avatar + name" cell used everywhere a table references a user
// (Reported By, Checked By, Personnel, Updated By, Archived By, etc.).
// Clicking it opens that user's info — so a user cell no longer inherits the
// row's "open vehicle" click.
function UserAvatarName({ user, fallback = '-' }) {
  const actions = useContext(RowActionsContext);

  if (!user || !user.name) {
    return <span className="user-avatar-name-empty">{fallback}</span>;
  }

  const initials = user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  const inner = (
    <>
      {user.photo_url ? (
        <img className="user-avatar-name-photo" src={resolvePhotoUrl(user.photo_url)} alt={user.name} />
      ) : (
        <span className="user-avatar-name-initials">{initials}</span>
      )}
      <span>{user.name}</span>
    </>
  );

  if (actions?.viewUser) {
    return (
      <button
        type="button"
        className="user-avatar-name cell-link"
        onClick={(e) => { e.stopPropagation(); actions.viewUser(user); }}
        title={`View ${user.name}`}
      >
        {inner}
      </button>
    );
  }

  return <span className="user-avatar-name">{inner}</span>;
}

// Vehicle cell (photo + name). The name opens the vehicle profile; the photo
// still opens the full-size image in a new tab.
// `isRowTitle` (default true) marks whether THIS column is also what the
// row's own onRowClick opens — true in every table except the Maintenance
// Tickets list, whose row click opens the ticket (the Title column) rather
// than this vehicle, so only that one caller passes false. Drives whether
// hovering anywhere in the row underlines this name too (row-title-text) —
// leaving it on everywhere would underline two different "click targets"
// at once on that one table.
function VehicleCell({ vehicle, isRowTitle = true }) {
  const actions = useContext(RowActionsContext);

  if (!vehicle) {
    return '-';
  }

  const textClassName = `vcn-text${isRowTitle ? ' row-title-text' : ''}`;

  return (
    <div className="vehicle-cell">
      <PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} />
      {actions?.viewVehicle && vehicle.vehicle_id ? (
        <button
          type="button"
          className="vehicle-cell-name cell-link"
          onClick={(e) => { e.stopPropagation(); actions.viewVehicle(vehicle); }}
          title={vehicle.vehicle_name}
        >
          <span className={textClassName}>{vehicle.vehicle_name}</span>
        </button>
      ) : (
        <span className="vehicle-cell-name" title={vehicle.vehicle_name}>
          <span className={textClassName}>{vehicle.vehicle_name}</span>
        </span>
      )}
    </div>
  );
}

// "Card View / List View" selector — a labeled dropdown (Realcore-style) that
// replaces the old two-icon toggle in panel header bars.
const VIEW_MODE_OPTIONS = [
  { value: 'card', label: 'Card View', icon: 'grid' },
  { value: 'table', label: 'List View', icon: 'list' },
];

function ViewModeDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const current = VIEW_MODE_OPTIONS.find((o) => o.value === value) ?? VIEW_MODE_OPTIONS[0];

  return (
    <div className="view-dropdown" ref={ref}>
      <button
        type="button"
        className="view-dropdown-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon name={current.icon} size={14} /> {current.label} <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="view-dropdown-menu" role="listbox">
          {VIEW_MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`view-dropdown-item${o.value === value ? ' active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <Icon name={o.icon} size={14} /> {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function moduleRequest(moduleKey, editTarget, payload) {
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

  if (moduleKey === 'schedules') {
    return (editTarget && editTarget.schedule_id)
      ? { method: 'put', path: `/maintenance-schedules/${editTarget.schedule_id}`, success: 'Schedule updated.' }
      : { method: 'post', path: '/maintenance-schedules', success: 'Schedule added.' };
  }

  return { method: 'post', path: moduleEndpoints[moduleKey], payload: clean, success: 'Saved.' };
}

async function sendPayload(method, path, payload) {
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

function cleanPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== '' && value !== undefined && !(isFile(value) && value.size === 0))
      .map(([key, value]) => [key, value === '' ? null : value]),
  );
}

function valuesFromFields(fields, initialValues) {
  return Object.fromEntries(fields.map((field) => {
    const raw = initialValues?.[field.name];
    if (field.type === 'checkboxes') {
      return [field.name, Array.isArray(raw) && raw.length ? raw : []];
    }
    // A 'list' field edits as separate rows but is stored as one
    // newline-joined string (see handleSubmit) — no backend/schema change
    // needed, and it stays a plain string for any code that just displays it.
    if (field.type === 'list') {
      const rows = typeof raw === 'string' && raw.trim() ? raw.split('\n') : (Array.isArray(raw) ? raw : []);
      return [field.name, rows.length ? rows : ['']];
    }
    return [field.name, raw ?? ''];
  }));
}

function options(items, valueKey, labelKey) {
  return items.map((item) => ({
    value: item[valueKey],
    label: item[labelKey],
  }));
}

// Inactive (archived) vehicles are excluded from every "pick a vehicle"
// dropdown app-wide — you can't schedule/report/record work against a
// vehicle that's been taken out of service.
function vehicleOptions(lookups) {
  return lookups.vehicles
    .filter((vehicle) => vehicle.status !== 'Inactive' && vehicle.status !== 'Decommissioned')
    .map((vehicle) => ({
      value: vehicle.vehicle_id,
      label: vehicleLabel(vehicle),
    }));
}

function vehicleLabel(vehicle) {
  if (!vehicle) {
    return '-';
  }

  return `${vehicle.vehicle_name} (${vehicle.plate_number})`;
}

function formatDate(value) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: value.includes?.('T') ? 'short' : undefined,
  }).format(new Date(value));
}

// Compact "table cell" version of a date: a colored month/day pill plus the
// year underneath — used in place of the long formatDate() string inside
// table columns. Time (when the source field carries one) is its own
// adjacent "Time" column via formatTime(), so it never repeats here.
function DateBadge({ value }) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return (
    <span className="date-badge">
      <span className="date-badge-pill">
        <span className="date-badge-month">{date.toLocaleDateString('en-US', { month: 'short' })}</span>
        <span className="date-badge-day">{date.toLocaleDateString('en-US', { day: '2-digit' })}</span>
      </span>
      <span className="date-badge-meta">
        <span>{date.getFullYear()}</span>
      </span>
    </span>
  );
}

// Muted inline date for calm contexts (the ticket detail cards) where the
// chunky red DateBadge tile reads as an alert. Dense tables keep the tile.
function QuietDate({ value }) {
  if (!value) return <span className="muted">—</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="muted">—</span>;
  return (
    <span className="quiet-date">
      <Icon name="calendar" size={12} /> {formatDate(value)}
    </span>
  );
}

// Plain time-of-day text for the "Time" column that sits next to a
// DateBadge column — blank for date-only fields (no time component).
function formatTime(value) {
  if (!value || typeof value !== 'string' || !value.includes('T')) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('en-PH', { timeStyle: 'short' }).format(date);
}

// Mechanic repair logs are stored as plain text, one entry per submission in
// the form "[YYYY-MM-DD HH:MM] message", separated by a blank line. Parse
// that back out so each entry can show a proper DateBadge instead of a raw
// bracketed timestamp buried in a wall of text.
function RepairLogEntries({ text, compact = false }) {
  if (!text) {
    return <p className="empty-state">No logs yet.</p>;
  }

  const entries = text.split(/\n\s*\n/).map((chunk) => {
    const match = chunk.match(/^\[(.+?)\]\s*([\s\S]*)$/);
    if (!match) {
      return { iso: null, message: chunk.trim() };
    }
    return { iso: match[1].trim().replace(' ', 'T'), message: match[2].trim() };
  }).filter((entry) => entry.message || entry.iso);

  if (compact) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map((entry, i) => (
          <p key={i} style={{ margin: 0, fontSize: '0.82rem', color: '#334155' }}>
            {entry.iso && <span className="muted" style={{ fontSize: '0.7rem', marginRight: 6 }}>{formatDate(entry.iso)}</span>}
            {entry.message}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="repair-log-entries">
      {entries.map((entry, i) => (
        <div className="repair-log-entry" key={i}>
          <div className="repair-log-entry-date">
            <DateBadge value={entry.iso} />
            {entry.iso && <span className="repair-log-entry-time">{formatTime(entry.iso)}</span>}
          </div>
          <p className="repair-log-entry-message">{entry.message}</p>
        </div>
      ))}
    </div>
  );
}

// Builds a CSV file from `columns` (each { label, value(row) }) and `rows`,
// then triggers a browser download named `filename`.
function exportRowsToCsv(filename, columns, rows) {
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

const VEHICLE_EXPORT_COLUMNS = [
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

const USER_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.id },
  { label: 'Name', value: (r) => r.name },
  { label: 'Email', value: (r) => r.email },
  { label: 'Phone', value: (r) => r.phone ?? '' },
  { label: 'Role', value: (r) => ((Array.isArray(r.roles) && r.roles.length) ? r.roles : [r.role].filter(Boolean)).join(', ') },
  { label: 'Status', value: (r) => (r.is_active ? 'Active' : 'Inactive') },
];

const SCHEDULE_EXPORT_COLUMNS = [
  { label: 'ID', value: (r) => r.schedule_id },
  { label: 'Vehicle', value: (r) => (r.vehicle ? `${r.vehicle.vehicle_name} (${r.vehicle.plate_number})` : '') },
  { label: 'Type', value: (r) => r.maintenance_type },
  { label: 'Date', value: (r) => r.scheduled_date },
  { label: 'Time', value: (r) => r.scheduled_time },
  { label: 'Location', value: (r) => r.service_location },
  { label: 'Status', value: (r) => r.status },
];

function rowKey(row, index) {
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
  return index;
}

function moduleLabel(modules, activeModule) {
  return modules.find(([key]) => key === activeModule)?.[1] ?? 'Workspace';
}


function isFile(value) {
  return typeof File !== 'undefined' && value instanceof File;
}

function showError(error, setNotice) {
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


// =========================================================================
// TICKET WORKFLOW FIELD FACTORIES
// =========================================================================

// Flattens a ticket's sub_issues into standalone rows carrying their parent
// ticket's context (vehicle, priority, custodian, etc.) — used by the
// Mechanic Work Order queue and the Custodian Verification queue, which now
// act on one sub-issue at a time instead of a whole ticket. Pass
// `mechanicId` to further restrict to that mechanic's own assigned lines
// (a ticket can carry sub-issues split across several mechanics).
function flattenSubIssueRows(tickets, mechanicId = null) {
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
function groupMechanicRowsByTicket(rows) {
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

// =========================================================================
// WORK TRACKER — cross-phase outcome feed (Custodian + Maintenance)
// =========================================================================

// Reads the FK that may arrive either as an eager-loaded relation object or as
// the raw integer column (both serialize under the same snake_case key).
function idOf(value) {
  return (value && typeof value === 'object') ? value.id : value;
}

// Flattens role-scoped tickets into one row per sub-issue THIS user is tied to,
// tagged with how they're involved (Mechanic / Custodian / both). A ticket may
// carry sibling sub-issues owned by other people — those are skipped.
function flattenWorkTrackerRows(tickets, user) {
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
function workTrackerOutcome(row) {
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
function workTrackerNeedsAction(row) {
  if (row.isMechanic && row.status === 'Under Repair') return true;
  if (row.isVerifier && row.status === 'For Inspection') return true;
  return false;
}

function workTrackerBucket(row) {
  if (workTrackerNeedsAction(row)) return 'attention';
  if (row.status === 'Done' || row.status === 'Deferred') return 'completed';
  return 'progress';
}

// Master-detail grouping: one entry per ticket (a sub-issue belongs to exactly
// one ticket, which belongs to exactly one vehicle), so a vehicle with many
// sub-issues collapses to a single list entry instead of many table rows.
// Sorted the same way the old flat list was — action-needed first, then most
// recently active — so the master list surfaces what matters without scrolling.
function groupWorkTrackerByTicket(rows) {
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

// "Vehicles you've worked on and where they stand now." A read-only feed that
// unifies every workflow phase so a Custodian/Mechanic sees the OUTCOME of their
// work (approved, rejected, confirmed, reopened) in one place — no notification
// chasing. Scope: everything still in progress, plus items completed/deferred
// within the last 30 days so recent outcomes stay visible without old clutter.
function WorkTrackerModule({ tickets, user, categories = [], vehicles = [], onViewTicket, tabBar }) {
  const [activeFilter, setActiveFilter] = useState('');
  const [search, setSearch] = useState('');
  // FilterBar (draft/apply) state — Category + Capacity + Status + My Role.
  const [filterCategory, setFilterCategory] = useState([]);
  const [filterCapacity, setFilterCapacity] = useState([]);
  const [filterStatus, setFilterStatus] = useState([]);
  const [filterRole, setFilterRole] = useState([]);
  const [filterOutcome, setFilterOutcome] = useState([]);
  // Captured once at mount (a 30-day window doesn't need per-render precision),
  // keeping the filter memo below a pure function of its inputs.
  const [nowTs] = useState(() => Date.now());

  const allRows = useMemo(() => {
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    return flattenWorkTrackerRows(tickets, user)
      .filter((row) => {
        const isCompleted = row.status === 'Done' || row.status === 'Deferred';
        if (!isCompleted) return true; // always show active/in-progress work
        const ref = row.confirmed_at || row.deferred_at || row.lastActivityIso;
        return ref ? (nowTs - new Date(ref).getTime()) <= THIRTY_DAYS : false;
      })
      // Action-needed first, then most-recent activity.
      .sort((a, b) => {
        const an = workTrackerNeedsAction(a) ? 1 : 0;
        const bn = workTrackerNeedsAction(b) ? 1 : 0;
        if (an !== bn) return bn - an;
        return b.lastActivityTs - a.lastActivityTs;
      });
  }, [tickets, user, nowTs]);

  const counts = useMemo(() => {
    const c = { attention: 0, progress: 0, completed: 0 };
    allRows.forEach((row) => { c[workTrackerBucket(row)] += 1; });
    return c;
  }, [allRows]);

  const visibleRows = useMemo(() => {
    let result = allRows;
    if (activeFilter) result = result.filter((row) => workTrackerBucket(row) === activeFilter);
    if (filterCategory.length) result = result.filter((row) => filterCategory.includes(String(row.vehicle?.category_id)));
    if (filterCapacity.length) result = result.filter((row) => filterCapacity.includes(row.vehicle?.capacity));
    if (filterStatus.length) result = result.filter((row) => filterStatus.includes(row.status));
    if (filterRole.length) {
      result = result.filter((row) => (
        (filterRole.includes('Mechanic') && row.isMechanic) || (filterRole.includes('Custodian') && row.isVerifier)
      ));
    }
    if (filterOutcome.length) result = result.filter((row) => filterOutcome.includes(workTrackerOutcome(row).label));
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter((row) => (
        (row.vehicle?.vehicle_name ?? '').toLowerCase().includes(q)
        || (row.vehicle?.plate_number ?? '').toLowerCase().includes(q)
        || (row.ticket_title ?? '').toLowerCase().includes(q)
        || (row.title ?? '').toLowerCase().includes(q)
      ));
    }
    return result;
  }, [allRows, activeFilter, filterCategory, filterCapacity, filterStatus, filterRole, filterOutcome, search]);

  const groupedTickets = useMemo(() => groupWorkTrackerByTicket(visibleRows), [visibleRows]);

  return (
    <div className="module-grid">
      {tabBar}
      <ModuleStatCards
        totalLabel="Total"
        total={allRows.length}
        cards={WORK_TRACKER_STAT_CARDS}
        counts={counts}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />
      <section className="panel module-filter-panel">
        <FilterBar
          categories={categories}
          vehicles={vehicles}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterCapacity={filterCapacity}
          setFilterCapacity={setFilterCapacity}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
          filterPriority={filterRole}
          setFilterPriority={setFilterRole}
          statusOptions={['Open', 'Under Repair', 'Pending Approval', 'For Inspection', 'For Confirmation', 'Done', 'Deferred']}
          priorityOptions={(hasRole(user, 'Custodian') && hasRole(user, 'Maintenance Personnel')) ? ['Mechanic', 'Custodian'] : []}
          priorityLabel="Role"
          extraFilters={[{
            key: 'outcome',
            label: 'Outcomes',
            options: ['Confirmed — Done', 'Reopened by Admin', 'Approved — awaiting Admin', 'Rejected — redo repair', 'Awaiting your verification', 'In repair', 'Deferred', 'Awaiting assignment'],
            selected: filterOutcome,
            setSelected: setFilterOutcome,
          }]}
        />
      </section>
      <section className="panel operations-board work-tracker-board">
        <div className="operations-board-head">
          <div>
            <span className="operations-kicker">Service activity</span>
            <h3>Work Tracker <span className="count-badge">{visibleRows.length}</span></h3>
            <p>Follow each assigned repair from active work through verification and completion.</p>
          </div>
          <LocalSearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search vehicle, plate, or ticket..."
            onExport={() => exportRowsToCsv('work-tracker.csv', [
              { label: 'Ticket', value: (r) => `#${r.ticket_id} ${r.ticket_title}` },
              { label: 'Vehicle', value: (r) => r.vehicle?.vehicle_name ?? '' },
              { label: 'Plate Number', value: (r) => r.vehicle?.plate_number ?? '' },
              { label: 'Sub-Issue', value: (r) => r.title ?? '' },
              { label: 'My Role', value: (r) => r.relationship },
              { label: 'Status', value: (r) => r.status ?? '' },
              { label: 'Outcome', value: (r) => workTrackerOutcome(r).label },
              { label: 'Last Update', value: (r) => r.lastActivityIso ?? '' },
            ], visibleRows)}
          />
        </div>
        <p className="muted" style={{ margin: '0 0 14px', fontSize: '0.85rem' }}>
          Every vehicle you've worked on and where it stands now — so you can see the outcome of your work
          without hunting for the ticket. Items needing your action are pinned to the top.
        </p>
        <div style={{ height: '16px' }} />
        <div className="operations-board-note"><Icon name="alert" size={14} /> Items requiring your action are shown first. Select a vehicle to review every related issue.</div>
        <div className="work-tracker-grid operations-card-grid">
          {groupedTickets.length === 0 ? (
            <p className="empty-state" style={{ gridColumn: '1 / -1' }}>
              Nothing here yet — vehicles you repair or verify will show up here with their current status.
            </p>
          ) : (
            groupedTickets.map((group) => {
              const photo = group.vehicle?.photo_url ? resolvePhotoUrl(group.vehicle.photo_url) : null;
              const doneCount = group.subIssues.filter((s) => s.status === 'Done').length;
              return (
                <button
                  key={group.ticket_id}
                  type="button"
                  className={`work-tracker-card${group.needsAction ? ' needs-action' : ''}`}
                  onClick={() => onViewTicket({ ticket_id: group.ticket_id })}
                >
                  <span className="work-tracker-thumb">
                    {photo ? <img src={photo} alt="" /> : <Icon name="vehicle" size={18} />}
                  </span>
                  <span className="work-tracker-card-heading">
                    <span className="work-tracker-card-title-row">
                      <strong>{group.vehicle?.vehicle_name ?? 'Unknown Vehicle'}</strong>
                      <span className="muted" style={{ fontSize: '0.78rem' }}>({group.vehicle?.plate_number ?? '-'})</span>
                      {group.needsAction && <Icon name="alert" size={13} className="work-tracker-item-flag" />}
                    </span>
                    <span className="work-tracker-card-sub" title={group.ticket_title}>#{group.ticket_id} · {group.ticket_title}</span>
                    <span className="work-tracker-card-summary">
                      {group.subIssues.length} sub-issue{group.subIssues.length !== 1 ? 's' : ''}
                      {doneCount > 0 ? ` · ${doneCount} done` : ''}
                      {' · '}{formatDate(group.lastActivityIso)}
                    </span>
                  </span>
                  <span className="work-tracker-card-chevron">▸</span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function mechanicAssignFields(lookups) {
  return [
    { label: 'Assign Mechanic', name: 'assigned_mechanic_id', options: (lookups.maintenance_personnel ?? []).map((m) => ({ value: m.id, label: m.name })), required: true, type: 'select' },
    { label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types ?? [], required: true, type: 'creatable-select', newItemLabel: 'maintenance type', catalogEndpoint: '/maintenance-types' },
    { label: 'Work Order Notes', name: 'work_order_notes', type: 'textarea', rows: 2 },
  ];
}

// Problem 2 — the functional test ("UAT") checklist. What must be physically
// operated and confirmed depends on the KIND of vehicle, keyed off the same
// Land/Water domain that drives the specs form (plus a fire-truck extra).
function functionalTestChecklist(vehicle) {
  const domain = vehicle?.category?.domain ?? 'Land';
  const name = (vehicle?.category?.category_name ?? '').toLowerCase();
  const base = [
    'Engine / power system starts normally',
    'No warning indicators or abnormal noise',
    'The reported problem no longer occurs',
  ];
  if (domain === 'Water') {
    return [...base, 'Engine runs under load on the water', 'Bilge pump operates', 'No hull leaks or water ingress'];
  }
  const land = ['Brakes respond properly', 'Completed a short test drive'];
  const fireTruck = name.includes('fire') ? ['Water pump reaches full pressure'] : [];
  return [...base, ...land, ...fireTruck];
}

// The Custodian's verification IS the functional test: operate the vehicle
// against the checklist, mark each Pass/Fail, and the verdict follows the
// result — any Fail => Rejected (bounced back to the mechanic); all Pass =>
// Approved, but only once the tester attests they actually operated it.
function VerificationForm({ target, onCancel, onSubmit }) {
  const checklist = useMemo(() => functionalTestChecklist(target?.vehicle), [target?.vehicle]);
  const [results, setResults] = useState(() => checklist.map((item) => ({ item, passed: null })));
  const [attested, setAttested] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [newTestInput, setNewTestInput] = useState('');

  const allAnswered = results.every((r) => r.passed !== null);
  const anyFailed = results.some((r) => r.passed === false);
  const allPassed = results.length > 0 && results.every((r) => r.passed === true);
  const verdict = anyFailed ? 'Rejected' : 'Approved';
  const needsAttestation = !anyFailed;
  const canSubmit = allAnswered && (!needsAttestation || attested) && !submitting;

  const setResult = (i, passed) => setResults((rs) => rs.map((r, idx) => (idx === i ? { ...r, passed } : r)));
  // Same shortcut as the Readiness Check form — most checks are routine
  // passes, so bulk-marking everything Pass and flipping the odd real
  // failure afterward beats clicking Pass on every single row.
  const toggleAllPassed = (checked) => setResults((rs) => rs.map((r) => ({ ...r, passed: checked ? true : null })));
  const addTest = () => {
    if (newTestInput.trim()) {
      setResults((rs) => [...rs, { item: newTestInput.trim(), passed: null }]);
      setNewTestInput('');
    }
  };
  const removeTest = (i) => setResults((rs) => rs.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({
        verification_verdict: verdict,
        verification_notes: notes || null,
        functional_test: results.map((r) => ({ item: r.item, passed: r.passed === true })),
        test_attested: verdict === 'Approved' ? attested : false,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.85rem' }}>
        Physically operate the vehicle and mark each check. A repair is only accepted once it actually works — any failed check sends it back to the mechanic.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 8, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: '0.83rem', fontWeight: 600, color: '#1e40af', cursor: 'pointer' }}>
        <input type="checkbox" checked={allPassed} onChange={(e) => toggleAllPassed(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
        Mark all as Pass
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {results.map((r, i) => (
          <div key={r.item} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
            <span style={{ fontSize: '0.85rem', flex: 1 }}>{r.item}</span>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setResult(i, true)}
                style={{ padding: '4px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${r.passed === true ? '#16a34a' : '#cbd5e1'}`, background: r.passed === true ? '#16a34a' : '#fff', color: r.passed === true ? '#fff' : '#64748b' }}
              >
                Pass
              </button>
              <button
                type="button"
                onClick={() => setResult(i, false)}
                style={{ padding: '4px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${r.passed === false ? '#dc2626' : '#cbd5e1'}`, background: r.passed === false ? '#dc2626' : '#fff', color: r.passed === false ? '#fff' : '#64748b' }}
              >
                Fail
              </button>
              <button
                type="button"
                onClick={() => removeTest(i)}
                title="Remove this test"
                style={{ padding: '4px 8px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: '1px solid #fca5a5', background: '#fef2f2', color: '#dc2626' }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            type="text"
            value={newTestInput}
            onChange={(e) => setNewTestInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && addTest()}
            placeholder="Add a custom test item..."
            style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.85rem', fontFamily: 'inherit' }}
          />
          <button
            type="button"
            onClick={addTest}
            style={{ padding: '8px 16px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: '1px solid #2563eb', background: '#2563eb', color: '#fff' }}
          >
            + Add Test
          </button>
        </div>
      </div>

      {allAnswered && (
        <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 8,
          background: anyFailed ? '#fef2f2' : '#ecfdf5', color: anyFailed ? '#991b1b' : '#065f46', border: `1px solid ${anyFailed ? '#fecaca' : '#a7f3d0'}` }}>
          <Icon name={anyFailed ? 'alert' : 'checkCircle'} size={15} />
          {anyFailed
            ? 'A check failed — this will be Rejected and sent back to the mechanic to redo.'
            : 'All checks passed — this will be Approved for Admin confirmation.'}
        </div>
      )}

      {needsAttestation && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, fontSize: '0.85rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} style={{ marginTop: 3 }} />
          <span>I confirm I <strong>personally operated and tested</strong> this vehicle — this is not a paperwork-only sign-off.</span>
        </label>
      )}

      <div style={{ marginTop: 12 }}>
        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#475569', marginBottom: 4 }}>Notes {anyFailed ? '(what failed / needs redoing)' : '(optional)'}</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ width: '100%', borderRadius: 8, border: '1px solid #cbd5e1', padding: '8px 10px', fontSize: '0.85rem', fontFamily: 'inherit', resize: 'vertical' }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        <button type="button" className={anyFailed ? 'danger-button' : 'primary-button'} onClick={submit} disabled={!canSubmit}>
          {submitting ? 'Submitting…' : anyFailed ? 'Reject & Send Back' : 'Approve Repair'}
        </button>
      </div>
    </div>
  );
}

const confirmTicketFields = [
  { label: 'Confirmation Verdict', name: 'confirmation_verdict', options: ['Confirmed', 'Reopened'], required: true, type: 'select' },
  { label: 'Notes / Remarks', name: 'confirmation_notes', type: 'textarea', rows: 2 },
];

// =========================================================================
// TICKET STATUS BADGE
// =========================================================================

function TicketStatusBadge({ value, size = 'normal' }) {
  const colorMap = {
    'Open': 'ticket-open',
    'Active': 'ticket-repair',
    'For Maintenance': 'ticket-formaint',
    'Under Repair': 'ticket-repair',
    'Pending Approval': 'ticket-formaint',
    'For Inspection': 'ticket-forinspect',
    'For Confirmation': 'ticket-forconfirm',
    'Done': 'ticket-done',
    'Deferred': 'ticket-deferred',
    'Closed': 'ticket-done',
    'Deleted': 'ticket-cancelled',
    'Cancelled': 'ticket-cancelled',
    'Low': 'priority-low',
    'Medium': 'priority-medium',
    'High': 'priority-high',
    'Critical': 'priority-critical',
    'Needs Maintenance': 'ticket-formaint',
    'No Issues': 'ticket-done',
    'Approved': 'ticket-done',
    'Rejected': 'ticket-repair',
    'Confirmed': 'ticket-done',
    'Reopened': 'ticket-repair',
  };
  const cls = colorMap[value] ?? 'status-badge';
  return <span className={`status-badge ${cls} ${size === 'large' ? 'badge-large' : ''}`}>{value ?? '-'}</span>;
}

// =========================================================================
// TICKET PROPOSAL REVIEW — Admin's approve/decline screen for a Custodian's
// proposed ticket (status 'Pending Approval'). Kept as its own pair of
// components (not folded into the sub-issue cards below) so the existing
// read-only rendering for every other status stays completely untouched —
// TicketDetailPanel only ever mounts this while ticket.status is exactly
// 'Pending Approval', and swaps in a plain read-only notice instead for
// anyone viewing it without ticket.approve (i.e. the proposing Custodian).
// =========================================================================

function TicketProposalReview({ user, ticket, lookups, onApprove, onDecline }) {
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
function RepairContextDetails({ si }) {
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

function TicketProposalReviewForm({ ticket, lookups, onApprove, onDecline }) {
  // One ticket = one maintenance job. The Admin reviews the problem, picks the
  // mechanic and approves — assignment happens in the same click.
  const job = (ticket.sub_issues ?? [])[0] ?? null;
  const [fields, setFields] = useState({
    ticket_description: ticket.ticket_description ?? '',
    priority: ticket.priority ?? '',
    maintenance_type: job?.maintenance_type ?? '',
    assigned_mechanic_id: job?.suggested_mechanic_id ?? '',
  });
  const [declining, setDeclining] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const setField = (name, value) => setFields((f) => ({ ...f, [name]: value }));

  const submitApprove = async () => {
    setSubmitting(true);
    try {
      await onApprove({
        ticket_description: fields.ticket_description,
        priority: fields.priority,
        assigned_mechanic_id: fields.assigned_mechanic_id,
        sub_issues: job ? [{ sub_issue_id: job.sub_issue_id, title: job.title, maintenance_type: fields.maintenance_type || null }] : [],
      });
    } finally {
      setSubmitting(false);
    }
  };

  const custodianName = ticket.assigned_custodian?.name ?? 'the Custodian';

  return (
    <section className="ticket-section smart-form proposal-review">
      <div className="proposal-review-head">
        <span className="proposal-review-head-icon"><Icon name="checkCircle" size={18} /></span>
        <div className="proposal-review-head-text">
          <h4>Review &amp; Assign</h4>
          <p>Proposed by <strong>{custodianName}</strong></p>
        </div>
        <span className="proposal-review-pill">Pending Approval</span>
      </div>

      <div className="proposal-review-body">
        <div className="proposal-review-group">
          <div className="proposal-review-group-title"><Icon name="wrench" size={14} /> The Problem</div>
          <p style={{ margin: '0 0 12px', fontWeight: 600 }}>{job?.title ?? ticket.ticket_title}</p>
          <div className="ticket-form-grid-2" style={{ padding: 0, marginBottom: 12 }}>
            <label>
              <span>Maintenance Type</span>
              <CreatableSelect
                value={fields.maintenance_type}
                onChange={(v) => setField('maintenance_type', v)}
                options={lookups.maintenance_types ?? []}
                newItemLabel="maintenance type"
                catalogEndpoint="/maintenance-types"
              />
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
          <RepairContextDetails si={job} />
        </div>

        <div className="proposal-review-group">
          <div className="proposal-review-group-title"><Icon name="key" size={14} /> Assign the Work</div>
          <label>
            <span>Maintenance Personnel <span className="required-asterisk">*</span></span>
            <select value={fields.assigned_mechanic_id ?? ''} onChange={(e) => setField('assigned_mechanic_id', e.target.value)}>
              <option value="">Select who will do the work</option>
              {(lookups.maintenance_personnel ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
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
          <p className="proposal-review-hint">Approving sends the work order straight to the mechanic. Declining permanently deletes this proposal.</p>
          <div className="proposal-review-buttons">
            <button className="btn-sm danger-button" type="button" onClick={() => setDeclining(true)} disabled={submitting}>
              <Icon name="close" size={14} /> Decline
            </button>
            <button className="primary-button" type="button" onClick={submitApprove} disabled={submitting || !fields.assigned_mechanic_id}>
              <Icon name="checkCircle" size={14} /> Approve &amp; Assign
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

function TicketDetailPanel({ user, userId, ticket, lookups, onAssignMechanic, onReassignMechanic, onReassignCustodian, onConfirm, onReopenDone, onDeferSubIssue, onCloseTicket, onLogRepairs, onViewIssue, onCancel, onUncancel, onDelete, onRequestConfirmation, onVerify, onApproveCannibalization, onRejectCannibalization, onApproveProposal, onDeclineProposal, onClose, asPage = false }) {
  const [assigningAll, setAssigningAll] = useState(false);
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
      message: `Are you sure you want to completely delete Ticket #${ticket.ticket_id}? This action cannot be undone.`,
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
      <div className={`ticket-detail-panel${asPage ? ' is-page' : ''}`} onClick={asPage ? undefined : (e) => e.stopPropagation()}>
        <section className={`ticket-process-hero is-${nextSignal.tone}`}>
          <div className="ticket-process-meter" style={{ '--ticket-progress': `${resolvedPercent}%` }}>
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
            <h3 className="ticket-detail-title">{ticket.ticket_title}</h3>
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
                <div key={s} className={`ticket-process-flow-step is-${state}`} role="listitem">
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
                <div key={si.sub_issue_id} className="subissue-card">
                  <div className="subissue-card-head">
                    <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#eff6ff', color: '#2563eb', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, flexShrink: 0 }}>{index + 1}</span>
                    <strong style={{ fontSize: '0.9rem' }}>{si.title}</strong>
                    <TicketStatusBadge value={si.status} />
                  </div>

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
                </div>
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
                {' '}This ticket is ready to close
                {progress.deferred > 0 ? ' — closing now returns the vehicle to Available.' : '.'}
              </span>
              <button className="primary-button" type="button" onClick={() => onCloseTicket(ticket, {})}>Close Ticket</button>
            </div>
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
                  ] },
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

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {canDo(user, 'ticket.uncancel') && ticket.status === 'Cancelled' && onUncancel && (
              <button className="primary-button" type="button" onClick={() => onUncancel(ticket)}>Restore Ticket</button>
            )}
            {/* Close Ticket itself now lives in the green banner above when
                canClose is true — no need to repeat the same button here. */}
            {canDo(user, 'ticket.close') && canDecisionClose && !decisionClosing && (
              <button className="primary-button" type="button" style={{ background: '#d97706', borderColor: '#d97706' }} onClick={() => setDecisionClosing(true)}>Close as Decision</button>
            )}
            {/* Cancel is excluded once canClose too: every sub-issue is
                already resolved at that point, so there's real, confirmed
                work on record — cancelling would void it instead of just
                abandoning an unstarted/unfinished ticket. */}
            {/* A Pending Approval proposal isn't a live ticket yet — Approve/
                Decline in the Review Proposal block above are its real
                actions; Cancel/Delete here are for already-live tickets and
                would just bypass the decline notification. */}
            {canDo(user, 'ticket.cancel') && ticket.status !== 'Closed' && ticket.status !== 'Cancelled' && ticket.status !== 'Pending Approval' && !canClose && (
              <button className="ghost-button" type="button" onClick={requestCancel}>Cancel Ticket</button>
            )}
            {/* Once every sub-issue is resolved (ready to close) or the ticket
                is already Closed, there's real work on record — Delete is only
                for genuine mistakes, not for discarding finished repairs. */}
            {canDo(user, 'ticket.delete') && ticket.status !== 'Closed' && ticket.status !== 'Pending Approval' && !canClose && (
              <button className="danger-button" type="button" onClick={requestDelete}>Delete Ticket</button>
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

function TicketProfilePage({ ticketId, user, userId, ticketLookups, onBack, onRequestConfirmation, ticketAction: sendTicketAction }) {
  const navigate = useNavigate();
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const loadTicket = useCallback(() => {
    setLoading(true);
    return api.get(`/tickets/${ticketId}`)
      .then((response) => {
        setTicket(response.data);
        setNotFound(false);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [ticketId]);

  useEffect(() => { loadTicket(); }, [loadTicket]);

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
      onAssignMechanic={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/assign-mechanic`, payload, 'Mechanic assigned — work order dispatched.').then(afterAction)}
      onReassignMechanic={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/reassign-mechanic`, payload, 'Work order reassigned.').then(afterAction)}
      onReassignCustodian={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/reassign-custodian`, payload, 'Custodian reassigned.').then(afterAction)}
      onVerify={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/verify`, payload, 'Repair verification submitted.').then(afterAction)}
      onApproveCannibalization={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/approve-cannibalization`, payload, 'Cannibalized repair approved — a donor-vehicle issue report was opened.').then(afterAction)}
      onRejectCannibalization={(t, subIssue, payload) => sendTicketAction(`/tickets/${t.ticket_id}/sub-issues/${subIssue.sub_issue_id}/reject-cannibalization`, payload, 'Cannibalized repair rejected.').then(afterAction)}
      onLogRepairs={(t, si) => navigate(`${roleRoutes[user.role]}/work-orders/${t.ticket_id}/${si.sub_issue_id}/log-repairs`)}
      onCancel={(t) => sendTicketAction(`/tickets/${t.ticket_id}/cancel`, {}, 'Ticket cancelled.').then(afterAction)}
      onApproveProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/approve`, payload, 'Ticket proposal approved.').then(afterAction)}
      // Declining deletes the ticket server-side — nothing left to reload,
      // so this navigates away instead, same as onDelete just above.
      onDeclineProposal={(t, payload) => sendTicketAction(`/tickets/${t.ticket_id}/decline`, payload, 'Ticket proposal declined.').then((ok) => { if (ok) onBack(); return ok; })}
      onRequestConfirmation={onRequestConfirmation}
      onClose={onBack}
    />
  );
}

// A Custodian's "propose a ticket" form — their own diagnosis, including who
// they think should do each repair, submitted for an Admin to review before
// it becomes a real, live ticket (POST /tickets/propose). Deliberately a
// separate component from NewTicketPage above rather than a shared branch:
// Admin's flow is more elaborate (entry mode, cannibalized/external context,
// Assign to Custodian, a single shared sub-issue category) and none of that
// applies here — the backend self-assigns the proposing Custodian, and each
// sub-issue carries its own maintenance type + an optional suggested
// mechanic instead. Keeping it fully separate means Admin's existing form is
// untouched by this addition.
function ProposeTicketPage({ onBack, ticketLookups, onProposeTicket, onDirty, prefilledTicketData }) {
  // One problem -> one ticket. Everything the Custodian needs to say is on this
  // page: which vehicle, what is wrong, how urgent, and (optionally) who they
  // would suggest. The Admin approves it and assigns the mechanic in one step.
  // Opened from a due schedule or a condition check the form arrives pre-filled
  // and linked; otherwise it starts blank.
  const linkedScheduleId = prefilledTicketData?.schedule_id ?? null;
  const linkedConditionId = prefilledTicketData?.condition_check_id ?? null;
  const draftKey = `draft:propose-ticket:${linkedScheduleId ? `schedule-${linkedScheduleId}` : linkedConditionId ? `condition-${linkedConditionId}` : prefilledTicketData?.vehicle_id ? `vehicle-${prefilledTicketData.vehicle_id}` : 'blank'}`;
  const [values, setValues] = useDraftState(draftKey, () => ({
    vehicle_id: prefilledTicketData?.vehicle_id ?? '',
    problem: prefilledTicketData?.problem ?? '',
    maintenance_type: prefilledTicketData?.maintenance_type ?? '',
    details: prefilledTicketData?.details ?? '',
    priority: prefilledTicketData?.priority ?? 'Medium',
    suggested_mechanic_id: prefilledTicketData?.suggested_mechanic_id ?? '',
  }));
  const [submitting, setSubmitting] = useState(false);
  const [validationLines, setValidationLines] = useState(null);

  const setField = (name, value) => { setValues((v) => ({ ...v, [name]: value })); onDirty?.(); };

  const vehicleOptions = (ticketLookups.vehicles ?? []).filter((v) => v.status !== 'Inactive' && v.status !== 'Decommissioned');
  const priorityOptions = ticketLookups.priorities ?? [];
  const mechanicOptions = ticketLookups.maintenance_personnel ?? [];
  const selectedVehicle = vehicleOptions.find((v) => String(v.vehicle_id) === String(values.vehicle_id)) ?? null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errors = [];
    if (!values.vehicle_id) errors.push('Vehicle is required.');
    if (!(values.problem ?? '').trim()) errors.push('What is the problem? is required.');
    if (!values.priority) errors.push('Priority is required.');
    if (errors.length) { setValidationLines(errors); return; }

    setSubmitting(true);
    try {
      // No title is sent: the server builds "MT-0010 — Vehicle — Issue".
      const created = await onProposeTicket({
        vehicle_id: values.vehicle_id,
        ticket_description: (values.details ?? '').trim() || values.problem.trim(),
        priority: values.priority,
        entry_mode: 'in_house',
        schedule_id: linkedScheduleId || undefined,
        condition_check_id: linkedConditionId || undefined,
        sub_issues: [{
          title: values.problem.trim(),
          maintenance_type: values.maintenance_type || null,
          suggested_mechanic_id: values.suggested_mechanic_id || null,
        }],
      });
      if (created) { clearDraftState(draftKey); onBack(); }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModulePanel description="Describe the problem. An Admin reviews it, approves it and assigns a mechanic — nothing else to fill in.">
      {(linkedScheduleId || linkedConditionId) && (
        <div className="info-callout" style={{ marginBottom: '16px', background: 'rgba(59, 130, 246, 0.1)', borderColor: '#3b82f6' }}>
          <span style={{ marginRight: '8px', color: '#3b82f6', display: 'inline-flex' }}><Icon name="link" size={16} /></span>
          <p className="module-description" style={{ color: '#3b82f6', margin: 0 }}>
            Pre-filled from {linkedScheduleId ? <strong>a due maintenance schedule</strong> : <strong>a condition check</strong>} — review it and submit.
          </p>
        </div>
      )}
      <form className="smart-form ticket-create-form" onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {validationLines && (
          <div className="toast-notice-overlay" onClick={() => setValidationLines(null)}>
            <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
              <Icon name="alert" size={17} className="toast-notice-icon" />
              <div className="toast-notice-lines">
                {validationLines.map((line, i) => <span key={i}>{line}</span>)}
              </div>
              <button type="button" className="toast-notice-close" onClick={() => setValidationLines(null)} aria-label="Dismiss">
                <Icon name="close" size={13} />
              </button>
            </div>
          </div>
        )}

        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicle</h4></div>
          <div className="ticket-form-grid-2">
            <label>
              <span>Vehicle <span className="required-asterisk">*</span></span>
              <select required value={values.vehicle_id ?? ''} onChange={(e) => setField('vehicle_id', e.target.value)}>
                <option value="">{' '}</option>
                {vehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </select>
            </label>
          </div>
          {selectedVehicle && (
            <div className="ticket-selection-preview">
              <div className="ticket-preview-card ticket-preview-card--lg">
                {selectedVehicle.photo_url ? (
                  <img className="ticket-preview-photo ticket-preview-photo--lg" src={resolvePhotoUrl(selectedVehicle.photo_url)} alt={selectedVehicle.vehicle_name} />
                ) : (
                  <span className="ticket-preview-photo ticket-preview-photo--lg ticket-preview-photo-empty"><Icon name="vehicle" size={44} /></span>
                )}
                <div className="ticket-preview-body ticket-preview-body--lg">
                  <strong>{selectedVehicle.vehicle_name}</strong>
                  <span>{selectedVehicle.plate_number} &middot; {selectedVehicle.category?.category_name ?? 'Unclassified'}</span>
                  <span className="muted">{[selectedVehicle.brand, selectedVehicle.model].filter(Boolean).join(' ') || '—'} &middot; {selectedVehicle.current_location ?? 'No location on file'}</span>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="veh-card veh-card-form">
          <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>The Problem</h4></div>
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <label>
              <span>What is the problem? <span className="required-asterisk">*</span></span>
              <input type="text" placeholder="e.g. Brake pedal feels soft" value={values.problem ?? ''} onChange={(e) => setField('problem', e.target.value)} />
            </label>
            <label>
              <span>Maintenance Type</span>
              <CreatableSelect
                value={values.maintenance_type ?? ''}
                onChange={(v) => setField('maintenance_type', v)}
                options={ticketLookups?.maintenance_types ?? []}
                placeholder="Select a category or type to add new"
                newItemLabel="maintenance type"
                catalogEndpoint="/maintenance-types"
              />
            </label>
            <label>
              <span>Details (optional)</span>
              <textarea rows={3} value={values.details ?? ''} onChange={(e) => setField('details', e.target.value)} />
            </label>
            <div className="ticket-form-grid-2" style={{ padding: 0 }}>
              <label>
                <span>Priority <span className="required-asterisk">*</span></span>
                <select required value={values.priority ?? ''} onChange={(e) => setField('priority', e.target.value)}>
                  <option value="">{' '}</option>
                  {priorityOptions.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label>
                <span>Suggested mechanic (optional)</span>
                <select value={values.suggested_mechanic_id ?? ''} onChange={(e) => setField('suggested_mechanic_id', e.target.value)}>
                  <option value="">Admin will decide</option>
                  {mechanicOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
            </div>
          </div>
        </section>

        <div className="form-actions">
          <button type="button" className="ghost-button" onClick={onBack}>Cancel</button>
          <button type="submit" className="primary-button" disabled={submitting}>{submitting ? 'Submitting…' : 'Propose Ticket'}</button>
        </div>
      </form>
    </ModulePanel>
  );
}

// =========================================================================
// PHASE 1 + 4T2: ADMIN TICKET MODULE
// =========================================================================

function TicketModule({
  tickets,
  allTickets,
  ticketLookups,
  notifications = [],
  onViewTicket,
  onCreateNew,
  onViewArchives,
  searchQuery,
  setSearchQuery,
  categories,
  vehicles,
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterVehicle,
  setFilterVehicle,
  filterMechanic,
  setFilterMechanic,
  filterCustodian,
  setFilterCustodian,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  filterDateStart,
  setFilterDateStart,
  filterDateEnd,
  setFilterDateEnd,
}) {
  const [ticketViewMode, setTicketViewMode] = useState(
    () => localStorage.getItem('vms_ticket_view') || 'card'
  );

  const changeTicketViewMode = (mode) => {
    setTicketViewMode(mode);
    localStorage.setItem('vms_ticket_view', mode);
  };

  // Count alerts — now derived from sub-issues nested under each ticket,
  // since assignment/confirmation happen per sub-issue, not per ticket.
  // Sourced from the unfiltered list: these are "needs attention" banners,
  // so applying a status filter shouldn't make them under-report or vanish.
  const statSourceTickets = allTickets ?? tickets;
  const allSubIssues = statSourceTickets.flatMap((t) => t.sub_issues ?? []);
  const openSubIssueCount = allSubIssues.filter((s) => s.status === 'Open').length;
  const forConfirmSubIssueCount = allSubIssues.filter((s) => s.status === 'For Confirmation').length;
  const readyToCloseTickets = useMemo(
    () => statSourceTickets.filter((t) => t.status === 'Active' && (t.progress?.total ?? 0) > 0 && t.progress.done === t.progress.total),
    [statSourceTickets]
  );

  // Unread-updates badge per ticket card — counts this user's unread
  // notifications tied to that ticket (assignment, verification, etc.)
  // so an admin can spot which tickets have activity they haven't seen yet.
  const unreadByTicket = useMemo(() => {
    const counts = {};
    notifications.forEach((n) => {
      if (!n.read_at && n.ticket_id) {
        counts[n.ticket_id] = (counts[n.ticket_id] ?? 0) + 1;
      }
    });
    return counts;
  }, [notifications]);

  // Counts must come from the full ticket list, not the already
  // status-filtered `tickets` prop — otherwise clicking "Open" (say, 0
  // matches) would filter `tickets` down to nothing and every stat card,
  // including Total, would collapse to 0 along with it.
  const ticketStats = useMemo(() => {
    const counts = { total: statSourceTickets.length };
    ['Open', 'Pending Approval', 'Active', 'Closed', 'Cancelled'].forEach((s) => {
      counts[s] = statSourceTickets.filter((t) => t.status === s).length;
    });
    return counts;
  }, [statSourceTickets]);

  const ticketColumnDefs = useMemo(() => ticketTableColumns(unreadByTicket), [unreadByTicket]);
  const ticketColumnChooser = useColumnChooser('vms_ticket_columns', ticketColumnDefs);

  return (
    <div className="module-grid">
      <DismissibleHint description="Central Ticket Ledger — create tickets, assign custodians for inspection, dispatch mechanics, and confirm closures through the 5-phase workflow." />
      <ModuleStatCards
        totalLabel="Total Tickets"
        total={ticketStats.total}
        cards={TICKET_STAT_CARDS}
        counts={ticketStats}
        activeFilter={filterStatus}
        onFilterChange={setFilterStatus}
      />
      <section className="panel module-filter-panel">
        <TicketFilterPanel
          categories={categories}
          vehicles={vehicles}
          custodians={ticketLookups.custodians}
          maintenancePersonnelRoster={ticketLookups.maintenance_personnel}
          priorityLevels={ticketLookups.priorities}
          statusOptions={ticketLookups.ticket_statuses}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterCapacity={filterCapacity}
          setFilterCapacity={setFilterCapacity}
          filterVehicle={filterVehicle}
          setFilterVehicle={setFilterVehicle}
          filterMechanic={filterMechanic}
          setFilterMechanic={setFilterMechanic}
          filterCustodian={filterCustodian}
          setFilterCustodian={setFilterCustodian}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
          filterPriority={filterPriority}
          setFilterPriority={setFilterPriority}
          filterDateStart={filterDateStart}
          setFilterDateStart={setFilterDateStart}
          filterDateEnd={filterDateEnd}
          setFilterDateEnd={setFilterDateEnd}
        />
      </section>
      <TicketsReadyToClosePanel tickets={readyToCloseTickets} onViewTicket={onViewTicket} />

      <section className="panel">
        {/* Alert banners */}
        {openSubIssueCount > 0 && (
          <div className="ticket-alert-banner formaint">
            <Icon name="alert" size={16} /> <strong>{openSubIssueCount}</strong> sub-issue{openSubIssueCount > 1 ? 's' : ''} waiting for mechanic assignment.
          </div>
        )}
        {forConfirmSubIssueCount > 0 && (
          <div className="ticket-alert-banner forconfirm">
            <Icon name="checkCircle" size={16} /> <strong>{forConfirmSubIssueCount}</strong> sub-issue{forConfirmSubIssueCount > 1 ? 's' : ''} awaiting your final confirmation.
          </div>
        )}

        <div className="panel-header-bar" style={{ marginBottom: '8px' }}>
          <h3>All Tickets <span className="count-badge">{tickets.length}</span></h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {onViewArchives && (
              <button type="button" className="ghost-button" onClick={onViewArchives}>
                <Icon name="archive" size={14} /> Archives
              </button>
            )}
            <ViewModeDropdown value={ticketViewMode} onChange={changeTicketViewMode} />
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search tickets..."
              onAdd={onCreateNew}
              addLabel="Create Ticket"
              columnChooser={ticketViewMode === 'table' ? ticketColumnChooser : undefined}
            />
          </div>
        </div>

        <div style={{ height: '12px' }} />

        {tickets.length === 0
          ? <p className="empty-state">No tickets yet. Create one to begin the workflow.</p>
          : ticketViewMode === 'table'
            ? <PaginatedTable columns={ticketColumnChooser.visibleColumns} onReorderColumn={ticketColumnChooser.reorderColumn} rows={tickets} onRowClick={onViewTicket} />
            : (
              <PaginatedCardGrid
                items={tickets}
                keyOf={(t) => t.ticket_id}
                emptyMessage="No tickets yet. Create one to begin the workflow."
                renderItem={(t) => (
                  <TicketCard ticket={t} unreadCount={unreadByTicket[t.ticket_id] ?? 0} onClick={() => onViewTicket(t)} />
                )}
              />
            )
        }
      </section>
    </div>
  );
}

// =========================================================================
// VEHICLE DETAIL PANEL — shown when a vehicle row is clicked
// =========================================================================

// Gap A — the pre-deployment readiness checklist, by vehicle type. Distinct
// from the post-repair functional test: this proves the vehicle is mission-
// ready NOW (fuelled, equipped, working), regardless of whether it's broken.
function readinessChecklist(vehicle) {
  const domain = vehicle?.category?.domain ?? 'Land';
  const name = (vehicle?.category?.category_name ?? '').toLowerCase();
  if (domain === 'Water') return ['Fuel tank full', 'Life vests aboard', 'Bilge pump works', 'No water in the hull'];
  if (name.includes('ambulance')) return ['Fuel tank full', 'Oxygen tank present', 'Lights & siren work', 'Stretcher aboard'];
  if (name.includes('fire')) return ['Fuel tank full', 'Water tank full', 'Pump primes', 'Hoses aboard', 'Lights & siren work'];
  return ['Fuel tank full', 'Lights work', 'Engine starts normally'];
}

const READINESS_BADGE = {
  ready:          { label: 'Ready to respond', bg: '#ecfdf5', color: '#065f46', border: '#a7f3d0', icon: 'checkCircle' },
  stale:          { label: 'Readiness check', bg: '#fef3c7', color: '#92400e', border: '#fde68a', icon: 'alert' },
  not_ready:      { label: 'NOT ready to respond', bg: '#fee2e2', color: '#b91c1c', border: '#fecaca', icon: 'alert' },
  unchecked:      { label: 'Never checked', bg: '#f1f5f9', color: '#475569', border: '#cbd5e1', icon: 'alert' },
  in_maintenance: { label: 'In maintenance', bg: '#fff7ed', color: '#9a3412', border: '#fed7aa', icon: 'wrench' },
  retired:        { label: 'Out of fleet', bg: '#f1f5f9', color: '#475569', border: '#cbd5e1', icon: 'alert' },
};

function ReadinessCheckForm({ vehicle, onCancel, onSubmit }) {
  const items = useMemo(() => readinessChecklist(vehicle), [vehicle]);
  const [results, setResults] = useState(() => items.map((item) => ({ item, passed: null })));
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [newItemInput, setNewItemInput] = useState('');

  const allAnswered = results.length > 0 && results.every((r) => r.passed !== null);
  const anyFailed = results.some((r) => r.passed === false);
  const allOk = results.length > 0 && results.every((r) => r.passed === true);
  const setResult = (i, passed) => setResults((rs) => rs.map((r, idx) => (idx === i ? { ...r, passed } : r)));
  // Most checks are routine passes — checking each item individually is
  // needless friction. This bulk-marks everything OK in one click; any item
  // that actually failed just gets flipped to Fail afterward.
  const toggleAllOk = (checked) => setResults((rs) => rs.map((r) => ({ ...r, passed: checked ? true : null })));
  const addItem = () => {
    if (newItemInput.trim()) {
      setResults((rs) => [...rs, { item: newItemInput.trim(), passed: null }]);
      setNewItemInput('');
    }
  };
  const removeItem = (i) => setResults((rs) => rs.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({ checklist: results.map((r) => ({ item: r.item, passed: r.passed === true })), notes: notes || null });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.85rem' }}>
        Physically confirm the vehicle is ready to respond right now — fuelled, equipped, and working. Any failed item marks it NOT ready.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 8, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: '0.83rem', fontWeight: 600, color: '#1e40af', cursor: 'pointer' }}>
        <input type="checkbox" checked={allOk} onChange={(e) => toggleAllOk(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
        Mark all as OK
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {results.map((r, i) => (
          <div key={r.item} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
            <span style={{ fontSize: '0.85rem', flex: 1 }}>{r.item}</span>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button type="button" onClick={() => setResult(i, true)} style={{ padding: '4px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${r.passed === true ? '#16a34a' : '#cbd5e1'}`, background: r.passed === true ? '#16a34a' : '#fff', color: r.passed === true ? '#fff' : '#64748b' }}>OK</button>
              <button type="button" onClick={() => setResult(i, false)} style={{ padding: '4px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${r.passed === false ? '#dc2626' : '#cbd5e1'}`, background: r.passed === false ? '#dc2626' : '#fff', color: r.passed === false ? '#fff' : '#64748b' }}>Fail</button>
              <button
                type="button"
                onClick={() => removeItem(i)}
                title="Remove this item"
                style={{ padding: '4px 8px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: '1px solid #fca5a5', background: '#fef2f2', color: '#dc2626' }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            type="text"
            value={newItemInput}
            onChange={(e) => setNewItemInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && addItem()}
            placeholder="Add a custom checklist item..."
            style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.85rem', fontFamily: 'inherit' }}
          />
          <button
            type="button"
            onClick={addItem}
            style={{ padding: '8px 16px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: '1px solid #2563eb', background: '#2563eb', color: '#fff' }}
          >
            + Add Item
          </button>
        </div>
      </div>
      {allAnswered && (
        <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 8, background: anyFailed ? '#fef2f2' : '#ecfdf5', color: anyFailed ? '#991b1b' : '#065f46', border: `1px solid ${anyFailed ? '#fecaca' : '#a7f3d0'}` }}>
          <Icon name={anyFailed ? 'alert' : 'checkCircle'} size={15} />
          {anyFailed ? 'This vehicle will be marked NOT ready to respond.' : 'This vehicle will be marked verified ready to respond.'}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#475569', marginBottom: 4 }}>Notes (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ width: '100%', borderRadius: 8, border: '1px solid #cbd5e1', padding: '8px 10px', fontSize: '0.85rem', fontFamily: 'inherit', resize: 'vertical' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button" onClick={submit} disabled={!allAnswered || submitting}>
          {submitting ? 'Saving…' : 'Record Readiness Check'}
        </button>
      </div>
    </div>
  );
}

// Cross-vehicle "Vehicle Documents" sidebar entry — a vehicle picker beside
// the exact same per-vehicle Files card (VehicleFiles/VehicleFilesModal)
// VehicleProfilePage already uses, so there's no second document store or
// upload path to keep in sync, just another way to reach the existing one.
// Production-readiness audit finding #8 — FleetController::vehicleReliability()
// was fully built (failure counts, days out of service, lifetime spend, a
// chronic flag, a decommission signal) but had no caller anywhere in the
// frontend. Surfaced here, on the existing Vehicle Profile page, rather than
// a new sidebar module for one metric set.
function VehicleReliabilityCard({ vehicleId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/vehicles/${vehicleId}/reliability`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vehicleId]);

  const peso = (n) => `₱${Number(n ?? 0).toLocaleString()}`;

  return (
    <section className="veh-card">
      <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>Reliability</h4></div>
      {loading ? (
        <p className="muted" style={{ padding: '10px 14px' }}>Loading…</p>
      ) : !data ? (
        <p className="muted" style={{ padding: '10px 14px' }}>Reliability data is unavailable right now.</p>
      ) : (
        <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(data.chronic || data.decommission_signal) && (
            <div className="ticket-alert-banner formaint" style={{ marginBottom: 2 }}>
              <Icon name="alert" size={14} />
              {data.chronic && data.decommission_signal
                ? 'Chronic repeat failures, and lifetime repair spend is a large share of this vehicle’s value.'
                : data.chronic
                  ? 'Chronic repeat failures on this vehicle — consider a deeper fix.'
                  : 'Lifetime repair spend is a large share of this vehicle’s value — a decommission review may be worth it.'}
            </div>
          )}
          <dl className="veh-kv" style={{ margin: 0 }}>
            <div><dt>Failures (6 mo)</dt><dd>{data.failures_6mo}</dd></div>
            <div><dt>Failures (12 mo)</dt><dd>{data.failures_12mo}</dd></div>
            <div><dt>Avg. Days Out of Service</dt><dd>{data.avg_days_out ?? '-'}</dd></div>
            <div><dt>Lifetime Repair Spend</dt><dd>{peso(data.total_spend)}</dd></div>
            {data.acquisition_cost != null && (
              <div><dt>Spend vs. Acquisition Cost</dt><dd>{data.cost_ratio != null ? `${Math.round(data.cost_ratio * 100)}%` : '-'}</dd></div>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}

function VehicleFiles({ vehicleId, canManage, onRequestConfirmation }) {
  // canManage (Admin + Custodian, from VehicleProfilePage's
  // canManageDocuments) governs upload only here — VehicleFilesModal reads
  // the logged-in user itself to further narrow Edit to Admin (any) /
  // Custodian (their own upload only) and Delete to Admin only.
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [initialFile, setInitialFile] = useState(null);
  const [modalKey, setModalKey] = useState(0);

  const load = useCallback(() => {
    api.get(`/vehicles/${vehicleId}/documents`)
      .then((r) => setDocuments(r.data))
      .catch(() => setDocuments([]))
      .finally(() => setLoading(false));
  }, [vehicleId]);

  useEffect(() => { load(); }, [load]);

  const openModal = (file = null) => {
    setInitialFile(file);
    setModalKey((k) => k + 1);
    setModalOpen(true);
  };

  const modal = modalOpen && (
    <VehicleFilesModal
      key={modalKey}
      onClose={() => setModalOpen(false)}
      vehicleId={vehicleId}
      documents={documents}
      canManage={canManage}
      onChanged={load}
      initialFile={initialFile}
      onRequestConfirmation={onRequestConfirmation}
    />
  );

  return (
    <section className="veh-card veh-files">
      <div className="veh-card-head veh-files-head">
        <div className="veh-files-head-title"><Icon name="clipboard" size={16} /><h4>Files</h4></div>
        <div className="veh-files-head-actions">
          <button type="button" className="file-card-icon-btn" onClick={() => openModal()} title="Expand" aria-label="Expand">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
          {canManage && (
            <button type="button" className="file-card-icon-btn" onClick={() => openModal()} title="Add file" aria-label="Add file">
              <Icon name="plus" size={13} />
            </button>
          )}
        </div>
      </div>
      <div
        className="veh-files-body"
        onDragOver={(e) => canManage && e.preventDefault()}
        onDrop={(e) => {
          if (!canManage) return;
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) openModal(file);
        }}
      >
        {loading ? (
          <p className="empty-state">Loading files…</p>
        ) : documents.length ? (
          <div className="veh-files-compact-list">
            {documents.slice(0, 4).map((doc) => (
              <a key={doc.document_id} className="veh-files-compact-row" href={resolvePhotoUrl(doc.file_url)} target="_blank" rel="noreferrer">
                <Icon name="clipboard" size={14} />
                <span>{doc.title}</span>
              </a>
            ))}
            {documents.length > 4 && (
              <button type="button" className="veh-files-more" onClick={() => openModal()}>+{documents.length - 4} more</button>
            )}
          </div>
        ) : (
          <div className="file-card-empty">No data</div>
        )}
        {canManage && (
          <button type="button" className="file-card-dropzone veh-files-dropzone-trigger" onClick={() => openModal()}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 18a4.5 4.5 0 0 1-1-8.9A5.5 5.5 0 0 1 16.7 7 4.5 4.5 0 0 1 18 18" />
              <path d="M12 12v7" />
              <path d="M9.5 14.5 12 12l2.5 2.5" />
            </svg>
            <span>Drag file here</span>
          </button>
        )}
      </div>
      {modal}
    </section>
  );
}

// Given a fresh `key` every time it's opened (see VehicleFiles.openModal), so
// mounting with the right `initialFile` already pre-filled needs no
// reset-on-open effect — a new mount already starts from the right state.
function VehicleFilesModal({ onClose, vehicleId, documents, canManage, onChanged, initialFile, onRequestConfirmation }) {
  const { user } = useContext(AuthContext);
  // Phase B4 — document.delete is Admin-only (Custodian lost it); edit stays
  // Admin (any document) + Custodian, but only on the document THEY uploaded
  // (added_by is already in the list payload, so this needs no extra fetch —
  // the backend enforces the same ownership rule and 403s otherwise).
  const canDeleteDocs = hasRole(user, 'Admin');
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [pendingFile, setPendingFile] = useState(initialFile ?? null);
  const [addTitle, setAddTitle] = useState(initialFile ? initialFile.name.replace(/\.[^.]+$/, '') : '');
  const [addCategory, setAddCategory] = useState('');
  const [uploadPct, setUploadPct] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const selected = documents.find((d) => d.document_id === selectedId);
  const canEditSelected = !!selected && (hasRole(user, 'Admin') || (canDo(user, 'document.edit') && String(selected.added_by?.id) === String(user.id)));

  const handlePick = (file) => {
    setPendingFile(file);
    setAddTitle(file.name.replace(/\.[^.]+$/, ''));
    setError(null);
  };

  const handleUpload = async () => {
    if (!pendingFile || !addTitle.trim()) return;
    setUploadPct(0);
    setError(null);
    const formData = new FormData();
    formData.append('file', pendingFile);
    formData.append('title', addTitle.trim());
    if (addCategory.trim()) formData.append('category', addCategory.trim());
    try {
      await api.post(`/vehicles/${vehicleId}/documents`, formData, {
        onUploadProgress: (e) => setUploadPct(e.total ? Math.round((e.loaded * 100) / e.total) : null),
      });
      setPendingFile(null);
      setAddTitle('');
      setAddCategory('');
      setUploadPct(null);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Upload failed.');
      setUploadPct(null);
    }
  };

  const startEdit = (doc) => {
    setEditingId(doc.document_id);
    setEditTitle(doc.title);
    setEditCategory(doc.category ?? '');
  };

  const saveEdit = async () => {
    if (!editTitle.trim()) return;
    try {
      await api.put(`/documents/${editingId}`, { title: editTitle.trim(), category: editCategory.trim() || null });
      setEditingId(null);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Could not save changes.');
    }
  };

  const doDelete = async (doc) => {
    try {
      await api.delete(`/documents/${doc.document_id}`);
      if (selectedId === doc.document_id) setSelectedId(null);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Could not delete file.');
    }
  };

  const handleDelete = (doc) => {
    onRequestConfirmation?.({
      title: 'Delete File',
      message: `Delete "${doc.title}" from this vehicle's file cabinet? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => doDelete(doc),
    });
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-wide files-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Files</h3>
          <div className="files-modal-toolbar">
            {canManage && (
              <>
                <button type="button" className="file-card-icon-btn" onClick={() => fileInputRef.current?.click()} title="Add file" aria-label="Add file">
                  <Icon name="plus" size={14} />
                </button>
                <button
                  type="button"
                  className="file-card-icon-btn"
                  disabled={!canEditSelected}
                  onClick={() => canEditSelected && startEdit(selected)}
                  title={selected && !canEditSelected ? 'You can only edit a file you uploaded yourself' : 'Edit selected'}
                  aria-label="Edit selected"
                >
                  <Icon name="edit" size={14} />
                </button>
                {canDeleteDocs && (
                  <button type="button" className="file-card-icon-btn" disabled={!selected} onClick={() => selected && handleDelete(selected)} title="Delete selected" aria-label="Delete selected">
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </>
            )}
          </div>
          <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        <div className="modal-body">
          {error && (
            <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>
          )}
          <div className="files-modal-table-wrap">
            <table className="files-modal-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Added By</th>
                  <th>Date Added</th>
                </tr>
              </thead>
              <tbody>
                {documents.length === 0 ? (
                  <tr><td colSpan={5} className="files-modal-empty">No data</td></tr>
                ) : documents.map((doc) => (
                  <tr key={doc.document_id} className={selectedId === doc.document_id ? 'is-selected' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedId === doc.document_id}
                        onChange={() => setSelectedId(selectedId === doc.document_id ? null : doc.document_id)}
                      />
                    </td>
                    {editingId === doc.document_id ? (
                      <>
                        <td><input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></td>
                        <td><input value={editCategory} onChange={(e) => setEditCategory(e.target.value)} placeholder="Category" /></td>
                        <td>{doc.added_by?.name ?? '—'}</td>
                        <td>
                          <QuietDate value={doc.created_at} />
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button type="button" className="ghost-button" style={{ height: 28, padding: '0 10px', fontSize: '0.76rem' }} onClick={saveEdit}>Save</button>
                            <button type="button" className="ghost-button" style={{ height: 28, padding: '0 10px', fontSize: '0.76rem' }} onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          <a href={resolvePhotoUrl(doc.file_url)} target="_blank" rel="noreferrer" className="files-modal-title-link">
                            <Icon name="clipboard" size={13} />{doc.title}
                          </a>
                        </td>
                        <td>{doc.category || '—'}</td>
                        <td>{doc.added_by?.name ?? '—'}</td>
                        <td><QuietDate value={doc.created_at} /></td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canManage && (
            <div
              className="file-card-dropzone files-modal-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) handlePick(file);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => { const file = e.target.files?.[0]; if (file) handlePick(file); }}
              />
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 18a4.5 4.5 0 0 1-1-8.9A5.5 5.5 0 0 1 16.7 7 4.5 4.5 0 0 1 18 18" />
                <path d="M12 12v7" />
                <path d="M9.5 14.5 12 12l2.5 2.5" />
              </svg>
              <span>Drag file here</span>
            </div>
          )}

          {pendingFile && (
            <div className="files-modal-pending">
              <div className="files-modal-pending-row">
                <Icon name="clipboard" size={14} />
                <span className="files-modal-pending-name">{uploadPct != null ? 'Uploading… ' : ''}{pendingFile.name}</span>
                {uploadPct != null && <span className="files-modal-pending-pct">{uploadPct}%</span>}
                <button type="button" className="ghost-button" style={{ height: 28, padding: '0 10px', fontSize: '0.76rem' }} onClick={() => { setPendingFile(null); setUploadPct(null); }}>Cancel</button>
              </div>
              {uploadPct != null && (
                <div className="files-modal-progress-track"><div className="files-modal-progress-bar" style={{ width: `${uploadPct}%` }} /></div>
              )}
              {uploadPct == null && (
                <div className="files-modal-pending-fields">
                  <input placeholder="Title" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} />
                  <input placeholder="Category (optional)" value={addCategory} onChange={(e) => setAddCategory(e.target.value)} />
                  <button type="button" className="primary-button" style={{ height: 36, padding: '0 16px', fontSize: '0.85rem' }} onClick={handleUpload} disabled={!addTitle.trim()}>Add File</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function VehicleProfilePage({ vehicleId, lookups, allHubs, basePath, canManage = false, canManageDocuments = false, canViewDocuments = false, canCheckReadiness = false, canRecordCondition = false, canProposeTicket = false, onProposeMaintenance, canViewHistory = false, canViewReliability = false, canViewUsage = false, canLogUsage = false, setNotice, onSaved, onRequestConfirmation }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(new URLSearchParams(location.search).get('tab') === 'edit');
  const [decommissioning, setDecommissioning] = useState(false);
  const [readiness, setReadiness] = useState(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const [recordingCondition, setRecordingCondition] = useState(false);
  // Live-tracks the Edit form's Vehicle Type select so switching a vehicle
  // to a Water category shows Hull Material/Engine Type immediately,
  // instead of only after saving and reloading. Reset whenever a different
  // vehicle's edit form opens (see the effect below).
  const [editCategoryId, setEditCategoryId] = useState(null);

  const vehicle = (lookups.vehicles ?? []).find((v) => String(v.vehicle_id) === String(vehicleId));

  useEffect(() => {
    setEditCategoryId(vehicle?.category_id ?? null);
    // Deliberately keyed off vehicle_id only, not category_id — the latter
    // is exactly what this state tracks live while editing; including it
    // here would reset every live change right back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle?.vehicle_id]);

  // Gap A — response-readiness state.
  const loadReadiness = useCallback(() => {
    api.get(`/vehicles/${vehicleId}/readiness`).then((r) => setReadiness(r.data)).catch(() => setReadiness(null));
  }, [vehicleId]);

  useEffect(() => {
    loadReadiness();
  }, [loadReadiness]);

  const handleReadinessCheck = async (payload) => {
    setNotice(null);
    try {
      const response = await api.post(`/vehicles/${vehicleId}/readiness-check`, payload);
      loadReadiness();
      await onSaved();
      setNotice({ type: 'success', text: 'Readiness check recorded.' });
      setCheckingReadiness(false);

      // Only offered when the backend confirms it's safe: every item
      // passed AND the vehicle has no open ticket. A vehicle with an open
      // ticket must go back to Available through that ticket closing, not
      // through a generic checklist that never looked at the actual repair.
      if (response.data.can_mark_available) {
        onRequestConfirmation?.({
          title: 'Mark Vehicle Available',
          message: `Every item passed and ${vehicle.vehicle_name} has no open ticket — mark it Available now?`,
          confirmLabel: 'Mark Available',
          onConfirm: async () => {
            try {
              await api.put(`/vehicles/${vehicleId}/mark-available`);
              await onSaved();
              loadReadiness();
              setNotice({ type: 'success', text: 'Vehicle marked Available.' });
            } catch (error) {
              showError(error, setNotice);
            }
          },
        });
      }
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const handleDecommission = async (reason) => {
    setNotice(null);
    try {
      await api.put(`/vehicles/${vehicleId}/decommission`, { decommission_reason: reason });
      await onSaved();
      setNotice({ type: 'success', text: 'Vehicle decommissioned.' });
      setDecommissioning(false);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const handleRecommission = async () => {
    setNotice(null);
    try {
      await api.post(`/vehicles/${vehicleId}/restore`);
      await onSaved();
      setNotice({ type: 'success', text: 'Vehicle recommissioned to active service.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  if (!vehicle) {
    return (
      <ModulePanel description="This vehicle could not be found — it may have been archived.">
      </ModulePanel>
    );
  }

  // A condition check is the Custodian's quick "how does it look today" note.
  // Anything other than Good offers to propose a maintenance ticket right away,
  // pre-filled from the check — one click from "something is wrong" to the form.
  const handleConditionCheck = async (payload) => {
    setNotice(null);
    try {
      const response = await api.post('/conditions', { vehicle_id: vehicle.vehicle_id, ...payload });
      await onSaved();
      setRecordingCondition(false);
      setNotice({ type: 'success', text: 'Condition check recorded.' });
      if (payload.condition_result !== 'Good' && canProposeTicket) {
        onRequestConfirmation?.({
          title: 'Propose a maintenance ticket?',
          message: `${vehicle.vehicle_name} was recorded as "${payload.condition_result}". Propose maintenance for it now — the form is pre-filled.`,
          confirmLabel: 'Propose Ticket',
          onConfirm: () => onProposeMaintenance?.({
            vehicle_id: vehicle.vehicle_id,
            problem: payload.observations || payload.condition_result,
            details: payload.observations ? `Condition check: ${payload.condition_result}. ${payload.observations}` : `Condition check: ${payload.condition_result}.`,
            priority: payload.condition_result === 'Needs Repair' ? 'High' : 'Medium',
            condition_check_id: response.data?.condition_check_id,
          }),
        });
      }
    } catch (error) {
      showError(error, setNotice);
    }
  };
  const handleSave = async (payload) => {
    setNotice(null);
    try {
      const request = moduleRequest('vehicles', vehicle, payload);
      // Empty inputs are never sent, so a blanked custom field would silently
      // keep its old value — say "clear it" explicitly instead.
      const outgoing = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, k.startsWith('cf_') && (v === '' || v == null) ? '__clear__' : v]));
      await sendPayload(request.method, request.path, outgoing);
      await onSaved();
      setNotice({ type: 'success', text: 'Vehicle updated.' });
      setEditing(false);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // Derived data for the redesigned overview dashboard.
  const hub = (allHubs ?? []).find((h) => h.name === vehicle.current_location);
  const isWater = (vehicle.category?.domain ?? 'Land') === 'Water';
  return (
    <ModulePanel description="Full profile, maintenance, and tickets for this vehicle.">
      <div className="vehicle-profile-header">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
          {canManage && vehicle.status !== 'Decommissioned' && !editing && (
            <button className="btn-sm primary-button" type="button" onClick={() => setEditing(true)}>
              <Icon name="edit" size={13} /> Edit Vehicle
            </button>
          )}
          {canProposeTicket && !['Decommissioned', 'Inactive'].includes(vehicle.status) && !editing && (
            <button className="btn-sm primary-button" type="button" onClick={() => onProposeMaintenance?.({ vehicle_id: vehicle.vehicle_id })}>
              <Icon name="wrench" size={13} /> Propose Maintenance
            </button>
          )}
          {canRecordCondition && !['Decommissioned', 'Inactive'].includes(vehicle.status) && !editing && (
            <button className="btn-sm ghost-button" type="button" onClick={() => setRecordingCondition(true)}>
              <Icon name="search" size={13} /> Condition Check
            </button>
          )}
          {canCheckReadiness && !['Decommissioned', 'Inactive'].includes(vehicle.status) && !editing && (
            <button className="btn-sm success-button" type="button" onClick={() => setCheckingReadiness(true)}>
              <Icon name="checkCircle" size={13} /> Readiness Check
            </button>
          )}
          {canManage && vehicle.status !== 'Decommissioned' && !editing && (
            <button className="btn-sm danger-button" type="button" onClick={() => setDecommissioning(true)}>
              <Icon name="alert" size={13} /> Decommission
            </button>
          )}
          {canManage && vehicle.status === 'Decommissioned' && (
            <button className="btn-sm primary-button" type="button" onClick={() => onRequestConfirmation?.({
              title: 'Recommission Vehicle',
              message: `Bring ${vehicle.vehicle_name} back into active service? This reverses the decommission.`,
              confirmLabel: 'Recommission',
              onConfirm: handleRecommission,
            })}>
              <Icon name="undo" size={13} /> Recommission
            </button>
          )}
        </div>
      </div>

      {vehicle.status === 'Decommissioned' && (
        <div style={{ margin: '0 0 16px', padding: '14px 18px', borderRadius: 12, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, marginBottom: 4 }}>
            <Icon name="alert" size={18} /> Decommissioned — retired from the fleet
          </div>
          {vehicle.decommission_reason && <p style={{ margin: '4px 0 0' }}>Reason: {vehicle.decommission_reason}</p>}
          {vehicle.decommissioned_at && <p style={{ margin: '4px 0 0', fontSize: '0.82rem', opacity: 0.85 }}>Retired {formatDate(vehicle.decommissioned_at)}. Its history is preserved; it no longer counts toward readiness.</p>}
        </div>
      )}

      <FormModal open={checkingReadiness} title={`Readiness Check — ${vehicle.vehicle_name}`} onClose={() => setCheckingReadiness(false)}>
        <ReadinessCheckForm
          key={`readiness-${vehicle.vehicle_id}`}
          vehicle={vehicle}
          onCancel={() => setCheckingReadiness(false)}
          onSubmit={handleReadinessCheck}
        />
      </FormModal>

      <FormModal open={recordingCondition} title={`Condition Check — ${vehicle.vehicle_name}`} onClose={() => setRecordingCondition(false)}>
        <SmartForm
          fields={[
            { label: 'Condition', name: 'condition_result', options: ['Good', 'Needs Inspection', 'Needs Repair'], required: true, type: 'select' },
            { label: 'Observations (optional)', name: 'observations', type: 'textarea', rows: 3 },
          ]}
          key={`condition-${vehicle.vehicle_id}`}
          initialValues={{ condition_result: 'Good' }}
          onCancel={() => setRecordingCondition(false)}
          onSubmit={handleConditionCheck}
          submitLabel="Save Check"
          title=""
        />
      </FormModal>

      <FormModal open={decommissioning} title={`Decommission ${vehicle.vehicle_name}`} onClose={() => setDecommissioning(false)}>
        <p className="muted" style={{ marginBottom: 12, fontSize: '0.85rem' }}>
          This permanently retires the vehicle (end of life) and removes it from readiness/coverage. Its full history is kept, and an Admin can recommission it later if this was a mistake.
        </p>
        <SmartForm
          fields={[{ label: 'Reason for decommissioning', name: 'decommission_reason', required: true, type: 'textarea', rows: 3 }]}
          key="decommission"
          onCancel={() => setDecommissioning(false)}
          onSubmit={(payload) => handleDecommission(payload.decommission_reason)}
          submitLabel="Decommission Vehicle"
          title=""
        />
      </FormModal>

      {editing ? (
        <section className="veh-card veh-edit-card">
          <div className="veh-card-head"><Icon name="edit" size={16} /><h4>Edit Vehicle Information</h4></div>
          <div className="form-grid-2col veh-edit-body">
            <SmartForm
              fields={vehicleFields(
                lookups,
                allHubs,
                lookups.categories?.find((c) => String(c.category_id) === String(editCategoryId))?.domain
                  ?? vehicle.category?.domain
                  ?? 'Land',
                vehicle.photo_url,
                lookups.categories?.find((c) => String(c.category_id) === String(editCategoryId))
              )}
              initialValues={vehicleWithCustomInitials(vehicle)}
              key={vehicle.vehicle_id}
              onValuesChange={(vals) => setEditCategoryId(vals.category_id)}
              onCancel={() => setEditing(false)}
              onSubmit={handleSave}
              submitLabel="Save Changes"
              title=""
            />
          </div>
        </section>
      ) : (
      <>
      <div className="veh-dash">
        <div className="veh-dash-left">
          <section className="veh-card veh-info">
            <div className="veh-card-head"><Icon name={vehicleIconName(vehicle.category?.domain)} size={16} /><h4>Vehicle Information</h4></div>
            <div className="veh-info-body">
              <div className="veh-info-identity">
                <h3>{vehicle.vehicle_name}</h3>
                <span>{vehicle.category?.domain ?? 'Land'}.{vehicle.plate_number}</span>
              </div>
              {vehicle.photo_url && (
                <div className="veh-info-photo"><PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} /></div>
              )}
              <dl className="veh-kv">
                <div><dt>Vehicle Type</dt><dd>{vehicle.category?.category_name ?? 'Unassigned'}</dd></div>
                <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
                <div><dt>Year Model</dt><dd>{vehicle.year_model ?? '-'}</dd></div>
                <div><dt>Capacity</dt><dd>{vehicle.capacity ?? '-'}</dd></div>
                <div><dt>Color</dt><dd>{vehicle.vehicle_color ?? '-'}</dd></div>
                {isWater && (
                  <>
                    <div><dt>Hull Material</dt><dd>{vehicle.hull_material ?? '-'}</dd></div>
                    <div><dt>Engine Type</dt><dd>{vehicle.engine_type ?? '-'}</dd></div>
                  </>
                )}
                <div><dt>Fuel Type</dt><dd>{vehicle.fuel_type ?? '-'}</dd></div>
                {customValueRows(vehicle, lookups)}
              </dl>
            </div>
            {vehicle.remarks && (
              <div className="veh-remarks"><span className="veh-remarks-label">Remarks</span><p>{vehicle.remarks}</p></div>
            )}
          </section>
        </div>

        <div className="veh-dash-right">
          <div className="veh-status-row">
            <section className="veh-card veh-keydates">
              <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Status &amp; Key Dates</h4></div>
              <dl className="veh-kv">
                <div><dt>Availability</dt><dd><StatusBadge value={vehicle.status} /></dd></div>
                <div><dt>Condition</dt><dd><StatusBadge value={vehicle.condition} /></dd></div>
                {readiness && READINESS_BADGE[readiness.state] && (
                  <div><dt>Response Readiness</dt><dd>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.76rem', fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: READINESS_BADGE[readiness.state].bg, color: READINESS_BADGE[readiness.state].color, border: `1px solid ${READINESS_BADGE[readiness.state].border}` }}>
                      <Icon name={READINESS_BADGE[readiness.state].icon} size={11} /> {READINESS_BADGE[readiness.state].label}
                    </span>
                    {readiness.last_checked && <div className="muted" style={{ fontSize: '0.72rem', marginTop: 3 }}>Last checked {formatDate(readiness.last_checked)}</div>}
                  </dd></div>
                )}
                {/* Confirmed via live review: a vehicle marked Under
                    Maintenance had no visible path to WHY, forcing a
                    separate hunt through Maintenance Tickets. */}
                {readiness?.active_ticket_id && (
                  <div><dt>Active Ticket</dt><dd>
                    <button
                      type="button"
                      className="btn-view-action"
                      style={{ fontSize: '0.78rem', padding: '3px 10px' }}
                      onClick={() => navigate(`${basePath}/tickets/${readiness.active_ticket_id}`)}
                    >
                      {readiness.active_ticket_title ?? `Ticket #${readiness.active_ticket_id}`} →
                    </button>
                  </dd></div>
                )}
                {/* Kept beside the other at-a-glance status signals (not
                    buried under specs) — this is how urgently a down unit of
                    this type matters, same scale as the dashboard's
                    Readiness & Criticality Watch. */}
                <div><dt>Criticality</dt><dd>
                  <span className={`risk-watch-tag${(vehicle.criticality ?? defaultCriticalityFor(vehicle, lookups)) === 'Critical' ? ' is-critical' : ''}`}>
                    {(vehicle.criticality ?? defaultCriticalityFor(vehicle, lookups)).toUpperCase()}
                  </span>
                  <div className="muted" style={{ fontSize: '0.72rem', marginTop: 3 }}>{vehicle.criticality ? 'Set for this vehicle' : 'From vehicle type'}</div>
                </dd></div>
                <div><dt>Current Location</dt><dd>{vehicle.current_location ?? '-'}</dd></div>
                {vehicle.estimated_return_date && (
                  <div><dt>Est. Return Date</dt><dd>{formatForecastDate(vehicle.estimated_return_date)}</dd></div>
                )}
                <div><dt>Date Added</dt><dd>{vehicle.created_at ? <QuietDate value={vehicle.created_at} /> : '-'}</dd></div>
                <div><dt>Last Updated</dt><dd>{vehicle.updated_at ? <QuietDate value={vehicle.updated_at} /> : '-'}</dd></div>
              </dl>
            </section>

            <div className="veh-square-col">
              <section className="veh-card veh-reports">
                <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Reports</h4></div>
                <div className="veh-reports-body">
                  <select className="veh-reports-select" defaultValue="summary">
                    <option value="summary">Vehicle Summary Report</option>
                  </select>
                  <button type="button" className="veh-reports-print-btn" onClick={() => window.print()} title="Print report" aria-label="Print report">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 9V3h12v6" />
                      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                      <rect x="6" y="14" width="12" height="8" />
                    </svg>
                  </button>
                </div>
              </section>

              {canViewDocuments && <VehicleFiles vehicleId={vehicle.vehicle_id} canManage={canManageDocuments} onRequestConfirmation={onRequestConfirmation} />}

              {canViewReliability && <VehicleReliabilityCard vehicleId={vehicle.vehicle_id} />}

              {canViewUsage && <VehicleUsageCard vehicleId={vehicle.vehicle_id} canLog={canLogUsage} vehicleStatus={vehicle.status} readinessState={readiness?.state} onChanged={onSaved} />}

              {canViewHistory && <VehicleHistoryCard vehicleId={vehicle.vehicle_id} />}
            </div>
          </div>

          <section className="veh-card veh-map">
            <div className="veh-card-head"><Icon name="pin" size={16} /><h4>Current Location — {vehicle.current_location ?? 'Unknown'}</h4></div>
            <div className="veh-map-wrap">
              <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} scrollWheelZoom />
            </div>
          </section>
        </div>
      </div>

      {/* Print-only — kept off-screen (see .veh-print-report), shown by the
          Reports card's print button via window.print(). Portaled straight
          to <body> so it never inherits the app shell's own responsive
          collapse (that grid narrows unpredictably once Chromium's print
          engine evaluates media queries against the paper width instead of
          the screen viewport) and so normal document flow — not
          position:fixed — is what lands on the page: a fixed element
          gets reprinted on every page, which was duplicating this whole
          report onto page 2. Reuses the report band/grid look so a
          printed page still reads as a formal document: vehicle identity
          on the left, VMS mark on the right, blue bands. */}
      {createPortal(
        <div className="veh-print-report">
          <div className="veh-print-header">
            <div className="veh-print-header-left">
              <h2>{vehicle.vehicle_name}</h2>
              <p>{vehicle.category?.domain ?? 'Land'}.{vehicle.plate_number}</p>
            </div>
            <div className="veh-print-header-right">
              <Icon name="gear" size={48} className="topbar-gear-icon" filled />
              <span className="vms-wordmark">vms</span>
            </div>
          </div>
          <div className="veh-print-body">
            <div className="veh-print-media">
              {vehicle.photo_url && (
                <div className="veh-print-photo"><PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} /></div>
              )}
            </div>
            <div className="veh-print-info">
              <div className="veh-report-band">Vehicle Information</div>
              <dl className="veh-report-grid">
                <div><dt>{plateFieldLabel(vehicle.category?.domain)}</dt><dd>{vehicle.plate_number}</dd></div>
                <div><dt>Vehicle Name</dt><dd>{vehicle.vehicle_name}</dd></div>
                <div><dt>Vehicle Type</dt><dd>{vehicle.category?.category_name ?? 'Unassigned'}</dd></div>
                <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
                <div><dt>Year Model</dt><dd>{vehicle.year_model ?? '-'}</dd></div>
                <div><dt>Capacity</dt><dd>{vehicle.capacity ?? '-'}</dd></div>
                <div><dt>Color</dt><dd>{vehicle.vehicle_color ?? '-'}</dd></div>
                <div><dt>Fuel Type</dt><dd>{vehicle.fuel_type ?? '-'}</dd></div>
                {isWater && (
                  <>
                    <div><dt>Hull Material</dt><dd>{vehicle.hull_material ?? '-'}</dd></div>
                    <div><dt>Engine Type</dt><dd>{vehicle.engine_type ?? '-'}</dd></div>
                  </>
                )}
                <div><dt>Criticality</dt><dd>{vehicleCriticality(vehicle, lookups)}</dd></div>
                {customValueRows(vehicle, lookups)}
                <div><dt>Acquisition Cost</dt><dd>{vehicle.acquisition_cost != null ? `₱${Number(vehicle.acquisition_cost).toLocaleString()}` : '-'}</dd></div>
                <div><dt>Status</dt><dd>{vehicle.status}</dd></div>
                <div><dt>Condition</dt><dd>{vehicle.condition}</dd></div>
                <div><dt>Current Location</dt><dd>{vehicle.current_location ?? '-'}</dd></div>
                <div><dt>Date Added</dt><dd>{vehicle.created_at ? <QuietDate value={vehicle.created_at} /> : '-'}</dd></div>
                <div><dt>Last Updated</dt><dd>{vehicle.updated_at ? <QuietDate value={vehicle.updated_at} /> : '-'}</dd></div>
              </dl>
            </div>
          </div>
          <div className="veh-print-map-wide">
            <div className="veh-report-band">Current Location — {vehicle.current_location ?? 'Unknown'}</div>
            <div className="veh-print-map">
              <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} />
            </div>
          </div>
        </div>,
        document.body
      )}
      </>
      )}
    </ModulePanel>
  );
}

// =========================================================================
// TICKET CARD
// =========================================================================

// A ticket's broad status (Open/Active/Closed/Cancelled) doesn't say whose
// turn it is right now — "Active" alone looks the same whether a mechanic
// is still mid-repair, or the Custodian/Admin already responded and it's
// sitting untouched waiting for someone. This derives the actual next step
// from the ticket + its sub-issues, so that's visible at a glance instead of
// hiding behind a generic unread-notification counter.
function ticketWorkflowStage(ticket) {
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
const TICKET_STAGE_STYLE = {
  action:  { bg: 'linear-gradient(90deg,#faf5ff,#ede9fe)', color: '#5b21b6', icon: 'alert' },
  waiting: { bg: 'linear-gradient(90deg,#eff6ff,#dbeafe)', color: '#1d4ed8', icon: 'search' },
  info:    { bg: 'linear-gradient(90deg,#f8fafc,#f1f5f9)', color: '#475569', icon: 'wrench' },
};

function TicketStageBadge({ ticket, variant = 'flag' }) {
  const stage = ticketWorkflowStage(ticket);
  if (!stage) return null;
  const style = TICKET_STAGE_STYLE[stage.tone];
  // "flag" (default) reads as a leading tab flush against a card's left
  // edge — right for TicketCard, but floats oddly with nothing to sit
  // flush against once it's just one badge among others in a header row.
  // "pill" matches the rounded status/priority badges beside it there.
  if (variant === 'pill') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 700,
        padding: '5px 12px', borderRadius: 999, background: style.bg,
        border: `1px solid ${style.color}55`, color: style.color,
      }}>
        <Icon name={style.icon} size={12} /> {stage.label}
      </span>
    );
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 700,
      padding: '6px 10px', borderRadius: '0 6px 6px 0', background: style.bg,
      borderLeft: `3px solid ${style.color}`, color: style.color,
    }}>
      <Icon name={style.icon} size={12} /> {stage.label}
    </div>
  );
}

function TicketCard({ ticket, unreadCount = 0, onClick }) {
  const progress = ticket.progress;
  const stage = ticketWorkflowStage(ticket);

  return (
    <div className="ticket-card" style={{ position: 'relative' }} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      {unreadCount > 0 && (
        <span
          title={`${unreadCount} unread update${unreadCount > 1 ? 's' : ''} on this ticket`}
          style={{
            position: 'absolute', top: -8, right: -8, minWidth: 20, height: 20, padding: '0 5px',
            borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: '0.7rem', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.25)', zIndex: 1,
          }}
        >
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
      <div className="ticket-card-content-wrapper">
        <div className="ticket-card-info">
          <div className="ticket-card-top">
            <span className="ticket-card-id">Ticket #{ticket.ticket_id}</span>
            <TicketStatusBadge value={ticket.priority} />
          </div>
          <p className="ticket-card-title">{ticket.ticket_title}</p>
          <p className="ticket-card-vehicle">{ticket.vehicle?.vehicle_name} · {ticket.vehicle?.plate_number}</p>
        </div>
        {ticket.vehicle?.photo_url && (
          <div className="ticket-card-photo">
            <img src={resolvePhotoUrl(ticket.vehicle.photo_url)} alt={ticket.vehicle.vehicle_name} />
          </div>
        )}
      </div>
      <div style={{ margin: '8px 0 2px', minHeight: 22 }}>
        {progress?.total > 0 && (
          <>
            <div style={{ height: 6, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${(progress.done / progress.total) * 100}%`,
                background: progress.done === progress.total ? '#16a34a' : '#d97706',
                borderRadius: 999,
              }} />
            </div>
            <span className="muted" style={{ fontSize: '0.72rem' }}>{progress.done}/{progress.total} sub-issues done</span>
          </>
        )}
      </div>
      <div style={{ margin: '6px 0 2px', minHeight: 26 }}>
        {stage && <TicketStageBadge ticket={ticket} />}
      </div>
      <div className="ticket-card-bottom">
        <TicketStatusBadge value={ticket.status} />
        <DateBadge value={ticket.created_at} />
      </div>
    </div>
  );
}

// =========================================================================
// PHASE 2: CUSTODIAN INSPECTION MODULE
// =========================================================================

// =========================================================================
// PHASE 4 TIER 1: CUSTODIAN REPAIR VERIFICATION
// =========================================================================

function CustodianVerificationModule({
  user,
  tickets,
  editTarget,
  setEditTarget,
  onVerify,
  onCancelEdit,
  categories,
  vehicles,
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterPriority,
  setFilterPriority,
  mechanicOptions,
  filterVerdict,
  setFilterVerdict,
  onViewVehicle,
  stats,
  activeFilter,
  onFilterChange,
  tabBar
}) {
  const [viewLogsTarget, setViewLogsTarget] = useState(null);
  const isPendingView = activeFilter !== 'Verified';

  const verificationColumnDefs = useMemo(() => [
    { key: 'ticket_id', label: 'Ticket ID', locked: true, className: 'cell-center', render: (r) => r.ticket_id },
    { key: 'ticket_title', label: 'Ticket Title', render: (r) => r.ticket_title },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (r) => <VehicleCell vehicle={r.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => r.vehicle?.plate_number ?? '-' },
    { key: 'sub_issue', label: 'Sub-Issue', render: (r) => r.title },
    { key: 'mechanic', label: 'Mechanic', className: 'cell-center', render: (r) => r.assigned_mechanic?.name ?? '—' },
    {
      key: 'repair_log',
      label: 'Repair Log',
      render: (r) => r.repair_logs ? (
        <button
          type="button"
          className="link-button"
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline', fontWeight: 500 }}
          onClick={() => setViewLogsTarget(r)}
        >
          View Logs ↗
        </button>
      ) : '—'
    },
    { key: 'parts_used', label: 'Parts Used', render: (r) => <PartsTags value={r.parts_used} /> },
    {
      key: 'status',
      label: 'Status',
      className: 'cell-center',
      render: (r) => {
        if (r.reopened_at) {
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600 }} title={`Reopened by ${r.reopened_by?.name || 'Admin'}`}>
              <Icon name="alert" size={12} /> Reopened
            </span>
          );
        }
        return r.verification_verdict ? <TicketStatusBadge value={r.verification_verdict} /> : <span className="muted">—</span>;
      }
    },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      render: (r) => {
        if (r.status === 'For Inspection') {
          const assignedId = typeof r.verification_assigned_to === 'object' ? r.verification_assigned_to?.id : r.verification_assigned_to;
          const isAssignedToUser = assignedId === user.id || String(assignedId) === String(user.id);
          // Mirrors TicketController::verifyRepair's own guard — a dual-role
          // (Custodian + Maintenance Personnel) account assigned to verify
          // their own repair can't "grade their own homework" here even
          // though they're the assigned verifier. The button is hidden
          // proactively; the backend is what actually enforces it. Fixed by
          // reassigning the ticket to a different Custodian (audit finding
          // #2 removed the old "an Admin can step in" bypass).
          const isOwnRepair = r.assigned_mechanic_id != null
            && (r.assigned_mechanic_id === user.id || String(r.assigned_mechanic_id) === String(user.id));
          if (isAssignedToUser && isOwnRepair) {
            return <span className="muted" title="You performed this repair — reassign this ticket to a different Custodian to verify it.">Needs reassignment (you did this repair)</span>;
          }
          if (isAssignedToUser) {
            return <button className="btn-edit-action icon-btn" type="button" onClick={() => setEditTarget(r)} title="Verify Repair" aria-label="Verify Repair"><Icon name="checkCircle" size={14} /></button>;
          }
          const assignedName = (typeof r.verification_assigned_to === 'object' ? r.verification_assigned_to?.name : null) || 'another custodian';
          return <span className="muted" title={`Assigned to ${assignedName}`}>Assigned to {assignedName}</span>;
        }
        return <span className="muted">Submitted</span>;
      }
    },
  ], [user.id, setEditTarget]);
  const verificationColumnChooser = useColumnChooser('vms_custodian_verification_columns', verificationColumnDefs);

  return (
    <div className="module-grid">
      <DismissibleHint description="Phase 4 Tier 1 — Repair Integrity Verification. Review mechanic work, issue your inspection verdict before Admin confirmation, and check back here to see what you've already verified." />
      {tabBar}
      <ModuleStatCards
        totalLabel="Total Assigned"
        total={stats.total}
        cards={TICKET_VERIFICATION_STAT_CARDS}
        counts={stats}
        activeFilter={activeFilter}
        onFilterChange={onFilterChange}
      />
      <section className="panel module-filter-panel">
        <FilterBar
          categories={categories}
          vehicles={vehicles}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterCapacity={filterCapacity}
          setFilterCapacity={setFilterCapacity}
          filterPriority={filterPriority}
          setFilterPriority={setFilterPriority}
          priorityOptions={mechanicOptions}
          priorityLabel="Mechanic"
          extraFilters={[{
            key: 'verdict',
            label: 'Verdicts',
            options: ['Approved', 'Rejected'],
            selected: filterVerdict,
            setSelected: setFilterVerdict,
          }]}
        />
      </section>
      <section className="panel">
        <div className="panel-header-bar">
          <h3>{isPendingView ? 'Pending Verifications' : 'Verified Repairs'} <span className="count-badge">{tickets.length}</span></h3>
          <ColumnChooserButton {...verificationColumnChooser} />
        </div>
        <div style={{ height: '16px' }} />
        {tickets.length === 0
          ? <p className="empty-state">{isPendingView ? 'No repairs pending your verification.' : 'No repairs verified yet.'}</p>
          : (
            <DataTable
              columns={verificationColumnChooser.visibleColumns}
              onReorderColumn={verificationColumnChooser.reorderColumn}
              rows={tickets}
              onRowClick={(row) => row.vehicle && onViewVehicle(row.vehicle)}
            />
          )
        }
      </section>
      <FormModal open={!!editTarget} title={`Functional Test — ${editTarget?.ticket_title ? `${editTarget.ticket_title}: ` : ''}${editTarget?.title ?? `Ticket #${editTarget?.ticket_id}`}`} onClose={onCancelEdit}>
        <VerificationForm
          key={editTarget?.sub_issue_id ?? editTarget?.ticket_id}
          target={editTarget}
          onCancel={onCancelEdit}
          onSubmit={(payload) => onVerify(editTarget, payload)}
        />
        <div style={{marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--border-subtle)'}}>
          <p className="muted"><strong>Repair Log:</strong></p>
          <RepairLogEntries text={editTarget?.repair_logs} />
        </div>
      </FormModal>

      <FormModal open={!!viewLogsTarget} title={`Repair Details — Ticket #${viewLogsTarget?.ticket_id}`} onClose={() => setViewLogsTarget(null)}>
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Vehicle</h4>
            <div style={{ fontWeight: 600 }}>{viewLogsTarget?.vehicle?.vehicle_name} ({viewLogsTarget?.vehicle?.plate_number})</div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Work Order Title</h4>
            <div style={{ fontWeight: 600 }}>{viewLogsTarget?.ticket_title}</div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Mechanic</h4>
            <div>{viewLogsTarget?.assigned_mechanic?.name ?? '—'}</div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Log Entry</h4>
            <pre style={{ 
              whiteSpace: 'pre-wrap', 
              fontFamily: 'inherit', 
              background: '#f8fafc', 
              border: '1px solid #e2e8f0', 
              borderRadius: '6px', 
              padding: '12px', 
              fontSize: '0.9rem',
              lineHeight: '1.5',
              margin: '6px 0 0 0'
            }}>{viewLogsTarget?.repair_logs ?? 'No logs provided.'}</pre>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Parts / Materials Used</h4>
            <div style={{ marginTop: '6px' }}>
              <PartsTags value={viewLogsTarget?.parts_used} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
            <div>
              <h4 style={{ margin: '0 0 4px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Start Date</h4>
              <div>{viewLogsTarget?.repair_started_at ? formatDate(viewLogsTarget.repair_started_at) : '—'}</div>
            </div>
            <div>
              <h4 style={{ margin: '0 0 4px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Completion Date</h4>
              <div>{viewLogsTarget?.repair_completed_at ? formatDate(viewLogsTarget.repair_completed_at) : '—'}</div>
            </div>
          </div>
          <div>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Cost / Expenses</h4>
            <div style={{ fontWeight: 600, color: 'var(--text-success)', fontSize: '1.1rem' }}>
              {viewLogsTarget?.maintenance_cost ? `₱${Number(viewLogsTarget.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '₱0.00'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '24px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
          <button className="primary-button" onClick={() => setViewLogsTarget(null)} type="button">Close</button>
        </div>
      </FormModal>
    </div>
  );
}

// =========================================================================
// PHASE 3: MECHANIC WORK ORDER MODULE
// =========================================================================

function MechanicWorkOrderModule({
  tickets,
  onViewTicket,
  categories,
  vehicles,
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterPriority,
  setFilterPriority,
  maintTypeOptions,
  searchQuery,
  setSearchQuery,
  stats,
  activeFilter,
  onFilterChange,
  // Phase B4 — a Maintenance Personnel account's assigned Maintenance
  // Schedules, shown as a second section on this same page (null for every
  // other role, which never sees this section at all).
  mySchedules = null,
  onCompleteSchedule,
  currentUser,
}) {
  const isPendingView = activeFilter !== 'Submitted';
  // One card per ticket/vehicle — a vehicle with several Causes dispatched to
  // this mechanic (Cause A/B/C) no longer repeats its ticket/vehicle info on
  // every row; clicking the card opens that ticket's page directly (where the
  // mechanic logs repairs on each of their work orders).
  const groupedTickets = useMemo(() => groupMechanicRowsByTicket(tickets), [tickets]);

  return (
    <div className="module-grid">
      <DismissibleHint description="Phase 3 — Work Orders assigned to you. Execute vehicle repairs, submit your repair logs to send the ticket for Custodian inspection, and check back here to see what you've already logged." />
      <ModuleStatCards
        totalLabel="Total Assigned"
        total={stats.total}
        cards={TICKET_WORK_ORDER_STAT_CARDS}
        counts={stats}
        activeFilter={activeFilter}
        onFilterChange={onFilterChange}
      />
      <section className="panel module-filter-panel">
        <FilterBar
          categories={categories}
          vehicles={vehicles}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterCapacity={filterCapacity}
          setFilterCapacity={setFilterCapacity}
          filterPriority={filterPriority}
          setFilterPriority={setFilterPriority}
          priorityOptions={maintTypeOptions}
          priorityLabel="Maintenance Type"
        />
      </section>
      <section className="panel operations-board work-order-board">
        <div className="operations-board-head">
          <div>
            <span className="operations-kicker">Mechanic queue</span>
            <h3>{isPendingView ? 'Pending Work Orders' : 'Submitted Work Orders'} <span className="count-badge">{tickets.length}</span></h3>
            <p>{isPendingView ? 'Open a work order, record the repair, then send it for verification.' : 'Review work already submitted for Custodian verification.'}</p>
          </div>
          <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search work orders..." />
        </div>
        <div className="operations-board-note"><Icon name={isPendingView ? 'wrench' : 'checkCircle'} size={14} /> {isPendingView ? 'Repair logs are due for the highlighted work orders.' : 'Submitted items remain here until their next workflow update.'}</div>
        <div className="work-tracker-grid operations-card-grid">
          {groupedTickets.length === 0 ? (
            <p className="empty-state" style={{ gridColumn: '1 / -1' }}>
              {isPendingView ? 'No active work orders assigned to you.' : 'No repair logs submitted yet.'}
            </p>
          ) : (
            groupedTickets.map((group) => {
              const photo = group.vehicle?.photo_url ? resolvePhotoUrl(group.vehicle.photo_url) : null;
              return (
                <button
                  key={group.ticket_id}
                  type="button"
                  className={`work-tracker-card${group.needsAction ? ' needs-action' : ''}`}
                  onClick={() => onViewTicket({ ticket_id: group.ticket_id })}
                >
                  <span className="work-tracker-thumb">
                    {photo ? <img src={photo} alt="" /> : <Icon name="vehicle" size={18} />}
                  </span>
                  <span className="work-tracker-card-heading">
                    <span className="work-tracker-card-title-row">
                      <strong>{group.vehicle?.vehicle_name ?? 'Unknown Vehicle'}</strong>
                      <span className="muted" style={{ fontSize: '0.78rem' }}>({group.vehicle?.plate_number ?? '-'})</span>
                      {group.needsAction && <Icon name="alert" size={13} className="work-tracker-item-flag" />}
                    </span>
                    <span className="work-tracker-card-sub" title={group.ticket_title}>#{group.ticket_id} · {group.ticket_title}</span>
                    <span className="work-tracker-card-summary">
                      {group.subIssues.length} work order{group.subIssues.length !== 1 ? 's' : ''}
                    </span>
                  </span>
                  <span className="work-tracker-card-chevron">▸</span>
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* Phase B4 — Condition Monitoring and the standalone Maintenance
          Schedule module were both removed from Maintenance Personnel's
          sidebar; their assigned schedules (already scoped server-side to
          assigned_to = me) surface here instead, as a clearly-labeled second
          section on the same page. */}
      {mySchedules !== null && (
        <section className="panel operations-board work-order-board">
          <div className="operations-board-head">
            <div>
              <span className="operations-kicker">Preventive maintenance</span>
              <h3>My Assigned Maintenance Schedules <span className="count-badge">{mySchedules.length}</span></h3>
              <p>Vehicles scheduled for preventive maintenance and assigned to you.</p>
            </div>
          </div>
          <div className="work-tracker-grid operations-card-grid">
            {mySchedules.length === 0 ? (
              <p className="empty-state" style={{ gridColumn: '1 / -1' }}>No maintenance schedules assigned to you.</p>
            ) : (
              mySchedules.map((row) => (
                <MaintenanceScheduleCard
                  key={row.schedule_id}
                  row={row}
                  currentUser={currentUser}
                  onComplete={onCompleteSchedule}
                  onViewTicket={onViewTicket}
                />
              ))
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function LogRepairsPage({ ticket, vehicleOptions = [], onBack, onSubmit, onDirty, onExternalSend, onExternalReturn }) {
  const [repairLogs, setRepairLogs] = useState('');
  const [parts, setParts] = useState([{ name: '', cost: '' }]);
  const [attachment, setAttachment] = useState(null);
  const [repairStartedAt, setRepairStartedAt] = useState('');
  const [repairCompletedAt, setRepairCompletedAt] = useState('');
  // Pre-filled from whatever was chosen at ticket creation (if this was a
  // pre-diagnosed sub-issue) — still editable here, since the actual repair
  // sometimes ends up differing from the original plan. Sub-issues created
  // via "Needs Inspection" arrive with this blank, since nobody could know
  // it yet — this is the first point it's actually knowable.
  const [repairType, setRepairType] = useState(ticket?.repair_type ?? '');
  const [sourceVehicleId, setSourceVehicleId] = useState(ticket?.source_vehicle_id ?? '');
  const [externalVendor, setExternalVendor] = useState(ticket?.external_vendor ?? '');
  // date casts serialize with a time component (ISO datetime) — <input
  // type="date"> needs exactly YYYY-MM-DD or it silently fails to populate.
  const [warrantyUntil, setWarrantyUntil] = useState((ticket?.warranty_until ?? '').slice(0, 10));
  // Cannibalized part details.
  const [partNeeded, setPartNeeded] = useState(ticket?.part_needed ?? '');
  const [partQuantity, setPartQuantity] = useState(ticket?.part_quantity ?? '');
  const [partCondition, setPartCondition] = useState(ticket?.part_condition ?? '');
  const [cannibalReason, setCannibalReason] = useState(ticket?.cannibal_reason ?? '');
  const [partInstalledAt, setPartInstalledAt] = useState((ticket?.part_installed_at ?? '').slice(0, 10));
  // External shop stages: send out, then mark returned, then submit.
  const [sendForm, setSendForm] = useState({ external_vendor: ticket?.external_vendor ?? '', external_reason: '', external_work_scope: '', external_shop_contact: '', external_estimated_cost: '' });
  const [returnForm, setReturnForm] = useState({ external_return_notes: '', external_actual_cost: '', warranty_until: '' });

  if (!ticket) {
    return (
      <ModulePanel description="This work order could not be found — it may no longer be assigned to you.">
      </ModulePanel>
    );
  }

  const updatePart = (index, field, value) => { setParts((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row))); onDirty?.(); };
  const addPart = () => setParts((rows) => [...rows, { name: '', cost: '' }]);
  const removePart = (index) => setParts((rows) => rows.filter((_, i) => i !== index));

  // Live-running total instead of a manual "Generate" click — a click-based
  // total would go stale the moment another row is added or edited after
  // pressing it. This always reflects exactly what's in the rows right now.
  const totalCost = parts.reduce((sum, p) => sum + (parseFloat(p.cost) || 0), 0);
  // Confirmed via code audit: while a repair is sent out and waiting on the
  // shop, Parts/Attachment/Schedule don't apply yet — the mechanic has
  // nothing to log here until it comes back. De-emphasized, not removed or
  // disabled, since a mechanic may still want to note something early.
  const awaitingShopReturn = repairType === 'external' && !!ticket.external_sent_at && !ticket.external_returned_at;
  const sourceVehicleOptions = vehicleOptions.filter((v) => String(v.vehicle_id) !== String(ticket.vehicle?.vehicle_id));

  const handleSubmit = (e) => {
    e.preventDefault();
    const namedParts = parts.filter((p) => p.name.trim());
    onSubmit(ticket, {
      repair_logs: repairLogs,
      parts_used: namedParts.map((p) => p.name.trim()).join(', ') || undefined,
      photo: attachment || undefined,
      maintenance_cost: totalCost > 0 ? totalCost : undefined,
      repair_started_at: repairStartedAt || undefined,
      repair_completed_at: repairCompletedAt || undefined,
      repair_type: repairType || undefined,
      source_vehicle_id: repairType === 'cannibalized' ? sourceVehicleId : undefined,
      external_vendor: repairType === 'external' ? (externalVendor || undefined) : undefined,
      warranty_until: repairType === 'external' ? (warrantyUntil || undefined) : undefined,
      part_needed: repairType === 'cannibalized' ? (partNeeded || undefined) : undefined,
      part_quantity: repairType === 'cannibalized' ? (partQuantity || undefined) : undefined,
      part_condition: repairType === 'cannibalized' ? (partCondition || undefined) : undefined,
      cannibal_reason: repairType === 'cannibalized' ? (cannibalReason || undefined) : undefined,
      part_installed_at: repairType === 'cannibalized' ? (partInstalledAt || undefined) : undefined,
    });
  };

  return (
    <ModulePanel description="Execute the repair and submit your logs to send this ticket for Custodian inspection.">
      <div className="vehicle-profile-header">
        <h3 className="ticket-detail-title" style={{ margin: 0 }}>Log Repairs — {ticket.title}</h3>
      </div>
      <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>Main Issue: <strong>{ticket.ticket_title}</strong> (Ticket #{ticket.ticket_id}) — {ticket.maintenance_type}</p>
      {ticket.confirmation_verdict === 'Reopened' && (
        <div className="notice danger" style={{ marginBottom: 16 }}>
          <h4 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="alert" size={16} /> Reopened by Admin ({ticket.confirmed_by?.name ?? 'Admin'})</h4>
          <p><strong>Feedback/Reason:</strong> {ticket.confirmation_notes ?? 'No feedback notes provided.'}</p>
        </div>
      )}
      {ticket.verification_verdict === 'Rejected' && (
        <div className="notice warning" style={{ marginBottom: 16 }}>
          <h4 style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="alert" size={16} /> Rejected by Custodian ({ticket.verified_by?.name ?? 'Custodian'})</h4>
          <p><strong>Feedback/Reason:</strong> {ticket.verification_notes ?? 'No feedback notes provided.'}</p>
        </div>
      )}

      <form className="smart-form" onSubmit={handleSubmit} noValidate>
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <h4 style={{ margin: '0 0 6px 0', display: 'flex', alignItems: 'center', gap: 6, color: '#0f172a', fontSize: '0.85rem' }}><Icon name="clipboard" size={14} /> Repair Log Entry</h4>
          <textarea required rows={2} value={repairLogs} onChange={(e) => { setRepairLogs(e.target.value); onDirty?.(); }} style={{ width: '100%' }} />
        </div>

        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <h4 style={{ margin: '0 0 6px 0', display: 'flex', alignItems: 'center', gap: 6, color: '#0f172a', fontSize: '0.85rem' }}><Icon name="wrench" size={14} /> Repair Type</h4>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <select
              required
              value={repairType}
              onChange={(e) => { setRepairType(e.target.value); onDirty?.(); }}
              style={{ maxWidth: 260 }}
            >
              <option value="">Select</option>
              <option value="in_house">In-House Repair</option>
              <option value="cannibalized">Used Cannibalized Part</option>
              <option value="external">Sent to External Shop</option>
            </select>
            {repairType === 'cannibalized' && (
              <select
                required
                value={sourceVehicleId}
                onChange={(e) => { setSourceVehicleId(e.target.value); onDirty?.(); }}
                style={{ maxWidth: 260 }}
              >
                <option value="">Select source vehicle</option>
                {sourceVehicleOptions.map((v) => <option key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_name} ({v.plate_number})</option>)}
              </select>
            )}
            {repairType === 'external' && (
              <>
                <input
                  type="text"
                  placeholder="External shop name"
                  value={externalVendor}
                  onChange={(e) => { setExternalVendor(e.target.value); onDirty?.(); }}
                  style={{ maxWidth: 220 }}
                />
                <span title="Warranty Until" style={{ maxWidth: 180, display: 'inline-block' }}>
                  <DateFilterInput
                    value={warrantyUntil}
                    onChange={(v) => { setWarrantyUntil(v); onDirty?.(); }}
                  />
                </span>
              </>
            )}
          </div>
        </div>

        {repairType === 'cannibalized' && (
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.85rem' }}>Part Taken From Donor</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
              <input type="text" placeholder="Part (e.g. Radiator)" value={partNeeded} onChange={(e) => { setPartNeeded(e.target.value); onDirty?.(); }} />
              <input type="number" min="1" placeholder="Quantity" value={partQuantity} onChange={(e) => { setPartQuantity(e.target.value); onDirty?.(); }} />
              <input type="text" placeholder="Part condition" value={partCondition} onChange={(e) => { setPartCondition(e.target.value); onDirty?.(); }} />
              <span title="Date installed"><DateFilterInput value={partInstalledAt} onChange={(v) => { setPartInstalledAt(v); onDirty?.(); }} /></span>
            </div>
            <textarea rows={2} placeholder="Why this donor / why not buy the part?" value={cannibalReason} onChange={(e) => { setCannibalReason(e.target.value); onDirty?.(); }} style={{ width: '100%', marginTop: 8 }} />
          </div>
        )}

        {repairType === 'external' && onExternalSend && (
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.85rem' }}>External Shop</h4>
            {!ticket.external_sent_at ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                  <input type="text" placeholder="Shop name *" value={sendForm.external_vendor} onChange={(e) => setSendForm({ ...sendForm, external_vendor: e.target.value })} />
                  <input type="text" placeholder="Why outside? *" value={sendForm.external_reason} onChange={(e) => setSendForm({ ...sendForm, external_reason: e.target.value })} />
                  <input type="text" placeholder="Shop contact" value={sendForm.external_shop_contact} onChange={(e) => setSendForm({ ...sendForm, external_shop_contact: e.target.value })} />
                  <input type="number" min="0" placeholder="Estimated cost (₱)" value={sendForm.external_estimated_cost} onChange={(e) => setSendForm({ ...sendForm, external_estimated_cost: e.target.value })} />
                </div>
                <textarea rows={2} placeholder="Work to be done *" value={sendForm.external_work_scope} onChange={(e) => setSendForm({ ...sendForm, external_work_scope: e.target.value })} style={{ width: '100%', marginTop: 8 }} />
                <button
                  type="button"
                  className="primary-button"
                  style={{ marginTop: 8 }}
                  disabled={!sendForm.external_vendor.trim() || !sendForm.external_reason.trim() || !sendForm.external_work_scope.trim()}
                  onClick={() => onExternalSend(ticket, Object.fromEntries(Object.entries(sendForm).filter(([, v]) => String(v).trim() !== '')))}
                >
                  Mark as Sent to Shop
                </button>
              </>
            ) : !ticket.external_returned_at ? (
              <>
                <p style={{ margin: '0 0 8px', fontSize: '0.85rem' }}>Sent to <strong>{ticket.external_vendor}</strong> on {formatDate(ticket.external_sent_at)} — waiting for it to come back.</p>
                <textarea rows={2} placeholder="Result / condition on return *" value={returnForm.external_return_notes} onChange={(e) => setReturnForm({ ...returnForm, external_return_notes: e.target.value })} style={{ width: '100%' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <input type="number" min="0" placeholder="Actual cost (₱)" value={returnForm.external_actual_cost} onChange={(e) => setReturnForm({ ...returnForm, external_actual_cost: e.target.value })} />
                  <span title="Warranty until"><DateFilterInput value={returnForm.warranty_until} onChange={(v) => setReturnForm({ ...returnForm, warranty_until: v })} /></span>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!returnForm.external_return_notes.trim()}
                    onClick={() => onExternalReturn(ticket, Object.fromEntries(Object.entries(returnForm).filter(([, v]) => String(v).trim() !== '')))}
                  >
                    Mark as Returned
                  </button>
                </div>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: '0.85rem' }}>Returned from <strong>{ticket.external_vendor}</strong> on {formatDate(ticket.external_returned_at)}. {ticket.external_return_notes}</p>
            )}
          </div>
        )}

        {awaitingShopReturn && (
          <p className="muted" style={{ margin: '0 0 8px', fontSize: '0.8rem' }}>
            The fields below apply once the vehicle is back from the shop — mark it Returned above when it comes in.
          </p>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 190px', gap: 8, marginBottom: 12, alignItems: 'start', opacity: awaitingShopReturn ? 0.5 : 1 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10 }}>
              <h4 style={{ margin: '0 0 6px 0', display: 'flex', alignItems: 'center', gap: 6, color: '#0f172a', fontSize: '0.85rem' }}><Icon name="tools" size={14} /> Parts & Materials Used</h4>
              {parts.map((part, index) => (
                <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="Part name"
                    value={part.name}
                    onChange={(e) => updatePart(index, 'name', e.target.value)}
                    style={{ flex: 2 }}
                  />
                  <input
                    type="number"
                    placeholder="Cost (₱)"
                    min="0"
                    step="0.01"
                    value={part.cost}
                    onChange={(e) => updatePart(index, 'cost', e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn-delete-action icon-btn"
                    onClick={() => removePart(index)}
                    disabled={parts.length === 1}
                    title="Remove part"
                    aria-label="Remove part"
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
              <button type="button" className="primary-button" onClick={addPart}><Icon name="plus" size={14} /> Add another part</button>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: '1px solid #e2e8f0' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#475569' }}>Total Cost</span>
                <strong style={{ fontSize: '1rem', color: '#16a34a' }}>₱{totalCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>
              </div>
            </div>

            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10 }}>
              {attachment ? (
                <div className="file-cabinet-drawer">
                  {attachment.type.startsWith('image/') ? (
                    <img src={URL.createObjectURL(attachment)} alt="Attachment preview" style={{ width: 38, height: 38, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e8f0', flexShrink: 0 }} />
                  ) : (
                    <span className="file-cabinet-drawer-icon"><Icon name="archive" size={17} /></span>
                  )}
                  <span style={{ flex: 1, fontSize: '0.82rem', color: '#334155', wordBreak: 'break-all', fontWeight: 500 }}>{attachment.name}</span>
                  <button type="button" className="btn-delete-action icon-btn" onClick={() => setAttachment(null)} title="Remove attachment" aria-label="Remove attachment">
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ) : (
                <label className="file-cabinet-dropzone">
                  <span className="file-cabinet-dropzone-icon"><Icon name="archive" size={20} /></span>
                  <span className="file-cabinet-dropzone-title">Click to file a photo or document</span>
                  <span className="file-cabinet-dropzone-hint">JPG, PNG, PDF, or DOC — up to 8MB</span>
                  <input type="file" accept="image/*,.pdf,.doc,.docx" onChange={(e) => { setAttachment(e.target.files[0] ?? null); onDirty?.(); }} style={{ display: 'none' }} />
                </label>
              )}
            </div>
          </div>

          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 8px' }}>
            <h4 style={{ margin: '0 0 6px 0', display: 'flex', alignItems: 'center', gap: 6, color: '#0f172a', fontSize: '0.85rem' }}><Icon name="calendar" size={14} /> Schedule</h4>
            <label style={{ marginBottom: 6 }}>
              <span style={{ fontSize: '0.68rem' }}>Start Date</span>
              <DateFilterInput value={repairStartedAt} onChange={(v) => { setRepairStartedAt(v); onDirty?.(); }} />
            </label>
            <label style={{ marginBottom: 6 }}>
              <span style={{ fontSize: '0.68rem' }}>Completion Date</span>
              <DateFilterInput value={repairCompletedAt} onChange={(v) => { setRepairCompletedAt(v); onDirty?.(); }} />
            </label>
          </div>
        </div>

        <div className="form-actions">
          <button className="ghost-button" onClick={onBack} type="button">Cancel</button>
          <button className="primary-button" type="submit">Submit Repair Log</button>
        </div>
      </form>

      <div style={{marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--border-subtle)'}}>
        <p className="muted"><strong>Work Order Instructions:</strong> {ticket.work_order_notes ?? ticket.ticket_description}</p>
        {ticket.repair_logs && (
          <>
            <p className="muted" style={{marginTop: '8px'}}><strong>Previous Logs:</strong></p>
            <RepairLogEntries text={ticket.repair_logs} />
          </>
        )}
      </div>
    </ModulePanel>
  );
}

// =========================================================================
// TICKET TABLE VIEW COLUMNS (alternative to the ticket card grid)
// =========================================================================

// Collapsible highlight strip above the main ticket table — surfaces
// tickets whose sub-issues are all done but haven't been closed yet, so
// an Admin/Custodian can spot and act on them without hunting through the
// full list below. Always visible (even at a count of 0) so it reads as a
// permanent fixture of the page, not something that randomly appears.
function readyToCloseColumns() {
  return [
    { key: 'ticket_id', label: 'Ticket ID', className: 'cell-center', render: (r) => <span className="row-title-text">#{r.ticket_id}</span> },
    { key: 'vehicle', label: 'Vehicle', render: (r) => <VehicleCell vehicle={r.vehicle} isRowTitle={false} /> },
    { key: 'title', label: 'Title', render: (r) => r.ticket_title },
    { key: 'priority', label: 'Priority', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.priority} /> },
    { key: 'progress', label: 'Sub-Issues', className: 'cell-center', render: (r) => `${r.progress?.done ?? 0}/${r.progress?.total ?? 0} done` },
    { key: 'created', label: 'Created', className: 'cell-center', render: (r) => <DateBadge value={r.created_at} /> },
  ];
}

function TicketsReadyToClosePanel({ tickets, onViewTicket }) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const columns = useMemo(() => readyToCloseColumns(), []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((t) => (
      String(t.ticket_id).includes(q)
      || t.ticket_title?.toLowerCase().includes(q)
      || t.vehicle?.vehicle_name?.toLowerCase().includes(q)
      || t.vehicle?.plate_number?.toLowerCase().includes(q)
    ));
  }, [tickets, search]);

  return (
    <div className="ready-to-close-panel">
      <div className="ready-to-close-header">
        <span className="count-badge">{tickets.length}</span>
        <h3>Tickets Ready to Close</h3>
        <div className="ready-to-close-search">
          <LocalSearchInput value={search} onChange={setSearch} placeholder="Search ready tickets..." />
        </div>
        <button
          type="button"
          className="ready-to-close-toggle"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
        >
          <Icon name="chevronDown" size={16} className={expanded ? 'is-expanded' : ''} />
        </button>
      </div>
      {expanded && (
        <div className="ready-to-close-body">
          <DataTable
            compact
            columns={columns}
            rows={filtered}
            onRowClick={onViewTicket}
            emptyMessage={tickets.length ? 'No tickets match your search.' : 'No tickets are ready to close right now.'}
          />
        </div>
      )}
    </div>
  );
}

function ticketTableColumns(unreadByTicket = {}) {
  return [
    { key: 'ticket_id', label: 'Ticket ID', locked: true, className: 'cell-center', render: (r) => r.ticket_id },
    {
      key: 'title',
      label: 'Title',
      render: (r) => {
        const unread = unreadByTicket[r.ticket_id] ?? 0;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {unread > 0 && (
              <span
                title={`${unread} unread update${unread > 1 ? 's' : ''} on this ticket`}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  minWidth: 18, height: 18, padding: '0 4px', borderRadius: 999,
                  background: '#dc2626', color: '#fff', fontSize: '0.65rem', fontWeight: 700,
                }}
              >
                {unread > 9 ? '9+' : unread}
              </span>
            )}
            <span className="row-title-text">{r.ticket_title}</span>
          </span>
        );
      },
    },
    { key: 'vehicle', label: 'Vehicle', render: (r) => <VehicleCell vehicle={r.vehicle} isRowTitle={false} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => r.vehicle?.plate_number ?? '-' },
    { key: 'status', label: 'Status', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.status} /> },
    { key: 'next_step', label: 'Next Step', className: 'cell-center', render: (r) => <TicketStageBadge ticket={r} /> },
    { key: 'priority', label: 'Priority', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.priority} /> },
    { key: 'created', label: 'Created', className: 'cell-center', render: (r) => <DateBadge value={r.created_at} /> },
    { key: 'time', label: 'Time', className: 'cell-center', render: (r) => formatTime(r.created_at) },
  ];
}

// =========================================================================
// PHASE 5: TICKET ARCHIVE COLUMNS
// =========================================================================

// =========================================================================
// TICKET PHASE HELPERS
// =========================================================================

// A ticket now only moves through 3 stages at the ticket level — the real
// work happens per sub-issue (see TicketDetailPanel's sub-issue checklist,
// which uses this same TicketStatusBadge for each line's own status).
const phaseOrder = ['Open', 'Active', 'Closed'];

const PHASE_STEP_ICONS = {
  'Open': 'clipboard',
  'Active': 'wrench',
  'Closed': 'checkCircle',
};

const PHASE_STEP_COLORS = {
  'Open': '#2563eb',
  'Active': '#d97706',
  'Closed': '#16a34a',
};

// Order-insensitive comparison for the array-valued filter state used by
// FilterBar's multi-select dropdowns.
const sameSelection = (a = [], b = []) => a.length === b.length && a.every((v) => b.includes(v));

// Naive but good-enough English pluralization for filter placeholders
// ("Priority" -> "Priorities", "Status" -> "Statuses", "Mechanic" -> "Mechanics").
const pluralizeLabel = (label) => {
  if (label.endsWith('y')) return `${label.slice(0, -1)}ies`;
  if (label.endsWith('s')) return `${label}es`;
  return `${label}s`;
};

function isoDateToDisplay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '';
  return `${m}/${d}/${y}`;
}

function displayDateToIso(display) {
  const match = display.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, m, d, y] = match;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// A native <input type="date">'s displayed text always follows the
// visitor's own OS region setting (day-first, month-first, whatever it is)
// — nothing on the page, not even the `lang` attribute, can override just
// that display. This wraps a hidden native date input (kept only for its
// calendar picker, launched via showPicker()) behind a visible text field
// that is always typed and displayed as MM/DD/YYYY, so the format is
// guaranteed regardless of the browser/OS locale.
function DateFilterInput({ value, onChange, placeholder = 'mm/dd/yyyy' }) {
  const hiddenRef = useRef(null);
  const [text, setText] = useState(() => isoDateToDisplay(value));

  useEffect(() => {
    setText(isoDateToDisplay(value));
  }, [value]);

  const openPicker = () => {
    try { hiddenRef.current?.showPicker?.(); } catch { /* unsupported browser — text entry still works */ }
  };

  const commit = (raw) => {
    if (!raw.trim()) { onChange(''); return; }
    const iso = displayDateToIso(raw);
    if (iso) onChange(iso);
    else setText(isoDateToDisplay(value));
  };

  return (
    <div className="date-filter-input">
      <input
        type="text"
        className="filter-select"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <button type="button" className="date-filter-input-icon" onClick={openPicker} aria-label="Open calendar">
        <Icon name="calendar" size={14} />
      </button>
      <input
        ref={hiddenRef}
        type="date"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="date-filter-input-hidden"
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}

// Checkbox multi-select dropdown — lets a filter row pick zero, one, or many
// values instead of forcing a single native <select> choice.
function MultiSelectDropdown({ placeholder = 'All', options = [], selected = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const normalizedOptions = useMemo(
    () => options.map((opt) => (opt && typeof opt === 'object' ? opt : { value: opt, label: String(opt) })),
    [options]
  );
  const query = search.trim().toLowerCase();
  const filteredOptions = query
    ? normalizedOptions.filter((opt) => opt.label.toLowerCase().includes(query))
    : normalizedOptions;

  const toggleAll = () => onChange([]);
  const toggleOption = (value) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const summaryLabel = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? (normalizedOptions.find((o) => String(o.value) === String(selected[0]))?.label ?? String(selected[0]))
      : `${selected.length} selected`;

  return (
    <div className="multi-select-dropdown" ref={containerRef}>
      <button
        type="button"
        className={`filter-select multi-select-trigger${selected.length ? ' has-selection' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{summaryLabel}</span>
        <Icon name="chevronDown" size={14} className={`multi-select-chevron${open ? ' is-open' : ''}`} />
      </button>
      {open && (
        <div className="multi-select-panel">
          <input
            type="text"
            className="multi-select-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            autoFocus
          />
          <label className="multi-select-option multi-select-all-option">
            <input type="checkbox" checked={selected.length === 0} onChange={toggleAll} />
            <span>- All -</span>
          </label>
          <div className="multi-select-option-list">
            {filteredOptions.map((opt) => (
              <label key={opt.value} className="multi-select-option">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggleOption(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
            {filteredOptions.length === 0 && <div className="multi-select-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// A text input that suggests existing options as you type, and — when
// nothing matches — offers to add whatever was typed as a brand new one.
// The catalog it's editing (fault categories, maintenance types) is meant
// to grow with real use instead of being a fixed, admin-curated list; the
// backend persists new values the same way, so anyone who adds one here
// finds it waiting in the dropdown next time, everywhere it's offered.
function CreatableSelect({
  value, onChange, options = [], placeholder = 'Select or type to add new', newItemLabel = 'option',
  required = false, catalogEndpoint = null,
  // For a catalog whose API doesn't use plain {id, name} — e.g. vehicle
  // categories use {category_id, category_name} — read/write under these
  // keys instead, normalizing to {id, name} internally either way.
  idField = 'id', nameField = 'name',
  // True when the field this drives (e.g. category_id) stores the
  // catalog row's id, not its name — value/onChange deal in ids, and the
  // displayed text is resolved by looking the id up in the catalog.
  valueIsId = false,
  // Extra required fields the create-endpoint needs beyond a bare name
  // (e.g. vehicle categories also require a Domain) — rendered as simple
  // selects in the add-new modal, merged into the POST body.
  extraFields = [],
}) {
  // Only an Admin can remove a catalog entry — it's a shared list everyone
  // adds to, so letting any role delete from it risks a Custodian or
  // Mechanic wiping out something others rely on. The backend enforces
  // this too; hiding the button for non-Admins just avoids a guaranteed
  // 403 on click.
  const { user: currentUser } = useContext(AuthContext);
  const canDeleteCatalogItems = hasRole(currentUser, 'Admin');
  // Accepts either a plain name string (the simple catalogs) or a raw API
  // row keyed by idField/nameField (e.g. vehicle categories) — either way,
  // normalized to one {id, name} shape everything below works with.
  const normalizeItem = useCallback((raw) => (
    typeof raw === 'string' ? { id: null, name: raw } : { id: raw[idField] ?? null, name: raw[nameField] }
  ), [idField, nameField]);
  const [open, setOpen] = useState(false);
  // Only holds what's being typed while the panel is open — closed, the
  // input just displays `value` directly, so there's nothing to keep in
  // sync via an effect when the value changes from outside.
  const [draftText, setDraftText] = useState('');
  // {id, name} pairs — seeded from the plain-string `options` prop (ids
  // unknown yet) so the list isn't empty on first render, then replaced
  // with the authoritative version once catalogEndpoint responds. Ids are
  // what make per-row delete possible; a bare string list (no catalog
  // backing) just never shows a delete button.
  const [catalogItems, setCatalogItems] = useState(() => options.map(normalizeItem));
  // Non-null while the "complete new item" modal is open — holds its own
  // editable Name field, seeded from what was typed but not locked to it,
  // same as the reference add-new-Company flow (a real little form, not
  // just a yes/no confirmation of the raw typed text).
  const [addModalName, setAddModalName] = useState(null);
  // Non-null while the modal above is in EDIT mode instead of ADD mode —
  // holds the raw {id, name} item being renamed. Shares the same
  // addModalName/addModalExtra/addModalError/addSaving state as add, since
  // it's the same little form either way; only the submit target differs.
  const [editTarget, setEditTarget] = useState(null);
  // Values for `extraFields` (e.g. Domain), keyed by field name.
  const [addModalExtra, setAddModalExtra] = useState({});
  const [addModalError, setAddModalError] = useState(null);
  const [addSaving, setAddSaving] = useState(false);
  const [addedMessage, setAddedMessage] = useState(null);
  // The item pending the delete confirmation modal — a real, permanent
  // removal (it disappears from this list for everyone), so it gets the
  // same "are you sure" step as any other destructive action in the app.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // True right after opening (via focus), before the user has actually
  // typed anything — the input still shows the current value, but the
  // option list is NOT filtered by it, so reopening an already-picked
  // field shows the full catalog instead of just the one exact match
  // (which used to look like every other option had vanished).
  const [justOpened, setJustOpened] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!catalogEndpoint) return;
    let cancelled = false;
    api.get(catalogEndpoint).then((res) => {
      if (!cancelled) setCatalogItems(res.data.map(normalizeItem));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [catalogEndpoint, normalizeItem]);

  useEffect(() => {
    if (!addedMessage) return;
    const timer = setTimeout(() => setAddedMessage(null), 2600);
    return () => clearTimeout(timer);
  }, [addedMessage]);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  // When the driven field stores an id (valueIsId), resolve it to a name
  // for display — `value` itself is never text in that mode.
  const selectedItem = valueIsId ? catalogItems.find((o) => String(o.id) === String(value)) : null;
  const displayText = valueIsId ? (selectedItem?.name ?? '') : (value ?? '');
  const text = open ? draftText : displayText;
  const query = justOpened ? '' : text.trim().toLowerCase();
  const filtered = query ? catalogItems.filter((o) => o.name.toLowerCase().includes(query)) : catalogItems;
  const hasExactMatch = catalogItems.some((o) => o.name.toLowerCase() === query);
  const canAddNew = query.length > 0 && !hasExactMatch;

  const openPanel = () => {
    setDraftText(displayText);
    setJustOpened(true);
    setOpen(true);
  };
  const pick = (item) => {
    onChange(valueIsId ? item.id : item.name);
    setOpen(false);
  };
  const openAddModal = (name) => {
    setEditTarget(null);
    setAddModalName(name);
    // Extra fields can carry a sensible default from context (e.g. Domain
    // pre-filled to match the vehicle already being filled out) — still
    // shown and changeable, just not blank by default.
    setAddModalExtra(Object.fromEntries(extraFields.map((f) => [f.name, f.default ?? ''])));
    setAddModalError(null);
    setOpen(false);
  };
  // Renaming an existing entry — same little modal as add, pre-filled with
  // its current name. Only offered where add/delete already are (a real
  // catalogEndpoint, Admin), since it's the same permission story: a shared
  // list everyone reads, only Admin should be able to change it out from
  // under everyone else.
  const openEditModal = (item) => {
    setEditTarget(item);
    setAddModalName(item.name);
    setAddModalExtra(Object.fromEntries(extraFields.map((f) => [f.name, f.default ?? ''])));
    setAddModalError(null);
    setOpen(false);
  };
  const newItemTitle = newItemLabel.replace(/\b\w/g, (c) => c.toUpperCase());
  const saveAddModal = async (e) => {
    e.preventDefault();
    // React portals bubble synthetic events through the component tree, not
    // the DOM tree — without this, submitting this modal's form (portaled
    // to document.body) also fires the outer page's own <form onSubmit>,
    // since CreatableSelect is nested inside it there.
    e.stopPropagation();
    const val = addModalName.trim();
    if (!val) {
      setAddModalError('Name is required.');
      return;
    }
    const missingExtra = extraFields.find((f) => f.required && (addModalExtra[f.name] ?? '') === '');
    if (missingExtra) {
      setAddModalError(`${missingExtra.label} is required.`);
      return;
    }

    if (editTarget) {
      setAddSaving(true);
      try {
        const res = await api.put(`${catalogEndpoint}/${editTarget.id}`, { [nameField]: val, ...addModalExtra });
        const updated = normalizeItem(res.data);
        setCatalogItems((items) => items
          .map((i) => (i.id === editTarget.id ? updated : i))
          .sort((a, b) => a.name.localeCompare(b.name)));
        // Renamed item was the one already selected — plain-string mode
        // (valueIsId false) stores the name itself, so it has to follow the
        // rename or the field would keep showing text that's no longer a
        // real option. valueIsId mode needs nothing here; the id didn't change.
        if (!valueIsId && value === editTarget.name) {
          onChange(updated.name);
        }
        setEditTarget(null);
        setAddModalName(null);
        setAddModalError(null);
        setAddedMessage(`"${editTarget.name}" renamed to "${updated.name}".`);
      } catch (err) {
        setAddModalError(err?.response?.data?.message || 'Something went wrong — please try again.');
      } finally {
        setAddSaving(false);
      }
      return;
    }

    if (!catalogEndpoint) {
      pick({ id: null, name: val });
      setAddModalName(null);
      setAddModalError(null);
      setAddedMessage(`"${val}" added as a new ${newItemLabel}.`);
      return;
    }
    setAddSaving(true);
    try {
      const res = await api.post(catalogEndpoint, { [nameField]: val, ...addModalExtra });
      const created = normalizeItem(res.data);
      setCatalogItems((items) => {
        const withoutDupe = items.filter((i) => i.name.toLowerCase() !== created.name.toLowerCase());
        return [...withoutDupe, created].sort((a, b) => a.name.localeCompare(b.name));
      });
      pick(created);
      setAddModalName(null);
      setAddModalError(null);
      setAddedMessage(`"${created.name}" added as a new ${newItemLabel}.`);
    } catch (err) {
      setAddModalError(err?.response?.data?.message || 'Something went wrong — please try again.');
    } finally {
      setAddSaving(false);
    }
  };
  const closeAddModal = () => {
    setAddModalName(null);
    setAddModalError(null);
    setEditTarget(null);
  };
  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await api.delete(`${catalogEndpoint}/${deleteTarget.id}`);
      setCatalogItems((items) => items.filter((i) => i.id !== deleteTarget.id));
      const wasSelected = valueIsId ? String(value) === String(deleteTarget.id) : value === deleteTarget.name;
      if (wasSelected) onChange(valueIsId ? null : '');
      setDeleteTarget(null);
      setDeleteError(null);
    } catch (err) {
      setDeleteError(err?.response?.data?.message || 'Something went wrong — please try again.');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="creatable-select" ref={containerRef}>
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        required={required}
        onFocus={openPanel}
        onChange={(e) => { setDraftText(e.target.value); setJustOpened(false); if (!open) setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !open) return;
          // Enter inside the list means "choose what I typed" — never "submit the form".
          e.preventDefault();
          const exact = catalogItems.find((o) => o.name.toLowerCase() === query);
          if (exact) pick(exact);
          else if (filtered.length === 1) pick(filtered[0]);
          else if (canAddNew) openAddModal(text.trim());
        }}
      />
      {open && (
        <div className="creatable-select-panel">
          {!canAddNew && (
            <button type="button" className="creatable-select-option creatable-select-add creatable-select-add-pinned" onClick={() => openAddModal('')}>
              <Icon name="plus" size={13} /> Add New {newItemTitle}
            </button>
          )}
          <div className="creatable-select-option-list">
            {filtered.map((o) => (
              <div key={o.id ?? o.name} className="creatable-select-option-row">
                <button type="button" className="creatable-select-option" onClick={() => pick(o)}>
                  {o.name}
                </button>
                {catalogEndpoint && canDeleteCatalogItems && o.id != null && (
                  <>
                    {/* Simple name-only catalogs (Fault Category, Maintenance
                        Type) only — a catalog with extraFields (e.g. Vehicle
                        Type's Domain) isn't safe to rename here, since this
                        list never carries those extra values to prefill the
                        modal with; blindly submitting would reset them to
                        whatever the field's bare default is. Those already
                        have their own proper edit page elsewhere. */}
                    {extraFields.length === 0 && (
                      <button
                        type="button"
                        className="creatable-select-option-edit"
                        onClick={(e) => { e.stopPropagation(); openEditModal(o); }}
                        title={`Rename ${o.name}`}
                        aria-label={`Rename ${o.name}`}
                      >
                        <Icon name="edit" size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="creatable-select-option-delete"
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(o); setDeleteError(null); }}
                      title={`Remove ${o.name}`}
                      aria-label={`Remove ${o.name}`}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
            {filtered.length === 0 && !canAddNew && <div className="multi-select-empty">No matches</div>}
          </div>
          {canAddNew && (
            <button type="button" className="creatable-select-option creatable-select-add" onClick={() => openAddModal(text.trim())}>
              <Icon name="plus" size={13} /> Add "{text.trim()}" as a new {newItemLabel}
            </button>
          )}
        </div>
      )}
      <FormModal open={addModalName !== null} title={editTarget ? `Rename ${newItemTitle}` : `Add New ${newItemTitle}`} onClose={closeAddModal}>
        <form className="smart-form" onSubmit={saveAddModal} noValidate>
          {addModalError && (
            <div className="toast-notice-overlay" onClick={() => setAddModalError(null)}>
              <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
                <Icon name="alert" size={17} className="toast-notice-icon" />
                <div className="toast-notice-lines"><span>{addModalError}</span></div>
                <button type="button" className="toast-notice-close" onClick={() => setAddModalError(null)} aria-label="Dismiss">
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          )}
          <label>
            <span>Name <span className="required-asterisk">*</span></span>
            <input type="text" required autoFocus value={addModalName ?? ''} onChange={(e) => setAddModalName(e.target.value)} />
          </label>
          {extraFields.map((f) => (
            <label key={f.name}>
              <span>{f.label} {f.required && <span className="required-asterisk">*</span>}</span>
              {f.type === 'number' ? (
                <input
                  type="number"
                  step="any"
                  required={f.required}
                  placeholder={f.placeholder}
                  value={addModalExtra[f.name] ?? ''}
                  onChange={(e) => setAddModalExtra((cur) => ({ ...cur, [f.name]: e.target.value }))}
                />
              ) : (
                <select
                  required={f.required}
                  value={addModalExtra[f.name] ?? ''}
                  onChange={(e) => setAddModalExtra((cur) => ({ ...cur, [f.name]: e.target.value }))}
                >
                  <option value="" disabled>{' '}</option>
                  {f.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              )}
            </label>
          ))}
          <div className="form-actions">
            <button className="ghost-button" type="button" onClick={closeAddModal} disabled={addSaving}>Cancel</button>
            <button className="primary-button" type="submit" disabled={addSaving}>{addSaving ? 'Saving…' : (editTarget ? 'Save Changes' : 'Save')}</button>
          </div>
        </form>
      </FormModal>
      {deleteTarget && createPortal(
        <div className="confirm-overlay" onClick={() => !deleteBusy && setDeleteTarget(null)}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-icon" aria-hidden="true">
              <Icon name="alert" size={20} />
            </div>
            <div className="confirm-dialog-copy">
              <p className="eyebrow">Confirmation</p>
              <h3>Remove {newItemTitle}</h3>
              <p>Remove "{deleteTarget.name}" from this list? It disappears for everyone — existing tickets/records that already used it keep showing it, but it won't be selectable anymore.</p>
              {deleteError && <p style={{ color: '#b91c1c', fontWeight: 600, marginTop: 8 }}>{deleteError}</p>}
            </div>
            <div className="confirm-dialog-actions">
              <button className="ghost-button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)} type="button">Cancel</button>
              <button className="danger-button" disabled={deleteBusy} onClick={confirmDelete} type="button">
                {deleteBusy ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </section>
        </div>,
        document.body
      )}
      {addedMessage && createPortal(
        <div className="toast-notice success" role="alert">
          <div className="toast-notice-body">
            <Icon name="checkCircle" size={16} />
            <span>{addedMessage}</span>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function FilterBar({
  categories = [],
  vehicles = [],
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  statusOptions = [],
  priorityOptions = [],
  priorityLabel = "Priority",
  statusLabel = "Status",
  trailing,
  filterLocation,
  setFilterLocation,
  filterDomain,
  setFilterDomain,
  // Extra module-specific dropdowns beyond the standard six — each applies
  // immediately (no "Filter" click needed), unlike the staged fields above.
  // Shape: [{ key, label, options, selected, setSelected }].
  extraFilters = [],
  // Optional date-range pair (also applies immediately as typed).
  dateRange = null,
}) {
  // Extract unique capacities dynamically
  const capacities = useMemo(() => {
    const caps = new Set();
    vehicles.forEach((v) => {
      if (v.capacity) {
        caps.add(v.capacity.trim());
      }
    });
    return Array.from(caps).sort();
  }, [vehicles]);

  const locations = useMemo(() => {
    const locs = new Set();
    vehicles.forEach((v) => {
      if (v.current_location) locs.add(v.current_location.trim());
    });
    return Array.from(locs).sort();
  }, [vehicles]);

  const domains = useMemo(() => {
    const doms = new Set();
    categories.forEach((c) => { if (c.domain) doms.add(c.domain); });
    return Array.from(doms).sort();
  }, [categories]);

  // Draft selections — only applied to the table when "Filter" is clicked.
  // Each field is an array now, so a dropdown can hold zero, one, or many values.
  const [draft, setDraft] = useState({
    category: filterCategory ?? [],
    capacity: filterCapacity ?? [],
    status: filterStatus ?? [],
    priority: filterPriority ?? [],
    location: filterLocation ?? [],
    domain: filterDomain ?? [],
  });

  // Keep the draft in sync when applied filters are reset externally
  // (e.g. switching modules clears all filters).
  useEffect(() => {
    setDraft({
      category: filterCategory ?? [],
      capacity: filterCapacity ?? [],
      status: filterStatus ?? [],
      priority: filterPriority ?? [],
      location: filterLocation ?? [],
      domain: filterDomain ?? [],
    });
  }, [filterCategory, filterCapacity, filterStatus, filterPriority, filterLocation, filterDomain]);

  const isDirty = !sameSelection(draft.category, filterCategory ?? [])
    || !sameSelection(draft.capacity, filterCapacity ?? [])
    || !sameSelection(draft.status, filterStatus ?? [])
    || !sameSelection(draft.priority, filterPriority ?? [])
    || !sameSelection(draft.location, filterLocation ?? [])
    || !sameSelection(draft.domain, filterDomain ?? []);

  const applyFilters = () => {
    setFilterCategory(draft.category);
    setFilterCapacity(draft.capacity);
    setFilterStatus(draft.status);
    if (setFilterPriority) setFilterPriority(draft.priority);
    if (setFilterLocation) setFilterLocation(draft.location);
    if (setFilterDomain) setFilterDomain(draft.domain);
  };

  const extraFiltersJsx = extraFilters.map((f) => (
    <div className="filter-date-group" key={f.key}>
      <span>{f.label}</span>
      <MultiSelectDropdown
        placeholder={`All ${f.label}`}
        options={f.options}
        selected={f.selected}
        onChange={f.setSelected}
      />
    </div>
  ));

  const dateRangeJsx = dateRange && (
    <>
      <div className="filter-date-group">
        <span>From Date</span>
        <DateFilterInput value={dateRange.start || '2026-01-01'} onChange={dateRange.setStart} />
      </div>
      <div className="filter-date-group">
        <span>To Date</span>
        <DateFilterInput value={dateRange.end || '2026-12-31'} onChange={dateRange.setEnd} />
      </div>
    </>
  );

  return (
    <div className="filter-bar-container">
      <div className="filter-label">
        <span>Filters:</span>
      </div>

      {/* Category Dropdown */}
      <div className="filter-date-group">
        <span>Category</span>
        <MultiSelectDropdown
          placeholder="All Categories"
          options={categories.map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
          selected={draft.category}
          onChange={(vals) => setDraft((d) => ({ ...d, category: vals }))}
        />
      </div>

      {/* Capacity Dropdown */}
      <div className="filter-date-group">
        <span>Capacity</span>
        <MultiSelectDropdown
          placeholder="All Capacities"
          options={capacities}
          selected={draft.capacity}
          onChange={(vals) => setDraft((d) => ({ ...d, capacity: vals }))}
        />
      </div>

      {/* Status Dropdown */}
      {statusOptions && statusOptions.length > 0 && (
        <div className="filter-date-group">
          <span>{statusLabel}</span>
          <MultiSelectDropdown
            placeholder={`All ${pluralizeLabel(statusLabel)}`}
            options={statusOptions}
            selected={draft.status}
            onChange={(vals) => setDraft((d) => ({ ...d, status: vals }))}
          />
        </div>
      )}

      {/* Priority / Severity / Condition Dropdown */}
      {priorityOptions && priorityOptions.length > 0 && (
        <div className="filter-date-group">
          <span>{priorityLabel}</span>
          <MultiSelectDropdown
            placeholder={`All ${pluralizeLabel(priorityLabel)}`}
            options={priorityOptions}
            selected={draft.priority}
            onChange={(vals) => setDraft((d) => ({ ...d, priority: vals }))}
          />
        </div>
      )}

      {/* Location/Domain — only Vehicle Management passes their setters. */}
      {setFilterLocation && (
        <div className="filter-date-group">
          <span>Location</span>
          <MultiSelectDropdown
            placeholder="All Locations"
            options={locations}
            selected={draft.location}
            onChange={(vals) => setDraft((d) => ({ ...d, location: vals }))}
          />
        </div>
      )}
      {setFilterDomain && (
        <div className="filter-date-group">
          <span>Domain</span>
          <MultiSelectDropdown
            placeholder="All Domains (Land/Water)"
            options={domains}
            selected={draft.domain}
            onChange={(vals) => setDraft((d) => ({ ...d, domain: vals }))}
          />
        </div>
      )}

      {/* Extra module-specific dropdowns and the date range apply
          immediately, not staged. */}
      {extraFiltersJsx}
      {dateRangeJsx}

      {/* Apply Filter button */}
      <button
        type="button"
        className="filter-apply-btn"
        onClick={applyFilters}
        disabled={!isDirty}
      >
        Filter
      </button>

      {trailing && <div className="filter-bar-trailing">{trailing}</div>}
    </div>
  );
}

// "Import Vehicle Data" wizard: template -> upload -> preview (nothing is saved
// yet) -> confirm -> summary. The server re-reads and re-validates the stored
// file on confirm, so this only ever names which preview to confirm.
function VehicleImportModal({ open, onClose, onImported }) {
  const [step, setStep] = useState('upload'); // upload | preview | done
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  if (!open) return null;

  const close = () => {
    setStep('upload'); setFile(null); setError(''); setResult(null); setBusy(false);
    onClose();
  };

  const saveBlob = async (path, params, filename) => {
    const response = await api.get(path, { params, responseType: 'blob' });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const guard = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); } catch (err) {
      setError(err.response?.data?.message || err.response?.data?.errors?.file?.[0] || 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  const upload = () => guard(async () => {
    const body = new FormData();
    body.append('file', file);
    const res = await api.post('/vehicle-imports', body, { headers: { 'Content-Type': 'multipart/form-data' } });
    setResult(res.data); setStep('preview');
  });

  const confirm = () => guard(async () => {
    const res = await api.post(`/vehicle-imports/${result.id}/commit`);
    setResult(res.data); setStep('done');
    await onImported?.();
  });

  const findings = result?.findings ?? [];

  return (
    <FormModal open title="Import Vehicle Data" onClose={close} wide>
      {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}

      {step === 'upload' && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}>1. Download the template, fill in one vehicle per row, then upload it as .xlsx or .csv (up to 500 rows, 2 MB). You will review everything before anything is saved.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob('/vehicle-imports/template', { format: 'xlsx' }, 'vehicle-import-template.xlsx'))}>Download Excel template</button>
            <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob('/vehicle-imports/template', { format: 'csv' }, 'vehicle-import-template.csv'))}>Download CSV template</button>
          </div>
          <input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="form-actions">
            <button type="button" className="ghost-button" onClick={close}>Cancel</button>
            <button type="button" className="primary-button" disabled={!file || busy} onClick={upload}>{busy ? 'Checking…' : 'Upload & Preview'}</button>
          </div>
        </div>
      )}

      {step === 'preview' && result && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}><strong>{result.file_name}</strong> — {result.total_rows} rows: <strong>{result.valid_rows} valid</strong>, <strong>{result.error_rows} with errors</strong>, <strong>{result.warning_rows} with warnings</strong>.</p>
          {findings.length > 0 && (
            <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border, #d0d7e2)', borderRadius: 8 }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead><tr><th align="left">Row</th><th align="left">Field</th><th align="left">Issue</th></tr></thead>
                <tbody>
                  {findings.map((f, i) => (
                    <tr key={i} style={{ color: f.level === 'error' ? '#b42318' : '#b54708' }}>
                      <td>{f.row}</td><td>{f.field.replace(/_/g, ' ')}</td><td>{f.level === 'warning' ? 'Warning: ' : ''}{f.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ margin: 0, fontSize: 13 }}>Rows with errors will be skipped. Only the {result.valid_rows} valid row(s) are imported.</p>
          <div className="form-actions">
            {result.error_rows > 0 && (
              <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob(`/vehicle-imports/${result.id}/errors`, {}, 'vehicle-import-errors.csv'))}>Download error report</button>
            )}
            <button type="button" className="ghost-button" onClick={() => { setStep('upload'); setResult(null); }}>Back</button>
            <button type="button" className="success-button" disabled={busy || result.valid_rows === 0} onClick={confirm}>{busy ? 'Importing…' : `Import ${result.valid_rows} vehicle(s)`}</button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}>Import complete: <strong>{result.imported_rows} vehicle(s) added</strong>, {result.failed_rows} skipped, out of {result.total_rows} rows.</p>
          <div className="form-actions">
            {result.failed_rows > 0 && (
              <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob(`/vehicle-imports/${result.id}/errors`, {}, 'vehicle-import-errors.csv'))}>Download error report</button>
            )}
            <button type="button" className="primary-button" onClick={close}>Done</button>
          </div>
        </div>
      )}
    </FormModal>
  );
}
// Admin-defined custom fields for one Vehicle Type. Fields are archived, not
// deleted, so vehicles keep the values they already hold.
const CUSTOM_FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'date', label: 'Date' },
  { value: 'yes_no', label: 'Yes / No' },
];
const BLANK_FIELD_DRAFT = { label: '', field_type: 'text', is_required: false, unit: '', options: '' };

function CategoryFieldsManager({ categoryId, onChanged }) {
  const [fields, setFields] = useState([]);
  const [draft, setDraft] = useState(BLANK_FIELD_DRAFT);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get(`/categories/${categoryId}/fields`);
    setFields(res.data);
  }, [categoryId]);

  useEffect(() => {
    let cancelled = false;
    api.get(`/categories/${categoryId}/fields`).then((res) => { if (!cancelled) setFields(res.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [categoryId]);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); await onChanged?.(); } catch (err) {
      setError(err.response?.data?.message || 'Could not save the field.');
    } finally { setBusy(false); }
  };

  const toPayload = (d) => ({
    label: d.label.trim(),
    field_type: d.field_type,
    is_required: d.is_required,
    unit: d.unit?.trim() || null,
    options: d.field_type === 'dropdown' ? String(d.options).split(',').map((o) => o.trim()).filter(Boolean) : null,
  });

  const save = () => run(async () => {
    if (editingId) await api.put(`/category-fields/${editingId}`, toPayload(draft));
    else await api.post(`/categories/${categoryId}/fields`, toPayload(draft));
    setDraft(BLANK_FIELD_DRAFT); setEditingId(null);
  });

  const move = (index, delta) => run(async () => {
    const a = fields[index]; const b = fields[index + delta];
    if (!b) return;
    // Renumber both neighbours so equal sort_orders can't leave them stuck.
    await api.put(`/category-fields/${a.field_id}`, { label: a.label, sort_order: index + delta });
    await api.put(`/category-fields/${b.field_id}`, { label: b.label, sort_order: index });
  });

  const startEdit = (f) => {
    setEditingId(f.field_id);
    setDraft({ label: f.label, field_type: f.field_type, is_required: f.is_required, unit: f.unit ?? '', options: (f.options ?? []).join(', ') });
  };

  return (
    <section className="veh-card" style={{ marginTop: 16 }}>
      <div className="veh-card-head"><Icon name="list" size={16} /><h4>Custom Fields</h4></div>
      <div style={{ padding: '0 20px 20px', display: 'grid', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13 }}>Extra details asked for whenever a vehicle of this type is added or edited. Archived fields stop being asked, but existing values are kept.</p>
        {error && <div className="notice error">{error}</div>}
        {fields.length === 0 && <p style={{ margin: 0, opacity: 0.7 }}>No custom fields yet.</p>}
        {fields.map((f, i) => (
          <div key={f.field_id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', opacity: f.is_active ? 1 : 0.55 }}>
            <strong style={{ flex: '1 1 200px' }}>{f.label}{f.is_required ? ' *' : ''}</strong>
            <span style={{ fontSize: 13 }}>{CUSTOM_FIELD_TYPES.find((t) => t.value === f.field_type)?.label}{f.unit ? ` · ${f.unit}` : ''}{f.options?.length ? ` · ${f.options.join(', ')}` : ''}{f.is_active ? '' : ' · archived'}</span>
            <button type="button" className="ghost-button" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up">▲</button>
            <button type="button" className="ghost-button" disabled={busy || i === fields.length - 1} onClick={() => move(i, 1)} aria-label="Move down">▼</button>
            <button type="button" className="ghost-button" disabled={busy} onClick={() => startEdit(f)}>Edit</button>
            <button type="button" className="ghost-button" disabled={busy} onClick={() => run(() => api.put(`/category-fields/${f.field_id}`, { label: f.label, is_active: !f.is_active }))}>{f.is_active ? 'Archive' : 'Restore'}</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', borderTop: '1px solid var(--border, #d0d7e2)', paddingTop: 12 }}>
          <label style={{ flex: '1 1 180px' }}>Field name
            <input type="text" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. Tank Capacity" />
          </label>
          <label>Type
            <select value={draft.field_type} disabled={!!editingId} onChange={(e) => setDraft({ ...draft, field_type: e.target.value })}>
              {CUSTOM_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          {(draft.field_type === 'number' || draft.field_type === 'text') && (
            <label style={{ width: 90 }}>Unit
              <input type="text" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} placeholder="L, kg…" />
            </label>
          )}
          {draft.field_type === 'dropdown' && (
            <label style={{ flex: '1 1 220px' }}>Options (comma-separated)
              <input type="text" value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })} placeholder="Front, Rear" />
            </label>
          )}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.is_required} onChange={(e) => setDraft({ ...draft, is_required: e.target.checked })} /> Required
          </label>
          <button type="button" className="primary-button" disabled={busy || !draft.label.trim()} onClick={save}>{editingId ? 'Update Field' : 'Add Field'}</button>
          {editingId && <button type="button" className="ghost-button" onClick={() => { setEditingId(null); setDraft(BLANK_FIELD_DRAFT); }}>Cancel</button>}
        </div>
      </div>
    </section>
  );
}

// Fleet Readiness & Criticality Watch — every operational vehicle that isn't
// verified ready, Critical first. Shown on the lean (Custodian/Maintenance)
// dashboard; Admin sees the same list inside Risk & Readiness Watch.
function CriticalityWatchCard({ items, onNavigate, basePath }) {
  const shown = (items ?? []).slice(0, 6);

  return (
    <section className="panel col-span-7 dashboard-lean-panel">
      <div className="panel-header-bar">
        <h3><Icon name="alert" size={16} /> Readiness &amp; Criticality Watch</h3>
        {items?.length > 0 && <span className="area-chart-tag">{items.length} not ready</span>}
      </div>
      {!items?.length ? (
        <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> No readiness risks right now.</p>
      ) : (
        <>
          <div className="risk-watch-col">
            {shown.map((r) => (
              <button
                key={r.vehicle_id}
                type="button"
                className={`risk-watch-item risk-watch-item-clickable${r.criticality === 'Critical' ? ' is-critical' : ''}`}
                onClick={() => onNavigate(`${basePath}/vehicles/${r.vehicle_id}`)}
              >
                <span className={`risk-watch-item-dot${r.criticality === 'Critical' ? ' is-critical' : ''}`} />
                <div className="risk-watch-item-body">
                  <span className="risk-watch-item-top">
                    <span className="risk-watch-item-title">{r.vehicle_name}</span>
                    <span className={`risk-watch-tag${r.criticality === 'Critical' ? ' is-critical' : ''}`}>{r.criticality.toUpperCase()}</span>
                  </span>
                  <span className="risk-watch-item-sub">{r.category ?? '—'} · {r.reason}</span>
                </div>
              </button>
            ))}
          </div>
          {items.length > shown.length && (
            <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.78rem' }}>+ {items.length - shown.length} more — open Vehicles to see them all.</p>
          )}
        </>
      )}
    </section>
  );
}

// Fleet Capability & Readiness Impact — final feature pass (2026-10-10).
// The per-vehicle Criticality Watch above, rolled up to "which emergency
// capability is at risk?" per Vehicle Type. Entirely server-computed
// (capability_impact on the dashboard response) — this component only
// renders what it's given, it never recomputes readiness/criticality itself.
const CAPABILITY_STATE_LABEL = { LIMITED: 'Limited', AT_RISK: 'At Risk', NO_COVERAGE: 'No Coverage' };

function CapabilityImpactCard({ items, onNavigate, basePath }) {
  return (
    <section className="panel col-span-7 dashboard-lean-panel">
      <div className="panel-header-bar">
        <h3><Icon name="alert" size={16} /> Fleet Capability Impact</h3>
        {items?.length > 0 && <span className="area-chart-tag">{items.length} type{items.length === 1 ? '' : 's'} affected</span>}
      </div>
      {!items?.length ? (
        <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> No capability gaps right now.</p>
      ) : (
      <div className="risk-watch-col">
        {items.map((row) => (
          <div key={row.category} className={`risk-watch-item${row.criticality === 'Critical' ? ' is-critical' : ''}`} style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <span className={`risk-watch-item-dot${row.criticality === 'Critical' ? ' is-critical' : ''}`} />
            <div className="risk-watch-item-body">
              <span className="risk-watch-item-top">
                <span className="risk-watch-item-title">{row.category}</span>
                <span className={`risk-watch-tag${row.coverage_state === 'NO_COVERAGE' ? ' is-critical' : ''}`}>
                  {CAPABILITY_STATE_LABEL[row.coverage_state] ?? row.coverage_state}
                </span>
              </span>
              <span className="risk-watch-item-sub">
                {row.ready}/{row.total} ready · {row.criticality} · {row.primary_reason ?? 'Based on current records.'}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
                {row.affected_vehicles.slice(0, 4).map((v) => (
                  <span key={v.vehicle_id} style={{ display: 'inline-flex', borderRadius: 999, overflow: 'hidden', border: '1px solid #cbd5e1' }}>
                    <button
                      type="button"
                      className="btn-view-action"
                      style={{ fontSize: '0.74rem', padding: '3px 9px', border: 'none', borderRadius: 0 }}
                      onClick={() => onNavigate(`${basePath}/vehicles/${v.vehicle_id}`)}
                    >
                      {v.vehicle_name}
                    </button>
                    {v.active_ticket_id && (
                      <button
                        type="button"
                        className="btn-view-action"
                        title={`Open Ticket #${v.active_ticket_id}`}
                        style={{ fontSize: '0.74rem', padding: '3px 9px', border: 'none', borderLeft: '1px solid #cbd5e1', borderRadius: 0, background: '#eff6ff' }}
                        onClick={() => onNavigate(`${basePath}/tickets/${v.active_ticket_id}`)}
                      >
                        Ticket
                      </button>
                    )}
                  </span>
                ))}
                {row.affected_vehicles.length > 4 && (
                  <span className="muted" style={{ fontSize: '0.72rem' }}>+ {row.affected_vehicles.length - 4} more</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      )}
    </section>
  );
}

// Vehicle Usage Log — open a trip when the vehicle goes out, close it when it
// is back. Recording only; it never changes the vehicle's status.
// One timeline per vehicle. Maintenance, condition, readiness, location and
// usage history are just filters over it, not separate screens.
const HISTORY_FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'maintenance', label: 'Maintenance', test: (t) => /ticket|maintenance|repair|part removed|schedule|decommission|restored|archived/i.test(t) },
  { key: 'condition', label: 'Condition', test: (t) => /condition/i.test(t) },
  { key: 'readiness', label: 'Readiness', test: (t) => /readiness|available/i.test(t) },
  { key: 'location', label: 'Location', test: (t) => /location/i.test(t) },
  { key: 'usage', label: 'Usage', test: (t) => /taken out|returned/i.test(t) },
];

function VehicleHistoryCard({ vehicleId }) {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let cancelled = false;
    api.get('/histories', { params: { vehicle_id: vehicleId } }).then((res) => { if (!cancelled) setRows(res.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [vehicleId]);

  const active = HISTORY_FILTERS.find((f) => f.key === filter) ?? HISTORY_FILTERS[0];
  const shown = rows.filter((r) => active.test(r.activity_type ?? '')).slice(0, 40);

  return (
    <section className="veh-card">
      <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>History</h4></div>
      <div style={{ padding: '0 18px 18px', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {HISTORY_FILTERS.map((f) => (
            <button key={f.key} type="button" className={f.key === filter ? 'btn-sm primary-button' : 'btn-sm ghost-button'} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nothing recorded yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 6, maxHeight: 320, overflow: 'auto' }}>
            {shown.map((r) => (
              <div key={r.history_id} style={{ fontSize: '0.84rem', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <span><strong>{r.activity_type}</strong> — {r.description}</span>
                <span className="muted">{formatDate(r.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function VehicleUsageCard({ vehicleId, canLog, vehicleStatus, readinessState, onChanged }) {
  const [trips, setTrips] = useState([]);
  const [form, setForm] = useState({ purpose: '', destination: '', driver_name: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.get(`/vehicles/${vehicleId}/usage`).then((res) => { if (!cancelled) setTrips(res.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [vehicleId, reloadKey]);

  const open = trips.find((t) => !t.ended_at);
  const lastTrip = trips.find((t) => t.ended_at);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); setReloadKey((k) => k + 1); await onChanged?.(); } catch (err) {
      setError(err.response?.data?.message || (err.response?.data?.errors && Object.values(err.response.data.errors)[0]?.[0]) || 'Could not save.');
    } finally { setBusy(false); }
  };

  const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => String(v).trim() !== ''));

  // Take Out is only possible for a vehicle that is Available AND verified ready.
  const blockedReason = vehicleStatus !== 'Available'
    ? `This vehicle is ${vehicleStatus ?? 'unavailable'}, so it can't be taken out.`
    : readinessState !== 'ready'
      ? 'Run a readiness check first — a vehicle must be verified ready before it goes out.'
      : null;

  return (
    <section className="veh-card">
      <div className="veh-card-head">
        <Icon name="vehicle" size={16} /><h4>Usage</h4>
        <span className="area-chart-tag" style={{ marginLeft: 'auto' }}>{open ? 'Currently Out' : 'At Base'}</span>
      </div>
      <div style={{ padding: '0 18px 18px', display: 'grid', gap: 10 }}>
        {error && <div className="notice error">{error}</div>}
        {open ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem' }}>Out since {formatDate(open.started_at)}: <strong>{open.purpose}</strong>{open.destination ? ` → ${open.destination}` : ''}{open.driver_name ? ` · ${open.driver_name}` : ''}</span>
            {canLog && (
              <button type="button" className="primary-button" disabled={busy} onClick={() => run(() => api.put(`/usage-logs/${open.usage_id}/end`, {}))}>Mark Returned</button>
            )}
          </div>
        ) : canLog && (
          blockedReason ? (
            <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>{blockedReason}</p>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input type="text" placeholder="Purpose *" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} style={{ flex: '2 1 180px' }} />
              <input type="text" placeholder="Destination" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} style={{ flex: '1 1 140px' }} />
              <input type="text" placeholder="Driver" value={form.driver_name} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} style={{ flex: '1 1 120px' }} />
              <button type="button" className="primary-button" disabled={busy || !form.purpose.trim()} onClick={() => run(async () => { await api.post(`/vehicles/${vehicleId}/usage`, clean(form)); setForm({ purpose: '', destination: '', driver_name: '' }); })}>Take Out</button>
            </div>
          )
        )}
        {!open && lastTrip && (
          <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>Last used {formatDate(lastTrip.started_at)} – {formatDate(lastTrip.ended_at)}: {lastTrip.purpose}</p>
        )}
      </div>
    </section>
  );
}
function LocalSearchInput({ value, onChange, placeholder = "Search...", onExport, onAdd, addLabel = "Add", onImport, columnChooser }) {
  return (
    <div className="local-search-bar">
      <div className="local-search-container">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="local-search-icon">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="local-search-input"
        />
        {value && (
          <button className="local-search-clear" onClick={() => onChange('')} type="button" title="Clear search">
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {columnChooser && <ColumnChooserButton {...columnChooser} />}
      {onAdd && (
        <button className="icon-add-btn has-label" onClick={onAdd} type="button" title={addLabel} aria-label={addLabel}>
          <Icon name="plus" size={18} />
          <span className="icon-add-btn-label">{addLabel}</span>
        </button>
      )}
      {onImport && (
        <button className="export-btn" onClick={onImport} type="button" title="Import vehicles from a spreadsheet" aria-label="Import vehicles from a spreadsheet">
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="download" size={15} /></span>
        </button>
      )}
      {onExport && (
        <button className="export-btn" onClick={onExport} type="button" title="Export to CSV" aria-label="Export to CSV">
          <Icon name="download" size={15} />
        </button>
      )}
    </div>
  );
}

// Persists which columns a table shows and in what order, per browser (one
// localStorage entry per `storageKey`, so e.g. Vehicle Management's choices
// don't bleed into a different table reusing this same hook later).
// `allColumns` must be a stable array of {key, label, locked?, ...} — `key`
// is the identity persisted to storage, `locked` (e.g. ID/Action) hides the
// checkbox instead of letting a table lose its own row identifier or
// actions. Returns the already order-applied, hidden-filtered array to pass
// straight into DataTable/PaginatedTable's `columns` prop.
function useColumnChooser(storageKey, allColumns) {
  const columnKeys = allColumns.map((c) => c.key);
  // Real deps for the effect below — a plain array literal would be a new
  // reference (and re-run the effect) every render even when unchanged.
  const columnKeysSignature = columnKeys.join('|');

  const [order, setOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}_order`) ?? 'null');
      if (Array.isArray(saved) && saved.length) {
        const stillValid = saved.filter((k) => columnKeys.includes(k));
        const newOnes = columnKeys.filter((k) => !stillValid.includes(k));
        return [...stillValid, ...newOnes];
      }
    } catch { /* fall through to default order */ }
    return columnKeys;
  });
  const [hidden, setHidden] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`${storageKey}_hidden`) ?? '[]');
      return new Set(Array.isArray(saved) ? saved.filter((k) => columnKeys.includes(k)) : []);
    } catch {
      return new Set();
    }
  });

  // Keeps a saved preference from a previous session in sync if the column
  // set itself changes shape later (e.g. the role-gated Action column
  // appearing/disappearing) — drops keys that no longer exist, appends any
  // new ones at the end rather than silently hiding them.
  useEffect(() => {
    setOrder((prev) => {
      const stillValid = prev.filter((k) => columnKeys.includes(k));
      const newOnes = columnKeys.filter((k) => !stillValid.includes(k));
      return newOnes.length || stillValid.length !== prev.length ? [...stillValid, ...newOnes] : prev;
    });
    setHidden((prev) => {
      const next = new Set([...prev].filter((k) => columnKeys.includes(k)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKeysSignature]);

  useEffect(() => {
    try { localStorage.setItem(`${storageKey}_order`, JSON.stringify(order)); } catch { /* storage unavailable */ }
  }, [storageKey, order]);
  useEffect(() => {
    try { localStorage.setItem(`${storageKey}_hidden`, JSON.stringify([...hidden])); } catch { /* storage unavailable */ }
  }, [storageKey, hidden]);

  const toggleColumn = (key) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  // `side` ('before' | 'after') lets the table header's own drag handler
  // place a column on whichever side of the drop target the cursor was
  // actually over (matching the drop-line indicator DataTable draws there)
  // — the popover's simpler row list never passes it, so it keeps its
  // original "insert at the target's position" behavior.
  const reorderColumn = (dragKey, dropKey, side = 'before') => {
    if (dragKey === dropKey) return;
    setOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(dragKey);
      if (from === -1) return prev;
      next.splice(from, 1);
      let to = next.indexOf(dropKey);
      if (to === -1) return prev;
      if (side === 'after') to += 1;
      next.splice(to, 0, dragKey);
      return next;
    });
  };
  const resetColumns = () => {
    setOrder(columnKeys);
    setHidden(new Set());
  };

  const byKey = new Map(allColumns.map((c) => [c.key, c]));
  const visibleColumns = order.map((k) => byKey.get(k)).filter((c) => c && !hidden.has(c.key));

  return { allColumns, order, hidden, toggleColumn, reorderColumn, resetColumns, visibleColumns };
}

// Toolbar trigger + popover for picking which columns a table shows and
// reordering them by drag — spread straight from useColumnChooser's return
// value as <ColumnChooserButton {...chooser} />.
function ColumnChooserButton({ allColumns, order, hidden, toggleColumn, reorderColumn, resetColumns }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dragKeyRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const byKey = new Map(allColumns.map((c) => [c.key, c]));
  const orderedColumns = order.map((k) => byKey.get(k)).filter(Boolean);
  const query = search.trim().toLowerCase();
  const filtered = query ? orderedColumns.filter((c) => c.label.toLowerCase().includes(query)) : orderedColumns;
  // Dragging to reorder only makes sense against the full, unfiltered list —
  // disabled while a search is narrowing the rows shown, same reasoning
  // CreatableSelect's own filtered list uses.
  const dragEnabled = !query;

  return (
    <div className="column-chooser" ref={containerRef}>
      <button
        type="button"
        className={`export-btn${open ? ' is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Choose columns"
        aria-label="Choose columns"
      >
        <Icon name="columns" size={16} />
      </button>
      {open && (
        <div className="column-chooser-panel" role="dialog" aria-label="Choose columns">
          <div className="column-chooser-head">
            <h4>Choose Columns</h4>
            <button type="button" className="toast-notice-close" onClick={() => setOpen(false)} aria-label="Close">
              <Icon name="close" size={13} />
            </button>
          </div>
          <div className="column-chooser-search">
            <Icon name="search" size={13} />
            <input type="text" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="column-chooser-list">
            {filtered.map((col) => (
              <div
                key={col.key}
                className="column-chooser-row"
                draggable={dragEnabled}
                onDragStart={() => { dragKeyRef.current = col.key; }}
                onDragOver={(e) => { if (dragEnabled) e.preventDefault(); }}
                onDrop={() => {
                  if (dragEnabled && dragKeyRef.current) reorderColumn(dragKeyRef.current, col.key);
                  dragKeyRef.current = null;
                }}
              >
                <span className={`column-chooser-grip${dragEnabled ? '' : ' is-disabled'}`} aria-hidden="true">
                  <Icon name="gripVertical" size={14} />
                </span>
                <label className="column-chooser-checkbox">
                  <input
                    type="checkbox"
                    checked={!hidden.has(col.key)}
                    disabled={col.locked}
                    onChange={() => toggleColumn(col.key)}
                  />
                  <span>{col.label}</span>
                </label>
              </div>
            ))}
            {filtered.length === 0 && <p className="column-chooser-empty">No columns match &quot;{search}&quot;.</p>}
          </div>
          <div className="column-chooser-foot">
            <button type="button" className="link-button" onClick={resetColumns}>Reset to default</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Workspace;
