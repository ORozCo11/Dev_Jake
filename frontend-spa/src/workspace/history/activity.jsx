// Shared building blocks for the two "what happened" modules — Vehicle
// History (per-vehicle timeline) and the Activity Log (who did what, system
// wide): human-readable related-record links, date grouping, a result-scope
// summary that states exactly what Export/Print will contain, and a filtered
// empty state with a Clear filters action.
import { useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../components/Icon';
import { AuthContext } from '../../context/AuthContextObject';
import { PaginationControls } from '../components/tables';
import { StatusBadge, UserAvatarName, VehicleCell } from '../components/ui';
import { usePagination } from '../hooks/usePagination';
import { actionLabel, describeDateRange, groupRowsByDay, hasActiveScope, historyRecordKind, logRecordKind, relatedRecordText } from '../lib/activity';
import { formatTime } from '../lib/format';
import { roleRoutes } from '../lib/permissions';
import { moduleBadgeTone } from '../lib/statCards';

// "Ticket #12" as a link when the app has a page for that record (and it
// wasn't just deleted), plain labelled text otherwise.
export function RelatedRecordLink({ kind, id, deleted = false }) {
  const { user } = useContext(AuthContext) ?? {};
  const navigate = useNavigate();

  if (id == null || id === '') return <span className="muted">—</span>;
  const text = relatedRecordText(kind, id);
  const base = roleRoutes[user?.role];

  if (!kind?.path || !base || deleted) {
    return <span className="p23-record-ref" title={deleted ? `${text} (deleted)` : text}>{text}</span>;
  }

  return (
    <button
      type="button"
      className="issue-reporter-link p23-record-link"
      onClick={(e) => { e.stopPropagation(); navigate(`${base}/${kind.path}/${id}`); }}
      title={`Open ${text}`}
    >
      {text}
    </button>
  );
}

function ModuleTag({ module }) {
  if (!module) return null;
  const tone = moduleBadgeTone(module);
  return <span className="log-category-tag" style={{ background: tone.bg, color: tone.color }}>{module}</span>;
}

function ActorLine({ user, role }) {
  const resolvedRole = role ?? user?.role;
  return (
    <span className="p23-actor">
      {user?.name ? <UserAvatarName user={user} /> : <span className="p23-actor-system">System (automatic)</span>}
      {resolvedRole && <span className="p23-actor-role">{resolvedRole}</span>}
    </span>
  );
}

function DayGroupedList({ rows, keyOf, renderRow, pageSizeOptions = [10, 25, 50, 100], label }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(rows.length, { pageSizeOptions, initialPageSize: pageSizeOptions[0] });
  const groups = groupRowsByDay(rows.slice(start, end));

  return (
    <div className="p23-day-groups">
      {groups.map((group) => (
        <section key={group.key} className="p23-day-group" aria-label={`${label} — ${group.label}`}>
          <h4 className="p23-day-heading">
            <span>{group.label}</span>
            <span className="p23-day-count">{group.rows.length} {group.rows.length === 1 ? 'entry' : 'entries'}</span>
          </h4>
          <ol className="p23-day-list">
            {group.rows.map((row, i) => <li key={keyOf(row) ?? i} className="p23-entry">{renderRow(row)}</li>)}
          </ol>
        </section>
      ))}
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={pageSizeOptions} totalPages={totalPages} />
    </div>
  );
}

// Vehicle History, timeline/card view: grouped by day, each entry reads as
// "what happened" first, then vehicle, related record, who, and when.
export function HistoryDayTimeline({ rows, emptyState }) {
  if (!rows.length) return emptyState;
  return (
    <DayGroupedList
      label="Vehicle history"
      rows={rows}
      keyOf={(row) => row.history_id}
      renderRow={(row) => {
        const kind = historyRecordKind(row.related_table);
        return (
          <article className="p23-entry-card">
            <div className="p23-entry-head">
              <strong className="p23-entry-title">{row.activity_type ?? 'Vehicle activity'}</strong>
              <span className="p23-entry-time">{formatTime(row.created_at)}</span>
            </div>
            {row.description && <p className="p23-entry-desc">{row.description}</p>}
            <dl className="p23-entry-meta">
              <div><dt>Vehicle</dt><dd><VehicleCell vehicle={row.vehicle} isRowTitle={false} /></dd></div>
              {!kind?.self && row.related_record_id != null && (
                <div><dt>Related</dt><dd><RelatedRecordLink kind={kind} id={row.related_record_id} /></dd></div>
              )}
              <div><dt>By</dt><dd><ActorLine user={row.updated_by} /></dd></div>
            </dl>
          </article>
        );
      }}
    />
  );
}

// Activity Log, "Recent Activities" view.
export function LogDayTimeline({ rows, vehicles = [], emptyState }) {
  if (!rows.length) return emptyState;
  return (
    <DayGroupedList
      label="Activity log"
      rows={rows}
      keyOf={(row) => row.log_id}
      renderRow={(row) => (
        <article className="p23-entry-card">
          <div className="p23-entry-head">
            <span className="p23-entry-action"><StatusBadge value={actionLabel(row.action)} /></span>
            <ModuleTag module={row.module} />
            <span className="p23-entry-time">{formatTime(row.created_at)}</span>
          </div>
          <p className="p23-entry-title-text">{row.details || `${actionLabel(row.action)} in ${row.module ?? 'the system'}`}</p>
          <dl className="p23-entry-meta">
            <div><dt>By</dt><dd><ActorLine user={row.user} role={row.role} /></dd></div>
            {row.affected_record_id != null && (
              <div><dt>Record</dt><dd><LogRecordCell row={row} vehicles={vehicles} /></dd></div>
            )}
          </dl>
        </article>
      )}
    />
  );
}

// Activity Log "Record" cell (table + timeline): the vehicle's own name for
// Vehicle Management rows, otherwise "<Kind> #id", linked when possible.
export function LogRecordCell({ row, vehicles = [] }) {
  const navigate = useNavigate();
  const { user } = useContext(AuthContext) ?? {};
  if (row.affected_record_id == null) return <span className="muted">—</span>;
  const kind = logRecordKind(row.module);
  // "Delete", "Delete Ticket", ... — the record is gone, so no link.
  const deleted = /^Delete\b/.test(row.action ?? '');
  if (row.module === 'Vehicle Management' && !deleted) {
    const vehicle = vehicles.find((v) => String(v.vehicle_id) === String(row.affected_record_id));
    const base = roleRoutes[user?.role];
    if (vehicle && base) {
      return (
        <button type="button" className="issue-reporter-link p23-record-link" onClick={(e) => { e.stopPropagation(); navigate(`${base}/vehicles/${vehicle.vehicle_id}`); }} title={`Open ${vehicle.vehicle_name}`}>
          {vehicle.vehicle_name}
        </button>
      );
    }
  }
  return <RelatedRecordLink kind={kind} id={row.affected_record_id} deleted={deleted} />;
}

// One line above a list that states the result count, date range and every
// active filter, plus what Export/Print will contain — so nobody has to
// guess whether a CSV holds "this page" or "everything".
export function ResultScope({ shown, total, noun = 'entries', dateStart, dateEnd, filters = [], search, onClear, exportNote }) {
  const active = hasActiveScope({ dateStart, dateEnd, filters, search });
  const activeFilters = filters.filter((f) => f.values?.length);
  return (
    <div className="p23-scope" role="status" aria-live="polite">
      <p className="p23-scope-line">
        <span>Showing <strong>{shown}</strong>{total != null && total !== shown ? <> of {total}</> : null} {noun}</span>
        <span className="p23-scope-sep" aria-hidden="true">·</span>
        <span>Date range: <strong>{describeDateRange(dateStart, dateEnd)}</strong></span>
        {activeFilters.map((f) => (
          <span key={f.label}>
            <span className="p23-scope-sep" aria-hidden="true">·</span>
            {f.label}: <strong>{f.values.join(', ')}</strong>
          </span>
        ))}
        {String(search ?? '').trim() && (
          <span>
            <span className="p23-scope-sep" aria-hidden="true">·</span>
            Search: <strong>“{search.trim()}”</strong>
          </span>
        )}
        {active && onClear && (
          <button type="button" className="ghost-button p23-scope-clear" onClick={onClear}>
            <Icon name="close" size={13} /> Clear filters
          </button>
        )}
      </p>
      {exportNote && <p className="p23-scope-note">{exportNote}</p>}
    </div>
  );
}

// Empty state that says WHY it's empty: nothing recorded yet vs. nothing
// matching the current filters (with a one-click way out). `inline` returns
// phrasing content only, for DataTable's own <p className="empty-state">.
export function ScopedEmptyState({ filtered, emptyText, filteredText = 'No entries match the current filters.', onClear, inline = false }) {
  if (inline) {
    return (
      <>
        <span className="p23-empty-text">{filtered ? filteredText : emptyText}</span>
        {filtered && onClear && (
          <button type="button" className="ghost-button p23-empty-clear" onClick={onClear}>Clear filters</button>
        )}
      </>
    );
  }
  return (
    <div className="empty-state p23-empty">
      <p>{filtered ? filteredText : emptyText}</p>
      {filtered && onClear && (
        <button type="button" className="ghost-button" onClick={onClear}>Clear filters</button>
      )}
    </div>
  );
}
