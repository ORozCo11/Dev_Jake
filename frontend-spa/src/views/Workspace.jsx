import { useLocation, useNavigate } from 'react-router-dom';
import { Suspense, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from '../context/AuthContextObject';
import useDepsChanged from '../hooks/useDepsChanged';
import useResponsiveNav from '../hooks/useResponsiveNav';
import useCssHeightVar from '../hooks/useCssHeightVar';
import { SidebarBackdrop, SidebarDrawerHead } from '../components/SidebarDrawerChrome';
import api from '../api/axios';
import Icon from '../components/Icon';
import { geoJsonToRings } from '../utils/boundary';
import { PAKNAAN_POLYGON } from '../data/paknaanLocationDensity';
import WorkspaceFooter from '../components/WorkspaceFooter';
import ConfirmDialog from '../components/ConfirmDialog';
import { LocationDensityMap } from '../components/lazy';
import { categoryColumns, issueColumns, locationColumns, logColumns, maintenanceStatusColumns, scheduleColumns, ticketArchiveColumns, userColumns, vehicleColumns } from '../workspace/columns';
import { FilterBar, IssueFilterPanel, VehicleFilterPanel } from '../workspace/components/filters';
import { DateFilterInput, MultiSelectDropdown } from '../workspace/components/inputs';
import { DataTable, ModuleStatCards, PaginatedCardGrid, PaginatedTable, ViewModeDropdown } from '../workspace/components/tables';
import { DateBadge, FormModal, LocalSearchInput, ModuleLoader, ModulePanel, TicketStatusBadge } from '../workspace/components/ui';
import { IssueFilteredEmpty } from '../workspace/issues/issueBadges';
import { ConditionFilteredEmpty, ConditionMonitoringIntro, ConditionResultBadge, ConditionTicketCell } from '../workspace/conditions/conditions';
import { ErrorState } from '../workspace/components/states';
import { FormNoticeContext, RowActionsContext } from '../workspace/contexts';
import { FormPage, OpenItemsWarning } from '../workspace/forms/FormPage';
import { SmartForm } from '../workspace/forms/SmartForm';
import { useColumnChooser } from '../workspace/hooks/useColumnChooser';
import { cleanPayload, emptyLookups, emptyTicketLookups, fetchHubs, fetchLookups, fetchModuleData, fetchNotifications, fetchTicketLookups, moduleRequest, sendPayload, showError } from '../workspace/lib/data';
import { applyPerformedBy, applyRepairType, categoryFields, conditionFields, issueFields, maintenanceFields, scheduleFields, userFields, verificationFields, withPerformedBy, withRepairType } from '../workspace/lib/fields';
import { subRowFields } from '../workspace/lib/formHelpers';
import { EMPTY_OBJ, formatDate, formatTime, issueDescription, moduleLabel, options, sameSelection } from '../workspace/lib/format';
import { getNotificationStyle } from '../workspace/lib/notifications';
import { canDo, canRegisterVehicles, hasRole, resolveModuleGroups, roleRoutes } from '../workspace/lib/permissions';
import { SCHEDULE_EXPORT_COLUMNS, USER_EXPORT_COLUMNS, VEHICLE_EXPORT_COLUMNS, VEHICLE_HISTORY_EXPORT_COLUMNS, exportRowsToCsv } from '../workspace/lib/reports';
import { MY_ASSIGNED_SCHEDULE_CARD, SCHEDULE_STAT_CARDS, VEHICLE_STAT_CARDS } from '../workspace/lib/statCards';
import { RECURRENCE_LABEL, SCHEDULE_URGENCY_KEYS, flattenSubIssueRows, scheduleDueLabel, scheduleUrgencyBucket, verifyOutcomeMessage } from '../workspace/lib/workflow';
import { moduleIcons } from '../workspace/moduleIcons';
import { PendingRegistrations, ProfileMenu, ProfilePage, UserCard, UserFilterChips, UserInfoModal, UserViewPage } from '../workspace/users/users';
import { isPendingRegistration } from '../workspace/lib/userAccounts';
import { HistoryDayTimeline, LogDayTimeline, ResultScope, ScopedEmptyState } from '../workspace/history/activity';
import { describeDateRange, hasActiveScope, localDayKey, newestHistoryFirst } from '../workspace/lib/activity';
import { PrintSheet } from '../workspace/reports/PrintSheet';

// Pages and module views load on first use (see the Suspense boundary around
// .content-body), so a role only downloads the screens it actually opens.
const lazyNamed = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));
const loadDashboard = () => import('../workspace/dashboard/Dashboard');
const Dashboard = lazyNamed(loadDashboard, 'Dashboard');
const loadIssues = () => import('../workspace/issues/issues');
const IssueViewPage = lazyNamed(loadIssues, 'IssueViewPage');
const loadLocations = () => import('../workspace/locations/locations');
const EditLocationPage = lazyNamed(loadLocations, 'EditLocationPage');
const NewLocationPage = lazyNamed(loadLocations, 'NewLocationPage');
const loadMaintenance = () => import('../workspace/maintenance/maintenance');
const MaintenanceRecordCard = lazyNamed(loadMaintenance, 'MaintenanceRecordCard');
const MaintenanceRecordProfilePage = lazyNamed(loadMaintenance, 'MaintenanceRecordProfilePage');
const MaintenanceScheduleCard = lazyNamed(loadMaintenance, 'MaintenanceScheduleCard');
const loadReports = () => import('../workspace/reports/reports');
const GenerateReportButton = lazyNamed(loadReports, 'GenerateReportButton');
const ReportPreview = lazyNamed(loadReports, 'ReportPreview');
const ReportsModule = lazyNamed(loadReports, 'ReportsModule');
const loadInspectTicketPage = () => import('../workspace/tickets/InspectTicketPage');
const InspectTicketPage = lazyNamed(loadInspectTicketPage, 'InspectTicketPage');
const loadLogRepairsPage = () => import('../workspace/tickets/LogRepairsPage');
const LogRepairsPage = lazyNamed(loadLogRepairsPage, 'LogRepairsPage');
const loadNewTicketPage = () => import('../workspace/tickets/NewTicketPage');
const NewTicketPage = lazyNamed(loadNewTicketPage, 'NewTicketPage');
const loadProposeTicketPage = () => import('../workspace/tickets/ProposeTicketPage');
const ProposeTicketPage = lazyNamed(loadProposeTicketPage, 'ProposeTicketPage');
const loadTicketDetailPanel = () => import('../workspace/tickets/TicketDetailPanel');
const TicketProfilePage = lazyNamed(loadTicketDetailPanel, 'TicketProfilePage');
const loadTicketModules = () => import('../workspace/tickets/ticketModules');
const CustodianInspectionModule = lazyNamed(loadTicketModules, 'CustodianInspectionModule');
const CustodianVerificationModule = lazyNamed(loadTicketModules, 'CustodianVerificationModule');
const MechanicWorkOrderModule = lazyNamed(loadTicketModules, 'MechanicWorkOrderModule');
const TicketModule = lazyNamed(loadTicketModules, 'TicketModule');
const WorkTrackerModule = lazyNamed(loadTicketModules, 'WorkTrackerModule');
const loadNewVehiclePage = () => import('../workspace/vehicles/NewVehiclePage');
const CategoryFieldsManager = lazyNamed(loadNewVehiclePage, 'CategoryFieldsManager');
const NewVehiclePage = lazyNamed(loadNewVehiclePage, 'NewVehiclePage');
const VehicleImportModal = lazyNamed(loadNewVehiclePage, 'VehicleImportModal');
const loadVehicleProfilePage = () => import('../workspace/vehicles/VehicleProfilePage');
const ReadinessCheckForm = lazyNamed(() => import('../workspace/vehicles/ReadinessCheckForm'), 'ReadinessCheckForm');
const VehicleProfilePage = lazyNamed(loadVehicleProfilePage, 'VehicleProfilePage');

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
    || (logRepairsTicketId && 'Record Repair Work')
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
      || (isNewSchedulePage && !canDo(user, 'schedule.create') && !canDo(user, 'schedule.suggest'))
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
  // Keyed on role/roles only (all resolveModuleGroups reads) — a refreshed
  // user object with the same roles must not rebuild the sidebar, which would
  // reset activeModule back to the first module.
  const userRole = user.role;
  const userRoleList = user.roles;
  const moduleGroups = useMemo(() => resolveModuleGroups({ role: userRole, roles: userRoleList }), [userRole, userRoleList]);
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
    // Maintenance Personnel no longer has a standalone 'workTracker' sidebar
    // entry (folded into 'ticketWorkOrders' own Archive toggle) — prefer that
    // key so a direct/bookmarked ticket link never seeds activeModule with a
    // key this role can't reach from its own sidebar. Mirrors breadcrumbModule's
    // own fallback below. Custodian still has no 'ticketWorkOrders' entry, so
    // this keeps falling through to 'workTracker' (its My Tasks -> History tab) for them.
    if (ticketProfileId || isNewTicketPage) return user.role === 'Admin' ? 'tickets' : (modules.some(([k]) => k === 'ticketWorkOrders') ? 'ticketWorkOrders' : 'workTracker');
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
    // Plain module-list view (no special sub-page open) for one of the merged
    // "My Tasks" queues — 'ticketVerifications' is Custodian-only regardless,
    // 'workTracker' also covers Maintenance Personnel's own separate entry,
    // disambiguated by workTrackerViaMyTasks. Inspection was removed from
    // this merged container (see showMyTasksContainer above) — no path here
    // highlights it anymore, though the standalone page is left reachable by
    // direct link (inspectTicketId above) for any stale/bookmarked URL.
    : (hasMyTasksNav && (
        activeModule === 'ticketVerifications'
        || (activeModule === 'workTracker' && workTrackerViaMyTasks)
      )) ? 'myTasks'
    : (hasReportOrProposeNav && activeModule === 'issues') ? 'reportOrPropose'
    : (hasMaintenanceLedgerNav && (activeModule === 'maintenanceStatus' || activeModule === 'maintenance')) ? 'maintenanceLedger'
    : activeModule;
  // Always starts expanded — a collapsed sidebar should only ever be a
  // deliberate, in-session choice (the toggle button), never the default a
  // returning user lands on.
  const [lookups, setLookups] = useState(emptyLookups);
  const [ticketLookups, setTicketLookups] = useState(emptyTicketLookups);
  const [records, setRecords] = useState({});
  const [prefilledScheduleData, setPrefilledScheduleData] = useState(null);
  // Read once per mount (a lazy initializer may be impure; render may not).
  const [tomorrowDate] = useState(() => new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  // Memoized so the object reference stays stable across unrelated re-renders
  // — SmartForm resets its values whenever this reference changes, which
  // would otherwise wipe out whatever the user has already typed.
  const scheduleInitialValues = useMemo(() => (
    editScheduleId
      ? (records.schedules ?? []).find((s) => String(s.schedule_id) === String(editScheduleId))
      // Default to tomorrow — a schedule is always plotted ahead, so this
      // saves a click for the common case; still fully editable.
      : { scheduled_date: tomorrowDate, ...(prefilledScheduleData ?? {}) }
  ), [editScheduleId, records.schedules, prefilledScheduleData, tomorrowDate]);
  // Set right before navigating to /conditions/new from the "+" on a
  // specific "Not Checked" vehicle row — same pattern as prefilledScheduleData
  // above, so that vehicle is already selected instead of asking the
  // Custodian to pick it again from a vehicle they just clicked.
  const [prefilledConditionVehicleId, setPrefilledConditionVehicleId] = useState(null);
  const conditionInitialValues = useMemo(() => (
    editConditionId
      ? (records.conditions ?? []).find((c) => String(c.condition_check_id) === String(editConditionId))
      : (prefilledConditionVehicleId ? { vehicle_id: prefilledConditionVehicleId } : EMPTY_OBJ)
  ), [editConditionId, records.conditions, prefilledConditionVehicleId]);
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
  const [dashboardUpdatedAt, setDashboardUpdatedAt] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [completeScheduleTarget, setCompleteScheduleTarget] = useState(null);
  // Admin's "Reassign" action on a Scheduled row (schedule.reassign ability,
  // Admin-only) — hands a still-open schedule to a different Maintenance
  // Personnel without cancelling and re-booking it.
  const [reassignScheduleTarget, setReassignScheduleTarget] = useState(null);
  // Admin's "Decline" action on a Pending Approval row (schedule.decline
  // ability, Admin-only) — collects a reason, same modal pattern as Reassign.
  const [declineScheduleTarget, setDeclineScheduleTarget] = useState(null);
  // After a Custodian passes a verification they're already standing at the
  // vehicle — offer the Readiness Check right then instead of making them
  // come back for a second visit. Holds the vehicle to check, or null.
  const [readinessPromptTarget, setReadinessPromptTarget] = useState(null);
  // Card/List toggle for Maintenance Records, remembered per browser the same
  // way the Tickets module does it (separate key so the two don't clobber
  // each other). Defaults to the table — these rows carry more columns worth
  // scanning than a ticket does.
  const [maintenanceViewMode, setMaintenanceViewMode] = useState(
    () => localStorage.getItem('vms_maintenance_view') || 'table'
  );
  const [showMaintenanceFilters, setShowMaintenanceFilters] = useState(false);
  const changeMaintenanceViewMode = (mode) => {
    setMaintenanceViewMode(mode);
    localStorage.setItem('vms_maintenance_view', mode);
  };
  const [scheduleViewMode, setScheduleViewMode] = useState(
    () => localStorage.getItem('vms_schedule_view') || 'table'
  );
  const [showScheduleFilters, setShowScheduleFilters] = useState(false);
  const changeScheduleViewMode = (mode) => {
    setScheduleViewMode(mode);
    localStorage.setItem('vms_schedule_view', mode);
  };
  // List/Recent-Activities tab for the Activity Log — not persisted, since
  // "recent activities" is a quick-glance view you'd want defaulting back
  // to the full list on your next visit rather than staying sticky.
  const [logsView, setLogsView] = useState('list');
  const [usersViewMode, setUsersViewMode] = useState('list');
  // Users module: working accounts vs self-registrations awaiting approval.
  const [usersTab, setUsersTab] = useState('accounts');
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
  // Starts true: the first module load kicks off on mount.
  const [loading, setLoading] = useState(true);
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
  if (useDepsChanged([location.pathname])) setHasUnsavedChanges(false);
  // First-time approval only — a pending self-registration's role is a
  // request, not yet real, so Admin reviews/confirms it here instead of
  // the plain yes/no ConfirmDialog every other activate/deactivate uses.
  const [approvalTarget, setApprovalTarget] = useState(null);
  // The Staff Registration Code the barangay office hands to real staff —
  // Admin-only, fetched once so it's ready whenever they open Users.
  const [registrationCode, setRegistrationCode] = useState(null);
  const [registrationCodeVisible, setRegistrationCodeVisible] = useState(false);
  useEffect(() => {
    if (!hasRole(user, 'Admin')) return;
    api.get('/registration-settings').then((res) => setRegistrationCode(res.data.staff_code)).catch(() => {});
  }, [user]);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showIssueFilters, setShowIssueFilters] = useState(false);
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

  // Ticket Archives date/status filters
  const [archiveDraft, setArchiveDraft] = useState({ start: '', end: '', status: '', quick: '' });
  const [archiveStart, setArchiveStart] = useState('');
  const [archiveEnd, setArchiveEnd] = useState('');
  const [archiveStatusFilter, setArchiveStatusFilter] = useState('');

  // Condition Monitoring Filters
  const [condFilterStartDate, setCondFilterStartDate] = useState('');
  const [condFilterEndDate, setCondFilterEndDate] = useState('');
  // Draft for the condition filter bar — applied only on "Filter" click.
  const [condDraft, setCondDraft] = useState({ category: [], status: [], capacity: [], checkedBy: [], start: '', end: '' });
  const [conditionView, setConditionView] = useState('overview');
  const [showConditionFilters, setShowConditionFilters] = useState(false);
  const [conditionDetailTarget, setConditionDetailTarget] = useState(null);
  const [prefilledTicketData, setPrefilledTicketData] = useState(null);
  // A form page that finishes by switching module wants its success notice to
  // survive the module-change reset below.
  const [keepNotice, setKeepNotice] = useState(false);
  // Pre-filled proposal data (from a flagged issue / condition check) only
  // lives while the ticket form is open — leaving it by ANY route (sidebar,
  // back button, submit) drops it so the next form never re-links stale data.
  if (useDepsChanged([isNewTicketPage]) && !isNewTicketPage) setPrefilledTicketData(null);
  const [allHubs, setAllHubs] = useState([]);
  const [locationsTab, setLocationsTab] = useState('map');
  const [selectedMapVehicleId, setSelectedMapVehicleId] = useState(null);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'light'; } catch { return 'light'; }
  });
  const notificationsRef = useRef(null);
  const profileMenuRef = useRef(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const hasVehicles = (lookups.vehicles ?? []).length > 0;

  const loadNotifications = useCallback(async () => {
    try {
      setNotifications(await fetchNotifications());
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
    setLookups(await fetchLookups());
  }, []);

  const loadHubs = useCallback(async () => {
    setAllHubs(await fetchHubs());
  }, []);

  const loadTicketLookups = useCallback(async () => {
    setTicketLookups(await fetchTicketLookups());
  }, []);

  const applyModuleData = useCallback((patch) => {
    if (!patch) return;
    if (patch.dashboard) { setDashboard(patch.dashboard); setDashboardUpdatedAt(new Date()); }
    if (patch.records) setRecords((current) => ({ ...current, ...patch.records }));
  }, []);

  const loadModule = useCallback(async (key) => {
    applyModuleData(await fetchModuleData(key, user));
  }, [user, applyModuleData]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    fetchLookups()
      .then((data) => { if (!cancelled) setLookups(data); })
      .catch((error) => { if (!cancelled) showError(error, setNotice); });
    fetchTicketLookups()
      .then((data) => { if (!cancelled) setTicketLookups(data); })
      .catch(() => {});
    fetchHubs()
      .then((data) => { if (!cancelled) setAllHubs(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetchNotifications()
        .then((data) => { if (!cancelled) setNotifications(data); })
        .catch((error) => console.error('Failed to load notifications:', error));
    };
    poll();
    const interval = setInterval(poll, 10000); // Poll every 10 seconds
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Sidebar badge counts (dashboard.badge_counts) are visible on every module,
  // but were only ever fetched by loadModule('dashboard') — which only runs
  // when the Dashboard module itself is the active one. Anyone who lands on
  // (or navigates to) a different module first saw stale/zeroed badges until
  // they happened to visit Dashboard. Poll them independently so they reflect
  // live counts no matter what module is currently open.
  // Also refreshed the moment the tab/window regains focus — otherwise work
  // another user did while this tab sat in the background (a mechanic
  // submitting a repair, an Admin approving) only showed up on the next
  // 15s tick, so coming back to the tab briefly showed stale counts.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetchModuleData('dashboard', user)
        .then((patch) => { if (!cancelled) applyModuleData(patch); })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 15000);
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    window.addEventListener('focus', poll);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, applyModuleData]);

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

  // The role's module list changed (e.g. a role edit) — fall back to its first
  // module. Not on mount: the initial activeModule is seeded from the URL.
  if (useDepsChanged([modules])) {
    setActiveModule(modules[0]?.[0] ?? 'dashboard');
  }

  // Switching modules starts from a clean slate — done while rendering (not in
  // an effect) so the old module's filters/notice never flash on the new one.
  if (useDepsChanged([activeModule])) {
     setEditTarget(null);
     setReport(null);
     if (keepNotice) setKeepNotice(false); else setNotice(null);
     setSearchQuery('');
     setFilterCategory([]);
     setFilterCapacity([]);
     setFilterStatus([]);
     setFilterPriority([]);
     setFilterLocation([]);
     setFilterDomain([]);
     setFilterReadiness([]);
     setFilterIssueType([]);
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
     setCondDraft({ category: [], status: [], capacity: [], checkedBy: [], start: '', end: '' });
     setArchiveDraft({ start: '', end: '', status: '', quick: '' });
     setArchiveStart('');
     setArchiveEnd('');
     setArchiveStatusFilter('');
     setLoading(true);
  }

  // A failed module load shows a retryable error panel in place of the
  // module (not just a toast over an empty page).
  const [moduleError, setModuleError] = useState(null);
  const [moduleReloadKey, setModuleReloadKey] = useState(0);
  const retryModuleLoad = () => {
    setModuleError(null);
    setLoading(true);
    setModuleReloadKey((n) => n + 1);
  };
  if (useDepsChanged([activeModule]) && moduleError) setModuleError(null);

  useEffect(() => {
    let cancelled = false;
    fetchModuleData(activeModule, user)
      .then((patch) => { if (!cancelled) { applyModuleData(patch); setModuleError(null); } })
      .catch((error) => { if (!cancelled) setModuleError(error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeModule, user, applyModuleData, moduleReloadKey]);

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
        const reportFilters = { ...cleanPayload(payload) };
        delete reportFilters.report_type;
        const response = await api.get('/reports', { params: cleanPayload(payload) });
        // The API doesn't echo the filters back — keep them for the preview
        // and printed header ("Filters applied").
        setReport({ ...response.data, filters: reportFilters });
        setNotice({ type: 'success', text: `${payload.report_type} generated.` });
        return;
      }

      if (editTarget?.__verify) {
        await api.put(`/maintenance-records/${editTarget.maintenance_id}/verify`, cleanPayload(payload));
        // Capture before clearing editTarget — a Pass means the Custodian is
        // physically at the vehicle right now, which is the cheapest possible
        // moment to also confirm it's ready to respond (see
        // readinessPromptTarget). A Fail means the vehicle is going back for
        // more work, so there's nothing to check yet.
        const justVerifiedVehicle = payload.verification_result === 'Passed' ? editTarget.vehicle : null;
        setEditTarget(null);
        setNotice({ type: 'success', text: 'Verification submitted.' });
        await refreshCurrent();
        if (justVerifiedVehicle) setReadinessPromptTarget(justVerifiedVehicle);
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

  const createTicket = async (payload) => {
    setNotice(null);
    try {
      await api.post('/tickets', cleanPayload(payload));
      setEditTarget(null);
      setNotice({ type: 'success', text: 'Ticket created & inspection assigned to Custodian.' });
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

  // Admin's one next step on an open issue report that needs no ticket.
  const [dismissIssueTarget, setDismissIssueTarget] = useState(null);
  const dismissIssue = async (issue, payload) => {
    setNotice(null);
    try {
      await api.put(`/issues/${issue.issue_report_id}/dismiss`, { dismiss_reason: payload.dismiss_reason });
      setNotice({ type: 'success', text: 'Issue dismissed.' });
      setDismissIssueTarget(null);
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
    }
  };
  function renderDismissIssueModal() {
    return (
      <FormModal open={!!dismissIssueTarget} title={`Dismiss issue #${dismissIssueTarget?.issue_report_id ?? ''}`} onClose={() => setDismissIssueTarget(null)}>
        {dismissIssueTarget && (
          <>
            <p className="muted" style={{ marginBottom: 10, fontSize: '0.82rem' }}>
              Closes this report without a ticket — it isn't a real problem, or it's already handled. The reporter is told why.
            </p>
            <SmartForm
              fields={[{ label: 'Reason for dismissing', name: 'dismiss_reason', required: true, type: 'textarea', rows: 3 }]}
              key={`dismiss-${dismissIssueTarget.issue_report_id}`}
              onCancel={() => setDismissIssueTarget(null)}
              onSubmit={(payload) => dismissIssue(dismissIssueTarget, payload)}
              submitLabel="Dismiss Issue"
              title=""
            />
          </>
        )}
      </FormModal>
    );
  }

  const handleCreateTicketFromIssue = (issue) => {
    // The custodian who filed this already told us what's wrong — don't make
    // someone re-diagnose it. Pre-diagnosed mode skips straight past
    // inspection to a sub-issue ready for a mechanic; the assigned custodian
    // only re-enters later, to verify the actual repair.
    const reporterId = issue.reported_by?.id;
    const reporterIsCustodian = (ticketLookups.custodians ?? []).some((c) => c.id === reporterId);
    setPrefilledTicketData({
      vehicle_id: issue.vehicle_id,
      ticket_title: `[Issue #${issue.issue_report_id}] ${issue.issue_type}`,
      // Severity and ticket priority share the same Low / Medium / High scale.
      priority: issue.severity_level,
      ticket_description: `Original Reported Issue: ${issue.issue_description}\nSeverity: ${issue.severity_level}`,
      issue_report_id: issue.issue_report_id,
      // In-house repair is by far the usual case — preselected so it's one
      // click less; the Custodian can switch to cannibalized / external.
      entry_mode: canDo(user, 'ticket.propose') ? 'in_house' : 'prediagnosed',
      // The custodian's report is now a list of distinct problems (one per
      // line, see issueFields' 'list' field) — carry each one over as its
      // own sub-issue instead of dumping the whole report into a single line.
      sub_issues_text: (issue.issue_description ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
        .map((line) => `${issue.issue_type}: ${line}`).join('\n'),
      // Defaulted, not locked — Admin can still pick someone else (workload,
      // availability), but the person who already knows this is the sane
      // starting point instead of a blank "Select."
      ...(reporterIsCustodian ? { assigned_custodian_id: reporterId } : {}),
    });
    navigate(`${roleRoutes[user.role]}/tickets/new`);
  };

  // #2 (Mode C) — a "Needs Repair"/"Needs Inspection" condition check
  // already IS the inspection, so spawn a pre-diagnosed ticket carrying the
  // custodian's findings straight in instead of making someone re-describe
  // the same problem all over again via a separate Issue Report. Observations
  // seed the sub-issues. Needs Repair is a confirmed problem (High); Needs
  // Inspection is still just "take a closer look" (Medium) until it is one.
  const handleCreateTicketFromCondition = (cond) => {
    setPrefilledTicketData({
      vehicle_id: cond.vehicle_id,
      ticket_title: `Condition Check: ${cond.condition_result}`,
      ticket_description: `From condition check #${cond.condition_check_id} by ${cond.checked_by?.name ?? 'custodian'}.\nObservations: ${cond.observations ?? '—'}`,
      entry_mode: canDo(user, 'ticket.propose') ? 'in_house' : 'prediagnosed',
      sub_issues_text: cond.observations || cond.condition_result,
      priority: cond.condition_result === 'Needs Repair' ? 'High' : 'Medium',
      condition_check_id: cond.condition_check_id,
    });
    navigate(`${roleRoutes[user.role]}/tickets/new`);
  };

  // The Custodian has daily eyes on the vehicle and is the one most likely
  // to notice "this is due for a checkup soon" — and, since Custodian can
  // book a schedule directly again, this hands off straight to the real Add
  // Schedule form with the vehicle and a note already filled in; nothing is
  // booked until the form is actually submitted.
  const handleSuggestScheduleFromCondition = (cond) => {
    setPrefilledScheduleData({
      vehicle_id: cond.vehicle_id,
      notes: `Suggested from condition check #${cond.condition_check_id} (${cond.condition_result})${cond.observations ? `: ${cond.observations}` : ''}`,
    });
    navigate(`${roleRoutes[user.role]}/schedules/new`);
  };

  // Maintenance Personnel can't open a ticket — this points the Custodians at
  // the exact issue so they can propose one with everything already filled in.
  const recommendTicketForIssue = async (issue) => {
    setNotice(null);
    try {
      await api.post(`/issues/${issue.issue_report_id}/recommend-ticket`);
      setNotice({ type: 'success', text: 'Custodians notified — they can open the ticket from this issue.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const deleteTicket = async (ticket) => {
    setNotice(null);
    try {
      await api.delete(`/tickets/${ticket.ticket_id}`);
      setNotice({ type: 'success', text: 'Ticket deleted successfully.' });
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const updateRecord = async (path, payload, success) => {
    try {
      await api.put(path, payload);
      setNotice({ type: 'success', text: success });
      await refreshCurrent();
    } catch (error) {
      showError(error, setNotice);
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

  // `title` / `confirmLabel` name the actual action ("Deactivate X" /
  // "Deactivate") instead of a generic "Confirm Action" / "Continue".
  const deleteRecord = async (path, success, confirmMessage, { title = 'Confirm Action', confirmLabel = 'Continue' } = {}) => {
    setConfirmDialog({
      title,
      message: confirmMessage ?? 'Continue with this action?',
      confirmLabel,
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
      title: activate ? `Reactivate ${row.name}?` : `Deactivate ${row.name}?`,
      message: activate
        ? `${row.name} will be able to sign in again with their existing roles.`
        : (
          <>
            <span className="p23-confirm-line">{row.name} won't be able to sign in until an Admin reactivates the account.</span>
            <span className="p23-confirm-line">Nothing is deleted: their past actions, vehicle history entries, tickets, and logs stay attributed to them by name.</span>
            <span className="p23-confirm-line">Work still assigned to them (open tickets, schedules) stays assigned — reassign it if needed.</span>
          </>
        ),
      confirmLabel: activate ? 'Reactivate' : 'Deactivate account',
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
  const restoreRecord = async (path, success, message = 'Restore this vehicle to active service?', { title = 'Restore', confirmLabel = 'Restore' } = {}) => {
    setConfirmDialog({
      title,
      message,
      confirmLabel,
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

  // Admin reviews a Custodian's Pending Approval schedule — approve puts it
  // live (Scheduled); decline collects a reason, same propose/approve/decline
  // shape as a ticket proposal. Both work from Declined too (approve direct,
  // or decline again is a no-op since it's already there).
  const approveSchedule = async (target) => {
    setNotice(null);
    try {
      await api.put(`/maintenance-schedules/${target.schedule_id}/approve`);
      await refreshCurrent();
      setNotice({ type: 'success', text: 'Schedule approved.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };
  const declineSchedule = async (target, payload) => {
    setNotice(null);
    try {
      await api.put(`/maintenance-schedules/${target.schedule_id}/decline`, { decline_reason: payload.decline_reason });
      await refreshCurrent();
      setNotice({ type: 'success', text: 'Schedule declined.' });
      setDeclineScheduleTarget(null);
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

      // Admin owns the maintenance calendar — a Custodian filling in this same
      // form is sending a suggestion, which books nothing.
      if (moduleKey === 'schedules' && !existing && !canDo(user, 'schedule.create') && canDo(user, 'schedule.suggest')) {
        await api.post('/maintenance-schedules/suggest', {
          vehicle_id: payload.vehicle_id,
          maintenance_type: payload.maintenance_type,
          scheduled_date: payload.scheduled_date || undefined,
          notes: payload.notes || undefined,
        });
        await finishFormPageSuccess(moduleKey, existing, 'Suggestion sent to Admin.');
        return true;
      }

      if (moduleKey === 'maintenance' && payload.issue_report_id === '__new_issue__') {
        const { data: newIssue } = await api.post('/issues', {
          vehicle_id: payload.vehicle_id,
          issue_type: payload.new_issue_type,
          issue_description: payload.problem_reason,
          severity_level: 'Medium',
        });
        finalPayload = {
          ...payload,
          issue_report_id: newIssue.issue_report_id,
          new_issue_type: undefined,
          __new_issue_group__: undefined,
        };
      }

      request = moduleRequest(moduleKey, existing, finalPayload);
      const response = await sendPayload(request.method, request.path, finalPayload);

      // Land on the report just filed — with its own [Create Maintenance
      // Ticket] action right there — instead of back on the list, which
      // would make the reporter search for what they just submitted.
      if (moduleKey === 'issues' && !existing && response?.data?.issue_report_id) {
        await refreshCurrent();
        setNotice({ type: 'success', text: request.success });
        navigate(`${roleRoutes[user.role]}/issues/${response.data.issue_report_id}`);
        return true;
      }

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

  // Work Orders still act per sub-issue (a mechanic's own assigned lines) —
  // flatten each ticket's sub_issues into standalone rows so the existing
  // status filters below (which check row.status) keep working unchanged.
  // Verification is now a ticket-level step (one Custodian attestation
  // closes the whole job), so its rows are the tickets themselves —
  // narrowed to this Custodian's own tickets. Once a ticket is approved it
  // graduates out of "Issue Reports" (still a pre-ticket proposal) and into
  // this "My Tickets" queue so the Custodian can trace its progress —
  // Active tickets are included here too, not just the verification stage.
  const rawRows = activeModule === 'ticketWorkOrders'
    ? flattenSubIssueRows(records[activeModule], user.id)
    : activeModule === 'ticketVerifications'
      ? (records[activeModule] ?? []).filter((t) => (
          String(t.assigned_custodian_id) === String(user.id)
          && ['Active', 'For Verification', 'Closed'].includes(t.status)
        ))
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
      // Pending Approval is included so a newly-submitted schedule is
      // visible immediately, not just after clicking its stat card — it
      // needs timely action the same way Scheduled rows do. Click the
      // Declined/Completed/Cancelled stat card to see the rest.
      result = result.filter((row) => row.status === 'Scheduled' || row.status === 'Pending Approval');
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
      // Rows are now tickets, not sub-issues — Active means still being
      // repaired, Pending means waiting at For Verification, Verified means
      // already Closed. No filter selected (Total) shows every one.
      if (filterStatus.includes('Active')) {
        result = result.filter((row) => row.status === 'Active');
      } else if (filterStatus.includes('Verified')) {
        result = result.filter((row) => row.status === 'Closed');
      } else if (filterStatus.includes('Pending')) {
        result = result.filter((row) => row.status === 'For Verification');
      }
    } else if (activeModule === 'vehicles' && (filterStatus.includes('ReadyToRespond') || filterStatus.includes('NotReady'))) {
      // Retired vehicles are excluded from both buckets up in vehicleStats —
      // match that here too, or "Not Ready" would list units the card's own
      // count didn't include.
      result = result.filter((row) => row.readiness_state !== 'retired').filter((row) => (
        filterStatus.includes('ReadyToRespond') ? row.readiness_state === 'ready' : row.readiness_state !== 'ready'
      ));
    } else if (filterStatus.length && activeModule === 'users') {
      // Any role the account holds, not only the primary one.
      result = result.filter((row) => ((Array.isArray(row.roles) && row.roles.length) ? row.roles : [row.role]).some((r) => filterStatus.includes(r)));
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
        // the ticket's one assigned mechanic, not a priority level.
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

    if (activeModule === 'issues' && filterIssueType.length) {
      result = result.filter((row) => filterIssueType.includes(row.issue_type));
    }

    // "Needs a ticket" — reports nobody has turned into a ticket yet.
    // Unresolved reports first; the sort is stable, so the API's newest-first
    // order is kept within each group.
    if (activeModule === 'issues') {
      result = [...result].sort((a, b) => (a.status === 'Resolved') - (b.status === 'Resolved'));
    }

    // Issue Reports only ever shows pre-ticket reports — once a proposal is
    // approved it graduates into "My Tickets" instead (see issueIsPreTicket).
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
      // The verdict now lives per sub-issue, not on the ticket row itself —
      // match a ticket if any of its sub-issues carry the selected verdict.
      // Going forward verifyTicket() only ever writes 'Approved' (the old
      // per-sub-issue reject path is dead), but historical tickets verified
      // under the prior flow may still carry a 'Rejected' verdict.
      result = result.filter((row) => (row.sub_issues ?? []).some((si) => filterVerdict.includes(si.verification_verdict)));
    }

    if (activeModule === 'histories' && filterActivityType.length) {
      result = result.filter((row) => filterActivityType.includes(row.activity_type));
    }

    // Activity Log reuses the same slot as a Module filter.
    if (activeModule === 'logs' && filterActivityType.length) {
      result = result.filter((row) => filterActivityType.includes(row.module));
    }

    // Date range — same two fields, applied to whichever date column is
    // meaningful for the active module.
    if (filterDateStart || filterDateEnd) {
      const dateField = activeModule === 'maintenance' ? 'date_started'
        : activeModule === 'tickets' ? 'created_at'
        : activeModule === 'issues' ? 'created_at'
        : activeModule === 'histories' ? 'created_at'
        : activeModule === 'logs' ? 'created_at'
        : null;
      if (dateField) {
        result = result.filter((row) => {
          const raw = row[dateField];
          if (!raw) return false;
          const parsed = new Date(raw);
          const rowDate = Number.isNaN(parsed.getTime()) ? raw.substring(0, 10) : localDayKey(parsed);
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

    if (activeModule === 'histories') {
      result = newestHistoryFirst(result);
    }

    return result;
  }, [rawRows, searchQuery, filterCategory, filterCapacity, filterLocation, filterDomain, filterStatus, filterPriority, filterReadiness, filterIssueType, filterMaintType, filterSource, filterActive, filterAssignedTo, filterVerdict, filterCheckedBy, filterActivityType, filterVehicle, filterMechanic, filterCustodian, filterDateStart, filterDateEnd, activeModule, condFilterStartDate, condFilterEndDate, archiveStart, archiveEnd, archiveStatusFilter, user.id]);

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

  const issueStats = useMemo(
    () => countByValues(records.issues ?? [], (r) => r.status, ['Pending', 'Under Review', 'In Maintenance', 'Resolved']),
    [records.issues]
  );

  const scheduleStats = useMemo(() => {
    const base = countByValues(records.schedules ?? [], (r) => r.status, ['Pending Approval', 'Declined', 'Scheduled', 'Completed', 'Cancelled']);
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

  const maintenanceRecordStats = useMemo(
    () => countByValues(records.maintenance ?? [], (r) => r.progress_status, ['Assigned', 'Under Repair', 'For Verification', 'Completed']),
    [records.maintenance]
  );


  const inspectionStats = useMemo(() => {
    const rows = records.ticketInspections ?? [];
    const pending = rows.filter((r) => r.status === 'Open').length;
    return { total: rows.length, Pending: pending, Inspected: rows.length - pending };
  }, [records.ticketInspections]);

  const workOrderStats = useMemo(() => {
    const rows = flattenSubIssueRows(records.ticketWorkOrders, user.id);
    const pending = rows.filter((r) => r.status === 'Under Repair').length;
    return { total: rows.length, Pending: pending, Submitted: rows.length - pending };
  }, [records.ticketWorkOrders, user.id]);

  const verificationStats = useMemo(() => {
    // Mirrors rawRows' own scoping above — one row per ticket, restricted to
    // this Custodian's own tickets ("My Tickets": Active through Closed).
    const rows = (records.ticketVerifications ?? []).filter((t) => (
      String(t.assigned_custodian_id) === String(user.id)
      && ['Active', 'For Verification', 'Closed'].includes(t.status)
    ));
    const active = rows.filter((r) => r.status === 'Active').length;
    const pending = rows.filter((r) => r.status === 'For Verification').length;
    const verified = rows.filter((r) => r.status === 'Closed').length;
    return { total: rows.length, Active: active, Pending: pending, Verified: verified };
  }, [records.ticketVerifications, user.id]);

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

  // For the Vehicle Location module, every vehicle shown on the map should also
  // appear in the records list. We merge the saved location records (history)
  // with a synthesized "current" row for each vehicle that has no record yet,
  // so the list always mirrors the map.
  const locationRows = useMemo(() => {
    if (activeModule !== 'locations') {
      return visibleRows;
    }

    const vehiclesWithRecord = new Set(visibleRows.map((row) => row.vehicle_id));
    const query = searchQuery.toLowerCase().trim();

    const syntheticRows = (lookups.vehicles ?? [])
      .filter((vehicle) => !vehiclesWithRecord.has(vehicle.vehicle_id))
      .filter((vehicle) => {
        if (!query) return true;
        return [vehicle.vehicle_name, vehicle.plate_number, vehicle.current_location]
          .some((val) => val && String(val).toLowerCase().includes(query));
      })
      .map((vehicle) => ({
        location_record_id: null,
        vehicle_id: vehicle.vehicle_id,
        vehicle,
        current_location: vehicle.current_location,
        address_area: null,
        updated_by: null,
        updated_at: vehicle.updated_at ?? null,
        is_current_snapshot: true,
      }));

    return [...visibleRows, ...syntheticRows];
  }, [activeModule, visibleRows, lookups.vehicles, searchQuery]);

  // Same reasoning as locationRows above: Condition Monitoring should mirror
  // the whole fleet, not just vehicles that happen to have a check on file.
  // Merge the (already-filtered) check records with a synthesized "Not
  // Checked" row for every vehicle missing one — subject to the same active
  // filters, so a vehicle only appears here when it'd also match a real row.
  const conditionRows = useMemo(() => {
    if (activeModule !== 'conditions') {
      return visibleRows;
    }

    // A synthetic row has no checker or date to filter on, so it only
    // belongs in the merged list when none of those filters are narrowing
    // the results — otherwise "checked by Juan" or a date range would be
    // showing vehicles that were never checked at all.
    if (filterCheckedBy.length || condFilterStartDate || condFilterEndDate) {
      return visibleRows;
    }
    if (filterStatus.length && !filterStatus.includes('Not Checked')) {
      return visibleRows;
    }

    const vehiclesWithRecord = new Set((records.conditions ?? []).map((r) => r.vehicle_id));
    const query = searchQuery.toLowerCase().trim();

    const syntheticRows = (lookups.vehicles ?? [])
      .filter((vehicle) => !vehiclesWithRecord.has(vehicle.vehicle_id))
      .filter((vehicle) => !filterCategory.length || filterCategory.includes(String(vehicle.category_id)))
      .filter((vehicle) => !filterCapacity.length || filterCapacity.includes(vehicle.capacity))
      .filter((vehicle) => {
        if (!query) return true;
        return [vehicle.vehicle_name, vehicle.plate_number].some((val) => val && String(val).toLowerCase().includes(query));
      })
      .map((vehicle) => ({
        condition_check_id: null,
        vehicle_id: vehicle.vehicle_id,
        vehicle,
        condition_result: 'Not Checked',
        checked_by: null,
        observations: null,
        created_at: null,
      }));

    return [...visibleRows, ...syntheticRows];
  }, [activeModule, visibleRows, records.conditions, lookups.vehicles, searchQuery, filterCategory, filterCapacity, filterCheckedBy, filterStatus, condFilterStartDate, condFilterEndDate]);

  const viewVehicleOnMap = useCallback((row) => {
    const vehicleId = row.vehicle_id ?? row.vehicle?.vehicle_id;
    if (!vehicleId) return;
    setSelectedMapVehicleId(vehicleId);
    setLocationsTab('map');
  }, []);

  const locationTableColumns = useMemo(
    () => locationColumns(user, viewVehicleOnMap, (row) => navigate(`${roleRoutes[user.role]}/locations/${row.vehicle_id}/edit`)),
    [user, viewVehicleOnMap, navigate],
  );

  // "All Vehicles" is the pilot table for the Choose Columns toolbar button
  // (show/hide + drag to reorder, persisted per browser) — see
  // ColumnChooserButton/useColumnChooser below.
  const vehicleColumnDefs = useMemo(
    () => vehicleColumns(user, (row) => openVehicleProfile(row, 'edit'), deleteRecord, restoreRecord, filterStatus, openTicketProfile, (row) => setReadinessPromptTarget(row), openVehicleProfile),
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

  const locationColumnChooser = useColumnChooser('vms_location_columns', locationTableColumns);

  const issueColumnDefs = useMemo(
    () => issueColumns(user.role, (row) => navigate(`${roleRoutes[user.role]}/issues/${row.issue_report_id}/edit`), handleCreateTicketFromIssue, setUserInfoTarget, (row) => navigate(`${roleRoutes[user.role]}/issues/${row.issue_report_id}`), deleteRecord, user, openTicketProfile, setDismissIssueTarget),
    [user, navigate, handleCreateTicketFromIssue, deleteRecord, openTicketProfile],
  );
  const issueColumnChooser = useColumnChooser('vms_issue_columns', issueColumnDefs);

  const maintenanceStatusColumnDefs = useMemo(
    () => maintenanceStatusColumns(setEditTarget, user.id),
    [user.id],
  );
  const maintenanceStatusColumnChooser = useColumnChooser('vms_maintenance_status_columns', maintenanceStatusColumnDefs);

  const scheduleColumnDefs = useMemo(
    () => scheduleColumns((row) => navigate(`${roleRoutes[user.role]}/schedules/${row.schedule_id}/edit`), deleteRecord, openCompleteSchedule, user, (row) => navigate(`${roleRoutes[user.role]}/maintenance/${row.resulting_maintenance_id}`), restoreRecord, setReassignScheduleTarget, openTicketProfile, approveSchedule, setDeclineScheduleTarget, records.schedules),
    [navigate, user, deleteRecord, restoreRecord, openTicketProfile, records.schedules],
  );

  const logColumnDefs = useMemo(
    () => logColumns(lookups.vehicles, openVehicleProfile, openTicketProfile),
    [lookups.vehicles, openVehicleProfile, openTicketProfile],
  );
  const logColumnChooser = useColumnChooser('vms_activity_log_columns', logColumnDefs);

  const archiveColumnDefs = useMemo(() => [
    ...ticketArchiveColumns,
    {
      key: 'actions',
      label: 'Actions',
      locked: true,
      className: 'cell-center',
      // Same centered, labelled icon buttons on every row: View whenever the
      // ticket still exists (a Closed one opens read-only), Reopen only for
      // a Deleted one, which has no live ticket left to view.
      render: (row) => (
        <div className="row-actions p23-archive-actions">
          {row.final_status === 'Deleted' ? (
            <button
              className="btn-reopen-action icon-btn"
              type="button"
              title={`Reopen Ticket #${row.ticket_id}`}
              aria-label={`Reopen Ticket #${row.ticket_id}`}
              onClick={() => {
                setConfirmDialog({
                  title: `Reopen Ticket #${row.ticket_id}?`,
                  message: `Reopen deleted Ticket #${row.ticket_id} "${row.ticket_title}" for ${row.vehicle_name}${row.plate_number ? ` (${row.plate_number})` : ''}? It will be restored with all its sub-issues to how they were before it was deleted.`,
                  confirmLabel: `Reopen Ticket #${row.ticket_id}`,
                  variant: 'primary',
                  onConfirm: () => ticketAction(`/ticket-archives/${row.archive_id}/reopen`, {}, 'Ticket successfully reopened.'),
                });
              }}
            >
              <Icon name="undo" size={14} />
            </button>
          ) : (
            <button
              className="btn-view-action icon-btn"
              type="button"
              title={`View Ticket #${row.ticket_id}`}
              aria-label={`View Ticket #${row.ticket_id}`}
              onClick={() => openTicketProfile({ ticket_id: row.ticket_id })}
            >
              <Icon name="eye" size={14} />
            </button>
          )}
        </div>
      ),
    },
  ], [setConfirmDialog, openTicketProfile, ticketAction]);
  const archiveColumnChooser = useColumnChooser('vms_ticket_archive_columns', archiveColumnDefs);

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  const nav = useResponsiveNav(`${activeModule}|${location.pathname}`);
  const topbarRef = useRef(null);
  useCssHeightVar(topbarRef, '--topbar-height');

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
  const [impersonatePick, setImpersonateId] = useState(user?.id ?? '');
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
  // currently selected above — derived each render, so it follows barangay
  // changes and the candidate list's first load without an extra pass.
  const impersonateGroupUsers = impersonateGroups.find((g) => g.key === String(mapBarangayId))?.users ?? [];
  // The barangay/candidate chain resolves over several async calls, so this
  // can be computed against a still-loading (wrong) group before landing on
  // the real one. Falling back to "whoever's first" there would silently pick
  // a coworker instead of yourself — prefer your own account if it's in this
  // group at all, only falling further back to "first" when you genuinely
  // aren't a candidate here.
  const impersonateId = impersonateGroupUsers.some((u) => String(u.id) === String(impersonatePick))
    ? impersonatePick
    : (impersonateGroupUsers.find((u) => String(u.id) === String(user.id))?.id ?? impersonateGroupUsers[0]?.id ?? '');

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
      ? (dashboard?.badge_counts?.ticketVerifications ?? 0)
      : (dashboard?.badge_counts?.[key] ?? 0)
  );

  return (
    <FormNoticeContext.Provider value={notice}>
    <RowActionsContext.Provider value={rowActions}>
      <header className="topbar" ref={topbarRef}>
        <div className="topbar-left">
          <div className="topbar-brand-cluster">
            <button {...nav.toggleButtonProps} className="sidebar-toggle-btn" type="button">
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
          {/* No bell in the top bar — the list opens from the profile
              menu's "Notifications" item. */}
          <div className="notifications-dropdown-container" ref={notificationsRef}>
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
                          } else if (n.issue_report_id) {
                            navigate(`${roleRoutes[user.role]}/issues/${n.issue_report_id}`);
                          } else if (n.vehicle_id) {
                            navigate(`${roleRoutes[user.role]}/vehicles/${n.vehicle_id}`);
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
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={20} />
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

      <main className={nav.workspaceClassName}>
        <SidebarBackdrop nav={nav} />
        <aside {...nav.sidebarProps}>
          <SidebarDrawerHead nav={nav} />
          <nav className="module-nav" aria-label="Workspace modules">
            {moduleGroups.map(({ section, items }) => {
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
                        // 'workTracker' used to also be a plain sidebar row
                        // (Maintenance Personnel's standalone "Work Tracker"
                        // entry) reached via this generic click path — that
                        // row is gone now (folded into 'ticketWorkOrders'
                        // own Archive toggle), so no sidebar button sets
                        // activeModule to 'workTracker' through here anymore.
                        // This branch is kept, harmlessly unreachable, rather
                        // than special-cased away — My Tasks' own "History"
                        // tab still sets 'workTracker' exclusively through
                        // setMyTasksTab (see the tab bar below), which always
                        // keeps workTrackerViaMyTasks true.
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
                    title={nav.isRail ? label : undefined}
                    aria-label={nav.isRail ? (badgeCount > 0 ? `${label}, ${badgeCount} pending` : label) : undefined}
                    aria-current={key === breadcrumbModule ? 'page' : undefined}
                    type="button"
                  >
                    {moduleIcons[key]}
                    <span>{label}</span>
                    {badgeCount > 0 && <span className="module-nav-badge">{badgeCount}</span>}
                  </button>
                );
              };

              // Flat list — no group headings; every item is always visible.
              return <div key={section ?? '__top'} className="module-nav-group">{items.map(renderItem)}</div>;
            })}
          </nav>
        </aside>

        <section id="main-content" className="content-area" tabIndex={-1}>
          {/* Dashboard has its own greeting banner right below (name, role,
              date) — this generic icon+title bar would just repeat "Dashboard"
              redundantly above it, so it's skipped for that one page only. */}
          {(activeModule !== 'dashboard' || isOnSpecialPage) && (activeModule !== 'issues' || isOnSpecialPage) && (
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
                {activeModule === 'vehicles' && !subPageTitle && <p className="page-heading-subtitle">Manage fleet assets and monitor vehicle availability.</p>}
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
          <Suspense fallback={<ModuleLoader />}>
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
          ) : editLocationVehicleId ? (
            <EditLocationPage
              row={locationRows.find((r) => String(r.vehicle_id) === String(editLocationVehicleId)) ?? null}
              allHubs={allHubs}
              boundaryRings={locationBoundaryRings}
              boundaryLabel={locationBoundaryLabel}
              onBack={() => returnToModule('locations')}
              onSubmit={async ({ name, lat, lng, label, addressArea, remarks }) => {
                // Reuse the hub if that name already exists (case-insensitive
                // — hub names are unique per barangay); otherwise this is a
                // brand-new location, so create it first exactly like Add
                // Location does. Either way the vehicle's location update
                // itself always goes through POST /locations, so it's still
                // one more entry in that vehicle's location history, not an
                // edit of a past one.
                const existingHub = allHubs.find((h) => h.name.toLowerCase() === name.toLowerCase());
                if (!existingHub) {
                  await api.post('/hubs', { name, lat, lng, label });
                }
                await api.post('/locations', {
                  vehicle_id: editLocationVehicleId,
                  current_location: existingHub ? existingHub.name : name,
                  address_area: addressArea,
                  remarks,
                });
                setNotice({ type: 'success', text: 'Location updated.' });
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
                  setKeepNotice(true);
                  returnToModule(hasReportOrProposeNav ? 'issues' : 'workTracker');
                }}
                ticketLookups={ticketLookups}
                prefilledTicketData={prefilledTicketData}
                onProposeTicket={proposeTicket}
                onDirty={() => setHasUnsavedChanges(true)}
              />
            ) : (canDo(user, 'ticket.create') || hasRole(user, 'Admin')) ? (
              <NewTicketPage
                onBack={() => { setPrefilledTicketData(null); returnToModule('tickets'); }}
                ticketLookups={ticketLookups}
                prefilledTicketData={prefilledTicketData}
                onCreateTicket={createTicket}
                basePath={roleRoutes[user.role]}
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
              canRequestInspection={canDo(user, 'vehicle.request_inspection')}
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
              knownTickets={records[activeModule]}
              onBack={() => returnToModule('tickets')}
              onDeleteTicket={deleteTicket}
              onRequestConfirmation={setConfirmDialog}
              ticketAction={ticketAction}
            />
          ) : maintenanceProfileId ? (
            <MaintenanceRecordProfilePage
              maintenanceId={maintenanceProfileId}
              canManage={hasRole(user, 'Admin')}
              onConfirm={(r) => updateRecord(`/maintenance-records/${r.maintenance_id}/confirm`, { confirmed: true }, 'Maintenance confirmed.')}
              onReopen={(r) => updateRecord(`/maintenance-records/${r.maintenance_id}/confirm`, { confirmed: false }, 'Maintenance reopened.')}
              onDecisionClose={(r, payload) => updateRecord(`/maintenance-records/${r.maintenance_id}/decision-close`, payload, 'Record closed without verification.')}
              onViewIssue={(issueId) => navigate(`${roleRoutes[user.role]}/issues/${issueId}`)}
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
          ) : viewIssueId ? (
            <>
              <IssueViewPage
                issueId={viewIssueId}
                allIssues={records.issues ?? []}
                allHubs={allHubs}
                user={user}
                onCreateTicketFromIssue={handleCreateTicketFromIssue}
                onDismissIssue={setDismissIssueTarget}
                onRecommendTicket={recommendTicketForIssue}
              />
              {renderDismissIssueModal()}
            </>
          ) : (isNewIssuePage || editIssueId) ? (
            <FormPage
              description={issueDescription(user.role)}
              onBack={() => returnToModule('issues')}
              fields={issueFields(lookups, editIssueId ? { issue_report_id: editIssueId } : null, user.role, (!editIssueId && canRegisterVehicles(user)) ? () => navigate(`${roleRoutes[user.role]}/vehicles/new`, { state: { returnTo: location.pathname } }) : undefined)}
              initialValues={editIssueId
                ? (records.issues ?? []).find((i) => String(i.issue_report_id) === String(editIssueId))
                : (location.state?.prefillVehicleId ? { vehicle_id: location.state.prefillVehicleId } : EMPTY_OBJ)}
              onSubmit={(payload) => submitFormPage('issues', editIssueId ? { issue_report_id: editIssueId } : null, payload)}
              submitLabel={editIssueId ? 'Update Issue' : 'Submit Issue'}
              formTitle={editIssueId ? 'Update report information' : 'Tell us what happened'}
              reviewStep={!editIssueId}
              contextVehicles={lookups.vehicles}
              hubs={allHubs}
              warnEndpoint={editIssueId ? undefined : (vid) => `/vehicles/${vid}/open-issues`}
              warnRender={(rows) => <OpenItemsWarning kind="issue" rows={rows} basePath={roleRoutes[user.role]} />}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : (isNewConditionPage || editConditionId) ? (
            <FormPage
              description="Periodic inspection log — a Custodian's routine check-in on a vehicle's physical condition."
              onBack={() => { setPrefilledConditionVehicleId(null); returnToModule('conditions'); }}
              fields={conditionFields(lookups)}
              initialValues={conditionInitialValues}
              onSubmit={(payload) => submitFormPage('conditions', editConditionId ? { condition_check_id: editConditionId } : null, payload)}
              submitLabel={editConditionId ? 'Update Condition' : 'Record Condition'}
              contextVehicles={lookups.vehicles}
              hubs={allHubs}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : (isNewMaintenancePage || editMaintenanceId) ? (
            <FormPage
              description="Directly log external, historical, or third-party vehicle maintenance records and expenses without running the full ticket workflow."
              onBack={() => returnToModule('maintenance')}
              fields={(vals) => maintenanceFields(lookups, user.role, vals)}
              initialValues={editMaintenanceId ? withPerformedBy(withRepairType((records.maintenance ?? []).find((m) => String(m.maintenance_id) === String(editMaintenanceId)))) : EMPTY_OBJ}
              onSubmit={(payload) => submitFormPage('maintenance', editMaintenanceId ? { maintenance_id: editMaintenanceId } : null, applyPerformedBy(applyRepairType(payload)))}
              submitLabel={editMaintenanceId ? 'Update Maintenance' : 'Add Maintenance'}
              contextVehicles={lookups.vehicles}
              hubs={allHubs}
              reviewStep
              wrapperClassName="maintenance-form-grid"
              formTitle="Maintenance Record Details"
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
              description="Create and manage user accounts — Admin, Custodian, and Maintenance Personnel. New staff sign-ups wait under Pending Registrations until you approve them; deactivating an account blocks sign-in but keeps everything they did attributed to them."
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
              onSubmit={(subIssueRow, payload) => ticketAction(`/tickets/${subIssueRow.ticket_id}/sub-issues/${subIssueRow.sub_issue_id}/log-repairs`, payload, 'Repair logged. Once every repair on this ticket is logged, it goes to the Custodian for verification automatically.').then((ok) => { if (ok) returnToModule('ticketWorkOrders'); return ok; })}
              onExternalSend={(row, payload) => ticketAction(`/tickets/${row.ticket_id}/sub-issues/${row.sub_issue_id}/external-sent`, payload, 'Marked as sent to the shop.')}
              onExternalReturn={(row, payload) => ticketAction(`/tickets/${row.ticket_id}/sub-issues/${row.sub_issue_id}/external-returned`, payload, 'Marked as returned from the shop.')}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : inspectTicketId ? (
            <InspectTicketPage
              ticket={(records.ticketInspections ?? []).find((t) => String(t.ticket_id) === String(inspectTicketId))}
              relatedTickets={(() => {
                const current = (records.ticketInspections ?? []).find((t) => String(t.ticket_id) === String(inspectTicketId));
                if (!current) return [];
                return (records.ticketInspections ?? []).filter((t) => String(t.ticket_id) !== String(current.ticket_id)
                  && String(t.vehicle_id) === String(current.vehicle_id) && t.status !== 'Closed' && !t.archived_at);
              })()}
              ticketLookups={ticketLookups}
              onBack={() => returnToModule('ticketInspections')}
              onSubmit={(ticket, payload) => ticketAction(`/tickets/${ticket.ticket_id}/inspect`, payload, 'Inspection submitted. The Admin has been notified.').then((ok) => { if (ok) returnToModule('ticketInspections'); return ok; })}
              onDirty={() => setHasUnsavedChanges(true)}
            />
          ) : (loading ? <ModuleLoader /> : moduleError ? <ErrorState error={moduleError} onRetry={retryModuleLoad} /> : renderModule())}
          </Suspense>
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
            <div className="schedule-modal-summary" aria-label="Schedule being completed">
              <strong>{completeScheduleTarget.vehicle?.vehicle_name ?? 'Vehicle'}</strong>
              <span>{completeScheduleTarget.vehicle?.plate_number ?? 'No plate number'}</span>
              <span>{formatDate(completeScheduleTarget.scheduled_date)}{completeScheduleTarget.scheduled_time ? ` · ${completeScheduleTarget.scheduled_time}` : ''}</span>
            </div>
            <p className="schedule-modal-guidance">
              This logs a maintenance record for the work and closes the schedule
              {completeScheduleTarget.recurrence_months ? `, then automatically schedules the next one (${(RECURRENCE_LABEL[completeScheduleTarget.recurrence_months] ?? `every ${completeScheduleTarget.recurrence_months} months`).toLowerCase()}, counted from the completion date).` : '.'}
              {' '}The resulting maintenance record remains subject to Custodian verification.
            </p>
            {/* Grouped (audit §12): what was done, who did it — in-house
                vs an outside service provider, whose own fields appear
                directly under that choice — then proof. */}
            <div className="p23-complete-form">
            <SmartForm
              fields={[
                { label: 'Date Completed', name: 'date_completed', type: 'date', group: 'Work done' },
                { label: 'Cost in PHP (optional)', name: 'maintenance_cost', type: 'number', min: 0, placeholder: 'e.g. 1500', group: 'Work done' },
                { label: 'Notes — what was done', name: 'notes', type: 'textarea', rows: 2, fullWidth: true, group: 'Work done' },
                // Sometimes a scheduled job turns out to need a
                // third-party shop instead of in-house work.
                { label: 'Who performed the work?', name: 'is_external', type: 'select', fullWidth: true, group: 'Performed by', options: [
                  { value: 0, label: 'In-house — our maintenance personnel' },
                  { value: 1, label: 'External service provider (outside shop)' },
                ] },
                // Vendor/warranty only matter when it went external.
                ...(completeScheduleExternal ? [
                  { label: 'External Shop Name', name: 'external_vendor', type: 'text', placeholder: 'e.g. Bautista Auto Shop', group: 'Performed by' },
                  { label: 'Warranty Until (optional)', name: 'warranty_until', type: 'date', group: 'Performed by' },
                ] : []),
                {
                  label: 'Receipt / Proof of Completion',
                  name: 'receipt',
                  type: 'file',
                  accept: 'image/*,.pdf',
                  fullWidth: true,
                  group: 'Proof',
                  // Final senior system review (2026-10-05, §2) — only the
                  // assigned Maintenance Personnel can even open this modal
                  // now, and a receipt/photo is evidence only; it never skips
                  // the Custodian check, for anyone.
                  hint: 'Attach a receipt or a photo of the completed repair so the Custodian verifying this has proof.',
                },
              ]}
              key={`complete-${completeScheduleTarget.schedule_id}`}
              initialValues={{ date_completed: new Date().toISOString().slice(0, 10) }}
              onValuesChange={(vals) => setCompleteScheduleExternal(vals.is_external === 1 || vals.is_external === '1' || vals.is_external === true)}
              onCancel={() => setCompleteScheduleTarget(null)}
              onSubmit={(payload) => completeSchedule(completeScheduleTarget, payload)}
              submitLabel="Mark as Done"
              title=""
            />
            </div>
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
          <>
          <div className="schedule-modal-summary" aria-label="Schedule being reassigned">
            <strong>{reassignScheduleTarget.vehicle?.vehicle_name ?? 'Vehicle'} · {reassignScheduleTarget.maintenance_type}</strong>
            <span>Current assignee: {reassignScheduleTarget.assigned_to_user?.name ?? 'Unassigned'}</span>
            <span>Due {formatDate(reassignScheduleTarget.scheduled_date)}</span>
          </div>
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
          </>
        )}
      </FormModal>
    );
  }

  // Admin's "Decline" action on a Pending Approval row (new schedule.decline
  // ability) — mirrors the ticket proposal decline form exactly: one
  // required reason, visible to the Custodian afterward.
  function renderDeclineScheduleModal() {
    return (
      <FormModal open={!!declineScheduleTarget} title={`Decline — ${declineScheduleTarget?.maintenance_type ?? ''}`} onClose={() => setDeclineScheduleTarget(null)}>
        {declineScheduleTarget && (
          <SmartForm
            fields={[{ label: 'Decline Reason', name: 'decline_reason', type: 'textarea', rows: 2, required: true, placeholder: 'Let the Custodian know why this was declined' }]}
            key={`decline-schedule-${declineScheduleTarget.schedule_id}`}
            onCancel={() => setDeclineScheduleTarget(null)}
            onSubmit={(payload) => declineSchedule(declineScheduleTarget, payload)}
            submitLabel="Decline Schedule"
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
          My Tickets
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
          History
        </button>
      </div>
    );

    // Same thin-wrapper approach as My Tasks above — `activeModule` is
    // still literally 'maintenanceStatus'/'maintenance', this only decides
    // whether to also show the tab bar above that unchanged module.
    const showMaintenanceLedgerContainer = hasMaintenanceLedgerNav && (
      activeModule === 'maintenanceStatus' || activeModule === 'maintenance'
    );
    const maintenanceLedgerTabBar = showMaintenanceLedgerContainer && (
      <div className="locations-tab-bar" role="tablist" aria-label="Maintenance Records">
        <button
          type="button"
          role="tab"
          aria-selected={activeModule === 'maintenanceStatus'}
          className={`locations-tab-button ${activeModule === 'maintenanceStatus' ? 'active' : ''}`}
          onClick={() => setMaintenanceLedgerTab('maintenanceStatus')}
        >
          Needs Verification
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeModule === 'maintenance'}
          className={`locations-tab-button ${activeModule === 'maintenance' ? 'active' : ''}`}
          onClick={() => setMaintenanceLedgerTab('maintenance')}
        >
          All Records
        </button>
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
          onGoToSchedules={() => returnToModule('schedules')}
          onGoToModule={returnToModule}
          updatedAt={dashboardUpdatedAt}
          issues={records.issues ?? []}
          verificationTickets={records.ticketVerifications ?? []}
        />
      );
    }

    if (activeModule === 'vehicles') {
      const resetVehicleFilters = () => {
        setFilterCategory([]); setFilterCapacity([]); setFilterStatus([]);
        setFilterPriority([]); setFilterLocation([]); setFilterDomain([]); setFilterReadiness([]);
      };
      const showAllVehicles = () => {
        resetVehicleFilters();
        setFilterStatus(['Available', 'Under Maintenance', 'Inactive', 'Decommissioned']);
      };
      const showNeedsAttention = () => { resetVehicleFilters(); setFilterPriority(['Needs Inspection', 'Needs Repair']); };
      const showUnderMaintenance = () => { resetVehicleFilters(); setFilterStatus(['Under Maintenance']); };
      const showReadyVehicles = () => { resetVehicleFilters(); setFilterReadiness(['Ready']); };
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
              onTotalClick={showAllVehicles}
              gridClassName="fleet-summary-grid"
            />
          }
          filterBar={
            <VehicleFilterPanel
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
              filterLocation={filterLocation}
              setFilterLocation={setFilterLocation}
              filterDomain={filterDomain}
              setFilterDomain={setFilterDomain}
              filterReadiness={filterReadiness}
              setFilterReadiness={setFilterReadiness}
            />
          }
        >
          <div className="fleet-context" role="note" aria-label="How fleet states are determined">
            <Icon name="clipboard" size={16} />
            <p><strong>Three separate checks protect deployment decisions.</strong> Operational status shows availability, condition records physical findings, and response readiness requires a current authorized assessment.</p>
          </div>
          <div className="fleet-quick-filters" aria-label="Quick fleet filters">
            <span>Quick filters</span>
            <button type="button" onClick={showAllVehicles}>All Vehicles</button>
            <button type="button" onClick={showNeedsAttention}>Needs Attention</button>
            <button type="button" onClick={showUnderMaintenance}>Under Maintenance</button>
            <button type="button" onClick={showReadyVehicles}>Ready to Respond</button>
          </div>
          <div className="panel-header-bar schedule-list-toolbar fleet-list-header">
            <div><h3>Fleet Vehicles <span className="count-badge">{visibleRows.length}</span></h3><p className="fleet-list-caption">Select a vehicle to view its full profile, history, and operational records.</p></div>
            <LocalSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search by vehicle name or plate number"
              columnChooser={vehicleColumnChooser}
              onAdd={canRegisterVehicles(user) ? () => navigate(`${roleRoutes[user.role]}/vehicles/new`) : undefined}
              addLabel="Add Vehicle"
              onImport={canDo(user, 'vehicle.import') && canRegisterVehicles(user) ? () => setVehicleImportOpen(true) : undefined}
              onExport={() => exportRowsToCsv('vehicles.csv', VEHICLE_EXPORT_COLUMNS, visibleRows)}
              showActionLabels
            />
          </div>
          <PaginatedTable
            columns={vehicleColumnChooser.visibleColumns}
            rows={visibleRows}
            onRowClick={openVehicleProfile}
            onReorderColumn={vehicleColumnChooser.reorderColumn}
            emptyMessage={(rawRows?.length ?? 0) > 0
              ? 'No vehicles match the current search or filters — clear them to see the whole fleet.'
              : 'No vehicles here yet — click the + button to register one.'}
          />
          {/* Three different questions, often confused — spelled out once. */}
          <details className="column-legend">
            <summary>What do Status, Condition and Ready to Respond mean?</summary>
            <dl>
              <div><dt>Status</dt><dd>Can it be assigned right now? Available, Under Maintenance (in the shop) or Inactive (taken out of service).</dd></div>
              <div><dt>Condition</dt><dd>Its physical state from the latest condition check: Good, Needs Inspection or Needs Repair.</dd></div>
              <div><dt>Ready to Respond</dt><dd>Whether it passed a pre-dispatch readiness check in the last 24 hours. An Available vehicle with no recent check is not verified ready.</dd></div>
            </dl>
          </details>
          <Suspense fallback={null}>
            <VehicleImportModal open={vehicleImportOpen} onClose={() => setVehicleImportOpen(false)} onImported={refreshCurrent} />
          </Suspense>
          <FormModal
            open={!!readinessPromptTarget}
            title={`Readiness Check — ${readinessPromptTarget?.vehicle_name ?? ''}`}
            onClose={() => setReadinessPromptTarget(null)}
          >
            {readinessPromptTarget && (
              <Suspense fallback={null}>
                  <ReadinessCheckForm
                  vehicle={readinessPromptTarget}
                  onCancel={() => setReadinessPromptTarget(null)}
                  onSubmit={(payload) => submitReadinessFromPrompt(readinessPromptTarget.vehicle_id, payload)}
                />
              </Suspense>
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
          <DataTable columns={categoryColumnChooser.visibleColumns} onReorderColumn={categoryColumnChooser.reorderColumn} rows={visibleRows} emptyMessage={(searchQuery || filterDomain.length) ? 'No vehicle types match the current search or domain filter.' : 'No vehicle types yet — click the + button to add one.'} />
        </ModulePanel>
      );
    }

    if (activeModule === 'users') {
      const pendingRegistrations = (records.users ?? []).filter(isPendingRegistration);
      const accountRows = visibleRows.filter((row) => !isPendingRegistration(row));
      const usersFiltered = hasActiveScope({ search: searchQuery, filters: [{ values: filterStatus }, { values: filterActive }] });
      const usersEmpty = (inline) => (
        <ScopedEmptyState
          inline={inline}
          filtered={usersFiltered}
          emptyText="No user accounts yet — use Add User to create one."
          filteredText="No user accounts match these filters."
          onClear={() => { setFilterStatus([]); setFilterActive([]); setSearchQuery(''); }}
        />
      );
      return (
        <ModulePanel
          description="Create and manage user accounts — Admin, Custodian, and Maintenance Personnel. New staff sign-ups wait under Pending Registrations until you approve them; deactivating an account blocks sign-in but keeps everything they did attributed to them."
          statCards={
            <div className="user-summary-metrics" aria-label="User account summary">
              <div><span>Total Staff</span><strong>{accountRows.length}</strong></div>
              <div><span>Active Users</span><strong>{accountRows.filter((row) => row.is_active).length}</strong></div>
              <div><span>Pending Registrations</span><strong>{pendingRegistrations.length}</strong></div>
            </div>
            /*
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
            </div> */
          }
          filterBar={
            <div className="user-management-toolbar">
              <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search by name or email..." onAdd={() => navigate(`${roleRoutes[user.role]}/users/new`)} addLabel="Add User" onExport={() => exportRowsToCsv('users.csv', USER_EXPORT_COLUMNS, accountRows)} showActionLabels />
              <UserFilterChips statusOptions={['Active', 'Inactive']} selectedStatus={filterActive} onStatusChange={setFilterActive} roleOptions={['Admin', 'Custodian', 'Maintenance Personnel']} selectedRoles={filterStatus} onRolesChange={setFilterStatus} />
            </div>
          }
        >
          {hasRole(user, 'Admin') && (
            <details className="user-registration-settings">
              <summary>Staff Registration Settings</summary>
              <div>
                <strong style={{ display: 'block', fontSize: '0.8rem' }}>Staff Registration Code</strong>
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  Share this with real staff — they need it to register. Regenerating it locks out anyone who only has the old one.
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <code style={{ fontSize: '0.95rem', fontWeight: 700, padding: '6px 12px', background: 'var(--surface-2, #f8fafc)', borderRadius: 6 }}>
                  {registrationCode ? (registrationCodeVisible ? registrationCode : '••••••••') : 'Loading…'}
                </code>
                <button className="ghost-button" type="button" onClick={() => setRegistrationCodeVisible((visible) => !visible)} disabled={!registrationCode}>{registrationCodeVisible ? 'Hide' : 'Reveal'}</button>
                <button className="ghost-button" type="button" onClick={() => registrationCode && navigator.clipboard?.writeText(registrationCode)} disabled={!registrationCode}>Copy</button>
                <button className="ghost-button" type="button" onClick={regenerateRegistrationCode}>Regenerate</button>
              </div>
            </details>
          )}
          <div className="view-tabs p23-tabs p23-users-tabs" role="group" aria-label="User accounts">
            <button type="button" aria-pressed={usersTab === 'accounts'} className={usersTab === 'accounts' ? 'active' : ''} onClick={() => setUsersTab('accounts')}>
              User Accounts <span className="count-badge">{(records.users ?? []).filter((u) => !isPendingRegistration(u)).length}</span>
            </button>
            <button type="button" aria-pressed={usersTab === 'pending'} className={`${usersTab === 'pending' ? 'active' : ''}${pendingRegistrations.length ? ' p23-has-pending' : ''}`} onClick={() => setUsersTab('pending')}>
              Pending Registrations <span className="count-badge">{pendingRegistrations.length}</span>
            </button>
          </div>
          {usersTab === 'pending' ? (
            <PendingRegistrations rows={pendingRegistrations} onReview={(row) => toggleUserActive(row, true)} />
          ) : (
          <>
          <div className="view-tabs p23-tabs user-layout-switch" role="group" aria-label="Layout">
            <button type="button" aria-pressed={usersViewMode === 'list'} className={usersViewMode === 'list' ? 'active' : ''} onClick={() => setUsersViewMode('list')}>List View</button>
            <button type="button" aria-pressed={usersViewMode === 'card'} className={usersViewMode === 'card' ? 'active' : ''} onClick={() => setUsersViewMode('card')}>Card View</button>
          </div>
          {usersViewMode === 'card' ? (
            <PaginatedCardGrid
              items={accountRows}
              keyOf={(row) => row.id}
              emptyMessage={usersEmpty(true)}
              renderItem={(row) => (
                <UserCard user={row} onClick={() => navigate(`${roleRoutes[user.role]}/users/${row.id}/edit`)} />
              )}
            />
          ) : (
            <PaginatedTable
              columns={userColumnChooser.visibleColumns}
              onReorderColumn={userColumnChooser.reorderColumn}
              emptyMessage={usersEmpty(true)}
              rows={accountRows}
            />
          )}
          </>
          )}
        </ModulePanel>
      );
    }

    if (activeModule === 'locations') {
      return (
        <>
          <ModulePanel description="Record current vehicle stationing and keep a location history.">
            <div className="locations-tab-bar">
              <button
                type="button"
                aria-pressed={locationsTab === 'map'}
                className={`locations-tab-button ${locationsTab === 'map' ? 'active' : ''}`}
                onClick={() => setLocationsTab('map')}
              >
                <Icon name="map" size={16} />
                Vehicles Map
              </button>
              <button
                type="button"
                aria-pressed={locationsTab === 'records'}
                className={`locations-tab-button ${locationsTab === 'records' ? 'active' : ''}`}
                onClick={() => setLocationsTab('records')}
              >
                <Icon name="document" size={16} />
                Vehicle Location Record
              </button>
            </div>

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

            {locationsTab === 'records' && (
              <div className="location-records-workspace">
                <div className="location-records-toolbar">
                  <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search vehicle name or plate number..." onAdd={hasRole(user, 'Admin') ? () => navigate(`${roleRoutes[user.role]}/locations/new`) : undefined} addLabel="Add Location" />
                  <div className="filter-date-group">
                    <span>Status</span>
                    <MultiSelectDropdown
                      placeholder="All Statuses"
                      options={lookups.vehicle_statuses ?? []}
                      selected={filterStatus}
                      onChange={setFilterStatus}
                    />
                  </div>
                  <div className="filter-date-group">
                    <span>Location</span>
                    <MultiSelectDropdown
                      placeholder="All Locations"
                      options={[...new Set((lookups.vehicles ?? []).map((v) => v.current_location).filter(Boolean))]}
                      selected={filterLocation}
                      onChange={setFilterLocation}
                    />
                  </div>
                </div>
                <div className="panel-header-bar location-records-legacy-header" aria-hidden="true">
                  <h3>Location Records <span className="count-badge">{locationRows.length}</span></h3>
                  <LocalSearchInput
                    value={searchQuery}
                    onChange={setSearchQuery}
                    placeholder="Search records..."
                    // A vehicle's current location is already set from the
                    // Add/Edit Vehicle form (its Current Location field is a
                    // creatable-select, so it can introduce a new hub name
                    // too). What THIS tab had no way to do was define a new
                    // hub's actual map position — "Add Location" is its own
                    // page (fields + a live map, either one fills the
                    // other) instead of a click-the-map-first flow.
                    onAdd={hasRole(user, 'Admin') ? () => navigate(`${roleRoutes[user.role]}/locations/new`) : undefined}
                    addLabel="Add Location"
                    columnChooser={locationColumnChooser}
                  />
                </div>
                <div className="location-table-region">
                  <PaginatedTable
                    columns={locationColumnChooser.visibleColumns}
                    onReorderColumn={locationColumnChooser.reorderColumn}
                    rows={locationRows}
                    onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
                    emptyMessage={(searchQuery || filterStatus.length || filterLocation.length)
                      ? 'No location records match the current search or filters — clear them to see every vehicle.'
                      : 'No location records yet.'}
                  />
                </div>
              </div>
            )}
          </ModulePanel>
        </>
      );
    }

    if (activeModule === 'conditions') {
      const compareConditionRecords = (a, b) => {
        const dateDiff = new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        return dateDiff || Number(b.condition_check_id || 0) - Number(a.condition_check_id || 0);
      };
      const latestByVehicle = new Map();
      [...(records.conditions ?? [])].sort(compareConditionRecords).forEach((row) => {
        if (!latestByVehicle.has(String(row.vehicle_id))) latestByVehicle.set(String(row.vehicle_id), row);
      });
      const fleetOverview = (lookups.vehicles ?? []).map((vehicle) => latestByVehicle.get(String(vehicle.vehicle_id)) ?? ({
        condition_check_id: null,
        vehicle_id: vehicle.vehicle_id,
        vehicle,
        condition_result: 'Not Checked',
        checked_by: null,
        observations: null,
        created_at: null,
      }));
      const matchesConditionScope = (row) => {
        if (filterCategory.length && !filterCategory.includes(String(row.vehicle?.category_id))) return false;
        if (filterCapacity.length && !filterCapacity.includes(row.vehicle?.capacity)) return false;
        if (filterStatus.length && !filterStatus.includes(row.condition_result)) return false;
        if (filterCheckedBy.length && !filterCheckedBy.includes(row.checked_by?.name)) return false;
        const date = row.created_at?.substring(0, 10) ?? '';
        if (condFilterStartDate && (!date || date < condFilterStartDate)) return false;
        if (condFilterEndDate && (!date || date > condFilterEndDate)) return false;
        const query = searchQuery.trim().toLowerCase();
        if (query && ![row.vehicle?.vehicle_name, row.vehicle?.plate_number, row.condition_result, row.checked_by?.name, row.condition_check_id]
          .some((value) => String(value ?? '').toLowerCase().includes(query))) return false;
        return true;
      };
      const overviewRows = fleetOverview.filter(matchesConditionScope);
      const historyRows = conditionRows.filter((row) => row.condition_check_id);
      const displayedConditionRows = conditionView === 'overview' ? overviewRows : historyRows;
      const overviewCounts = fleetOverview.reduce((counts, row) => ({ ...counts, [row.condition_result]: (counts[row.condition_result] ?? 0) + 1 }), {});
      const activeConditionFilterCount = filterCategory.length + filterCapacity.length + filterCheckedBy.length
        + Number(Boolean(condFilterStartDate)) + Number(Boolean(condFilterEndDate));
      const clearConditionFilters = () => {
        setFilterCategory([]); setFilterStatus([]); setFilterCapacity([]); setFilterCheckedBy([]);
        setCondFilterStartDate(''); setCondFilterEndDate(''); setSearchQuery('');
        setCondDraft({ category: [], status: [], capacity: [], checkedBy: [], start: '', end: '' });
      };
      const conditionColumnsSimple = [
        {
          key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => (
            <span className="p24-maint-primary-cell"><strong>{row.vehicle?.vehicle_name ?? 'Vehicle not recorded'}</strong><span>{row.vehicle?.plate_number ?? 'No plate number'}</span></span>
          ),
        },
        { key: 'condition', label: 'Latest Condition', className: 'cell-center', render: (row) => <ConditionResultBadge value={row.condition_result} /> },
        { key: 'date', label: 'Last Checked', className: 'cell-center', render: (row) => row.created_at ? <DateBadge value={row.created_at} /> : <span className="muted">No check recorded</span> },
        ...(conditionView === 'history' ? [{ key: 'checked', label: 'Checked By', render: (row) => row.checked_by?.name ?? <span className="muted">Not recorded</span> }] : []),
        {
          key: 'action', label: '', locked: true, className: 'cell-center', render: (row) => (
            <button className="p24-view-link" type="button" onClick={(event) => { event.stopPropagation(); setConditionDetailTarget(row); }}>
              {row.condition_check_id ? 'View details' : 'View vehicle'} <Icon name="chevronRight" size={14} />
            </button>
          ),
        },
      ];

      return (
        <>
        <ModulePanel>
          <header className="p24-condition-header">
            <div><p className="p24-maint-eyebrow">Fleet oversight</p><h2>Vehicle Condition Monitoring</h2><p>Review vehicle checks and identify maintenance concerns.</p></div>
            {canDo(user, 'condition.create') && <button className="primary-button" type="button" onClick={() => { setPrefilledConditionVehicleId(null); navigate(`${roleRoutes[user.role]}/conditions/new`); }}><Icon name="plus" size={16} /> Add Condition Check</button>}
          </header>

          <section className="p24-condition-metrics" aria-label="Latest vehicle condition summary">
            {[
              ['Vehicles Reviewed', fleetOverview.length - (overviewCounts['Not Checked'] ?? 0), [], 'neutral'],
              ['Good', overviewCounts.Good ?? 0, ['Good'], 'success'],
              ['Needs Inspection', overviewCounts['Needs Inspection'] ?? 0, ['Needs Inspection'], 'warning'],
              ['Needs Repair', overviewCounts['Needs Repair'] ?? 0, ['Needs Repair'], 'danger'],
            ].map(([label, count, value, tone]) => <button key={label} type="button" className={`p24-condition-metric tone-${tone}${JSON.stringify(filterStatus) === JSON.stringify(value) ? ' is-active' : ''}`} onClick={() => setFilterStatus(value)}><span>{label}</span><strong>{count}</strong></button>)}
          </section>

          <ConditionMonitoringIntro />

          <div className="p24-condition-view-tabs" role="tablist" aria-label="Condition records view">
            <button type="button" role="tab" aria-selected={conditionView === 'overview'} className={conditionView === 'overview' ? 'is-active' : ''} onClick={() => setConditionView('overview')}>Latest Vehicle Conditions</button>
            <button type="button" role="tab" aria-selected={conditionView === 'history'} className={conditionView === 'history' ? 'is-active' : ''} onClick={() => setConditionView('history')}>All Condition History <span>{records.conditions?.length ?? 0}</span></button>
          </div>

          <div className="p24-condition-toolbar">
            <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search by vehicle, plate number, or condition..." />
            <button className={`ghost-button p24-filter-toggle${showConditionFilters ? ' is-active' : ''}`} type="button" aria-expanded={showConditionFilters} onClick={() => setShowConditionFilters((value) => !value)}><Icon name="filter" size={16} /> Filters{activeConditionFilterCount ? ` (${activeConditionFilterCount})` : ''}</button>
            {(filterCategory.length || filterStatus.length || filterCapacity.length || filterCheckedBy.length || condFilterStartDate || condFilterEndDate || searchQuery) && <button className="ghost-button" type="button" onClick={clearConditionFilters}>Reset</button>}
          </div>

          <div className="p24-maint-tabs" role="tablist" aria-label="Filter by condition">
            {[['All', []], ['Good', ['Good']], ['Needs Inspection', ['Needs Inspection']], ['Needs Repair', ['Needs Repair']], ['Not Checked', ['Not Checked']]].map(([label, value]) => (
              <button key={label} type="button" role="tab" aria-selected={JSON.stringify(filterStatus) === JSON.stringify(value)} className={JSON.stringify(filterStatus) === JSON.stringify(value) ? 'is-active' : ''} onClick={() => setFilterStatus(value)}>{label}</button>
            ))}
          </div>

          {showConditionFilters && (
            <div className="p24-condition-advanced">
              <div className="p24-maint-advanced-head"><h3>More filters</h3><p>Narrow checks by vehicle details, inspector, or date.</p></div>
            <div className="filter-bar-container">
              <div className="filter-date-group">
                <span>Category</span>
                <MultiSelectDropdown
                  placeholder="All Categories"
                  options={(lookups.categories ?? []).map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
                  selected={condDraft.category}
                  onChange={(vals) => setCondDraft((d) => ({ ...d, category: vals }))}
                />
              </div>

              <div className="filter-date-group">
                <span>Capacity</span>
                <MultiSelectDropdown
                  placeholder="All Capacities"
                  options={[...new Set((lookups.vehicles ?? []).map((v) => v.capacity).filter(Boolean))]}
                  selected={condDraft.capacity}
                  onChange={(vals) => setCondDraft((d) => ({ ...d, capacity: vals }))}
                />
              </div>

              <div className="filter-date-group">
                <span>Checked By</span>
                <MultiSelectDropdown
                  placeholder="All Checked By"
                  options={[...new Set((records.conditions ?? []).map((r) => r.checked_by?.name).filter(Boolean))]}
                  selected={condDraft.checkedBy}
                  onChange={(vals) => setCondDraft((d) => ({ ...d, checkedBy: vals }))}
                />
              </div>

              <div className="filter-date-group">
                <span>From Date</span>
                <DateFilterInput
                  value={condDraft.start || '2026-01-01'}
                  onChange={(val) => setCondDraft((d) => ({ ...d, start: val }))}
                />
              </div>

              <div className="filter-date-group">
                <span>To Date</span>
                <DateFilterInput
                  value={condDraft.end || '2026-12-31'}
                  onChange={(val) => setCondDraft((d) => ({ ...d, end: val }))}
                />
              </div>

              <button
                type="button"
                className="filter-apply-btn"
                disabled={
                  sameSelection(condDraft.category, filterCategory)
                  && sameSelection(condDraft.capacity, filterCapacity)
                  && sameSelection(condDraft.checkedBy, filterCheckedBy)
                  && condDraft.start === condFilterStartDate
                  && condDraft.end === condFilterEndDate
                }
                onClick={() => {
                  setFilterCategory(condDraft.category);
                  setFilterCapacity(condDraft.capacity);
                  setFilterCheckedBy(condDraft.checkedBy);
                  setCondFilterStartDate(condDraft.start);
                  setCondFilterEndDate(condDraft.end);
                }}
              >
                Filter
              </button>
            </div>
            </div>
          )}

            <div className="p24-maint-results-head"><h3>{conditionView === 'overview' ? 'Latest Vehicle Conditions' : 'Condition History'}</h3><span>{displayedConditionRows.length} shown</span></div>
            <div className="p24-condition-table">
            <PaginatedTable
              columns={conditionColumnsSimple}
              emptyMessage={(filterCategory.length || filterStatus.length || filterCapacity.length || filterCheckedBy.length || condFilterStartDate || condFilterEndDate || searchQuery)
                ? (
                  <ConditionFilteredEmpty
                    results={filterStatus}
                    search={searchQuery}
                    onClear={() => {
                      setFilterCategory([]);
                      setFilterStatus([]);
                      setFilterCapacity([]);
                      setFilterCheckedBy([]);
                      setCondFilterStartDate('');
                      setCondFilterEndDate('');
                      setCondDraft({ category: [], status: [], capacity: [], checkedBy: [], start: '', end: '' });
                      setSearchQuery('');
                    }}
                  />
                )
                : 'No condition checks logged yet — click the + button to record one.'}
              rows={displayedConditionRows}
              onRowClick={(row) => setConditionDetailTarget(row)}
            />
            </div>
        </ModulePanel>
        <FormModal open={!!conditionDetailTarget} title={conditionDetailTarget?.condition_check_id ? `Condition Check #${conditionDetailTarget.condition_check_id}` : 'Vehicle Condition'} onClose={() => setConditionDetailTarget(null)}>
          {conditionDetailTarget && (
            <div className="p24-condition-detail">
              <div className="p24-condition-detail-vehicle"><div><span>Vehicle</span><strong>{conditionDetailTarget.vehicle?.vehicle_name ?? 'Vehicle not recorded'}</strong><small>{conditionDetailTarget.vehicle?.plate_number ?? 'No plate number'}</small></div><ConditionResultBadge value={conditionDetailTarget.condition_result} /></div>
              {conditionDetailTarget.condition_check_id ? <>
                <dl><div><dt>Checked by</dt><dd>{conditionDetailTarget.checked_by?.name ?? 'Not recorded'}</dd></div><div><dt>Date and time</dt><dd>{formatDate(conditionDetailTarget.created_at)} · {formatTime(conditionDetailTarget.created_at)}</dd></div></dl>
                <section><h3>Inspector Observations</h3><p>{conditionDetailTarget.observations || 'No observations recorded.'}</p></section>
                {conditionDetailTarget.resulting_ticket && <section><h3>Related Maintenance Ticket</h3><ConditionTicketCell row={conditionDetailTarget} onViewTicket={openTicketProfile} /></section>}
                <div className="p24-condition-detail-actions">
                  {canDo(user, 'ticket.create') && conditionDetailTarget.condition_result !== 'Good' && !conditionDetailTarget.resulting_ticket && <button className="primary-button" type="button" onClick={() => { setConditionDetailTarget(null); handleCreateTicketFromCondition(conditionDetailTarget); }}>Create Ticket</button>}
                  {canDo(user, 'ticket.propose') && conditionDetailTarget.condition_result !== 'Good' && !conditionDetailTarget.resulting_ticket && <button className="primary-button" type="button" onClick={() => { setConditionDetailTarget(null); handleCreateTicketFromCondition(conditionDetailTarget); }}>Propose Ticket</button>}
                  {canDo(user, 'schedule.suggest') && <button className="ghost-button" type="button" onClick={() => { setConditionDetailTarget(null); handleSuggestScheduleFromCondition(conditionDetailTarget); }}>Suggest Schedule</button>}
                  {canDo(user, 'condition.edit') && String(conditionDetailTarget.checked_by?.id) === String(user.id) && <button className="ghost-button" type="button" onClick={() => navigate(`${roleRoutes[user.role]}/conditions/${conditionDetailTarget.condition_check_id}/edit`)}>Edit Check</button>}
                </div>
              </> : <div className="p24-condition-unchecked"><p>No condition check has been recorded for this vehicle.</p>{canDo(user, 'condition.create') && <button className="primary-button" type="button" onClick={() => { setPrefilledConditionVehicleId(conditionDetailTarget.vehicle_id); navigate(`${roleRoutes[user.role]}/conditions/new`); }}>Record Condition</button>}</div>}
              <p className="p24-condition-readiness-note"><Icon name="info" size={14} /> Condition checks describe physical condition. Readiness for emergency deployment is assessed separately.</p>
            </div>
          )}
        </FormModal>
        </>
      );
    }

    // Issue Reports list — Admin, Custodian ('reportOrPropose' in their
    // sidebar), and Maintenance Personnel ('issues') all land here. Its
    // header carries a "Report Vehicle/Technical Issue" action (issue.create)
    // and, for whoever holds ticket.propose, a "Propose Ticket" action.
    if (activeModule === 'issues') {
      if (hasRole(user, 'Custodian') && !hasVehicles) {
        return (
          <ModulePanel description={issueDescription(user.role)}>
            <div className="empty-prereq">
              <h3>No vehicles registered yet</h3>
              <p>Vehicle issue reporting starts after at least one vehicle has been added to the system.</p>
            </div>
          </ModulePanel>
        );
      }

      return (
        <ModulePanel description={null}>
          <header className="issue-page-header">
            <div><h2>Vehicle Issue Reports</h2><p>Report problems and track their progress.</p></div>
            <div className="issue-header-actions">
              {canDo(user, 'issue.create') && <button className="primary-button" type="button" onClick={() => navigate(`${roleRoutes[user.role]}/issues/new`)}><Icon name="add" size={15} /> Report an Issue</button>}
              {canDo(user, 'ticket.propose') && <button className="ghost-button" type="button" onClick={() => { setPrefilledTicketData(null); navigate(`${roleRoutes[user.role]}/tickets/new`); }}><Icon name="ticket" size={15} /> Propose Repair Work</button>}
            </div>
          </header>
          {canDo(user, 'ticket.propose') && <p className="issue-action-help"><Icon name="info" size={14} /> Reporting records a problem. Proposing repair work creates a maintenance request that still needs Admin approval.</p>}
          <section className="issue-compact-metrics" aria-label="Issue report summary">
            <button type="button" className={!filterStatus.length ? 'is-active' : ''} onClick={() => setFilterStatus([])}><span>Total Reports</span><strong>{issueStats.total}</strong></button>
            <button type="button" className={sameSelection(filterStatus, ['Pending', 'Under Review']) ? 'is-active' : ''} onClick={() => setFilterStatus(['Pending', 'Under Review'])}><span>Awaiting Action</span><strong>{(issueStats.Pending ?? 0) + (issueStats['Under Review'] ?? 0)}</strong><small>Waiting or being reviewed</small></button>
            <button type="button" className={sameSelection(filterStatus, ['Resolved']) ? 'is-active' : ''} onClick={() => setFilterStatus(['Resolved'])}><span>Resolved</span><strong>{issueStats.Resolved ?? 0}</strong></button>
          </section>
          <section className="issue-list-section">
            <div className="issue-list-heading"><h3>My Issue Reports</h3><p>{visibleRows.length} report{visibleRows.length === 1 ? '' : 's'} shown</p></div>
            <div className="issue-toolbar">
              <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search issue, vehicle, or plate..." />
              <button className="ghost-button issue-filter-toggle" type="button" onClick={() => setShowIssueFilters((open) => !open)} aria-expanded={showIssueFilters} aria-controls="issue-advanced-filters"><Icon name="filter" size={15} /> Advanced Filters</button>
            </div>
            {showIssueFilters && <div id="issue-advanced-filters" className="issue-advanced-filters"><IssueFilterPanel
              categories={lookups.categories} vehicles={lookups.vehicles} issueTypes={lookups.issue_types ?? []} severityLevels={lookups.severity_levels ?? []} statusOptions={lookups.issue_statuses ?? []}
              filterCategory={filterCategory} setFilterCategory={setFilterCategory} filterCapacity={filterCapacity} setFilterCapacity={setFilterCapacity}
              filterIssueType={filterIssueType} setFilterIssueType={setFilterIssueType} filterStatus={filterStatus} setFilterStatus={setFilterStatus}
              filterPriority={filterPriority} setFilterPriority={setFilterPriority} filterDateStart={filterDateStart} setFilterDateStart={setFilterDateStart}
              filterDateEnd={filterDateEnd} setFilterDateEnd={setFilterDateEnd}
            /></div>}
          {renderDismissIssueModal()}
          <div className="issue-report-table"><PaginatedTable
            columns={issueColumnChooser.visibleColumns}
            onReorderColumn={issueColumnChooser.reorderColumn}
            emptyMessage={(filterCategory.length || filterCapacity.length || filterIssueType.length || filterStatus.length || filterPriority.length || filterDateStart || filterDateEnd || searchQuery)
              ? (
                <IssueFilteredEmpty
                  severity={filterPriority}
                  statuses={filterStatus}
                  search={searchQuery}
                  onClear={() => {
                    setFilterCategory([]);
                    setFilterCapacity([]);
                    setFilterIssueType([]);
                    setFilterStatus([]);
                    setFilterPriority([]);
                    setFilterDateStart('');
                    setFilterDateEnd('');
                    setSearchQuery('');
                  }}
                />
              )
              : 'No issue reports waiting — every reported problem already has an approved ticket or has been closed.'}
            rows={visibleRows}
            onRowClick={(row) => navigate(`${roleRoutes[user.role]}/issues/${row.issue_report_id}`)}
          /></div>
          </section>
        </ModulePanel>
      );
    }

    if (activeModule === 'maintenance') {
      // Says which situation it is: nothing logged at all, nothing at the
      // one progress stage picked from the stat cards, or filters/search
      // hiding everything. (There's no + button here — records come from
      // closed tickets and completed schedules.)
      const maintenanceEmptyMessage = (rawRows?.length ?? 0) === 0
        ? 'No maintenance records yet — they are created when tickets are closed or schedules are marked done.'
        : filterStatus.length === 1
          ? `No records are at "${filterStatus[0]}" with the current search and filters.`
          : 'No maintenance records match the current search or filters — clear them to see every record.';
      const statusLabel = (status) => ({
        'For Verification': 'Needs Verification',
        'Under Repair': 'Repair in Progress',
      }[status] ?? status ?? 'Not recorded');
      const statusTone = (status) => ({
        Assigned: 'neutral',
        'Under Repair': 'info',
        'For Verification': 'warning',
        Completed: 'success',
      }[status] ?? 'neutral');
      const recordPath = (row) => `${roleRoutes[user.role]}/maintenance/${row.maintenance_id}`;
      const actionableRecords = (records.maintenance ?? []).filter((row) => (
        (canDo(user, 'record.verify')
          && row.progress_status === 'For Verification'
          && String(row.maintenance_personnel_id) !== String(user.id))
        || (canDo(user, 'record.confirm')
          && row.verification_result === 'Passed'
          && row.progress_status !== 'Completed')
      ));
      const advancedFilterCount = filterCategory.length + filterCapacity.length + filterPriority.length
        + filterMaintType.length + filterSource.length + Number(Boolean(filterDateStart)) + Number(Boolean(filterDateEnd));
      const simpleColumns = [
        {
          key: 'maintenance', label: 'Maintenance', locked: true, render: (row) => (
            <span className="p24-maint-primary-cell">
              <strong>{row.maintenance_type || 'Maintenance work'}</strong>
              <span>Record #{row.maintenance_id}</span>
            </span>
          ),
        },
        {
          key: 'vehicle', label: 'Vehicle', render: (row) => (
            <span className="p24-maint-primary-cell">
              <strong>{row.vehicle?.vehicle_name ?? 'Vehicle not recorded'}</strong>
              {row.vehicle?.plate_number && <span>{row.vehicle.plate_number}</span>}
            </span>
          ),
        },
        { key: 'status', label: 'Current Status', className: 'cell-center', render: (row) => <span className={`p24-maint-status tone-${statusTone(row.progress_status)}`}>{statusLabel(row.progress_status)}</span> },
        {
          key: 'date', label: 'Relevant Date', className: 'cell-center', render: (row) => (
            <span className="p24-maint-date">
              <DateBadge value={row.date_completed || row.date_started} />
              <small>{row.date_completed ? 'Completed' : 'Started'}</small>
            </span>
          ),
        },
        {
          key: 'action', label: '', locked: true, className: 'cell-center', render: (row) => (
            <button className="p24-view-link" type="button" onClick={(event) => { event.stopPropagation(); navigate(recordPath(row)); }}>
              View details <Icon name="chevronRight" size={14} />
            </button>
          ),
        },
      ];
      return (
        <>
        <ModulePanel tabBar={maintenanceLedgerTabBar}>
          <header className="p24-maint-header">
            <div>
              <p className="p24-maint-eyebrow">Vehicle operations</p>
              <h2>Maintenance Records</h2>
              <p>Find completed work, review records needing attention, and open full repair details.</p>
            </div>
          </header>

          <section className="p24-maint-metrics" aria-label="Maintenance record summary">
            {[
              ['All Records', maintenanceRecordStats.total, []],
              ['Needs Verification', maintenanceRecordStats['For Verification'] ?? 0, ['For Verification']],
              ['Completed', maintenanceRecordStats.Completed ?? 0, ['Completed']],
            ].map(([label, count, value]) => (
              <button key={label} type="button" className={`p24-maint-metric${JSON.stringify(filterStatus) === JSON.stringify(value) ? ' is-active' : ''}`} onClick={() => setFilterStatus(value)}>
                <span>{label}</span><strong>{count}</strong>
              </button>
            ))}
          </section>

          {actionableRecords.length > 0 && (
            <section className="p24-maint-actions" aria-labelledby="maintenance-actions-title">
              <div className="p24-maint-actions-copy">
                <span className="p24-maint-action-icon"><Icon name="alert" size={18} /></span>
                <div><h3 id="maintenance-actions-title">Action Required</h3><p>{actionableRecords.length} {actionableRecords.length === 1 ? 'record needs' : 'records need'} your attention.</p></div>
              </div>
              <div className="p24-maint-action-items">
                {actionableRecords.slice(0, 3).map((row) => (
                  <button key={row.maintenance_id} type="button" onClick={() => {
                    if (canDo(user, 'record.verify') && row.progress_status === 'For Verification') setEditTarget({ ...row, __verify: true });
                    else navigate(recordPath(row));
                  }}>
                    <span><strong>{row.maintenance_type}</strong><small>{row.vehicle?.vehicle_name ?? `Record #${row.maintenance_id}`}</small></span>
                    <span>{canDo(user, 'record.verify') && row.progress_status === 'For Verification' ? 'Review' : 'Confirm'} <Icon name="chevronRight" size={14} /></span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="p24-maint-toolbar">
            <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search by maintenance, vehicle, or record ID..." />
            <button className={`ghost-button p24-filter-toggle${showMaintenanceFilters ? ' is-active' : ''}`} type="button" aria-expanded={showMaintenanceFilters} onClick={() => setShowMaintenanceFilters((value) => !value)}>
              <Icon name="filter" size={16} /> Filters{advancedFilterCount ? ` (${advancedFilterCount})` : ''}
            </button>
            <ViewModeDropdown value={maintenanceViewMode} onChange={changeMaintenanceViewMode} />
          </div>

          <div className="p24-maint-tabs" role="tablist" aria-label="Filter by maintenance status">
            {[
              ['All', []], ['Assigned', ['Assigned']], ['Repair in Progress', ['Under Repair']],
              ['Needs Verification', ['For Verification']], ['Completed', ['Completed']],
            ].map(([label, value]) => (
              <button key={label} type="button" role="tab" aria-selected={JSON.stringify(filterStatus) === JSON.stringify(value)} className={JSON.stringify(filterStatus) === JSON.stringify(value) ? 'is-active' : ''} onClick={() => setFilterStatus(value)}>{label}</button>
            ))}
          </div>

          {showMaintenanceFilters && (
            <div className="p24-maint-advanced">
              <div className="p24-maint-advanced-head"><div><h3>More filters</h3><p>Narrow records by vehicle details, personnel, source, or date.</p></div></div>
            <FilterBar
              categories={lookups.categories}
              vehicles={lookups.vehicles}
              filterCategory={filterCategory}
              setFilterCategory={setFilterCategory}
              filterCapacity={filterCapacity}
              setFilterCapacity={setFilterCapacity}
              filterStatus={filterStatus}
              setFilterStatus={setFilterStatus}
              statusOptions={lookups.maintenance_statuses}
              statusLabel="Progress"
              filterPriority={filterPriority}
              setFilterPriority={setFilterPriority}
              priorityOptions={(lookups.maintenance_personnel ?? []).map((p) => p.name)}
              priorityLabel="Mechanic"
              extraFilters={[
                {
                  key: 'maintType',
                  label: 'Maintenance Types',
                  options: lookups.maintenance_types ?? [],
                  selected: filterMaintType,
                  setSelected: setFilterMaintType,
                },
                {
                  key: 'source',
                  label: 'Sources',
                  options: ['Scheduled Maintenance', 'External Shop', 'From Issue Report', 'Field Repair'],
                  selected: filterSource,
                  setSelected: setFilterSource,
                },
              ]}
              dateRange={{
                start: filterDateStart,
                setStart: setFilterDateStart,
                end: filterDateEnd,
                setEnd: setFilterDateEnd,
              }}
            />
            </div>
          )}

          <div className="p24-maint-results-head"><h3>Records</h3><span>{visibleRows.length} shown</span></div>
          {maintenanceViewMode === 'card' ? (
            <PaginatedCardGrid
              items={visibleRows}
              keyOf={(row) => row.maintenance_id}
              emptyMessage={maintenanceEmptyMessage}
              renderItem={(row) => (
                <MaintenanceRecordCard
                  record={row}
                  onClick={() => navigate(`${roleRoutes[user.role]}/maintenance/${row.maintenance_id}`)}
                />
              )}
            />
          ) : (
            <PaginatedTable
              columns={simpleColumns}
              emptyMessage={maintenanceEmptyMessage}
              rows={visibleRows}
              compact
              onRowClick={(row) => navigate(recordPath(row))}
            />
          )}
        </ModulePanel>
        <FormModal open={!!editTarget?.__verify} title={`Verify Maintenance #${editTarget?.maintenance_id}`} onClose={() => setEditTarget(null)}>
          <SmartForm
            fields={verificationFields}
            key={editTarget?.maintenance_id}
            onCancel={() => setEditTarget(null)}
            onSubmit={submitModuleForm}
            submitLabel="Submit Verification"
            title=""
          />
        </FormModal>
        </>
      );
    }

    if (activeModule === 'maintenanceStatus') {
      return (
        <>
          <ModulePanel tabBar={maintenanceLedgerTabBar} description="Review records marked for field verification and send the result back to the ticket loop.">
            <div className="panel-header-bar">
              <h3>Pending Verifications <span className="count-badge">{visibleRows.length}</span></h3>
              <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search verifications..." columnChooser={maintenanceStatusColumnChooser} />
            </div>
            <DataTable
              columns={maintenanceStatusColumnChooser.visibleColumns}
              onReorderColumn={maintenanceStatusColumnChooser.reorderColumn}
              emptyMessage="Nothing awaiting your verification right now."
              rows={visibleRows}
              onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
              renderSubRow={(row) => subRowFields([['Problem / Reason', row.problem_reason], ['Action Taken', row.action_taken]])}
            />
          </ModulePanel>
          <FormModal open={!!editTarget} title={`Verify Maintenance #${editTarget?.maintenance_id}`} onClose={() => setEditTarget(null)}>
            <SmartForm
              fields={verificationFields}
              key={editTarget?.maintenance_id}
              onCancel={() => setEditTarget(null)}
              onSubmit={submitModuleForm}
              submitLabel="Submit Verification"
              title=""
            />
          </FormModal>

          {/* Offered right after a Pass, while the Custodian is still at the
              vehicle. Confirming a repair and confirming the vehicle can
              respond are different facts, so they stay separate records —
              this just removes the second trip needed to collect them. */}
          <FormModal
            open={!!readinessPromptTarget}
            title={`Readiness Check — ${readinessPromptTarget?.vehicle_name ?? ''}`}
            onClose={() => setReadinessPromptTarget(null)}
          >
            {readinessPromptTarget && (
              <>
                <div className="notice success" style={{ marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ display: 'inline-flex', flexShrink: 0, marginTop: 1 }}><Icon name="checkCircle" size={16} /></span>
                  <span style={{ fontSize: '0.84rem' }}>
                    Verification passed. Since you&apos;re already at this vehicle, you can record its Readiness Check now instead of making a second trip — or skip it with Cancel.
                  </span>
                </div>
                <Suspense fallback={null}>
                    <ReadinessCheckForm
                    vehicle={readinessPromptTarget}
                    onCancel={() => setReadinessPromptTarget(null)}
                    onSubmit={(payload) => submitReadinessFromPrompt(readinessPromptTarget.vehicle_id, payload)}
                  />
                </Suspense>
              </>
            )}
          </FormModal>
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

      // Specific to what's hiding the list: nothing booked yet, nothing in
      // the one status card picked, or search/filters excluding everything.
      const scheduleFilterLabel = filterStatus.length === 1
        ? ([...SCHEDULE_STAT_CARDS, MY_ASSIGNED_SCHEDULE_CARD].find((c) => c.key === filterStatus[0])?.label ?? filterStatus[0])
        : null;
      const scheduleEmptyMessage = (rawRows?.length ?? 0) === 0
        ? (canDo(user, 'schedule.create') ? 'No maintenance scheduled yet — click the + button to plan one.' : 'No maintenance scheduled yet.')
        : scheduleFilterLabel
          ? `No "${scheduleFilterLabel}" schedules with the current search and filters.`
          : 'No schedules match the current search or filters — clear them to see every schedule.';

      const scheduledRows = records.schedules ?? [];
      const upcomingCount = scheduledRows.filter((row) => row.status === 'Scheduled' && scheduleUrgencyBucket(row) !== 'Overdue').length;
      const attentionRows = scheduledRows.filter((row) => (
        (canDo(user, 'schedule.approve') && row.status === 'Pending Approval')
        || (hasRole(user, 'Maintenance Personnel') && row.status === 'Scheduled' && String(row.assigned_to) === String(user.id))
        || (canDo(user, 'record.verify') && row.status === 'Completed' && row.resulting_maintenance?.progress_status === 'For Verification')
      )).sort((a, b) => new Date(a.scheduled_date) - new Date(b.scheduled_date));
      const advancedFilterCount = filterCategory.length + filterCapacity.length + filterAssignedTo.length + filterLocation.length;
      const formatScheduleTime = (value) => {
        if (!value) return '';
        const [hours, minutes] = String(value).split(':').map(Number);
        if (!Number.isFinite(hours)) return value;
        return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, hours, minutes || 0));
      };
      const scheduleActionColumn = scheduleColumnDefs.find((column) => column.key === 'action');
      const simpleScheduleColumns = [
        {
          key: 'when', label: 'Schedule', locked: true, render: (row) => (
            <span className="p24-schedule-when">
              <strong>{formatDate(row.scheduled_date)}</strong>
              <span>{formatScheduleTime(row.scheduled_time) || 'Time not set'}</span>
            </span>
          ),
        },
        {
          key: 'vehicle', label: 'Vehicle', render: (row) => (
            <span className="p24-maint-primary-cell"><strong>{row.vehicle?.vehicle_name ?? 'Vehicle not recorded'}</strong><span>{row.vehicle?.plate_number ?? 'No plate number'}</span></span>
          ),
        },
        { key: 'type', label: 'Maintenance', render: (row) => <span className="p24-schedule-type"><strong>{row.maintenance_type}</strong><span>Schedule #{row.schedule_id}</span></span> },
        { key: 'assigned', label: 'Assigned To', render: (row) => row.assigned_to_user?.name ?? <span className="muted">Unassigned</span> },
        {
          key: 'status', label: 'Status', className: 'cell-center', render: (row) => (
            <span className="p24-schedule-state"><TicketStatusBadge value={row.status} />{row.status === 'Scheduled' && <small>{scheduleDueLabel(row)}</small>}</span>
          ),
        },
        scheduleActionColumn,
      ].filter(Boolean);

      return (
        <ModulePanel>
          <header className="p24-schedule-header">
            <div><p className="p24-maint-eyebrow">Maintenance planning</p><h2>Maintenance Schedule</h2><p>Track upcoming maintenance and overdue work.</p></div>
            {(canDo(user, 'schedule.create') || canDo(user, 'schedule.suggest')) && (
              <button className="primary-button" type="button" onClick={() => navigate(`${roleRoutes[user.role]}/schedules/new`)}>
                <Icon name="plus" size={16} /> {canDo(user, 'schedule.create') ? 'Add Schedule' : 'Suggest Schedule'}
              </button>
            )}
          </header>

          <section className="p24-schedule-metrics" aria-label="Schedule summary">
            {[
              ['Total Schedules', scheduleStats.total, null, 'neutral'],
              ['Overdue', scheduleStats.Overdue ?? 0, ['Overdue'], 'danger'],
              ['Pending Approval', scheduleStats['Pending Approval'] ?? 0, ['Pending Approval'], 'warning'],
              ['Upcoming', upcomingCount, ['Due1to3', 'Due4to7', 'Due8plus'], 'info'],
            ].map(([label, count, value, tone]) => (
              <button key={label} type="button" className={`p24-schedule-metric tone-${tone}${value && value.every((item) => filterStatus.includes(item)) ? ' is-active' : ''}`} onClick={() => value && setFilterStatus(value)} aria-label={value ? `Show ${label}` : `${label}: ${count}`}>
                <span>{label}</span><strong>{count}</strong>
              </button>
            ))}
          </section>

          {attentionRows.length > 0 && (
            <section className="p24-schedule-attention" aria-labelledby="schedule-attention-title">
              <div className="p24-schedule-attention-head"><span><Icon name="alert" size={17} /></span><div><h3 id="schedule-attention-title">Needs Attention</h3><p>{attentionRows.length} {attentionRows.length === 1 ? 'schedule is' : 'schedules are'} ready for your action.</p></div></div>
              <div className="p24-schedule-attention-list">
                {attentionRows.slice(0, 4).map((row) => (
                  <div key={row.schedule_id}>
                    <span><strong>{row.maintenance_type}</strong><small>{row.vehicle?.vehicle_name} · {formatDate(row.scheduled_date)}</small></span>
                    {canDo(user, 'schedule.approve') && row.status === 'Pending Approval' ? (
                      <button type="button" onClick={() => approveSchedule(row)}>Approve</button>
                    ) : row.status === 'Completed' && row.resulting_maintenance_id ? (
                      <button type="button" onClick={() => navigate(`${roleRoutes[user.role]}/maintenance/${row.resulting_maintenance_id}`)}>Review</button>
                    ) : (
                      <button type="button" onClick={() => openVehicleProfile(row.vehicle)}>View vehicle</button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="p24-schedule-toolbar">
            <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search by vehicle, maintenance, or schedule ID..." />
            <button className={`ghost-button p24-filter-toggle${showScheduleFilters ? ' is-active' : ''}`} type="button" aria-expanded={showScheduleFilters} onClick={() => setShowScheduleFilters((value) => !value)}><Icon name="filter" size={16} /> Filters{advancedFilterCount ? ` (${advancedFilterCount})` : ''}</button>
            <button className="ghost-button p24-schedule-export" type="button" onClick={() => exportRowsToCsv('maintenance-schedules.csv', SCHEDULE_EXPORT_COLUMNS, visibleRows)}><Icon name="download" size={16} /> Export</button>
            <ViewModeDropdown value={scheduleViewMode} onChange={changeScheduleViewMode} />
          </div>

          <div className="p24-maint-tabs" role="tablist" aria-label="Filter schedules">
            {[
              ['Current', []], ['Scheduled', ['Scheduled']], ['Pending Approval', ['Pending Approval']],
              ['Awaiting Verification', ['AwaitingVerification']], ['Completed', ['Completed']], ['Cancelled', ['Cancelled']], ['Declined', ['Declined']],
            ].map(([label, value]) => (
              <button key={label} type="button" role="tab" aria-selected={JSON.stringify(filterStatus) === JSON.stringify(value)} className={JSON.stringify(filterStatus) === JSON.stringify(value) ? 'is-active' : ''} onClick={() => setFilterStatus(value)}>{label}</button>
            ))}
          </div>

          {showScheduleFilters && (
            <div className="p24-maint-advanced">
              <div className="p24-maint-advanced-head"><h3>More filters</h3><p>Narrow schedules by vehicle, assigned personnel, or service location.</p></div>
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
            </div>
          )}

          <div className="p24-maint-results-head"><h3>Schedules</h3><span>{scheduleRows.length} shown</span></div>
          {scheduleViewMode === 'card' ? (
            <PaginatedCardGrid
              items={scheduleRows}
              keyOf={(row) => row.schedule_id}
              emptyMessage={scheduleEmptyMessage}
              renderItem={(row) => (
                <MaintenanceScheduleCard
                  row={row}
                  currentUser={user}
                  onComplete={openCompleteSchedule}
                  onEdit={(r) => navigate(`${roleRoutes[user.role]}/schedules/${r.schedule_id}/edit`)}
                  onDelete={(r) => deleteRecord(`/maintenance-schedules/${r.schedule_id}`, 'Schedule cancelled.', `Cancel the ${r.maintenance_type} schedule for ${r.vehicle?.vehicle_name ?? 'this vehicle'}? It can be restored later if needed.`, { title: 'Cancel schedule', confirmLabel: 'Cancel schedule' })}
                  onRestore={(r) => restoreRecord(`/maintenance-schedules/${r.schedule_id}/restore`, 'Schedule restored.', 'Restore this cancelled schedule back to Scheduled?', { title: 'Restore schedule' })}
                  onViewRecord={(r) => navigate(`${roleRoutes[user.role]}/maintenance/${r.resulting_maintenance_id}`)}
                  onReassign={setReassignScheduleTarget}
                  onViewTicket={openTicketProfile}
                  onViewVehicle={openVehicleProfile}
                  onApprove={approveSchedule}
                  onDecline={setDeclineScheduleTarget}
                />
              )}
            />
          ) : (
            <PaginatedTable
              columns={simpleScheduleColumns}
              emptyMessage={scheduleEmptyMessage}
              rows={scheduleRows}
              onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
            />
          )}

          {renderCompleteScheduleModal()}
          {renderReassignScheduleModal()}
          {renderDeclineScheduleModal()}
        </ModulePanel>
      );
    }

    if (activeModule === 'histories') {
      const historyActivityTypeOptions = [...new Set((records.histories ?? []).map((h) => h.activity_type).filter(Boolean))].sort();
      const historyScope = { dateStart: filterDateStart, dateEnd: filterDateEnd, search: searchQuery, filters: [{ label: 'Activity', values: filterActivityType }] };
      const historyFiltered = hasActiveScope(historyScope);
      const clearHistoryFilters = () => { setFilterActivityType([]); setFilterDateStart(''); setFilterDateEnd(''); setSearchQuery(''); };
      const historyEmpty = (inline) => (
        <ScopedEmptyState
          inline={inline}
          filtered={historyFiltered}
          emptyText="No vehicle activity recorded yet — entries appear automatically as vehicles are updated, checked, and repaired."
          filteredText="No vehicle activity matches these filters."
          onClear={clearHistoryFilters}
        />
      );
      return (
        <ModulePanel
          description="Vehicle History — what happened to each vehicle (location changes, issues, condition checks, maintenance), recorded automatically. For who did what across the whole system, see the Activity Log."
          filterBar={
            <div className="filter-bar-container">
              <div className="filter-label"><span>Filters:</span></div>
              <div className="filter-date-group">
                <span>Activity Type</span>
                <MultiSelectDropdown
                  placeholder="All Activity Types"
                  options={historyActivityTypeOptions}
                  selected={filterActivityType}
                  onChange={setFilterActivityType}
                />
              </div>
              <div className="filter-date-group">
                <span>From Date</span>
                <DateFilterInput value={filterDateStart} onChange={setFilterDateStart} />
              </div>
              <div className="filter-date-group">
                <span>To Date</span>
                <DateFilterInput value={filterDateEnd} onChange={setFilterDateEnd} />
              </div>
            </div>
          }
        >
          <header className="history-page-header">
            <div><span className="history-page-eyebrow">Fleet activity</span><h2>Vehicle History</h2><p>A chronological record of vehicle updates, checks, reported issues, and maintenance.</p></div>
            <div className="history-page-actions">
              <button className="ghost-button" onClick={() => exportRowsToCsv(`vehicle-history-${new Date().toISOString().slice(0, 10)}.csv`, VEHICLE_HISTORY_EXPORT_COLUMNS, visibleRows)} type="button" disabled={!visibleRows.length}><Icon name="download" size={15} /> Export CSV</button>
              <button className="ghost-button" onClick={() => window.print()} type="button" disabled={!visibleRows.length}><Icon name="print" size={15} /> Print</button>
            </div>
          </header>
          <section className="history-toolbar" aria-label="Search vehicle history">
            <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search vehicle, activity, person, or description..." />
            {historyFiltered && <button type="button" className="ghost-button history-clear-button" onClick={clearHistoryFilters}><Icon name="close" size={13} /> Clear all filters</button>}
          </section>
          <p className="p23-module-intro">
            <strong>Vehicle History</strong> is each vehicle's own timeline — location changes, issues, condition checks, and maintenance — recorded automatically.
            {modules.some(([key]) => key === 'logs') && (
              <> For who did what across every module, see the <button type="button" className="link-button p23-inline-link" onClick={() => setActiveModule('logs')}>Activity Log</button>.</>
            )}
          </p>
          <ResultScope
            shown={visibleRows.length}
            total={(records.histories ?? []).length}
            {...historyScope}
            onClear={clearHistoryFilters}
            exportNote="Export (CSV spreadsheet) and Print include every entry listed here across all pages — not just the page on screen."
          />
          <section className="history-timeline-surface" aria-label="Chronological vehicle activity">
            <HistoryDayTimeline rows={visibleRows} emptyState={historyEmpty(false)} />
          </section>

          <PrintSheet
            title="Vehicle Activity History"
            landscape
            meta={[
              { label: 'Printed on', value: formatDate(new Date().toISOString()) },
              { label: 'Printed by', value: user.name },
              { label: 'Date range', value: describeDateRange(filterDateStart, filterDateEnd) },
              { label: 'Activity types', value: filterActivityType.length ? filterActivityType.join(', ') : 'All' },
              { label: 'Search', value: searchQuery.trim() ? `“${searchQuery.trim()}”` : null },
              { label: 'Entries', value: String(visibleRows.length) },
            ]}
            columns={VEHICLE_HISTORY_EXPORT_COLUMNS.map((col) => ({ label: col.label, render: col.value }))}
            rows={visibleRows}
            rowKey={(row) => row.history_id}
          />
        </ModulePanel>
      );
    }

    if (activeModule === 'reports') {
      return (
        <ModulePanel description="Reports are grouped by the question they answer. Open one, set its filters, and Generate — the preview below can then be downloaded as CSV data or printed as a formatted report.">
          <div className="panel-header-bar">
            <h3>Reports</h3>
          </div>
          <p className="p23-module-intro">Reports are grouped by the question they answer. Open one, set its filters, then Generate. The preview can be downloaded as <strong>CSV</strong> (raw data for a spreadsheet) or <strong>printed / saved as PDF</strong> (a formatted report with title, barangay, preparer, and filters).</p>
          <ReportsModule lookups={lookups} onGenerate={submitModuleForm} />
          {report && (
            <ReportPreview
              key={`${report.report_type}-${report.generated_at}`}
              report={report}
              lookups={lookups}
              barangay={user.barangay?.name ?? user.barangay_name ?? null}
            />
          )}
        </ModulePanel>
      );
    }

    if (activeModule === 'logs') {
      const logModuleOptions = [...new Set((records.logs ?? []).map((l) => l.module).filter(Boolean))].sort();
      const logScope = { dateStart: filterDateStart, dateEnd: filterDateEnd, search: searchQuery, filters: [{ label: 'Module', values: filterActivityType }] };
      const logFiltered = hasActiveScope(logScope);
      const clearLogFilters = () => { setFilterActivityType([]); setFilterDateStart(''); setFilterDateEnd(''); setSearchQuery(''); };
      const logEmpty = (inline) => (
        <ScopedEmptyState
          inline={inline}
          filtered={logFiltered}
          emptyText="No activity logged yet — every create, update, approval, and deletion made by a user is recorded here."
          filteredText="No logged activity matches these filters."
          onClear={clearLogFilters}
        />
      );
      return (
        <ModulePanel
          description="Activity Log — a read-only accountability record of who did what, in which module, and when, across the whole system. For a single vehicle's timeline, see Vehicle History."
          filterBar={
            <div className="filter-bar-container">
              <div className="filter-label"><span>Filters:</span></div>
              <div className="filter-date-group">
                <span>Module</span>
                <MultiSelectDropdown
                  placeholder="All Modules"
                  options={logModuleOptions}
                  selected={filterActivityType}
                  onChange={setFilterActivityType}
                />
              </div>
              <div className="filter-date-group">
                <span>From Date</span>
                <DateFilterInput value={filterDateStart || '2026-01-01'} onChange={setFilterDateStart} />
              </div>
              <div className="filter-date-group">
                <span>To Date</span>
                <DateFilterInput value={filterDateEnd || '2026-12-31'} onChange={setFilterDateEnd} />
              </div>
            </div>
          }
        >
          <div className="panel-header-bar">
            <h3>Activity Log <span className="count-badge">{visibleRows.length}</span></h3>
            <div className="p23-header-actions">
              <GenerateReportButton rows={visibleRows} />
              <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search logs..." columnChooser={logsView === 'list' ? logColumnChooser : undefined} />
            </div>
          </div>
          <p className="p23-module-intro">
            <strong>Activity Log</strong> is the read-only accountability record of every user action — who did it, their role, which module, and the record affected.
            {modules.some(([key]) => key === 'histories') && (
              <> For one vehicle's own timeline, see <button type="button" className="link-button p23-inline-link" onClick={() => setActiveModule('histories')}>Vehicle History</button>.</>
            )}
          </p>
          <div className="view-tabs p23-tabs" role="group" aria-label="Activity log view">
            <button type="button" aria-pressed={logsView === 'list'} className={logsView === 'list' ? 'active' : ''} onClick={() => setLogsView('list')}>Full List</button>
            <button type="button" aria-pressed={logsView === 'recent'} className={logsView === 'recent' ? 'active' : ''} onClick={() => setLogsView('recent')}>Recent Activities</button>
          </div>
          <p className="p23-view-hint">
            {logsView === 'list'
              ? 'Full List: every logged action as a table — choose columns, then use Generate Report to export it.'
              : 'Recent Activities: the same entries as a day-by-day timeline, newest first, for a quick read of what happened lately.'}
          </p>
          <ResultScope
            shown={visibleRows.length}
            total={(records.logs ?? []).length}
            {...logScope}
            onClear={clearLogFilters}
            exportNote="Generate Report exports every entry listed here (all pages) as a CSV spreadsheet."
          />
          {logsView === 'list' ? (
            <PaginatedTable columns={logColumnChooser.visibleColumns} onReorderColumn={logColumnChooser.reorderColumn} rows={visibleRows} emptyMessage={logEmpty(true)} />
          ) : (
            <LogDayTimeline rows={visibleRows} vehicles={lookups.vehicles ?? []} emptyState={logEmpty(false)} />
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
          onCreateNew={hasRole(user, 'Admin') ? () => navigate(`${roleRoutes[user.role]}/tickets/new`) : undefined}
          onViewArchives={canDo(user, 'ticket.view_archives') ? () => setActiveModule('ticketArchives') : undefined}
          recentIssues={hasRole(user, 'Admin') ? (records.issues ?? []) : undefined}
          onViewVehicle={openVehicleProfile}
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
    if (activeModule === 'ticketArchives') {
      const allArchiveRows = records.ticketArchives ?? [];

      // Year → ticket count map, built from unfiltered data
      const yearCounts = allArchiveRows.reduce((acc, r) => {
        const yr = r.archived_at?.substring(0, 4);
        if (yr) acc[yr] = (acc[yr] ?? 0) + 1;
        return acc;
      }, {});
      const archiveYears = Object.keys(yearCounts).sort().reverse();

      // Final status values present in the data
      const archiveFinalStatuses = [...new Set(allArchiveRows.map((r) => r.final_status).filter(Boolean))];

      // Which year is the current draft's From date pointing at (for year selector sync)
      const selectedYear = archiveDraft.start ? archiveDraft.start.substring(0, 4) : '';

      const applyQuickFilter = (key) => {
        const today = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        let start = '';
        let end = '';
        if (key === 'this_year') {
          start = `${today.getFullYear()}-01-01`;
          end = fmt(today);
        } else if (key === 'last_year') {
          const yr = today.getFullYear() - 1;
          start = `${yr}-01-01`;
          end = `${yr}-12-31`;
        } else if (key === 'over_1yr') {
          const d = new Date(today); d.setFullYear(d.getFullYear() - 1);
          end = fmt(d);
        } else if (key === 'over_3yr') {
          const d = new Date(today); d.setFullYear(d.getFullYear() - 3);
          end = fmt(d);
        }
        const next = { start, end, status: archiveDraft.status, quick: key || '' };
        setArchiveDraft(next);
        setArchiveStart(next.start);
        setArchiveEnd(next.end);
      };

      const applyYearFilter = (yr) => {
        if (!yr) {
          setArchiveDraft({ start: '', end: '', status: archiveDraft.status, quick: '' });
          setArchiveStart('');
          setArchiveEnd('');
        } else {
          const next = { start: `${yr}-01-01`, end: `${yr}-12-31`, status: archiveDraft.status, quick: '' };
          setArchiveDraft(next);
          setArchiveStart(next.start);
          setArchiveEnd(next.end);
        }
      };

      const isDraftDifferent =
        archiveDraft.start !== archiveStart ||
        archiveDraft.end !== archiveEnd ||
        archiveDraft.status !== archiveStatusFilter;

      return (
        <ModulePanel
          description="Immutable audit trail of all completed and closed maintenance tickets."
          filterBar={
            <div className="filter-bar-container" style={{ flexWrap: 'wrap', gap: '8px 12px', alignItems: 'center' }}>
              <div className="filter-label"><span>Vehicle:</span></div>
              <div className="filter-date-group">
                <span>Category</span>
                <MultiSelectDropdown
                  placeholder="All Categories"
                  options={(lookups.categories ?? []).map((c) => ({ value: String(c.category_id), label: c.category_name }))}
                  selected={filterCategory}
                  onChange={setFilterCategory}
                />
              </div>
              <div className="filter-date-group">
                <span>Capacity</span>
                <MultiSelectDropdown
                  placeholder="All Capacities"
                  options={[...new Set((lookups.vehicles ?? []).map((v) => v.capacity).filter(Boolean))]}
                  selected={filterCapacity}
                  onChange={setFilterCapacity}
                />
              </div>

              <div style={{ width: 1, height: 22, background: 'var(--border, #334155)', flexShrink: 0 }} />

              <div className="filter-label"><span>DATE FILTER:</span></div>

              {/* Quick relative filters — dropdown */}
              <div className="filter-date-group">
                <span>Quick Filter</span>
                <select
                  className="filter-select"
                  value={archiveDraft.quick}
                  onChange={(e) => applyQuickFilter(e.target.value)}
                >
                  <option value="">Quick Filter</option>
                  <option value="this_year">This Year</option>
                  <option value="last_year">Last Year</option>
                  <option value="over_1yr">Older than 1 Year</option>
                  <option value="over_3yr">Older than 3 Years</option>
                </select>
              </div>

              <div style={{ width: 1, height: 22, background: 'var(--border, #334155)', flexShrink: 0 }} />

              {/* Year dropdown — only years that actually have archived tickets */}
              <div className="filter-date-group">
                <span>Year</span>
                <select
                  className="filter-select"
                  value={selectedYear}
                  onChange={(e) => applyYearFilter(e.target.value)}
                >
                  <option value="">All Years</option>
                  {archiveYears.map((yr) => (
                    <option key={yr} value={yr}>
                      {yr} — {yearCounts[yr]} {yearCounts[yr] === 1 ? 'ticket' : 'tickets'}
                    </option>
                  ))}
                </select>
              </div>

              {/* Custom date range */}
              <div className="filter-date-group">
                <span>From Date</span>
                <DateFilterInput
                  value={archiveDraft.start || '2026-01-01'}
                  onChange={(val) => setArchiveDraft((d) => ({ ...d, start: val, quick: '' }))}
                />
              </div>
              <div className="filter-date-group">
                <span>To Date</span>
                <DateFilterInput
                  value={archiveDraft.end || '2026-12-31'}
                  onChange={(val) => setArchiveDraft((d) => ({ ...d, end: val, quick: '' }))}
                />
              </div>

              {/* Final status filter */}
              {archiveFinalStatuses.length > 0 && (
                <div className="filter-date-group">
                  <span>Status</span>
                  <select
                    className="filter-select"
                    value={archiveDraft.status}
                    onChange={(e) => setArchiveDraft((d) => ({ ...d, status: e.target.value }))}
                  >
                    <option value="">All Statuses</option>
                    {archiveFinalStatuses.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Apply — only shown when draft differs from applied */}
              <button
                type="button"
                className="filter-apply-btn"
                disabled={!isDraftDifferent}
                onClick={() => {
                  setArchiveStart(archiveDraft.start);
                  setArchiveEnd(archiveDraft.end);
                  setArchiveStatusFilter(archiveDraft.status);
                }}
              >
                Apply
              </button>

              {/* Active range summary pill */}
              {(archiveStart || archiveEnd) && (
                <span style={{ fontSize: '0.75rem', opacity: 0.55, fontStyle: 'italic' }}>
                  {archiveStart && archiveEnd
                    ? `${archiveStart} → ${archiveEnd}`
                    : archiveStart
                    ? `From ${archiveStart}`
                    : `Up to ${archiveEnd}`}
                </span>
              )}
            </div>
          }
        >
          <div className="panel-header-bar">
            <h3>
              <button type="button" className="ghost-button" style={{ marginRight: 10 }} onClick={() => setActiveModule('tickets')}>
                <Icon name="arrowLeft" size={14} /> Tickets
              </button>
              Archived Tickets <span className="count-badge">{visibleRows.length}</span>
              {visibleRows.length !== allArchiveRows.length && (
                <span style={{ fontWeight: 400, fontSize: '0.8rem', marginLeft: 6 }}>of {allArchiveRows.length} total</span>
              )}
            </h3>
            <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search archives..." columnChooser={archiveColumnChooser} />
          </div>

          {/* No-result hint when filters are active but nothing matched */}
          {visibleRows.length === 0 && allArchiveRows.length > 0 && (archiveStart || archiveEnd || archiveStatusFilter) && (
            <p className="notice" style={{ margin: '8px 0', opacity: 0.7, fontSize: '0.85rem' }}>
              No archived tickets match the selected filters. Only dates with actual archived tickets will return results — try adjusting the date range or clearing the filter.
            </p>
          )}

          <PaginatedTable
            columns={archiveColumnChooser.visibleColumns}
            onReorderColumn={archiveColumnChooser.reorderColumn}
            emptyMessage="No archived tickets yet — completed tickets are stored here automatically."
            rows={visibleRows}
            onRowClick={(row) => row.vehicle && openVehicleProfile(row.vehicle)}
          />
        </ModulePanel>
      );
    }

    // Phase 2: Custodian — submit inspection results
    if (activeModule === 'ticketInspections') {
      return (
          <CustodianInspectionModule
            tabBar={myTasksTabBar}
            tickets={visibleRows}
            onOpenInspect={(ticket) => navigate(`${roleRoutes[user.role]}/inspections/${ticket.ticket_id}/inspect`)}
            categories={lookups.categories}
            vehicles={lookups.vehicles}
            filterCategory={filterCategory}
            setFilterCategory={setFilterCategory}
            filterCapacity={filterCapacity}
            setFilterCapacity={setFilterCapacity}
            filterPriority={filterPriority}
            setFilterPriority={setFilterPriority}
            priorityOptions={ticketLookups.priorities}
            onViewVehicle={openVehicleProfile}
            stats={inspectionStats}
            activeFilter={filterStatus}
            onFilterChange={setFilterStatus}
          />
      );
    }

    // Phase 4 Tier 1: Custodian — verify completed repairs
    if (activeModule === 'ticketVerifications') {
      return (
          <CustodianVerificationModule
            tabBar={myTasksTabBar}
            user={user}
            tickets={visibleRows}
            editTarget={editTarget}
            setEditTarget={setEditTarget}
            onVerify={(ticket, payload) => ticketAction(`/tickets/${ticket.ticket_id}/verify`, payload, verifyOutcomeMessage(payload))}
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
            onViewTicket={openTicketProfile}
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
            allTickets={records.ticketWorkOrders ?? []}
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
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            stats={workOrderStats}
            activeFilter={filterStatus}
            onFilterChange={setFilterStatus}
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

export default Workspace;
