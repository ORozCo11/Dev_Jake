import { useMemo, useState } from 'react';
import Icon from '../../components/Icon';
import { StackedBarChart } from '../../components/lazy';
import { readyToCloseColumns, ticketTableColumns } from '../columns';
import { FilterBar, TicketFilterPanel } from '../components/filters';
import { ColumnChooserButton, DataTable, ModuleStatCards, PaginatedCardGrid, PaginatedTable, ViewModeDropdown } from '../components/tables';
import { DateBadge, DismissibleHint, FormModal, LocalSearchInput, PartsTags, TicketStageBadge, TicketStatusBadge, VehicleCell } from '../components/ui';
import { useColumnChooser } from '../hooks/useColumnChooser';
import { formatDate, formatTime, resolvePhotoUrl } from '../lib/format';
import { hasRole } from '../lib/permissions';
import { exportRowsToCsv } from '../lib/reports';
import { TICKET_INSPECTION_STAT_CARDS, TICKET_STAT_CARDS, TICKET_VERIFICATION_STAT_CARDS, TICKET_WORK_ORDER_STAT_CARDS, WORK_TRACKER_STAT_CARDS } from '../lib/statCards';
import { flattenWorkTrackerRows, groupMechanicRowsByTicket, groupWorkTrackerByTicket, ticketWorkflowStage, workTrackerBucket, workTrackerNeedsAction, workTrackerOutcome } from '../lib/workflow';
import { LatestIssueCard } from '../issues/issues';
import { TicketVerificationForm } from './VerificationForm';

