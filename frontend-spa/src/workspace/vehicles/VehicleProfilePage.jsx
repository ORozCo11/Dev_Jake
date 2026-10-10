import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import Icon from '../../components/Icon';
import useDepsChanged from '../../hooks/useDepsChanged';
import api from '../../api/axios';
import { AuthContext } from '../../context/AuthContextObject';
import { VehicleLocationMap } from '../../components/lazy';
import Modal from '../components/Modal';
import { FormModal, ModulePanel, PhotoCell, QuietDate, StatusBadge } from '../components/ui';
import { SmartForm } from '../forms/SmartForm';
import { moduleRequest, sendPayload, showError } from '../lib/data';
import { customValueRows, defaultCriticalityFor, plateFieldLabel, vehicleCriticality, vehicleFields, vehicleIconName, vehicleWithCustomInitials } from '../lib/fields';
import { formatDate, formatForecastDate, resolvePhotoUrl } from '../lib/format';
import { canDo, hasRole } from '../lib/permissions';
import { CAPABILITY_STATE_LABEL } from '../lib/statCards';
import { ReadinessCheckForm } from './ReadinessCheckForm';

// Production-readiness audit finding #8 — FleetController::vehicleReliability()
// was fully built (failure counts, days out of service, lifetime spend, a
// chronic flag, a decommission signal) but had no caller anywhere in the
// frontend. Surfaced here, on the existing Vehicle Profile page, rather than
// a new sidebar module for one metric set.
export function VehicleReliabilityCard({ vehicleId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  if (useDepsChanged([vehicleId])) setLoading(true);

  useEffect(() => {
    let cancelled = false;
    api.get(`/vehicles/${vehicleId}/reliability`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vehicleId]);

  const peso = (n) => `₱${Number(n ?? 0).toLocaleString()}`;
  // UI audit §5 — a vehicle with no repair history used to show a wall of
  // "0" / "₱0" that read like a measured result; say "no data yet" instead.
  const noHistory = data && !Number(data.failures_12mo) && !Number(data.total_spend) && data.avg_days_out == null;

  return (
    <section className="veh-card">
      <div className="veh-card-head"><Icon name="wrench" size={16} /><h4>Reliability</h4></div>
      {loading ? (
        <p className="muted" style={{ padding: '10px 14px' }}>Loading…</p>
      ) : !data ? (
        <p className="muted" style={{ padding: '10px 14px' }}>Reliability data is unavailable right now.</p>
      ) : noHistory ? (
        <p className="muted" style={{ padding: '10px 14px', margin: 0 }}>No data yet — figures appear once a repair or maintenance cost is recorded for this vehicle.</p>
      ) : (
        <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(data.chronic || data.decommission_signal) && (
            <div className="ticket-alert-banner formaint" style={{ marginBottom: 2 }}>
              <Icon name="alert" size={14} />
              {data.chronic && data.decommission_signal
                ? 'Chronic repeat failures, and lifetime repair spend is a large share of this vehicle’s value.'
                : data.chronic
                  ? 'Chronic repeat failures on this vehicle — consider a deeper fix.'
                  : 'Lifetime repair spend is a large share of this vehicle’s value — a decommission review may be worth it.'}
            </div>
          )}
          <dl className="veh-kv" style={{ margin: 0 }}>
            <div><dt>Failures (6 mo)</dt><dd>{data.failures_6mo}</dd></div>
            <div><dt>Failures (12 mo)</dt><dd>{data.failures_12mo}</dd></div>
            <div><dt>Avg. Days Out of Service</dt><dd>{data.avg_days_out ?? '-'}</dd></div>
            <div><dt>Recorded Repair Spend</dt><dd>{peso(data.total_spend)}</dd></div>
            {data.acquisition_cost != null && (
              <div><dt>Spend vs. Acquisition Cost</dt><dd>{data.cost_ratio != null ? `${Math.round(data.cost_ratio * 100)}%` : '-'}</dd></div>
            )}
          </dl>
          <p className="p23-source-note">Source: maintenance tickets and records logged in VMS. Spend covers recorded costs only — repairs paid outside the system aren&apos;t included.</p>
        </div>
      )}
    </section>
  );
}

export function VehicleFiles({ vehicleId, canManage, onRequestConfirmation }) {
  // canManage (Admin + Custodian, from VehicleProfilePage's
  // canManageDocuments) governs upload only here — VehicleFilesModal reads
  // the logged-in user itself to further narrow Edit to Admin (any) /
  // Custodian (their own upload only) and Delete to Admin only.
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [initialFile, setInitialFile] = useState(null);
  const [modalKey, setModalKey] = useState(0);

  const load = useCallback(() => {
    api.get(`/vehicles/${vehicleId}/documents`)
      .then((r) => { setDocuments(r.data); setLoadFailed(false); })
      .catch(() => { setDocuments([]); setLoadFailed(true); })
      .finally(() => setLoading(false));
  }, [vehicleId]);

  useEffect(() => { load(); }, [load]);

  const openModal = (file = null) => {
    setInitialFile(file);
    setModalKey((k) => k + 1);
    setModalOpen(true);
  };

  const modal = modalOpen && (
    <VehicleFilesModal
      key={modalKey}
      onClose={() => setModalOpen(false)}
      vehicleId={vehicleId}
      documents={documents}
      canManage={canManage}
      onChanged={load}
      initialFile={initialFile}
      onRequestConfirmation={onRequestConfirmation}
    />
  );

  return (
    <section className="veh-card veh-files">
      <div className="veh-card-head veh-files-head">
        <div className="veh-files-head-title"><Icon name="clipboard" size={16} /><h4>Files</h4></div>
        <div className="veh-files-head-actions">
          <button type="button" className="file-card-icon-btn" onClick={() => openModal()} title="Expand" aria-label="Expand">
            <Icon name="maximize" size={13} />
          </button>
          {canManage && (
            <button type="button" className="file-card-icon-btn" onClick={() => openModal()} title="Add file" aria-label="Add file">
              <Icon name="plus" size={13} />
            </button>
          )}
        </div>
      </div>
      <div
        className="veh-files-body"
        onDragOver={(e) => canManage && e.preventDefault()}
        onDrop={(e) => {
          if (!canManage) return;
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) openModal(file);
        }}
      >
        {loading ? (
          <p className="empty-state">Loading files…</p>
        ) : loadFailed ? (
          <div className="file-card-empty" role="alert">
            Files couldn&apos;t be loaded.{' '}
            <button type="button" className="p23-link-btn" onClick={load}>Retry</button>
          </div>
        ) : documents.length ? (
          <div className="veh-files-compact-list">
            {documents.slice(0, 4).map((doc) => (
              <a key={doc.document_id} className="veh-files-compact-row" href={resolvePhotoUrl(doc.file_url)} target="_blank" rel="noreferrer">
                <Icon name="clipboard" size={14} />
                <span>{doc.title}</span>
              </a>
            ))}
            {documents.length > 4 && (
              <button type="button" className="veh-files-more" onClick={() => openModal()}>+{documents.length - 4} more</button>
            )}
          </div>
        ) : (
          <div className="file-card-empty">No files uploaded yet</div>
        )}
        {canManage && (
          <button type="button" className="file-card-dropzone veh-files-dropzone-trigger" onClick={() => openModal()}>
            <Icon name="upload" size={30} strokeWidth={1.6} />
            <span>Drag file here</span>
          </button>
        )}
      </div>
      {modal}
    </section>
  );
}

