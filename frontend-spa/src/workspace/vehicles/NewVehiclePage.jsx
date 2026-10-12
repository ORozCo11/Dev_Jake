import { useCallback, useEffect, useState } from 'react';
import { VehicleLocationMap } from '../../components/lazy';
import Icon from '../../components/Icon';
import api from '../../api/axios';
import { FormModal, ModulePanel } from '../components/ui';
import { SmartForm } from '../forms/SmartForm';
import { useDraftState } from '../hooks/useDraftState';
import { BLANK_FIELD_DRAFT, CUSTOM_FIELD_TYPES, VEHICLE_WIZARD_STEP_ICONS, VEHICLE_WIZARD_STEP_LABELS, capacityUnits, customFieldInputs, plateFieldLabel, vehicleDomainFields } from '../lib/fields';
import { clearDraftState } from '../lib/formHelpers';
import { EMPTY_OBJ } from '../lib/format';

export function NewVehiclePage({ onBack, lookups, allHubs, onSubmit, onDirty }) {
  // Persisted across a route change and back (e.g. adding a new Vehicle
  // Type mid-wizard opens its own page/modal) — see useDraftState.
  const [step, setStep] = useDraftState('draft:new-vehicle:step', 1);
  const [wizardData, setWizardData] = useDraftState('draft:new-vehicle:data', EMPTY_OBJ);
  const clearNewVehicleDraft = () => {
    clearDraftState('draft:new-vehicle:step');
    clearDraftState('draft:new-vehicle:data');
  };
  // Live-tracks the in-progress Category pick within step 1 (before it's
  // merged into wizardData on "Next") so the Vehicle Type options can
  // filter immediately, without resetting anything else the user has
  // already typed on this step. Re-synced from wizardData wherever `step`
  // actually changes (see setStep call sites below), not via an effect.
  const [domainFilter, setDomainFilter] = useState(wizardData.vehicle_domain ?? '');

  const domain = lookups.categories.find(
    (c) => String(c.category_id) === String(wizardData.category_id)
  )?.domain ?? 'Land';

  // Derived from the actual vehicle types on file, not hardcoded — so a
  // newly added domain (beyond today's Land/Water) just works here too.
  const domainOptions = [...new Set(lookups.categories.map((c) => c.domain).filter(Boolean))].sort();

  const stepFields = {
    1: [
      // Asked first, before the vehicle even has a name — everything else on
      // this step (the plate/registration field's label and pattern, which
      // vehicle types are offered below) depends on Land vs Water, so this
      // has to be answered before those can make sense.
      { label: 'Land or Water Vehicle', name: 'vehicle_domain', options: domainOptions, required: true, type: 'select' },
      { label: 'Vehicle Name', name: 'vehicle_name', required: true, type: 'text' },
      domainFilter === 'Water'
        ? {
            label: plateFieldLabel('Water'), name: 'plate_number', required: true, type: 'text',
            placeholder: 'e.g. HULL-24-01', uppercase: true, maxLength: 10,
          }
        : {
            label: plateFieldLabel('Land'), name: 'plate_number', required: true, type: 'text',
            // NOTE: browsers compile `pattern` with the strict `v` flag, where `\s`
            // inside a character class is invalid — use a literal space instead.
            placeholder: 'e.g. ABC 1234', pattern: '^[A-Za-z]{2,6}[ \\-]?\\d{2,6}[A-Za-z]?$',
            title: 'Enter a valid plate number, e.g. ABC 1234 or ABC-1234', uppercase: true, maxLength: 10,
          },
      {
        label: 'Vehicle Type',
        name: 'category_id',
        options: lookups.categories.filter((c) => c.domain === domainFilter),
        required: true,
        type: 'creatable-select',
        newItemLabel: 'vehicle type',
        catalogEndpoint: '/categories',
        idField: 'category_id',
        nameField: 'category_name',
        valueIsId: true,
        // Pre-fills the add-new-type modal's Domain field to match the
        // domain already picked above, instead of leaving it blank.
        extraFields: [{ name: 'domain', label: 'Domain', options: domainOptions.length ? domainOptions : ['Land', 'Water'], required: true, default: domainFilter || 'Land' }],
      },
    ],
    2: [
      { label: 'Brand', name: 'brand', required: true, type: 'text' },
      { label: 'Model', name: 'model', required: true, type: 'text' },
      { label: 'Year Model', name: 'year_model', required: true, type: 'number' },
      { label: 'Capacity', name: 'capacity', required: true, type: 'quantity', units: capacityUnits(domain) },
      // Optional — without it, the per-vehicle reliability lens' lifetime-
      // cost-vs-value (decommission signal) has nothing to compare against
      // and is just skipped for this vehicle (production-readiness audit
      // finding #7 — same field already existed on the Edit Vehicle form,
      // just never on registration itself).
      { label: 'Acquisition Cost (optional)', name: 'acquisition_cost', type: 'number', placeholder: 'e.g. 850000' },
      { label: 'Vehicle Color', name: 'vehicle_color', required: true, type: 'text' },
      ...vehicleDomainFields(domain),
      ...customFieldInputs(lookups.categories.find((c) => String(c.category_id) === String(wizardData.category_id))),
    ],
    3: [
      { label: 'Vehicle Photo', name: 'photo', accept: 'image/*', type: 'file', compactFile: true },
      {
        label: 'Current Location', name: 'current_location', options: allHubs, required: true, type: 'creatable-select',
        newItemLabel: 'location', catalogEndpoint: '/hubs', idField: 'hub_id', nameField: 'name',
        // A hub needs real coordinates to ever show up on the map, so
        // unlike Vehicle Type's Domain (a plain preset dropdown), these are
        // free-typed numbers with no sensible default to pre-fill.
        extraFields: [
          { name: 'lat', label: 'Latitude', type: 'number', required: true, placeholder: 'e.g. 10.3378' },
          { name: 'lng', label: 'Longitude', type: 'number', required: true, placeholder: 'e.g. 123.9422' },
        ],
        // Shows exactly where the hub is as soon as one is picked, instead
        // of leaving the location as just a name in a dropdown. Rendered
        // inline (inside this field's own cell, right under the select)
        // rather than as a separate full-width row, so it sits directly
        // beneath the dropdown and top-aligns with the photo box beside it
        // instead of leaving a gap where a taller sibling row would go.
        inlineExtra: (vals) => {
          const hub = allHubs.find((h) => h.name === vals.current_location);
          return hub ? (
            <div className="veh-map-wrap" style={{ height: 220 }}>
              <VehicleLocationMap lat={hub.lat} lng={hub.lng} label={hub.name} />
            </div>
          ) : null;
        },
      },
      { label: 'Remarks (optional)', name: 'remarks', type: 'textarea' },
    ],
  };

  const isLastStep = step === 3;

  // Also used by the wizard-step-pill "go back" clicks below, so
  // domainFilter always reflects whatever step 1 last had, whichever way
  // the user navigates back to it.
  const goToStep = (n) => {
    setDomainFilter(wizardData.vehicle_domain ?? '');
    setStep(n);
  };

  const handleStepSubmit = async (values) => {
    const merged = { ...wizardData, ...values };
    if (isLastStep) {
      const ok = await onSubmit(merged);
      if (ok !== false) clearNewVehicleDraft();
    } else {
      setWizardData(merged);
      setStep((s) => s + 1);
    }
  };

  return (
    <ModulePanel description="Register a new vehicle in the fleet — complete all three steps to add it.">
      <div className="wizard-steps" role="list" aria-label="Add vehicle steps">
        {VEHICLE_WIZARD_STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const state = step === n ? 'active' : step > n ? 'done' : 'upcoming';
          if (state === 'done') {
            return (
              <button
                key={label}
                type="button"
                className="wizard-step-pill is-done"
                role="listitem"
                onClick={() => goToStep(n)}
                title={`Go back to ${label}`}
              >
                <Icon name="checkCircle" size={16} />
                {label}
              </button>
            );
          }
          return (
            <div key={label} className={`wizard-step-pill is-${state}`} role="listitem">
              <Icon name={VEHICLE_WIZARD_STEP_ICONS[i]} size={16} />
              {label}
            </div>
          );
        })}
      </div>
      <div className={`form-grid-2col${step === 3 ? ' wizard-photo-location-grid' : ''}`}>
        <SmartForm
          fields={stepFields[step]}
          initialValues={wizardData}
          key={step}
          cancelLabel={step === 1 ? 'Cancel' : 'Back'}
          onCancel={step === 1 ? () => { clearNewVehicleDraft(); onBack(); } : () => goToStep(step - 1)}
          onSubmit={handleStepSubmit}
          onValuesChange={(vals) => { setDomainFilter(vals.vehicle_domain ?? ''); onDirty?.(); }}
          submitLabel={isLastStep ? 'Add Vehicle' : 'Next'}
          title=""
        />
      </div>
    </ModulePanel>
  );
}

