<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    /**
     * Seed the application's database.
     *
     * Seeding stays offline. Barangay outlines come from `boundaries:import`,
     * a separate setup step that reaches the network — run it after seeding
     * (see docs/MAP_BOUNDARIES.md).
     */
    public function run(): void
    {
        // Call your custom UserSeeder class
        $this->call([
            ProvinceSeeder::class,
            CitySeeder::class,
            CityBoundarySeeder::class,
            BarangaySeeder::class,
            UserSeeder::class,
            FleetReferenceSeeder::class,
            MockDataSeeder::class,
        ]);
    }
}