// Given a fresh `key` every time it's opened (see VehicleFiles.openModal), so
// mounting with the right `initialFile` already pre-filled needs no
// reset-on-open effect — a new mount already starts from the right state.
export function VehicleFilesModal({ onClose, vehicleId, documents, canManage, onChanged, initialFile, onRequestConfirmation }) {
  const { user } = useContext(AuthContext);
  // Phase B4 — document.delete is Admin-only (Custodian lost it); edit stays
  // Admin (any document) + Custodian, but only on the document THEY uploaded
  // (added_by is already in the list payload, so this needs no extra fetch —
  // the backend enforces the same ownership rule and 403s otherwise).
  const canDeleteDocs = hasRole(user, 'Admin');
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [pendingFile, setPendingFile] = useState(initialFile ?? null);
  const [addTitle, setAddTitle] = useState(initialFile ? initialFile.name.replace(/\.[^.]+$/, '') : '');
  const [addCategory, setAddCategory] = useState('');
  const [uploadPct, setUploadPct] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const selected = documents.find((d) => d.document_id === selectedId);
  const canEditSelected = !!selected && (hasRole(user, 'Admin') || (canDo(user, 'document.edit') && String(selected.added_by?.id) === String(user.id)));

  const handlePick = (file) => {
    setPendingFile(file);
    setAddTitle(file.name.replace(/\.[^.]+$/, ''));
    setError(null);
  };

  const handleUpload = async () => {
    if (!pendingFile || !addTitle.trim()) return;
    setUploadPct(0);
    setError(null);
    const formData = new FormData();
    formData.append('file', pendingFile);
    formData.append('title', addTitle.trim());
    if (addCategory.trim()) formData.append('category', addCategory.trim());
    try {
      await api.post(`/vehicles/${vehicleId}/documents`, formData, {
        onUploadProgress: (e) => setUploadPct(e.total ? Math.round((e.loaded * 100) / e.total) : null),
      });
      setPendingFile(null);
      setAddTitle('');
      setAddCategory('');
      setUploadPct(null);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Upload failed.');
      setUploadPct(null);
    }
  };

  const startEdit = (doc) => {
    setEditingId(doc.document_id);
    setEditTitle(doc.title);
    setEditCategory(doc.category ?? '');
  };

  const saveEdit = async () => {
    if (!editTitle.trim()) return;
    try {
      await api.put(`/documents/${editingId}`, { title: editTitle.trim(), category: editCategory.trim() || null });
      setEditingId(null);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Could not save changes.');
    }
  };

  const doDelete = async (doc) => {
    try {
      await api.delete(`/documents/${doc.document_id}`);
      if (selectedId === doc.document_id) setSelectedId(null);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Could not delete file.');
    }
  };

  const handleDelete = (doc) => {
    onRequestConfirmation?.({
      title: 'Delete File',
      message: `Delete "${doc.title}" from this vehicle's file cabinet? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => doDelete(doc),
    });
  };

  return (
    <Modal
      title="Files"
      onClose={onClose}
      wide
      className="files-modal"
      headerExtra={(
          <div className="files-modal-toolbar">
            {canManage && (
              <>
                <button type="button" className="file-card-icon-btn" onClick={() => fileInputRef.current?.click()} title="Add file" aria-label="Add file">
                  <Icon name="plus" size={14} />
                </button>
                <button
                  type="button"
                  className="file-card-icon-btn"
                  disabled={!canEditSelected}
                  onClick={() => canEditSelected && startEdit(selected)}
                  title={!selected ? 'Select a file first to edit it' : !canEditSelected ? 'You can only edit a file you uploaded yourself' : 'Edit selected'}
                  aria-label="Edit selected"
                >
                  <Icon name="edit" size={14} />
                </button>
                {canDeleteDocs && (
                  <button type="button" className="file-card-icon-btn" disabled={!selected} onClick={() => selected && handleDelete(selected)} title={selected ? 'Delete selected' : 'Select a file first to delete it'} aria-label="Delete selected">
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </>
            )}
          </div>
      )}
    >
          {error && (
            <div className="notice error" role="alert" style={{ marginBottom: 12 }}>{error}</div>
          )}
          <div className="files-modal-table-wrap">
            <table className="files-modal-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Added By</th>
                  <th>Date Added</th>
                </tr>
              </thead>
              <tbody>
                {documents.length === 0 ? (
                  <tr><td colSpan={5} className="files-modal-empty">No files uploaded yet</td></tr>
                ) : documents.map((doc) => (
                  <tr key={doc.document_id} className={selectedId === doc.document_id ? 'is-selected' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${doc.title}`}
                        checked={selectedId === doc.document_id}
                        onChange={() => setSelectedId(selectedId === doc.document_id ? null : doc.document_id)}
                      />
                    </td>
                    {editingId === doc.document_id ? (
                      <>
                        <td><input aria-label="File title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></td>
                        <td><input aria-label="File category" value={editCategory} onChange={(e) => setEditCategory(e.target.value)} placeholder="Category" /></td>
                        <td>{doc.added_by?.name ?? '—'}</td>
                        <td>
                          <QuietDate value={doc.created_at} />
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button type="button" className="ghost-button" style={{ height: 28, padding: '0 10px', fontSize: '0.76rem' }} onClick={saveEdit}>Save</button>
                            <button type="button" className="ghost-button" style={{ height: 28, padding: '0 10px', fontSize: '0.76rem' }} onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          <a href={resolvePhotoUrl(doc.file_url)} target="_blank" rel="noreferrer" className="files-modal-title-link">
                            <Icon name="clipboard" size={13} />{doc.title}
                          </a>
                        </td>
                        <td>{doc.category || '—'}</td>
                        <td>{doc.added_by?.name ?? '—'}</td>
                        <td><QuietDate value={doc.created_at} /></td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canManage && (
            <div
              className="file-card-dropzone files-modal-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) handlePick(file);
              }}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              aria-label="Add a file: drag one here, or press Enter to browse"
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); }
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => { const file = e.target.files?.[0]; if (file) handlePick(file); }}
              />
              <Icon name="upload" size={30} strokeWidth={1.6} />
              <span>Drag file here</span>
            </div>
          )}

          {pendingFile && (
            <div className="files-modal-pending">
              <div className="files-modal-pending-row">
                <Icon name="clipboard" size={14} />
                <span className="files-modal-pending-name">{uploadPct != null ? 'Uploading… ' : ''}{pendingFile.name}</span>
                {uploadPct != null && <span className="files-modal-pending-pct">{uploadPct}%</span>}
                <button type="button" className="ghost-button" style={{ height: 28, padding: '0 10px', fontSize: '0.76rem' }} onClick={() => { setPendingFile(null); setUploadPct(null); }}>Cancel</button>
              </div>
              {uploadPct != null && (
                <div className="files-modal-progress-track"><div className="files-modal-progress-bar" style={{ width: `${uploadPct}%` }} /></div>
              )}
              {uploadPct == null && (
                <div className="files-modal-pending-fields">
                  <input aria-label="New file title" placeholder="Title" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} />
                  <input aria-label="New file category" placeholder="Category (optional)" value={addCategory} onChange={(e) => setAddCategory(e.target.value)} />
                  <button type="button" className="primary-button" style={{ height: 36, padding: '0 16px', fontSize: '0.85rem' }} onClick={handleUpload} disabled={!addTitle.trim()}>Add File</button>
                </div>
              )}
            </div>
          )}
    </Modal>
  );
}

