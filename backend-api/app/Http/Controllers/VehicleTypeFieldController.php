<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Models\ActivityLog;
use App\Models\VehicleCategory;
use App\Models\VehicleTypeField;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/**
 * Admin-managed custom fields per Vehicle Type. Gated by the existing
 * vehicle_type.* abilities — it is the same "maintain vehicle types" job.
 * Fields are archived (is_active=false), never deleted, so vehicles keep the
 * values they already hold.
 */
class VehicleTypeFieldController extends Controller
{
    use AuthorizesAbilities;

    public function index(Request $request, VehicleCategory $category)
    {
        // Final senior system review — this had no ability check at all,
        // reachable by any authenticated user of any role. A broad read
        // grant (it's just field schema/labels, not vehicle data) closes
        // that without blocking anyone who legitimately needs it to render
        // a vehicle's custom fields.
        $this->requireAbility($request, 'vehicle_type.view');

        return $category->fields;
    }

    public function store(Request $request, VehicleCategory $category)
    {
        $this->requireAbility($request, 'vehicle_type.edit');
        $data = $this->validated($request, null);

        $base = Str::slug($data['label'], '_') ?: 'field';
        $key = $base;
        for ($n = 2; $category->fields()->where('key', $key)->exists(); $n++) {
            $key = "{$base}_{$n}";
        }

        $field = $category->fields()->create($data + [
            'key' => $key,
            'sort_order' => ($category->fields()->max('sort_order') ?? 0) + 1,
        ]);
        $this->log($request, 'Add', "Added custom field \"{$field->label}\" to vehicle type {$category->category_name}", $field->field_id);

        return response()->json($field, 201);
    }

    public function update(Request $request, VehicleTypeField $field)
    {
        $this->requireAbility($request, 'vehicle_type.edit');
        $data = $this->validated($request, $field);
        // The type is fixed once created — changing it would orphan stored values.
        unset($data['field_type']);

        $field->update($data);
        $this->log($request, 'Edit', "Updated custom field \"{$field->label}\" on vehicle type {$field->category->category_name}", $field->field_id);

        return $field->fresh();
    }

    private function validated(Request $request, ?VehicleTypeField $existing): array
    {
        $data = $request->validate([
            'label' => ['required', 'string', 'max:100'],
            'field_type' => [$existing ? 'sometimes' : 'required', Rule::in(VehicleTypeField::TYPES)],
            'is_required' => ['sometimes', 'boolean'],
            'unit' => ['nullable', 'string', 'max:30'],
            'options' => ['nullable', 'array'],
            'options.*' => ['string', 'max:100'],
            'sort_order' => ['sometimes', 'integer', 'min:0'],
            'is_active' => ['sometimes', 'boolean'],
        ]);

        $type = $existing?->field_type ?? $data['field_type'];
        if ($type === 'dropdown') {
            $options = array_values(array_unique(array_filter(array_map('trim', $data['options'] ?? $existing?->options ?? []))));
            abort_if(!$options, 422, 'A dropdown field needs at least one option.');
            $data['options'] = $options;
        } else {
            $data['options'] = null;
        }
        if (!in_array($type, ['number', 'text'], true)) {
            $data['unit'] = null;
        }

        return $data;
    }

    private function log(Request $request, string $action, string $details, int $id): void
    {
        ActivityLog::create([
            'user_id' => $request->user()->id,
            'role' => $request->attributes->get('vms_acted_as_role') ?? $request->user()->role,
            'action' => $action,
            'module' => 'Vehicle Categories',
            'affected_record_id' => (string) $id,
            'details' => $details,
        ]);
    }
}
