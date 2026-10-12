import { useEffect, useId, useRef, useState } from 'react';
import Icon from '../../components/Icon';
import { reportColumns } from '../columns';
import { DataTable } from '../components/tables';
import { formatDate, formatLogDateTime } from '../lib/format';
import { REPORT_CATALOG, describeReportFilters, exportRowsToCsv, findReportDef, reportExportColumns, reportFieldDefs } from '../lib/reports';
import { PrintSheet } from './PrintSheet';

// Generated report: title + who/where/when it was prepared + the exact
// filters applied, then the data. CSV = raw rows for a spreadsheet; Print =
// a formatted, always black-on-white page (Save as PDF from the dialog).
export function ReportPreview({ report, lookups = {}, barangay }) {
  const def = findReportDef(report?.report_type);
  const [orientation, setOrientation] = useState(def?.wide ? 'landscape' : 'portrait');
  const orientationId = useId();

  if (!report) {
    return <p className="empty-state">Choose a report above, set its filters, then Generate to see a preview here.</p>;
  }

  const rows = report.rows ?? [];
  const columns = reportColumns(rows);
  const filters = describeReportFilters(report.filters, lookups);
  const filterText = filters.length ? filters.map((f) => `${f.label}: ${f.value}`).join(' · ') : 'None — all records';
  const fileStem = `${report.report_type.toLowerCase().replaceAll(' ', '-')}-${String(report.generated_at ?? '').slice(0, 10) || 'export'}`;

  return (
    <section className="p23-report-preview" aria-labelledby={`${orientationId}-title`}>
      <div className="report-heading p23-report-heading">
        <div>
          <p className="p23-report-eyebrow">Report preview</p>
          <h3 id={`${orientationId}-title`}>{report.report_type}</h3>
        </div>
      </div>

      <dl className="p23-report-meta">
        {barangay && <div><dt>Barangay</dt><dd>{barangay}</dd></div>}
        <div><dt>Prepared by</dt><dd>{report.generated_by ?? '—'}</dd></div>
        <div><dt>Prepared on</dt><dd>{formatDate(report.generated_at)}</dd></div>
        <div><dt>Records</dt><dd>{rows.length}</dd></div>
        <div className="p23-report-meta-wide"><dt>Filters applied</dt><dd>{filterText}</dd></div>
      </dl>

      <div className="p23-report-actions" role="group" aria-label="Report output">
        <div className="p23-report-action">
          <button
            className="ghost-button"
            disabled={!rows.length}
            onClick={() => exportRowsToCsv(`${fileStem}.csv`, reportExportColumns(rows), rows)}
            type="button"
          >
            <Icon name="download" size={14} /> Download CSV
          </button>
          <span className="p23-report-action-hint">Raw data only, for Excel or Google Sheets.</span>
        </div>
        <div className="p23-report-action">
          <div className="p23-report-print-row">
            <button className="primary-button" onClick={() => window.print()} type="button">
              <Icon name="clipboard" size={14} /> Print / Save as PDF
            </button>
            <label className="p23-orientation" htmlFor={orientationId}>
              <span>Page</span>
              <select id={orientationId} value={orientation} onChange={(e) => setOrientation(e.target.value)}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape (wide tables)</option>
              </select>
            </label>
          </div>
          <span className="p23-report-action-hint">Formatted report with this header, always printed black on white.</span>
        </div>
      </div>

      {rows.length ? (
        <DataTable columns={columns} rows={rows} />
      ) : (
        <div className="empty-state p23-empty">
          <p><strong>No records match this report's filters.</strong></p>
          <p>Try a wider date range or a different {filters.length ? filters.map((f) => f.label.toLowerCase()).join(' / ') : 'filter'}. You can still print this page as a record that nothing was found.</p>
        </div>
      )}

      <PrintSheet
        title={report.report_type}
        landscape={orientation === 'landscape'}
        meta={[
          { label: 'Barangay', value: barangay },
          { label: 'Prepared by', value: report.generated_by },
          { label: 'Prepared on', value: formatDate(report.generated_at) },
          { label: 'Filters applied', value: filterText },
          { label: 'Records', value: String(rows.length) },
        ]}
        columns={columns}
        rows={rows}
        emptyText="No records match the applied filters."
      />
    </section>
  );
}