// UI audit §5/§6 — the profile's top band answers "can this vehicle go out
// right now, and if not, why and what's next?" before any record detail.
// Every state carries a text label + icon, never colour alone, and the
// tone maps onto the theme-aware --status-* tokens (p23-vehicles.css) instead
// of READINESS_BADGE's fixed light-theme hex values.
const READINESS_VIEW = {
  ready:          { label: 'Ready to respond', tone: 'success', icon: 'checkCircle' },
  stale:          { label: 'Stale — check expired', tone: 'warning', icon: 'alert' },
  not_ready:      { label: 'Failed last check', tone: 'danger', icon: 'alert' },
  unchecked:      { label: 'Never checked', tone: 'neutral', icon: 'info' },
  in_maintenance: { label: 'In maintenance', tone: 'warning', icon: 'wrench' },
  retired:        { label: 'Out of fleet', tone: 'neutral', icon: 'archive' },
};

// last_checked + the backend's freshness window (24h) — the exact moment a
// passed check stops counting, so "Stale" can say when it lapsed.
function readinessExpiry(readiness) {
  if (!readiness?.last_checked) return null;
  const checked = new Date(readiness.last_checked);
  if (Number.isNaN(checked.getTime())) return null;
  return new Date(checked.getTime() + (readiness.freshness_hours ?? 24) * 3600 * 1000).toISOString();
}

// One plain-language sentence for the operational decision, built only from
// what /vehicles/{id}/readiness and the vehicle row already return.
function readinessReason(vehicle, readiness) {
  const checked = readiness?.last_checked ? formatDate(readiness.last_checked) : null;
  const expiry = formatDate(readinessExpiry(readiness));
  const hours = readiness?.freshness_hours ?? 24;
  switch (readiness?.state) {
    case 'ready':
      return vehicle.condition === 'Needs Repair'
        ? `Passed its readiness check (valid until ${expiry}), but its condition is still recorded as Needs Repair.`
        : `Passed its readiness check on ${checked}. Valid until ${expiry}.`;
    case 'stale':
      return `Not ready because the last check (${checked}) expired on ${expiry} — checks are only valid for ${hours} hours. Recheck the vehicle.`;
    case 'not_ready':
      return `Not ready because the last readiness check on ${checked} did not pass. Fix the problem, then recheck.`;
    case 'unchecked':
      return 'Not ready because no readiness check has been recorded for this vehicle yet.';
    case 'in_maintenance': {
      const ticket = readiness.active_ticket_id ? ` — “${readiness.active_ticket_title ?? `Ticket #${readiness.active_ticket_id}`}” is still open` : '';
      const back = vehicle.estimated_return_date ? ` Expected back ${formatForecastDate(vehicle.estimated_return_date)}.` : '';
      return `Not ready because it is ${vehicle.status}${ticket}.${back}`;
    }
    case 'retired':
      return `This vehicle is ${vehicle.status} and no longer counts toward readiness.`;
    default:
      return null;
  }
}

function ReadinessPill({ state }) {
  const view = READINESS_VIEW[state];
  if (!view) return null;
  return (
    <span className={`p23-pill tone-${view.tone}`}>
      <Icon name={view.icon} size={12} /> {view.label}
    </span>
  );
}