// "Import Vehicle Data" wizard: template -> upload -> preview (nothing is saved
// yet) -> confirm -> summary. The server re-reads and re-validates the stored
// file on confirm, so this only ever names which preview to confirm.
export function VehicleImportModal({ open, onClose, onImported }) {
  const [step, setStep] = useState('upload'); // upload | preview | done
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  if (!open) return null;

  const close = () => {
    setStep('upload'); setFile(null); setError(''); setResult(null); setBusy(false);
    onClose();
  };

  const saveBlob = async (path, params, filename) => {
    const response = await api.get(path, { params, responseType: 'blob' });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const guard = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); } catch (err) {
      setError(err.response?.data?.message || err.response?.data?.errors?.file?.[0] || 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  const upload = () => guard(async () => {
    const body = new FormData();
    body.append('file', file);
    const res = await api.post('/vehicle-imports', body, { headers: { 'Content-Type': 'multipart/form-data' } });
    setResult(res.data); setStep('preview');
  });

  const confirm = () => guard(async () => {
    const res = await api.post(`/vehicle-imports/${result.id}/commit`);
    setResult(res.data); setStep('done');
    await onImported?.();
  });

  const findings = result?.findings ?? [];

  return (
    <FormModal open title="Import Vehicle Data" onClose={close} wide>
      {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}

      {step === 'upload' && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}>1. Download the template, fill in one vehicle per row, then upload it as .xlsx or .csv (up to 500 rows, 2 MB). You will review everything before anything is saved.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob('/vehicle-imports/template', { format: 'xlsx' }, 'vehicle-import-template.xlsx'))}>Download Excel template</button>
            <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob('/vehicle-imports/template', { format: 'csv' }, 'vehicle-import-template.csv'))}>Download CSV template</button>
          </div>
          <input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="form-actions">
            <button type="button" className="ghost-button" onClick={close}>Cancel</button>
            <button type="button" className="primary-button" disabled={!file || busy} onClick={upload}>{busy ? 'Checking…' : 'Upload & Preview'}</button>
          </div>
        </div>
      )}

      {step === 'preview' && result && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}><strong>{result.file_name}</strong> — {result.total_rows} rows: <strong>{result.valid_rows} valid</strong>, <strong>{result.error_rows} with errors</strong>, <strong>{result.warning_rows} with warnings</strong>.</p>
          {findings.length > 0 && (
            <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border, #d0d7e2)', borderRadius: 8 }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead><tr><th align="left">Row</th><th align="left">Field</th><th align="left">Issue</th></tr></thead>
                <tbody>
                  {findings.map((f, i) => (
                    <tr key={i} style={{ color: f.level === 'error' ? '#b42318' : '#b54708' }}>
                      <td>{f.row}</td><td>{f.field.replace(/_/g, ' ')}</td><td>{f.level === 'warning' ? 'Warning: ' : ''}{f.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ margin: 0, fontSize: 13 }}>Rows with errors will be skipped. Only the {result.valid_rows} valid row(s) are imported.</p>
          <div className="form-actions">
            {result.error_rows > 0 && (
              <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob(`/vehicle-imports/${result.id}/errors`, {}, 'vehicle-import-errors.csv'))}>Download error report</button>
            )}
            <button type="button" className="ghost-button" onClick={() => { setStep('upload'); setResult(null); }}>Back</button>
            <button type="button" className="success-button" disabled={busy || result.valid_rows === 0} onClick={confirm}>{busy ? 'Importing…' : `Import ${result.valid_rows} vehicle(s)`}</button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0 }}>Import complete: <strong>{result.imported_rows} vehicle(s) added</strong>, {result.failed_rows} skipped, out of {result.total_rows} rows.</p>
          <div className="form-actions">
            {result.failed_rows > 0 && (
              <button type="button" className="ghost-button" onClick={() => guard(() => saveBlob(`/vehicle-imports/${result.id}/errors`, {}, 'vehicle-import-errors.csv'))}>Download error report</button>
            )}
            <button type="button" className="primary-button" onClick={close}>Done</button>
          </div>
        </div>
      )}
    </FormModal>
  );
}

