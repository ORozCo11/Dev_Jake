import { useId, useState } from 'react';
import Icon from '../../components/Icon';

// Shared pass/fail checklist (Readiness Check, Repair Verification): native
// radio groups per item (arrow keys work), 44px targets, text + icon so the
// state never depends on colour alone, a live "n of m checked" count, a
// bulk "mark all" shortcut and custom items. Styles: readiness-form.css.
//
// `results` is [{ item, passed: true | false | null }], owned by the parent.
export function PassFailChecklist({ results, onChange, passLabel = 'OK', allLabel = 'Mark all as OK', addPlaceholder = 'Add a custom checklist item…', itemNoun = 'item' }) {
  const id = useId();
  const [newItem, setNewItem] = useState('');
  const [newItemError, setNewItemError] = useState('');
  const answered = results.filter((r) => r.passed !== null).length;
  const allPassed = results.length > 0 && results.every((r) => r.passed === true);

  const setResult = (i, passed) => onChange(results.map((r, idx) => (idx === i ? { ...r, passed } : r)));
  // Most checks are routine passes — bulk-mark them, then flip any real failure.
  const toggleAll = (checked) => onChange(results.map((r) => ({ ...r, passed: checked ? true : null })));
  const remove = (i) => onChange(results.filter((_, idx) => idx !== i));
  const add = () => {
    const item = newItem.trim();
    if (!item) return;
    if (results.some((r) => r.item.toLowerCase() === item.toLowerCase())) {
      setNewItemError(`"${item}" is already on the list.`);
      return;
    }
    onChange([...results, { item, passed: null }]);
    setNewItem('');
    setNewItemError('');
  };

  return (
    <>
      <div className="readiness-form-toolbar">
        <label className="readiness-all-ok">
          <input type="checkbox" checked={allPassed} onChange={(e) => toggleAll(e.target.checked)} />
          {allLabel}
        </label>
        <span className="readiness-progress" role="status" aria-live="polite">
          {answered} of {results.length} checked
        </span>
      </div>

      <div className="readiness-items">
        {results.map((r, i) => {
          const name = `${id}-item-${i}`;
          return (
            <fieldset key={r.item} className={`readiness-item${r.passed === false ? ' is-failed' : r.passed === true ? ' is-ok' : ''}`}>
              <legend className="readiness-item-label">{r.item}</legend>
              <div className="readiness-item-choices">
                <label className="readiness-choice is-ok">
                  <input type="radio" name={name} checked={r.passed === true} onChange={() => setResult(i, true)} />
                  <Icon name="checkCircle" size={16} />
                  <span>{passLabel}</span>
                </label>
                <label className="readiness-choice is-fail">
                  <input type="radio" name={name} checked={r.passed === false} onChange={() => setResult(i, false)} />
                  <Icon name="alert" size={16} />
                  <span>Fail</span>
                </label>
                <button type="button" className="readiness-item-remove" onClick={() => remove(i)} aria-label={`Remove "${r.item}"`}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            </fieldset>
          );
        })}
      </div>

      <div className="readiness-add">
        <label htmlFor={`${id}-new`} className="sr-only">Add a custom {itemNoun}</label>
        <input
          id={`${id}-new`}
          type="text"
          value={newItem}
          onChange={(e) => { setNewItem(e.target.value); setNewItemError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={addPlaceholder}
          aria-invalid={newItemError ? 'true' : undefined}
          aria-describedby={newItemError ? `${id}-new-error` : undefined}
        />
        <button type="button" className="ghost-button" onClick={add}>
          <Icon name="plus" size={14} /> Add {itemNoun}
        </button>
      </div>
      {newItemError && <p id={`${id}-new-error`} className="readiness-field-error" role="alert">{newItemError}</p>}
    </>
  );
}