// My Tasks -> History: a plain record of work that's actually finished — a
// sub-issue reached Done (confirmed) or Deferred. Anything still Open/Under
// Repair/For Inspection/etc. belongs in the My Tickets tab, not here; this
// used to also surface in-progress work ("Work Tracker"'s original scope),
// but that read as unfinished tickets showing up in a "History" list, so
// it's completed-only now, with no 30-day cutoff — it's meant to be the
// full record, not a recent-activity feed.
export function WorkTrackerModule({ tickets, user, categories = [], vehicles = [], onViewTicket, tabBar }) {
  const [activeFilter, setActiveFilter] = useState('');
  const [search, setSearch] = useState('');
  // FilterBar (draft/apply) state — Category + Capacity + Status + My Role.
  const [filterCategory, setFilterCategory] = useState([]);
  const [filterCapacity, setFilterCapacity] = useState([]);
  const [filterStatus, setFilterStatus] = useState([]);
  const [filterRole, setFilterRole] = useState([]);
  const [filterOutcome, setFilterOutcome] = useState([]);

  const allRows = useMemo(() => {
    return flattenWorkTrackerRows(tickets, user)
      .filter((row) => row.status === 'Done' || row.status === 'Deferred')
      // Most recently finished first.
      .sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  }, [tickets, user]);

  const counts = useMemo(() => {
    const c = { Done: 0, Deferred: 0 };
    allRows.forEach((row) => { c[row.status] += 1; });
    return c;
  }, [allRows]);

  const visibleRows = useMemo(() => {
    let result = allRows;
    if (activeFilter) result = result.filter((row) => row.status === activeFilter);
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
  // groupWorkTrackerByTicket's return is a synthesized summary row (one per
  // ticket_id, built from flattened sub-issue rows) — not the real ticket
  // object TicketCard needs (status/priority/created_at/progress). `tickets`
  // here is already the full raw ticket list, so just look the real one up.
  const ticketById = useMemo(() => {
    const map = new Map();
    (tickets ?? []).forEach((t) => map.set(t.ticket_id, t));
    return map;
  }, [tickets]);
  const groupedTicketCards = useMemo(
    () => groupedTickets.map((g) => ticketById.get(g.ticket_id)).filter(Boolean),
    [groupedTickets, ticketById]
  );

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
          statusOptions={['Done', 'Deferred']}
          priorityOptions={(hasRole(user, 'Custodian') && hasRole(user, 'Maintenance Personnel')) ? ['Mechanic', 'Custodian'] : []}
          priorityLabel="Role"
          extraFilters={[{
            key: 'outcome',
            label: 'Outcomes',
            options: ['Confirmed — Done', 'Deferred'],
            selected: filterOutcome,
            setSelected: setFilterOutcome,
          }]}
        />
      </section>
      <section className="panel operations-board work-tracker-board">
        <div className="operations-board-head">
          <div>
            <span className="operations-kicker">Service history</span>
            <h3>History <span className="count-badge">{visibleRows.length}</span></h3>
            <p>Every ticket you've worked on that's already done or deferred — still-open work stays on My Tickets.</p>
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
        <div style={{ height: '16px' }} />
        <PaginatedCardGrid
          items={groupedTicketCards}
          keyOf={(t) => t.ticket_id}
          emptyMessage="Nothing here yet — tickets you've worked on will show up here once they're done or deferred."
          renderItem={(t) => <TicketCard ticket={t} onClick={() => onViewTicket(t)} />}
        />
      </section>
    </div>
  );
}

// =========================================================================
// PHASE 1 + 4T2: ADMIN TICKET MODULE
// =========================================================================

export function TicketModule({
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
  recentIssues,
  onViewVehicle,
}) {
  const [ticketViewMode, setTicketViewMode] = useState(
    () => localStorage.getItem('vms_ticket_view') || 'card'
  );

  const changeTicketViewMode = (mode) => {
    setTicketViewMode(mode);
    localStorage.setItem('vms_ticket_view', mode);
  };

  // Count alerts — sourced from the unfiltered list so applying a status
  // filter doesn't make them under-report or vanish. A cannibalized repair
  // is the one thing still awaiting an Admin decision at the sub-issue
  // level now — every other old per-sub-issue gate (mechanic assignment,
  // confirmation) was folded into the one-mechanic-per-ticket approval and
  // the Custodian's single verification step.
  const statSourceTickets = allTickets ?? tickets;
  const allSubIssues = statSourceTickets.flatMap((t) => t.sub_issues ?? []);
  const pendingCannibalizationCount = allSubIssues.filter((s) => s.status === 'Pending Approval').length;
  // "Ready to close" now means what it actually takes to close a ticket:
  // the mechanic has submitted, and the Custodian's one verification is the
  // only thing left before it's Closed. (The old definition — every
  // sub-issue already Done while the ticket is still Active — can't happen
  // anymore: verifyTicket() marks every sub-issue Done and closes the
  // ticket in the same transaction.)
  const readyToCloseTickets = useMemo(
    () => statSourceTickets.filter((t) => t.status === 'For Verification'),
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
    ['Pending Approval', 'Declined', 'Active', 'For Verification', 'Closed', 'Cancelled'].forEach((s) => {
      counts[s] = statSourceTickets.filter((t) => t.status === s).length;
    });
    return counts;
  }, [statSourceTickets]);
  const ticketPriorityStats = useMemo(() => {
    const counts = { High: 0, Medium: 0, Low: 0 };
    statSourceTickets.forEach((t) => { if (t.priority in counts) counts[t.priority] += 1; });
    return counts;
  }, [statSourceTickets]);

  const ticketColumnDefs =useMemo(() => ticketTableColumns(unreadByTicket), [unreadByTicket]);
  const ticketColumnChooser = useColumnChooser('vms_ticket_columns', ticketColumnDefs);

  return (
    <div className="module-grid">
      <DismissibleHint description="Central Ticket Ledger — review Custodian proposals, approve and assign a mechanic, then let the mechanic's submission and the Custodian's verification carry the ticket through to Closed." />
      <ModuleStatCards
        totalLabel="Total Tickets"
        total={ticketStats.total}
        cards={TICKET_STAT_CARDS}
        counts={ticketStats}
        activeFilter={filterStatus}
        onFilterChange={setFilterStatus}
      />
      {/* Same layout as the Issue Reports page: the priority bar and the
          filters stack on the left, Latest Reports spans both on the right.
          The bar counts the same full list as the stat cards above. */}
      <div className={`ticket-summary-grid${recentIssues && recentIssues.length > 0 ? '' : ' no-side'}`}>
        <div className="ticket-summary-chart">
          <StackedBarChart
            title="Maintenance Tickets"
            segments={[
              { label: 'High', value: ticketPriorityStats.High, color: '#dc2626' },
              { label: 'Medium', value: ticketPriorityStats.Medium, color: '#f59e0b' },
              { label: 'Low', value: ticketPriorityStats.Low, color: '#0ea5e9' },
            ]}
          />
        </div>
        <section className="panel module-filter-panel ticket-summary-filters">
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
        {/* Admin no longer has a standalone Issue Reports page — this is
            the one thing worth keeping from it, moved here instead of
            dropped. */}
        {recentIssues && recentIssues.length > 0 && (
          <LatestIssueCard issues={recentIssues} onRowClick={(row) => row.vehicle && onViewVehicle?.(row.vehicle)} />
        )}
      </div>

      <TicketsReadyToClosePanel tickets={readyToCloseTickets} onViewTicket={onViewTicket} />

      <section className="panel" style={{ width: '100%' }}>
        {/* Alert banners */}
        {pendingCannibalizationCount > 0 && (
          <div className="ticket-alert-banner formaint">
            <Icon name="alert" size={16} /> <strong>{pendingCannibalizationCount}</strong> cannibalized repair{pendingCannibalizationCount > 1 ? 's' : ''} waiting for your approval.
          </div>
        )}

        <div className="panel-header-bar" style={{ marginBottom: '8px' }}>
          <h3>All Tickets <span className="count-badge">{tickets.length}</span></h3>
          <div className="ticket-list-toolbar-actions">
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

export function TicketCard({ ticket, unreadCount = 0, onClick }) {
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

export function CustodianInspectionModule({
  tickets,
  onOpenInspect,
  categories,
  vehicles,
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterPriority,
  setFilterPriority,
  priorityOptions,
  onViewVehicle,
  stats,
  activeFilter,
  onFilterChange,
  tabBar
}) {
  const isPendingView = activeFilter !== 'Inspected';

  const inspectionColumnDefs = useMemo(() => [
    { key: 'ticket_id', label: 'Ticket ID', locked: true, className: 'cell-center', render: (r) => r.ticket_id },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (r) => <VehicleCell vehicle={r.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => r.vehicle?.plate_number ?? '-' },
    { key: 'title', label: 'Title', render: (r) => r.ticket_title },
    { key: 'priority', label: 'Priority', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.priority} /> },
    { key: 'result', label: 'Result', className: 'cell-center', render: (r) => r.inspection_result ? <TicketStatusBadge value={r.inspection_result} /> : <span className="muted">—</span> },
    { key: 'assigned', label: 'Assigned', className: 'cell-center', render: (r) => <DateBadge value={r.assigned_at} /> },
    { key: 'time', label: 'Time', className: 'cell-center', render: (r) => formatTime(r.assigned_at) },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      // "Submitted" implied THIS Custodian already did something —
      // false for a Pre-Diagnosed ticket, or one reassigned to
      // them after the fact. Reusing the same stage logic the
      // Admin's ticket cards use says honestly where the ball
      // actually is instead (e.g. "Diagnosed — Assign a
      // Mechanic" — informational, since assigning one isn't a
      // Custodian action, but at least it's true).
      render: (r) => r.status === 'Open'
        ? <button className="btn-edit-action icon-btn" type="button" onClick={() => onOpenInspect(r)} title="Inspect" aria-label="Inspect"><Icon name="search" size={14} /></button>
        : <TicketStageBadge ticket={r} />
    },
  ], [onOpenInspect]);
  const inspectionColumnChooser = useColumnChooser('vms_custodian_inspection_columns', inspectionColumnDefs);

  return (
    <div className="module-grid">
      <DismissibleHint description="Phase 2 — Vehicle Evaluation. Review tickets assigned to you, submit physical inspection findings, and check back here for anything already diagnosed — either by your own inspection, or pre-diagnosed by an Admin (e.g. reassigned to you mid-repair)." />
      {tabBar}
      <ModuleStatCards
        totalLabel="Total Assigned"
        total={stats.total}
        cards={TICKET_INSPECTION_STAT_CARDS}
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
          priorityOptions={priorityOptions}
          priorityLabel="Priority"
        />
      </section>
      <section className="panel">
        <div className="panel-header-bar">
          {/* Not every ticket in this second bucket was actually inspected —
              a Pre-Diagnosed ticket (or one reassigned to this Custodian
              after the fact) skips inspection entirely, so calling it
              "Already Inspected" claimed something that never happened. */}
          <h3>{isPendingView ? 'Pending Inspections' : 'Diagnosed'} <span className="count-badge">{tickets.length}</span></h3>
          <ColumnChooserButton {...inspectionColumnChooser} />
        </div>
        <div style={{ height: '16px' }} />
        {tickets.length === 0
          ? <p className="empty-state">{isPendingView ? 'No inspection assignments pending.' : 'Nothing diagnosed yet.'}</p>
          : (
            <DataTable
              columns={inspectionColumnChooser.visibleColumns}
              onReorderColumn={inspectionColumnChooser.reorderColumn}
              rows={tickets}
              onRowClick={(row) => row.vehicle && onViewVehicle(row.vehicle)}
              renderSubRow={(row) => row.ticket_description}
            />
          )
        }
      </section>
    </div>
  );
}

// =========================================================================
// PHASE 4 TIER 1: CUSTODIAN REPAIR VERIFICATION
// =========================================================================

export function CustodianVerificationModule({
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
  onViewTicket,
  stats,
  activeFilter,
  onFilterChange,
  tabBar
}) {
  const [viewLogsTarget, setViewLogsTarget] = useState(null);
  const panelTitle = activeFilter.includes('Active')
    ? 'Active Tickets'
    : activeFilter.includes('Verified')
      ? 'Verified Repairs'
      : activeFilter.includes('Pending')
        ? 'Pending Verifications'
        : 'My Tickets';
  const isMyTicketsView = panelTitle === 'My Tickets';
  const emptyStateText = activeFilter.includes('Active')
    ? 'No tickets currently active.'
    : activeFilter.includes('Verified')
      ? 'No repairs verified yet.'
      : activeFilter.includes('Pending')
        ? 'No repairs pending your verification.'
        : 'No tickets yet — once the Admin approves a proposal, it will show up here.';

  const verificationColumnDefs = useMemo(() => [
    { key: 'ticket_id', label: 'Ticket ID', locked: true, className: 'cell-center', render: (r) => r.ticket_id },
    { key: 'ticket_title', label: 'Ticket Title', render: (r) => r.ticket_title },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (r) => <VehicleCell vehicle={r.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => r.vehicle?.plate_number ?? '-' },
    {
      key: 'sub_issues',
      label: 'Sub-Issues',
      render: (r) => {
        const subs = r.sub_issues ?? [];
        if (subs.length === 0) return '—';
        if (subs.length === 1) return subs[0].title;
        return `${subs.length} sub-issues: ${subs.map((s) => s.title).join(', ')}`;
      }
    },
    // One mechanic per ticket now — the whole job (every sub-issue) is
    // assigned, logged and submitted together.
    { key: 'mechanic', label: 'Mechanic', className: 'cell-center', render: (r) => r.assigned_mechanic?.name ?? '—' },
    {
      key: 'repair_log',
      label: 'Repair Log',
      render: (r) => (r.sub_issues ?? []).some((si) => si.repair_logs) ? (
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
    // parts_used is a comma-separated string per sub-issue (PartsTags splits
    // it itself) — join every sub-issue's string into one, since a ticket
    // can now carry several sub-issues, each with its own parts.
    { key: 'parts_used', label: 'Parts Used', render: (r) => <PartsTags value={(r.sub_issues ?? []).map((si) => si.parts_used).filter(Boolean).join(', ')} /> },
    {
      key: 'status',
      label: 'Status',
      className: 'cell-center',
      render: (r) => {
        const reopenedSub = (r.sub_issues ?? []).find((si) => si.reopened_at && si.status !== 'Done');
        if (reopenedSub) {
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600 }} title={`Reopened by ${reopenedSub.reopened_by?.name || 'Admin'}`}>
              <Icon name="alert" size={12} /> Reopened
            </span>
          );
        }
        return <TicketStatusBadge value={r.status === 'Closed' ? 'Verified' : r.status} />;
      }
    },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      render: (r) => {
        if (r.status !== 'For Verification') {
          return <span className="muted">{r.status === 'Closed' ? 'Verified' : r.status}</span>;
        }
        // Mirrors TicketController::verifyTicket's own guard — a dual-role
        // (Custodian + Maintenance Personnel) account currently assigned as
        // this ticket's mechanic can't "grade their own homework" here even
        // though they're the assigned verifier. The button is hidden
        // proactively; the backend is what actually enforces it (including
        // any PRIOR mechanic on the ticket, which this UI hint doesn't check —
        // see verifyTicket()'s prior_mechanic_ids guard). Fixed by reassigning
        // the ticket to a different Custodian.
        const isOwnRepair = r.assigned_mechanic_id != null
          && (r.assigned_mechanic_id === user.id || String(r.assigned_mechanic_id) === String(user.id));
        if (isOwnRepair) {
          return <span className="muted" title="You performed this repair — reassign this ticket to a different Custodian to verify it.">Needs reassignment (you did this repair)</span>;
        }
        return <button className="btn-edit-action icon-btn" type="button" onClick={() => setEditTarget(r)} title="Verify Repair" aria-label="Verify Repair"><Icon name="checkCircle" size={14} /></button>;
      }
    },
  ], [user.id, setEditTarget]);
  const verificationColumnChooser = useColumnChooser('vms_custodian_verification_columns', verificationColumnDefs);

  return (
    <div className="module-grid">
      <DismissibleHint description="Review a mechanic's completed work and give the one verification attestation that closes the ticket — check back here to see what you've already verified." />
      {/* Stat cards swapped above the My Tickets/History tab bar — they read
          as the page's headline now, with the tabs as a secondary switch
          underneath instead of sitting above everything. */}
      <ModuleStatCards
        totalLabel="Total Assigned"
        total={stats.total}
        cards={TICKET_VERIFICATION_STAT_CARDS}
        counts={stats}
        activeFilter={activeFilter}
        onFilterChange={onFilterChange}
      />
      {tabBar}
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
          <h3>{panelTitle} <span className="count-badge">{tickets.length}</span></h3>
          {!isMyTicketsView && <ColumnChooserButton {...verificationColumnChooser} />}
        </div>
        <div style={{ height: '16px' }} />
        {tickets.length === 0
          ? <p className="empty-state">{emptyStateText}</p>
          : isMyTicketsView ? (
            // The plain "My Tickets" view (no Active/Pending/Verified filter
            // picked) reads as tickets, same as the Admin's own ticket list —
            // the verification-focused table (repair log, parts, verify
            // action) only makes sense once a specific status is picked.
            <PaginatedCardGrid
              items={tickets}
              keyOf={(t) => t.ticket_id}
              emptyMessage={emptyStateText}
              renderItem={(t) => <TicketCard ticket={t} onClick={() => (onViewTicket ? onViewTicket(t) : (t.vehicle && onViewVehicle(t.vehicle)))} />}
            />
          ) : (
            <DataTable
              columns={verificationColumnChooser.visibleColumns}
              onReorderColumn={verificationColumnChooser.reorderColumn}
              rows={tickets}
              onRowClick={(row) => (onViewTicket ? onViewTicket(row) : (row.vehicle && onViewVehicle(row.vehicle)))}
            />
          )
        }
      </section>
      {/* Whole-ticket verification (TicketController::verifyTicket): the
          vehicle-type functional test, then Approve (closes the ticket) or
          Return for Repair. Same TicketVerificationForm the ticket detail
          page's own "Verify Repair" section uses. */}
      <FormModal open={!!editTarget} title={`Verify Repair — ${editTarget?.ticket_title ?? `Ticket #${editTarget?.ticket_id}`}`} onClose={onCancelEdit}>
        <TicketVerificationForm
          key={editTarget?.ticket_id}
          ticket={editTarget}
          onCancel={onCancelEdit}
          onSubmit={(payload) => onVerify(editTarget, payload)}
        />
      </FormModal>

      <FormModal open={!!viewLogsTarget} title={`Repair Details — Ticket #${viewLogsTarget?.ticket_id}`} onClose={() => setViewLogsTarget(null)}>
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Vehicle</h4>
            <div style={{ fontWeight: 600 }}>{viewLogsTarget?.vehicle?.vehicle_name} ({viewLogsTarget?.vehicle?.plate_number})</div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Ticket Title</h4>
            <div style={{ fontWeight: 600 }}>{viewLogsTarget?.ticket_title}</div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Mechanic</h4>
            <div>{viewLogsTarget?.assigned_mechanic?.name ?? '—'}</div>
          </div>
          {/* One block per sub-issue — a ticket can carry several now, so
              each gets its own log/parts/dates/cost instead of a single
              ticket-wide set (the common one-sub-issue ticket just renders
              one block, same information as before). */}
          {(viewLogsTarget?.sub_issues ?? []).map((si, idx, arr) => (
            <div key={si.sub_issue_id} style={{ marginBottom: '20px', paddingBottom: idx < arr.length - 1 ? '16px' : 0, borderBottom: idx < arr.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
              {arr.length > 1 && (
                <h4 style={{ margin: '0 0 10px 0', fontSize: '0.95rem' }}>{si.title}</h4>
              )}
              <div style={{ marginBottom: '12px' }}>
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
                }}>{si.repair_logs ?? 'No logs provided.'}</pre>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Parts / Materials Used</h4>
                <div style={{ marginTop: '6px' }}>
                  <PartsTags value={si.parts_used} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '12px' }}>
                <div>
                  <h4 style={{ margin: '0 0 4px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Start Date</h4>
                  <div>{si.repair_started_at ? formatDate(si.repair_started_at) : '—'}</div>
                </div>
                <div>
                  <h4 style={{ margin: '0 0 4px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Completion Date</h4>
                  <div>{si.repair_completed_at ? formatDate(si.repair_completed_at) : '—'}</div>
                </div>
              </div>
              <div>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Repair Cost / Expenses</h4>
                <div style={{ fontWeight: 600, color: 'var(--text-success)', fontSize: '1.1rem' }}>
                  {si.maintenance_cost ? `₱${Number(si.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '₱0.00'}
                </div>
              </div>
            </div>
          ))}
          {!(viewLogsTarget?.sub_issues ?? []).length && (
            <p className="empty-state">No sub-issues on this ticket.</p>
          )}
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

export function MechanicWorkOrderModule({
  tickets,
  // Full, unfiltered list of every ticket assigned to this mechanic (same
  // GET /tickets payload `tickets` above was flattened/filtered down from) —
  // needed so the Archive toggle (the former standalone Work Tracker page)
  // can compute its own 30-day history scope independent of the active-work
  // Pending/Submitted filter, and so both views can hand TicketCard the real
  // ticket object (status/priority/progress/created_at) rather than the
  // slimmed-down grouping shape.
  allTickets = [],
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
  currentUser,
}) {
  const isPendingView = activeFilter !== 'Submitted';
  // Merge 2 — "Work Tracker" is no longer its own sidebar entry; it's this
  // Archive toggle over the same page, mirroring Admin's Maintenance Tickets
  // "Archives" button (see TicketModule's onViewArchives). Admin's version
  // swaps `activeModule` to a distinct key with its own fetch; this role's
  // GET /tickets already returns every ticket ever assigned to them (not
  // just the active ones — see loadModule), so a plain local boolean over
  // data already on hand is enough.
  const [showArchive, setShowArchive] = useState(false);

  // Resolve the real ticket object for a ticket_id — both grouping helpers
  // below return a synthesized summary row, not what TicketCard needs.
  const ticketById = useMemo(() => {
    const map = new Map();
    (allTickets ?? []).forEach((t) => map.set(t.ticket_id, t));
    return map;
  }, [allTickets]);

  // ---- Active work (unchanged scope: Pending vs Submitted, via `tickets`
  // which the parent already flattened/filtered to this mechanic's own
  // sub-issue rows) — one card per ticket/vehicle, same as before.
  const groupedTickets = useMemo(() => groupMechanicRowsByTicket(tickets), [tickets]);
  const activeTicketCards = useMemo(
    () => groupedTickets.map((g) => ticketById.get(g.ticket_id)).filter(Boolean),
    [groupedTickets, ticketById]
  );

  // ---- Archive — the history view the old standalone Work Tracker page
  // showed this role: everything still in progress, plus anything
  // completed/deferred within the last 30 days, mirroring WorkTrackerModule's
  // own scope exactly (just narrowed to this mechanic's own lines, since this
  // page never shows a Custodian's verification work).
  const [nowTs] = useState(() => Date.now());
  const [archiveSearch, setArchiveSearch] = useState('');
  const [archiveBucketFilter, setArchiveBucketFilter] = useState('');

  const archiveAllRows = useMemo(() => {
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    return flattenWorkTrackerRows(allTickets, currentUser)
      .filter((row) => row.isMechanic)
      .filter((row) => {
        const isCompleted = row.status === 'Done' || row.status === 'Deferred';
        if (!isCompleted) return true; // always show active/in-progress work
        const ref = row.confirmed_at || row.deferred_at || row.lastActivityIso;
        return ref ? (nowTs - new Date(ref).getTime()) <= THIRTY_DAYS : false;
      })
      .sort((a, b) => {
        const an = workTrackerNeedsAction(a) ? 1 : 0;
        const bn = workTrackerNeedsAction(b) ? 1 : 0;
        if (an !== bn) return bn - an;
        return b.lastActivityTs - a.lastActivityTs;
      });
  }, [allTickets, currentUser, nowTs]);

  const archiveCounts = useMemo(() => {
    const c = { attention: 0, progress: 0, completed: 0 };
    archiveAllRows.forEach((row) => { c[workTrackerBucket(row)] += 1; });
    return c;
  }, [archiveAllRows]);

  const archiveVisibleRows = useMemo(() => {
    let result = archiveAllRows;
    if (archiveBucketFilter) result = result.filter((row) => workTrackerBucket(row) === archiveBucketFilter);
    const q = archiveSearch.trim().toLowerCase();
    if (q) {
      result = result.filter((row) => (
        (row.vehicle?.vehicle_name ?? '').toLowerCase().includes(q)
        || (row.vehicle?.plate_number ?? '').toLowerCase().includes(q)
        || (row.ticket_title ?? '').toLowerCase().includes(q)
        || (row.title ?? '').toLowerCase().includes(q)
      ));
    }
    return result;
  }, [archiveAllRows, archiveBucketFilter, archiveSearch]);

  const archiveGroupedTickets = useMemo(() => groupWorkTrackerByTicket(archiveVisibleRows), [archiveVisibleRows]);
  const archiveTicketCards = useMemo(
    () => archiveGroupedTickets.map((g) => ticketById.get(g.ticket_id)).filter(Boolean),
    [archiveGroupedTickets, ticketById]
  );

  return (
    <div className="module-grid">
      <DismissibleHint description="Work Orders assigned to you. Execute vehicle repairs, log them, then submit the ticket for Custodian verification once every sub-issue is logged — check the Archive for your full history." />

      {!showArchive ? (
        <>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button type="button" className="ghost-button" onClick={() => setShowArchive(true)}>
                  <Icon name="archive" size={14} /> Archive
                </button>
                <LocalSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search work orders..." />
              </div>
            </div>
            <div className="operations-board-note"><Icon name={isPendingView ? 'wrench' : 'checkCircle'} size={14} /> {isPendingView ? 'Repair logs are due for the highlighted work orders.' : 'Submitted items remain here until their next workflow update.'}</div>
            <PaginatedCardGrid
              items={activeTicketCards}
              keyOf={(t) => t.ticket_id}
              emptyMessage={isPendingView ? 'No active work orders assigned to you.' : 'No repair logs submitted yet.'}
              renderItem={(t) => <TicketCard ticket={t} onClick={() => onViewTicket(t)} />}
            />
          </section>
        </>
      ) : (
        <section className="panel operations-board work-order-board">
          <div className="operations-board-head">
            <div>
              <span className="operations-kicker">Service activity</span>
              <h3>Work Order Archive <span className="count-badge">{archiveVisibleRows.length}</span></h3>
              <p>Every vehicle you've repaired and where it stands now — completed and deferred work stays here for 30 days.</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button type="button" className="ghost-button" onClick={() => setShowArchive(false)}>
                <Icon name="wrench" size={14} /> Back to Work Orders
              </button>
              <LocalSearchInput value={archiveSearch} onChange={setArchiveSearch} placeholder="Search vehicle, plate, or ticket..." />
            </div>
          </div>
          <ModuleStatCards
            totalLabel="Total"
            total={archiveAllRows.length}
            cards={WORK_TRACKER_STAT_CARDS}
            counts={archiveCounts}
            activeFilter={archiveBucketFilter}
            onFilterChange={setArchiveBucketFilter}
          />
          <div className="operations-board-note"><Icon name="alert" size={14} /> Items requiring your action are shown first.</div>
          <PaginatedCardGrid
            items={archiveTicketCards}
            keyOf={(t) => t.ticket_id}
            emptyMessage="Nothing here yet — vehicles you repair will show up here with their current status."
            renderItem={(t) => <TicketCard ticket={t} onClick={() => onViewTicket(t)} />}
          />
        </section>
      )}

      {/* The old "My Assigned Maintenance Schedules" card section that used
          to live here (a duplicate of the real Maintenance Schedule sidebar
          page) was removed — that page is back in this role's sidebar, and
          GET /maintenance-schedules already scopes to assigned_to = me for
          a pure Maintenance Personnel account, so this was showing the same
          data twice. */}
    </div>
  );
}

export function TicketsReadyToClosePanel({ tickets, onViewTicket }) {
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
