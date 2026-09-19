<?php

namespace Database\Seeders;

use App\Models\Barangay;
use App\Models\City;
use App\Models\RegistrationSetting;
use Illuminate\Database\Seeder;

class BarangaySeeder extends Seeder
{
    /**
     * The 27 barangays of Mandaue City, Cebu — the LGU this VMS instance
     * serves (see the Paknaan hub/map data already in the frontend).
     */
    private const BARANGAYS = [
        'Alang-alang',
        'Bakilid',
        'Banilad',
        'Basak',
        'Cabancalan',
        'Cambaro',
        'Canduman',
        'Casili',
        'Casuntingan',
        'Centro (Poblacion)',
        'Cubacub',
        'Guizo',
        'Ibabao-Estancia',
        'Jagobiao',
        'Labogon',
        'Looc',
        'Maguikay',
        'Mantuyong',
        'Opao',
        'Pagsabungan',
        'Paknaan',
        'Subangdaku',
        'Tabok',
        'Tawason',
        'Tingub',
        'Tipolo',
        'Umapad',
    ];

    /**
     * Seed the application's database. Must run after CitySeeder — links
     * every barangay to the "Mandaue City" row so the Register form can
     * tell which selected city has a real barangay list to offer.
     *
     * Also gives every one of these real barangays its Staff Registration
     * Code up front (firstOrCreate — re-running this seeder never rotates a
     * code that's already been handed out). Registration now requires this
     * code even from the very first person to register for a barangay, so
     * without it here, nobody could ever complete that first registration —
     * whoever runs this seeder is responsible for getting each printed code
     * to that barangay's actual office.
     */
    public function run(): void
    {
        $mandaueCityId = City::where('name', 'Mandaue City')->value('id');

        foreach (self::BARANGAYS as $name) {
            // Scoped to the city, never name alone: once the nationwide
            // barangay import has run, names like "Basak" or "Looc" exist in
            // hundreds of cities, and a name-only match would seize one of
            // those rows and drag it into Mandaue — taking any user already
            // registered under it along with it.
            $barangay = Barangay::firstOrCreate(['city_id' => $mandaueCityId, 'name' => $name]);

            $code = RegistrationSetting::for($barangay->id)->staff_code;
            $this->command?->info("{$name}: {$code}");
        }
    }
}