// Filter form for one report template. Generate stays disabled until every
// required filter is set and the date range is valid, and shows progress
// while the report is being built.
function ReportGeneratorForm({ reportDef, lookups, onGenerate }) {
  const fields = reportFieldDefs(lookups, reportDef);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const baseId = useId();

  const missing = fields.filter((f) => f.required && !String(values[f.name] ?? '').trim());
  const badRange = values.from && values.to && values.from > values.to;
  const blocked = missing.length > 0 || badRange;
  const statusId = `${baseId}-status`;

  const submit = async (event) => {
    event.preventDefault();
    if (blocked || busy) return;
    setBusy(true);
    try {
      await onGenerate({ report_type: reportDef.type, ...values });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="p23-report-form" onSubmit={submit} noValidate aria-busy={busy}>
      {fields.length ? (
        <div className="p23-report-fields">
          {fields.map((f) => {
            const id = `${baseId}-${f.name}`;
            const value = values[f.name] ?? '';
            const set = (v) => setValues((prev) => ({ ...prev, [f.name]: v }));
            return (
              <div key={f.name} className="p23-report-field">
                <label htmlFor={id}>
                  {f.label}{f.required ? <span className="required-asterisk" aria-hidden="true"> *</span> : <span className="p23-optional"> (optional)</span>}
                </label>
                {f.type === 'select' ? (
                  <select id={id} value={value} onChange={(e) => set(e.target.value)} required={f.required} aria-describedby={statusId}>
                    <option value="">{f.required ? `Choose ${f.label.toLowerCase()}…` : `All ${f.label.toLowerCase()}s`}</option>
                    {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input
                    id={id}
                    type={f.type}
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    required={f.required}
                    aria-invalid={f.type === 'date' && badRange ? 'true' : undefined}
                    aria-describedby={statusId}
                  />
                )}
                {f.hint && <span className="p23-field-hint">{f.hint}</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="p23-report-nofilters">No filters needed — this report covers all records.</p>
      )}
      <div className="p23-report-submit">
        <p id={statusId} className={`p23-report-status${badRange ? ' is-error' : ''}`} aria-live="polite">
          {busy
            ? 'Generating report…'
            : badRange
              ? '“Date From” must be on or before “Date To”.'
              : missing.length
                ? `Choose ${missing.map((f) => f.label.toLowerCase()).join(' and ')} to generate this report.`
                : 'Ready to generate.'}
        </p>
        <button className="primary-button" type="submit" disabled={blocked || busy}>
          {busy ? <span className="p23-spinner" aria-hidden="true" /> : null}
          {busy ? 'Generating…' : 'Generate Report'}
        </button>
      </div>
    </form>
  );
}

export function ReportsModule({ lookups, onGenerate }) {
  // Only one report's form is open at a time, across all categories, so
  // Generate only ever appears once on screen.
  const [expandedType, setExpandedType] = useState(null);

  return (
    <div className="report-catalog-grid p23-reports">
      {REPORT_CATALOG.map((group) => (
        <section key={group.category} className={`report-category-card tone-${group.tone}`} aria-labelledby={`report-group-${group.tone}`}>
          <div className="report-category-card-head">
            <span className="report-category-card-icon" aria-hidden="true"><Icon name={group.icon} size={16} /></span>
            <div className="p23-report-group-text">
              <h4 id={`report-group-${group.tone}`}>{group.category}</h4>
              <p>{group.purpose}</p>
            </div>
            <span className="report-category-count" aria-label={`${group.reports.length} report${group.reports.length === 1 ? '' : 's'}`}>{group.reports.length}</span>
          </div>
          <div className="report-category-card-body">
            {group.reports.map((r) => {
              const isOpen = expandedType === r.type;
              const panelId = `report-panel-${r.type.replaceAll(' ', '-').toLowerCase()}`;
              return (
                <div key={r.type} className={`report-type-row${isOpen ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="report-type-item"
                    onClick={() => setExpandedType((t) => (t === r.type ? null : r.type))}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                  >
                    <span className="report-type-icon" aria-hidden="true"><Icon name={r.icon} size={15} /></span>
                    <span className="report-type-text">
                      <strong>{r.type}</strong>
                      <span>{r.description}</span>
                      {r.includes && <span className="p23-report-includes">Includes: {r.includes}</span>}
                    </span>
                    <Icon name="chevronDown" size={14} className={isOpen ? 'is-expanded' : ''} />
                  </button>
                  {isOpen && (
                    <div className="report-generator-panel" id={panelId}>
                      <ReportGeneratorForm key={r.type} reportDef={r} lookups={lookups} onGenerate={onGenerate} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// Toolbar button + popover offering a few pre-shaped CSV exports over
// whatever activity rows are currently in view (same filtered/searched set
// the table shows) — a raw chronological dump, and two rollups (by user, by
// module) that are actually useful for "who's been doing what" questions a
// raw log dump doesn't answer directly.
export function GenerateReportButton({ rows }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const runReport = (type) => {
    setOpen(false);
    const stamp = new Date().toISOString().slice(0, 10);

    if (type === 'timeline') {
      exportRowsToCsv(`activity-timeline-${stamp}.csv`, [
        { label: 'Date and Time', value: (r) => formatLogDateTime(r.created_at) },
        { label: 'User', value: (r) => r.user?.name ?? 'System' },
        { label: 'Role', value: (r) => r.role ?? '-' },
        { label: 'Module', value: (r) => r.module ?? '-' },
        { label: 'Action', value: (r) => r.action },
        { label: 'Details', value: (r) => r.details ?? '' },
      ], rows);
      return;
    }

    if (type === 'user') {
      const byUser = new Map();
      rows.forEach((r) => {
        const key = r.user?.name ?? 'System';
        const entry = byUser.get(key) ?? { user: key, role: r.role ?? '-', total: 0, last: r.created_at };
        entry.total += 1;
        if (r.created_at && (!entry.last || new Date(r.created_at) > new Date(entry.last))) entry.last = r.created_at;
        byUser.set(key, entry);
      });
      exportRowsToCsv(`activity-by-user-${stamp}.csv`, [
        { label: 'User', value: (r) => r.user },
        { label: 'Role', value: (r) => r.role },
        { label: 'Total Actions', value: (r) => r.total },
        { label: 'Last Active', value: (r) => formatLogDateTime(r.last) },
      ], [...byUser.values()].sort((a, b) => b.total - a.total));
      return;
    }

    if (type === 'module') {
      const byModule = new Map();
      rows.forEach((r) => {
        const key = r.module ?? 'Other';
        byModule.set(key, (byModule.get(key) ?? 0) + 1);
      });
      exportRowsToCsv(`activity-by-module-${stamp}.csv`, [
        { label: 'Module', value: (r) => r.module },
        { label: 'Total Actions', value: (r) => r.total },
      ], [...byModule.entries()].map(([module, total]) => ({ module, total })).sort((a, b) => b.total - a.total));
    }
  };

  return (
    <div className="column-chooser generate-report" ref={containerRef}>
      <button type="button" className={`primary-button generate-report-btn${open ? ' is-active' : ''}`} onClick={() => setOpen((v) => !v)}>
        Generate Report <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div className="column-chooser-panel generate-report-panel" role="menu">
          <p className="p23-genreport-scope">Downloads a CSV of the {rows.length} {rows.length === 1 ? 'entry' : 'entries'} currently listed (filters and search applied).</p>
          <button type="button" className="generate-report-option" onClick={() => runReport('timeline')}>
            <strong>Timeline Report</strong>
            <span>Every action, newest first: date, user, role, module, what happened.</span>
          </button>
          <button type="button" className="generate-report-option" onClick={() => runReport('user')}>
            <strong>User Report</strong>
            <span>Action counts per user, most active first.</span>
          </button>
          <button type="button" className="generate-report-option" onClick={() => runReport('module')}>
            <strong>Module Report</strong>
            <span>Action counts per module, busiest first.</span>
          </button>
        </div>
      )}
    </div>
  );
}
