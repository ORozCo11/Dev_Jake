import Icon from '../components/Icon';
import { DateBadge, PhotoCell, StatusBadge, TicketStageBadge, TicketStatusBadge, UserAvatarName, VehicleCell } from './components/ui';
import { formatDate, formatLogDateTime, formatTime, prettifyKey, resolvePhotoUrl, resolveRelationLabel } from './lib/format';
import { canDo, hasRole } from './lib/permissions';
import { moduleBadgeTone } from './lib/statCards';
import { actionLabel, historyRecordKind } from './lib/activity';
import { accountStatus, splitRoles } from './lib/userAccounts';
import { LogRecordCell, RelatedRecordLink } from './history/activity';
import { READINESS_BADGE, RECURRENCE_LABEL, isScheduleOverdue, issueNeedsTicket } from './lib/workflow';
import { ScheduleActionMenu } from './maintenance/maintenance';

export function vehicleColumns(user, onEdit, deleteRecord, restoreRecord, filterStatus, onViewTicket, onReadinessCheck) {
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
              <button className="btn-edit-action icon-btn" onClick={() => restoreRecord(`/vehicles/${row.vehicle_id}/restore`, row.status === 'Decommissioned' ? 'Vehicle recommissioned.' : 'Vehicle restored.', `Return ${row.vehicle_name} to active service? It counts toward availability again; run a readiness check before dispatching it.`, { title: `${row.status === 'Decommissioned' ? 'Recommission' : 'Restore'} ${row.vehicle_name}`, confirmLabel: row.status === 'Decommissioned' ? 'Recommission' : 'Restore' })} type="button" title={row.status === 'Decommissioned' ? 'Recommission' : 'Restore'} aria-label="Restore"><Icon name="undo" size={14} /></button>
            )
          ) : (
            canArchiveVehicle && (
              <button className="btn-archive-action icon-btn" onClick={() => deleteRecord(`/vehicles/${row.vehicle_id}`, 'Vehicle marked inactive.', `${row.vehicle_name} will be marked Inactive: it drops out of availability and readiness counts and can't be dispatched. Its history is kept, and it can be restored later.`, { title: `Deactivate ${row.vehicle_name}`, confirmLabel: 'Deactivate' })} type="button" title="Deactivate (reversible)" aria-label="Deactivate"><Icon name="archive" size={14} /></button>
            )
          )}
        </div>
      ),
    });
  }

  return columns;
}

export function categoryColumns(onEdit, deleteRecord) {
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
          <button className="btn-delete-action icon-btn" onClick={() => deleteRecord(`/categories/${row.category_id}`, 'Category deleted.', `Delete the "${row.category_name}" vehicle type? This cannot be undone.`, { title: 'Delete vehicle type', confirmLabel: 'Delete' })} type="button" title="Delete" aria-label="Delete"><Icon name="trash" size={14} /></button>
        </div>
      ),
    },
  ];
}

export function userColumns(onEdit, onToggleActive, currentUserId) {
  return [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.id },
    { key: 'user', label: 'User', locked: true, render: (row) => <UserAvatarName user={row} /> },
    { key: 'email', label: 'Email', render: (row) => row.email },
    { key: 'phone', label: 'Phone', className: 'cell-center', render: (row) => row.phone ?? '-' },
    { key: 'role', label: 'Role', className: 'cell-center', render: (row) => {
      // Primary role (drives which portal they land in) first and labelled;
      // any additional roles listed after it, so neither hides the other.
      const { primary, additional } = splitRoles(row);
      return (
        <span className="p23-role-cell">
          {primary ? <span className="p23-role-primary"><StatusBadge value={primary} /><span className="p23-role-tag">Primary</span></span> : '-'}
          {additional.length > 0 && <span className="p23-role-extra">Also: {additional.join(', ')}</span>}
        </span>
      );
    } },
    { key: 'status', label: 'Status', className: 'cell-center', render: (row) => {
      const status = accountStatus(row);
      return (
        <span className="p23-status-cell">
          <StatusBadge value={status.label} />
          <span className="p23-status-detail">{status.detail}</span>
        </span>
      );
    } },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions">
          <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title={`Edit ${row.name}`} aria-label={`Edit ${row.name}`}><Icon name="edit" size={14} /></button>
          {row.id !== currentUserId && (
            row.is_active ? (
              <button className="btn-archive-action icon-btn" onClick={() => onToggleActive(row, false)} type="button" title="Deactivate (reversible)" aria-label={`Deactivate ${row.name}`}><Icon name="archive" size={14} /></button>
            ) : (
              <button className="btn-edit-action icon-btn" onClick={() => onToggleActive(row, true)} type="button" title={row.approved_at ? 'Reactivate' : 'Review & approve'} aria-label={row.approved_at ? `Reactivate ${row.name}` : `Review and approve ${row.name}`}><Icon name="undo" size={14} /></button>
            )
          )}
        </div>
      ),
    },
  ];
}

