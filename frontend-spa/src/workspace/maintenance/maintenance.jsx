import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../components/Icon';
import api from '../../api/axios';
import useDepsChanged from '../../hooks/useDepsChanged';
import { DateBadge, ModuleLoader, ModulePanel, StatusBadge, TicketStatusBadge, UserAvatarName, VehicleCell } from '../components/ui';
import { SmartForm } from '../forms/SmartForm';
import { formatDate, formatTime, resolvePhotoUrl } from '../lib/format';
import { canDo } from '../lib/permissions';
import {
  MAINTENANCE_PROGRESS_STAGES,
  MAINTENANCE_SOURCE_INFO,
  findNextScheduleOccurrence,
  formatMaintenanceCost,
  isClosedUnverified,
  isRecordReturnedForRework,
  isScheduleOverdue,
  maintenanceNextStep,
  maintenancePerformerText,
  maintenanceStageIndex,
  recurrenceSentence,
  scheduleDueLabel,
  scheduleStatusNote,
  scheduleUrgencyBucket,
} from '../lib/workflow';

const NEXT_STEP_ICON = { success: 'checkCircle', warning: 'alert', danger: 'alert', info: 'search', neutral: 'wrench' };

// The one stage trail for a Maintenance Record — the card, the detail page
// and (in text form) the table all read from maintenanceStageIndex(), so a
// record can never look like it's at a different stage in different views.
// Each step carries its state in text (screen-reader suffix + "on hold" /
// "rework" label), not only in colour.
export function MaintenanceStageTrail({ record, compact = false }) {
  const stageIndex = maintenanceStageIndex(record);
  const onHold = record.progress_status === 'On Hold - Awaiting Parts';
  const rework = isRecordReturnedForRework(record);
  const currentLabel = MAINTENANCE_PROGRESS_STAGES[stageIndex] ?? record.progress_status;

  return (
    <ol
      className={`p23-stage-trail${compact ? ' is-compact' : ''}`}
      aria-label={`Progress: ${currentLabel}${stageIndex >= 0 ? `, stage ${stageIndex + 1} of ${MAINTENANCE_PROGRESS_STAGES.length}` : ''}`}
    >
      {MAINTENANCE_PROGRESS_STAGES.map((stage, i) => {
        const done = i < stageIndex || (i === stageIndex && stage === 'Completed');
        const current = i === stageIndex && !done;
        const stalled = current && (onHold || rework);
        const state = done ? 'done' : current ? 'current' : 'upcoming';
        return (
          <li
            key={stage}
            className={`p23-stage is-${state}${stalled ? (rework ? ' is-rework' : ' is-hold') : ''}`}
            aria-current={current ? 'step' : undefined}
          >
            <span className="p23-stage-dot" aria-hidden="true">
              {done ? <Icon name="checkCircle" size={compact ? 12 : 14} /> : i + 1}
            </span>
            <span className="p23-stage-label">
              {stage}
              {current && onHold ? ' (on hold)' : ''}
              {current && rework ? ' (rework)' : ''}
            </span>
            <span className="p23-sr-only">{done ? ' — done' : current ? ' — current stage' : ' — not reached yet'}</span>
          </li>
        );
      })}
    </ol>
  );
}

// "What's happening, why, and who acts next" — leads the detail page and is
// summarised on the card, from the same maintenanceNextStep() helper.
function MaintenanceNextStep({ record, children }) {
  const step = maintenanceNextStep(record);
  if (!step) return null;
  return (
    <section className={`p23-next-step tone-${step.tone}`} aria-labelledby={`p23-next-step-${record.maintenance_id}`}>
      <h4 className="p23-next-step-title" id={`p23-next-step-${record.maintenance_id}`}>
        <Icon name={NEXT_STEP_ICON[step.tone] ?? 'info'} size={16} />
        {step.title}
      </h4>
      {step.reason && <p className="p23-next-step-reason">{step.reason}</p>}
      {step.next && <p className="p23-next-step-next">{step.next}</p>}
      {children}
    </section>
  );
}

