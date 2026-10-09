import { formatForecastDate } from './format';

export function clearDraftState(key) {
  if (!key) return;
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}

export function splitQuantityValue(value, units) {
  const str = String(value ?? '').trim();
  if (!str) return { amount: '', unit: units[0] };
  const lastSpace = str.lastIndexOf(' ');
  if (lastSpace === -1) {
    // No "<amount> <unit>" shape found. If the whole string is actually
    // just a unit name (e.g. the user picked a unit before typing an
    // amount, so the field's value is only that unit), treat it as
    // "no amount yet" with that unit preserved — don't misread the unit
    // name itself as the amount and silently reset the dropdown.
    if (units.includes(str)) return { amount: '', unit: str };
    return { amount: str, unit: units[0] };
  }
  const amount = str.slice(0, lastSpace).trim();
  const unitCandidate = str.slice(lastSpace + 1).trim();
  return units.includes(unitCandidate) ? { amount, unit: unitCandidate } : { amount: str, unit: units[0] };
}

// A quantity field's amount only counts as filled in when it's a genuine
// number — a bare unit string (e.g. "Gallons" picked before any amount was
// typed) must not pass as a valid amount.
export function isQuantityAmountFilled(amount) {
  return amount !== '' && amount != null && !Number.isNaN(Number(amount));
}

// Generic required-check: treat only "no value" (empty string/null/undefined)
// as missing, so a legitimate falsy value like the number 0 (e.g. latitude
// 0, longitude 0) still counts as filled in.
export function isValueMissing(value) {
  return value === '' || value === null || value === undefined;
}

export const SELECT_OR_OTHER_SENTINEL = '__other__';

// Phase B4 — catalog.create (fault categories / maintenance types) is
// Admin-only now. Everywhere a Custodian or Maintenance Personnel used to
// get CreatableSelect's "+ Add New" affordance on one of these two
// catalogs, this replaces it: a plain select with "Other" pinned as the
// last option. Picking it reveals a free-text note below — `value` stays a
// real catalog name, or the literal CATALOG_OTHER_VALUE sentinel; `note` is
// kept separate, meant to be folded into whichever description/notes field
// the parent form already sends to the backend (rather than trying to mint
// a new catalog value, which only Admin can still do). Admin keeps the
// original CreatableSelect wherever this replaces it — this component is
// never shown to Admin.
export const CATALOG_OTHER_VALUE = 'Other';

// Every required/pattern/confirm-match check SmartForm used to hand off to
// the browser's own constraint validation (native tooltip, positioned and
// styled by the browser, not this app). Re-implemented here so every form
// reports through the same in-app, styled validation card the server-side
// (422) errors already use — one consistent message UI instead of two.
// One entry per problem: { name, message } — `name` is the field to mark
// invalid and focus; `message` is shown beside it and in the form summary.
export function collectFieldErrors(fields, values) {
  const errors = [];
  fields.forEach((field) => {
    const value = values[field.name];

    if (field.type === 'checkboxes') {
      if (field.required && !(Array.isArray(value) && value.length > 0)) {
        errors.push({ name: field.name, message: `${field.label}: select at least one.` });
      }
      return;
    }

    if (field.type === 'list') {
      const rows = Array.isArray(value) ? value : [];
      if (field.required && !rows.some((row) => row.trim())) {
        errors.push({ name: field.name, message: `${field.label} is required.` });
      }
      return;
    }

    if (field.type === 'quantity') {
      // Require the amount portion specifically — a combined value like
      // "Gallons" (unit picked, no amount typed) must not pass just because
      // the raw string is non-empty.
      if (field.required) {
        const { amount } = splitQuantityValue(value, field.units);
        if (!isQuantityAmountFilled(amount)) {
          errors.push({ name: field.name, message: `${field.label} is required.` });
        }
      }
      return;
    }

    if (field.confirmOf) {
      if (field.required && isValueMissing(value)) {
        errors.push({ name: field.name, message: `${field.label} is required.` });
      } else if (value && value !== values[field.confirmOf]) {
        errors.push({ name: field.name, message: `${field.label} does not match.` });
      }
      return;
    }

    if (field.required && isValueMissing(value)) {
      errors.push({ name: field.name, message: `${field.label} is required.` });
      return;
    }

    if (field.type === 'number' && value !== '' && value != null) {
      const num = Number(value);
      if (field.min != null && num < Number(field.min)) {
        errors.push({ name: field.name, message: `${field.label} must be at least ${field.min}.` });
      }
      if (field.max != null && num > Number(field.max)) {
        errors.push({ name: field.name, message: `${field.label} must be at most ${field.max}.` });
      }
    }

    if (field.pattern && value && !new RegExp(`^(?:${field.pattern})$`).test(value)) {
      errors.push({ name: field.name, message: field.title || `${field.label} is invalid.` });
    }
  });
  return errors;
}

