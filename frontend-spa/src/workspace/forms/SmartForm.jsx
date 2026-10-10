import { Fragment, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useDepsChanged from '../../hooks/useDepsChanged';
import Icon from '../../components/Icon';
import { CatalogOrOtherField, CreatableSelect, NewIssueModalField, SelectOrOtherField } from '../components/inputs';
import { isFile } from '../lib/data';
import { CATALOG_OTHER_VALUE, NEW_ISSUE_OPTION, collectFieldErrors, groupFields, splitQuantityValue, valuesFromFields } from '../lib/formHelpers';
import { EMPTY_OBJ, resolvePhotoUrl } from '../lib/format';

export function SmartForm({ fields, initialValues = EMPTY_OBJ, onCancel, cancelLabel = 'Cancel', onSubmit, submitLabel, title, onValuesChange }) {
  const [values, setValues] = useState(() => valuesFromFields(fields, initialValues));
  const [submitting, setSubmitting] = useState(false);
  // Per-field show/hide toggle for password inputs — keyed by field name so
  // e.g. Old/New/Confirm Password on the same form toggle independently.
  const [visiblePasswords, setVisiblePasswords] = useState({});
  // Errors from the last submit attempt, keyed by field name. Only the ones
  // that are STILL wrong are shown (recomputed below), so a message vanishes
  // as soon as its field is fixed, whichever input path changed it.
  const [submittedErrors, setSubmittedErrors] = useState(null);
  const formRef = useRef(null);
  const formId = useId();

  // A new initialValues reference means a different record (or one that just
  // finished loading) — re-seed. Only keyed on initialValues: `fields` is
  // often rebuilt every render and must not wipe what the user typed.
  if (useDepsChanged([initialValues])) {
    setValues(valuesFromFields(fields, initialValues));
  }

  const handleChange = (event) => {
    const { name, type, files, value } = event.target;
    const field = fields.find((f) => f.name === name);
    let nextValue = field?.uppercase ? value.toUpperCase() : value;
    if (field?.type === 'tel' && name === 'phone') {
      nextValue = value.replace(/[^0-9]/g, '').slice(0, 10);
    }
    // 'multi-file' fields render their own dropzone/input with a dedicated
    // onChange (see the field renderer below) — this generic handler only
    // ever sees single-file and non-file fields.
    const finalValue = type === 'file' ? files[0] : nextValue;
    const next = { ...values, [name]: finalValue };
    setValues(next);
    onValuesChange?.(next);
  };

  const stillInvalid = submittedErrors ? new Set(collectFieldErrors(fields, values).map((e) => e.name)) : null;
  const fieldErrors = submittedErrors
    ? Object.fromEntries(Object.entries(submittedErrors).filter(([name]) => stillInvalid.has(name)))
    : {};
  const errorEntries = Object.entries(fieldErrors);
  const errorId = (name) => `${formId}-${name}-error`;
  const errorProps = (field) => (fieldErrors[field.name]
    ? { 'aria-invalid': 'true', 'aria-describedby': errorId(field.name) }
    : {});
  const focusField = (name) => {
    const form = formRef.current;
    if (!form) return;
    const el = form.querySelector(`[name="${CSS.escape(name)}"]`)
      ?? form.querySelector(`[aria-describedby="${CSS.escape(errorId(name))}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const errors = collectFieldErrors(fields, values);
    if (errors.length) {
      const byName = {};
      errors.forEach((e) => { if (!byName[e.name]) byName[e.name] = e.message; });
      setSubmittedErrors(byName);
      // Wait for the error props to render, then take the user to the first problem.
      requestAnimationFrame(() => focusField(errors[0].name));
      return;
    }
    setSubmittedErrors(null);

    setSubmitting(true);
    try {
      // 'list' fields edit as an array of rows; flatten back to the
      // newline-joined string the backend column actually stores.
      // 'confirmOf' fields are sent through as-is (not stripped) — some
      // backends (e.g. the self-service password change) rely on Laravel's
      // `confirmed` rule convention, which expects the `{field}_confirmation`
      // value to actually be present in the request; others just ignore it.
      const payload = { ...values };
      fields.forEach((field) => {
        if (field.type === 'list') {
          payload[field.name] = (Array.isArray(payload[field.name]) ? payload[field.name] : [])
            .map((row) => row.trim())
            .filter(Boolean)
            .join('\n');
        }
      });
      // Phase B4 — a 'catalog-or-other' field's typed note never has a
      // backend column of its own (Custodian/Maintenance Personnel can no
      // longer mint a new catalog value, so "Other" + a note stands in for
      // it). Runs as its own pass, after the 'list' join above, so folding
      // the note into another field this same form owns (e.g. a textarea
      // that started as an array) appends to the already-joined string, not
      // the raw array.
      fields.forEach((field) => {
        if (field.type !== 'catalog-or-other') return;
        const noteKey = `${field.name}__other_note`;
        const note = String(payload[noteKey] ?? '').trim();
        delete payload[noteKey];
        if (payload[field.name] === CATALOG_OTHER_VALUE && note && field.otherNoteField) {
          const prefixed = `Other (specified type): ${note}`;
          const existing = String(payload[field.otherNoteField] ?? '').trim();
          payload[field.otherNoteField] = existing ? `${existing}\n${prefixed}` : prefixed;
        }
      });
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form ref={formRef} className="smart-form" onSubmit={handleSubmit} noValidate autoComplete="off">
      {errorEntries.length > 0 && (
        <div className="form-error-summary" role="alert" style={{ gridColumn: '1 / -1' }}>
          <p className="form-error-summary-title">
            <Icon name="alert" size={16} />
            {errorEntries.length === 1 ? 'Fix 1 field before saving:' : `Fix ${errorEntries.length} fields before saving:`}
          </p>
          <ul>
            {errorEntries.map(([name, message]) => (
              <li key={name}>
                <button type="button" className="link-button" onClick={() => focusField(name)}>{message}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {submitting && createPortal(
        <div className="loading-overlay">
          <div className="loading-overlay-card">
            <Icon name="gear" size={34} className="loading-overlay-gear" filled />
            <span>Loading…</span>
          </div>
        </div>,
        document.body
      )}
      <h3>{title}</h3>
      {(() => {
        const renderField = (field) => {
        const quantity = field.type === 'quantity' ? splitQuantityValue(values[field.name], field.units) : null;
        // Drives the floating-label float-up: a value counts even for an
        // array (checkboxes/list), so those fields' captions float too
        // once at least one row/option is filled in.
        const rawFieldValue = values[field.name];
        const fieldHasValue = Array.isArray(rawFieldValue)
          ? rawFieldValue.some((v) => String(v ?? '').trim() !== '')
          : rawFieldValue !== undefined && rawFieldValue !== null && String(rawFieldValue).trim() !== '';
        return (
        <Fragment key={field.name}>
        {field.sectionHeading ? <div className="smart-form-section-heading" role="heading" aria-level="4"><strong>{field.sectionHeading}</strong>{field.sectionHint ? <span>{field.sectionHint}</span> : null}</div> : null}
        <label
          className={[field.compactFile ? 'file-inline' : null, fieldHasValue ? 'has-value' : null].filter(Boolean).join(' ') || undefined}
          style={field.fullWidth ? { gridColumn: '1 / -1' } : undefined}
        >
          <span style={field.action ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } : undefined}>
            <span>{field.label}{field.required ? <span className="required-asterisk"> *</span> : null}</span>
            {field.action && (
              <button
                type="button"
                className="link-button"
                onClick={field.action.onClick}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline', fontWeight: 600, fontSize: '0.78rem', whiteSpace: 'nowrap' }}
              >
                {field.action.label}
              </button>
            )}
          </span>
          {fieldErrors[field.name] && (
            <small className="field-error" id={errorId(field.name)}>
              <Icon name="alert" size={12} /> {fieldErrors[field.name]}
            </small>
          )}
          {field.type === 'quantity' ? (
            <div className="quantity-field">
              <input
                min="0"
                onChange={(e) => setValues((current) => ({
                  ...current,
                  [field.name]: `${e.target.value} ${quantity.unit}`.trim(),
                }))}
                placeholder={field.placeholder}
                required={field.required} {...errorProps(field)}
                step="any"
                type="number"
                value={quantity.amount}
              />
              <select
                onChange={(e) => setValues((current) => ({
                  ...current,
                  [field.name]: `${quantity.amount} ${e.target.value}`.trim(),
                }))}
                value={quantity.unit}
              >
                {field.units.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          ) : null}
          {field.type === 'textarea' ? (
            <textarea
              name={field.name}
              onChange={handleChange}
              placeholder={field.placeholder ?? field.label}
              required={field.required} {...errorProps(field)}
              rows={field.rows ?? 3}
              value={values[field.name] ?? ''}
            />
          ) : null}
          {field.type === 'select' ? (
            <select
              name={field.name}
              onChange={handleChange}
              required={field.required} {...errorProps(field)}
              value={values[field.name] ?? ''}
            >
              {/* Blank rather than "Select" — at rest the floating label
                  sits centered over the field like a placeholder, so a
                  visible option here would double up with it. */}
              <option value="">{' '}</option>
              {field.options.map((option, i) => (
                <option
                  key={option?.value != null ? option.value : `opt-${i}`}
                  value={option?.value ?? option ?? ''}
                  style={option?.value === NEW_ISSUE_OPTION.value ? { color: '#2563eb', fontWeight: 700 } : undefined}
                >
                  {option?.label ?? option}
                </option>
              ))}
            </select>
          ) : null}
          {field.type === 'select-or-other' ? (
            <SelectOrOtherField
              field={field}
              value={values[field.name]}
              onChange={(v) => {
                const next = { ...values, [field.name]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
            />
          ) : null}
          {field.type === 'creatable-select' ? (
            <CreatableSelect
              value={values[field.name] ?? ''}
              onChange={(v) => {
                const next = { ...values, [field.name]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
              options={field.options ?? []}
              required={field.required} {...errorProps(field)}
              newItemLabel={field.newItemLabel}
              catalogEndpoint={field.catalogEndpoint}
              idField={field.idField}
              nameField={field.nameField}
              valueIsId={field.valueIsId}
              extraFields={field.extraFields}
            />
          ) : null}
          {field.type === 'catalog-or-other' ? (
            <CatalogOrOtherField
              value={values[field.name] ?? ''}
              onChange={(v) => {
                const next = { ...values, [field.name]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
              note={values[`${field.name}__other_note`] ?? ''}
              onNoteChange={(v) => {
                const next = { ...values, [`${field.name}__other_note`]: v };
                setValues(next);
                onValuesChange?.(next);
              }}
              options={field.options ?? []}
              required={field.required} {...errorProps(field)}
              placeholder={field.placeholder}
              otherNoteLabel={field.otherNoteLabel}
            />
          ) : null}
          {field.type === 'new-issue-modal' ? (
            <NewIssueModalField
              value={{ new_issue_type: values.new_issue_type }}
              onChange={(patch) => {
                const next = { ...values, ...patch };
                setValues(next);
                onValuesChange?.(next);
              }}
              issueTypeOptions={field.issueTypeOptions ?? []}
            />
          ) : null}
          {field.type === 'checkboxes' ? (
            <div className="checkbox-group" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(() => {
                const groupHasSelection = Array.isArray(values[field.name]) && values[field.name].length > 0;
                // A native checkbox's `required` only ever means "this exact
                // box must be checked" — there's no built-in "at least one of
                // these" semantic. Marking every box required only while the
                // group is empty gets that behavior for free: checking any
                // one of them clears `required` from the whole group on the
                // very next render, so the browser's own validation bubble
                // (same one every other required field already uses) fires
                // correctly instead of a confusing raw backend error surfacing
                // after a round-trip.
                return field.options.map((option) => {
                  const val = option?.value ?? option;
                  const label = option?.label ?? option;
                  const selected = Array.isArray(values[field.name]) && values[field.name].includes(val);
                  return (
                    <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, cursor: 'pointer', margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={selected}
                        required={field.required && !groupHasSelection}
                        title={field.required ? 'Select at least one.' : undefined}
                        onChange={() => setValues((current) => {
                          const list = Array.isArray(current[field.name]) ? current[field.name] : [];
                          const next = selected ? list.filter((r) => r !== val) : [...list, val];
                          const merged = { ...current, [field.name]: next };
                          onValuesChange?.(merged);
                          return merged;
                        })}
                        style={{ width: 'auto' }}
                      />
                      <span style={{ margin: 0 }}>{label}</span>
                    </label>
                  );
                });
              })()}
            </div>
          ) : null}
          {field.type === 'list' ? (
            <div className="list-field">
              {(Array.isArray(values[field.name]) ? values[field.name] : ['']).map((row, index) => {
                const rows = Array.isArray(values[field.name]) ? values[field.name] : [''];
                return (
                  <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
                    <span className="muted" style={{ flex: '0 0 20px', textAlign: 'right' }}>{index + 1}.</span>
                    <input
                      type="text"
                      placeholder={field.placeholder}
                      value={row}
                      required={field.required && index === 0}
                      onChange={(e) => setValues((current) => {
                        const list = [...(Array.isArray(current[field.name]) ? current[field.name] : [''])];
                        list[index] = e.target.value;
                        const merged = { ...current, [field.name]: list };
                        onValuesChange?.(merged);
                        return merged;
                      })}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="btn-delete-action icon-btn"
                      onClick={() => setValues((current) => {
                        const list = (Array.isArray(current[field.name]) ? current[field.name] : ['']).filter((_, i) => i !== index);
                        const merged = { ...current, [field.name]: list.length ? list : [''] };
                        onValuesChange?.(merged);
                        return merged;
                      })}
                      disabled={rows.length === 1}
                      title={`Remove ${field.removeLabel ?? 'issue'}`}
                      aria-label={`Remove ${field.removeLabel ?? 'issue'}`}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="primary-button"
                onClick={() => setValues((current) => {
                  const merged = { ...current, [field.name]: [...(Array.isArray(current[field.name]) ? current[field.name] : ['']), ''] };
                  onValuesChange?.(merged);
                  return merged;
                })}
              >
                <Icon name="plus" size={14} /> {field.addLabel ?? 'Add another issue'}
              </button>
            </div>
          ) : null}
          {field.type === 'password' ? (
            <div className="password-field">
              <input
                autoComplete="new-password"
                name={field.name}
                onChange={handleChange}
                placeholder={field.placeholder ?? field.label}
                required={field.required} {...errorProps(field)}
                title={field.title}
                type={visiblePasswords[field.name] ? 'text' : 'password'}
                value={values[field.name] ?? ''}
              />
              <button
                type="button"
                className="password-field-toggle"
                onClick={() => setVisiblePasswords((current) => ({ ...current, [field.name]: !current[field.name] }))}
                title={visiblePasswords[field.name] ? 'Hide password' : 'Show password'}
                aria-label={visiblePasswords[field.name] ? 'Hide password' : 'Show password'}
              >
                <Icon name={visiblePasswords[field.name] ? 'eyeOff' : 'eye'} size={16} />
              </button>
            </div>
          ) : null}
          {!['textarea', 'select', 'quantity', 'checkboxes', 'select-or-other', 'creatable-select', 'catalog-or-other', 'list', 'password', 'file', 'multi-file'].includes(field.type) ? (
            <input
              accept={field.accept}
              autoComplete="off"
              maxLength={field.maxLength}
              name={field.name}
              onChange={handleChange}
              pattern={field.pattern}
              placeholder={field.placeholder ?? field.label}
              required={field.required} {...errorProps(field)}
              title={field.title}
              type={field.type}
              value={values[field.name] ?? ''}
            />
          ) : null}
          {field.type === 'file' ? (
            <div className={`photo-box${isFile(values[field.name]) || field.existingUrl ? ' has-file' : ''}`}>
              <input
                accept={field.accept}
                className="photo-box-input"
                id={`photo-box-input-${field.name}`}
                name={field.name}
                onChange={handleChange}
                required={field.required} {...errorProps(field)}
                type="file"
              />
              <label className="photo-box-add-btn" htmlFor={`photo-box-input-${field.name}`}>
                <Icon name="plus" size={10} />
                {isFile(values[field.name]) || field.existingUrl ? 'Change Image' : 'Add Image'}
              </label>
              {isFile(values[field.name]) ? (
                <button
                  type="button"
                  className="photo-box-remove"
                  onClick={() => {
                    const next = { ...values, [field.name]: null };
                    setValues(next);
                    onValuesChange?.(next);
                  }}
                  title="Remove image"
                  aria-label="Remove image"
                >
                  <Icon name="trash" size={13} />
                </button>
              ) : null}
              {isFile(values[field.name]) ? (
                values[field.name].type.startsWith('image/') ? (
                  <img alt={field.label} className="photo-box-fill" src={URL.createObjectURL(values[field.name])} />
                ) : (
                  <div className="photo-box-file">
                    <Icon name="clipboard" size={28} />
                    <span>{values[field.name].name}</span>
                  </div>
                )
              ) : field.existingUrl ? (
                // Not a freshly-picked File — the vehicle's already-saved photo,
                // shown so editing doesn't look like it wiped out the photo that
                // was there all along. No remove button here: the backend only
                // ever replaces photo_url when a new file is uploaded, it has no
                // "clear the photo" path, so offering removal would be a lie.
                <img alt={field.label} className="photo-box-fill" src={resolvePhotoUrl(field.existingUrl)} />
              ) : (
                <div className="photo-box-empty">
                  <Icon name="photo" size={38} strokeWidth={1.5} />
                  <span>No image available</span>
                </div>
              )}
            </div>
          ) : null}
          {field.type === 'multi-file' ? (() => {
            const existingFiles = Array.isArray(field.existingAttachments) ? field.existingAttachments : [];
            const pendingFiles = Array.isArray(values[field.name]) ? values[field.name] : [];
            const addFiles = (incoming) => {
              const list = Array.from(incoming ?? []).filter(Boolean);
              if (!list.length) return;
              const next = { ...values, [field.name]: [...pendingFiles, ...list] };
              setValues(next);
              onValuesChange?.(next);
            };
            const inputId = `multi-file-input-${field.name}`;
            return (
              <div className="multi-file-field file-card-like">
                <div className="multi-file-body">
                  {existingFiles.length || pendingFiles.length ? (
                    <div className="multi-file-list">
                      {existingFiles.map((att) => (
                        <div key={`existing-${att.attachment_id}`} className="multi-file-item is-existing">
                          <Icon name="clipboard" size={14} />
                          <a className="multi-file-name" href={resolvePhotoUrl(att.file_url)} target="_blank" rel="noreferrer">
                            {att.original_name || 'File'}
                          </a>
                          {field.onRemoveExisting && (
                            <button type="button" className="multi-file-remove" onClick={() => field.onRemoveExisting(att)} title="Remove file" aria-label="Remove file">
                              <Icon name="close" size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                      {pendingFiles.map((file, i) => (
                        <div key={`pending-${file.name}-${i}`} className="multi-file-item">
                          <Icon name="clipboard" size={14} />
                          <span className="multi-file-name">{file.name}</span>
                          <button
                            type="button"
                            className="multi-file-remove"
                            onClick={() => {
                              const next = { ...values, [field.name]: pendingFiles.filter((_, fi) => fi !== i) };
                              setValues(next);
                              onValuesChange?.(next);
                            }}
                            title="Remove file"
                            aria-label="Remove file"
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="file-card-empty">No data</div>
                  )}
                  <label
                    className="file-card-dropzone multi-file-dropzone"
                    htmlFor={inputId}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
                  >
                    <input
                      accept={field.accept}
                      className="multi-file-input"
                      id={inputId}
                      multiple
                      name={field.name}
                      onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                      type="file"
                    />
                    <Icon name="upload" size={30} strokeWidth={1.6} />
                    <span>Drag file here</span>
                  </label>
                </div>
              </div>
            );
          })() : null}
          {field.inlineExtra ? (
            <div className="field-extra field-extra-inline">
              {typeof field.inlineExtra === 'function' ? field.inlineExtra(values) : field.inlineExtra}
            </div>
          ) : null}
          {field.hint ? <small className="field-hint">{field.hint}</small> : null}
        </label>
        {field.extra ? (
          <div className="field-extra" style={{ gridColumn: field.extraGridColumn ?? '1 / -1' }}>
            {typeof field.extra === 'function' ? field.extra(values) : field.extra}
          </div>
        ) : null}
        </Fragment>
        );
        };

        return fields.some((f) => f.group) ? (
          groupFields(fields).map((group) => (
            <section className="form-group" key={group.name ?? 'ungrouped'}>
              {group.name ? <h4 className="form-group-title">{group.name}</h4> : null}
              <div className="form-group-body">{group.fields.map(renderField)}</div>
            </section>
          ))
        ) : (
          fields.map(renderField)
        );
      })()}
      <div className="form-actions">
        {onCancel ? <button className="ghost-button" onClick={onCancel} type="button">{cancelLabel}</button> : null}
        <button className="primary-button" type="submit">{submitLabel}</button>
      </div>
    </form>
  );
}
