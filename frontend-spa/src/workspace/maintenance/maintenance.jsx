import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../components/Icon';
import api from '../../api/axios';
import useDepsChanged from '../../hooks/useDepsChanged';
import { DateBadge, ModuleLoader, ModulePanel, StatusBadge, UserAvatarName, VehicleCell } from '../components/ui';
import { SmartForm } from '../forms/SmartForm';
import { formatDate, formatTime, resolvePhotoUrl } from '../lib/format';
import { hasRole } from '../lib/permissions';
import { MAINTENANCE_PROGRESS_STAGES, RECURRENCE_LABEL, isClosedUnverified, isScheduleOverdue, maintenanceStageIndex, scheduleDueLabel, scheduleUrgencyBucket } from '../lib/workflow';

// Card-view counterpart to the Maintenance Records table — mirrors TicketCard
// (and reuses its themed .ticket-card-* classes) so both modules read as the
// same product rather than two different card systems.
export function MaintenanceRecordCard({ record, onClick }) {
  const stageIndex = maintenanceStageIndex(record);
  const isDone = record.progress_status === 'Completed';
  const unverified = isClosedUnverified(record);
  const stagesDone = stageIndex + 1;

  return (
    <div className="ticket-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="ticket-card-content-wrapper">
        <div className="ticket-card-info">
          <div className="ticket-card-top">
            <span className="ticket-card-id">#{record.maintenance_id}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <StatusBadge value={record.source} />
              <StatusBadge value={record.progress_status} />
            </div>
          </div>
          <p className="ticket-card-title">{record.maintenance_type}</p>
          <p className="ticket-card-vehicle">
            {record.vehicle?.vehicle_name}{record.vehicle?.plate_number ? ` · ${record.vehicle.plate_number}` : ''}
          </p>
        </div>
        {record.vehicle?.photo_url && (
          <div className="ticket-card-photo">
            <img src={resolvePhotoUrl(record.vehicle.photo_url)} alt={record.vehicle.vehicle_name} />
          </div>
        )}
      </div>

      {/* Same four stages as the detail page, compressed to a single bar —
          green only once it's genuinely finished. */}
      <div style={{ margin: '8px 0 2px' }}>
        <div style={{ height: 6, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${(stagesDone / MAINTENANCE_PROGRESS_STAGES.length) * 100}%`,
            background: isDone ? '#16a34a' : '#d97706',
            borderRadius: 999,
          }} />
        </div>
        <span className="muted" style={{ fontSize: '0.72rem' }}>
          {MAINTENANCE_PROGRESS_STAGES[stageIndex] ?? record.progress_status} · stage {stagesDone} of {MAINTENANCE_PROGRESS_STAGES.length}
        </span>
      </div>

      {(unverified || record.is_external || record.source_vehicle) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0 2px' }}>
          {unverified && (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }} title="Closed by Admin without Custodian verification.">
              UNVERIFIED CLOSE
            </span>
          )}
          {record.is_external && (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd' }} title={record.external_vendor || 'External shop'}>
              EXTERNAL
            </span>
          )}
          {record.source_vehicle && (
            <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }} title={`${record.part_name ? `${record.part_name} c` : 'C'}annibalized from ${record.source_vehicle.vehicle_name}`}>
              ⚙ {record.part_name ? `${record.part_name} — ` : ''}{record.source_vehicle.vehicle_name}
            </span>
          )}
        </div>
      )}

      <div className="ticket-card-bottom">
        {record.verification_result
          ? <StatusBadge value={record.verification_result} />
          : <span className="muted" style={{ fontSize: '0.72rem' }}>{record.maintenance_personnel?.name ?? record.performed_by_other ?? '—'}</span>}
        <span className="ticket-card-date">{formatDate(record.date_completed ?? record.date_started)}</span>
      </div>
    </div>
  );
}

// Read-rich detail PAGE for a single Maintenance Record — same spirit as the
// Ticket detail page (a visual progress trail instead of a flat status
// word), but for the linear Assigned -> ... -> Completed chain a Record
// follows instead of a ticket's per-sub-issue breakdown. Reachable both from
// the Maintenance Records table and from a completed Schedule row, so
// there's one consistent "view what actually happened" experience instead
// of only ever landing in the plain edit form.
export function MaintenanceRecordDetail({ record, onConfirm, onReopen, onDecisionClose, canManage }) {
  const [closing, setClosing] = useState(false);
  const onHold = record.progress_status === 'On Hold - Awaiting Parts';
  const stageIndex = maintenanceStageIndex(record);
  const canConfirm = canManage && record.verification_result === 'Passed' && record.progress_status !== 'Completed';
  // Decision-close is only offered where it's actually meaningful: not
  // already finished, and not already passed verification (a pass should go
  // through Confirm so it isn't overwritten as "unverified").
  const canDecisionClose = canManage && record.progress_status !== 'Completed' && record.verification_result !== 'Passed';
  // A record that reached Completed with no verification result was closed on
  // an Admin decision, not on verified work — never let the two look alike.
  const closedUnverified = isClosedUnverified(record);

  return (
    <ModulePanel description={`Maintenance #${record.maintenance_id}`}>
      <div className="maintenance-record-detail">
        <div className="maintenance-record-hero">
          <VehicleCell vehicle={record.vehicle} />
          <span className="muted">{record.maintenance_type}</span>
          <StatusBadge value={record.source} />
          {onHold && (
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>ON HOLD — AWAITING PARTS</span>
          )}
          {record.is_external && (
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd' }}>External{record.external_vendor ? ` — ${record.external_vendor}` : ''}</span>
          )}
          {record.source_vehicle && (
            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>⚙ Part from {record.source_vehicle.vehicle_name}</span>
          )}
          {closedUnverified && (
            <span
              style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
              title="Admin closed this without waiting for Custodian verification — nobody independently checked the work."
            >
              <Icon name="alert" size={11} /> CLOSED WITHOUT VERIFICATION
            </span>
          )}
        </div>

        {/* Progress trail — where this record actually sits, not just a
            status word. Filled/checked nodes are stages already passed. */}
        <div className="maintenance-progress">
          {MAINTENANCE_PROGRESS_STAGES.map((stage, i) => (
            <div key={stage} style={{ display: 'flex', alignItems: 'flex-start', flex: i === MAINTENANCE_PROGRESS_STAGES.length - 1 ? '0 0 auto' : 1 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 56 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  background: i < stageIndex || (i === stageIndex && stage === 'Completed') ? '#16a34a' : i === stageIndex ? '#2563eb' : '#e2e8f0',
                  color: i <= stageIndex ? '#fff' : '#94a3b8', fontSize: '0.74rem', fontWeight: 700,
                }}>
                  {i < stageIndex || (i === stageIndex && stage === 'Completed') ? <Icon name="checkCircle" size={14} /> : i + 1}
                </div>
                <span style={{ fontSize: '0.7rem', color: i <= stageIndex ? '#0f172a' : '#94a3b8', fontWeight: i === stageIndex ? 700 : 500, textAlign: 'center' }}>{stage}</span>
              </div>
              {i < MAINTENANCE_PROGRESS_STAGES.length - 1 && (
                <div style={{ flex: 1, height: 2, marginTop: 13, background: i < stageIndex ? '#16a34a' : '#e2e8f0' }} />
              )}
            </div>
          ))}
        </div>

        <div className="maintenance-detail-grid">
          <div>
            <span className="maintenance-detail-label">Problem / Reason</span>
            {record.problem_reason || '—'}
          </div>
          <div>
            <span className="maintenance-detail-label">Action Taken</span>
            {record.action_taken || '—'}
          </div>
          <div>
            <span className="maintenance-detail-label">Parts Used</span>
            {record.parts_used || '—'}
          </div>
          <div>
            <span className="maintenance-detail-label">Cost</span>
            {record.maintenance_cost != null ? `₱${Number(record.maintenance_cost).toLocaleString()}` : '—'}
          </div>
          <div>
            <span className="maintenance-detail-label">Personnel</span>
            <UserAvatarName user={record.maintenance_personnel} fallback={record.performed_by_other ?? '-'} />
          </div>
          <div>
            <span className="maintenance-detail-label">Date Started / Completed</span>
            {formatDate(record.date_started)} — {formatDate(record.date_completed)}
          </div>
        </div>

        {/* Proof shown inline — the whole point of this view over the plain
            edit form is not having to click away just to see it. */}
        {record.receipt_url && (
          <div>
            <span className="muted" style={{ fontSize: '0.74rem', display: 'block', marginBottom: 6 }}>Proof of Completion</span>
            <a href={resolvePhotoUrl(record.receipt_url)} target="_blank" rel="noopener noreferrer">
              <img src={resolvePhotoUrl(record.receipt_url)} alt="Proof of completion" style={{ maxWidth: 360, maxHeight: 280, borderRadius: 8, border: '1px solid #e2e8f0', display: 'block' }} />
            </a>
          </div>
        )}

        {record.verification_result && (
          <div style={{ padding: '10px 12px', borderRadius: 8, maxWidth: 480, background: record.verification_result === 'Passed' ? '#ecfdf5' : '#fef2f2', border: `1px solid ${record.verification_result === 'Passed' ? '#a7f3d0' : '#fecaca'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', fontWeight: 700, color: record.verification_result === 'Passed' ? '#065f46' : '#991b1b' }}>
              <Icon name={record.verification_result === 'Passed' ? 'checkCircle' : 'alert'} size={15} />
              Verification: {record.verification_result}
            </div>
            {record.verification_notes && <p style={{ margin: '4px 0 0', fontSize: '0.82rem' }}>{record.verification_notes}</p>}
            {record.verified_by && <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.76rem' }}>By {record.verified_by.name} · {formatDate(record.verified_at)}</p>}
          </div>
        )}

        {/* Why verification was skipped — mandatory at close time, so it's
            always here when the badge above is showing. */}
        {record.closure_reason && (
          <div style={{ padding: '10px 12px', borderRadius: 8, maxWidth: 480, background: '#fffbeb', border: '1px solid #fde68a' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', fontWeight: 700, color: '#92400e' }}>
              <Icon name="alert" size={15} /> Reason for closing without verification
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '0.82rem' }}>{record.closure_reason}</p>
          </div>
        )}

        {record.confirmed_by && (
          <p className="muted" style={{ fontSize: '0.78rem', margin: 0 }}>
            {closedUnverified ? 'Closed' : 'Confirmed'} by {record.confirmed_by.name} · {formatDate(record.confirmed_at)}
          </p>
        )}

        {canConfirm && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="primary-button" type="button" onClick={() => onConfirm(record)}>Confirm</button>
            <button className="ghost-button" type="button" onClick={() => onReopen(record)}>Reopen</button>
          </div>
        )}

        {canDecisionClose && !closing && (
          <div>
            <button className="ghost-button" type="button" onClick={() => setClosing(true)}>
              Close Without Verification
            </button>
            <p className="muted" style={{ fontSize: '0.76rem', margin: '6px 0 0', maxWidth: 480 }}>
              Ends this record now without waiting for a Custodian to check the work. Requires a reason, and the record stays permanently marked as unverified.
            </p>
          </div>
        )}

        {canDecisionClose && closing && (
          <div style={{ padding: '14px 16px', borderRadius: 8, maxWidth: 520, background: '#fffbeb', border: '1px solid #fde68a' }}>
            <h4 style={{ margin: '0 0 4px', fontSize: '0.92rem', color: '#92400e' }}>Close without Custodian verification</h4>
            <p className="muted" style={{ fontSize: '0.78rem', margin: '0 0 12px' }}>
              Nobody will have independently checked this work. The record will be permanently flagged as closed unverified, and Custodians will be notified the verification is no longer needed.
            </p>
            <SmartForm
              fields={[
                { label: 'Reason for closing without verification', name: 'closure_reason', type: 'textarea', rows: 2, required: true, fullWidth: true },
                {
                  label: 'Is the vehicle fit to return to service?',
                  name: 'returned_to_service',
                  type: 'select',
                  required: true,
                  fullWidth: true,
                  options: [
                    { value: 1, label: 'Yes — return it to Available' },
                    { value: 0, label: 'No — keep it Under Maintenance' },
                  ],
                },
              ]}
              onCancel={() => setClosing(false)}
              onSubmit={(payload) => onDecisionClose(record, payload)}
              submitLabel="Close Record"
              title=""
            />
          </div>
        )}
      </div>
    </ModulePanel>
  );
}

// Fetch-by-id wrapper — same pattern as TicketProfilePage: load once by the
// URL's :id, show a loader/not-found state, then hand the fetched record to
// the read-rich detail view above. Re-fetches after Confirm/Reopen so the
// progress trail reflects the new state without a manual refresh.
export function MaintenanceRecordProfilePage({ maintenanceId, onConfirm, onReopen, onDecisionClose, canManage }) {
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const fetchRecord = useCallback(() => api.get(`/maintenance-records/${maintenanceId}`), [maintenanceId]);

  // Re-fetch after Confirm/Reopen/Decision.
  const loadRecord = useCallback(() => {
    setLoading(true);
    fetchRecord()
      .then((response) => { setRecord(response.data); setNotFound(false); })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [fetchRecord]);

  if (useDepsChanged([maintenanceId])) setLoading(true);

  useEffect(() => {
    let cancelled = false;
    fetchRecord()
      .then((response) => { if (!cancelled) { setRecord(response.data); setNotFound(false); } })
      .catch(() => { if (!cancelled) setNotFound(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchRecord]);

  if (loading) return <ModuleLoader label="Loading maintenance record" />;

  if (notFound || !record) {
    return <ModulePanel description="This maintenance record could not be found — it may have been deleted." />;
  }

  return (
    <MaintenanceRecordDetail
      record={record}
      canManage={canManage}
      onConfirm={(r) => onConfirm(r).then(loadRecord)}
      onReopen={(r) => onReopen(r).then(loadRecord)}
      onDecisionClose={(r, payload) => onDecisionClose(r, payload).then(loadRecord)}
    />
  );
}

export function ScheduleActionMenu({ label, children }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const menuRef = useRef(null);
  const triggerRef = useRef(null);

  const openMenu = () => {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (bounds) {
      const menuWidth = 180;
      const estimatedHeight = 220;
      setPosition({
        top: bounds.bottom + estimatedHeight > window.innerHeight
          ? Math.max(8, bounds.top - estimatedHeight - 4)
          : bounds.bottom + 4,
        left: Math.max(8, Math.min(bounds.right - menuWidth, window.innerWidth - menuWidth - 8)),
      });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const closeOnScroll = () => setOpen(false);
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [open]);

  return (
    <div className="schedule-action-menu" ref={menuRef}>
      <button
        className="schedule-action-menu-trigger"
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          if (open) setOpen(false);
          else openMenu();
        }}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open && (
        <div className="schedule-action-menu-popover" role="menu" style={position} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

// Card-view counterpart to scheduleColumns — same information and the same
// action affordances, so neither view can do something the other can't.
// Deliberately NOT one big click target: unlike a Maintenance Record, a
// schedule has no detail page to open, and a whole-card click would fight
// with the action buttons it needs to carry.
export function MaintenanceScheduleCard({ row, currentUser, onComplete, onEdit, onDelete, onViewRecord, onRestore, onReassign, onViewTicket }) {
  const isAdmin = hasRole(currentUser, 'Admin');
  const currentUserId = currentUser?.id;
  const isMine = currentUserId != null && String(row.assigned_to) === String(currentUserId);
  const overdue = isScheduleOverdue(row);
  const urgency = scheduleUrgencyBucket(row);
  const dueLabel = scheduleDueLabel(row);
  const resulting = row.resulting_maintenance;
  // Once a due schedule has become a ticket, the ticket is where the work is
  // done — completing the schedule directly would be refused. Final senior
  // system review (2026-10-05, §2) — Admin no longer completes a schedule
  // directly (that's physically performing the work); only the assigned
  // Maintenance Personnel can.
  const canComplete = row.status === 'Scheduled' && !row.resulting_ticket_id && onComplete && isMine;
  const becameTicket = row.status === 'Scheduled' && row.resulting_ticket_id && onViewTicket;

  return (
    <article className={`ticket-card maintenance-schedule-card schedule-${String(row.status ?? '').toLowerCase()} urgency-${String(urgency ?? 'none').toLowerCase()}`}>
      <div className="ticket-card-content-wrapper">
        <div className="ticket-card-info">
          <div className="ticket-card-top">
            <span className="ticket-card-id">#{row.schedule_id}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <StatusBadge value={row.status} />
              {overdue && (
                <span className="schedule-urgency-badge is-overdue">OVERDUE</span>
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
      <div className="schedule-date-row">
        <span className={`schedule-date-value ${overdue ? 'is-overdue' : ''}`}>
          <Icon name="calendar" size={13} /> {formatDate(row.scheduled_date)}{row.scheduled_time ? ` · ${row.scheduled_time}` : ''}
        </span>
        {dueLabel && <span className={`schedule-due-label ${overdue ? 'is-overdue' : ''}`}>{dueLabel}</span>}
        <span className="schedule-repeat-label muted">
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

      <div className="row-actions schedule-card-actions" aria-label={`Actions for schedule ${row.schedule_id}`}>
        {canComplete && (
          <button className="btn-confirm-action schedule-action-button" onClick={() => onComplete(row)} type="button"><Icon name="checkCircle" size={14} /><span>Mark Done</span></button>
        )}
        {becameTicket && (
          <button className="btn-view-action icon-btn" onClick={() => onViewTicket({ ticket_id: row.resulting_ticket_id })} type="button" title={`This schedule became Ticket #${row.resulting_ticket_id} — open it`} aria-label={`Open Ticket #${row.resulting_ticket_id}`}><Icon name="ticket" size={14} /></button>
        )}
        {row.status === 'Completed' && row.resulting_maintenance_id && onViewRecord && (
          <button className="btn-view-action schedule-action-button" onClick={() => onViewRecord(row)} type="button"><Icon name="wrench" size={14} /><span>View Record</span></button>
        )}
        {/* Admin edits any schedule; a Custodian may only edit the one they
            themselves created — see scheduleColumns' matching Action column. */}
        {(isAdmin || (currentUserId != null && String(row.createdBy?.id) === String(currentUserId))) && (
          <button className="btn-edit-action schedule-action-button" onClick={() => onEdit(row)} type="button"><Icon name="edit" size={14} /><span>Edit</span></button>
        )}
        {/* Reassign/cancel stay Admin-only, unaffected by the ownership edit above. */}
        {isAdmin && (
          <>
            {/* schedule.reassign ability (Admin only). */}
            {row.status === 'Scheduled' && onReassign && (
              <button className="btn-view-action schedule-action-button" onClick={() => onReassign(row)} type="button"><Icon name="undo" size={14} /><span>Reassign</span></button>
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
    </article>
  );
}

// Card-view counterpart to historyColumns — same fields, laid out for a
// grid instead of a row.
export function HistoryCard({ row, onClick }) {
  return (
    <div className="history-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="history-card-top">
        <VehicleCell vehicle={row.vehicle} isRowTitle={false} />
        <span className="history-card-activity">{row.activity_type}</span>
      </div>
      {row.description && <p className="history-card-desc">{row.description}</p>}
      <div className="history-card-bottom">
        <UserAvatarName user={row.updated_by} />
        <span className="history-card-date">
          <DateBadge value={row.created_at} /> {formatTime(row.created_at)}
        </span>
      </div>
    </div>
  );
}
