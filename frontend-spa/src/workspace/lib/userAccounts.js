// Account status + role helpers shared by the Users table, cards and profile.
import { formatDate } from './format';

// A self-registration nobody has approved yet: never approved AND not active.
// (Accounts an Admin creates directly are active but may have no approved_at.)
export function isPendingRegistration(user) {
  return !user?.approved_at && !user?.is_active;
}

// { key, label, detail } — label is what the badge says, detail the one-line
// context next to it (when approved / when registered).
export function accountStatus(user) {
  if (isPendingRegistration(user)) {
    return { key: 'pending', label: 'Pending', detail: `Registered ${formatDate(user?.created_at)} · awaiting approval` };
  }
  const approved = user?.approved_at ? `Approved ${formatDate(user.approved_at)}` : 'Created by an Admin';
  if (user?.is_active === false) {
    return { key: 'inactive', label: 'Inactive', detail: `${approved} · deactivated, cannot sign in` };
  }
  return { key: 'active', label: 'Active', detail: approved };
}

// `role` is the primary role (drives which portal the person lands in);
// `roles` holds every role the account may use.
export function splitRoles(user) {
  const all = (Array.isArray(user?.roles) && user.roles.length) ? user.roles : [user?.role].filter(Boolean);
  const primary = user?.role ?? all[0] ?? null;
  return { primary, additional: all.filter((r) => r !== primary) };
}
