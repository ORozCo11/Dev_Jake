<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class VehicleCategory extends Model
{
    protected $primaryKey = 'category_id';

    protected $fillable = [
        'category_name',
        'domain',
        'description',
    ];

    // All fields (archived ones included) in display order; forms filter on is_active.
    public function fields()
    {
        return $this->hasMany(VehicleTypeField::class, "category_id", "category_id")->orderBy("sort_order")->orderBy("field_id");
    }

    public function vehicles()
    {
        return $this->hasMany(Vehicle::class, 'category_id', 'category_id');
    }
}