function VehicleOperationalSummary({ vehicle, readiness, readinessError, onRetryReadiness, openIssueCount, canCheck, onCheck, onOpenTicket, showActions }) {
  const operational = !['Decommissioned', 'Inactive'].includes(vehicle.status);
  const state = readiness?.state;
  const view = READINESS_VIEW[state];
  const expiry = readinessExpiry(readiness);
  const reason = readiness ? readinessReason(vehicle, readiness) : null;
  const headline = state === 'ready' ? 'Ready to respond' : state === 'retired' ? 'Out of fleet' : 'Not ready to respond';

  return (
    <section className={`p23-summary tone-${view?.tone ?? 'neutral'}`} aria-labelledby="p23-summary-title">
      <div className="p23-decision">
        <div className="p23-decision-text">
          <span className="p23-eyebrow" id="p23-summary-title">Operational decision</span>
          {readinessError ? (
            <p className="p23-decision-line">
              Readiness couldn&apos;t be loaded right now.{' '}
              <button type="button" className="p23-link-btn" onClick={onRetryReadiness}>Retry</button>
            </p>
          ) : !readiness ? (
            <p className="p23-decision-line muted">Checking readiness…</p>
          ) : (
            <>
              <strong className="p23-decision-head">
                {view && <Icon name={view.icon} size={18} />}
                {headline}
              </strong>
              {reason && <p className="p23-decision-line">{reason}</p>}
            </>
          )}
        </div>
        {showActions && operational && (readiness?.active_ticket_id || canCheck) && (
          <div className="p23-decision-actions">
            {readiness?.active_ticket_id && (
              <button type="button" className="ghost-button p23-action" onClick={onOpenTicket}>
                <Icon name="ticket" size={14} /> Open active ticket
              </button>
            )}
            {canCheck && (
              <button type="button" className={`p23-action ${state === 'ready' ? 'ghost-button' : 'success-button'}`} onClick={onCheck}>
                <Icon name="checkCircle" size={14} /> {state === 'unchecked' ? 'Run readiness check' : 'Recheck vehicle'}
              </button>
            )}
          </div>
        )}
      </div>

      <dl className="p23-tiles">
        <div className="p23-tile">
          <dt>Availability</dt>
          <dd><StatusBadge value={vehicle.status} /></dd>
          <span className="p23-tile-meta">{vehicle.updated_at ? `Record updated ${formatDate(vehicle.updated_at)}` : 'No update recorded'}</span>
        </div>
        <div className="p23-tile">
          <dt>Condition</dt>
          <dd><StatusBadge value={vehicle.condition} /></dd>
          <span className="p23-tile-meta">Physical condition — not the same as verified ready</span>
        </div>
        <div className="p23-tile">
          <dt>Readiness</dt>
          <dd>{readiness ? <ReadinessPill state={state} /> : <span className="muted">—</span>}</dd>
          <span className="p23-tile-meta">
            {readiness?.last_checked
              ? <>Checked {formatDate(readiness.last_checked)}<br />{state === 'stale' ? 'Expired' : 'Valid until'} {formatDate(expiry)}</>
              : 'No check recorded yet'}
          </span>
        </div>
        <div className="p23-tile">
          <dt>Open issues</dt>
          <dd className="p23-tile-value">{openIssueCount}</dd>
          <span className="p23-tile-meta">{openIssueCount ? 'Reported and not yet resolved' : 'No unresolved issue reports'}</span>
        </div>
        <div className="p23-tile">
          <dt>Location</dt>
          <dd className="p23-tile-text">{vehicle.current_location ?? 'Not assigned'}</dd>
          <span className="p23-tile-meta">Assigned hub, not live GPS</span>
        </div>
      </dl>
    </section>
  );
}