export function locationColumns(currentUser, onViewOnMap, onEdit) {
  return [
  { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.location_record_id ?? 'Current' },
  { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
  { key: 'status', label: 'Status', className: 'cell-center', render: (row) => <StatusBadge value={row.vehicle?.status ?? '-'} /> },
  { key: 'current_location', label: 'Current Location', render: (row) => row.current_location ?? '-' },
  { key: 'address_area', label: 'Address / Area', render: (row) => row.address_area ?? '-' },
  {
    key: 'updated_by',
    label: 'Updated By',
    className: 'cell-center',
    render: (row) => <UserAvatarName user={row.is_current_snapshot ? currentUser : row.updated_by} />,
  },
  { key: 'date_updated', label: 'Date Updated', className: 'cell-center', render: (row) => <DateBadge value={row.updated_at} /> },
  { key: 'time', label: 'Time', className: 'cell-center', render: (row) => formatTime(row.updated_at) },
  {
    key: 'action',
    label: 'Action',
    locked: true,
    className: 'cell-center',
    render: (row) => (
      <div className="row-actions">
        {hasRole(currentUser, 'Admin') && (
          <button
            className="btn-edit-action icon-btn"
            onClick={() => onEdit(row)}
            title="Update this vehicle's location"
            aria-label="Update this vehicle's location"
            type="button"
          >
            <Icon name="edit" size={14} />
          </button>
        )}
        <button
          className="btn-view-action icon-btn"
          onClick={() => onViewOnMap(row)}
          title="View vehicle on map"
          aria-label="View vehicle on map"
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    ),
  },
  ];
}

export function conditionColumns(user, onEdit, deleteRecord, onCreateTicketFromCondition, onSuggestScheduleFromCondition, onAddCondition) {
  const columns = [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.condition_check_id ?? '-' },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'result', label: 'Result', className: 'cell-center', render: (row) => <StatusBadge value={row.condition_result} /> },
    { key: 'checked_by', label: 'Checked By', className: 'cell-center', render: (row) => <UserAvatarName user={row.checked_by} /> },
    { key: 'date', label: 'Date', className: 'cell-center', render: (row) => <DateBadge value={row.created_at} /> },
    { key: 'time', label: 'Time', className: 'cell-center', render: (row) => formatTime(row.created_at) },
  ];

  if (hasRole(user, 'Custodian')) {
    columns.push({
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => {
        // condition.edit is Custodian-only, and only for the check THEY
        // performed (backend 403s otherwise). Admin no longer gets this
        // column at all — Condition Monitoring is the Custodian's own data
        // to manage, not something Admin takes row-level action on.
        const canEdit = canDo(user, 'condition.edit') && String(row.checked_by?.id) === String(user.id);
        const canDelete = false;
        return (
        // A synthesized "Not Checked" row has no condition_check_id — there's
        // no record yet to create a ticket from, suggest a schedule against,
        // edit, or delete. Its only real action is filing the first check.
        !row.condition_check_id ? (
          <div className="row-actions">
            {onAddCondition && (
              <button className="btn-confirm-action icon-btn" onClick={() => onAddCondition(row)} type="button" title="Record Condition" aria-label="Record Condition"><Icon name="plus" size={14} /></button>
            )}
          </div>
        ) : (
        <div className="row-actions">
          {/* #2 — Admin can turn a problem-finding condition check (Needs
              Repair OR Needs Inspection — anything short of Good) into a
              pre-diagnosed ticket in one click, instead of someone having to
              redescribe the same problem in a separate Issue Report just to
              get it in front of Admin. Reserved as its own slot (hidden, not
              removed) even when this row doesn't qualify — otherwise
              Edit/Delete shift left on every row that lacks it, and the
              column stops lining up. */}
          {(canDo(user, 'ticket.create') || canDo(user, 'ticket.propose')) && onCreateTicketFromCondition && (
            row.condition_result !== 'Good' ? (
              <button className="btn-confirm-action icon-btn" onClick={() => onCreateTicketFromCondition(row)} type="button" title={canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'} aria-label={canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'}><Icon name="ticket" size={14} /></button>
            ) : (
              <button
                className="btn-confirm-action icon-btn"
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                disabled
                style={{ visibility: 'hidden', pointerEvents: 'none' }}
              >
                <Icon name="ticket" size={14} />
              </button>
            )
          )}
          {/* Custodian or Admin can propose a preventive schedule from any
              condition check — not gated to a bad result, since "let's plan
              a checkup" is a reasonable call even on a Good vehicle. */}
          {onSuggestScheduleFromCondition && (
            <button className="btn-view-action icon-btn" onClick={() => onSuggestScheduleFromCondition(row)} type="button" title="Suggest Maintenance Schedule" aria-label="Suggest Maintenance Schedule"><Icon name="calendar" size={14} /></button>
          )}
          {canEdit && (
            <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          )}
          {canDelete && (
            <button className="btn-delete-action icon-btn" onClick={() => deleteRecord(`/conditions/${row.condition_check_id}`, 'Condition check deleted.', `Delete this "${row.condition_result}" condition check for ${row.vehicle?.vehicle_name ?? 'this vehicle'}? This cannot be undone.`, { title: 'Delete condition check', confirmLabel: 'Delete' })} type="button" title="Delete" aria-label="Delete"><Icon name="trash" size={14} /></button>
          )}
        </div>
        )
        );
      },
    });
  }

  return columns;
}