export function collectValidationErrors(fields, values) {
  return collectFieldErrors(fields, values).map((e) => e.message);
}

// Opt-in field grouping: fields carrying a `group` label render inside their
// own titled sub-card (Maintenance Records today) instead of one flat list —
// so the section header says what those fields are about at a glance,
// mirroring the realcore reference's "Select Fee Type" / "Other" cards.
// Fields with no `group` fall into a single nameless bucket, which the
// caller renders unwrapped — so forms that never set `group` are unaffected.
export function groupFields(fields) {
  const groups = [];
  fields.forEach((field) => {
    const key = field.group ?? null;
    let bucket = groups.find((g) => g.name === key);
    if (!bucket) {
      bucket = { name: key, fields: [] };
      groups.push(bucket);
    }
    bucket.fields.push(field);
  });
  return groups;
}

// Formats one form field's live value for the Entry Summary card — resolves a
// select's option label and pretty-prints dates; returns null when unanswered.
export function formSummaryValue(field, raw) {
  if (raw == null || raw === '') return null;
  if (field.type === 'select' && Array.isArray(field.options)) {
    const opt = field.options.find((o) => String(o?.value ?? o) === String(raw));
    const label = opt?.label ?? opt;
    if (label != null) return String(label);
  }
  if (field.type === 'date') return formatForecastDate(raw) || String(raw);
  if (field.type === 'list') {
    const rows = (Array.isArray(raw) ? raw : [raw]).map((r) => String(r).trim()).filter(Boolean);
    return rows.length ? rows.join(' · ') : null;
  }
  if (field.type === 'multi-file') {
    const count = Array.isArray(raw) ? raw.length : 0;
    return count ? `${count} file${count === 1 ? '' : 's'} selected` : null;
  }
  return String(raw);
}

export const NEW_ISSUE_OPTION = { value: '__new_issue__', label: '+ Add New Issue…' };

// Stacks two or more long-text fields (e.g. Problem/Reason + Action Taken)
// into one labeled multi-line block for a table's renderSubRow band,
// skipping whichever fields aren't populated on a given row.
export function subRowFields(pairs) {
  const present = pairs.filter(([, value]) => value);
  if (!present.length) return null;
  return (
    <div className="table-subrow-lines">
      {present.map(([label, value]) => (
        <div key={label}><strong>{label}:</strong> {value}</div>
      ))}
    </div>
  );
}

export function valuesFromFields(fields, initialValues) {
  return Object.fromEntries(fields.map((field) => {
    const raw = initialValues?.[field.name];
    if (field.type === 'checkboxes') {
      return [field.name, Array.isArray(raw) && raw.length ? raw : []];
    }
    // A 'list' field edits as separate rows but is stored as one
    // newline-joined string (see handleSubmit) — no backend/schema change
    // needed, and it stays a plain string for any code that just displays it.
    if (field.type === 'list') {
      const rows = typeof raw === 'string' && raw.trim() ? raw.split('\n') : (Array.isArray(raw) ? raw : []);
      return [field.name, rows.length ? rows : ['']];
    }
    return [field.name, raw ?? ''];
  }));
}
