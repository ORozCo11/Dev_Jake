import { useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import useDepsChanged from '../../hooks/useDepsChanged';
import api from '../../api/axios';
import { VehicleLocationMap } from '../../components/lazy';
import { ModulePanel, StatusBadge } from '../components/ui';
import { SmartForm } from './SmartForm';
import { useDraftState } from '../hooks/useDraftState';
import { capacityUnits, plateFieldLabel, vehicleDomainFields, vehicleIconName } from '../lib/fields';
import { clearDraftState, formSummaryValue } from '../lib/formHelpers';
import { EMPTY_ARR, EMPTY_OBJ, resolvePhotoUrl } from '../lib/format';

// #7 — non-blocking "this vehicle already has open items" warning, shown on the
// Report Issue form (and reusable for tickets). Lets a second reporter notice a
// duplicate before opening another record. Never blocks — two genuinely
// different problems can be open at once.
export function OpenItemsWarning({ kind, rows, basePath }) {
  return (
    <div className="info-callout" style={{ marginBottom: 16, background: 'rgba(245, 158, 11, 0.1)', borderColor: '#f59e0b' }}>
      <span style={{ marginRight: 8, color: '#b45309', display: 'inline-flex', flexShrink: 0 }}><Icon name="alert" size={16} /></span>
      <div style={{ flex: 1 }}>
        <p className="module-description" style={{ color: '#b45309', margin: '0 0 6px', fontWeight: 600 }}>
          This vehicle already has {rows.length} open {kind}{rows.length !== 1 ? 's' : ''} — check it isn&apos;t the same problem before adding another:
        </p>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {rows.map((r) => {
            const id = r.issue_report_id ?? r.ticket_id;
            const label = r.issue_report_id
              ? `#${r.issue_report_id} ${r.issue_type} (${r.severity_level}) — ${r.status}`
              : `#${r.ticket_id} ${r.ticket_title} — ${r.status}`;
            const href = basePath ? `${basePath}/${r.issue_report_id ? 'issues' : 'tickets'}/${id}` : null;
            return (
              <li key={id} style={{ fontSize: '0.85rem', color: '#92400e', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>{label}</span>
                {/* Opens in a new tab — same reasoning as the ticket duplicate
                    warning: whoever's filling this form shouldn't lose their
                    in-progress entry just to go check an existing record. */}
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.8rem', fontWeight: 600, color: '#b45309', textDecoration: 'underline', whiteSpace: 'nowrap' }}
                  >
                    View <Icon name="link" size={11} style={{ verticalAlign: 'middle' }} />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// Generic single-form page — used for every simple create/edit flow (Vehicle
// Types, Maintenance Schedules, Condition Checks, Issue Reports) that doesn't
// need its own multi-tab profile like vehicles/tickets do.
// When `contextVehicles` is provided, the page renders Realcore-style: the form
// fields sit in a card on the right, and the left side live-previews the
// selected vehicle (photo, info, location map) as the user picks one.
export function FormPage({ description, onBack, fields, initialValues, onSubmit, submitLabel, contextVehicles, hubs, warnEndpoint, warnRender, reviewStep = false, wrapperClassName, formTitle = '', onDirty, showDomainPreview = false, categoryVehicleCount = null }) {
  // Scoped to this exact route (new-X vs. editing record #N are different
  // paths) so a form's in-progress values survive clicking a "view" link
  // (e.g. the selected vehicle/custodian's name) and coming Back, instead of
  // resetting because the page component fully unmounted and remounted —
  // see useDraftState.
  const location = useLocation();
  const draftKey = `draft:form:${location.pathname}`;
  const [liveValues, setLiveValues] = useDraftState(draftKey, initialValues ?? EMPTY_OBJ);
  // SmartForm keeps its own internal `values`, seeded once from whatever
  // `initialValues` prop it's given — passing the plain `initialValues` prop
  // straight through (as before) would silently discard the restored draft,
  // since SmartForm would seed itself from the pre-draft original instead.
  // This snapshot starts as the restored `liveValues` but, unlike liveValues,
  // does NOT track every keystroke (only the reset effect below updates it),
  // so it stays a stable reference SmartForm won't re-sync against mid-typing.
  const [smartFormSeed, setSmartFormSeed] = useState(() => liveValues);
  const [warnRowsResult, setWarnRows] = useState([]);
  // Opt-in two-step flow (Maintenance Records today): fill the fields, hit
  // Next, then review everything on its own full-width step before it
  // actually saves — instead of a live summary sidebar fighting the form for
  // space the whole time it's being filled in. Every other FormPage caller
  // leaves reviewStep unset and keeps the original single-step behavior.
  const [step, setStep] = useState(1);
  const [confirming, setConfirming] = useState(false);

  // Not on mount (that would immediately overwrite a restored draft with the
  // plain initialValues) — but resets on every later change, e.g. once
  // `initialValues` itself finishes loading in from the server.
  if (useDepsChanged([initialValues])) {
    setLiveValues(initialValues ?? EMPTY_OBJ);
    setSmartFormSeed(initialValues ?? EMPTY_OBJ);
    setStep(1);
  }

  const hasContext = Boolean(contextVehicles?.length);
  const vehicle = hasContext
    ? contextVehicles.find((v) => String(v.vehicle_id) === String(liveValues?.vehicle_id))
    : null;
  const hub = vehicle ? (hubs ?? []).find((h) => h.name === vehicle.current_location) : null;

  // #7 — when a warn endpoint is provided (e.g. open issues on this vehicle),
  // fetch it as the vehicle is picked so the form can show a duplicate warning.
  const warnVehicleId = liveValues?.vehicle_id ?? null;
  const warnRows = warnEndpoint && warnVehicleId ? warnRowsResult : EMPTY_ARR;
  useEffect(() => {
    if (!warnEndpoint || !warnVehicleId) return undefined;
    let cancelled = false;
    api.get(warnEndpoint(warnVehicleId))
      .then((r) => { if (!cancelled) setWarnRows(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (!cancelled) setWarnRows([]); });
    return () => { cancelled = true; };
  }, [warnEndpoint, warnVehicleId]);

  // `fields` may be a function of the live values so a form can grow extra
  // fields in response to what the user picked (e.g. "+ Add New Issue").
  const resolvedFields = typeof fields === 'function' ? fields(liveValues) : fields;

  const handleReviewConfirm = async () => {
    setConfirming(true);
    try {
      const ok = await onSubmit(liveValues);
      if (ok !== false) clearDraftState(draftKey);
    } finally {
      setConfirming(false);
    }
  };

  // Reused on its own in the plain sidebar layout, and folded into the
  // review step (together with the field summary) when reviewStep is on —
  // "put this together with the summary in the next section" instead of it
  // sitting in a separate persistent side panel throughout.
  const vehicleInfoCard = vehicle ? (
    <section className="veh-card">
      <div className="veh-card-head"><Icon name={vehicleIconName(vehicle.category?.domain)} size={16} /><h4>Selected Vehicle</h4></div>
      {vehicle.photo_url && (
        <div className="form-context-photo">
          <img src={resolvePhotoUrl(vehicle.photo_url)} alt={vehicle.vehicle_name} />
        </div>
      )}
      <dl className="veh-kv">
        <div><dt>Vehicle</dt><dd>{vehicle.vehicle_name}</dd></div>
        <div><dt>{plateFieldLabel(vehicle.category?.domain)}</dt><dd>{vehicle.plate_number}</dd></div>
        <div><dt>Type</dt><dd>{vehicle.category?.category_name ?? 'Unassigned'}</dd></div>
        <div><dt>Brand / Model</dt><dd>{`${vehicle.brand ?? '-'} ${vehicle.model ?? ''}`.trim() || '-'}</dd></div>
        <div><dt>Status</dt><dd><StatusBadge value={vehicle.status} /></dd></div>
        <div><dt>Condition</dt><dd><StatusBadge value={vehicle.condition} /></dd></div>
      </dl>
    </section>
  ) : null;

  const form = reviewStep && step === 2 ? (
    <div className="form-review-step">
      <h3 className="form-review-title">Review before saving</h3>
      {vehicleInfoCard}
      <dl className="veh-kv form-review-grid">
        {resolvedFields.filter((f) => f.name !== 'vehicle_id' && f.type !== 'file').map((f) => {
          const val = formSummaryValue(f, liveValues?.[f.name]);
          return (
            <div key={f.name}>
              <dt>{f.label}</dt>
              <dd className={val ? 'summary-val' : 'summary-empty'}>{val ?? '—'}</dd>
            </div>
          );
        })}
      </dl>
      <div className="form-review-actions">
        <button type="button" className="ghost-button" onClick={() => setStep(1)} disabled={confirming}>Back</button>
        <button type="button" className="primary-button" onClick={handleReviewConfirm} disabled={confirming}>
          {confirming ? 'Saving…' : `Confirm & ${submitLabel}`}
        </button>
      </div>
    </div>
  ) : (
    <>
      {warnRender && warnRows.length > 0 ? warnRender(warnRows) : null}
      <SmartForm
        fields={resolvedFields}
        initialValues={smartFormSeed}
        onCancel={() => { clearDraftState(draftKey); onBack(); }}
        onSubmit={reviewStep ? (payload) => { setLiveValues(payload); setStep(2); } : async (payload) => {
          const ok = await onSubmit(payload);
          if (ok !== false) clearDraftState(draftKey);
          return ok;
        }}
        onValuesChange={(vals) => { setLiveValues(vals); onDirty?.(); }}
        submitLabel={reviewStep ? 'Next' : submitLabel}
        title={formTitle}
      />
    </>
  );

  // reviewStep forms skip the persistent side panel entirely — step 1 gets
  // the form full-width (no vehicle card competing for space while typing),
  // and step 2 (above) folds the vehicle card back in alongside the summary.
  const useSideLayout = (hasContext || showDomainPreview) && !reviewStep;

  // Live preview of what a vehicle's own Add/Edit form will ask for once
  // it's assigned this Vehicle Type — so picking Land vs Water here shows
  // its consequence immediately, instead of only being discovered later
  // when actually adding a vehicle of this type.
  const previewDomain = liveValues?.domain || 'Land';
  const domainPreviewFields = [
    { label: plateFieldLabel(previewDomain), note: previewDomain === 'Water' ? 'registration / hull number' : 'plate number' },
    { label: 'Capacity', note: `in ${capacityUnits(previewDomain).join(', ')}` },
    ...vehicleDomainFields(previewDomain).map((f) => ({ label: f.label, note: f.options ? f.options.slice(0, 3).join(', ') + (f.options.length > 3 ? '…' : '') : 'free text' })),
  ];

  return (
    <ModulePanel description={description}>
      {useSideLayout ? (
        <div className="form-context-layout">
          <div className="form-context-side">
            {showDomainPreview ? (
              <section className="veh-card">
                <div className="veh-card-head"><Icon name={vehicleIconName(previewDomain)} size={16} /><h4>{previewDomain} Vehicle Fields</h4></div>
                <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.8rem' }}>
                  A vehicle assigned this type will additionally ask for:
                </p>
                <dl className="veh-kv">
                  {domainPreviewFields.map((f) => (
                    <div key={f.label}><dt>{f.label}</dt><dd>{f.note}</dd></div>
                  ))}
                </dl>
              </section>
            ) : null}
            {/* Edit only — so a rename/domain change doesn't blindly affect
                a whole fleet without the Admin realizing it first. */}
            {showDomainPreview && categoryVehicleCount != null && (
              <section className="veh-card">
                <div className="veh-card-head"><Icon name="vehicle" size={16} /><h4>Vehicles Using This Type</h4></div>
                <p style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>{categoryVehicleCount}</p>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.8rem' }}>
                  {categoryVehicleCount ? 'Renaming or switching domain affects every one of these.' : 'No vehicles assigned this type yet.'}
                </p>
              </section>
            )}
            {showDomainPreview ? null : vehicle ? (
              vehicleInfoCard
            ) : (
              <section className="veh-card form-context-empty">
                <Icon name="vehicle" size={30} />
                <p>Select a vehicle in the form and its photo, details, and location will show here.</p>
              </section>
            )}

            {vehicle && !showDomainPreview && (
              <section className="veh-card">
                <div className="veh-card-head"><Icon name="clipboard" size={16} /><h4>Entry Summary</h4></div>
                <dl className="veh-kv">
                  {resolvedFields.filter((f) => f.name !== 'vehicle_id' && f.type !== 'file').map((f) => {
                    const val = formSummaryValue(f, liveValues?.[f.name]);
                    return (
                      <div key={f.name}>
                        <dt>{f.label}</dt>
                        <dd className={val ? 'summary-val' : 'summary-empty'}>{val ?? '—'}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            )}

          </div>
          <div className="form-context-form-col">
            <div className={`form-grid-2col form-context-form${wrapperClassName ? ` ${wrapperClassName}` : ''}`}>{form}</div>
            {/* Stacked below the form fields, inside the same column, so it
                fills the free space the form's shorter height leaves behind
                instead of floating full-width beneath both columns. */}
            {vehicle && !showDomainPreview && (
              <section className="veh-card form-context-map-inline">
                <div className="veh-card-head"><Icon name="pin" size={16} /><h4>{vehicle.current_location ?? 'Location unknown'}</h4></div>
                <div className="veh-map-wrap form-context-map-expanded">
                  <VehicleLocationMap lat={hub?.lat} lng={hub?.lng} label={vehicle.current_location} />
                </div>
              </section>
            )}
          </div>
        </div>
      ) : (
        <div className={`form-grid-2col${wrapperClassName ? ` ${wrapperClassName}` : ''}`}>{form}</div>
      )}
    </ModulePanel>
  );
}