export function VehicleProfilePage({ vehicleId, lookups, allHubs, basePath, canManage = false, canManageDocuments = false, canViewDocuments = false, canCheckReadiness = false, canRequestInspection = false, canViewReliability = false, setNotice, onSaved, onRequestConfirmation }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(new URLSearchParams(location.search).get('tab') === 'edit');
  const [decommissioning, setDecommissioning] = useState(false);
  const [readiness, setReadiness] = useState(null);
  const [readinessError, setReadinessError] = useState(false);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  // Live-tracks the Edit form's Vehicle Type select so switching a vehicle
  // to a Water category shows Hull Material/Engine Type immediately,
  // instead of only after saving and reloading. Reset whenever a different
  // vehicle's edit form opens (see below).
  const vehicle = (lookups.vehicles ?? []).find((v) => String(v.vehicle_id) === String(vehicleId));
  const [editCategoryId, setEditCategoryId] = useState(vehicle?.category_id ?? null);

  // Deliberately keyed off vehicle_id only, not category_id — the latter is
  // exactly what this state tracks live while editing; including it here
  // would reset every live change right back.
  if (useDepsChanged([vehicle?.vehicle_id])) {
    setEditCategoryId(vehicle?.category_id ?? null);
  }

  // Gap A — response-readiness state.
  const loadReadiness = useCallback(() => {
    api.get(`/vehicles/${vehicleId}/readiness`)
      .then((r) => { setReadiness(r.data); setReadinessError(false); })
      .catch(() => { setReadiness(null); setReadinessError(true); });
  }, [vehicleId]);

  useEffect(() => {
    loadReadiness();
  }, [loadReadiness]);

  const handleReadinessCheck = async (payload) => {
    setNotice(null);
    try {
      const response = await api.post(`/vehicles/${vehicleId}/readiness-check`, payload);
      loadReadiness();
      await onSaved();
      setNotice({ type: 'success', text: 'Readiness check recorded.' });
      setCheckingReadiness(false);

      // Only offered when the backend confirms it's safe: every item
      // passed AND the vehicle has no open ticket. A vehicle with an open
      // ticket must go back to Available through that ticket closing, not
      // through a generic checklist that never looked at the actual repair.
      if (response.data.can_mark_available) {
        onRequestConfirmation?.({
          title: 'Mark Vehicle Available',
          message: `Every item passed and ${vehicle.vehicle_name} has no open ticket — mark it Available now?`,
          confirmLabel: 'Mark Available',
          onConfirm: async () => {
            try {
              await api.put(`/vehicles/${vehicleId}/mark-available`);
              await onSaved();
              loadReadiness();
              setNotice({ type: 'success', text: 'Vehicle marked Available.' });
            } catch (error) {
              showError(error, setNotice);
            }
          },
        });
      }
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const handleDecommission = async (reason) => {
    setNotice(null);
    try {
      await api.put(`/vehicles/${vehicleId}/decommission`, { decommission_reason: reason });
      await onSaved();
      setNotice({ type: 'success', text: 'Vehicle decommissioned.' });
      setDecommissioning(false);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const handleRecommission = async () => {
    setNotice(null);
    try {
      await api.post(`/vehicles/${vehicleId}/restore`);
      await onSaved();
      setNotice({ type: 'success', text: 'Vehicle recommissioned to active service.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  if (!vehicle) {
    return (
      <ModulePanel description="This vehicle could not be found — it may have been archived.">
      </ModulePanel>
    );
  }

  // Admin may not report an issue or open a ticket — the way to act on a
  // hunch is to ask the Custodians to go and look.
  const requestInspection = async () => {
    setNotice(null);
    try {
      await api.post(`/vehicles/${vehicle.vehicle_id}/request-inspection`);
      setNotice({ type: 'success', text: 'Custodians notified to inspect this vehicle.' });
    } catch (error) {
      showError(error, setNotice);
    }
  };

  const handleSave = async (payload) => {
    setNotice(null);
    try {
      const request = moduleRequest('vehicles', vehicle, payload);
      // Empty inputs are never sent, so a blanked custom field would silently
      // keep its old value — say "clear it" explicitly instead.
      const outgoing = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, k.startsWith('cf_') && (v === '' || v == null) ? '__clear__' : v]));
      await sendPayload(request.method, request.path, outgoing);
      await onSaved();
      setNotice({ type: 'success', text: 'Vehicle updated.' });
      setEditing(false);
    } catch (error) {
      showError(error, setNotice);
    }
  };

  // Derived data for the redesigned overview dashboard.
  const hub = (allHubs ?? []).find((h) => h.name === vehicle.current_location);
  const isWater = (vehicle.category?.domain ?? 'Land') === 'Water';
  const operational = !['Decommissioned', 'Inactive'].includes(vehicle.status);
  // /lookups already returns every unresolved issue report (Resolved ones —
  // dismissals included — are excluded server-side).
  const openIssueCount = (lookups.issue_reports ?? []).filter((issue) => String(issue.vehicle_id) === String(vehicle.vehicle_id)).length;
  return (
    <ModulePanel description="Full profile, maintenance, and tickets for this vehicle.">
      {/* UI audit §5 — actions grouped by risk: routine field actions,
          record maintenance, then lifecycle/destructive last and visually
          set apart so Decommission never sits beside a routine button. The
          readiness check itself lives in the Operational decision band
          below, next to the reason it's needed. */}
      <div className="vehicle-profile-header">
        <div className="p23-action-groups">
          {canRequestInspection && operational && !editing && (
            <div className="p23-action-group" role="group" aria-label="Routine actions">
              <button className="btn-sm ghost-button" type="button" onClick={requestInspection}>
                <Icon name="search" size={13} /> Request Custodian Inspection
              </button>
            </div>
          )}
          {canManage && vehicle.status !== 'Decommissioned' && !editing && (
            <div className="p23-action-group" role="group" aria-label="Record maintenance">
              <button className="btn-sm primary-button" type="button" onClick={() => setEditing(true)}>
                <Icon name="edit" size={13} /> Edit Vehicle
              </button>
            </div>
          )}
          {canManage && !editing && (
            <div className="p23-action-group is-lifecycle" role="group" aria-label="Lifecycle actions">
              {vehicle.status !== 'Decommissioned' ? (
                <button className="btn-sm danger-button" type="button" onClick={() => setDecommissioning(true)}>
                  <Icon name="alert" size={13} /> Decommission
                </button>
              ) : (
                <button className="btn-sm primary-button" type="button" onClick={() => onRequestConfirmation?.({
                  title: 'Recommission Vehicle',
                  message: `Bring ${vehicle.vehicle_name} back into active service? This reverses the decommission.`,
                  confirmLabel: 'Recommission',
                  onConfirm: handleRecommission,
                })}>
                  <Icon name="undo" size={13} /> Recommission
                </button>
              )}
            </div>
          )}
        </div>
        {!operational && !editing && (canCheckReadiness || canRequestInspection || canManage) && (
          <p className="p23-unavailable" role="note">
            <Icon name="info" size={14} />
            {vehicle.status === 'Decommissioned'
              ? `Readiness checks, inspections and editing are unavailable while this vehicle is decommissioned${canManage ? ' — recommission it first' : ''}.`
              : 'Readiness checks and inspection requests are unavailable while this vehicle is Inactive.'}
          </p>
        )}
      </div>

      {vehicle.status === 'Decommissioned' && (
        <div className="p23-retired-banner" role="status">
          <div className="p23-retired-banner-head">
            <Icon name="alert" size={18} /> Decommissioned — retired from the fleet
          </div>
          {vehicle.decommission_reason && <p>Reason: {vehicle.decommission_reason}</p>}
          {vehicle.decommissioned_at && <p className="p23-retired-banner-meta">Retired {formatDate(vehicle.decommissioned_at)}. Its history is preserved; it no longer counts toward readiness.</p>}
        </div>
      )}

      <VehicleOperationalSummary
        vehicle={vehicle}
        readiness={readiness}
        readinessError={readinessError}
        onRetryReadiness={loadReadiness}
        openIssueCount={openIssueCount}
        canCheck={canCheckReadiness}
        onCheck={() => setCheckingReadiness(true)}
        onOpenTicket={() => navigate(`${basePath}/tickets/${readiness.active_ticket_id}`)}
        showActions={!editing}
      />

      <FormModal open={checkingReadiness} title={`Readiness Check — ${vehicle.vehicle_name}`} onClose={() => setCheckingReadiness(false)}>
        <ReadinessCheckForm
          key={`readiness-${vehicle.vehicle_id}`}
          vehicle={vehicle}
          onCancel={() => setCheckingReadiness(false)}
          onSubmit={handleReadinessCheck}
        />
      </FormModal>

      <FormModal open={decommissioning} title={`Decommission ${vehicle.vehicle_name}`} onClose={() => setDecommissioning(false)}>
        <p className="muted" style={{ marginBottom: 12, fontSize: '0.85rem' }}>
          This permanently retires the vehicle (end of life) and removes it from readiness/coverage. Its full history is kept, and an Admin can recommission it later if this was a mistake.
        </p>
        <SmartForm
          fields={[{ label: 'Reason for decommissioning', name: 'decommission_reason', required: true, type: 'textarea', rows: 3 }]}
          key="decommission"
          onCancel={() => setDecommissioning(false)}
          onSubmit={(payload) => handleDecommission(payload.decommission_reason)}
          submitLabel="Decommission Vehicle"
          title=""
        />
      </FormModal>

      {editing ? (
        <section className="veh-card veh-edit-card">
          <div className="veh-card-head"><Icon name="edit" size={16} /><h4>Edit Vehicle Information</h4></div>
          <div className="form-grid-2col veh-edit-body">
            <SmartForm
              fields={vehicleFields(
                lookups,
                allHubs,
                lookups.categories?.find((c) => String(c.category_id) === String(editCategoryId))?.domain
                  ?? vehicle.category?.domain
                  ?? 'Land',
                vehicle.photo_url,
                lookups.categories?.find((c) => String(c.category_id) === String(editCategoryId))
              )}
              initialValues={vehicleWithCustomInitials(vehicle)}
              key={vehicle.vehicle_id}
              onValuesChange={(vals) => setEditCategoryId(vals.category_id)}
              onCancel={() => setEditing(false)}
              onSubmit={handleSave}
              submitLabel="Save Changes"
              title=""
            />
          </div>
        </section>
      ) : (
      <>
      <div className="veh-dash">
        <div className="veh-dash-left">
          <section className="veh-card veh-info">
            <div className="veh-card-head"><Icon name={vehicleIconName(vehicle.category?.domain)} size={16} /><h4>Vehicle Information</h4></div>
            <div className="veh-info-body">
              <div className="veh-info-identity">
                <h3>{vehicle.vehicle_name}</h3>
                <span>{vehicle.category?.domain ?? 'Land'}.{vehicle.plate_number}</span>
              </div>
              {vehicle.photo_url && (
                <div className="veh-info-photo"><PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} /></div>
              )}
              <dl className="veh-kv">
                <div><dt>Vehicle Type</dt><dd>{vehicle.category?.category_name ?? 'Unassigned'}</dd></div>
                <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
                <div><dt>Year Model</dt><dd>{vehicle.year_model ?? '-'}</dd></div>
                <div><dt>Capacity</dt><dd>{vehicle.capacity ?? '-'}</dd></div>
                <div><dt>Color</dt><dd>{vehicle.vehicle_color ?? '-'}</dd></div>
                {isWater && (
                  <>
                    <div><dt>Hull Material</dt><dd>{vehicle.hull_material ?? '-'}</dd></div>
                    <div><dt>Engine Type</dt><dd>{vehicle.engine_type ?? '-'}</dd></div>
                  </>
                )}
                <div><dt>Fuel Type</dt><dd>{vehicle.fuel_type ?? '-'}</dd></div>
                {customValueRows(vehicle, lookups)}
              </dl>
            </div>
            {vehicle.remarks && (
              <div className="veh-remarks"><span className="veh-remarks-label">Remarks</span><p>{vehicle.remarks}</p></div>
            )}
          </section>
        </div>

        <div className="veh-dash-right">
          <div className="veh-status-row">
            <section className="veh-card veh-keydates">
              <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Status &amp; Key Dates</h4></div>
              <dl className="veh-kv">
                <div><dt>Availability</dt><dd><StatusBadge value={vehicle.status} /></dd></div>
                <div><dt>Condition</dt><dd><StatusBadge value={vehicle.condition} /></dd></div>
                {readiness && READINESS_VIEW[readiness.state] && (
                  <div><dt>Response Readiness</dt><dd>
                    <ReadinessPill state={readiness.state} />
                    <div className="p23-dd-meta">
                      {readiness.last_checked
                        ? <>Last checked {formatDate(readiness.last_checked)} · {readiness.state === 'stale' ? 'expired' : 'valid until'} {formatDate(readinessExpiry(readiness))}</>
                        : 'No readiness check recorded yet'}
                    </div>
                  </dd></div>
                )}
                {/* Confirmed via live review: a vehicle marked Under
                    Maintenance had no visible path to WHY, forcing a
                    separate hunt through Maintenance Tickets. */}
                {readiness?.active_ticket_id && (
                  <div><dt>Active Ticket</dt><dd>
                    <button
                      type="button"
                      className="btn-view-action p23-ticket-link"
                      onClick={() => navigate(`${basePath}/tickets/${readiness.active_ticket_id}`)}
                    >
                      {readiness.active_ticket_title ?? `Ticket #${readiness.active_ticket_id}`} →
                    </button>
                  </dd></div>
                )}
                {/* Kept beside the other at-a-glance status signals (not
                    buried under specs) — this is how urgently a down unit of
                    this type matters, same scale as the dashboard's
                    Readiness & Criticality Watch. */}
                <div><dt>Criticality</dt><dd>
                  <span className={`risk-watch-tag${(vehicle.criticality ?? defaultCriticalityFor(vehicle, lookups)) === 'Critical' ? ' is-critical' : ''}`}>
                    {(vehicle.criticality ?? defaultCriticalityFor(vehicle, lookups)).toUpperCase()}
                  </span>
                  <div className="p23-dd-meta">{vehicle.criticality ? 'Set for this vehicle' : 'From vehicle type'}</div>
                </dd></div>
                <div><dt>Current Location</dt><dd>{vehicle.current_location ?? '-'}</dd></div>
                {vehicle.estimated_return_date && (
                  <div><dt>Est. Return Date</dt><dd>{formatForecastDate(vehicle.estimated_return_date)}</dd></div>
                )}
                <div><dt>Date Added</dt><dd>{vehicle.created_at ? <QuietDate value={vehicle.created_at} /> : '-'}</dd></div>
                <div><dt>Last Updated</dt><dd>{vehicle.updated_at ? <QuietDate value={vehicle.updated_at} /> : '-'}</dd></div>
              </dl>
            </section>

            <div className="veh-square-col">
              <section className="veh-card veh-reports">
                <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Reports</h4></div>
                <div className="veh-reports-body">
                  <select className="veh-reports-select" defaultValue="summary" aria-label="Report to print">
                    <option value="summary">Vehicle Summary Report</option>
                  </select>
                  <button type="button" className="veh-reports-print-btn" onClick={() => window.print()} title="Print report" aria-label="Print report">
                    <Icon name="print" size={16} />
                  </button>
                </div>
              </section>

              {canViewDocuments && <VehicleFiles vehicleId={vehicle.vehicle_id} canManage={canManageDocuments} onRequestConfirmation={onRequestConfirmation} />}

              {canViewReliability && <VehicleReliabilityCard vehicleId={vehicle.vehicle_id} />}
            </div>
          </div>

          <section className="veh-card veh-map">
            <div className="veh-card-head"><Icon name="pin" size={16} /><h4>Current Location — {vehicle.current_location ?? 'Unknown'}</h4></div>
            <p className="p23-map-note"><Icon name="info" size={13} /> Shows the hub this vehicle is assigned to — not a live GPS position.</p>
            <div className="veh-map-wrap">
              <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} scrollWheelZoom />
            </div>
          </section>
        </div>
      </div>

      {/* Print-only — kept off-screen (see .veh-print-report), shown by the
          Reports card's print button via window.print(). Portaled straight
          to <body> so it never inherits the app shell's own responsive
          collapse (that grid narrows unpredictably once Chromium's print
          engine evaluates media queries against the paper width instead of
          the screen viewport) and so normal document flow — not
          position:fixed — is what lands on the page: a fixed element
          gets reprinted on every page, which was duplicating this whole
          report onto page 2. Reuses the report band/grid look so a
          printed page still reads as a formal document: vehicle identity
          on the left, VMS mark on the right, blue bands. */}
      {createPortal(
        <div className="veh-print-report">
          <div className="veh-print-header">
            <div className="veh-print-header-left">
              <h2>{vehicle.vehicle_name}</h2>
              <p>{vehicle.category?.domain ?? 'Land'}.{vehicle.plate_number}</p>
            </div>
            <div className="veh-print-header-right">
              <Icon name="gear" size={48} className="topbar-gear-icon" filled />
              <span className="vms-wordmark">vms</span>
            </div>
          </div>
          <div className="veh-print-body">
            <div className="veh-print-media">
              {vehicle.photo_url && (
                <div className="veh-print-photo"><PhotoCell alt={vehicle.vehicle_name} url={vehicle.photo_url} /></div>
              )}
            </div>
            <div className="veh-print-info">
              <div className="veh-report-band">Vehicle Information</div>
              <dl className="veh-report-grid">
                <div><dt>{plateFieldLabel(vehicle.category?.domain)}</dt><dd>{vehicle.plate_number}</dd></div>
                <div><dt>Vehicle Name</dt><dd>{vehicle.vehicle_name}</dd></div>
                <div><dt>Vehicle Type</dt><dd>{vehicle.category?.category_name ?? 'Unassigned'}</dd></div>
                <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
                <div><dt>Year Model</dt><dd>{vehicle.year_model ?? '-'}</dd></div>
                <div><dt>Capacity</dt><dd>{vehicle.capacity ?? '-'}</dd></div>
                <div><dt>Color</dt><dd>{vehicle.vehicle_color ?? '-'}</dd></div>
                <div><dt>Fuel Type</dt><dd>{vehicle.fuel_type ?? '-'}</dd></div>
                {isWater && (
                  <>
                    <div><dt>Hull Material</dt><dd>{vehicle.hull_material ?? '-'}</dd></div>
                    <div><dt>Engine Type</dt><dd>{vehicle.engine_type ?? '-'}</dd></div>
                  </>
                )}
                <div><dt>Criticality</dt><dd>{vehicleCriticality(vehicle, lookups)}</dd></div>
                {customValueRows(vehicle, lookups)}
                <div><dt>Acquisition Cost</dt><dd>{vehicle.acquisition_cost != null ? `₱${Number(vehicle.acquisition_cost).toLocaleString()}` : '-'}</dd></div>
                <div><dt>Status</dt><dd>{vehicle.status}</dd></div>
                <div><dt>Condition</dt><dd>{vehicle.condition}</dd></div>
                <div><dt>Current Location</dt><dd>{vehicle.current_location ?? '-'}</dd></div>
                <div><dt>Date Added</dt><dd>{vehicle.created_at ? <QuietDate value={vehicle.created_at} /> : '-'}</dd></div>
                <div><dt>Last Updated</dt><dd>{vehicle.updated_at ? <QuietDate value={vehicle.updated_at} /> : '-'}</dd></div>
              </dl>
            </div>
          </div>
          <div className="veh-print-map-wide">
            <div className="veh-report-band">Current Location — {vehicle.current_location ?? 'Unknown'}</div>
            <div className="veh-print-map">
              <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} />
            </div>
          </div>
        </div>,
        document.body
      )}
      </>
      )}
    </ModulePanel>
  );
}

// Fleet Readiness & Criticality Watch — every operational vehicle that isn't
// verified ready, Critical first. Shown on the lean (Custodian/Maintenance)
// dashboard; Admin sees the same list inside Risk & Readiness Watch.
export function CriticalityWatchCard({ items, onNavigate, basePath }) {
  const shown = (items ?? []).slice(0, 6);

  return (
    <section className="panel col-span-7 dashboard-lean-panel">
      <div className="panel-header-bar">
        <h3><Icon name="alert" size={16} /> Readiness &amp; Criticality Watch</h3>
        {items?.length > 0 && <span className="area-chart-tag">{items.length} not ready</span>}
      </div>
      {!items?.length ? (
        <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> No readiness risks right now.</p>
      ) : (
        <>
          <div className="risk-watch-col">
            {shown.map((r) => (
              <button
                key={r.vehicle_id}
                type="button"
                className={`risk-watch-item risk-watch-item-clickable${r.criticality === 'Critical' ? ' is-critical' : ''}`}
                onClick={() => onNavigate(`${basePath}/vehicles/${r.vehicle_id}`)}
              >
                <span className={`risk-watch-item-dot${r.criticality === 'Critical' ? ' is-critical' : ''}`} />
                <div className="risk-watch-item-body">
                  <span className="risk-watch-item-top">
                    <span className="risk-watch-item-title">{r.vehicle_name}</span>
                    <span className={`risk-watch-tag${r.criticality === 'Critical' ? ' is-critical' : ''}`}>{r.criticality.toUpperCase()}</span>
                  </span>
                  <span className="risk-watch-item-sub">{r.category ?? '—'} · {r.reason}</span>
                </div>
              </button>
            ))}
          </div>
          {items.length > shown.length && (
            <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.78rem' }}>+ {items.length - shown.length} more — open Vehicles to see them all.</p>
          )}
        </>
      )}
    </section>
  );
}

export function CapabilityImpactCard({ items, onNavigate, basePath }) {
  return (
    <section className="panel col-span-7 dashboard-lean-panel">
      <div className="panel-header-bar">
        <h3><Icon name="alert" size={16} /> Fleet Capability Impact</h3>
        {items?.length > 0 && <span className="area-chart-tag">{items.length} type{items.length === 1 ? '' : 's'} affected</span>}
      </div>
      {!items?.length ? (
        <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> No capability gaps right now.</p>
      ) : (
      <div className="risk-watch-col">
        {items.map((row) => (
          <div key={row.category} className={`risk-watch-item${row.criticality === 'Critical' ? ' is-critical' : ''}`} style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <span className={`risk-watch-item-dot${row.criticality === 'Critical' ? ' is-critical' : ''}`} />
            <div className="risk-watch-item-body">
              <span className="risk-watch-item-top">
                <span className="risk-watch-item-title">{row.category}</span>
                <span className={`risk-watch-tag${row.coverage_state === 'NO_COVERAGE' ? ' is-critical' : ''}`}>
                  {CAPABILITY_STATE_LABEL[row.coverage_state] ?? row.coverage_state}
                </span>
              </span>
              <span className="risk-watch-item-sub">
                {row.ready}/{row.total} ready · {row.criticality} · {row.primary_reason ?? 'Based on current records.'}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
                {row.affected_vehicles.slice(0, 4).map((v) => (
                  <span key={v.vehicle_id} className="risk-watch-chip">
                    <button
                      type="button"
                      className="risk-watch-chip-btn"
                      onClick={() => onNavigate(`${basePath}/vehicles/${v.vehicle_id}`)}
                    >
                      {v.vehicle_name}
                    </button>
                    {v.active_ticket_id && (
                      <button
                        type="button"
                        className="risk-watch-chip-btn is-ticket"
                        title={`Open Ticket #${v.active_ticket_id}`}
                        onClick={() => onNavigate(`${basePath}/tickets/${v.active_ticket_id}`)}
                      >
                        Ticket
                      </button>
                    )}
                  </span>
                ))}
                {row.affected_vehicles.length > 4 && (
                  <span className="muted" style={{ fontSize: '0.72rem' }}>+ {row.affected_vehicles.length - 4} more</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      )}
    </section>
  );
}

// Vehicle Usage Log — open a trip when the vehicle goes out, close it when it
// is back. Recording only; it never changes the vehicle's status.
export function VehicleUsageCard({ vehicleId, canLog, vehicleStatus }) {
  const [trips, setTrips] = useState([]);
  const [form, setForm] = useState({ purpose: '', destination: '', driver_name: '', odometer_start: '' });
  const [endForm, setEndForm] = useState({ odometer_end: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.get(`/vehicles/${vehicleId}/usage`).then((res) => { if (!cancelled) setTrips(res.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [vehicleId, reloadKey]);

  const open = trips.find((t) => !t.ended_at);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); setReloadKey((k) => k + 1); } catch (err) {
      setError(err.response?.data?.message || err.response?.data?.errors && Object.values(err.response.data.errors)[0]?.[0] || 'Could not save.');
    } finally { setBusy(false); }
  };

  const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => String(v).trim() !== ''));

  return (
    <section className="veh-card">
      <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Usage Log</h4></div>
      <div style={{ padding: '0 18px 18px', display: 'grid', gap: 10 }}>
        {error && <div className="notice error">{error}</div>}
        {canLog && !open && vehicleStatus === 'Available' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="text" placeholder="Purpose *" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} style={{ flex: '2 1 180px' }} />
            <input type="text" placeholder="Destination" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} style={{ flex: '1 1 140px' }} />
            <input type="text" placeholder="Driver" value={form.driver_name} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} style={{ flex: '1 1 120px' }} />
            <input type="number" min="0" placeholder="Odometer" value={form.odometer_start} onChange={(e) => setForm({ ...form, odometer_start: e.target.value })} style={{ width: 110 }} />
            <button type="button" className="primary-button" disabled={busy || !form.purpose.trim()} onClick={() => run(async () => { await api.post(`/vehicles/${vehicleId}/usage`, clean(form)); setForm({ purpose: '', destination: '', driver_name: '', odometer_start: '' }); })}>Take Out</button>
          </div>
        )}
        {canLog && open && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem' }}>Out since {formatDate(open.started_at)}: <strong>{open.purpose}</strong></span>
            <input type="number" min={open.odometer_start ?? 0} placeholder="Odometer on return" value={endForm.odometer_end} onChange={(e) => setEndForm({ odometer_end: e.target.value })} style={{ width: 150 }} />
            <button type="button" className="primary-button" disabled={busy} onClick={() => run(async () => { await api.put(`/usage-logs/${open.usage_id}/end`, clean(endForm)); setEndForm({ odometer_end: '' }); })}>Mark Returned</button>
          </div>
        )}
        {trips.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No trips recorded yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {trips.slice(0, 8).map((t) => (
              <div key={t.usage_id} style={{ fontSize: '0.84rem', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span><strong>{t.purpose}</strong>{t.destination ? ` → ${t.destination}` : ''}{t.driver_name ? ` · ${t.driver_name}` : ''}</span>
                <span className="muted">{formatDate(t.started_at)}{t.ended_at ? ` – ${formatDate(t.ended_at)}` : ' · out now'}{t.odometer_start != null && t.odometer_end != null ? ` · ${t.odometer_end - t.odometer_start} km` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