// Source badge with what that source actually means attached, so "Field
// Repair" vs "From Issue Report" isn't left for the reader to guess.
function SourceBadge({ source }) {
  const info = MAINTENANCE_SOURCE_INFO[source];
  return (
    <span className="p23-source-badge" title={info?.description}>
      <StatusBadge value={source} />
    </span>
  );
}

// Badges that change how a record should be read — rework, unverified close,
// external shop, cannibalized part. Text first; colour only reinforces it.
function RecordFlags({ record }) {
  const rework = isRecordReturnedForRework(record);
  const unverified = isClosedUnverified(record);
  const onHold = record.progress_status === 'On Hold - Awaiting Parts';
  if (!rework && !unverified && !onHold && !record.is_external && !record.source_vehicle) return null;
  return (
    <div className="p23-chip-row">
      {rework && (
        <span className="p23-chip tone-danger" title={record.verification_notes || 'Failed Custodian verification.'}>
          <Icon name="alert" size={12} /> Failed verification — rework
        </span>
      )}
      {onHold && <span className="p23-chip tone-warning">On hold — awaiting parts</span>}
      {unverified && (
        <span className="p23-chip tone-warning" title="Closed by Admin without Custodian verification.">
          <Icon name="alert" size={12} /> Closed without verification
        </span>
      )}
      {record.is_external && (
        <span className="p23-chip tone-info" title={record.external_vendor || 'External shop'}>
          External{record.external_vendor ? ` — ${record.external_vendor}` : ''}
        </span>
      )}
      {record.source_vehicle && (
        <span className="p23-chip tone-accent" title={`${record.part_name ? `${record.part_name} c` : 'C'}annibalized from ${record.source_vehicle.vehicle_name}`}>
          Part{record.part_name ? ` (${record.part_name})` : ''} from {record.source_vehicle.vehicle_name}
        </span>
      )}
    </div>
  );
}

// Card-view counterpart to the Maintenance Records table — mirrors TicketCard
// (and reuses its themed .ticket-card-* classes) so both modules read as the
// same product rather than two different card systems.
export function MaintenanceRecordCard({ record, onClick }) {
  const step = maintenanceNextStep(record);
  const isDone = record.progress_status === 'Completed';
  const rework = isRecordReturnedForRework(record);
  const performer = maintenancePerformerText(record);
  const cost = formatMaintenanceCost(record.maintenance_cost);

  return (
    <div
      className={`ticket-card p23-record-card${rework ? ' is-rework' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Maintenance #${record.maintenance_id} — ${record.maintenance_type ?? ''}, ${record.vehicle?.vehicle_name ?? 'vehicle'}. ${step?.title ?? ''}. Open details`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
    >
      <div className="ticket-card-content-wrapper">
        <div className="ticket-card-info">
          <div className="ticket-card-top">
            <span className="ticket-card-id">#{record.maintenance_id}</span>
            <div className="p23-badge-group">
              <SourceBadge source={record.source} />
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
            <img src={resolvePhotoUrl(record.vehicle.photo_url)} alt="" />
          </div>
        )}
      </div>

      <MaintenanceStageTrail record={record} compact />

      {!isDone && step && (
        <p className={`p23-card-next tone-${step.tone}`}>
          <strong>{step.title}.</strong> {step.next}
        </p>
      )}

      <RecordFlags record={record} />

      <dl className="p23-record-meta">
        <div><dt>Performed by</dt><dd>{performer ?? 'Not recorded'}</dd></div>
        <div><dt>Cost</dt><dd>{cost ?? 'Not recorded'}</dd></div>
        <div>
          <dt>{record.date_completed ? 'Completed' : 'Started'}</dt>
          <dd>{record.date_completed ? formatDate(record.date_completed) : (record.date_started ? formatDate(record.date_started) : 'Not recorded')}</dd>
        </div>
      </dl>
    </div>
  );
}

// Splits the free-text / comma-separated parts_used into chips that wrap,
// instead of one long unbreakable line.
function PartsList({ value }) {
  const parts = String(value ?? '').split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return <span className="muted">None recorded</span>;
  return (
    <ul className="p23-parts-list">
      {parts.map((part, idx) => <li key={`${part}-${idx}`}>{part}</li>)}
    </ul>
  );
}

