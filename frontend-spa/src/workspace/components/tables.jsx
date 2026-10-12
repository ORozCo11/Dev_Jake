import { Fragment, useEffect, useRef, useState } from 'react';
import Icon from '../../components/Icon';
import { paginationPageList, usePagination } from '../hooks/usePagination';
import { rowKey } from '../lib/format';
import { VIEW_MODE_OPTIONS } from '../lib/statCards';

// Column headers are drag-reorderable in-place whenever `onReorderColumn`
// is passed AND the columns carry a stable `key` (only some tables' column
// functions set one so far, e.g. vehicleColumns — the rest render exactly
// as before, since a column with no `key` just never becomes draggable).
// Mirrors the same reorder semantics ColumnChooserButton's popover list
// uses, so dragging a header does the same thing as dragging its row there
// — just without opening the popover first.
// Clicks on these inside a clickable row act on themselves, not the row.
const ROW_CLICK_IGNORE = 'button, a, select, input, textarea, label';

// `emptyCellValue` is what a column without a `render` shows for a missing
// value (blank by default; Super Admin tables use '-').
export function DataTable({ columns, rows, compact = false, onRowClick, onReorderColumn, emptyMessage = 'No records found.', renderSubRow, emptyCellValue }) {
  // Which side of which header the dragged column would land on — drawn as
  // a thin vertical line right on that edge (matching the realcore
  // reference), so there's no guessing where a drop will actually land.
  // Declared before the early return below so the hook itself is always
  // called regardless of whether `rows` is empty on a given render.
  const [dropIndicator, setDropIndicator] = useState(null);

  if (!rows?.length) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  const hasWidths = columns.some((column) => column.width);
  const sideOf = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
  };

  return (
    // Below 640px the table restacks into one card per row (CSS); explicit
    // ARIA roles keep the table semantics once display: table is gone.
    // Focusable so keyboard users can scroll it sideways when it overflows.
    <div className={`table-shell${compact ? ' is-compact' : ''}${hasWidths ? ' is-fixed' : ''}`} tabIndex={0} role="region" aria-label="Table">
      <table role="table">
        {hasWidths && (
          <colgroup>
            {columns.map((column) => (
              <col key={column.label} style={column.width ? { width: column.width } : undefined} />
            ))}
          </colgroup>
        )}
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((column) => {
              const draggable = Boolean(onReorderColumn && column.key && !column.locked);
              const isDropTarget = draggable && dropIndicator?.key === column.key;
              return (
                <th
                  role="columnheader"
                  key={column.label}
                  className={[
                    column.className,
                    draggable ? 'is-draggable-column' : null,
                    isDropTarget ? `is-drop-${dropIndicator.side}` : null,
                  ].filter(Boolean).join(' ') || undefined}
                  draggable={draggable}
                  title={draggable ? `Drag to move "${column.label}"` : undefined}
                  onDragStart={draggable ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', column.key); } : undefined}
                  onDragOver={draggable ? (e) => {
                    e.preventDefault();
                    const side = sideOf(e);
                    setDropIndicator((prev) => (prev?.key === column.key && prev.side === side ? prev : { key: column.key, side }));
                  } : undefined}
                  onDragLeave={draggable ? () => setDropIndicator((prev) => (prev?.key === column.key ? null : prev)) : undefined}
                  onDragEnd={draggable ? () => setDropIndicator(null) : undefined}
                  onDrop={draggable ? (e) => {
                    e.preventDefault();
                    const dragKey = e.dataTransfer.getData('text/plain');
                    if (dragKey) onReorderColumn(dragKey, column.key, sideOf(e));
                    setDropIndicator(null);
                  } : undefined}
                >
                  {column.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row, index) => {
            const subContent = renderSubRow ? renderSubRow(row) : null;
            return (
              <Fragment key={rowKey(row, index)}>
                <tr
                  role="row"
                  className={onRowClick ? 'is-clickable' : undefined}
                  onClick={onRowClick ? (e) => { if (!e.target.closest(ROW_CLICK_IGNORE)) onRowClick(row); } : undefined}
                  // Clickable rows are reachable and operable from the keyboard
                  // too (Tab to the row, Enter/Space to open it).
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={onRowClick ? (e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); }
                  } : undefined}
                >
                  {columns.map((column) => (
                    <td role="cell" key={column.label} className={column.className} data-label={column.label} data-col={column.key}>{column.render ? column.render(row) : (row[column.key] ?? emptyCellValue)}</td>
                  ))}
                </tr>
                {subContent && (
                  <tr role="row" className="table-subrow">
                    <td role="cell" colSpan={columns.length}>{subContent}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Reusable "Total + clickable status breakdown" card row, sitting above a
// module's table, matching the Vehicle Management stat cards exactly.
// `cards` is [{ key, label, icon, bg, color }]; `counts` maps key -> number;
// clicking a card toggles `activeFilter` via `onFilterChange`.
export function ModuleStatCards({ totalLabel = 'Total', total, cards, counts, activeFilter, onFilterChange, onTotalClick, gridClassName = '' }) {
  const isFilterMulti = Array.isArray(activeFilter);
  const isTotalActive = isFilterMulti ? activeFilter.length === 0 : !activeFilter;
  return (
    <section className={`metric-grid${gridClassName ? ` ${gridClassName}` : ''}`} aria-label="Status summary" style={{ marginBottom: '16px' }}>
      <button
        type="button"
        className={`metric-card metric-card-iconic stat-filter-card${isTotalActive ? ' is-active' : ''}`}
        style={{
          cursor: 'pointer',
          boxShadow: isTotalActive ? '0 0 0 2px #2563eb' : undefined,
        }}
        onClick={() => onTotalClick ? onTotalClick() : onFilterChange(isFilterMulti ? [] : '')}
        title={`Show all ${totalLabel.replace(/^Total\s*/i, '') || 'items'}`.trim()}
      >
        <span className="metric-card-icon is-total">
          <Icon name="grid" size={18} />
        </span>
        <div className="metric-card-body">
          <span>{totalLabel}</span>
          <strong>{total}</strong>
        </div>
      </button>
      {cards.map(({ key, label, icon, bg, color }) => {
        // activeFilter is a plain string in some modules (a dedicated
        // single-purpose bucket filter) and an array in others (the shared
        // filter state now that FilterBar's dropdowns are multi-select) —
        // support both without forcing every caller to convert.
        const isMulti = Array.isArray(activeFilter);
        const isActive = isMulti ? (activeFilter.length === 1 && activeFilter[0] === key) : activeFilter === key;
        return (
          <button
            key={key}
            type="button"
            className={`metric-card metric-card-iconic stat-filter-card${isActive ? ' is-active' : ''}`}
            style={{
              cursor: 'pointer',
              boxShadow: isActive ? `0 0 0 2px ${color}` : undefined,
            }}
            onClick={() => onFilterChange(isActive ? (isMulti ? [] : '') : (isMulti ? [key] : key))}
            title={`Filter: ${label}`}
          >
            <span className="metric-card-icon" style={{ background: bg, color }}>
              <Icon name={icon} size={18} />
            </span>
            <div className="metric-card-body">
              <span>{label}</span>
              <strong>{counts[key] ?? 0}</strong>
            </div>
          </button>
        );
      })}
    </section>
  );
}

export function PaginationControls({ page, setPage, pageSize, setPageSize, pageSizeOptions, totalPages }) {
  if (totalPages <= 1 && pageSizeOptions.length <= 1) return null;
  const pageList = paginationPageList(page, totalPages);
  return (
    <div className="table-pagination">
      <div className="table-pagination-pages">
        <button type="button" className="pagination-arrow" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">‹</button>
        {pageList.map((p, i) => (
          p === '…'
            ? <span key={`gap-${i}`} className="pagination-ellipsis">…</span>
            : <button key={p} type="button" className={`pagination-page${p === page ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>
        ))}
        <button type="button" className="pagination-arrow" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">›</button>
      </div>
      <div className="table-pagination-size">
        <span className="muted">Page size:</span>
        {pageSizeOptions.map((n) => (
          <button key={n} type="button" className={`pagination-page${n === pageSize ? ' active' : ''}`} onClick={() => setPageSize(n)}>{n}</button>
        ))}
      </div>
    </div>
  );
}

export function PaginatedTable({ columns, rows, onRowClick, onReorderColumn, emptyMessage, compact = false, pageSizeOptions = [10, 25, 50, 100], initialPageSize = 25, renderSubRow, emptyCellValue }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(rows?.length ?? 0, { pageSizeOptions, initialPageSize });
  const tableProps = { columns, onRowClick, onReorderColumn, emptyMessage, compact, renderSubRow, emptyCellValue };

  if (!rows?.length) {
    return <DataTable {...tableProps} rows={rows} />;
  }

  const pageRows = rows.slice(start, end);

  return (
    <>
      <DataTable {...tableProps} rows={pageRows} />
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={pageSizeOptions} totalPages={totalPages} />
    </>
  );
}

// Card-grid counterpart to PaginatedTable — same PaginationControls footer,
// so switching between List and Card view doesn't change how paging looks or
// behaves. Page size defaults lower than the table's: cards are much taller,
// so 25 of them is a very long scroll.
export function PaginatedCardGrid({ items, renderItem, keyOf, emptyMessage, pageSizeOptions = [12, 24, 48, 96], initialPageSize = 12 }) {
  const { page, setPage, pageSize, setPageSize, totalPages, start, end } = usePagination(items?.length ?? 0, { pageSizeOptions, initialPageSize });

  if (!items?.length) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  const pageItems = items.slice(start, end);

  return (
    <>
      <div className="ticket-card-grid">
        {pageItems.map((item, i) => (
          <div key={keyOf ? keyOf(item) : i}>{renderItem(item)}</div>
        ))}
      </div>
      <PaginationControls page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={pageSizeOptions} totalPages={totalPages} />
    </>
  );
}

export function ViewModeDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const current = VIEW_MODE_OPTIONS.find((o) => o.value === value) ?? VIEW_MODE_OPTIONS[0];

  return (
    <div className="view-dropdown" ref={ref}>
      <button
        type="button"
        className="view-dropdown-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon name={current.icon} size={14} /> {current.label} <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="view-dropdown-menu" role="listbox">
          {VIEW_MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`view-dropdown-item${o.value === value ? ' active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <Icon name={o.icon} size={14} /> {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Toolbar trigger + popover for picking which columns a table shows and
// reordering them by drag — spread straight from useColumnChooser's return
// value as <ColumnChooserButton {...chooser} />.
export function ColumnChooserButton({ allColumns, order, hidden, toggleColumn, reorderColumn, resetColumns }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dragKeyRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const byKey = new Map(allColumns.map((c) => [c.key, c]));
  const orderedColumns = order.map((k) => byKey.get(k)).filter(Boolean);
  const query = search.trim().toLowerCase();
  const filtered = query ? orderedColumns.filter((c) => c.label.toLowerCase().includes(query)) : orderedColumns;
  // Dragging to reorder only makes sense against the full, unfiltered list —
  // disabled while a search is narrowing the rows shown, same reasoning
  // CreatableSelect's own filtered list uses.
  const dragEnabled = !query;

  return (
    <div className="column-chooser" ref={containerRef}>
      <button
        type="button"
        className={`export-btn${open ? ' is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Choose columns"
        aria-label="Choose columns"
      >
        <Icon name="columns" size={16} />
      </button>
      {open && (
        <div className="column-chooser-panel" role="dialog" aria-label="Choose columns">
          <div className="column-chooser-head">
            <h4>Choose Columns</h4>
            <button type="button" className="toast-notice-close" onClick={() => setOpen(false)} aria-label="Close">
              <Icon name="close" size={13} />
            </button>
          </div>
          <div className="column-chooser-search">
            <Icon name="search" size={13} />
            <input type="text" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="column-chooser-list">
            {filtered.map((col) => (
              <div
                key={col.key}
                className="column-chooser-row"
                draggable={dragEnabled}
                onDragStart={() => { dragKeyRef.current = col.key; }}
                onDragOver={(e) => { if (dragEnabled) e.preventDefault(); }}
                onDrop={() => {
                  if (dragEnabled && dragKeyRef.current) reorderColumn(dragKeyRef.current, col.key);
                  dragKeyRef.current = null;
                }}
              >
                <span className={`column-chooser-grip${dragEnabled ? '' : ' is-disabled'}`} aria-hidden="true">
                  <Icon name="gripVertical" size={14} />
                </span>
                <label className="column-chooser-checkbox">
                  <input
                    type="checkbox"
                    checked={!hidden.has(col.key)}
                    disabled={col.locked}
                    onChange={() => toggleColumn(col.key)}
                  />
                  <span>{col.label}</span>
                </label>
              </div>
            ))}
            {filtered.length === 0 && <p className="column-chooser-empty">No columns match &quot;{search}&quot;.</p>}
          </div>
          <div className="column-chooser-foot">
            <button type="button" className="link-button" onClick={resetColumns}>Reset to default</button>
          </div>
        </div>
      )}
    </div>
  );
}
