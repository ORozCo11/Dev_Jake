import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/axios';
import Icon from '../components/Icon';
import WorkspaceFooter from '../components/WorkspaceFooter';
import ConfirmDialog from '../components/ConfirmDialog';
import { SidebarBackdrop, SidebarDrawerHead } from '../components/SidebarDrawerChrome';
import useResponsiveNav from '../hooks/useResponsiveNav';
import useCssHeightVar from '../hooks/useCssHeightVar';
import { BoundaryPreviewMap, DonutChart, HorizontalBarChart } from '../components/lazy';
import { AuthContext } from '../context/AuthContextObject';
import { geoJsonToRings } from '../utils/boundary';
import Modal from '../workspace/components/Modal';
import { PaginatedTable } from '../workspace/components/tables';
import { LocalSearchInput, StatusBadge, UserAvatarName } from '../workspace/components/ui';
import { formatDate } from '../workspace/lib/format';
import { getNotificationStyle } from '../workspace/lib/notifications';
import { roleRoutes } from '../workspace/lib/permissions';

const ROLES = ['Admin', 'Custodian', 'Maintenance Personnel'];

// Sectioned sidebar nav — mirrors the main Workspace's grouped module-nav
// pattern (collapsible sections, badge counts) instead of one flat list, so
// the two portals read as the same product. `section: null` renders with no
// header, same convention as the main app's Dashboard entry.
const NAV_GROUPS = [
  { section: null, items: [['dashboard', 'Dashboard']] },
  { section: 'Approvals', icon: 'clipboard', items: [
    ['pending', 'Pending Approvals'],
  ] },
  // Barangays folded into Dashboard (the full table, Add, and Recover all
  // live there now — see DashboardTab) rather than a separate stop.
  { section: 'Accounts', icon: 'grid', items: [
    ['users', 'All Users'],
    ['codes', 'Registration Codes'],
  ] },
  // Impersonate moved out of here into the topbar (next to the "vms"
  // wordmark) — it's a quick support action reached from any tab, not a
  // page you navigate to and stay on like the rest of this nav.
  { section: 'Support', icon: 'mail', items: [
    ['concerns', 'Concern Reports'],
  ] },
  { section: 'System', icon: 'key', items: [
    ['activity', 'Activity Log'],
  ] },
];

// Flat [key, label] list — used for the page-heading lookup and anywhere
// else that doesn't care about grouping.
const TABS = NAV_GROUPS.flatMap((g) => g.items);

const TAB_DESCRIPTIONS = {
  dashboard: 'Platform health, barangay coverage, and registration readiness at a glance.',
  pending: 'Review account requests and keep every barangay properly staffed.',
  users: 'Manage platform users, roles, and account availability by location.',
  codes: 'Create or refresh the staff registration code for each barangay.',
  concerns: 'Track and resolve reports that need platform-level attention.',
  activity: 'A chronological record of platform and Super Admin activity.',
  settings: 'Manage your Super Admin account settings and security.',
};

const CONCERN_TYPE_LABELS = {
  'Barangay Inactive': "Barangay seems inactive",
  'Suspected Fake Staff': "Suspected fake staff",
  'Other': 'Other',
};

function UsersIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

const TAB_ICONS = {
  dashboard: <Icon name="grid" size={18} className="nav-icon" />,
  pending: <Icon name="clipboard" size={18} className="nav-icon" />,
  users: <UsersIcon />,
  codes: <Icon name="key" size={18} className="nav-icon" />,
  concerns: <Icon name="mail" size={18} className="nav-icon" />,
  activity: <Icon name="clipboard" size={18} className="nav-icon" />,
  settings: <Icon name="key" size={18} className="nav-icon" />,
};

function ProfileMenu({ user, open, setOpen, onOpenSettings, onLogout }) {
  const initials = user.name ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'U';
  return (
    <>
      <button className="profile-menu-trigger" type="button" onClick={() => setOpen((v) => !v)} aria-label="Account menu">
        <span className="profile-menu-avatar">{initials}</span>
      </button>
      {open && (
        <div className="profile-menu-dropdown">
          <div className="profile-menu-user">
            <span className="profile-menu-avatar">{initials}</span>
            <div className="profile-menu-user-info">
              <span className="profile-menu-name">{user.name}</span>
              <span className="profile-menu-role">{user.role}</span>
            </div>
          </div>
          <div className="profile-menu-divider" />
          <button className="profile-menu-item" type="button" onClick={() => { onOpenSettings(); setOpen(false); }}>
            <Icon name="key" size={15} /> My Settings
          </button>
          <div className="profile-menu-divider" />
          <button className="profile-menu-item profile-menu-item-danger" type="button" onClick={onLogout}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Logout
          </button>
        </div>
      )}
    </>
  );
}

// Mirrors DashboardSignalCard from Workspace.jsx (icon chip, chevron-when-
// clickable, value, one-line detail, progress meter) so this portal's
// dashboard reads as the same component family as the main app's.
function SignalCard({ icon, label, value, detail, tone = '', meter, onClick }) {
  const content = (
    <>
      <div className="dashboard-signal-card-head">
        <span className="dashboard-signal-card-icon"><Icon name={icon} size={16} /></span>
        <span>{label}</span>
        {onClick && <Icon name="chevronRight" size={14} className="dashboard-signal-card-chevron" />}
      </div>
      <strong>{value}</strong>
      {detail && <p>{detail}</p>}
      {typeof meter === 'number' && (
        <span className="dashboard-signal-meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, meter))}%` }} />
        </span>
      )}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`dashboard-signal-card ${tone}`} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <article className={`dashboard-signal-card ${tone}`}>{content}</article>;
}

