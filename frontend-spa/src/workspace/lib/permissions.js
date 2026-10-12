

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
      // Issue Reports was its own sidebar page — removed as redundant (no
      // ticket linked, Admin's only action was Dismiss). The one thing worth
      // keeping, a glance at the latest reports, now lives on Maintenance
      // Tickets instead (see LatestIssueCard there). The underlying feature
      // and data aren't gone — Custodian/Maintenance Personnel still report
      // issues, and a ticket's "From Issue Report #N" link still opens one.
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
      ['users', 'User Management'],
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
    // screen. 'myTasks' stays a tabbed container (Repair Verification / Work
    // Tracker — see renderModule's tab bar; the old Assigned Inspections tab
    // was removed since inspection is no longer part of the live workflow).
    // Neither key has its own moduleEndpoints entry — both are pure
    // navigation/presentation wrappers around shared components/data.
    { section: 'Vehicle Operations', icon: 'checkCircle', items: [
      ['reportOrPropose', 'Report Vehicle Issue'],
      ['myTasks', 'My Tasks'],
      ['conditions', 'Condition Monitoring'],
    ] },
    { section: 'Maintenance', icon: 'calendar', items: [
      ['schedules', 'Maintenance Schedule'],
      // Same single ledger Admin sees now — the separate "Needs
      // Verification" tab/page was removed; a Custodian's Verify action is
      // now a row-level button in this same table (see maintenanceColumns'
      // record.verify branch), matching Admin's "no tabs" reference design.
      ['maintenance', 'Maintenance Records'],
    ] },
  ],
  'Maintenance Personnel': [
    // "View Vehicles" used to sit alone under its own collapsible "Vehicles"
    // section — a dropdown for exactly one row. With nothing else ever
    // likely to join it (see the removed-items notes below), it's a plain
    // top-level item next to Dashboard instead, same as the un-sectioned
    // group above.
    { section: null, items: [['dashboard', 'Dashboard'], ['vehicles', 'View Vehicles']] },
    { section: 'Maintenance', icon: 'wrench', items: [
      // Work Tracker used to be its own sidebar entry/page here — merged
      // into My Work Orders as an in-page Archive toggle (mirrors Admin's
      // Maintenance Tickets "Archives" button) so this role has one ticket
      // page instead of two. Custodian's own My Tasks -> History tab still
      // uses the WorkTrackerModule component this used to route to — only
      // this role's standalone entry point was removed.
      ['ticketWorkOrders', 'My Work Orders'],
      ['maintenance', 'Maintenance Records'],
      ['schedules', 'Maintenance Schedule'],
    ] },
    // "Vehicle Issues" removed per product direction — redundant for this
    // role (not necessary; a mechanic's own ticket/work-order flow already
    // captures what's wrong with a vehicle). issue.create still lists
    // Maintenance Personnel in config/permissions.php for now, just with no
    // UI entry point left to reach it from.
    // No standalone "Vehicle Documents" sidebar item for any role — the
    // module lives only on the vehicle profile's own Files card now
    // (document.view/.create abilities). Maintenance Personnel reaches it
    // the same way: open a vehicle from View Vehicles above.
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

// Mirrors User::canRegisterVehicles() on the backend. Vehicle registration
// is a standard Custodian duty now — the per-account can_register_vehicles
// delegation flag is no longer required (kept in the data model for history,
// just not read here anymore).
export function canRegisterVehicles(user) {
  return hasRole(user, 'Admin') || hasRole(user, 'Custodian');
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
