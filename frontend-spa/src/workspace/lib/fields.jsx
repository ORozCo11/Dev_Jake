import { VehicleLocationMap } from '../../components/lazy';
import { NEW_ISSUE_OPTION } from './formHelpers';
import { SeverityGuide } from '../issues/issueBadges';
import { EMPTY_OBJ, options, vehicleOptions } from './format';

export function profileFields(existingPhotoUrl) {
  return [
    { label: 'Full Name', name: 'name', required: true, type: 'text' },
    { label: 'Email', name: 'email', required: true, type: 'text', placeholder: 'name@barangay.gov' },
    { label: 'Phone', name: 'phone', type: 'tel', pattern: '[0-9]{10}', placeholder: '09XXXXXXXXX', title: 'Phone must be exactly 10 digits' },
    { label: 'Address', name: 'address', type: 'text' },
    { label: 'Profile Photo', name: 'photo', accept: 'image/*', type: 'file', existingUrl: existingPhotoUrl },
  ];
}

export const CRITICALITY_LEVELS = ['Critical', 'High', 'Normal'];

export function defaultCriticalityFor(vehicle, lookups) {
  return (lookups.categories ?? []).find((c) => String(c.category_id) === String(vehicle.category_id))?.default_criticality ?? 'Normal';
}

export function vehicleCriticality(vehicle, lookups) {
  return vehicle.criticality ? `${vehicle.criticality} (set for this vehicle)` : `${defaultCriticalityFor(vehicle, lookups)} (from vehicle type)`;
}

export const categoryFields = [
  { label: 'Vehicle Type Name', name: 'category_name', required: true, type: 'text', placeholder: 'e.g. Fire Truck, Rescue Boat' },
  {
    label: 'Domain', name: 'domain', options: ['Land', 'Water'], required: true, type: 'select',
    hint: 'Water changes what a vehicle of this type asks for elsewhere — hull material and engine type instead of the usual land specs.',
  },
  {
    label: 'Default Criticality', name: 'default_criticality', options: CRITICALITY_LEVELS, type: 'select',
    hint: 'How much a vehicle of this type matters operationally. Critical vehicles surface first on the readiness watch. Admin can override it per vehicle.',
  },
  { label: 'Description', name: 'description', type: 'textarea', placeholder: 'Optional notes about when to use this type' },
];

// `liveValues` lets Confirm Password become required only once a new
// password has actually been typed — editing an Admin resets someone
// else's password, so unlike the self-service My Profile flow there's
// deliberately no Current Password field: the whole point of an admin
// reset is that they don't (and shouldn't need to) know the old one.
export function userFields(isEditing, liveValues = EMPTY_OBJ) {
  return [
    { label: 'Full Name', name: 'name', required: true, type: 'text', group: 'Personal Information' },
    { label: 'Email Address', name: 'email', required: true, type: 'text', placeholder: 'name@barangay.gov', group: 'Personal Information' },
    { label: 'Phone', name: 'phone', type: 'tel', pattern: '[0-9]{10}', placeholder: '09XXXXXXXXX', title: 'Phone must be exactly 10 digits', group: 'Personal Information' },
    { label: 'Address', name: 'address', type: 'text', group: 'Personal Information' },
    // Deliberately paired side by side, in this order, both NOT full-width:
    // the grid's dense auto-flow (App.css .form-grid-2col .smart-form)
    // only backfills gaps when one exists — keeping every field here a
    // plain single-column item, in strict declared order, means each row
    // fills left-then-right with no gaps for later fields to jump into
    // (which is what previously stranded Confirm Password alone).
    { label: 'Select one or more roles. The first selected role is the primary portal role.', name: 'roles', options: ['Admin', 'Custodian', 'Maintenance Personnel'], required: true, type: 'checkboxes', group: 'Roles & Access' },
    // No per-account "Vehicle Registration" checkbox any more: every
    // Custodian can register vehicles (see canRegisterVehicles in
    // permissions.js), so the old delegation toggle was removed.
    {
      label: isEditing ? 'New Password (leave blank to keep current)' : 'Password',
      name: 'password',
      required: !isEditing,
      type: 'password',
      group: 'Account Security',
    },
    {
      label: isEditing ? 'Confirm New Password' : 'Confirm Password',
      name: 'password_confirmation',
      required: isEditing ? Boolean(liveValues.password) : true,
      type: 'password',
      confirmOf: 'password',
      group: 'Account Security',
    },
    { label: 'Profile Photo (optional)', name: 'photo', accept: 'image/*', type: 'file', group: 'Profile Photo' },
  ];
}

