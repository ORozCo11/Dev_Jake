<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Province extends Model
{
    protected $fillable = [
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

    public function cities()
    {
        return $this->hasMany(City::class);
    }
}