export function issueColumns(role, onEdit, onCreateTicketFromIssue, setUserInfoTarget, onView, deleteRecord, user, onViewTicket, onDismiss) {
  const columns = [
    { key: 'id', label: 'ID', width: '5%', locked: true, className: 'cell-center', render: (row) => row.issue_report_id },
    {
      key: 'issue',
      label: 'Issue',
      width: '12%',
      render: (row) => (
        <div className="issue-cell">
          <div className="issue-cell-top">
            <span className="issue-type">{row.issue_type}</span>
          </div>
        </div>
      ),
    },
    { key: 'vehicle', label: 'Vehicle', width: '28%', render: (row) => <VehicleCell vehicle={row.vehicle} /> },
    { key: 'plate', label: 'Plate Number', width: '7%', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'severity', label: 'Severity', width: '9%', className: 'cell-center', render: (row) => <TicketStatusBadge value={row.severity_level} /> },
    { key: 'status', label: 'Status', width: '9%', className: 'cell-center', render: (row) => <StatusBadge value={row.status} /> },
    {
      key: 'reported_by',
      label: 'Reported By',
      width: '12%',
      className: 'cell-center',
      render: (row) => (
        row.reported_by
          ? <UserAvatarName user={row.reported_by} />
          : <span className="issue-reporter">-</span>
      ),
    },
    { key: 'date', label: 'Date', width: '9%', className: 'cell-center', render: (row) => <DateBadge value={row.created_at} /> },
  ];

  // Which ticket (if any) this report became — a link, or a dash when nobody
  // has started one. Only roles that can open tickets see it.
  if (['Admin', 'Custodian'].includes(role) && onViewTicket) {
    columns.splice(columns.length - 1, 0, {
      key: 'ticket',
      label: 'Ticket',
      width: '8%',
      className: 'cell-center',
      render: (row) => (row.maintenance_ticket
        ? (
          <span className="cell-stack">
            <button
              type="button"
              className="issue-reporter-link"
              onClick={(e) => { e.stopPropagation(); onViewTicket({ ticket_id: row.maintenance_ticket.ticket_id }); }}
            >
              Ticket #{row.maintenance_ticket.ticket_id}
            </button>
            {row.maintenance_ticket.status && <small className="cell-subtext">{row.maintenance_ticket.status}</small>}
          </span>
        )
        : <span className="muted" title="No ticket has been started for this report yet">No ticket</span>),
    });
  }

  if (['Admin', 'Maintenance Personnel'].includes(role)) {
    columns.push({
      key: 'action',
      label: 'Action',
      width: '10%',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions" style={{ flexWrap: 'nowrap' }}>
          {row.maintenance_ticket && onViewTicket ? (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.maintenance_ticket.ticket_id })} type="button" title={`View Ticket #${row.maintenance_ticket.ticket_id}`} aria-label={`View Ticket #${row.maintenance_ticket.ticket_id}`}><Icon name="eye" size={14} /></button>
          ) : (
            <button className="btn-view-action icon-btn" onClick={() => onView(row)} type="button" title="View" aria-label="View"><Icon name="eye" size={14} /></button>
          )}
          {/* issue.edit is Admin+Custodian only (Phase B4 narrowed Maintenance
              Personnel out) — gated by ability rather than this block's role
              condition since the two no longer match. */}
          {canDo(user, 'issue.edit') && (
            <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Update" aria-label="Update"><Icon name="edit" size={14} /></button>
          )}
          {canDo(user, 'issue.dismiss') && onDismiss && issueNeedsTicket(row) && (
            <button className="btn-delete-action icon-btn" onClick={() => onDismiss(row)} type="button" title="Dismiss this issue" aria-label="Dismiss this issue"><Icon name="close" size={14} /></button>
          )}
          {(canDo(user, 'ticket.create') || canDo(user, 'ticket.propose')) && ['Pending', 'Under Review'].includes(row.status) && !row.maintenance_ticket && (
            <button className="btn-confirm-action icon-btn" onClick={() => onCreateTicketFromIssue(row)} type="button" title={canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'} aria-label={canDo(user, 'ticket.propose') ? 'Propose Ticket' : 'Create Ticket'}><Icon name="ticket" size={14} /></button>
          )}
        </div>
      ),
    });
  }

  if (role === 'Custodian') {
    columns.push({
      label: 'Action',
      width: '10%',
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions" style={{ flexWrap: 'nowrap' }}>
          {row.maintenance_ticket && onViewTicket ? (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.maintenance_ticket.ticket_id })} type="button" title={`View Ticket #${row.maintenance_ticket.ticket_id}`} aria-label={`View Ticket #${row.maintenance_ticket.ticket_id}`}><Icon name="eye" size={14} /></button>
          ) : (
            <button className="btn-view-action icon-btn" onClick={() => onView(row)} type="button" title="View" aria-label="View"><Icon name="eye" size={14} /></button>
          )}
          {/* A Custodian turns a flagged concern into a ticket proposal right
              from the row — only while the issue can still take one. */}
          {canDo(user, 'ticket.propose') && onCreateTicketFromIssue && ['Pending', 'Under Review'].includes(row.status) && !row.maintenance_ticket && (
            <button className="btn-confirm-action icon-btn" onClick={() => onCreateTicketFromIssue(row)} type="button" title="Propose Ticket" aria-label="Propose Ticket"><Icon name="ticket" size={14} /></button>
          )}
          {row.status === 'Pending' && (
            <>
              <button className="btn-edit-action icon-btn" onClick={() => onEdit(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
              <button className="btn-delete-action icon-btn" onClick={() => deleteRecord(`/issues/${row.issue_report_id}`, 'Issue deleted.', `Delete this "${row.issue_type}" report for ${row.vehicle?.vehicle_name ?? 'this vehicle'}? This cannot be undone.`, { title: 'Delete issue report', confirmLabel: 'Delete' })} type="button" title="Delete" aria-label="Delete"><Icon name="trash" size={14} /></button>
            </>
          )}
        </div>
      ),
    });
  }

  return columns;
}

