import { useMemo, useState } from 'react';
import Icon from '../../components/Icon';
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
import { MaintenanceScheduleCard } from '../maintenance/maintenance';
import { VerificationForm } from './VerificationForm';

// "Vehicles you've worked on and where they stand now." A read-only feed that
// unifies every workflow phase so a Custodian/Mechanic sees the OUTCOME of their
// work (approved, rejected, confirmed, reopened) in one place — no notification
// chasing. Scope: everything still in progress, plus items completed/deferred
// within the last 30 days so recent outcomes stay visible without old clutter.
export function WorkTrackerModule({ tickets, user, categories = [], vehicles = [], onViewTicket, tabBar }) {
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

export function MechanicWorkOrderModule({
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
