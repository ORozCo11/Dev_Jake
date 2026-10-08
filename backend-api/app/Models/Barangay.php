<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Barangay extends Model
{
    protected $fillable = [
        'name',
        'city_id',
        'boundary',
        'boundary_status',
        'boundary_source',
        'boundary_verified_at',
        'boundary_verified_by',
        'pending_boundary',
        'pending_boundary_source',
    ];

    protected $casts = [
        'boundary' => 'array',
        'boundary_verified_at' => 'datetime',
        'pending_boundary' => 'array',
    ];

    public function city()
    {
        return $this->belongsTo(City::class);
    }

    public function users()
    {
        return $this->hasMany(User::class);
    }

    public function registrationSetting()
    {
        return $this->hasOne(RegistrationSetting::class);
    }

    /**
     * Used wherever a barangay's boundary is labeled for a viewer (e.g. the
     * Vehicle Location map) — several barangay names repeat across
     * neighboring cities (Banilad, Basak, ...), so the bare name alone is
     * ambiguous. Relies on `city` being eager-loaded; falls back to null
     * rather than lazy-loading it on every row.
     */
    public function getCityNameAttribute(): ?string
    {
        return $this->relationLoaded('city') ? $this->city?->name : null;
    }

    /**
     * Look up a barangay by name within a city (case-insensitive, trimmed),
     * creating it if it doesn't exist yet. Lets a registrant's free-typed
     * barangay name (used whenever a city has no seeded dropdown list)
     * become a real, selectable option for the next person registering
     * under the same city — instead of staying a one-off string forever.
     */
    public static function findOrCreateForCity(int $cityId, string $name): self
    {
        $name = trim($name);

        $barangay = static::where('city_id', $cityId)
            ->whereRaw('LOWER(name) = ?', [strtolower($name)])
            ->first();

        if ($barangay) {
            return $barangay;
        }

        try {
            return static::create(['city_id' => $cityId, 'name' => $name]);
        } catch (\Illuminate\Database\QueryException $e) {
            // Another request created the same barangay between our lookup
            // and our insert — use theirs instead of failing the signup.
            return static::where('city_id', $cityId)
                ->whereRaw('LOWER(name) = ?', [strtolower($name)])
                ->firstOr(fn () => throw $e);
        }
    }
}