export function maintenanceColumns(role, setEditTarget, updateRecord, onViewRecord, user) {
  const columns = [
    { key: 'id', label: 'ID', width: '4%', locked: true, className: 'cell-center', render: (row) => row.maintenance_id },
    { key: 'vehicle', label: 'Vehicle', width: '15%', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> },
    { key: 'plate', label: 'Plate Number', width: '8%', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    {
      key: 'type',
      label: 'Type',
      width: '9%',
      render: (row) => (
        <div>
          <div>{row.maintenance_type}</div>
          {row.is_external && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
              <span className="badge" style={{ fontSize: '0.68rem', background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd' }} title={row.external_vendor || 'External shop'}>External</span>
              {row.receipt_url && (
                <a href={resolvePhotoUrl(row.receipt_url)} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.72rem', fontWeight: 600, color: '#0369a1', textDecoration: 'underline' }}>
                  Receipt
                </a>
              )}
            </div>
          )}
          {row.source_vehicle && (
            <div style={{ marginTop: 2 }}>
              <span className="badge" style={{ fontSize: '0.68rem', background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }} title={`${row.part_name ? `${row.part_name} c` : 'C'}annibalized from ${row.source_vehicle.vehicle_name}`}>
                ⚙ {row.part_name ? `${row.part_name} ` : ''}from {row.source_vehicle.vehicle_name}
              </span>
            </div>
          )}
        </div>
      ),
    },
    { key: 'source', label: 'Source', width: '9%', className: 'cell-center', render: (row) => <StatusBadge value={row.source} /> },
    { key: 'personnel', label: 'Personnel', width: '10%', className: 'cell-center', render: (row) => <UserAvatarName user={row.maintenance_personnel} fallback={row.performed_by_other ?? '-'} /> },
    { key: 'progress', label: 'Progress', width: '8%', className: 'cell-center', render: (row) => <StatusBadge value={row.progress_status} /> },
    { key: 'verification', label: 'Verification', width: '8%', className: 'cell-center', render: (row) => row.verification_result ? <StatusBadge value={row.verification_result} /> : '-' },
    { key: 'date_started', label: 'Date Started', width: '5%', className: 'cell-center', render: (row) => <DateBadge value={row.date_started} /> },
    { key: 'date_completed', label: 'Date Completed', width: '5%', className: 'cell-center', render: (row) => <DateBadge value={row.date_completed} /> },
    {
      key: 'action',
      label: 'Action',
      width: '8%',
      locked: true,
      className: 'cell-center',
      render: (row) => (
        <div className="row-actions" style={{ flexWrap: 'wrap' }}>
          {onViewRecord && (
            <button className="btn-view-action icon-btn" onClick={() => onViewRecord(row)} type="button" title="View" aria-label="View"><Icon name="eye" size={14} /></button>
          )}
          {/* Phase B4 — record.edit narrowed to Admin only (Custodian is
              read-only here now; Maintenance Personnel never reaches this
              module at all — see modulesByRole). */}
          {canDo(user, 'record.edit') && (
            <button className="btn-edit-action icon-btn" onClick={() => setEditTarget(row)} type="button" title="Edit" aria-label="Edit"><Icon name="edit" size={14} /></button>
          )}
          {canDo(user, 'record.confirm') && row.verification_result === 'Passed' && row.progress_status !== 'Completed' ? (
            <>
              <button className="btn-confirm-action icon-btn" onClick={() => updateRecord(`/maintenance-records/${row.maintenance_id}/confirm`, { confirmed: true }, 'Maintenance confirmed.')} type="button" title="Confirm" aria-label="Confirm"><Icon name="checkCircle" size={14} /></button>
              <button className="btn-reopen-action icon-btn" onClick={() => updateRecord(`/maintenance-records/${row.maintenance_id}/confirm`, { confirmed: false }, 'Maintenance reopened.')} type="button" title="Reopen" aria-label="Reopen"><Icon name="undo" size={14} /></button>
            </>
          ) : null}
          {/* Unified into the one ledger every role sees — no more separate
              "Needs Verification" tab/page. Same self-verification guard the
              old maintenanceStatusColumns had: a Custodian who performed this
              repair themselves can't be the one who verifies it. */}
          {canDo(user, 'record.verify') && row.progress_status === 'For Verification' && (
            String(row.maintenance_personnel_id) === String(user?.id) ? (
              <span className="muted" title="You performed this repair — another Custodian needs to verify it.">Awaiting another Custodian</span>
            ) : (
              <button className="btn-edit-action icon-btn" onClick={() => setEditTarget({ ...row, __verify: true })} type="button" title="Verify" aria-label="Verify"><Icon name="checkCircle" size={14} /></button>
            )
          )}
        </div>
      ),
    },
  ];

  return columns;
}

export function maintenanceStatusColumns(setEditTarget, currentUserId) {
  return [
    { key: 'id', label: 'ID', locked: true, className: 'cell-center', render: (row) => row.maintenance_id },
    { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (row) => row.vehicle?.plate_number ?? '-' },
    { key: 'type', label: 'Type', className: 'cell-center', render: (row) => row.maintenance_type },
    { key: 'source', label: 'Source', className: 'cell-center', render: (row) => <StatusBadge value={row.source} /> },
    { key: 'personnel', label: 'Personnel', className: 'cell-center', render: (row) => <UserAvatarName user={row.maintenance_personnel} fallback={row.performed_by_other ?? '-'} /> },
    { key: 'progress', label: 'Progress', className: 'cell-center', render: (row) => <StatusBadge value={row.progress_status} /> },
    {
      key: 'action',
      label: 'Action',
      locked: true,
      className: 'cell-center',
      render: (row) => {
        // The backend blocks a Custodian from verifying their own repair
        // (dual-role Custodian/mechanic accounts can log one) — matching
        // that here instead of showing a button that just 403s on submit.
        const isOwnRepair = currentUserId != null && String(row.maintenance_personnel_id) === String(currentUserId);
        if (isOwnRepair) {
          return <span className="muted" title="You performed this repair — another Custodian needs to verify it.">Awaiting another Custodian</span>;
        }
        return <button className="btn-edit-action icon-btn" onClick={() => setEditTarget(row)} type="button" title="Verify" aria-label="Verify"><Icon name="checkCircle" size={14} /></button>;
      },
    },
  ];
}

export function scheduleColumns(onEdit, deleteRecord, onComplete, currentUser, onViewRecord, restoreRecord, onReassign, onViewTicket, onApprove, onDecline) {
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
          {/* TicketStatusBadge, not the plain StatusBadge — its colorMap
              already covers Pending Approval/Declined (shared with tickets);
              Scheduled/Completed/Cancelled fall back to the same plain
              style StatusBadge gave them, so this is a strict addition. */}
          <TicketStatusBadge value={row.status} />
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
          {row.status === 'Declined' && row.decline_reason && (
            <span
              style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', cursor: 'help' }}
              title={`Reason: ${row.decline_reason}`}
            >
              Why? <Icon name="info" size={11} />
            </span>
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
        <ScheduleActionMenu label={`Actions for schedule ${row.schedule_id}`}>
          {row.status === 'Scheduled' && row.resulting_ticket_id && onViewTicket && (
            <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.resulting_ticket_id })} type="button" title={`This schedule became Ticket #${row.resulting_ticket_id} — open it`} aria-label={`Open Ticket #${row.resulting_ticket_id}`}><Icon name="ticket" size={14} /></button>
          )}
          {row.status === 'Scheduled' && !row.resulting_ticket_id && onComplete && (currentUserId != null && String(row.assigned_to) === String(currentUserId)) && (
            <button className="schedule-menu-item" onClick={() => onComplete(row)} type="button"><Icon name="checkCircle" size={15} /><span>Mark as Done</span></button>
          )}
          {row.status === 'Completed' && row.resulting_maintenance_id && onViewRecord && (
            <button className="schedule-menu-item" onClick={() => onViewRecord(row)} type="button"><Icon name="wrench" size={15} /><span>View Maintenance Record</span></button>
          )}
          {/* Admin reviews a Custodian's booked schedule before it goes live
              — same propose/approve/decline shape as a ticket proposal. A
              Declined row can still be approved directly (no undecline
              needed first), same as tickets. */}
          {canDo(currentUser, 'schedule.approve') && ['Pending Approval', 'Declined'].includes(row.status) && onApprove && (
            <button className="schedule-menu-item" onClick={() => onApprove(row)} type="button"><Icon name="checkCircle" size={15} /><span>Approve Schedule</span></button>
          )}
          {canDo(currentUser, 'schedule.decline') && row.status === 'Pending Approval' && onDecline && (
            <button className="schedule-menu-item is-danger" onClick={() => onDecline(row)} type="button"><Icon name="close" size={15} /><span>Decline Schedule</span></button>
          )}
          {/* Edit/Delete/Restore are Custodian-only abilities (config/
              permissions.php: schedule.edit/.delete/.restore => ['Custodian']
              — Admin doesn't hold them), gated by canDo rather than role so
              this actually matches what the backend will accept. Any
              Custodian may edit or cancel any schedule in their barangay,
              not only the ones they booked. A Maintenance Personnel assigned
              to it only ever gets to act on it via Mark as Done above. */}
          {canDo(currentUser, 'schedule.edit') && (
            <button className="schedule-menu-item" onClick={() => onEdit(row)} type="button"><Icon name="edit" size={15} /><span>Edit Schedule</span></button>
          )}
          {/* schedule.reassign (Admin only, config/permissions.php) — Admin's
              one remaining lever over an already-booked schedule: hand a
              still-open Scheduled row to a different Maintenance Personnel
              without cancelling and re-booking it. */}
          {canDo(currentUser, 'schedule.reassign') && row.status === 'Scheduled' && onReassign && (
            <button className="schedule-menu-item" onClick={() => onReassign(row)} type="button"><Icon name="undo" size={15} /><span>Reassign</span></button>
          )}
          {/* Cancelling a schedule is a soft cancel — the row survives — so a
              cancelled one gets Restore instead of a Delete that would do
              nothing. Same swap vehicleColumns makes for archived vehicles. */}
          {row.status === 'Cancelled'
            ? canDo(currentUser, 'schedule.restore') && restoreRecord && (
              <button className="schedule-menu-item" onClick={() => restoreRecord(`/maintenance-schedules/${row.schedule_id}/restore`, 'Schedule restored.', 'Restore this cancelled schedule back to Scheduled?', { title: 'Restore schedule' })} type="button"><Icon name="undo" size={15} /><span>Restore Schedule</span></button>
            )
            : canDo(currentUser, 'schedule.delete') && (
              <button className="schedule-menu-item is-danger" onClick={() => deleteRecord(`/maintenance-schedules/${row.schedule_id}`, 'Schedule cancelled.', `Cancel the ${row.maintenance_type} schedule for ${row.vehicle?.vehicle_name ?? 'this vehicle'}? It can be restored later if needed.`, { title: 'Cancel schedule', confirmLabel: 'Cancel schedule' })} type="button"><Icon name="trash" size={15} /><span>Cancel Schedule</span></button>
            )}
        </ScheduleActionMenu>
      ),
    },
  ];
}

