<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class City extends Model
{
    protected $fillable = [
        'province_id',
        'code',
        'name',
        'boundary',
        'boundary_source',
        'boundary_verified_at',
    ];

    protected $casts = [
        'boundary' => 'array',
        'boundary_verified_at' => 'datetime',
    ];

    public function province()
    {
        return $this->belongsTo(Province::class);
    }

    public function barangays()
    {
        return $this->hasMany(Barangay::class);
    }

    public function users()
    {
        return $this->hasMany(User::class);
    }
}