// The Super Admin landing page — barangay-centric by design (see the
// removed standalone Barangays tab, folded in here): stat cards, a
// snapshot of two charts that follow the same filters as the grid below,
// clickable filter-tabs, a search/filter row, and the full barangay table
// with Add/Recover — one page, same shape as a "records in the market"
// overview page rather than scattered across separate tabs.
function DashboardTab({ barangays, users, pendingApprovals, concernReports, onPromote, onAddedBarangay, onRetryBoundary, onConfirmBoundary, onDiscardBoundary, onNavigate }) {
  // Tracks which rows have a retry in flight, purely so the button can show
  // "Checking…" and not be double-clicked — the lookup itself takes a couple
  // seconds (it can make two sequential OSM requests, see lookupBoundary()).
  const [retryingBoundaryId, setRetryingBoundaryId] = useState(null);
  const retryBoundary = async (b) => {
    setRetryingBoundaryId(b.id);
    try {
      await onRetryBoundary(b);
    } finally {
      setRetryingBoundaryId(null);
    }
  };
  // The barangay currently open in the boundary review modal, if any.
  const [reviewingBoundary, setReviewingBoundary] = useState(null);

  const orphaned = barangays.filter((b) => !b.has_active_admin);
  const needsBoundaryReview = barangays.filter((b) => b.boundary_status === 'needs_review');
  const openConcerns = concernReports.filter((r) => r.status !== 'Resolved').length;
  const activeUsers = users.filter((u) => u.is_active).length;
  const pendingCount = pendingApprovals.length;

  const cards = [
    {
      key: 'pending', label: 'Pending Approvals', value: pendingCount, icon: 'clipboard',
      tone: pendingCount > 0 ? 'is-warn' : 'is-ok',
      detail: pendingCount > 0 ? 'Awaiting your review' : 'All caught up',
      meter: Math.min(100, pendingCount * 20), goto: 'pending',
    },
    {
      key: 'barangays', label: 'Barangays', value: barangays.length, icon: 'pin', tone: '',
      detail: `${barangays.length - orphaned.length} with an active Admin`,
      meter: barangays.length ? ((barangays.length - orphaned.length) / barangays.length) * 100 : 0,
    },
    {
      key: 'orphaned', label: 'Orphaned Barangays', value: orphaned.length, icon: 'alert',
      tone: orphaned.length > 0 ? 'is-alert' : 'is-ok',
      detail: orphaned.length > 0 ? 'No active Admin — needs recovery' : 'Every barangay is covered',
      meter: barangays.length ? (orphaned.length / barangays.length) * 100 : 0,
    },
    {
      key: 'users', label: 'Total Users', value: users.length, icon: 'grid', tone: '',
      detail: `${activeUsers} active`,
      meter: users.length ? (activeUsers / users.length) * 100 : 0, goto: 'users',
    },
    {
      key: 'concerns', label: 'Open Concern Reports', value: openConcerns, icon: 'mail',
      tone: openConcerns > 0 ? 'is-warn' : 'is-ok',
      detail: openConcerns > 0 ? 'Needs a look' : 'Inbox clear',
      meter: Math.min(100, openConcerns * 20), goto: 'concerns',
    },
    {
      key: 'boundary', label: 'Needs Boundary Review', value: needsBoundaryReview.length, icon: 'pin',
      tone: needsBoundaryReview.length > 0 ? 'is-warn' : 'is-ok',
      detail: needsBoundaryReview.length > 0 ? 'A candidate boundary is awaiting confirmation' : 'Nothing waiting on review',
      meter: Math.min(100, needsBoundaryReview.length * 20),
      // Same-page filter, not a cross-tab goto — this row below the KPI
      // grid already does filtering for "Active"/"Orphaned"; this reuses it.
      onClick: () => setActiveFilter('boundary_review'),
    },
  ];

  // Filter-tabs + search/province filter — the grid's own filters, which
  // (like the reference page) the two snapshot charts above also follow.
  // Defaults to "Active Admin" — most barangays should be in this state day
  // to day, and Recover is an exception-handling action, not something that
  // needs to dominate the page. Orphaned barangays are still one click away
  // via the tab below.
  const [activeFilter, setActiveFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [provinceFilter, setProvinceFilter] = useState('');
  const [recoveryId, setRecoveryId] = useState(null);
  const [pickedUserId, setPickedUserId] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  const provinceOptions = useMemo(
    () => Array.from(new Set(barangays.map((b) => b.province_name).filter(Boolean))).sort(),
    [barangays],
  );

  const filteredBarangays = useMemo(() => {
    let rows = barangays;
    if (activeFilter === 'active') rows = rows.filter((b) => b.has_active_admin);
    if (activeFilter === 'orphaned') rows = rows.filter((b) => !b.has_active_admin);
    if (activeFilter === 'boundary_review') rows = rows.filter((b) => b.boundary_status === 'needs_review');
    if (provinceFilter) rows = rows.filter((b) => b.province_name === provinceFilter);
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((b) => [b.name, b.city_name, b.province_name].filter(Boolean).some((v) => v.toLowerCase().includes(q)));
    return rows;
  }, [barangays, activeFilter, provinceFilter, search]);

  const provinceRows = useMemo(() => {
    const byProvince = new Map();
    filteredBarangays.forEach((b) => {
      const key = b.province_name ?? 'Unassigned';
      byProvince.set(key, (byProvince.get(key) ?? 0) + 1);
    });
    return Array.from(byProvince.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [filteredBarangays]);

  const filteredOrphaned = filteredBarangays.filter((b) => !b.has_active_admin).length;
  const coverageSegments = [
    { label: 'Active Admin', value: filteredBarangays.length - filteredOrphaned, color: '#16a34a' },
    { label: 'Orphaned', value: filteredOrphaned, color: '#dc2626' },
  ];

  const columns = [
    { label: 'Barangay', render: (b) => (
      <span className="approval-card-location"><Icon name="pin" size={14} /><span>{b.name}</span></span>
    ) },
    { label: 'City / Province', render: (b) => `${b.city_name ?? '-'} · ${b.province_name ?? '-'}` },
    { label: 'Staff', render: (b) => b.staff_count },
    { label: 'Admin Status', render: (b) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <StatusBadge value={b.has_active_admin ? 'Active Admin' : 'Orphaned'} />
        {/* Phase A4 — one departure away from Orphaned: GuardsLastAdmin
            blocks that departure from happening through deactivate/role-
            change, but not this Admin simply leaving with no successor
            ever promoted. */}
        {b.sole_active_admin && (
          <span className="sole-admin-flag" title="Only one active Admin — promote a backup before this barangay risks becoming orphaned.">
            <Icon name="alert" size={13} />
          </span>
        )}
      </span>
    ) },
    // Reg. Code / Boundary — the two other things that make a barangay
    // fully usable (staff can't register at all without a code; the
    // Vehicle Location map can't draw it without a boundary) but neither
    // is visible anywhere else on this page.
    { label: 'Reg. Code', className: 'cell-center', render: (b) => (
      b.has_registration_code
        ? <span className="status-badge good" title="A staff registration code has been generated."><Icon name="key" size={11} /> On file</span>
        : <span className="muted">Not yet</span>
    ) },
    { label: 'Boundary', className: 'cell-center', render: (b) => (
      b.boundary_status === 'needs_review'
        ? (
          <button
            type="button"
            className="status-badge pending"
            style={{ border: 'none', cursor: 'pointer' }}
            title="A candidate boundary was found and is waiting for your review before it becomes the barangay's official shape."
            onClick={() => setReviewingBoundary(b)}
          >
            <Icon name="alert" size={11} /> Needs Review
          </button>
        )
        : b.boundary_status === 'verified'
          ? <span className="status-badge good" title="A reviewed and confirmed boundary polygon is on file."><Icon name="pin" size={11} /> Verified</span>
          : (
            <button
              type="button"
              className="ghost-button"
              disabled={retryingBoundaryId === b.id}
              title="No boundary matched when this barangay was added — try the lookup again."
              onClick={() => retryBoundary(b)}
            >
              {retryingBoundaryId === b.id ? 'Checking…' : 'Not Found · Retry'}
            </button>
          )
    ) },
    { label: 'Action', render: (b) => (
      !b.has_active_admin ? (
        <button
          type="button"
          className="ghost-button"
          onClick={() => { setRecoveryId(recoveryId === b.id ? null : b.id); setPickedUserId(''); }}
        >
          {recoveryId === b.id ? 'Cancel' : 'Recover'}
        </button>
      ) : <span className="muted">-</span>
    ) },
  ];

  const recoveryBarangay = barangays.find((b) => b.id === recoveryId);
  const candidateUsers = recoveryBarangay ? users.filter((u) => u.barangay_id === recoveryBarangay.id) : [];

  return (
    <div className="superadmin-tab superadmin-dashboard">
      <div className="dashboard-signal-grid">
        {cards.map((c) => (
          <SignalCard
            key={c.key}
            icon={c.icon}
            label={c.label}
            value={c.value}
            detail={c.detail}
            tone={c.tone}
            meter={c.meter}
            onClick={c.onClick ?? (c.goto ? () => onNavigate(c.goto) : undefined)}
          />
        ))}
      </div>

      <div className="superadmin-snapshot-head">
        <h3>Barangay snapshot</h3>
        <span className="muted">{filteredBarangays.length} matching barangays · Charts follow the filters below</span>
      </div>
      <div className="superadmin-dashboard-row">
        <div className="superadmin-dashboard-panel">
          <h4>Barangays by Province</h4>
          <p className="superadmin-panel-subtitle">Number of barangays</p>
          <HorizontalBarChart rows={provinceRows} />
        </div>
        <div className="superadmin-dashboard-panel">
          <h4>Admin Coverage</h4>
          <p className="superadmin-panel-subtitle">Share of barangays by Admin status</p>
          <div className="superadmin-dashboard-donut-row">
            <DonutChart segments={coverageSegments} centerLabel={filteredBarangays.length} centerSubLabel="barangays" />
            <ul className="chart-legend">
              {coverageSegments.map((s) => (
                <li key={s.label}>
                  <span style={{ '--legend-color': s.color }}></span>
                  <small>{s.label}</small>
                  <strong>{s.value}</strong>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="superadmin-filter-tabs">
        <button type="button" className={activeFilter === 'all' ? 'active' : ''} onClick={() => setActiveFilter('all')}>
          All Barangays <span>{barangays.length}</span>
        </button>
        <button type="button" className={activeFilter === 'active' ? 'active' : ''} onClick={() => setActiveFilter('active')}>
          Active Admin <span>{barangays.length - orphaned.length}</span>
        </button>
        <button type="button" className={activeFilter === 'orphaned' ? 'active' : ''} onClick={() => setActiveFilter('orphaned')}>
          Orphaned <span>{orphaned.length}</span>
        </button>
        <button type="button" className={activeFilter === 'boundary_review' ? 'active' : ''} onClick={() => setActiveFilter('boundary_review')}>
          Needs Boundary Review <span>{needsBoundaryReview.length}</span>
        </button>
      </div>

      <div className="superadmin-grid-toolbar">
        <LocalSearchInput value={search} onChange={setSearch} placeholder="Search barangay, city, or province..." />
        <select value={provinceFilter} onChange={(e) => setProvinceFilter(e.target.value)} aria-label="Filter by province">
          <option value="">All Provinces</option>
          {provinceOptions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button type="button" className="primary-button" onClick={() => setShowAddForm((v) => !v)}>
          <Icon name="plus" size={14} /> {showAddForm ? 'Cancel' : 'Add Barangay'}
        </button>
      </div>

      {showAddForm && (
        <AddBarangayForm
          onAdded={(created) => { onAddedBarangay(created); setShowAddForm(false); }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <PaginatedTable emptyCellValue="-" columns={columns} rows={filteredBarangays} emptyMessage="No barangays match these filters." />

      {recoveryBarangay && (
        <div className="location-form-panel superadmin-panel-spaced">
          <h3>Recover {recoveryBarangay.name}</h3>
          {candidateUsers.length === 0 ? (
            <p className="muted">No staff registered here yet — there's nobody to promote.</p>
          ) : (
            <>
              <p className="muted superadmin-muted-block">
                Pick an existing user in {recoveryBarangay.name} to promote to Admin. If their account is inactive, it will also be activated.
              </p>
              <div className="superadmin-inline-row">
                <select value={pickedUserId} onChange={(e) => setPickedUserId(e.target.value)} aria-label="User to promote to Admin">
                  <option value="">Select a user</option>
                  {candidateUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.name} · {u.role}{u.is_active ? '' : ' (inactive)'}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!pickedUserId}
                  onClick={async () => {
                    const target = candidateUsers.find((u) => String(u.id) === String(pickedUserId));
                    await onPromote(target);
                    setRecoveryId(null);
                  }}
                >
                  Promote to Admin
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {reviewingBoundary && (
        <BoundaryReviewModal
          barangay={reviewingBoundary}
          onClose={() => setReviewingBoundary(null)}
          onConfirm={async () => { await onConfirmBoundary(reviewingBoundary); setReviewingBoundary(null); }}
          onDiscard={async () => { await onDiscardBoundary(reviewingBoundary); setReviewingBoundary(null); }}
        />
      )}
    </div>
  );
}

// Final stabilization (§33.2/§33.3) — a found boundary candidate is never
// auto-accepted. This lets a Super Admin actually see the shape before it
// becomes the barangay's official boundary — a text "Boundary found" is not
// enough to judge whether a polygon is actually usable. Reuses the same
// react-leaflet primitives and geoJsonToRings() helper the fleet map already
// uses — no new geospatial code.
function BoundaryReviewModal({ barangay, onClose, onConfirm, onDiscard }) {
  const [busy, setBusy] = useState(false);
  const rings = useMemo(() => geoJsonToRings(barangay.pending_boundary), [barangay.pending_boundary]);
  const allPoints = rings.flat();
  const center = allPoints.length
    ? [allPoints.reduce((s, p) => s + p[0], 0) / allPoints.length, allPoints.reduce((s, p) => s + p[1], 0) / allPoints.length]
    : [10.3, 123.9];

  const [action, setAction] = useState(null);
  const run = async (kind, fn) => {
    setBusy(true);
    setAction(kind);
    try { await fn(); } finally { setBusy(false); setAction(null); }
  };
  const place = [barangay.name, barangay.city_name, barangay.province_name].filter(Boolean).join(', ');

  return (
    <Modal
      title={`Review Boundary — ${barangay.name}`}
      onClose={onClose}
      boxStyle={{ maxWidth: 560 }}
      closeOnOverlay={!busy}
      closeOnEscape={!busy}
    >
      <p className="muted" style={{ margin: '0 0 10px' }}>
        <strong>{place}</strong> — candidate outline matched automatically from OpenStreetMap. It is <strong>not</strong> the
        official boundary until you confirm it.
        Confirm only if the shape below actually looks like {barangay.name}.
      </p>
      {rings.length === 0 ? (
        <p className="notice error" role="alert">This candidate&apos;s geometry couldn&apos;t be rendered — discard it and try again later.</p>
      ) : (
        <div style={{ height: 280, borderRadius: 8, overflow: 'hidden', border: '1px solid #e2e8f0' }}>
          <BoundaryPreviewMap center={center} rings={rings} />
        </div>
      )}
      <div className="form-actions" style={{ marginTop: 12 }}>
        <button type="button" className="ghost-button" disabled={busy} onClick={() => run('discard', onDiscard)}>
          {action === 'discard' ? 'Discarding…' : 'Discard'}
        </button>
        <button type="button" className="success-button" disabled={busy || rings.length === 0} onClick={() => run('confirm', onConfirm)}>
          {action === 'confirm' ? 'Confirming…' : 'Confirm Boundary'}
        </button>
      </div>
    </Modal>
  );
}

// The screen this whole role exists to guard: every account still waiting on
// approval. A first-time Admin for an otherwise-orphaned barangay is flagged
// distinctly — approving that specific case is what closes the registration
// hole (see AuthController::register()).
function PendingApprovalsTab({ approvals, barangays, onApprove, onReject, onRequestConfirmation }) {
  const [search, setSearch] = useState('');
  // Which barangay group is drilled into — null means "show the grouped
  // overview". Cleared whenever the underlying approvals list changes size
  // (e.g. the group you were looking at just got approved/rejected down to
  // zero), so you're never left staring at an empty drill-down.
  const [openBarangayKey, setOpenBarangayKey] = useState(null);

  const isFirstAdmin = useCallback((a) => {
    if (a.role !== 'Admin') return false;
    const b = barangays.find((x) => x.id === a.barangay_id);
    return !b || !b.has_active_admin;
  }, [barangays]);

  const sortByFirstAdmin = (rows) => [...rows].sort((a, b) => (isFirstAdmin(b) ? 1 : 0) - (isFirstAdmin(a) ? 1 : 0));

  // Grouped-by-barangay overview — the default view. One card per barangay
  // with at least one account waiting, not one card per account: a Super
  // Admin approving 6 accounts for the same barangay used to mean scrolling
  // past 6 near-identical cards to find the ones for a DIFFERENT barangay.
  const groups = useMemo(() => {
    const byKey = new Map();
    approvals.forEach((a) => {
      const key = a.barangay_id ?? `unassigned-${a.barangay_name ?? 'none'}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          barangay_name: a.barangay_name,
          city_name: a.city_name,
          province_name: a.province_name,
          accounts: [],
        });
      }
      byKey.get(key).accounts.push(a);
    });
    // Groups with a pending first-Admin float to the top — same priority
    // the old flat list gave individual first-Admin cards.
    return Array.from(byKey.values()).sort((a, b) => {
      const aFirst = a.accounts.some(isFirstAdmin) ? 1 : 0;
      const bFirst = b.accounts.some(isFirstAdmin) ? 1 : 0;
      return bFirst - aFirst || b.accounts.length - a.accounts.length;
    });
  }, [approvals, isFirstAdmin]);

  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        accounts: g.accounts.filter((a) =>
          [a.name, a.email, a.barangay_name].filter(Boolean).some((v) => v.toLowerCase().includes(q))
        ),
      }))
      .filter((g) => g.accounts.length > 0);
  }, [groups, search]);

  // Once the open group empties out (last account approved/rejected), forget
  // it — otherwise a later registration for that barangay would reopen it
  // on its own. Reset during render rather than in an effect.
  if (openBarangayKey && !groups.some((g) => g.key === openBarangayKey)) {
    setOpenBarangayKey(null);
  }
  const openGroup = visibleGroups.find((g) => g.key === openBarangayKey) ?? null;

  const requestReject = (a) => {
    onRequestConfirmation({
      title: 'Reject Registration',
      message: `Reject ${a.name}'s registration for ${a.barangay_name ?? 'their barangay'}? Their account is permanently deleted — this cannot be undone.`,
      confirmLabel: 'Reject & Delete',
      variant: 'danger',
      onConfirm: () => onReject(a),
    });
  };

  // A significant platform action (activating an account, sometimes the
  // very first Admin for a barangay) previously fired on one click with no
  // review step at all — asymmetric with Reject, which already confirms.
  const requestApprove = (a) => {
    onRequestConfirmation({
      title: 'Approve Registration',
      message: isFirstAdmin(a)
        ? `${a.name} will become ${a.barangay_name ?? 'this barangay'}'s first Admin — this activates a brand-new barangay account.`
        : `Approve ${a.name}'s registration for ${a.barangay_name ?? 'their barangay'} as ${a.role}?`,
      confirmLabel: 'Approve',
      variant: 'primary',
      onConfirm: () => onApprove(a),
    });
  };

  const renderAccountCard = (a) => (
    <article key={a.id} className={`approval-card${isFirstAdmin(a) ? ' is-first-admin' : ''}`}>
      <div className="approval-card-main">
        <UserAvatarName user={a} fallback="Unknown" />
      </div>
      <div className="approval-card-meta">
        <span className="approval-card-email">{a.email}</span>
        {a.phone && <span className="approval-card-phone">{a.phone}</span>}
      </div>
      <div className="approval-card-tags">
        <StatusBadge value={a.role} />
        {isFirstAdmin(a) && <span className="badge-first-admin">First Admin</span>}
      </div>
      <div className="approval-card-submitted muted">Submitted {formatDate(a.created_at)}</div>
      <div className="approval-card-actions">
        <button type="button" className="ghost-button" onClick={() => requestReject(a)}>Reject</button>
        <button type="button" className="primary-button" onClick={() => requestApprove(a)}>Approve</button>
      </div>
    </article>
  );

  return (
    <div className="superadmin-tab superadmin-pending-tab">
      <div className="panel-header-bar">
        <h3>
          {openGroup && (
            <button type="button" className="approval-group-back" onClick={() => setOpenBarangayKey(null)} aria-label="Back to barangays">
              <Icon name="arrowLeft" size={16} />
            </button>
          )}
          {openGroup ? (openGroup.barangay_name ?? 'Unassigned') : 'Pending Approvals'}{' '}
          <span className="count-badge">{openGroup ? openGroup.accounts.length : approvals.length}</span>
        </h3>
        {approvals.length > 0 && <LocalSearchInput value={search} onChange={setSearch} placeholder="Search name, email, or barangay..." />}
      </div>
      <p className="muted superadmin-muted-block">
        {openGroup
          ? `Accounts waiting on approval for ${[openGroup.barangay_name, openGroup.city_name, openGroup.province_name].filter(Boolean).join(', ') || 'this barangay'}.`
          : 'Every barangay with an account waiting on approval. A barangay whose first Admin is pending is flagged and floats to the top — approving them is what lets that barangay actually be used.'}
      </p>

      {!approvals.length ? (
        <p className="empty-state">No accounts are waiting on approval right now.</p>
      ) : openGroup ? (
        <div className="approval-card-list">
          {sortByFirstAdmin(openGroup.accounts).map(renderAccountCard)}
        </div>
      ) : (
        <div className="approval-group-list">
          {visibleGroups.map((g) => {
            const groupIsFirstAdmin = g.accounts.some(isFirstAdmin);
            return (
              <button
                key={g.key}
                type="button"
                className={`approval-group-card${groupIsFirstAdmin ? ' is-first-admin' : ''}`}
                onClick={() => setOpenBarangayKey(g.key)}
              >
                <div className="approval-group-card-location">
                  <Icon name="pin" size={16} />
                  <div>
                    <strong>{g.barangay_name ?? 'Unassigned'}</strong>
                    <span className="muted">{[g.city_name, g.province_name].filter(Boolean).join(', ') || '—'}</span>
                  </div>
                </div>
                <div className="approval-group-card-tags">
                  {groupIsFirstAdmin && <span className="badge-first-admin">First Admin pending</span>}
                  <span className="count-badge">{g.accounts.length} waiting</span>
                </div>
                <Icon name="chevronRight" size={18} className="approval-group-card-chevron" />
              </button>
            );
          })}
          {visibleGroups.length === 0 && <p className="empty-state">No matches.</p>}
        </div>
      )}
    </div>
  );
}

// Province -> City -> name — lets a Super Admin add a barangay for ANY LGU
// up front, not just the ones with a seeded list, so a registration code
// can be generated and handed out before that barangay's first resident
// ever registers (RegistrationSetting::for() auto-creates the code the
// first time it's looked up — see SuperAdminController::storeBarangay).
// /provinces and /cities?province_id= are the same public, unscoped
// nationwide lists — not the registration form's narrower
// /provinces/with-barangays, which only lists provinces that already have
// real barangay data.
function AddBarangayForm({ onAdded, onCancel }) {
  const [provinces, setProvinces] = useState([]);
  const [cities, setCities] = useState([]);
  const [provinceId, setProvinceId] = useState('');
  const [cityId, setCityId] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/provinces').then((res) => setProvinces(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!provinceId) return undefined;
    let cancelled = false;
    api.get('/cities', { params: { province_id: provinceId } })
      .then((res) => { if (!cancelled) setCities(res.data); })
      .catch(() => { if (!cancelled) setCities([]); });
    return () => { cancelled = true; };
  }, [provinceId]);

  const submit = async (e) => {
    e.preventDefault();
    if (!cityId || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post('/superadmin/barangays', { city_id: cityId, name: name.trim() });
      onAdded(res.data);
    } catch (err) {
      setError(err.response?.data?.message ?? 'Something went wrong — please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="location-form-panel superadmin-panel-spaced" onSubmit={submit}>
      <h3>Add Barangay</h3>
      <p className="muted superadmin-muted-block">
        Creates the barangay immediately — a registration code can be generated for it right after, from Registration Codes.
      </p>
      {error && <p className="muted" style={{ color: '#dc2626' }}>{error}</p>}
      <div className="superadmin-inline-row">
        <select value={provinceId} onChange={(e) => { setProvinceId(e.target.value); setCities([]); setCityId(''); }} required aria-label="Province">
          <option value="">Province</option>
          {provinces.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={cityId} onChange={(e) => setCityId(e.target.value)} disabled={!provinceId} required aria-label="City or municipality">
          <option value="">City / Municipality</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Barangay name"
          disabled={!cityId}
          required
        />
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary-button" disabled={saving || !cityId || !name.trim()}>
          {saving ? 'Adding…' : 'Add'}
        </button>
      </div>
    </form>
  );
}

function UsersTab({ users, onChangeRole, onToggleActive }) {
  const [search, setSearch] = useState('');

  // `users` here is already the Super-Admin-excluded list computed once at
  // the parent (see `visibleUsers` in SuperAdminWorkspace) — DashboardTab
  // consumes the same filtered list so its counts never drift from this
  // tab's count badge.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => [u.name, u.email, u.barangay_name].filter(Boolean).some((v) => v.toLowerCase().includes(q)));
  }, [users, search]);

  // Province -> Barangay -> users. A flat table of every account across
  // every barangay got unusable the moment more than one LGU had real
  // staff (which barangay a name belongs to stopped being scannable) —
  // grouped the same way Impersonate's own province/barangay picker
  // already does, just rendered as collapsible sections instead of
  // cascading <select>s.
  const provinceGroups = useMemo(() => {
    const byProvince = new Map();
    visible.forEach((u) => {
      const pKey = u.province_name ?? 'Unassigned';
      const bKey = u.barangay_name ?? 'Unassigned';
      if (!byProvince.has(pKey)) byProvince.set(pKey, new Map());
      const byBarangay = byProvince.get(pKey);
      if (!byBarangay.has(bKey)) byBarangay.set(bKey, []);
      byBarangay.get(bKey).push(u);
    });
    return Array.from(byProvince.entries())
      .map(([province, byBarangay]) => ({
        province,
        barangayGroups: Array.from(byBarangay.entries())
          .map(([barangay, rows]) => ({ barangay, rows }))
          .sort((a, b) => a.barangay.localeCompare(b.barangay)),
        total: Array.from(byBarangay.values()).reduce((sum, rows) => sum + rows.length, 0),
      }))
      .sort((a, b) => a.province.localeCompare(b.province));
  }, [visible]);

  const columns = [
    { label: 'Name', render: (u) => (
      <div>
        <UserAvatarName user={u} fallback="Unknown" />
        <div className="muted" style={{ fontSize: '0.76rem', marginTop: 2 }}>{u.email}</div>
      </div>
    ) },
    { label: 'Role', render: (u) => (
      <select value={u.role} onChange={(e) => onChangeRole(u, e.target.value)} aria-label={`Role for ${u.name}`}>
        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
    ) },
    { label: 'Status', render: (u) => (
      <StatusBadge value={!u.approved_at ? 'Pending' : (u.is_active ? 'Active' : 'Inactive')} />
    ) },
    { label: 'Action', render: (u) => (
      <button type="button" className="ghost-button" onClick={() => onToggleActive(u)}>
        {u.is_active ? 'Deactivate' : 'Activate'}
      </button>
    ) },
  ];

  return (
    <div className="superadmin-tab superadmin-users-tab">
      <div className="panel-header-bar">
        <h3>All Users <span className="count-badge">{visible.length}</span></h3>
        <LocalSearchInput value={search} onChange={setSearch} placeholder="Search name, email, or barangay..." />
      </div>

      {!visible.length ? (
        <p className="empty-state">No users found.</p>
      ) : (
        <div className="users-province-groups">
          {provinceGroups.map((pg) => (
            <details key={pg.province} className="users-province-group" open>
              <summary>
                <Icon name="grid" size={15} />
                <span>{pg.province}</span>
                <span className="count-badge">{pg.total}</span>
              </summary>
              {pg.barangayGroups.map((bg) => (
                <details key={bg.barangay} className="users-barangay-group" open>
                  <summary>
                    <Icon name="pin" size={13} />
                    <span>{bg.barangay}</span>
                    <span className="count-badge">{bg.rows.length}</span>
                  </summary>
                  <PaginatedTable emptyCellValue="-" columns={columns} rows={bg.rows} initialPageSize={10} pageSizeOptions={[10, 25, 50]} />
                </details>
              ))}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function RegistrationCodesTab({ barangays, onRequestConfirmation, setNotice }) {
  // Province -> City -> Barangay cascade. Province/City are the full
  // nationwide PSGC lists (same /provinces + /cities?province_id= as
  // AddBarangayForm) — NOT derived from `barangays`, which only has
  // whichever province/city a barangay already exists in. Without this, a
  // Super Admin could never reach a new area to hand out its very first
  // code: barangays only ever get created via "Add new" below or the
  // Dashboard's Add Barangay, so a brand-new city always starts with zero.
  const [provinces, setProvinces] = useState([]);
  const [cities, setCities] = useState([]);
  const [provinceId, setProvinceId] = useState('');
  const [cityId, setCityId] = useState('');
  // Barangay is a typed field (with suggestions), not a closed <select> —
  // this doubles as both "pick an existing one" and "name a new one" in a
  // single box, instead of two separate widgets for the same field.
  const [barangayId, setBarangayId] = useState('');
  const [code, setCode] = useState(null);
  const [codeUpdatedAt, setCodeUpdatedAt] = useState(null);
  const [loadingCode, setLoadingCode] = useState(false);

  useEffect(() => {
    api.get('/provinces').then((res) => setProvinces(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!provinceId) return undefined;
    let cancelled = false;
    api.get('/cities', { params: { province_id: provinceId } })
      .then((res) => { if (!cancelled) setCities(res.data); })
      .catch(() => { if (!cancelled) setCities([]); });
    return () => { cancelled = true; };
  }, [provinceId]);
  // Guards against out-of-order responses: switching barangays quickly can
  // leave an earlier, slower request resolving after a later one — this
  // tracks which barangay is the CURRENT request so a stale response (for a
  // barangay we've since navigated away from) is ignored instead of
  // clobbering what's on screen.
  const requestedIdRef = useRef(null);

  const loadCode = useCallback(async (id) => {
    requestedIdRef.current = id;
    if (!id) { setCode(null); setCodeUpdatedAt(null); return; }
    setLoadingCode(true);
    try {
      const res = await api.get(`/superadmin/barangays/${id}/registration-code`);
      if (requestedIdRef.current !== id) return; // a newer request has since been made
      setCode(res.data.staff_code);
      setCodeUpdatedAt(res.data.updated_at);
    } catch {
      if (requestedIdRef.current !== id) return;
      setCode(null);
      setCodeUpdatedAt(null);
    } finally {
      if (requestedIdRef.current === id) setLoadingCode(false);
    }
  }, []);

  const regenerate = () => {
    if (!barangayId) return;
    onRequestConfirmation({
      title: 'Regenerate Registration Code',
      message: 'Regenerate this code? The old one stops working immediately.',
      confirmLabel: 'Regenerate',
      variant: 'danger',
      onConfirm: async () => {
        setLoadingCode(true);
        try {
          const res = await api.post(`/superadmin/barangays/${barangayId}/registration-code/regenerate`);
          setCode(res.data.staff_code);
          setCodeUpdatedAt(res.data.updated_at);
        } catch (error) {
          setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not regenerate that code.' });
        } finally {
          setLoadingCode(false);
        }
      },
    });
  };

  const selectedCity = cities.find((c) => String(c.id) === String(cityId));
  // `barangays` only carries city_name/province_name (no city_id — see
  // SuperAdminController::barangays()), so matching a fetched city back to
  // the ones that already have a real row here has to go by name, same as
  // the cascade above it did before this rewrite.
  const barangayOptions = useMemo(
    () => selectedCity
      ? barangays.filter((b) => b.city_name === selectedCity.name).sort((a, b) => a.name.localeCompare(b.name))
      : [],
    [barangays, selectedCity],
  );
  // Does what's currently typed already exist in this city? Drives whether
  // typing resolves an existing barangay's code, or offers to create a new
  // one — the same box does both, no separate "pick" vs "add new" widgets.
  return (
    <div className="superadmin-tab superadmin-codes-tab">
      <div className="panel-header-bar">
        <h3>Registration Codes</h3>
      </div>
      <div className="location-form-panel">
        <div className="superadmin-inline-row">
          <label className="auth-field" style={{ maxWidth: 220 }}>
            <span>Province</span>
            <select
              value={provinceId}
              onChange={(e) => { setProvinceId(e.target.value); setCities([]); setCityId(''); setBarangayId(''); setCode(null); setCodeUpdatedAt(null); }}
            >
              <option value="">Select a province</option>
              {provinces.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="auth-field" style={{ maxWidth: 220 }}>
            <span>City / Municipality</span>
            <select
              value={cityId}
              disabled={!provinceId}
              onChange={(e) => { setCityId(e.target.value); setBarangayId(''); setCode(null); setCodeUpdatedAt(null); }}
            >
              <option value="">{provinceId ? 'Select a city' : 'Select a province first'}</option>
              {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="auth-field" style={{ maxWidth: 220 }}>
            <span>Barangay</span>
            {/* A typed field, not a closed <select> — the datalist offers
                existing barangays in this city as suggestions while typing,
                but any other name typed here is treated as a NEW barangay
                to add (see the "Add" button below), not an invalid choice. */}
            <select
              value={barangayId}
              disabled={!cityId}
              onChange={(e) => {
                const id = e.target.value;
                setBarangayId(id);
                loadCode(id);
              }}
            >
              <option value="">{cityId ? 'Select a barangay' : 'Select a city first'}</option>
              {barangayOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        </div>

        {barangayId && (
          <div className="superadmin-panel-spaced">
            {loadingCode ? (
              <p className="muted">Loading…</p>
            ) : code ? (
              <div className="superadmin-inline-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="superadmin-code-chip">{code}</span>
                {codeUpdatedAt && <span className="muted" style={{ fontSize: '0.8rem' }}>Last changed {formatDate(codeUpdatedAt)}</span>}
                <button type="button" className="ghost-button" onClick={regenerate}>Regenerate</button>
              </div>
            ) : (
              <p className="muted">Could not load this barangay's code.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Was its own full-page sidebar tab; now inline in the topbar, right beside
// the "vms" wordmark — three plain cascading <select>s (Province, Barangay,
// Staff) + a button, same visual language and layout as the main Workspace's
// own topbar picker (map-boundary-selector + dev-impersonate — see
// Workspace.jsx), just always-on here instead of DEV-gated, since
// impersonation is a real Super Admin feature, not a debug tool. Deliberately
// NOT a click-to-open popover — always visible, matching that reference.
function ImpersonateInline({ candidates, onImpersonate }) {
  const [provinceKey, setProvinceKey] = useState('');
  const [barangayKey, setBarangayKey] = useState('');
  const [userId, setUserId] = useState('');
  // Phase A5 — a written reason is required before impersonating anyone
  // (support/recovery only, never idle browsing), and appears in both the
  // target barangay's Activity Log and the Super Admin's own account log.
  const [reason, setReason] = useState('');

  const groups = useMemo(() => {
    const byProvince = new Map();
    candidates.filter((c) => c.role !== 'Super Admin').forEach((c) => {
      const pKey = c.province_name ?? 'Unassigned';
      const bKey = c.barangay_name ?? 'Unassigned';
      if (!byProvince.has(pKey)) byProvince.set(pKey, new Map());
      const byBarangay = byProvince.get(pKey);
      if (!byBarangay.has(bKey)) byBarangay.set(bKey, []);
      byBarangay.get(bKey).push(c);
    });
    return byProvince;
  }, [candidates]);

  const barangayOptions = provinceKey ? Array.from(groups.get(provinceKey)?.keys() ?? []) : [];
  const staffOptions = (provinceKey && barangayKey) ? (groups.get(provinceKey)?.get(barangayKey) ?? []) : [];

  return (
    <>
      <div className="map-boundary-selector" title="Pick a province and barangay to see its staff.">
        <select
          aria-label="Impersonate province"
          value={provinceKey}
          onChange={(e) => { setProvinceKey(e.target.value); setBarangayKey(''); setUserId(''); }}
        >
          <option value="">Province</option>
          {Array.from(groups.keys()).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          aria-label="Impersonate barangay"
          value={barangayKey}
          disabled={!provinceKey}
          onChange={(e) => { setBarangayKey(e.target.value); setUserId(''); }}
        >
          <option value="">Barangay</option>
          {barangayOptions.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
      <div className="dev-impersonate" title="Impersonate a staff account for support or account recovery. Read-only, expires in 30 minutes, and is logged.">
        <select
          aria-label="Impersonate staff"
          value={userId}
          disabled={!barangayKey}
          onChange={(e) => setUserId(e.target.value)}
        >
          <option value="">Staff</option>
          {staffOptions.map((u) => (
            <option key={u.id} value={u.id} disabled={!u.is_active}>{u.name} · {u.role}{u.is_active ? '' : ' (inactive)'}</option>
          ))}
        </select>
        {userId && (
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required)"
            aria-label="Reason for impersonating"
            style={{ width: 180 }}
          />
        )}
        <button
          type="button"
          disabled={!userId || !reason.trim()}
          onClick={() => { onImpersonate(userId, reason.trim()); setReason(''); }}
        >
          Impersonate
        </button>
      </div>
    </>
  );
}

function ConcernReportsTab({ reports, onResolve, onReopen, onDelete, onRequestConfirmation }) {
  const [scope, setScope] = useState('open');
  const visible = scope === 'open' ? reports.filter((r) => r.status !== 'Resolved') : reports;

  const requestDelete = (report) => {
    onRequestConfirmation({
      title: 'Delete Concern Report',
      message: 'Delete this concern report permanently? This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: () => onDelete(report),
    });
  };

  const columns = [
    { label: 'Type', render: (r) => CONCERN_TYPE_LABELS[r.concern_type] ?? r.concern_type },
    { label: 'Barangay', render: (r) => r.barangay_name || '-' },
    { label: 'Description', render: (r) => (
      <span className="superadmin-description-cell">{r.description}</span>
    ) },
    { label: 'Reported By', render: (r) => (
      <div>
        <div>{r.reporter_name || 'Anonymous'}</div>
        {r.reporter_contact && <div className="muted" style={{ fontSize: '0.76rem' }}>{r.reporter_contact}</div>}
      </div>
    ) },
    { label: 'Submitted', render: (r) => formatDate(r.created_at) },
    { label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
    { label: 'Action', render: (r) => (
      <div className="superadmin-inline-row">
        {r.status === 'Resolved' ? (
          <button type="button" className="ghost-button" onClick={() => onReopen(r)}>Reopen</button>
        ) : (
          <button type="button" className="ghost-button" onClick={() => onResolve(r)}>Mark Resolved</button>
        )}
        <button type="button" className="ghost-button" onClick={() => requestDelete(r)}>Delete</button>
      </div>
    ) },
  ];

  return (
    <div className="superadmin-tab superadmin-concerns-tab">
      <div className="locations-tab-bar">
        <button className={`locations-tab-button ${scope === 'open' ? 'active' : ''}`} onClick={() => setScope('open')} type="button">
          <Icon name="alert" size={16} /> Open
        </button>
        <button className={`locations-tab-button ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')} type="button">
          <Icon name="grid" size={16} /> All Reports
        </button>
      </div>
      <div className="panel-header-bar inline">
        <h3>Concern Reports <span className="count-badge">{visible.length}</span></h3>
      </div>
      <PaginatedTable emptyCellValue="-"
        columns={columns}
        rows={visible}
        emptyMessage={scope === 'open' ? 'No open concerns — all clear.' : 'No concern reports have been submitted yet.'}
      />
    </div>
  );
}

function ActivityLogTab({ entries }) {
  const [scope, setScope] = useState('all');
  const columns = [
    { label: 'Date', render: (e) => formatDate(e.created_at) },
    { label: 'By', render: (e) => e.user?.name ?? '-' },
    { label: 'Action', render: (e) => e.action },
    { label: 'Module', render: (e) => e.module },
    { label: 'Details', render: (e) => e.details },
  ];
  const visible = scope === 'mine' ? entries.filter((e) => e.module === 'Super Admin') : entries;

  return (
    <div className="superadmin-tab superadmin-activity-tab">
      <div className="locations-tab-bar">
        <button className={`locations-tab-button ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')} type="button">
          <Icon name="grid" size={16} /> Full Platform Log
        </button>
        <button className={`locations-tab-button ${scope === 'mine' ? 'active' : ''}`} onClick={() => setScope('mine')} type="button">
          <Icon name="key" size={16} /> Super Admin Actions Only
        </button>
      </div>
      <div className="panel-header-bar inline">
        <h3>Activity Log <span className="count-badge">{visible.length}</span></h3>
      </div>
      <PaginatedTable emptyCellValue="-"
        columns={columns}
        rows={visible}
        emptyMessage={scope === 'mine' ? 'No Super Admin actions yet.' : 'No activity yet.'}
        pageSizeOptions={[25, 50, 100]}
        initialPageSize={25}
      />
    </div>
  );
}

function SettingsTab({ setNotice }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.put('/profile/password', {
        old_password: oldPassword,
        new_password: newPassword,
        new_password_confirmation: confirmPassword,
      });
      setNotice({ type: 'success', text: 'Password updated.' });
      setOldPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not update password.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="superadmin-tab superadmin-settings-tab">
      <div className="panel-header-bar">
        <h3>My Settings</h3>
      </div>
      <form className="smart-form" onSubmit={submit} style={{ maxWidth: 420 }}>
        <label>
          <span>Current Password</span>
          <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required autoComplete="off" />
        </label>
        <label>
          <span>New Password</span>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        </label>
        <label>
          <span>Confirm New Password</span>
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        </label>
        <div className="form-actions">
          <button className="primary-button" type="submit" disabled={submitting}>{submitting ? 'Saving…' : 'Update Password'}</button>
        </div>
      </form>
    </div>
  );
}

function fetchSuperAdminData() {
  return Promise.all([
    api.get('/superadmin/barangays'),
    api.get('/superadmin/users'),
    api.get('/superadmin/pending-approvals'),
    api.get('/impersonate/candidates'),
    api.get('/superadmin/concern-reports'),
    api.get('/superadmin/activity-log'),
  ]);
}

export default function SuperAdminWorkspace() {
  const { user, logout } = useContext(AuthContext);
  const [activeTab, setActiveTab] = useState('dashboard');
  // Always starts expanded — a collapsed sidebar should only ever be a
  // deliberate, in-session choice (the toggle button), never the default a
  // returning user lands on.
  const nav = useResponsiveNav(activeTab);
  const topbarRef = useRef(null);
  useCssHeightVar(topbarRef, '--topbar-height');
  const [collapsedNavGroups, setCollapsedNavGroups] = useState([]);
  const toggleNavGroup = (section) => {
    setCollapsedNavGroups((prev) => (prev.includes(section) ? prev.filter((s) => s !== section) : [...prev, section]));
  };
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'light'; } catch { return 'light'; }
  });
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const handleConfirmDialog = async () => {
    if (!confirmDialog?.onConfirm || confirmBusy) return;
    setConfirmBusy(true);
    try {
      await confirmDialog.onConfirm();
      setConfirmDialog(null);
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Something went wrong. Please try again.' });
    } finally {
      setConfirmBusy(false);
    }
  };

  const [barangays, setBarangays] = useState([]);
  const [users, setUsers] = useState([]);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [concernReports, setConcernReports] = useState([]);
  const [activityLog, setActivityLog] = useState([]);
  const [loading, setLoading] = useState(true);

  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationsRef = useRef(null);
  const profileMenuRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const applyAll = useCallback(([b, u, p, c, r, a]) => {
    setBarangays(b.data);
    setUsers(u.data);
    setPendingApprovals(p.data);
    setCandidates(c.data);
    setConcernReports(r.data);
    setActivityLog(a.data);
  }, []);

  // `loading` starts true and only the initial-load effect below clears it.
  // loadAll() never flips it back: every tab's content-body unmounts while
  // loading is true (see the ternary below), which would wipe any local form
  // state a tab was mid-filling-out (province/city/barangay picks, search
  // text, ...). A post-mutation refresh updates the data in place instead.
  const loadAll = useCallback(async () => {
    try {
      applyAll(await fetchSuperAdminData());
    } catch {
      setNotice({ type: 'error', text: 'Could not load Super Admin data.' });
    }
  }, [applyAll]);

  useEffect(() => {
    let cancelled = false;
    fetchSuperAdminData()
      .then((results) => { if (!cancelled) applyAll(results); })
      .catch(() => { if (!cancelled) setNotice({ type: 'error', text: 'Could not load Super Admin data.' }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [applyAll]);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await api.get('/notifications');
      setNotifications(res.data);
    } catch { /* ignore — bell just stays empty until the next poll */ }
  }, []);

  const markNotificationAsRead = async (id) => {
    try {
      await api.put(`/notifications/${id}/read`);
      await loadNotifications();
    } catch { /* ignore */ }
  };

  const markAllNotificationsAsRead = async () => {
    try {
      await api.put('/notifications/read-all');
      await loadNotifications();
    } catch { /* ignore */ }
  };

  const deleteNotification = async (id) => {
    try {
      await api.delete(`/notifications/${id}`);
      await loadNotifications();
    } catch { /* ignore */ }
  };

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api.get('/notifications')
        .then((res) => { if (!cancelled) setNotifications(res.data); })
        .catch(() => { /* ignore — bell just stays empty until the next poll */ });
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

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

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  // Computed once here and handed to both DashboardTab and UsersTab so the
  // "Total Users"/"Pending Registrations" counts on the dashboard can never
  // drift from the "All Users" tab's own count badge — both read the same
  // Super-Admin-excluded list instead of each filtering independently.
  const visibleUsers = useMemo(() => users.filter((u) => u.role !== 'Super Admin'), [users]);

  const promoteToAdmin = async (target) => {
    if (!target) return;
    try {
      await api.put(`/superadmin/users/${target.id}/role`, { role: 'Admin' });
      if (!target.is_active) {
        await api.put(`/superadmin/users/${target.id}/activate`);
      }
      setNotice({ type: 'success', text: `${target.name} is now this barangay's Admin.` });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not promote this user.' });
    }
  };

  // AddBarangayForm already POSTs and hands back the created row itself —
  // this just refreshes the shared datasets (same loadAll() convention
  // every other mutation here uses) and surfaces the success notice.
  const addBarangay = async (created) => {
    setNotice({ type: 'success', text: `${created.name} (${created.city_name}) added.` });
    await loadAll();
  };

  // Only meaningful for a barangay without a verified boundary yet — re-runs
  // the same OSM lookup storeBarangay() tried on creation, for the (common)
  // case where nothing trustworthy was found the first time. Never
  // overwrites a boundary that's already verified (see
  // refreshBarangayBoundary()). A match found here lands as a candidate
  // awaiting review (boundary_status 'needs_review'), not an immediate save.
  const retryBoundary = async (barangay) => {
    try {
      const res = await api.post(`/superadmin/barangays/${barangay.id}/boundary/refresh`);
      setNotice(res.data.boundary_status === 'needs_review'
        ? { type: 'success', text: `Found a candidate boundary for ${barangay.name} — review it before confirming.` }
        : res.data.boundary_status === 'verified'
          ? { type: 'success', text: `${barangay.name} already has a verified boundary.` }
          : { type: 'error', text: `Still no boundary match for ${barangay.name} — try again later, or add it manually.` });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not retry that boundary lookup.' });
    }
  };

  const confirmBoundary = async (barangay) => {
    try {
      await api.post(`/superadmin/barangays/${barangay.id}/boundary/confirm`);
      setNotice({ type: 'success', text: `Boundary confirmed for ${barangay.name}.` });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not confirm that boundary.' });
    }
  };

  const discardBoundary = async (barangay) => {
    try {
      await api.delete(`/superadmin/barangays/${barangay.id}/boundary/pending`);
      setNotice({ type: 'success', text: `Candidate boundary discarded for ${barangay.name}.` });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not discard that candidate boundary.' });
    }
  };

  const changeRole = async (targetUser, role) => {
    if (role === targetUser.role) return;
    try {
      await api.put(`/superadmin/users/${targetUser.id}/role`, { role });
      setNotice({ type: 'success', text: `${targetUser.name}'s role is now ${role}.` });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not change that role.' });
    }
  };

  const toggleActive = async (targetUser) => {
    try {
      await api.put(`/superadmin/users/${targetUser.id}/${targetUser.is_active ? 'deactivate' : 'activate'}`);
      setNotice({ type: 'success', text: `${targetUser.name} is now ${targetUser.is_active ? 'inactive' : 'active'}.` });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not update that account.' });
    }
  };

  const approvePending = async (approval) => {
    try {
      await api.put(`/superadmin/users/${approval.id}/activate`);
      setNotice({ type: 'success', text: `${approval.name} is approved and can now sign in.` });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not approve this account.' });
    }
  };

  const rejectPending = async (approval) => {
    try {
      await api.delete(`/superadmin/users/${approval.id}/reject`);
      setNotice({ type: 'success', text: `${approval.name}'s registration was rejected.` });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not reject this account.' });
    }
  };

  const resolveConcern = async (report) => {
    try {
      await api.put(`/superadmin/concern-reports/${report.id}/resolve`);
      setNotice({ type: 'success', text: 'Concern report marked resolved.' });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not update that report.' });
    }
  };

  const reopenConcern = async (report) => {
    try {
      await api.put(`/superadmin/concern-reports/${report.id}/reopen`);
      setNotice({ type: 'success', text: 'Concern report reopened.' });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not update that report.' });
    }
  };

  const doImpersonate = async (userId, reason) => {
    try {
      const res = await api.post(`/impersonate/${userId}`, { reason });
      // Stash the Super Admin's own token before it's overwritten below —
      // otherwise there was no way back into it short of logging out and
      // back in. Workspace.jsx's topbar reads these same keys to show a
      // "Return to..." control on whichever dashboard the impersonated
      // account lands on.
      const ownToken = localStorage.getItem('token');
      if (ownToken) {
        localStorage.setItem('impersonator_token', ownToken);
        localStorage.setItem('impersonator_name', user.name);
        localStorage.setItem('impersonator_role', user.role);
      }
      localStorage.setItem('token', res.data.access_token);
      sessionStorage.removeItem('token');
      window.location.assign(roleRoutes[res.data.user?.role] ?? '/admin');
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not impersonate that account.' });
    }
  };

  const deleteConcern = async (report) => {
    try {
      await api.delete(`/superadmin/concern-reports/${report.id}`);
      setNotice({ type: 'success', text: 'Concern report deleted.' });
      await loadAll();
    } catch (error) {
      setNotice({ type: 'error', text: error.response?.data?.message ?? 'Could not delete that report.' });
    }
  };

  const handleLogout = () => {
    setShowProfileMenu(false);
    logout();
  };

  if (!user) return null;

  return (
    // Scopes the modern <select> styling below (superadmin-shell select) to
    // just this portal — the main Workspace.jsx shell uses the same
    // "workspace" class name on its own <main>, so a bare Fragment here
    // couldn't be targeted on its own without also restyling every select
    // in the fleet-facing app.
    <div className="superadmin-shell">
      <header className="topbar" ref={topbarRef}>
        <div className="topbar-left">
          <div className="topbar-brand-cluster">
            <button {...nav.toggleButtonProps} className="sidebar-toggle-btn" type="button">
              <Icon name="menu" size={24} />
            </button>
            <Icon name="gear" size={28} className="topbar-gear-icon" filled />
            <span className="vms-wordmark vms-wordmark-sm">vms</span>
            <ImpersonateInline candidates={candidates} onImpersonate={doImpersonate} />
          </div>
        </div>

        <div className="topbar-right">
          <div className="notifications-dropdown-container" ref={notificationsRef}>
            <button
              className="icon-btn notification-btn"
              title="Notifications"
              type="button"
              onClick={() => setShowNotifications((v) => !v)}
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
                            if (n.type === 'pending_admin_approval') {
                              setActiveTab('pending');
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
              onOpenSettings={() => setActiveTab('settings')}
              onLogout={handleLogout}
            />
          </div>
        </div>
      </header>

      <main className={nav.workspaceClassName}>
        <SidebarBackdrop nav={nav} />
        <aside {...nav.sidebarProps}>
          <SidebarDrawerHead nav={nav} />
          <nav className="module-nav" aria-label="Super Admin modules">
            {NAV_GROUPS.map(({ section, icon, items }) => {
              const renderItem = ([key, label]) => {
                const badgeCount = key === 'pending' ? pendingApprovals.length : 0;
                return (
                  <button
                    key={key}
                    className={key === activeTab ? 'active' : ''}
                    onClick={() => setActiveTab(key)}
                    title={nav.isRail ? label : undefined}
                    aria-label={nav.isRail ? (badgeCount > 0 ? `${label}, ${badgeCount} pending` : label) : undefined}
                    aria-current={key === activeTab ? 'page' : undefined}
                    type="button"
                  >
                    {TAB_ICONS[key]}
                    <span>{label}</span>
                    {badgeCount > 0 && <span className="module-nav-badge">{badgeCount}</span>}
                  </button>
                );
              };

              // Ungrouped (Dashboard) — no header, always visible.
              if (!section) return <div key="__top" className="module-nav-group">{items.map(renderItem)}</div>;

              const groupBadge = items.reduce((sum, [key]) => sum + (key === 'pending' ? pendingApprovals.length : 0), 0);
              const holdsActive = items.some(([key]) => key === activeTab);
              const expanded = nav.isRail || holdsActive || !collapsedNavGroups.includes(section);

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

        <section id="main-content" className="content-area" tabIndex={-1}>
          <div className="page-heading-row">
            <span className="page-heading-icon">{TAB_ICONS[activeTab]}</span>
            <div className="page-heading-text">
              <span className="superadmin-page-kicker">Super Admin Console</span>
              <h2>{TABS.find(([k]) => k === activeTab)?.[1] ?? 'My Settings'}</h2>
              <p>{TAB_DESCRIPTIONS[activeTab] ?? TAB_DESCRIPTIONS.settings}</p>
            </div>
          </div>

          {notice && (
            <div className={`toast-notice ${notice.type}`} role="alert">
              <div className="toast-notice-body">
                <Icon name={notice.type === 'success' ? 'checkCircle' : 'alert'} size={16} />
                <span>{notice.text}</span>
              </div>
              <button type="button" className="toast-notice-close" onClick={() => setNotice(null)} aria-label="Dismiss">
                <Icon name="close" size={13} />
              </button>
            </div>
          )}

          <div className="content-body">
            {loading ? (
              <p className="muted">Loading…</p>
            ) : activeTab === 'dashboard' ? (
              <DashboardTab
                barangays={barangays}
                users={visibleUsers}
                pendingApprovals={pendingApprovals}
                concernReports={concernReports}
                onPromote={promoteToAdmin}
                onAddedBarangay={addBarangay}
                onRetryBoundary={retryBoundary}
                onConfirmBoundary={confirmBoundary}
                onDiscardBoundary={discardBoundary}
                onNavigate={setActiveTab}
              />
            ) : activeTab === 'pending' ? (
              <PendingApprovalsTab
                approvals={pendingApprovals}
                barangays={barangays}
                onApprove={approvePending}
                onReject={rejectPending}
                onRequestConfirmation={setConfirmDialog}
              />
            ) : activeTab === 'users' ? (
              <UsersTab users={visibleUsers} onChangeRole={changeRole} onToggleActive={toggleActive} />
            ) : activeTab === 'codes' ? (
              <RegistrationCodesTab barangays={barangays} onRequestConfirmation={setConfirmDialog} setNotice={setNotice} />
            ) : activeTab === 'concerns' ? (
              <ConcernReportsTab reports={concernReports} onResolve={resolveConcern} onReopen={reopenConcern} onDelete={deleteConcern} onRequestConfirmation={setConfirmDialog} />
            ) : activeTab === 'activity' ? (
              <ActivityLogTab entries={activityLog} />
            ) : (
              <SettingsTab setNotice={setNotice} />
            )}
          </div>
        </section>
      </main>

      <WorkspaceFooter />
      <ConfirmDialog
        busy={confirmBusy}
        dialog={confirmDialog}
        onCancel={() => setConfirmDialog(null)}
        onConfirm={handleConfirmDialog}
      />
    </div>
  );
}
