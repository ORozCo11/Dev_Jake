<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Barangay extends Model
{
    /**
     * Barangay names our seeded list spells differently from the PSGC source
     * dataset. The local spelling is the one we keep; this map only exists so
     * the two can be recognised as the same place.
     */
    private const NAME_ALIASES = [
        'centro' => 'Centro (Poblacion)',
        'pakna-an' => 'Paknaan',
    ];

    protected $fillable = [
        'name',
        'code',
        'city_id',
        'boundary',
        'boundary_source',
        'boundary_verified_at',
    ];

    protected $casts = [
        'boundary' => 'array',
        'boundary_verified_at' => 'datetime',
    ];

    public function city()
    {
        return $this->belongsTo(City::class);
    }

    public function users()
    {
        return $this->hasMany(User::class);
    }

    /**
     * Look up a barangay by name within a city (case-insensitive, trimmed),
     * creating it if it doesn't exist yet.
     *
     * This is the emergency fallback for a city whose barangay list hasn't
     * been imported yet — registration normally requires picking an existing
     * barangay, and AuthController only reaches this when the city has no
     * barangays at all. A row created here carries no PSGC code and no
     * boundary; running `boundaries:import` later attaches both by name.
     */
    public static function fallbackForCity(int $cityId, string $name): self
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

    /**
     * Collapses a barangay name to a comparable key, so "Pakna-an" and
     * "Paknaan" resolve to the same place across datasets.
     */
    public static function normalizeName(string $name): string
    {
        $name = self::NAME_ALIASES[strtolower(trim($name))] ?? $name;

        // PSGC abbreviates "Poblacion" as "Pob." in hundreds of barangay
        // names nationwide, so "Centro (Pob.)" and "Centro (Poblacion)" have
        // to collapse to the same key or the importer inserts a duplicate
        // alongside the row it should have matched.
        $name = preg_replace('/\bpob\b\.?/i', 'poblacion', $name);

        return strtolower(preg_replace('/[^a-z0-9]/i', '', $name));
    }
}
