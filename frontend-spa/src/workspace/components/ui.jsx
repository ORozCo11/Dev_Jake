import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../../components/Icon';
import Modal from './Modal';
import { ColumnChooserButton, PaginationControls } from './tables';
import { FormNoticeContext, RowActionsContext } from '../contexts';
import { usePagination } from '../hooks/usePagination';
import { formatDate, formatTime, resolvePhotoUrl, timeAgo } from '../lib/format';
import { TICKET_STAGE_STYLE, ticketWorkflowStage } from '../lib/workflow';

// One filled horizontal bar split proportionally into colored segments (e.g.
// role breakdown) — paired with ChartLegend below it for the label/count per
// segment, rather than HorizontalBarChart's stack of separate per-row bars.
// A dual-handle range slider over a small fixed set of labeled stops (e.g.
// severity levels), not a continuous 0-100 value — built from two overlaid
// native <input type="range"> elements (a well-worn CSS trick: both share
// the same track, but only their thumbs are clickable, via pointer-events
// stripped from the input itself and restored on ::-webkit/-moz-range-thumb)
// rather than hand-rolling pointer-drag math.
export function DualRangeSlider({ labels, minIndex, maxIndex, onChange, label = 'Range' }) {
  const lastIndex = labels.length - 1;
  const percentOf = (i) => (lastIndex === 0 ? 0 : (i / lastIndex) * 100);

  return (
    <div className="dual-range-slider">
      <div className="dual-range-track">
        <div
          className="dual-range-fill"
          style={{ left: `${percentOf(minIndex)}%`, right: `${100 - percentOf(maxIndex)}%` }}
        />
        <input
          type="range"
          className="dual-range-input"
          min={0}
          max={lastIndex}
          step={1}
          value={minIndex}
          aria-label={`${label}: lowest`}
          aria-valuetext={labels[minIndex]}
          // Stacked on top of the max thumb once they meet at the same stop
          // (e.g. narrowing the filter down to "Medium" only) — otherwise,
          // since it's first in the DOM, the max thumb always paints over it
          // and permanently swallows the drag, leaving the min thumb stuck
          // and the range impossible to widen back out.
          style={{ zIndex: minIndex >= maxIndex ? 2 : 1 }}
          onChange={(e) => onChange(Math.min(Number(e.target.value), maxIndex), maxIndex)}
        />
        <input
          type="range"
          className="dual-range-input"
          min={0}
          max={lastIndex}
          step={1}
          value={maxIndex}
          aria-label={`${label}: highest`}
          aria-valuetext={labels[maxIndex]}
          style={{ zIndex: minIndex >= maxIndex ? 1 : 2 }}
          onChange={(e) => onChange(minIndex, Math.max(Number(e.target.value), minIndex))}
        />
      </div>
      <div className="dual-range-labels">
        {labels.map((stop) => <span key={stop} aria-hidden="true">{stop}</span>)}
      </div>
    </div>
  );
}

export function SegmentedBar({ segments }) {
  const total = segments.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  return (
    <div className="segmented-bar">
      {total === 0
        ? <span style={{ width: '100%', background: 'var(--surface-2, #f1f5f9)' }} />
        : segments.filter((s) => s.value > 0).map((s) => (
          <span key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />
        ))}
    </div>
  );
}

export function ChartLegend({ rows }) {
  return (
    <ul className="chart-legend">
      {rows.map((row) => (
        <li key={row.label}>
          <span style={{ '--legend-color': row.color }}></span>
          <small>{row.label}</small>
          <strong>{row.value}</strong>
        </li>
      ))}
    </ul>
  );
}