export const verificationFields = [
  { label: 'Verification Result', name: 'verification_result', options: ['Passed', 'Failed'], required: true, type: 'select' },
  { label: 'Verification Notes', name: 'verification_notes', type: 'textarea' },
];

export const passwordFields = [
  { label: 'Old Password', name: 'old_password', required: true, type: 'password' },
  { label: 'New Password', name: 'new_password', required: true, type: 'password' },
  { label: 'Confirm New Password', name: 'new_password_confirmation', required: true, type: 'password', confirmOf: 'new_password' },
];

export const FUEL_TYPE_OPTIONS = ['Diesel', 'Gasoline', 'Electric', 'Hybrid', 'CNG', 'LPG'];
export const HULL_MATERIAL_OPTIONS = ['Fiberglass', 'Aluminum', 'Steel', 'Wood', 'Rubber/Inflatable'];

export function capacityUnits(domain) {
  // 'pax' matters for a Water vehicle too — a rescue boat's key spec is how
  // many people it can carry, same reason it matters for an Ambulance.
  return domain === 'Water' ? ['L', 'gal', 'm³', 'pax'] : ['kg', 'tons', 'L', 'pax'];
}

// Same underlying column (plate_number) either way — a boat has no LTO
// plate, so the label/placeholder/validation just read right for whichever
// domain the vehicle actually is.
export function plateFieldLabel(domain) {
  return domain === 'Water' ? 'Registration / Hull No.' : 'Plate Number';
}

export function vehicleIconName(domain) {
  return domain === 'Water' ? 'boat' : 'vehicle';
}

export function vehicleDomainFields(domain) {
  return domain === 'Water'
    ? [
        { label: 'Hull Material', name: 'hull_material', options: HULL_MATERIAL_OPTIONS, required: true, type: 'select' },
        { label: 'Engine Type', name: 'engine_type', required: true, type: 'text' },
        { label: 'Fuel Type', name: 'fuel_type', options: FUEL_TYPE_OPTIONS, required: true, type: 'select' },
      ]
    : [{ label: 'Fuel Type', name: 'fuel_type', options: FUEL_TYPE_OPTIONS, required: true, type: 'select' }];
}

// Admin-defined per-Vehicle-Type fields, rendered as ordinary form inputs
// named cf_<key> (the API folds them into custom_values).
export function customFieldInputs(category, group) {
  return (category?.fields ?? []).filter((f) => f.is_active).map((f) => ({
    label: f.unit ? `${f.label} (${f.unit})` : f.label,
    name: `cf_${f.key}`,
    required: f.is_required,
    type: f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : (f.field_type === 'dropdown' || f.field_type === 'yes_no') ? 'select' : 'text',
    options: f.field_type === 'yes_no' ? ['Yes', 'No'] : (f.options ?? undefined),
    ...(group ? { group } : {}),
  }));
}

export function vehicleWithCustomInitials(vehicle) {
  return { ...vehicle, ...Object.fromEntries(Object.entries(vehicle?.custom_values ?? {}).map(([k, v]) => [`cf_${k}`, v])) };
}

// Profile rows for a vehicle's custom values (archived fields still show what they hold).
export function customValueRows(vehicle, lookups) {
  const category = (lookups.categories ?? []).find((c) => String(c.category_id) === String(vehicle.category_id));
  return (category?.fields ?? [])
    .filter((f) => vehicle.custom_values?.[f.key] != null && vehicle.custom_values[f.key] !== '')
    .map((f) => (
      <div key={f.key}><dt>{f.label}</dt><dd>{vehicle.custom_values[f.key]}{f.unit ? ` ${f.unit}` : ''}</dd></div>
    ));
}

