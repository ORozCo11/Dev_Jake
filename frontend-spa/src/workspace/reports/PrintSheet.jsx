import { createPortal } from 'react-dom';
import Icon from '../../components/Icon';

// Print-only report sheet shared by the Reports module and Vehicle History.
// Portaled to <body> because the app's @media print rule hides #root
// entirely (see vehicle-profile.css). Always printed black-on-white via
// .p23-print (p23-admin.css), whatever theme the screen is in.
//
// `meta` is a list of { label, value } printed under the title (barangay,
// prepared by/on, filters, record count) so a printed page stands on its own.
// `landscape` adds a page-size rule only while this sheet is mounted.
export function PrintSheet({ title, meta = [], columns, rows, rowKey, landscape = false, emptyText = 'No records match the applied filters.' }) {
  return createPortal(
    <div className={`report-print-view p23-print${landscape ? ' is-landscape' : ''}`}>
      {landscape && <style>{'@media print { @page { size: landscape; margin: 0; } }'}</style>}
      <div className="veh-print-header">
        <div className="veh-print-header-left">
          <h2>{title}</h2>
        </div>
        <div className="veh-print-header-right">
          <Icon name="gear" size={48} className="topbar-gear-icon" filled />
          <span className="vms-wordmark">vms</span>
        </div>
      </div>
      {meta.length > 0 && (
        <dl className="p23-print-meta">
          {meta.filter((m) => m.value != null && m.value !== '').map((m) => (
            <div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>
          ))}
        </dl>
      )}
      <table className="report-print-table">
        <thead>
          <tr>{columns.map((col) => <th key={col.label} scope="col">{col.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row, i) => (
            <tr key={(rowKey && rowKey(row)) ?? i}>{columns.map((col) => <td key={col.label}>{col.render(row)}</td>)}</tr>
          )) : (
            <tr><td colSpan={columns.length || 1}>{emptyText}</td></tr>
          )}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}
