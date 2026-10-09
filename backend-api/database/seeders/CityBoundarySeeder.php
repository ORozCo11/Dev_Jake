<?php

namespace Database\Seeders;

use App\Models\City;
use Illuminate\Database\Seeder;

class CityBoundarySeeder extends Seeder
{
    /**
     * Seed the application's database.
     *
     * Boundary polygons for the Vehicle Location map's barangay/city
     * selector — sourced from faeldon/philippines-json-maps (built from the
     * PSA's PSGC shapefiles, Dec 2023), matched to our `cities` rows by
     * PSGC code. Coverage is ~98.5% (1610/1634) — the ~24 gaps are other
     * independent cities (Cebu City, Davao City, etc., alongside Mandaue
     * City) that this source also doesn't carry a standalone city-level
     * shape for; those simply keep `boundary` null and the map falls back
     * to its default Paknaan outline when selected. Must run after
     * CitySeeder.
     */
    public function run(): void
    {
        $path = database_path('data/city-boundaries.json');
        $entries = json_decode(file_get_contents($path), true);

        $updated = 0;
        foreach ($entries as $entry) {
            if (!$entry['geometry']) {
                continue;
            }

            $updated += City::where('code', $entry['code'])
                ->update([
                    'boundary' => $entry['geometry'],
                    'boundary_source' => 'philippines-json-maps',
                    'boundary_verified_at' => now(),
                ]);
        }

        $this->command?->info("City boundaries linked: {$updated}");
    }
}