export const VEHICLE_WIZARD_STEP_LABELS = ['Basic Information', 'Specs', 'Photo & Location'];
export const VEHICLE_WIZARD_STEP_ICONS = ['clipboard', 'wrench', 'pin'];

export function vehicleFields(lookups, allHubs = [], domain = 'Land', existingPhotoUrl = null, category = null) {
  const hubOptions = allHubs.map((hub) => ({ value: hub.name, label: hub.name }));

  return [
    { label: 'Vehicle Name', name: 'vehicle_name', required: true, type: 'text', group: 'Vehicle identity' },
    { label: plateFieldLabel(domain), name: 'plate_number', required: true, type: 'text', maxLength: 10, group: 'Vehicle identity' },
    { label: 'Vehicle Type', name: 'category_id', options: lookups.categories ?? [], required: true, type: 'creatable-select', group: 'Vehicle identity',
      newItemLabel: 'vehicle type', catalogEndpoint: '/categories', idField: 'category_id', nameField: 'category_name', valueIsId: true,
      extraFields: [{ name: 'domain', label: 'Domain', options: ['Land', 'Water'], required: true, default: domain }],
    },
    { label: 'Operational Criticality (override)', name: 'criticality', options: [...CRITICALITY_LEVELS, 'Inherit'], type: 'select', group: 'Vehicle identity', hint: 'Choose Inherit to use the Vehicle Type default.' },
    { label: 'Vehicle Photo', name: 'photo', accept: 'image/*', type: 'file', existingUrl: existingPhotoUrl, group: 'Vehicle photo' },
    { label: 'Brand', name: 'brand', required: true, type: 'text', group: 'Technical details' },
    { label: 'Model', name: 'model', required: true, type: 'text', group: 'Technical details' },
    { label: 'Year Model', name: 'year_model', required: true, type: 'number', group: 'Technical details' },
    { label: 'Capacity', name: 'capacity', required: true, type: 'quantity', units: capacityUnits(domain), group: 'Technical details' },
    // #10 — optional; without it, lifetime-cost-vs-value (decommission signal)
    // simply has nothing to compare against and is skipped for this vehicle.
    { label: 'Acquisition Cost (optional)', name: 'acquisition_cost', type: 'number', placeholder: 'e.g. 850000', group: 'Technical details' },
    { label: 'Vehicle Color', name: 'vehicle_color', required: true, type: 'text', group: 'Technical details' },
    ...vehicleDomainFields(domain).map((field) => ({ ...field, group: 'Technical details' })),
    ...customFieldInputs(category, 'Technical details'),
    {
      label: 'Current Location', name: 'current_location', options: hubOptions, required: true, type: 'select', group: 'Location & service availability',
      // Full-width (not inline in the select's own half-column) — this map
      // needs real width to read as a map, not a cramped strip. Reflects
      // whatever is currently picked, not just what the vehicle loaded
      // with — re-looks-up the hub from the live form value on every
      // change, so switching the dropdown always re-populates it.
      extra: (vals) => {
        const hub = allHubs.find((h) => h.name === vals.current_location);
        return hub ? (
          <div className="veh-map-wrap" style={{ height: 320 }}>
            <VehicleLocationMap lat={hub.lat} lng={hub.lng} label={hub.name} />
          </div>
        ) : null;
      },
    },
    // Production-readiness audit finding #7 — was accepted by the API and
    // shown read-only on the profile, but had no way to actually be edited.
    { label: 'Remarks (optional)', name: 'remarks', type: 'textarea', group: 'Location & service availability' },
  ];
}

