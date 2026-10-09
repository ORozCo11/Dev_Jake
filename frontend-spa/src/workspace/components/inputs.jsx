import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../../components/Icon';
import useDepsChanged from '../../hooks/useDepsChanged';
import useDialogA11y from '../../hooks/useDialogA11y';
import { AuthContext } from '../../context/AuthContextObject';
import api from '../../api/axios';
import { FormModal } from './ui';
import { CATALOG_OTHER_VALUE, SELECT_OR_OTHER_SENTINEL } from '../lib/formHelpers';
import { displayDateToIso, isoDateToDisplay } from '../lib/format';
import { hasRole } from '../lib/permissions';

// A dropdown of presets plus an "Other" option that reveals a free-text box —
// e.g. Service Location: pick a known hub, or specify an outside repair shop.
// Tracks "other mode" locally (not in the form's values), seeded from whether
// the incoming value already fails to match any preset.
// Same look/interaction as CreatableSelect's combobox — a single bordered
// input opening a dropdown with a pinned "+ Add …" row — but for a small
// fixed set of numeric presets (e.g. recurrence intervals). The custom value
// is entered in a small popup form, like CreatableSelect's add-new modal;
// nothing is persisted to a catalog, it's just a value on this one record.
export function SelectOrAddNumberField({ field, value, onChange }) {
  const options = field.options ?? [];
  const matchesPreset = options.some((o) => String(o?.value ?? o) === String(value ?? ''));
  const isCustomActive = Boolean(value) && !matchesPreset;
  const [open, setOpen] = useState(false);
  // Non-null while the custom-value popup is open.
  const [customDraft, setCustomDraft] = useState(null);
  const [customError, setCustomError] = useState(null);
  const containerRef = useRef(null);
  const suffix = field.otherSuffix ?? '';
  const addLabel = field.otherLabel ?? 'Add Custom Value';

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const customText = (v) => `Every ${v}${suffix ? ` ${suffix}` : ''}`;
  const selectedLabel = matchesPreset
    ? (options.find((o) => String(o?.value ?? o) === String(value ?? ''))?.label ?? '')
    : (isCustomActive ? customText(value) : '');

  const pick = (option) => {
    onChange(String(option?.value ?? option ?? ''));
    setOpen(false);
  };
  const openCustom = () => {
    setCustomDraft(isCustomActive ? String(value) : '');
    setCustomError(null);
    setOpen(false);
  };
  const closeCustom = () => { setCustomDraft(null); setCustomError(null); };
  const saveCustom = (e) => {
    e.preventDefault();
    // The popup is portaled, but React still bubbles its submit to the
    // page's own form — stop it there.
    e.stopPropagation();
    const n = Number(customDraft);
    const min = field.otherMin ?? 1;
    const max = field.otherMax ?? Infinity;
    if (!customDraft || !Number.isInteger(n) || n < min || n > max) {
      setCustomError(`Enter a whole number from ${min} to ${max}.`);
      return;
    }
    onChange(String(n));
    closeCustom();
  };

  return (
    <div className="creatable-select" ref={containerRef}>
      <input
        type="text"
        readOnly
        value={selectedLabel}
        placeholder={field.placeholder ?? 'Select'}
        required={field.required}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
      />
      {open && (
        <div className="creatable-select-panel">
          <button type="button" className="creatable-select-option creatable-select-add creatable-select-add-pinned" onClick={openCustom}>
            <Icon name="plus" size={13} /> {addLabel}
          </button>
          <div className="creatable-select-option-list">
            {options.map((option, i) => (
              <div key={option?.value != null ? option.value : `opt-${i}`} className="creatable-select-option-row">
                <button type="button" className="creatable-select-option" onClick={() => pick(option)}>
                  {option?.label ?? option}
                </button>
              </div>
            ))}
            {isCustomActive && (
              <div className="creatable-select-option-row">
                <button type="button" className="creatable-select-option" onClick={() => setOpen(false)}>
                  {customText(value)} (custom)
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <FormModal open={customDraft !== null} title={addLabel} onClose={closeCustom}>
        <form className="smart-form" onSubmit={saveCustom} noValidate>
          <label>
            <span>{field.otherInputLabel ?? `Number of ${suffix || 'units'}`} <span className="required-asterisk">*</span></span>
            <input
              type="number"
              autoFocus
              min={field.otherMin}
              max={field.otherMax}
              step="1"
              placeholder={field.otherPlaceholder ?? ''}
              value={customDraft ?? ''}
              aria-invalid={customError ? 'true' : undefined}
              onChange={(e) => { setCustomDraft(e.target.value); setCustomError(null); }}
            />
          </label>
          {customError && <p className="readiness-field-error" role="alert">{customError}</p>}
          <div className="form-actions">
            <button className="ghost-button" type="button" onClick={closeCustom}>Cancel</button>
            <button className="primary-button" type="submit">Save</button>
          </div>
        </form>
      </FormModal>
    </div>
  );
}

export function SelectOrOtherField({ field, value, onChange }) {
  const options = field.options ?? [];
  const matchesPreset = options.some((o) => String(o?.value ?? o) === String(value ?? ''));
  const [otherMode, setOtherMode] = useState(Boolean(value) && !matchesPreset);

  if (field.otherType === 'number') {
    return <SelectOrAddNumberField field={field} value={value} onChange={onChange} />;
  }

  return (
    <>
      <select
        required={field.required}
        value={otherMode ? SELECT_OR_OTHER_SENTINEL : (value ?? '')}
        onChange={(e) => {
          if (e.target.value === SELECT_OR_OTHER_SENTINEL) {
            setOtherMode(true);
            onChange('');
          } else {
            setOtherMode(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">{' '}</option>
        {options.map((option, i) => (
          <option key={option?.value != null ? option.value : `opt-${i}`} value={option?.value ?? option ?? ''}>
            {option?.label ?? option}
          </option>
        ))}
        <option value={SELECT_OR_OTHER_SENTINEL}>{field.otherLabel ?? 'Other (specify)'}</option>
      </select>
      {otherMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            type={field.otherType ?? 'text'}
            min={field.otherMin}
            max={field.otherMax}
            placeholder={field.otherPlaceholder ?? 'Specify'}
            required={field.required}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            style={{ flex: 1 }}
          />
          {field.otherSuffix && <span className="muted" style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>{field.otherSuffix}</span>}
        </div>
      )}
    </>
  );
}

export function CatalogOrOtherField({ value, onChange, note, onNoteChange, options = [], required = false, placeholder = 'Select an option', otherNoteLabel = 'Describe the issue/type' }) {
  const isOther = value === CATALOG_OTHER_VALUE;
  return (
    <>
      <select
        required={required}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((option, i) => (
          <option key={option?.value != null ? option.value : `opt-${i}`} value={option?.value ?? option ?? ''}>
            {option?.label ?? option}
          </option>
        ))}
        <option value={CATALOG_OTHER_VALUE}>Other</option>
      </select>
      {isOther && (
        <input
          type="text"
          placeholder={otherNoteLabel}
          value={note ?? ''}
          onChange={(e) => onNoteChange(e.target.value)}
          style={{ marginTop: 8 }}
        />
      )}
    </>
  );
}

// A native <input type="date">'s displayed text always follows the
// visitor's own OS region setting (day-first, month-first, whatever it is)
// — nothing on the page, not even the `lang` attribute, can override just
// that display. This wraps a hidden native date input (kept only for its
// calendar picker, launched via showPicker()) behind a visible text field
// that is always typed and displayed as MM/DD/YYYY, so the format is
// guaranteed regardless of the browser/OS locale.
export // `id` lets a standalone <label htmlFor> point at the visible text input;
// both are optional and unused by every existing caller.
function DateFilterInput({ value, onChange, placeholder = 'mm/dd/yyyy', id, ariaLabel }) {
  const hiddenRef = useRef(null);
  const [text, setText] = useState(() => isoDateToDisplay(value));

  if (useDepsChanged([value])) setText(isoDateToDisplay(value));

  const openPicker = () => {
    try { hiddenRef.current?.showPicker?.(); } catch { /* unsupported browser — text entry still works */ }
  };

  const commit = (raw) => {
    if (!raw.trim()) { onChange(''); return; }
    const iso = displayDateToIso(raw);
    if (iso) onChange(iso);
    else setText(isoDateToDisplay(value));
  };

  return (
    <div className="date-filter-input">
      <input
        type="text"
        id={id}
        aria-label={ariaLabel}
        className="filter-select"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <button type="button" className="date-filter-input-icon" onClick={openPicker} aria-label="Open calendar">
        <Icon name="calendar" size={14} />
      </button>
      <input
        ref={hiddenRef}
        type="date"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="date-filter-input-hidden"
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}

// Checkbox multi-select dropdown — lets a filter row pick zero, one, or many
// values instead of forcing a single native <select> choice.
export function MultiSelectDropdown({ placeholder = 'All', options = [], selected = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const normalizedOptions = useMemo(
    () => options.map((opt) => (opt && typeof opt === 'object' ? opt : { value: opt, label: String(opt) })),
    [options]
  );
  const query = search.trim().toLowerCase();
  const filteredOptions = query
    ? normalizedOptions.filter((opt) => opt.label.toLowerCase().includes(query))
    : normalizedOptions;

  const toggleAll = () => onChange([]);
  const toggleOption = (value) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const summaryLabel = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? (normalizedOptions.find((o) => String(o.value) === String(selected[0]))?.label ?? String(selected[0]))
      : `${selected.length} selected`;

  return (
    <div className="multi-select-dropdown" ref={containerRef}>
      <button
        type="button"
        className={`filter-select multi-select-trigger${selected.length ? ' has-selection' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{summaryLabel}</span>
        <Icon name="chevronDown" size={14} className={`multi-select-chevron${open ? ' is-open' : ''}`} />
      </button>
      {open && (
        <div className="multi-select-panel">
          <input
            type="text"
            className="multi-select-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            autoFocus
          />
          <label className="multi-select-option multi-select-all-option">
            <input type="checkbox" checked={selected.length === 0} onChange={toggleAll} />
            <span>- All -</span>
          </label>
          <div className="multi-select-option-list">
            {filteredOptions.map((opt) => (
              <label key={opt.value} className="multi-select-option">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggleOption(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
            {filteredOptions.length === 0 && <div className="multi-select-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// A text input that suggests existing options as you type, and — when
// nothing matches — offers to add whatever was typed as a brand new one.
// The catalog it's editing (fault categories, maintenance types) is meant
// to grow with real use instead of being a fixed, admin-curated list; the
// backend persists new values the same way, so anyone who adds one here
// finds it waiting in the dropdown next time, everywhere it's offered.
export function CreatableSelect({
  value, onChange, options = [], placeholder = 'Select or type to add new', newItemLabel = 'option',
  required = false, catalogEndpoint = null,
  // For a catalog whose API doesn't use plain {id, name} — e.g. vehicle
  // categories use {category_id, category_name} — read/write under these
  // keys instead, normalizing to {id, name} internally either way.
  idField = 'id', nameField = 'name',
  // True when the field this drives (e.g. category_id) stores the
  // catalog row's id, not its name — value/onChange deal in ids, and the
  // displayed text is resolved by looking the id up in the catalog.
  valueIsId = false,
  // Extra required fields the create-endpoint needs beyond a bare name
  // (e.g. vehicle categories also require a Domain) — rendered as simple
  // selects in the add-new modal, merged into the POST body.
  extraFields = [],
}) {
  // Only an Admin can remove a catalog entry — it's a shared list everyone
  // adds to, so letting any role delete from it risks a Custodian or
  // Mechanic wiping out something others rely on. The backend enforces
  // this too; hiding the button for non-Admins just avoids a guaranteed
  // 403 on click.
  const { user: currentUser } = useContext(AuthContext);
  const canDeleteCatalogItems = hasRole(currentUser, 'Admin');
  // Accepts either a plain name string (the simple catalogs) or a raw API
  // row keyed by idField/nameField (e.g. vehicle categories) — either way,
  // normalized to one {id, name} shape everything below works with.
  const normalizeItem = useCallback((raw) => (
    typeof raw === 'string' ? { id: null, name: raw } : { id: raw[idField] ?? null, name: raw[nameField] }
  ), [idField, nameField]);
  const [open, setOpen] = useState(false);
  // Only holds what's being typed while the panel is open — closed, the
  // input just displays `value` directly, so there's nothing to keep in
  // sync via an effect when the value changes from outside.
  const [draftText, setDraftText] = useState('');
  // {id, name} pairs — seeded from the plain-string `options` prop (ids
  // unknown yet) so the list isn't empty on first render, then replaced
  // with the authoritative version once catalogEndpoint responds. Ids are
  // what make per-row delete possible; a bare string list (no catalog
  // backing) just never shows a delete button.
  const [catalogItems, setCatalogItems] = useState(() => options.map(normalizeItem));
  // Non-null while the "complete new item" modal is open — holds its own
  // editable Name field, seeded from what was typed but not locked to it,
  // same as the reference add-new-Company flow (a real little form, not
  // just a yes/no confirmation of the raw typed text).
  const [addModalName, setAddModalName] = useState(null);
  // Non-null while the modal above is in EDIT mode instead of ADD mode —
  // holds the raw {id, name} item being renamed. Shares the same
  // addModalName/addModalExtra/addModalError/addSaving state as add, since
  // it's the same little form either way; only the submit target differs.
  const [editTarget, setEditTarget] = useState(null);
  // Values for `extraFields` (e.g. Domain), keyed by field name.
  const [addModalExtra, setAddModalExtra] = useState({});
  const [addModalError, setAddModalError] = useState(null);
  const [addSaving, setAddSaving] = useState(false);
  const [addedMessage, setAddedMessage] = useState(null);
  // The item pending the delete confirmation modal — a real, permanent
  // removal (it disappears from this list for everyone), so it gets the
  // same "are you sure" step as any other destructive action in the app.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteDialogRef = useRef(null);
  const deleteCancelRef = useRef(null);
  const deleteTitleId = useId();
  useDialogA11y(deleteDialogRef, { open: Boolean(deleteTarget), onClose: () => setDeleteTarget(null), initialFocusRef: deleteCancelRef, closeOnEscape: !deleteBusy });
  // True right after opening (via focus), before the user has actually
  // typed anything — the input still shows the current value, but the
  // option list is NOT filtered by it, so reopening an already-picked
  // field shows the full catalog instead of just the one exact match
  // (which used to look like every other option had vanished).
  const [justOpened, setJustOpened] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!catalogEndpoint) return;
    let cancelled = false;
    api.get(catalogEndpoint).then((res) => {
      if (!cancelled) setCatalogItems(res.data.map(normalizeItem));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [catalogEndpoint, normalizeItem]);

  useEffect(() => {
    if (!addedMessage) return;
    const timer = setTimeout(() => setAddedMessage(null), 2600);
    return () => clearTimeout(timer);
  }, [addedMessage]);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  // When the driven field stores an id (valueIsId), resolve it to a name
  // for display — `value` itself is never text in that mode.
  const selectedItem = valueIsId ? catalogItems.find((o) => String(o.id) === String(value)) : null;
  const displayText = valueIsId ? (selectedItem?.name ?? '') : (value ?? '');
  const text = open ? draftText : displayText;
  const query = justOpened ? '' : text.trim().toLowerCase();
  const filtered = query ? catalogItems.filter((o) => o.name.toLowerCase().includes(query)) : catalogItems;
  const hasExactMatch = catalogItems.some((o) => o.name.toLowerCase() === query);
  const canAddNew = query.length > 0 && !hasExactMatch;

  const openPanel = () => {
    setDraftText(displayText);
    setJustOpened(true);
    setOpen(true);
  };
  const pick = (item) => {
    onChange(valueIsId ? item.id : item.name);
    setOpen(false);
  };
  const openAddModal = (name) => {
    setEditTarget(null);
    setAddModalName(name);
    // Extra fields can carry a sensible default from context (e.g. Domain
    // pre-filled to match the vehicle already being filled out) — still
    // shown and changeable, just not blank by default.
    setAddModalExtra(Object.fromEntries(extraFields.map((f) => [f.name, f.default ?? ''])));
    setAddModalError(null);
    setOpen(false);
  };
  // Renaming an existing entry — same little modal as add, pre-filled with
  // its current name. Only offered where add/delete already are (a real
  // catalogEndpoint, Admin), since it's the same permission story: a shared
  // list everyone reads, only Admin should be able to change it out from
  // under everyone else.
  const openEditModal = (item) => {
    setEditTarget(item);
    setAddModalName(item.name);
    setAddModalExtra(Object.fromEntries(extraFields.map((f) => [f.name, f.default ?? ''])));
    setAddModalError(null);
    setOpen(false);
  };
  const newItemTitle = newItemLabel.replace(/\b\w/g, (c) => c.toUpperCase());
  const saveAddModal = async (e) => {
    e.preventDefault();
    // React portals bubble synthetic events through the component tree, not
    // the DOM tree — without this, submitting this modal's form (portaled
    // to document.body) also fires the outer page's own <form onSubmit>,
    // since CreatableSelect is nested inside it there.
    e.stopPropagation();
    const val = addModalName.trim();
    if (!val) {
      setAddModalError('Name is required.');
      return;
    }
    const missingExtra = extraFields.find((f) => f.required && (addModalExtra[f.name] ?? '') === '');
    if (missingExtra) {
      setAddModalError(`${missingExtra.label} is required.`);
      return;
    }

    if (editTarget) {
      setAddSaving(true);
      try {
        const res = await api.put(`${catalogEndpoint}/${editTarget.id}`, { [nameField]: val, ...addModalExtra });
        const updated = normalizeItem(res.data);
        setCatalogItems((items) => items
          .map((i) => (i.id === editTarget.id ? updated : i))
          .sort((a, b) => a.name.localeCompare(b.name)));
        // Renamed item was the one already selected — plain-string mode
        // (valueIsId false) stores the name itself, so it has to follow the
        // rename or the field would keep showing text that's no longer a
        // real option. valueIsId mode needs nothing here; the id didn't change.
        if (!valueIsId && value === editTarget.name) {
          onChange(updated.name);
        }
        setEditTarget(null);
        setAddModalName(null);
        setAddModalError(null);
        setAddedMessage(`"${editTarget.name}" renamed to "${updated.name}".`);
      } catch (err) {
        setAddModalError(err?.response?.data?.message || 'Something went wrong — please try again.');
      } finally {
        setAddSaving(false);
      }
      return;
    }

    if (!catalogEndpoint) {
      pick({ id: null, name: val });
      setAddModalName(null);
      setAddModalError(null);
      setAddedMessage(`"${val}" added as a new ${newItemLabel}.`);
      return;
    }
    setAddSaving(true);
    try {
      const res = await api.post(catalogEndpoint, { [nameField]: val, ...addModalExtra });
      const created = normalizeItem(res.data);
      setCatalogItems((items) => {
        const withoutDupe = items.filter((i) => i.name.toLowerCase() !== created.name.toLowerCase());
        return [...withoutDupe, created].sort((a, b) => a.name.localeCompare(b.name));
      });
      pick(created);
      setAddModalName(null);
      setAddModalError(null);
      setAddedMessage(`"${created.name}" added as a new ${newItemLabel}.`);
    } catch (err) {
      setAddModalError(err?.response?.data?.message || 'Something went wrong — please try again.');
    } finally {
      setAddSaving(false);
    }
  };
  const closeAddModal = () => {
    setAddModalName(null);
    setAddModalError(null);
    setEditTarget(null);
  };
  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await api.delete(`${catalogEndpoint}/${deleteTarget.id}`);
      setCatalogItems((items) => items.filter((i) => i.id !== deleteTarget.id));
      const wasSelected = valueIsId ? String(value) === String(deleteTarget.id) : value === deleteTarget.name;
      if (wasSelected) onChange(valueIsId ? null : '');
      setDeleteTarget(null);
      setDeleteError(null);
    } catch (err) {
      setDeleteError(err?.response?.data?.message || 'Something went wrong — please try again.');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="creatable-select" ref={containerRef}>
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        required={required}
        onFocus={openPanel}
        onChange={(e) => { setDraftText(e.target.value); setJustOpened(false); if (!open) setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !open) return;
          // Enter inside the list means "choose what I typed" — never "submit the form".
          e.preventDefault();
          const exact = catalogItems.find((o) => o.name.toLowerCase() === query);
          if (exact) pick(exact);
          else if (filtered.length === 1) pick(filtered[0]);
          else if (canAddNew) openAddModal(text.trim());
        }}
      />
      {open && (
        <div className="creatable-select-panel">
          {!canAddNew && (
            <button type="button" className="creatable-select-option creatable-select-add creatable-select-add-pinned" onClick={() => openAddModal('')}>
              <Icon name="plus" size={13} /> Add New {newItemTitle}
            </button>
          )}
          <div className="creatable-select-option-list">
            {filtered.map((o) => (
              <div key={o.id ?? o.name} className="creatable-select-option-row">
                <button type="button" className="creatable-select-option" onClick={() => pick(o)}>
                  {o.name}
                </button>
                {catalogEndpoint && canDeleteCatalogItems && o.id != null && (
                  <>
                    {/* Simple name-only catalogs (Fault Category, Maintenance
                        Type) only — a catalog with extraFields (e.g. Vehicle
                        Type's Domain) isn't safe to rename here, since this
                        list never carries those extra values to prefill the
                        modal with; blindly submitting would reset them to
                        whatever the field's bare default is. Those already
                        have their own proper edit page elsewhere. */}
                    {extraFields.length === 0 && (
                      <button
                        type="button"
                        className="creatable-select-option-edit"
                        onClick={(e) => { e.stopPropagation(); openEditModal(o); }}
                        title={`Rename ${o.name}`}
                        aria-label={`Rename ${o.name}`}
                      >
                        <Icon name="edit" size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="creatable-select-option-delete"
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(o); setDeleteError(null); }}
                      title={`Remove ${o.name}`}
                      aria-label={`Remove ${o.name}`}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
            {filtered.length === 0 && !canAddNew && <div className="multi-select-empty">No matches</div>}
          </div>
          {canAddNew && (
            <button type="button" className="creatable-select-option creatable-select-add" onClick={() => openAddModal(text.trim())}>
              <Icon name="plus" size={13} /> Add "{text.trim()}" as a new {newItemLabel}
            </button>
          )}
        </div>
      )}
      <FormModal open={addModalName !== null} title={editTarget ? `Rename ${newItemTitle}` : `Add New ${newItemTitle}`} onClose={closeAddModal}>
        <form className="smart-form" onSubmit={saveAddModal} noValidate>
          {addModalError && (
            <div className="toast-notice-overlay" onClick={() => setAddModalError(null)}>
              <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
                <Icon name="alert" size={17} className="toast-notice-icon" />
                <div className="toast-notice-lines"><span>{addModalError}</span></div>
                <button type="button" className="toast-notice-close" onClick={() => setAddModalError(null)} aria-label="Dismiss">
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          )}
          <label>
            <span>Name <span className="required-asterisk">*</span></span>
            <input type="text" required autoFocus value={addModalName ?? ''} onChange={(e) => setAddModalName(e.target.value)} />
          </label>
          {extraFields.map((f) => (
            <label key={f.name}>
              <span>{f.label} {f.required && <span className="required-asterisk">*</span>}</span>
              {f.type === 'number' ? (
                <input
                  type="number"
                  step="any"
                  required={f.required}
                  placeholder={f.placeholder}
                  value={addModalExtra[f.name] ?? ''}
                  onChange={(e) => setAddModalExtra((cur) => ({ ...cur, [f.name]: e.target.value }))}
                />
              ) : (
                <select
                  required={f.required}
                  value={addModalExtra[f.name] ?? ''}
                  onChange={(e) => setAddModalExtra((cur) => ({ ...cur, [f.name]: e.target.value }))}
                >
                  <option value="" disabled>{' '}</option>
                  {f.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              )}
            </label>
          ))}
          <div className="form-actions">
            <button className="ghost-button" type="button" onClick={closeAddModal} disabled={addSaving}>Cancel</button>
            <button className="primary-button" type="submit" disabled={addSaving}>{addSaving ? 'Saving…' : (editTarget ? 'Save Changes' : 'Save')}</button>
          </div>
        </form>
      </FormModal>
      {deleteTarget && createPortal(
        <div className="confirm-overlay" onClick={() => !deleteBusy && setDeleteTarget(null)}>
          <section ref={deleteDialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={deleteTitleId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-icon" aria-hidden="true">
              <Icon name="alert" size={20} />
            </div>
            <div className="confirm-dialog-copy">
              <p className="eyebrow">Confirmation</p>
              <h3 id={deleteTitleId}>Remove {newItemTitle}</h3>
              <p>Remove "{deleteTarget.name}" from this list? It disappears for everyone — existing tickets/records that already used it keep showing it, but it won't be selectable anymore.</p>
              {deleteError && <p role="alert" style={{ color: '#b91c1c', fontWeight: 600, marginTop: 8 }}>{deleteError}</p>}
            </div>
            <div className="confirm-dialog-actions">
              <button ref={deleteCancelRef} className="ghost-button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)} type="button">Cancel</button>
              <button className="danger-button" disabled={deleteBusy} onClick={confirmDelete} type="button">
                {deleteBusy ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </section>
        </div>,
        document.body
      )}
      {addedMessage && createPortal(
        <div className="toast-notice success" role="alert">
          <div className="toast-notice-body">
            <Icon name="checkCircle" size={16} />
            <span>{addedMessage}</span>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Popup-modal version of the "+ Add New Issue…" field on the Maintenance
// Record form. Opens immediately (lazy initial state, not an effect — no
// extra click on an inline trigger first) and only asks for Issue Type;
// Description/Severity aren't asked twice — submitFormPage fills those in
// from the outer form's own Problem/Reason field and a default severity.
// Writes new_issue_type plus a truthy sentinel on its own field name (so
// SmartForm's generic required-field check has something to check) via one
// onChange patch — nothing downstream needs to know it came from a modal.
export function NewIssueModalField({ value, onChange, issueTypeOptions = [] }) {
  const hasValue = !!value?.new_issue_type;
  const [open, setOpen] = useState(() => !hasValue);
  const [draft, setDraft] = useState(() => value?.new_issue_type ?? '');
  const [error, setError] = useState(null);

  const openModal = () => {
    setDraft(value?.new_issue_type ?? '');
    setError(null);
    setOpen(true);
  };

  // Cancelling out of a first-time add (nothing saved yet) reverts the
  // Related Issue Report dropdown back to blank instead of leaving the
  // field group stranded with no value and no visible way back in.
  const cancel = () => {
    if (!hasValue) onChange({ issue_report_id: '' });
    setOpen(false);
  };

  const save = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draft.trim()) {
      setError('Issue Type is required.');
      return;
    }
    onChange({ new_issue_type: draft.trim(), __new_issue_group__: 1 });
    setOpen(false);
  };

  return (
    <>
      {hasValue && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', border: '1px solid var(--border-subtle, #e2e8f0)', borderRadius: 8 }}>
          <strong>{value.new_issue_type}</strong>
          <button type="button" className="ghost-button" onClick={openModal} style={{ flexShrink: 0 }}>Edit</button>
        </div>
      )}
      <FormModal open={open} title="Add New Issue" onClose={cancel}>
        <form className="smart-form new-issue-form" onSubmit={save} noValidate>
          {error && (
            <div className="toast-notice-overlay" onClick={() => setError(null)}>
              <div className="toast-notice toast-notice-validation error" role="alert" onClick={(e) => e.stopPropagation()}>
                <Icon name="alert" size={17} className="toast-notice-icon" />
                <div className="toast-notice-lines"><span>{error}</span></div>
                <button type="button" className="toast-notice-close" onClick={() => setError(null)} aria-label="Dismiss">
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          )}
          <label>
            <span>Issue Type <span className="required-asterisk">*</span></span>
            <CreatableSelect
              value={draft}
              onChange={setDraft}
              options={issueTypeOptions}
              newItemLabel="issue type"
              catalogEndpoint="/fault-categories"
              required
            />
          </label>
          <div className="form-actions">
            <button className="ghost-button" type="button" onClick={cancel}>Cancel</button>
            <button className="primary-button" type="submit">Save</button>
          </div>
        </form>
      </FormModal>
    </>
  );
}
