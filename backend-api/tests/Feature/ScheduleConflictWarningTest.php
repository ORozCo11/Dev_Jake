<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * FleetController::checkScheduleConflicts() — a barangay's daily volume of
 * Scheduled entries never blocks a new booking, only warns past
 * config('scheduling.daily_volume_warning_threshold'). Same-vehicle
 * double-booking gets the identical treatment — see the dedicated test in
 * TicketWorkflowTest for that half; this file covers the daily-volume half
 * and the two combined.
 */
class ScheduleConflictWarningTest extends TestCase
{
    use RefreshDatabase;

    private int $barangayId;
    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangayId = Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id])->id;
        $this->admin = User::factory()->create([
            'role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangayId,
        ]);
    }

    private function vehicle(): Vehicle
    {
        $category = VehicleCategory::create(['category_name' => 'Ambulance ' . uniqid(), 'description' => 'x']);

        return Vehicle::create([
            'vehicle_name' => 'Test Ambulance',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
            'capacity' => '1000 kg', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
            'barangay_id' => $this->barangayId,
        ]);
    }

    #[Test]
    public function a_quiet_day_has_no_warning_at_all(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => '2026-08-01',
        ])->assertCreated();
    }

    #[Test]
    public function crossing_the_daily_volume_threshold_warns_but_a_confirm_proceeds(): void
    {
        $threshold = config('scheduling.daily_volume_warning_threshold');

        // Fill the day up to (but not past) the threshold directly — a
        // different vehicle each time, so this is purely about DAILY VOLUME,
        // not the separate same-vehicle rule.
        for ($i = 0; $i < $threshold; $i++) {
            VehicleMaintenanceSchedule::create([
                'vehicle_id' => $this->vehicle()->vehicle_id,
                'maintenance_type' => 'Oil Change',
                'scheduled_date' => '2026-08-01',
                'created_by' => $this->admin->id,
                'status' => 'Scheduled',
            ]);
        }

        Sanctum::actingAs($this->admin, ['*']);
        $newVehicle = $this->vehicle();

        $warned = $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $newVehicle->vehicle_id,
            'maintenance_type' => 'Tire Rotation',
            'scheduled_date' => '2026-08-01',
        ])->assertStatus(409);

        $this->assertFalse($warned->json('same_vehicle_conflict'));
        $this->assertSame($threshold, $warned->json('daily_volume_count'));
        $this->assertDatabaseCount('vehicle_maintenance_schedules', $threshold);

        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $newVehicle->vehicle_id,
            'maintenance_type' => 'Tire Rotation',
            'scheduled_date' => '2026-08-01',
            'confirm_conflicts' => true,
        ])->assertCreated();
        $this->assertDatabaseCount('vehicle_maintenance_schedules', $threshold + 1);
    }

    #[Test]
    public function a_different_barangays_bookings_do_not_count_toward_this_barangays_daily_volume(): void
    {
        $threshold = config('scheduling.daily_volume_warning_threshold');

        $otherCity = City::create(['province_id' => Province::first()->id, 'code' => 'OTHC', 'name' => 'Other City']);
        $otherBarangayId = Barangay::create(['name' => 'Other Barangay', 'city_id' => $otherCity->id])->id;
        $otherVehicleCategory = VehicleCategory::create(['category_name' => 'Van ' . uniqid(), 'description' => 'x']);

        for ($i = 0; $i < $threshold; $i++) {
            VehicleMaintenanceSchedule::create([
                'vehicle_id' => Vehicle::create([
                    'vehicle_name' => 'Other Barangay Vehicle',
                    'plate_number' => 'OTH ' . random_int(1000, 9999),
                    'category_id' => $otherVehicleCategory->category_id,
                    'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
                    'capacity' => '1000 kg', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
                    'barangay_id' => $otherBarangayId,
                ])->vehicle_id,
                'maintenance_type' => 'Oil Change',
                'scheduled_date' => '2026-08-01',
                'created_by' => $this->admin->id,
                'status' => 'Scheduled',
            ]);
        }

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'maintenance_type' => 'Tire Rotation',
            'scheduled_date' => '2026-08-01',
        ])->assertCreated();
    }

    #[Test]
    public function moving_a_schedule_into_a_busy_day_warns_the_same_way_on_update(): void
    {
        $threshold = config('scheduling.daily_volume_warning_threshold');

        for ($i = 0; $i < $threshold; $i++) {
            VehicleMaintenanceSchedule::create([
                'vehicle_id' => $this->vehicle()->vehicle_id,
                'maintenance_type' => 'Oil Change',
                'scheduled_date' => '2026-08-01',
                'created_by' => $this->admin->id,
                'status' => 'Scheduled',
            ]);
        }

        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $this->vehicle()->vehicle_id,
            'maintenance_type' => 'Brake Check',
            'scheduled_date' => '2026-09-01',
            'created_by' => $this->admin->id,
            'status' => 'Scheduled',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", [
            'scheduled_date' => '2026-08-01',
        ])->assertStatus(409);

        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", [
            'scheduled_date' => '2026-08-01',
            'confirm_conflicts' => true,
        ])->assertOk();
        $this->assertStringStartsWith('2026-08-01', (string) $schedule->fresh()->scheduled_date);
    }
}
