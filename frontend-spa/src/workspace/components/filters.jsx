import { useMemo, useState } from 'react';
import Icon from '../../components/Icon';
import useDepsChanged from '../../hooks/useDepsChanged';
import { DateFilterInput, MultiSelectDropdown } from './inputs';
import { DualRangeSlider } from './ui';
import { pluralizeLabel, sameSelection } from '../lib/format';
import { ISSUE_SEVERITY_CHIP_BG, ISSUE_SEVERITY_CHIP_COLOR, TICKET_STAT_CARDS } from '../lib/statCards';
import { severityRangeFromSelection } from '../lib/workflow';

// A one-off, richer filter panel built specifically for Issue Reports (a
// search box, a severity range slider, and status shown as colored
// checkbox chips instead of a dropdown) rather than stretching the generic
// FilterBar — none of these are concepts the other ~15 FilterBar callers
// share, so bolting them on there would leak Issue-Reports-only UI into a
// shared component. Everything except the search box is staged (a local
// draft, applied together on "Filter") — same convention FilterBar itself
// uses, just with these different field types.
export function IssueFilterPanel({
  categories = [],
  vehicles = [],
  issueTypes = [],
  severityLevels = [],
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterIssueType,
  setFilterIssueType,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  filterDateStart,
  setFilterDateStart,
  filterDateEnd,
  setFilterDateEnd,
}) {
  const capacities = useMemo(() => {
    const caps = new Set();
    vehicles.forEach((v) => { if (v.capacity) caps.add(v.capacity.trim()); });
    return Array.from(caps).sort();
  }, [vehicles]);

  // Same default window every time the applied filter is unset — both on
  // first mount AND after "Clear Filters" resets filterDateStart/End back
  // to '' — instead of only seeding it once and then collapsing to a blank
  // "dd/mm/yyyy" the moment this effect's first resync runs.
  const draftFromFilters = () => ({
    category: filterCategory ?? [],
    capacity: filterCapacity ?? [],
    issueType: filterIssueType ?? [],
    status: filterStatus ?? [],
    severity: filterPriority ?? [],
    dateStart: filterDateStart || '2026-01-01',
    dateEnd: filterDateEnd || '2026-12-31',
  });
  const [draft, setDraft] = useState(draftFromFilters);

  // Re-sync whenever the applied filters change (e.g. "Clear Filters").
  if (useDepsChanged([filterCategory, filterCapacity, filterIssueType, filterStatus, filterPriority, filterDateStart, filterDateEnd])) {
    setDraft(draftFromFilters());
  }

  // An empty draft.severity means "no filter" — every chip reads checked.
  // Unchecking one FROM that implicit-all state expands it into an explicit
  // "every level except this one" list first.
  const toggleDraftSeverity = (level) => {
    setDraft((d) => {
      const current = d.severity.length === 0 ? severityLevels : d.severity;
      const next = current.includes(level) ? current.filter((s) => s !== level) : [...current, level];
      return { ...d, severity: next.length === severityLevels.length ? [] : next };
    });
  };

  const applyFilters = () => {
    setFilterCategory(draft.category);
    setFilterCapacity(draft.capacity);
    setFilterIssueType(draft.issueType);
    setFilterStatus(draft.status);
    setFilterPriority(draft.severity);
    setFilterDateStart(draft.dateStart);
    setFilterDateEnd(draft.dateEnd);
  };

  const isDirty = !sameSelection(draft.category, filterCategory ?? [])
    || !sameSelection(draft.capacity, filterCapacity ?? [])
    || !sameSelection(draft.issueType, filterIssueType ?? [])
    || !sameSelection(draft.status, filterStatus ?? [])
    || !sameSelection(draft.severity, filterPriority ?? [])
    || draft.dateStart !== (filterDateStart || '2026-01-01')
    || draft.dateEnd !== (filterDateEnd || '2026-12-31');

  return (
    <div className="issue-filter-panel">
      <div className="issue-filter-row">
        <div className="filter-date-group">
          <span>Category</span>
          <MultiSelectDropdown
            placeholder="All Categories"
            options={categories.map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
            selected={draft.category}
            onChange={(vals) => setDraft((d) => ({ ...d, category: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Capacity</span>
          <MultiSelectDropdown
            placeholder="All Capacities"
            options={capacities}
            selected={draft.capacity}
            onChange={(vals) => setDraft((d) => ({ ...d, capacity: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Issue Type</span>
          <MultiSelectDropdown
            placeholder="All Issue Types"
            options={issueTypes}
            selected={draft.issueType}
            onChange={(vals) => setDraft((d) => ({ ...d, issueType: vals }))}
          />
        </div>
      </div>
      {/* Second grid column of the TOP row — same track as the status
          chips + Filter button below it, so the two rows' right edges
          line up instead of the dates sitting narrower than that cluster. */}
      <div className="issue-filter-dates">
        <div className="filter-date-group issue-filter-date-input">
          <span>From Date</span>
          <DateFilterInput value={draft.dateStart} onChange={(val) => setDraft((d) => ({ ...d, dateStart: val }))} />
        </div>
        <div className="filter-date-group issue-filter-date-input">
          <span>To Date</span>
          <DateFilterInput value={draft.dateEnd} onChange={(val) => setDraft((d) => ({ ...d, dateEnd: val }))} />
        </div>
      </div>

      {/* Low/Medium/High used to be a range slider (pick a contiguous span
          of the scale) — plain checkboxes instead, same chip style as the
          status group, since severity is really just another multi-select
          and the slider made picking e.g. "Low + High only" impossible.
          Colors match the Issue Reports bar chart's own segments. */}
      <fieldset className="issue-filter-severity-card">
        <legend className="issue-filter-severity-label">Severity</legend>
        <div className="issue-filter-status-grid">
          {severityLevels.map((level) => (
            <label key={level} className="issue-filter-status-chip" style={{ background: ISSUE_SEVERITY_CHIP_BG[level] ?? '#f1f5f9' }}>
              <input type="checkbox" checked={draft.severity.length === 0 || draft.severity.includes(level)} onChange={() => toggleDraftSeverity(level)} />
              <span style={{ color: ISSUE_SEVERITY_CHIP_COLOR[level] ?? '#334155' }}>{level}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {/* The status chips (Pending/Under Review/In Maintenance/Resolved)
          that used to live here were a plain duplicate of the stat cards
          at the top of the page — same four statuses, same counts, just a
          second way to toggle them. Removed; the Filter button keeps its
          own row instead of sharing a cell with chips that no longer
          exist. */}
      <div className="issue-filter-right-cluster">
        <div className="issue-filter-actions">
          <button type="button" className="filter-apply-btn issue-filter-apply-btn" onClick={applyFilters} disabled={!isDirty}>Filter</button>
        </div>
      </div>
    </div>
  );
}

// Same bespoke filter panel design as IssueFilterPanel, adapted for
// Maintenance Tickets: no Issue Type dropdown (tickets don't have one),
// the range slider covers ticket Priority (Low/Medium/High) instead of
// Severity, and the status chips use TICKET_STAT_CARDS (Open/Active/
// Closed/Cancelled) instead of ISSUE_STAT_CARDS.
export function TicketFilterPanel({
  categories = [],
  vehicles = [],
  custodians = [],
  maintenancePersonnelRoster = [],
  priorityLevels = [],
  statusOptions = [],
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterVehicle,
  setFilterVehicle,
  filterMechanic,
  setFilterMechanic,
  filterCustodian,
  setFilterCustodian,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  filterDateStart,
  setFilterDateStart,
  filterDateEnd,
  setFilterDateEnd,
}) {
  const capacities = useMemo(() => {
    const caps = new Set();
    vehicles.forEach((v) => { if (v.capacity) caps.add(v.capacity.trim()); });
    return Array.from(caps).sort();
  }, [vehicles]);

  const maintenancePersonnelNames = useMemo(
    () => maintenancePersonnelRoster.map((p) => p.name).sort(),
    [maintenancePersonnelRoster],
  );
  const custodianNames = useMemo(() => custodians.map((c) => c.name).sort(), [custodians]);

  const statusKeys = useMemo(
    () => TICKET_STAT_CARDS.filter((c) => statusOptions.includes(c.key)).map((c) => c.key),
    [statusOptions],
  );

  // Same default window every time the applied filter is unset — both on
  // first mount AND after "Clear Filters" resets filterDateStart/End back
  // to '' — instead of only seeding it once and then collapsing to a blank
  // "dd/mm/yyyy" the moment this effect's first resync runs.
  const draftFromFilters = () => ({
    category: filterCategory ?? [],
    capacity: filterCapacity ?? [],
    vehicle: filterVehicle ?? [],
    mechanic: filterMechanic ?? [],
    custodian: filterCustodian ?? [],
    status: filterStatus ?? [],
    priorityRange: severityRangeFromSelection(filterPriority, priorityLevels),
    dateStart: filterDateStart || '2026-01-01',
    dateEnd: filterDateEnd || '2026-12-31',
  });
  const [draft, setDraft] = useState(draftFromFilters);

  // Re-sync whenever the applied filters change (e.g. "Clear Filters").
  if (useDepsChanged([filterCategory, filterCapacity, filterVehicle, filterMechanic, filterCustodian, filterStatus, filterPriority, filterDateStart, filterDateEnd])) {
    setDraft(draftFromFilters());
  }

  // An empty draft.status means "no filter" — every chip should read as
  // checked, the same "everything's included" state the Total/All stat
  // card represents. Unchecking one FROM that implicit-all state has to
  // expand it into an explicit "every status except this one" list first —
  // otherwise toggling off a single chip would (wrongly) read as toggling
  // it on, since d.status.includes(key) is false for all of them.
  const toggleDraftStatus = (key) => {
    setDraft((d) => {
      const current = d.status.length === 0 ? statusKeys : d.status;
      const next = current.includes(key) ? current.filter((s) => s !== key) : [...current, key];
      return { ...d, status: next.length === statusKeys.length ? [] : next };
    });
  };

  const applyFilters = () => {
    setFilterCategory(draft.category);
    setFilterCapacity(draft.capacity);
    setFilterVehicle(draft.vehicle);
    setFilterMechanic(draft.mechanic);
    setFilterCustodian(draft.custodian);
    setFilterStatus(draft.status);
    setFilterPriority(priorityLevels.slice(draft.priorityRange[0], draft.priorityRange[1] + 1));
    setFilterDateStart(draft.dateStart);
    setFilterDateEnd(draft.dateEnd);
  };

  const isFullPriorityRange = draft.priorityRange[0] === 0 && draft.priorityRange[1] === priorityLevels.length - 1;
  const isDirty = !sameSelection(draft.category, filterCategory ?? [])
    || !sameSelection(draft.capacity, filterCapacity ?? [])
    || !sameSelection(draft.vehicle, filterVehicle ?? [])
    || !sameSelection(draft.mechanic, filterMechanic ?? [])
    || !sameSelection(draft.custodian, filterCustodian ?? [])
    || !sameSelection(draft.status, filterStatus ?? [])
    || !isFullPriorityRange && !sameSelection(priorityLevels.slice(draft.priorityRange[0], draft.priorityRange[1] + 1), filterPriority ?? [])
    || draft.dateStart !== (filterDateStart || '2026-01-01')
    || draft.dateEnd !== (filterDateEnd || '2026-12-31');

  return (
    <div className="issue-filter-panel">
      <div className="issue-filter-row">
        <div className="filter-date-group">
          <span>Category</span>
          <MultiSelectDropdown
            placeholder="All Categories"
            options={categories.map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
            selected={draft.category}
            onChange={(vals) => setDraft((d) => ({ ...d, category: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Capacity</span>
          <MultiSelectDropdown
            placeholder="All Capacities"
            options={capacities}
            selected={draft.capacity}
            onChange={(vals) => setDraft((d) => ({ ...d, capacity: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Vehicle</span>
          <MultiSelectDropdown
            placeholder="All Vehicles"
            options={vehicles.map((v) => ({ value: String(v.vehicle_id), label: `${v.vehicle_name} · ${v.plate_number}` }))}
            selected={draft.vehicle}
            onChange={(vals) => setDraft((d) => ({ ...d, vehicle: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Maintenance Personnel</span>
          <MultiSelectDropdown
            placeholder="All Maintenance Personnel"
            options={maintenancePersonnelNames}
            selected={draft.mechanic}
            onChange={(vals) => setDraft((d) => ({ ...d, mechanic: vals }))}
          />
        </div>
        <div className="filter-date-group">
          <span>Custodian</span>
          <MultiSelectDropdown
            placeholder="All Custodians"
            options={custodianNames}
            selected={draft.custodian}
            onChange={(vals) => setDraft((d) => ({ ...d, custodian: vals }))}
          />
        </div>
      </div>
      <div className="issue-filter-dates">
        <div className="filter-date-group issue-filter-date-input">
          <span>From Date</span>
          <DateFilterInput value={draft.dateStart} onChange={(val) => setDraft((d) => ({ ...d, dateStart: val }))} />
        </div>
        <div className="filter-date-group issue-filter-date-input">
          <span>To Date</span>
          <DateFilterInput value={draft.dateEnd} onChange={(val) => setDraft((d) => ({ ...d, dateEnd: val }))} />
        </div>
      </div>

      <div className="issue-filter-severity-card">
        <span className="issue-filter-severity-label">Priority</span>
        <DualRangeSlider
          label="Priority"
          labels={priorityLevels}
          minIndex={draft.priorityRange[0]}
          maxIndex={draft.priorityRange[1]}
          onChange={(min, max) => setDraft((d) => ({ ...d, priorityRange: [min, max] }))}
        />
      </div>
      <div className="issue-filter-right-cluster">
        <div className="issue-filter-status-grid">
          {TICKET_STAT_CARDS.filter((c) => statusOptions.includes(c.key)).map((c) => (
            <label key={c.key} className="issue-filter-status-chip" style={{ background: c.bg }}>
              <input type="checkbox" checked={draft.status.length === 0 || draft.status.includes(c.key)} onChange={() => toggleDraftStatus(c.key)} />
              <span style={{ color: c.color }}>{c.label}</span>
            </label>
          ))}
        </div>
        <div className="issue-filter-actions">
          <button type="button" className="filter-apply-btn issue-filter-apply-btn" onClick={applyFilters} disabled={!isDirty}>Filter</button>
        </div>
      </div>
    </div>
  );
}

const optionLabel = (options, value) => {
  const match = (options ?? []).find((o) => (typeof o === 'object' ? String(o.value) === String(value) : String(o) === String(value)));
  return match && typeof match === 'object' ? match.label : (match ?? value);
};

// The filters currently APPLIED (not the staged draft), each removable on its
// own, plus one "Clear all". Lets a user see at a glance why a list looks
// short, and undo it without reopening every dropdown.
export function ActiveFilterChips({ groups }) {
  const active = groups.filter((g) => g.set && g.values?.length);
  if (!active.length) return null;
  const clearAll = () => active.forEach((g) => g.set([]));
  return (
    <div className="active-filter-chips" role="group" aria-label="Active filters">
      {active.flatMap((g) => g.values.map((value) => {
        const text = `${g.label}: ${g.display ? g.display(value) : value}`;
        return (
          <button
            key={`${g.label}-${value}`}
            type="button"
            className="active-filter-chip"
            onClick={() => g.set(g.values.filter((v) => v !== value))}
            aria-label={`Remove filter ${text}`}
          >
            <span>{text}</span>
            <Icon name="close" size={12} />
          </button>
        );
      }))}
      <button type="button" className="active-filter-clear" onClick={clearAll}>Clear all filters</button>
    </div>
  );
}

export function VehicleFilterPanel(props) {
  const [expanded, setExpanded] = useState(false);
  const activeCount = [
    props.filterCategory, props.filterCapacity, props.filterStatus,
    props.filterPriority, props.filterLocation, props.filterDomain,
    props.filterReadiness,
  ].reduce((sum, values) => sum + (values?.length ?? 0), 0);

  return (
    <div className="vehicle-filter-panel">
      <button type="button" className="vehicle-filter-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="vehicle-advanced-filters">
        <span><Icon name="filter" size={15} /> Advanced Filters {activeCount > 0 && <strong>{activeCount}</strong>}</span>
        <Icon name="chevronDown" size={15} className={expanded ? 'is-expanded' : ''} />
      </button>
      {expanded && (
        <div id="vehicle-advanced-filters">
          <FilterBar
            {...props}
            priorityLabel="Condition"
            extraFilters={[{
              key: 'readiness', label: 'Response Readiness', options: ['Ready', 'Not Ready'],
              selected: props.filterReadiness, setSelected: props.setFilterReadiness,
            }]}
          />
        </div>
      )}
      {!expanded && activeCount > 0 && <p className="vehicle-filter-summary">{activeCount} applied filter{activeCount === 1 ? '' : 's'} · Expand to review or clear</p>}
    </div>
  );
}

export function FilterBar({
  categories = [],
  vehicles = [],
  filterCategory,
  setFilterCategory,
  filterCapacity,
  setFilterCapacity,
  filterStatus,
  setFilterStatus,
  filterPriority,
  setFilterPriority,
  statusOptions = [],
  priorityOptions = [],
  priorityLabel = "Priority",
  statusLabel = "Status",
  trailing,
  filterLocation,
  setFilterLocation,
  filterDomain,
  setFilterDomain,
  // Extra module-specific dropdowns beyond the standard six — each applies
  // immediately (no "Filter" click needed), unlike the staged fields above.
  // Shape: [{ key, label, options, selected, setSelected }].
  extraFilters = [],
  // Optional date-range pair (also applies immediately as typed).
  dateRange = null,
}) {
  // Extract unique capacities dynamically
  const capacities = useMemo(() => {
    const caps = new Set();
    vehicles.forEach((v) => {
      if (v.capacity) {
        caps.add(v.capacity.trim());
      }
    });
    return Array.from(caps).sort();
  }, [vehicles]);

  const locations = useMemo(() => {
    const locs = new Set();
    vehicles.forEach((v) => {
      if (v.current_location) locs.add(v.current_location.trim());
    });
    return Array.from(locs).sort();
  }, [vehicles]);

  const domains = useMemo(() => {
    const doms = new Set();
    categories.forEach((c) => { if (c.domain) doms.add(c.domain); });
    return Array.from(doms).sort();
  }, [categories]);

  // Draft selections — only applied to the table when "Filter" is clicked.
  // Each field is an array now, so a dropdown can hold zero, one, or many values.
  const draftFromFilters = () => ({
    category: filterCategory ?? [],
    capacity: filterCapacity ?? [],
    status: filterStatus ?? [],
    priority: filterPriority ?? [],
    location: filterLocation ?? [],
    domain: filterDomain ?? [],
  });
  const [draft, setDraft] = useState(draftFromFilters);

  // Keep the draft in sync when applied filters are reset externally
  // (e.g. switching modules clears all filters).
  if (useDepsChanged([filterCategory, filterCapacity, filterStatus, filterPriority, filterLocation, filterDomain])) {
    setDraft(draftFromFilters());
  }

  const isDirty = !sameSelection(draft.category, filterCategory ?? [])
    || !sameSelection(draft.capacity, filterCapacity ?? [])
    || !sameSelection(draft.status, filterStatus ?? [])
    || !sameSelection(draft.priority, filterPriority ?? [])
    || !sameSelection(draft.location, filterLocation ?? [])
    || !sameSelection(draft.domain, filterDomain ?? []);

  const applyFilters = () => {
    setFilterCategory(draft.category);
    setFilterCapacity(draft.capacity);
    setFilterStatus(draft.status);
    if (setFilterPriority) setFilterPriority(draft.priority);
    if (setFilterLocation) setFilterLocation(draft.location);
    if (setFilterDomain) setFilterDomain(draft.domain);
  };

  const extraFiltersJsx = extraFilters.map((f) => (
    <div className="filter-date-group" key={f.key}>
      <span>{f.label}</span>
      <MultiSelectDropdown
        placeholder={`All ${f.label}`}
        options={f.options}
        selected={f.selected}
        onChange={f.setSelected}
      />
    </div>
  ));

  const dateRangeJsx = dateRange && (
    <>
      <div className="filter-date-group">
        <span>From Date</span>
        <DateFilterInput value={dateRange.start || '2026-01-01'} onChange={dateRange.setStart} />
      </div>
      <div className="filter-date-group">
        <span>To Date</span>
        <DateFilterInput value={dateRange.end || '2026-12-31'} onChange={dateRange.setEnd} />
      </div>
    </>
  );

  return (
    <div className="filter-bar-container">
      <div className="filter-label">
        <span>Filters:</span>
      </div>

      {/* Category Dropdown */}
      <div className="filter-date-group">
        <span>Category</span>
        <MultiSelectDropdown
          placeholder="All Categories"
          options={categories.map((cat) => ({ value: String(cat.category_id), label: cat.category_name }))}
          selected={draft.category}
          onChange={(vals) => setDraft((d) => ({ ...d, category: vals }))}
        />
      </div>

      {/* Capacity Dropdown */}
      <div className="filter-date-group">
        <span>Capacity</span>
        <MultiSelectDropdown
          placeholder="All Capacities"
          options={capacities}
          selected={draft.capacity}
          onChange={(vals) => setDraft((d) => ({ ...d, capacity: vals }))}
        />
      </div>

      {/* Status Dropdown */}
      {statusOptions && statusOptions.length > 0 && (
        <div className="filter-date-group">
          <span>{statusLabel}</span>
          <MultiSelectDropdown
            placeholder={`All ${pluralizeLabel(statusLabel)}`}
            options={statusOptions}
            selected={draft.status}
            onChange={(vals) => setDraft((d) => ({ ...d, status: vals }))}
          />
        </div>
      )}

      {/* Priority / Severity / Condition Dropdown */}
      {priorityOptions && priorityOptions.length > 0 && (
        <div className="filter-date-group">
          <span>{priorityLabel}</span>
          <MultiSelectDropdown
            placeholder={`All ${pluralizeLabel(priorityLabel)}`}
            options={priorityOptions}
            selected={draft.priority}
            onChange={(vals) => setDraft((d) => ({ ...d, priority: vals }))}
          />
        </div>
      )}

      {/* Location/Domain — only Vehicle Management passes their setters. */}
      {setFilterLocation && (
        <div className="filter-date-group">
          <span>Location</span>
          <MultiSelectDropdown
            placeholder="All Locations"
            options={locations}
            selected={draft.location}
            onChange={(vals) => setDraft((d) => ({ ...d, location: vals }))}
          />
        </div>
      )}
      {setFilterDomain && (
        <div className="filter-date-group">
          <span>Domain</span>
          <MultiSelectDropdown
            placeholder="All Domains (Land/Water)"
            options={domains}
            selected={draft.domain}
            onChange={(vals) => setDraft((d) => ({ ...d, domain: vals }))}
          />
        </div>
      )}

      {/* Extra module-specific dropdowns and the date range apply
          immediately, not staged. */}
      {extraFiltersJsx}
      {dateRangeJsx}

      {/* Apply Filter button */}
      <button
        type="button"
        className="filter-apply-btn"
        onClick={applyFilters}
        disabled={!isDirty}
      >
        Filter
      </button>

      {trailing && <div className="filter-bar-trailing">{trailing}</div>}

      <ActiveFilterChips
        groups={[
          { label: 'Category', values: filterCategory, set: setFilterCategory, display: (v) => categories.find((c) => String(c.category_id) === String(v))?.category_name ?? v },
          { label: 'Capacity', values: filterCapacity, set: setFilterCapacity },
          { label: statusLabel, values: filterStatus, set: setFilterStatus, display: (v) => optionLabel(statusOptions, v) },
          { label: priorityLabel, values: filterPriority, set: setFilterPriority, display: (v) => optionLabel(priorityOptions, v) },
          { label: 'Location', values: filterLocation, set: setFilterLocation },
          { label: 'Domain', values: filterDomain, set: setFilterDomain },
          ...extraFilters.map((f) => ({ label: f.label, values: f.selected, set: f.setSelected, display: (v) => optionLabel(f.options, v) })),
        ]}
      />
    </div>
  );
}