export function CategoryFieldsManager({ categoryId, onChanged }) {
  const [fields, setFields] = useState([]);
  const [draft, setDraft] = useState(BLANK_FIELD_DRAFT);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get(`/categories/${categoryId}/fields`);
    setFields(res.data);
  }, [categoryId]);

  useEffect(() => {
    let cancelled = false;
    api.get(`/categories/${categoryId}/fields`).then((res) => { if (!cancelled) setFields(res.data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [categoryId]);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); await onChanged?.(); } catch (err) {
      setError(err.response?.data?.message || 'Could not save the field.');
    } finally { setBusy(false); }
  };

  const toPayload = (d) => ({
    label: d.label.trim(),
    field_type: d.field_type,
    is_required: d.is_required,
    unit: d.unit?.trim() || null,
    options: d.field_type === 'dropdown' ? String(d.options).split(',').map((o) => o.trim()).filter(Boolean) : null,
  });

  // UI audit §14 — two fields with the same label would render as
  // indistinguishable inputs on the vehicle form; catch it before saving.
  const duplicateLabel = draft.label.trim() && fields.some((f) => f.field_id !== editingId && f.label.trim().toLowerCase() === draft.label.trim().toLowerCase());

  const save = () => run(async () => {
    if (editingId) await api.put(`/category-fields/${editingId}`, toPayload(draft));
    else await api.post(`/categories/${categoryId}/fields`, toPayload(draft));
    setDraft(BLANK_FIELD_DRAFT); setEditingId(null);
  });

  const move = (index, delta) => run(async () => {
    const a = fields[index]; const b = fields[index + delta];
    if (!b) return;
    // Renumber both neighbours so equal sort_orders can't leave them stuck.
    await api.put(`/category-fields/${a.field_id}`, { label: a.label, sort_order: index + delta });
    await api.put(`/category-fields/${b.field_id}`, { label: b.label, sort_order: index });
  });

  const startEdit = (f) => {
    setEditingId(f.field_id);
    setDraft({ label: f.label, field_type: f.field_type, is_required: f.is_required, unit: f.unit ?? '', options: (f.options ?? []).join(', ') });
  };

  return (
    <section className="veh-card" style={{ marginTop: 16 }}>
      <div className="veh-card-head"><Icon name="list" size={16} /><h4>Custom Fields</h4></div>
      <div style={{ padding: '0 20px 20px', display: 'grid', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13 }}>Extra details asked for whenever a vehicle of this type is added or edited. Archived fields stop being asked, but existing values are kept.</p>
        {error && <div className="notice error">{error}</div>}
        {fields.length === 0 && <p style={{ margin: 0, opacity: 0.7 }}>No custom fields yet.</p>}
        {fields.map((f, i) => (
          <div key={f.field_id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', opacity: f.is_active ? 1 : 0.55 }}>
            <strong style={{ flex: '1 1 200px' }}>{f.label}{f.is_required ? ' *' : ''}</strong>
            <span style={{ fontSize: 13 }}>{CUSTOM_FIELD_TYPES.find((t) => t.value === f.field_type)?.label}{f.unit ? ` · ${f.unit}` : ''}{f.options?.length ? ` · ${f.options.join(', ')}` : ''}{f.is_active ? '' : ' · archived'}</span>
            <button type="button" className="ghost-button" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${f.label} up`} title="Move up">▲</button>
            <button type="button" className="ghost-button" disabled={busy || i === fields.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${f.label} down`} title="Move down">▼</button>
            <button type="button" className="ghost-button" disabled={busy} onClick={() => startEdit(f)} aria-label={`Edit ${f.label}`}>Edit</button>
            <button type="button" className="ghost-button" disabled={busy} onClick={() => run(() => api.put(`/category-fields/${f.field_id}`, { label: f.label, is_active: !f.is_active }))}>{f.is_active ? 'Archive' : 'Restore'}</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', borderTop: '1px solid var(--border, #d0d7e2)', paddingTop: 12 }}>
          <label style={{ flex: '1 1 180px' }}>Field name
            <input type="text" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. Tank Capacity" aria-invalid={duplicateLabel || undefined} aria-describedby={duplicateLabel ? 'category-field-dup' : undefined} />
            {duplicateLabel && <small id="category-field-dup" className="field-error" role="alert">This type already has a field called “{draft.label.trim()}”.</small>}
          </label>
          <label>Type
            <select value={draft.field_type} disabled={!!editingId} onChange={(e) => setDraft({ ...draft, field_type: e.target.value })}>
              {CUSTOM_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          {(draft.field_type === 'number' || draft.field_type === 'text') && (
            <label style={{ width: 90 }}>Unit
              <input type="text" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} placeholder="L, kg…" />
            </label>
          )}
          {draft.field_type === 'dropdown' && (
            <label style={{ flex: '1 1 220px' }}>Options (comma-separated)
              <input type="text" value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })} placeholder="Front, Rear" />
            </label>
          )}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.is_required} onChange={(e) => setDraft({ ...draft, is_required: e.target.checked })} /> Required
          </label>
          <button type="button" className="primary-button" disabled={busy || !draft.label.trim() || duplicateLabel} onClick={save}>{editingId ? 'Update Field' : 'Add Field'}</button>
          {editingId && <button type="button" className="ghost-button" onClick={() => { setEditingId(null); setDraft(BLANK_FIELD_DRAFT); }}>Cancel</button>}
        </div>
      </div>
    </section>
  );
}
