<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class VehicleTypeField extends Model
{
    public const TYPES = ['text', 'number', 'dropdown', 'date', 'yes_no'];

    protected $primaryKey = 'field_id';

    protected $fillable = ['category_id', 'key', 'label', 'field_type', 'is_required', 'unit', 'options', 'sort_order', 'is_active'];

    protected $casts = [
        'is_required' => 'boolean',
        'is_active' => 'boolean',
        'options' => 'array',
    ];

    /**
     * Validation rules for the values a vehicle of this type may carry, keyed
     * `custom_fields.{key}`. Only active fields are asked for / required.
     */
    public static function rulesFor(iterable $fields): array
    {
        $rules = ["custom_fields" => ["nullable", "array"]];
        foreach ($fields as $field) {
            if (!$field->is_active) {
                continue;
            }
            $base = [$field->is_required ? "required" : "nullable"];
            $rules["custom_fields.{$field->key}"] = array_merge($base, match ($field->field_type) {
                "number" => ["numeric"],
                "date" => ["date"],
                "yes_no" => [\Illuminate\Validation\Rule::in(["Yes", "No"])],
                "dropdown" => [\Illuminate\Validation\Rule::in($field->options ?? [])],
                default => ["string", "max:255"],
            });
        }

        return $rules;
    }

    public function category()
    {
        return $this->belongsTo(VehicleCategory::class, 'category_id', 'category_id');
    }
}