// Every decision on the record in the order it happened — start, work done,
// verification verdict, Admin confirmation/closure — instead of separate
// boxes in a fixed order that hid the sequence.
function RecordTimeline({ record }) {
  const closedUnverified = isClosedUnverified(record);
  const events = [];
  if (record.date_started) {
    events.push({ key: 'started', at: record.date_started, tone: 'neutral', title: 'Work started' });
  }
  if (record.date_completed) {
    events.push({ key: 'completed', at: record.date_completed, tone: 'neutral', title: 'Work reported complete' });
  }
  if (record.verification_result && record.verified_at) {
    const passed = record.verification_result === 'Passed';
    events.push({
      key: 'verified',
      at: record.verified_at,
      tone: passed ? 'success' : 'danger',
      title: `Custodian verification: ${record.verification_result}`,
      by: record.verified_by?.name,
      notes: record.verification_notes,
    });
  }
  if (record.confirmed_at) {
    events.push({
      key: 'confirmed',
      at: record.confirmed_at,
      tone: closedUnverified ? 'warning' : 'success',
      title: closedUnverified ? 'Closed without verification' : 'Confirmed and closed by Admin',
      by: record.confirmed_by?.name,
      notes: closedUnverified ? record.closure_reason : null,
      notesLabel: closedUnverified ? 'Reason' : null,
    });
  } else if (record.closure_reason) {
    events.push({ key: 'closed', at: null, tone: 'warning', title: 'Closed without verification', notes: record.closure_reason, notesLabel: 'Reason' });
  }

  if (!events.length) return null;
  events.sort((a, b) => String(a.at ?? '9999').localeCompare(String(b.at ?? '9999')));

  return (
    <section className="p23-record-section" aria-labelledby={`p23-timeline-${record.maintenance_id}`}>
      <h4 className="p23-section-title" id={`p23-timeline-${record.maintenance_id}`}>Decisions &amp; history</h4>
      <ol className="p23-timeline">
        {events.map((event) => (
          <li key={event.key} className={`tone-${event.tone}`}>
            <span className="p23-timeline-title">{event.title}</span>
            <span className="p23-timeline-meta">
              {event.at ? formatDate(event.at) : 'Date not recorded'}{event.by ? ` · by ${event.by}` : ''}
            </span>
            {event.notes && (
              <p className="p23-timeline-notes">{event.notesLabel ? <strong>{event.notesLabel}: </strong> : null}{event.notes}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// Where the record came from, with a link back when there's something to
// open (the originating issue report / vehicle). A ticket-generated record
// carries its issue_report_id; the issue page links on to its ticket.
function RecordOrigin({ record, onViewIssue }) {
  const info = MAINTENANCE_SOURCE_INFO[record.source];
  const issue = record.issue_report;
  const schedule = record.originating_schedule;
  return (
    <div className="p23-origin">
      <p className="p23-origin-line">
        <strong>{info?.short ?? record.source}:</strong> {info?.description ?? ''}
      </p>
      {schedule && (
        <p className="p23-origin-line">
          From Schedule #{schedule.schedule_id} — {schedule.maintenance_type}, due {formatDate(schedule.scheduled_date)}.
        </p>
      )}
      {(issue || record.issue_report_id) && (
        <p className="p23-origin-line">
          Originating issue:{' '}
          {onViewIssue ? (
            <button type="button" className="p23-link-button" onClick={() => onViewIssue(record.issue_report_id ?? issue.issue_report_id)}>
              Issue Report #{record.issue_report_id ?? issue.issue_report_id}{issue?.issue_type ? ` — ${issue.issue_type}` : ''}
            </button>
          ) : (
            <span>Issue Report #{record.issue_report_id ?? issue.issue_report_id}{issue?.issue_type ? ` — ${issue.issue_type}` : ''}</span>
          )}
        </p>
      )}
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
export function MaintenanceRecordDetail({ record, onConfirm, onReopen, onDecisionClose, onViewIssue, canManage }) {
  const [closing, setClosing] = useState(false);
  const canConfirm = canManage && record.verification_result === 'Passed' && record.progress_status !== 'Completed';
  // Decision-close is only offered where it's actually meaningful: not
  // already finished, and not already passed verification (a pass should go
  // through Confirm so it isn't overwritten as "unverified").
  const canDecisionClose = canManage && record.progress_status !== 'Completed' && record.verification_result !== 'Passed';
  const rework = isRecordReturnedForRework(record);
  const performer = maintenancePerformerText(record);
  const cost = formatMaintenanceCost(record.maintenance_cost);

  return (
    <ModulePanel description={`Maintenance #${record.maintenance_id}`}>
      <div className={`maintenance-record-detail p23-record-detail${rework ? ' is-rework' : ''}`}>
        <div className="maintenance-record-hero p23-record-hero">
          <VehicleCell vehicle={record.vehicle} />
          <span className="p23-record-type">{record.maintenance_type}</span>
          <SourceBadge source={record.source} />
          <StatusBadge value={record.progress_status} />
        </div>
        <RecordFlags record={record} />

        {/* Next action leads the page — what's happening, why it's waiting,
            and the buttons that move it on — before any of the detail. */}
        <MaintenanceNextStep record={record}>
          {canConfirm && (
            <div className="p23-next-step-actions">
              <button className="primary-button" type="button" onClick={() => onConfirm(record)}>Confirm &amp; close</button>
              <button className="ghost-button" type="button" onClick={() => onReopen(record)}>Reopen for more work</button>
            </div>
          )}
          {canDecisionClose && !closing && (
            <div className="p23-next-step-actions">
              <button className="ghost-button" type="button" onClick={() => setClosing(true)}>
                Close Without Verification
              </button>
              <p className="p23-help-text">
                Ends this record now without waiting for a Custodian to check the work. Requires a reason, and the record stays permanently marked as unverified.
              </p>
            </div>
          )}
        </MaintenanceNextStep>

        {canDecisionClose && closing && (
          <div className="p23-decision-close">
            <h4>Close without Custodian verification</h4>
            <p className="p23-help-text">
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

        <MaintenanceStageTrail record={record} />

        <RecordOrigin record={record} onViewIssue={onViewIssue} />

        {/* Same three facts, same wording, as the card and table. */}
        <dl className="p23-record-summary">
          <div>
            <dt>Performed by</dt>
            <dd>
              {record.is_external
                ? (performer ?? 'External shop')
                : <UserAvatarName user={record.maintenance_personnel} fallback={record.performed_by_other ?? 'Not recorded'} />}
            </dd>
          </div>
          <div><dt>Cost</dt><dd>{cost ?? 'Not recorded'}</dd></div>
          <div><dt>Date started</dt><dd>{record.date_started ? formatDate(record.date_started) : 'Not recorded'}</dd></div>
          <div><dt>Date completed</dt><dd>{record.date_completed ? formatDate(record.date_completed) : 'Not completed yet'}</dd></div>
          {record.is_external && record.warranty_until && (
            <div><dt>Warranty until</dt><dd>{formatDate(record.warranty_until)}</dd></div>
          )}
        </dl>

        <section className="p23-record-section" aria-labelledby={`p23-worklog-${record.maintenance_id}`}>
          <h4 className="p23-section-title" id={`p23-worklog-${record.maintenance_id}`}>Work log</h4>
          <div className="p23-worklog">
            <div>
              <span className="maintenance-detail-label">Problem / Reason</span>
              <p className="p23-long-text">{record.problem_reason || 'Not recorded'}</p>
            </div>
            <div>
              <span className="maintenance-detail-label">Action Taken</span>
              <p className="p23-long-text">{record.action_taken || 'Not recorded'}</p>
            </div>
            <div>
              <span className="maintenance-detail-label">Parts Used</span>
              <PartsList value={record.parts_used} />
            </div>
            {record.remarks && (
              <div>
                <span className="maintenance-detail-label">Remarks</span>
                <p className="p23-long-text">{record.remarks}</p>
              </div>
            )}
          </div>
        </section>

        {/* Proof shown inline — the whole point of this view over the plain
            edit form is not having to click away just to see it. */}
        {record.receipt_url && (
          <section className="p23-record-section">
            <h4 className="p23-section-title">Proof of completion</h4>
            <a href={resolvePhotoUrl(record.receipt_url)} target="_blank" rel="noopener noreferrer" className="p23-proof-link">
              <img src={resolvePhotoUrl(record.receipt_url)} alt={`Proof of completion for maintenance #${record.maintenance_id} (opens full size in a new tab)`} className="p23-proof-image" />
            </a>
          </section>
        )}

        <RecordTimeline record={record} />
      </div>
    </ModulePanel>
  );
}

// Fetch-by-id wrapper — same pattern as TicketProfilePage: load once by the
// URL's :id, show a loader/not-found state, then hand the fetched record to
// the read-rich detail view above. Re-fetches after Confirm/Reopen so the
// progress trail reflects the new state without a manual refresh.
export function MaintenanceRecordProfilePage({ maintenanceId, onConfirm, onReopen, onDecisionClose, onViewIssue, canManage }) {
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
      onViewIssue={onViewIssue}
      onConfirm={(r) => onConfirm(r).then(loadRecord)}
      onReopen={(r) => onReopen(r).then(loadRecord)}
      onDecisionClose={(r, payload) => onDecisionClose(r, payload).then(loadRecord)}
    />
  );
}

const MENU_WIDTH = 230;
const menuItemsOf = (popover) => [...(popover?.querySelectorAll('button:not([disabled])') ?? [])];

export function ScheduleActionMenu({ label, children }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);

  const openMenu = () => {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (bounds) {
      const menuWidth = Math.min(MENU_WIDTH, window.innerWidth - 16);
      const estimatedHeight = 260;
      setPosition({
        top: bounds.bottom + estimatedHeight > window.innerHeight
          ? Math.max(8, bounds.top - estimatedHeight - 4)
          : bounds.bottom + 4,
        left: Math.max(8, Math.min(bounds.right - menuWidth, window.innerWidth - menuWidth - 8)),
      });
    }
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    // Items are passed in as plain buttons by the caller — give them menu
    // semantics here and move focus into the menu, so keyboard users land
    // on the first action instead of having to tab around for it.
    const items = menuItemsOf(popoverRef.current);
    items.forEach((item) => item.setAttribute('role', 'menuitem'));
    items[0]?.focus();
    const closeOutside = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
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

  const onMenuKeyDown = (event) => {
    const items = menuItemsOf(popoverRef.current);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    else if (event.key === 'Tab') { closeMenu(false); return; }
    if (next) { event.preventDefault(); next.focus(); }
  };

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
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) { event.preventDefault(); openMenu(); }
        }}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open && (
        <div
          className="schedule-action-menu-popover p23-action-menu"
          role="menu"
          aria-label={label}
          ref={popoverRef}
          style={{ ...position, width: Math.min(MENU_WIDTH, window.innerWidth - 16) }}
          onClick={(event) => { event.stopPropagation(); if (event.target.closest('button')) closeMenu(true); }}
          onKeyDown={onMenuKeyDown}
        >
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
export function MaintenanceScheduleCard({ row, currentUser, allSchedules, onComplete, onEdit, onDelete, onViewRecord, onRestore, onReassign, onViewTicket, onViewVehicle, onApprove, onDecline }) {
  const currentUserId = currentUser?.id;
  const isMine = currentUserId != null && String(row.assigned_to) === String(currentUserId);
  const overdue = isScheduleOverdue(row);
  const urgency = scheduleUrgencyBucket(row);
  const dueLabel = scheduleDueLabel(row);
  const resulting = row.resulting_maintenance;
  const isCompleted = row.status === 'Completed';
  const nextOccurrence = findNextScheduleOccurrence(row, allSchedules);
  const statusNote = scheduleStatusNote(row);
  // Once a due schedule has become a ticket, the ticket is where the work is
  // done — completing the schedule directly would be refused. Final senior
  // system review (2026-10-05, §2) — Admin no longer completes a schedule
  // directly (that's physically performing the work); only the assigned
  // Maintenance Personnel can.
  const canComplete = row.status === 'Scheduled' && !row.resulting_ticket_id && onComplete && isMine;
  const becameTicket = row.status === 'Scheduled' && row.resulting_ticket_id && onViewTicket;
  // A completed schedule is history — its work lives in the maintenance
  // record it produced — so Edit/Cancel are withheld and the reason shown.
  const canEdit = canDo(currentUser, 'schedule.edit') && !isCompleted;
  const canCancel = canDo(currentUser, 'schedule.delete') && !isCompleted && row.status !== 'Cancelled';
  const canRestore = row.status === 'Cancelled' && canDo(currentUser, 'schedule.restore') && onRestore;

  // Clicking the card body opens the vehicle's profile; the action row below
  // stops propagation so its buttons never double-fire this.
  const canView = Boolean(onViewVehicle && row.vehicle);

  return (
    <article
      className={`ticket-card maintenance-schedule-card p23-schedule-card schedule-${String(row.status ?? '').toLowerCase().replaceAll(' ', '-')} urgency-${String(urgency ?? 'none').toLowerCase()}`}
      style={canView ? { cursor: 'pointer' } : undefined}
      onClick={canView ? () => onViewVehicle(row.vehicle) : undefined}
      role={canView ? 'button' : undefined}
      tabIndex={canView ? 0 : undefined}
      aria-label={canView ? `Schedule #${row.schedule_id}, ${row.maintenance_type}, ${row.status}${overdue ? ', overdue' : ''} — open ${row.vehicle?.vehicle_name ?? 'vehicle'} profile` : undefined}
      onKeyDown={canView ? (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onViewVehicle(row.vehicle); }
      } : undefined}
    >
      <div className="ticket-card-content-wrapper">
        <div className="ticket-card-info">
          <div className="ticket-card-top">
            <span className="ticket-card-id">#{row.schedule_id}</span>
            <span className="p23-badge-group">
              {/* TicketStatusBadge covers Pending Approval/Declined (shared
                  with tickets) — same choice as scheduleColumns' Status. */}
              <TicketStatusBadge value={row.status} />
              {overdue && (
                <span className="schedule-urgency-badge is-overdue"><Icon name="alert" size={11} /> Overdue</span>
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
            <img src={resolvePhotoUrl(row.vehicle.photo_url)} alt="" />
          </div>
        )}
      </div>

      {statusNote && (
        <p className={`p23-schedule-note ${row.status === 'Declined' ? 'tone-danger' : row.status === 'Pending Approval' ? 'tone-warning' : 'tone-neutral'}`}>
          {statusNote}
        </p>
      )}

      {/* The date is the whole point of a schedule, so it leads here rather
          than being one column among many — exact date first, the relative
          "due in" label beside it, never one without the other. */}
      <div className="schedule-date-row">
        <span className={`schedule-date-value ${overdue ? 'is-overdue' : ''}`}>
          <Icon name="calendar" size={13} /> {formatDate(row.scheduled_date)}{row.scheduled_time ? ` · ${row.scheduled_time}` : ''}
        </span>
        {dueLabel && <span className={`schedule-due-label ${overdue ? 'is-overdue' : ''}`}>{dueLabel}</span>}
        <span className="schedule-repeat-label">
          <Icon name="undo" size={13} /> {recurrenceSentence(row.recurrence_months)}
        </span>
      </div>

      <div className="p23-schedule-assignee">
        <span className="p23-meta-label">Assigned to</span>
        {row.assigned_to_user?.name
          ? (
            <>
              <UserAvatarName user={row.assigned_to_user} />
              {isMine && <span className="p23-chip tone-info">You</span>}
            </>
          )
          : <span className="muted">Unassigned</span>}
      </div>

      {row.service_location && (
        <p className="p23-schedule-location">
          <Icon name="pin" size={12} /> <span className="p23-meta-label">Location</span> {row.service_location}
        </p>
      )}

      {/* Traceability, same as the table's Status column: "Completed" alone
          doesn't say whether the record it produced was ever verified. */}
      {isCompleted && (
        <div className="p23-schedule-completion">
          {resulting && (resulting.progress_status === 'Completed' ? (
            <span className="p23-chip tone-success">Record closed {formatDate(resulting.date_completed)}</span>
          ) : (
            <span className="p23-chip tone-warning" title="The calendar task is done, but the record it created still needs Custodian verification.">
              Record #{resulting.maintenance_id}: {resulting.progress_status}
            </span>
          ))}
          {row.recurrence_months ? (
            <p className="p23-schedule-next">
              <strong>Next occurrence:</strong>{' '}
              {nextOccurrence
                ? `${formatDate(nextOccurrence.scheduled_date)} (Schedule #${nextOccurrence.schedule_id}, ${nextOccurrence.status})`
                : 'Not in the current list — it is created automatically from the completion date.'}
            </p>
          ) : null}
          <p className="p23-help-text">
            Completed schedules can't be edited or cancelled — the work is already recorded{row.resulting_maintenance_id ? ` in Maintenance #${row.resulting_maintenance_id}` : ''}. Make corrections on that record instead.
          </p>
        </div>
      )}

      {/* margin-top: auto pins the action row to the bottom of the card (same
          as TicketCard's footer) so buttons line up across a row of cards
          regardless of how much optional content each card has above it.
          stopPropagation keeps button clicks from also opening the vehicle. */}
      <div className="row-actions schedule-card-actions p23-schedule-actions" style={{ marginTop: 'auto' }} role="group" aria-label={`Actions for schedule ${row.schedule_id}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {canComplete && (
          <button className="btn-confirm-action schedule-action-button" onClick={() => onComplete(row)} type="button"><Icon name="checkCircle" size={14} /><span>Mark Done</span></button>
        )}
        {becameTicket && (
          <button className="btn-view-action schedule-action-button" onClick={() => onViewTicket({ ticket_id: row.resulting_ticket_id })} type="button" title={`This schedule became Ticket #${row.resulting_ticket_id}`}><Icon name="ticket" size={14} /><span>Open Ticket #{row.resulting_ticket_id}</span></button>
        )}
        {isCompleted && row.resulting_maintenance_id && onViewRecord && (
          <button className="btn-view-action schedule-action-button" onClick={() => onViewRecord(row)} type="button"><Icon name="wrench" size={14} /><span>View Record</span></button>
        )}
        {/* Admin reviews a Custodian's booked schedule before it goes live —
            see scheduleColumns' matching Action column for the full
            reasoning. A Declined row can still be approved directly. */}
        {canDo(currentUser, 'schedule.approve') && ['Pending Approval', 'Declined'].includes(row.status) && onApprove && (
          <button className="btn-confirm-action schedule-action-button" onClick={() => onApprove(row)} type="button"><Icon name="checkCircle" size={14} /><span>Approve</span></button>
        )}
        {canDo(currentUser, 'schedule.decline') && row.status === 'Pending Approval' && onDecline && (
          <button className="btn-delete-action schedule-action-button" onClick={() => onDecline(row)} type="button"><Icon name="close" size={14} /><span>Decline</span></button>
        )}
        {/* Edit/Delete/Restore are Custodian-only abilities (config/
            permissions.php — Admin doesn't hold schedule.edit/.delete/
            .restore), gated by canDo so this matches what the backend
            actually accepts — see scheduleColumns' matching Action column.
            Any Custodian may edit any schedule in their barangay. */}
        {canEdit && (
          <button className="btn-edit-action schedule-action-button" onClick={() => onEdit(row)} type="button"><Icon name="edit" size={14} /><span>Edit</span></button>
        )}
        {/* schedule.reassign (Admin only) — Admin's one remaining lever over
            an already-booked schedule. */}
        {canDo(currentUser, 'schedule.reassign') && row.status === 'Scheduled' && onReassign && (
          <button className="btn-view-action schedule-action-button" onClick={() => onReassign(row)} type="button"><Icon name="undo" size={14} /><span>Reassign</span></button>
        )}
        {/* Cancel / Restore sit apart and quieter than the main actions —
            they're the rare, undo-style ones. A cancelled schedule offers
            Restore, not a Cancel that would do nothing. */}
        {canRestore && (
          <button className="p23-quiet-action" onClick={() => onRestore(row)} type="button"><Icon name="undo" size={13} /><span>Restore</span></button>
        )}
        {canCancel && (
          <button className="p23-quiet-action is-danger" onClick={() => onDelete(row)} type="button"><Icon name="trash" size={13} /><span>Cancel schedule</span></button>
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
