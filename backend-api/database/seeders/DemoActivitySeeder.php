<?php

namespace Database\Seeders;

use App\Models\Barangay;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleReadinessCheck;
use Illuminate\Database\Seeder;

/**
 * Demo activity on top of MockDataSeeder's vehicles: condition-monitoring
 * history and recent readiness checks, so the dashboards and Condition
 * Monitoring page show real-looking data instead of "Never checked".
 *
 * Safe to re-run (php artisan db:seed --class=DemoActivitySeeder): rows are
 * matched on vehicle + text and updated in place, never duplicated. A
 * readiness check only counts as fresh for 24 hours, so re-running also
 * moves the readiness checks back to "today".
 */
class DemoActivitySeeder extends Seeder
{
    private const READINESS_NOTE = 'Demo data — daily pre-shift check.';

    public function run(): void
    {
        $paknaanId = Barangay::where('name', 'Paknaan')->value('id');
        $custodian = User::where('email', 'custodian@barangay.gov')->first()
            ?? User::where('role', 'Custodian')->first();

        if (!$paknaanId || !$custodian) {
            $this->command?->error('Run UserSeeder and MockDataSeeder first.');
            return;
        }

        $vehicles = Vehicle::withoutGlobalScopes()
            ->with('category')
            ->where('barangay_id', $paknaanId)
            ->whereNotIn('status', ['Inactive', 'Decommissioned'])
            ->orderBy('vehicle_id')
            ->get();

        foreach ($vehicles as $i => $vehicle) {
            $this->seedConditionChecks($vehicle, $custodian->id, $i);
            $this->seedReadinessCheck($vehicle, $custodian->id, $i);
        }

        $this->command?->info("Demo condition and readiness checks seeded for {$vehicles->count()} vehicles.");
    }

    // An older routine check (always Good) plus a latest check that agrees
    // with the vehicle's current condition, so the page and the vehicle
    // record never contradict each other.
    private function seedConditionChecks(Vehicle $vehicle, int $checkedBy, int $i): void
    {
        $type = strtolower($vehicle->category?->category_name ?? '');

        $routine = str_contains($type, 'fire')
            ? 'Weekly check: pump primes, hoses and nozzles intact, water tank full, lights and siren working.'
            : (str_contains($type, 'ambulance')
                ? 'Weekly check: oxygen tanks full, stretcher locks secure, lights and siren working, tires at pressure.'
                : 'Weekly check: engine starts clean, no warning lights, tires and fluids OK.');

        $latest = match ($vehicle->condition) {
            'Needs Repair' => [
                'Needs Repair',
                str_contains($type, 'fire')
                    ? 'Pump loses pressure after a few minutes of use; not safe for a fire response.'
                    : 'Brake pedal feels soft and stopping distance is long; keep off response runs until repaired.',
            ],
            'Needs Inspection' => [
                'Needs Inspection',
                'Slight vibration above 60 km/h and a faint grinding sound on turns — needs a mechanic to look at it.',
            ],
            default => [
                'Good',
                'Walk-around done: body, lights, tires and fluids all fine. Ready for duty.',
            ],
        };

        $this->upsertCondition($vehicle->vehicle_id, 'Good', $routine, $checkedBy, now()->subDays(9 + ($i % 4))->setTime(0, 30));
        $this->upsertCondition($vehicle->vehicle_id, $latest[0], $latest[1], $checkedBy, now()->subDays(1 + ($i % 3))->setTime(0, 15));
    }

    // Times are stored in UTC — 00:15/00:30 UTC is a morning check (8 AM) in the Philippines.
    private function upsertCondition(int $vehicleId, string $result, string $observations, int $checkedBy, $at): void
    {
        $check = VehicleConditionCheck::withoutGlobalScopes()->updateOrCreate(
            ['vehicle_id' => $vehicleId, 'observations' => $observations],
            ['condition_result' => $result, 'checked_by' => $checkedBy],
        );
        $check->timestamps = false;
        $check->forceFill(['created_at' => $at, 'updated_at' => $at])->save();
    }

    // One readiness check per vehicle within the last day. A vehicle that is
    // currently down shows its "in maintenance" state regardless.
    private function seedReadinessCheck(Vehicle $vehicle, int $checkedBy, int $i): void
    {
        VehicleReadinessCheck::withoutGlobalScopes()->updateOrCreate(
            ['vehicle_id' => $vehicle->vehicle_id, 'notes' => self::READINESS_NOTE],
            [
                'checked_by' => $checkedBy,
                'checklist'  => [['item' => 'Personally operated and confirmed ready to respond', 'passed' => true]],
                'all_passed' => true,
                'checked_at' => now()->subHours(1 + ($i % 8)),
            ],
        );
    }
}