export const historyColumns = [
  { key: 'id', label: 'Entry #', locked: true, render: (row) => row.history_id },
  { key: 'vehicle', label: 'Vehicle', locked: true, render: (row) => <VehicleCell vehicle={row.vehicle} /> }, { key: 'plate', label: 'Plate Number', render: (row) => row.vehicle?.plate_number ?? '-' },
  { key: 'activity', label: 'Activity', render: (row) => row.activity_type },
  { key: 'related_record', label: 'Related Record', render: (row) => <RelatedRecordLink kind={historyRecordKind(row.related_table)} id={row.related_record_id} /> },
  { key: 'updated_by', label: 'Updated By', render: (row) => <UserAvatarName user={row.updated_by} /> },
  { key: 'date', label: 'Date', render: (row) => <DateBadge value={row.created_at} /> },
  { key: 'time', label: 'Time', render: (row) => formatTime(row.created_at) },
];

// Extra args (vehicle/ticket openers) are accepted for older call sites but no
// longer needed — LogRecordCell navigates by itself.
export function logColumns(vehicles) {
  return [
    { key: 'datetime', label: 'Date and Time', className: 'cell-center', render: (row) => formatLogDateTime(row.created_at) },
    {
      key: 'item',
      label: 'Affected Record',
      // Vehicle rows show the vehicle's own name; every other module reads
      // as "<Kind> #id" (linked when the app has a page for it) instead of a
      // bare number — see LogRecordCell / lib/activity.js.
      render: (row) => <LogRecordCell row={row} vehicles={vehicles} />,
    },
    {
      key: 'module',
      label: 'Module',
      className: 'cell-center',
      render: (row) => {
        const tone = moduleBadgeTone(row.module ?? '');
        return <span className="log-category-tag" style={{ background: tone.bg, color: tone.color }}>{row.module ?? '-'}</span>;
      },
    },
    { key: 'action', label: 'What Happened', className: 'cell-text', render: (row) => (
      <span className="p23-log-action"><strong>{actionLabel(row.action)}</strong>{row.details ? <span>{row.details}</span> : null}</span>
    ) },
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

export function reportColumns(rows) {
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

// =========================================================================
// TICKET TABLE VIEW COLUMNS (alternative to the ticket card grid)
// =========================================================================

// Collapsible highlight strip above the main ticket table — surfaces
// tickets whose sub-issues are all done but haven't been closed yet, so
// an Admin/Custodian can spot and act on them without hunting through the
// full list below. Always visible (even at a count of 0) so it reads as a
// permanent fixture of the page, not something that randomly appears.
export function readyToCloseColumns() {
  return [
    { key: 'ticket_id', label: 'Ticket ID', className: 'cell-center', render: (r) => <span className="row-title-text">#{r.ticket_id}</span> },
    { key: 'vehicle', label: 'Vehicle', render: (r) => <VehicleCell vehicle={r.vehicle} isRowTitle={false} /> },
    { key: 'title', label: 'Title', render: (r) => r.ticket_title },
    { key: 'priority', label: 'Priority', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.priority} /> },
    { key: 'progress', label: 'Sub-Issues', className: 'cell-center', render: (r) => `${r.progress?.done ?? 0}/${r.progress?.total ?? 0} done` },
    { key: 'created', label: 'Created', className: 'cell-center', render: (r) => <DateBadge value={r.created_at} /> },
  ];
}

export function ticketTableColumns(unreadByTicket = {}) {
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

export const ticketArchiveColumns = [
  { key: 'archive_id', label: 'Archive ID', locked: true, className: 'cell-center', render: (r) => r.archive_id },
  { key: 'ticket_id', label: 'Ticket ID', className: 'cell-center', render: (r) => r.ticket_id },
  { key: 'title', label: 'Title', render: (r) => r.ticket_title },
  { key: 'vehicle', label: 'Vehicle', render: (r) => <VehicleCell vehicle={r.vehicle ?? { vehicle_name: r.vehicle_name, plate_number: r.plate_number }} /> },
  { key: 'plate', label: 'Plate Number', className: 'cell-center', render: (r) => (r.vehicle?.plate_number ?? r.plate_number) ?? '-' },
  { key: 'expenses', label: 'Expenses', className: 'cell-center', render: (r) => r.maintenance_cost ? `₱${Number(r.maintenance_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '₱0.00' },
  { key: 'final_status', label: 'Final Status', className: 'cell-center', render: (r) => <TicketStatusBadge value={r.final_status} /> },
  { key: 'archived_by', label: 'Archived By', className: 'cell-center', render: (r) => <UserAvatarName user={r.archived_by} fallback="—" /> },
  { key: 'archived_at', label: 'Archived At', className: 'cell-center', render: (r) => <DateBadge value={r.archived_at} /> },
  { key: 'time', label: 'Time', className: 'cell-center', render: (r) => formatTime(r.archived_at) },
];