export function conditionFields(lookups) {
  return [
    { label: 'Vehicle', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select' },
    { label: 'Condition Result', name: 'condition_result', options: lookups.condition_results, required: true, type: 'select', hint: '“Good” records the vehicle’s physical condition only — it does not mark it ready to respond. Use a Readiness Check for that.' },
    { label: 'Observations', name: 'observations', type: 'textarea' },
  ];
}

export function issueFields(lookups, editTarget, role, onAddVehicle) {
  if (editTarget?.issue_report_id && role === 'Custodian') {
    return [
      // Phase B4 — catalog.create (fault categories) is Admin-only now, so
      // a Custodian no longer gets the "+ Add New" affordance here — "Other"
      // + a note (folded into Remarks on submit, see SmartForm's handleSubmit)
      // stands in for it instead. Remarks itself isn't its own visible field
      // any more (it duplicated Issues Found) — otherNoteField still targets
      // it so an "Other" note has somewhere to land.
      { label: 'Issue Type', name: 'issue_type', options: lookups.issue_types, required: true, type: 'catalog-or-other', otherNoteField: 'remarks', otherNoteLabel: 'Describe the issue/type' },
      // A list, not one paragraph — each row becomes its own line-item, so
      // when this report is later converted into a Pre-Diagnosed ticket,
      // every distinct problem lands as its own sub-issue instead of the
      // whole description getting dumped into a single sub-issue.
      { label: 'Issues Found', name: 'issue_description', required: true, type: 'list', placeholder: 'e.g. Low coolant level', addLabel: 'Add another issue' },
      { label: 'Severity Level', name: 'severity_level', options: lookups.severity_levels, required: true, type: 'select', extra: (values) => <SeverityGuide levels={lookups.severity_levels} selected={values.severity_level} /> },
      { label: 'Files', name: 'attachments', type: 'multi-file', existingAttachments: editTarget.attachments },
    ];
  }

  if (editTarget?.issue_report_id || role === 'Maintenance Personnel') {
    return [
      { label: 'Status', name: 'status', options: lookups.issue_statuses, required: true, type: 'select' },
      { label: 'Remarks', name: 'remarks', type: 'textarea' },
    ];
  }

  return [
    {
      label: 'Which vehicle has a problem?', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select', group: '1. Select Vehicle',
      // Only offered to whoever actually holds vehicle.create (Admin and
      // Custodian) — anyone else would just hit a permissions wall.
      action: onAddVehicle ? { label: '+ Add Vehicle', onClick: onAddVehicle } : undefined,
    },
    // Phase B4 — Admin keeps the original "+ Add New" catalog affordance;
    // anyone else (a Custodian filing a fresh report) gets "Other" + a note
    // folded into Remarks instead, same as the edit-own path above.
    (role === 'Admin'
      ? { label: 'Type of problem', name: 'issue_type', options: lookups.issue_types, required: true, type: 'creatable-select', newItemLabel: 'issue type', catalogEndpoint: '/fault-categories', group: '2. Describe the Problem' }
      : { label: 'Type of problem', name: 'issue_type', options: lookups.issue_types, required: true, type: 'catalog-or-other', otherNoteField: 'remarks', otherNoteLabel: 'Describe the issue/type', group: '2. Describe the Problem' }),
    { label: 'What did you notice?', name: 'issue_description', required: true, type: 'textarea', placeholder: 'Describe the problem, when it happens, and anything the reviewer should know.', group: '2. Describe the Problem' },
    { label: 'How urgent is it?', name: 'severity_level', options: lookups.severity_levels, required: true, type: 'select', group: '3. Additional Information', extra: (values) => <SeverityGuide levels={lookups.severity_levels} selected={values.severity_level} /> },
    { label: 'Photos or files (optional)', name: 'attachments', type: 'multi-file', group: '3. Additional Information', hint: 'Add evidence only if it helps explain the problem.' },
  ];
}

// "Repair Type" is a single virtual selector standing in for two genuinely
// independent backend facts — which vehicle a part came off of, vs. who
// performed the labor — that used to render as two separate dropdowns next
// to each other and read as related when they weren't. repairTypeOf derives
// the selector's value from an existing record (for editing); applyRepairType
// converts it back to the real is_external/source_vehicle_id fields the
// backend expects (for submitting). See FleetController::storeMaintenanceRecord.
export function repairTypeOf(record) {
  if (record?.source_vehicle_id) return 'cannibalized';
  if (record?.is_external === 1 || record?.is_external === true || record?.is_external === '1') return 'external';
  return 'in_house';
}

export function withRepairType(record) {
  if (!record) return EMPTY_OBJ;
  return { ...record, repair_type: repairTypeOf(record) };
}

export function applyRepairType(payload) {
  const { repair_type, ...rest } = payload;
  if (repair_type === 'cannibalized') return { ...rest, is_external: 0 };
  if (repair_type === 'external') return { ...rest, is_external: 1, source_vehicle_id: null };
  return { ...rest, is_external: 0, source_vehicle_id: null };
}

// "Performed By" (Admin-only, select-or-other) shares one field name for two
// mutually-exclusive backend facts: a registered user's id, or a free-text
// name for someone outside the system entirely (a volunteer, an outside
// helper). withPerformedBy seeds the field from whichever the existing
// record actually has (for editing); applyPerformedBy sorts a submitted
// value back into the right one of the two real columns — a plain numeric
// string is treated as a picked user id, anything else as typed "Other"
// text. See FleetController::storeMaintenanceRecord.
export function withPerformedBy(record) {
  if (!record) return EMPTY_OBJ;
  return { ...record, maintenance_personnel_id: record.maintenance_personnel_id ?? record.performed_by_other ?? '' };
}

export function applyPerformedBy(payload) {
  if (!('maintenance_personnel_id' in payload)) return payload;
  const raw = payload.maintenance_personnel_id;
  const isOther = raw !== '' && raw != null && !/^\d+$/.test(String(raw));
  if (isOther) return { ...payload, maintenance_personnel_id: null, performed_by_other: raw };
  return { ...payload, performed_by_other: null };
}

export function maintenanceFields(lookups, role, liveValues = EMPTY_OBJ) {
  const fields = [
    // Leads the form instead of trailing after Parts/Materials Used — it's
    // the single choice that decides which other fields even show up (Source
    // Vehicle for a cannibalized part, vendor/warranty for an external shop),
    // so it belongs first, not buried past fields that don't depend on it.
    // In place of the old "Source Vehicle" + "External Repair?" dropdowns
    // sitting side by side, which read as related when they weren't.
    // Full-width so its follow-up field(s) clearly read as belonging to it,
    // on their own row directly underneath, instead of sharing a row side by side.
    {
      label: 'Repair Type',
      name: 'repair_type',
      type: 'select',
      fullWidth: true,
      group: 'Repair Details',
      options: [
        { value: 'in_house', label: 'In-House Repair' },
        { value: 'cannibalized', label: 'Used Cannibalized Part' },
        { value: 'external', label: 'Sent to External Shop' },
      ],
    },
    { label: 'Vehicle', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select', group: 'Vehicle & Issue' },
    { label: 'Related Issue Report', name: 'issue_report_id', options: issueOptions(), type: 'select', group: 'Vehicle & Issue' },
    { label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types, required: true, type: 'creatable-select', newItemLabel: 'maintenance type', catalogEndpoint: '/maintenance-types', group: 'Vehicle & Issue' },
    { label: 'Problem / Reason', name: 'problem_reason', required: true, type: 'textarea', group: 'Work Log' },
    { label: 'Date Started', name: 'date_started', type: 'date', group: 'Schedule & Personnel' },
    { label: 'Date Completed', name: 'date_completed', type: 'date', group: 'Schedule & Personnel' },
    { label: 'Action Taken', name: 'action_taken', type: 'textarea', group: 'Work Log' },
    {
      label: 'Parts / Materials Used',
      name: 'parts_used',
      type: 'list',
      group: 'Work Log',
      placeholder: 'e.g. Brake pads',
      addLabel: 'Add another part',
      removeLabel: 'part',
    },
    { label: 'Maintenance Cost (PHP)', name: 'maintenance_cost', type: 'number', min: 0, placeholder: 'e.g. 1500', group: 'Cost & Completion' },
    // Proof-of-completion fast close: what actually justifies skipping
    // Custodian verification is that something REAL is attached — a receipt
    // for an external shop repair, or a photo of the finished work for an
    // in-house fix (e.g. a roadside tire change). Either counts; a typed
    // note does not, so this isn't gated behind Repair Type — only its
    // label/hint change to match, so it's obvious which kind of proof is
    // expected instead of a generic either/or description every time.
    {
      label: liveValues?.repair_type === 'external' ? 'Receipt (Proof of Payment)' : 'Photo of Completed Repair',
      name: 'receipt',
      type: 'file',
      accept: 'image/*,.pdf',
      group: 'Cost & Completion',
      hint: liveValues?.repair_type === 'external'
        ? "Attach the shop's receipt, then set Progress Status to Completed — this closes the record immediately with no separate verification step."
        : 'Attach a photo of the completed repair, then set Progress Status to Completed — this closes the record immediately with no separate verification step.',
    },
    { label: 'Progress Status', name: 'progress_status', options: lookups.maintenance_statuses, type: 'select', group: 'Cost & Completion' },
    { label: 'Remarks', name: 'remarks', type: 'textarea', group: 'Cost & Completion' },
  ];

  if (role === 'Admin') {
    fields.splice(fields.findIndex((f) => f.name === 'action_taken'), 0, {
      label: 'Performed By',
      name: 'maintenance_personnel_id',
      options: options(lookups.maintenance_performers, 'id', 'name'),
      required: true,
      type: 'select-or-other',
      otherLabel: 'Other (not in system)',
      otherPlaceholder: 'e.g. a volunteer or outside helper\'s name',
      group: 'Schedule & Personnel',
      hint: 'Whoever actually did the repair — not necessarily Maintenance Personnel; a Custodian or Admin who fixed it themselves belongs here too. Not registered in the system at all? Pick Other and type their name.',
    });
  }

  // Only one of these ever applies at a time — that's the whole point of
  // collapsing them into one selector above instead of two independent
  // toggles that could (confusingly) both be filled in at once.
  const repairTypeIndex = fields.findIndex((f) => f.name === 'repair_type');
  if (liveValues?.repair_type === 'cannibalized') {
    // Required — "cannibalized" only means something once we know which
    // vehicle the part actually came from.
    fields.splice(repairTypeIndex + 1, 0, {
      label: 'Source Vehicle',
      name: 'source_vehicle_id',
      options: vehicleOptions(lookups).filter((v) => String(v.value) !== String(liveValues?.vehicle_id)),
      type: 'select',
      required: true,
      group: 'Repair Details',
      hint: 'Which vehicle the part was taken from.',
    }, {
      label: 'Part Taken From Donor',
      name: 'part_name',
      type: 'text',
      required: true,
      placeholder: 'e.g. Alternator, Brake caliper',
      group: 'Repair Details',
      hint: 'Which specific part was removed from the source vehicle.',
    });
  } else if (liveValues?.repair_type === 'external') {
    // Vendor required — can't log an external repair without knowing which
    // shop it went to. Warranty stays optional; not every repair carries one.
    fields.splice(repairTypeIndex + 1, 0,
      { label: 'External Shop', name: 'external_vendor', type: 'text', placeholder: 'e.g. Bautista Auto Shop', required: true, group: 'Repair Details' },
      { label: 'Warranty Until', name: 'warranty_until', type: 'date', group: 'Repair Details' },
    );
  }

  // No matching Issue Report yet (e.g. a mechanic self-filing a field repair
  // with nothing on file) — let them create one instead of leaving this
  // module and losing their in-progress record. Picking "+ Add New Issue…"
  // pops the modal open immediately and only asks for Issue Type — the new
  // report's description/severity come from this same form's Problem/Reason
  // and a default (see submitFormPage), not asked for a second time.
  if (liveValues?.issue_report_id === NEW_ISSUE_OPTION.value) {
    const issueReportIndex = fields.findIndex((f) => f.name === 'issue_report_id');
    fields.splice(issueReportIndex + 1, 0,
      {
        label: 'New Issue Type',
        name: '__new_issue_group__',
        required: true,
        type: 'new-issue-modal',
        issueTypeOptions: lookups.issue_types,
        fullWidth: true,
        group: 'Vehicle & Issue',
      },
    );
  }

  return fields;

  function issueOptions() {
    return [
      NEW_ISSUE_OPTION,
      ...(lookups.issue_reports ?? []).map((issue) => ({
        value: issue.issue_report_id,
        label: `#${issue.issue_report_id} ${issue.issue_type}`,
      })),
    ];
  }
}

export function scheduleFields(lookups, allHubs = [], isEdit = false, suggestOnly = false) {
  const hubOptions = allHubs.map((hub) => ({ value: hub.name, label: hub.name }));

  // A Custodian's suggestion only needs what Admin must see: which vehicle,
  // what, roughly when, and why.
  const keep = suggestOnly ? ['vehicle_id', 'maintenance_type', 'scheduled_date', 'notes'] : null;
  const all = [
    { label: 'Vehicle', name: 'vehicle_id', options: vehicleOptions(lookups), required: true, type: 'select' },
    { label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types, required: true, type: 'creatable-select', newItemLabel: 'maintenance type', catalogEndpoint: '/maintenance-types' },
    { label: 'Scheduled Date', name: 'scheduled_date', required: true, type: 'date', hint: 'Choose the target service date. Overdue schedules are highlighted automatically.' },
    { label: 'Scheduled Time', name: 'scheduled_time', type: 'time', hint: 'Optional; use this when the service has a confirmed time slot.' },
    // Recurring PM: completing this schedule auto-creates the next at the chosen
    // interval. Left blank = one-time (the default "Select" option).
    {
      label: 'Repeats (optional)',
      name: 'recurrence_months',
      type: 'select-or-other',
      // Spelled out in full (audit §12) — same wording as the list's
      // Repeat column (RECURRENCE_LABEL).
      options: [
        { value: 1, label: 'Every month' },
        { value: 3, label: 'Every 3 months (quarterly)' },
        { value: 6, label: 'Every 6 months' },
        { value: 12, label: 'Every year' },
      ],
      otherLabel: 'Custom number of months…',
      otherInputLabel: 'Repeat every how many months? (1–60)',
      otherPlaceholder: 'e.g. 4',
      otherSuffix: 'months',
      otherType: 'number',
      otherMin: 1,
      otherMax: 60,
      hint: 'Leave blank for one-time maintenance. When a repeating schedule is marked done, the next one is created automatically, counted from the completion date.',
    },
    // A known hub, or "Other" for an outside repair shop not in that list.
    { label: 'Service Location', name: 'service_location', type: 'select-or-other', options: hubOptions, otherLabel: 'Other / External Shop', otherPlaceholder: 'e.g. Toyota Service Center', hint: 'Pick a hub for in-house work, or "Other / External Shop" to name an outside service provider.' },
    // Full-width only on create: with Status hidden there, it's the trailing
    // odd-one-out in the 2-column grid — spanning the full row reads as
    // intentional instead of leaving an empty cell beside it. On edit, Status
    // sits next to it instead, making the pair even again.
    { label: 'Assigned To', name: 'assigned_to', options: options(lookups.maintenance_personnel, 'id', 'name'), type: 'select', fullWidth: !isEdit, hint: 'The assigned maintenance personnel can mark this schedule as done.' },
    // Completed is deliberately never offered here — marking a schedule done
    // goes through the dedicated "Mark Done" action (creates the proof-of-work
    // record and, if recurring, the next occurrence); this field only ever
    // needs to cancel an existing one. Not shown at all when creating new.
    ...(isEdit ? [{ label: 'Status', name: 'status', options: ['Scheduled', 'Cancelled'], type: 'select' }] : []),
    { label: 'Notes', name: 'notes', type: 'textarea' },
  ];
  return keep ? all.filter((f) => keep.includes(f.name)) : all;
}

export function mechanicAssignFields(lookups) {
  return [
    { label: 'Assign Mechanic', name: 'assigned_mechanic_id', options: (lookups.maintenance_personnel ?? []).map((m) => ({ value: m.id, label: m.name })), required: true, type: 'select' },
    { label: 'Maintenance Type', name: 'maintenance_type', options: lookups.maintenance_types ?? [], required: true, type: 'creatable-select', newItemLabel: 'maintenance type', catalogEndpoint: '/maintenance-types' },
    { label: 'Work Order Notes', name: 'work_order_notes', type: 'textarea', rows: 2 },
  ];
}

// Problem 2 — the functional test ("UAT") checklist. What must be physically
// operated and confirmed depends on the KIND of vehicle, keyed off the same
// Land/Water domain that drives the specs form (plus a fire-truck extra).
export function functionalTestChecklist(vehicle) {
  const domain = vehicle?.category?.domain ?? 'Land';
  const name = (vehicle?.category?.category_name ?? '').toLowerCase();
  const base = [
    'Engine / power system starts normally',
    'No warning indicators or abnormal noise',
    'The reported problem no longer occurs',
  ];
  if (domain === 'Water') {
    return [...base, 'Engine runs under load on the water', 'Bilge pump operates', 'No hull leaks or water ingress'];
  }
  const land = ['Brakes respond properly', 'Completed a short test drive'];
  const fireTruck = name.includes('fire') ? ['Water pump reaches full pressure'] : [];
  return [...base, ...land, ...fireTruck];
}

export const confirmTicketFields = [
  { label: 'Confirmation Verdict', name: 'confirmation_verdict', options: ['Confirmed', 'Reopened'], required: true, type: 'select' },
  { label: 'Notes / Remarks', name: 'confirmation_notes', type: 'textarea', rows: 2 },
];

// The four ways a ticket can be reported. Everything but 'inspection' means
// the issue AND its repair type are already known — Repair Type used to
// only live on the separate Maintenance Record form; it's captured here
// instead so it isn't asked for twice. Shared with the Log Repairs step,
// where the same repair type gets confirmed/corrected once work starts.
export const ENTRY_MODE_OPTIONS = [
  { value: 'inspection', label: 'Needs Inspection', description: 'A custodian must inspect and confirm the required work.' },
  { value: 'in_house', label: 'In-House Repair', description: 'The issue is known and will be repaired by barangay personnel.' },
  { value: 'cannibalized', label: 'Used Cannibalized Part', description: 'Use a compatible part sourced from another fleet vehicle.' },
  { value: 'external', label: 'Sent to External Shop', description: 'Send the vehicle to an outside repair provider.' },
];

// =========================================================================
// VEHICLE DETAIL PANEL — shown when a vehicle row is clicked
// =========================================================================

// Gap A — the pre-deployment readiness checklist, by vehicle type. Distinct
// from the post-repair functional test: this proves the vehicle is mission-
// ready NOW (fuelled, equipped, working), regardless of whether it's broken.
export function readinessChecklist(vehicle) {
  const domain = vehicle?.category?.domain ?? 'Land';
  const name = (vehicle?.category?.category_name ?? '').toLowerCase();
  if (domain === 'Water') return ['Fuel tank full', 'Life vests aboard', 'Bilge pump works', 'No water in the hull'];
  if (name.includes('ambulance')) return ['Fuel tank full', 'Oxygen tank present', 'Lights & siren work', 'Stretcher aboard'];
  if (name.includes('fire')) return ['Fuel tank full', 'Water tank full', 'Pump primes', 'Hoses aboard', 'Lights & siren work'];
  return ['Fuel tank full', 'Lights work', 'Engine starts normally'];
}
// Admin-defined custom fields for one Vehicle Type. Fields are archived, not
// deleted, so vehicles keep the values they already hold.
export const CUSTOM_FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'date', label: 'Date' },
  { value: 'yes_no', label: 'Yes / No' },
];
export const BLANK_FIELD_DRAFT = { label: '', field_type: 'text', is_required: false, unit: '', options: '' };