export function SolidPieLegend({ segments, total }) {
  const shown = segments.filter((s) => s.value > 0);
  if (!shown.length) return null;
  return (
    <div className="solid-pie-legend">
      {shown.map((s) => (
        <div className="solid-pie-legend-item" key={s.label}>
          <span className="solid-pie-legend-dot" style={{ background: s.color }} />
          <div>
            <p className="solid-pie-legend-label" style={{ color: s.color }}>{s.label}</p>
            <p className="solid-pie-legend-pct">{total ? Math.round((s.value / total) * 100) : 0}%</p>
            <p className="solid-pie-legend-count">{s.value} issue{s.value === 1 ? '' : 's'}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// The "what this page does" hint banner (blue info callout) was removed from
// every module per user request — kept as a no-op rather than touched at
// every call site, so ModulePanel and the 4 ticket-workflow pages that use it
// don't need to change.
export function DismissibleHint() {
  return null;
}

export function ModulePanel({ children, description, statCards, filterBar, tabBar }) {
  return (
    <div className="module-grid">
      <DismissibleHint description={description} />
      {/* Tabs switch the whole view (stats, filters, list), so they live at
          the top — same spot on every tab — not between filters and list. */}
      {tabBar}
      {statCards}
      {filterBar && (
        <section className="panel module-filter-panel">
          {filterBar}
        </section>
      )}
      <section className="panel">
        {children}
      </section>
    </div>
  );
}

/** Generic modal wrapper that hosts a SmartForm popup. */
export function FormModal({ open, title, onClose, children, wide = false }) {
  const notice = useContext(FormNoticeContext);

  if (!open) return null;

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide={wide}
      beforeBody={notice && notice.type === 'error' && (
        <div className="notice error" role="alert" style={{ margin: '12px 28px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', textAlign: 'center', flexDirection: 'column' }}>
          <span style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name="alert" size={16} /></span>
          <span>{notice.text}</span>
        </div>
      )}
    >
      {children}
    </Modal>
  );
}

export function PartsTags({ value }) {
  if (!value) return <span style={{ color: '#94a3b8' }}>-</span>;
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return <span style={{ color: '#94a3b8' }}>-</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxWidth: '240px' }}>
      {parts.map((part, idx) => (
        <span key={idx} className="part-tag" title={part}>{part}</span>
      ))}
    </div>
  );
}

// Centered modal overlay for a submit-in-progress state — used where a
// small in-button spinner isn't noticeable enough (e.g. Create Ticket,
// which stays on a long scrolled form while it saves). Portaled to <body>
// like FormModal, so it sits above everything regardless of where it's
// rendered from.
export function SubmitLoadingOverlay({ label = 'Saving…' }) {
  return createPortal(
    <div className="modal-overlay submit-loading-overlay" role="status" aria-live="polite">
      <div className="submit-loading-card">
        <Icon name="gear" size={48} className="submit-loading-gear" filled />
        <p className="submit-loading-label">{label}</p>
      </div>
    </div>,
    document.body
  );
}

export function ModuleLoader({ label = 'Loading module data' }) {
  return (
    <div className="module-loader" role="status" aria-live="polite">
      <div className="module-loader-card">
        <span className="module-loader-spinner" aria-hidden="true">
          <svg viewBox="0 0 50 50" width="44" height="44">
            <circle className="module-loader-track" cx="25" cy="25" r="20" fill="none" strokeWidth="5" />
            <circle className="module-loader-arc" cx="25" cy="25" r="20" fill="none" strokeWidth="5" strokeLinecap="round" />
          </svg>
        </span>
        <span className="module-loader-label">{label}<span className="module-loader-dots" /></span>
      </div>

      <div className="skeleton-table" aria-hidden="true">
        <div className="skeleton-row skeleton-head">
          {Array.from({ length: 5 }).map((_, i) => <span className="skeleton-cell" key={i} />)}
        </div>
        {Array.from({ length: 5 }).map((_, r) => (
          <div className="skeleton-row" key={r} style={{ animationDelay: `${r * 0.08}s` }}>
            {Array.from({ length: 5 }).map((_, c) => <span className="skeleton-cell" key={c} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

// Same rows as the List View table, rendered as a connected vertical
// timeline instead — its own pagination via the same usePagination hook, so
// switching tabs doesn't lose your place in a 14,000-row activity log.
export function ActivityTimeline({ rows }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(rows.length, { pageSizeOptions: [10, 25, 50, 100], initialPageSize: 10 });

  if (!rows.length) {
    return <p className="empty-state">No activity yet.</p>;
  }

  const pageRows = rows.slice(start, end);

  return (
    <div className="activity-timeline-wrap">
      <h3 className="activity-timeline-title">Recent Activities</h3>
      <ol className="activity-timeline">
        {pageRows.map((row) => (
          <li key={row.log_id} className="activity-timeline-item">
            <span className="activity-timeline-dot" aria-hidden="true">
              <Icon name="link" size={13} />
            </span>
            <div className="activity-timeline-body">
              <strong>{row.user?.name ?? 'System'} {row.action}</strong>
              <p>{row.details}</p>
            </div>
            <span className="activity-timeline-time">{timeAgo(row.created_at)}</span>
          </li>
        ))}
      </ol>
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={[10, 25, 50, 100]} totalPages={totalPages} />
    </div>
  );
}

export function StatusBadge({ value }) {
  return <span className={`status-badge ${String(value ?? '-').toLowerCase().replaceAll(' ', '-')}`}>{value ?? '-'}</span>;
}

// Clamps long free-text table cells to a fixed number of lines so they can't
// stretch the row/table. A "Show more" chevron only appears when the text
// actually overflows the clamp (measured via scrollHeight vs clientHeight),
// so short text that already fits gets no dead-looking toggle affordance.
export function ExpandableText({ text, lines = 2, className = '' }) {
  const [expanded, setExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const textRef = useRef(null);

  useLayoutEffect(() => {
    if (expanded) return;
    const el = textRef.current;
    if (el) setIsTruncated(el.scrollHeight > el.clientHeight + 1);
  }, [text, lines, expanded]);

  if (!text) return '-';

  const toggle = () => setExpanded((prev) => !prev);
  const canToggle = isTruncated || expanded;

  return (
    <span className="expandable-text-wrap">
      <span
        ref={textRef}
        className={`expandable-text ${canToggle ? 'is-clickable' : ''} ${expanded ? 'is-expanded' : ''} ${className}`.trim()}
        style={{ WebkitLineClamp: expanded ? 'unset' : lines }}
        onClick={canToggle ? (event) => { event.stopPropagation(); toggle(); } : undefined}
        onKeyDown={canToggle ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            toggle();
          }
        } : undefined}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        title={canToggle ? (expanded ? 'Click to collapse' : 'Click to view full text') : undefined}
      >
        {text}
      </span>
      {canToggle && (
        <button
          type="button"
          className={`expandable-text-toggle${expanded ? ' is-expanded' : ''}`}
          onClick={(event) => { event.stopPropagation(); toggle(); }}
          title={expanded ? 'Collapse' : 'Show full text'}
        >
          {expanded ? 'Show less' : 'Show more'}
          <Icon name="chevronDown" size={11} />
        </button>
      )}
    </span>
  );
}

export function PhotoCell({ url, alt }) {
  if (!url) {
    return '-';
  }

  const resolved = resolvePhotoUrl(url);

  return (
    <a className="photo-cell" href={resolved} rel="noreferrer" target="_blank">
      <img alt={alt} className="photo-thumb" src={resolved} loading="lazy" />
    </a>
  );
}

// Consistent "avatar + name" cell used everywhere a table references a user
// (Reported By, Checked By, Personnel, Updated By, Archived By, etc.).
// Clicking it opens that user's info — so a user cell no longer inherits the
// row's "open vehicle" click.
export function UserAvatarName({ user, fallback = '-' }) {
  const actions = useContext(RowActionsContext);

  if (!user || !user.name) {
    return <span className="user-avatar-name-empty">{fallback}</span>;
  }

  const initials = user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  const inner = (
    <>
      {user.photo_url ? (
        <img className="user-avatar-name-photo" src={resolvePhotoUrl(user.photo_url)} alt="" />
      ) : (
        <span className="user-avatar-name-initials">{initials}</span>
      )}
      <span>{user.name}</span>
    </>
  );

  if (actions?.viewUser) {
    return (
      <button
        type="button"
        className="user-avatar-name cell-link"
        onClick={(e) => { e.stopPropagation(); actions.viewUser(user); }}
        title={`View ${user.name}`}
      >
        {inner}
      </button>
    );
  }

  return <span className="user-avatar-name">{inner}</span>;
}

// Vehicle cell (photo + name). The name opens the vehicle profile; the photo
// still opens the full-size image in a new tab.
// `isRowTitle` (default true) marks whether THIS column is also what the
// row's own onRowClick opens — true in every table except the Maintenance
// Tickets list, whose row click opens the ticket (the Title column) rather
// than this vehicle, so only that one caller passes false. Drives whether
// hovering anywhere in the row underlines this name too (row-title-text) —
// leaving it on everywhere would underline two different "click targets"
// at once on that one table.
export function VehicleCell({ vehicle, isRowTitle = true }) {
  const actions = useContext(RowActionsContext);

  if (!vehicle) {
    return '-';
  }

  const textClassName = `vcn-text${isRowTitle ? ' row-title-text' : ''}`;

  return (
    <div className="vehicle-cell">
      <PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} />
      {actions?.viewVehicle && vehicle.vehicle_id ? (
        <button
          type="button"
          className="vehicle-cell-name cell-link"
          onClick={(e) => { e.stopPropagation(); actions.viewVehicle(vehicle); }}
          title={vehicle.vehicle_name}
        >
          <span className={textClassName}>{vehicle.vehicle_name}</span>
        </button>
      ) : (
        <span className="vehicle-cell-name" title={vehicle.vehicle_name}>
          <span className={textClassName}>{vehicle.vehicle_name}</span>
        </span>
      )}
    </div>
  );
}

// Compact "table cell" version of a date: a colored month/day pill plus the
// year underneath — used in place of the long formatDate() string inside
// table columns. Time (when the source field carries one) is its own
// adjacent "Time" column via formatTime(), so it never repeats here.
export function DateBadge({ value }) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return (
    <span className="date-badge">
      <span className="date-badge-pill">
        <span className="date-badge-month">{date.toLocaleDateString('en-US', { month: 'short' })}</span>
        <span className="date-badge-day">{date.toLocaleDateString('en-US', { day: '2-digit' })}</span>
      </span>
      <span className="date-badge-meta">
        <span>{date.getFullYear()}</span>
      </span>
    </span>
  );
}

// Muted inline date for calm contexts (the ticket detail cards) where the
// chunky red DateBadge tile reads as an alert. Dense tables keep the tile.
export function QuietDate({ value }) {
  if (!value) return <span className="muted">—</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="muted">—</span>;
  return (
    <span className="quiet-date">
      <Icon name="calendar" size={12} /> {formatDate(value)}
    </span>
  );
}

// Mechanic repair logs are stored as plain text, one entry per submission in
// the form "[YYYY-MM-DD HH:MM] message", separated by a blank line. Parse
// that back out so each entry can show a proper DateBadge instead of a raw
// bracketed timestamp buried in a wall of text.
export // `limit` (compact mode only, optional): show just the latest N entries
// with a toggle to reveal the rest, so a long history stays one line tall.
function RepairLogEntries({ text, compact = false, limit = null }) {
  const [showAll, setShowAll] = useState(false);

  if (!text) {
    return <p className="empty-state">No logs yet.</p>;
  }

  const entries = text.split(/\n\s*\n/).map((chunk) => {
    const match = chunk.match(/^\[(.+?)\]\s*([\s\S]*)$/);
    if (!match) {
      return { iso: null, message: chunk.trim() };
    }
    return { iso: match[1].trim().replace(' ', 'T'), message: match[2].trim() };
  }).filter((entry) => entry.message || entry.iso);

  if (compact) {
    const collapsed = limit != null && !showAll && entries.length > limit;
    const shown = collapsed ? entries.slice(-limit) : entries;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {shown.map((entry, i) => (
          <p key={i} style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text, #334155)' }}>
            {entry.iso && <span className="muted" style={{ fontSize: '0.7rem', marginRight: 6 }}>{formatDate(entry.iso)}</span>}
            {entry.message}
          </p>
        ))}
        {limit != null && entries.length > limit && (
          <button type="button" className="lr-link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show latest only' : `View full repair history (${entries.length})`}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="repair-log-entries">
      {entries.map((entry, i) => (
        <div className="repair-log-entry" key={i}>
          <div className="repair-log-entry-date">
            <DateBadge value={entry.iso} />
            {entry.iso && <span className="repair-log-entry-time">{formatTime(entry.iso)}</span>}
          </div>
          <p className="repair-log-entry-message">{entry.message}</p>
        </div>
      ))}
    </div>
  );
}

// =========================================================================
// TICKET STATUS BADGE
// =========================================================================

export function TicketStatusBadge({ value, size = 'normal' }) {
  const colorMap = {
    'Open': 'ticket-open',
    'Active': 'ticket-repair',
    'For Maintenance': 'ticket-formaint',
    'Under Repair': 'ticket-repair',
    'Pending Approval': 'ticket-formaint',
    'Declined': 'ticket-cancelled',
    'For Verification': 'ticket-forinspect',
    'For Inspection': 'ticket-forinspect',
    'For Confirmation': 'ticket-forconfirm',
    'Done': 'ticket-done',
    'Deferred': 'ticket-deferred',
    'Closed': 'ticket-done',
    'Deleted': 'ticket-cancelled',
    'Cancelled': 'ticket-cancelled',
    'Low': 'priority-low',
    'Medium': 'priority-medium',
    'High': 'priority-high',
    'Critical': 'priority-critical',
    'Needs Maintenance': 'ticket-formaint',
    'No Issues': 'ticket-done',
    'Approved': 'ticket-done',
    'Rejected': 'ticket-repair',
    'Confirmed': 'ticket-done',
    'Reopened': 'ticket-repair',
  };
  const cls = colorMap[value] ?? 'status-badge';
  return <span className={`status-badge ${cls} ${size === 'large' ? 'badge-large' : ''}`}>{value ?? '-'}</span>;
}

export function TicketStageBadge({ ticket, variant = 'flag' }) {
  const stage = ticketWorkflowStage(ticket);
  if (!stage) return null;
  const style = TICKET_STAGE_STYLE[stage.tone];
  // "flag" (default) reads as a leading tab flush against a card's left
  // edge — right for TicketCard, but floats oddly with nothing to sit
  // flush against once it's just one badge among others in a header row.
  // "pill" matches the rounded status/priority badges beside it there.
  if (variant === 'pill') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 700,
        padding: '5px 12px', borderRadius: 999, background: style.bg,
        border: `1px solid ${style.color}55`, color: style.color,
      }}>
        <Icon name={style.icon} size={12} /> {stage.label}
      </span>
    );
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 700,
      padding: '6px 10px', borderRadius: '0 6px 6px 0', background: style.bg,
      borderLeft: `3px solid ${style.color}`, color: style.color,
    }}>
      <Icon name={style.icon} size={12} /> {stage.label}
    </div>
  );
}
export function LocalSearchInput({ value, onChange, placeholder = "Search...", onExport, onAdd, addLabel = "Add", onImport, columnChooser }) {
  return (
    <div className="local-search-bar">
      <div className="local-search-container">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="local-search-icon">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="local-search-input"
        />
        {value && (
          <button className="local-search-clear" onClick={() => onChange('')} type="button" title="Clear search">
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {columnChooser && <ColumnChooserButton {...columnChooser} />}
      {onAdd && (
        <button className="icon-add-btn has-label" onClick={onAdd} type="button" title={addLabel} aria-label={addLabel}>
          <Icon name="plus" size={18} />
          <span className="icon-add-btn-label">{addLabel}</span>
        </button>
      )}
      {onImport && (
        <button className="export-btn" onClick={onImport} type="button" title="Import vehicles from a spreadsheet" aria-label="Import vehicles from a spreadsheet">
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="download" size={15} /></span>
        </button>
      )}
      {onExport && (
        <button className="export-btn" onClick={onExport} type="button" title="Export to CSV" aria-label="Export to CSV">
          <Icon name="download" size={15} />
        </button>
      )}
    </div>
  );
}
