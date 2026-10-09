

export const roleRoutes = {
  Admin: '/admin',
  Custodian: '/custodian',
  'Maintenance Personnel': '/maintenance',
  'Super Admin': '/superadmin',
};

// Sidebar structure, grouped into collapsible sections. `section: null` means
// the items render at the top with no header (Dashboard) — everything else
// sits under a labelled, collapsible group. The groupings themselves aren't
// new: they existed as comments here long before they were rendered.
export const modulesByRole = {
  Admin: [
    { section: null, items: [['dashboard', 'Dashboard']] },
    { section: 'Operations', icon: 'clipboard', items: [
      ['issues', 'Issue Reports'],
      ['tickets', 'Maintenance Tickets'],
      ['schedules', 'Maintenance Schedule'],
      ['maintenance', 'Maintenance Records'],
      ['conditions', 'Condition Monitoring'],
    ] },
    // The old cross-vehicle "Vehicle Documents" picker page (VehicleDocumentsPage)
    // was removed (2026-10-10) — unlinked everywhere and reachable only by
    // forcing its module key. Documents now live solely on the vehicle
    // profile's own Files card. Ticket Archives moved into the Maintenance
    // Tickets module itself (a toolbar link there) instead of its own
    // top-level row.
    { section: 'Fleet & Assets', icon: 'vehicle', items: [
      ['vehicles', 'Vehicle Management'],
      ['categories', 'Vehicle Types'],
      ['locations', 'Vehicle Location'],
    ] },
    { section: 'Administration', icon: 'key', items: [
      ['users', 'Users'],
      ['reports', 'Reports'],
      ['logs', 'Activity Log'],
    ] },
  ],
  Custodian: [
    { section: null, items: [['dashboard', 'Dashboard']] },
    // 'vehicles' already carries both "View Vehicles" and, for whoever
    // holds vehicle.create, the "+ Add Vehicle" (register) action inline —
    // no separate "Register Vehicle" row for the same page.
    { section: 'Vehicles', icon: 'vehicle', items: [
      ['vehicles', 'View Vehicles'],
      ['histories', 'Vehicle History'],
    ] },
    // 'reportOrPropose' ('issues' module under the hood) is the Issue
    // Reports list, with a "Report Vehicle Issue" action and a "Propose
    // Ticket" action both inline in its header — not a separate chooser
    // screen. 'myTasks' stays a tabbed container (Assigned Inspections /
    // Repair Verification / Work Tracker — see renderModule's tab bar).
    // Neither key has its own moduleEndpoints entry — both are pure
    // navigation/presentation wrappers around shared components/data.
    { section: 'Vehicle Operations', icon: 'checkCircle', items: [
      ['reportOrPropose', 'Report Vehicle Issue'],
      ['myTasks', 'My Tasks'],
      ['conditions', 'Condition Monitoring'],
    ] },
    { section: 'Maintenance', icon: 'calendar', items: [
      ['schedules', 'Maintenance Schedule'],
      // Merged "Maintenance Status" + "Maintenance Records" — same
      // underlying data (see maintenanceLedgerLastTab above), tabbed.
      ['maintenanceLedger', 'Maintenance Records'],
    ] },
  ],
  'Maintenance Personnel': [
    { section: null, items: [['dashboard', 'Dashboard']] },
    { section: 'Maintenance', icon: 'wrench', items: [
      ['ticketWorkOrders', 'My Work Orders'],
      ['workTracker', 'Work Tracker'],
      ['maintenanceLedger', 'Maintenance Records'],
      ['schedules', 'Maintenance Schedule'],
    ] },
    // Same Issue Reports list Admin/Custodian use, scoped server-side to
    // reports this account personally filed — the "Report Technical Issue"
    // action lives inline in its header (issue.create), gated the same way
    // for every role that holds it.
    { section: 'Issues', icon: 'issues', items: [
      ['issues', 'Vehicle Issues'],
    ] },
    // No standalone "Vehicle Documents" sidebar item for any role — the
    // module lives only on the vehicle profile's own Files card now
    // (document.view/.create abilities). Maintenance Personnel reaches it
    // the same way: open a vehicle from View Vehicles below.
    { section: 'Vehicles', icon: 'vehicle', items: [
      ['vehicles', 'View Vehicles'],
    ] },
  ],
};

// Multi-role helpers. `role` is the primary (portal/routing); `roles` is
// every hat the account may wear. Permission checks use hasRole so a person
// holding several roles is allowed to act under any of them.
export function hasRole(user, role) {
  if (!user) return false;
  const roles = user.roles;
  if (Array.isArray(roles) && roles.length) return roles.includes(role);
  return user.role === role; // fall back to primary role
}

// Ability-based permission check. The backend computes `user.abilities` from
// config/permissions.php (role -> abilities) and returns it on login/GET user.
// Prefer this over hasRole()/raw role checks for authorization decisions —
// role checks should be reserved for display-only logic (e.g. label copy).
export function canDo(user, ability) {
  if (!user) return false;
  return Array.isArray(user.abilities) && user.abilities.includes(ability);
}

// Production-readiness audit finding #6 — mirrors User::canRegisterVehicles()
// on the backend. canDo(user, 'vehicle.create') alone can't express this: the
// ability only says Admin/Custodian are the eligible ROLES, not which
// specific Custodian accounts an Admin has actually delegated it to.
export function canRegisterVehicles(user) {
  if (hasRole(user, 'Admin')) return true;
  return hasRole(user, 'Custodian') && !!user?.can_register_vehicles;
}

export function userRoles(user) {
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
export function resolveModuleGroups(user) {
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
