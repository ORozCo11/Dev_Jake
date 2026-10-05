<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleMaintenanceRecord;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Gap 2 — recurring preventive maintenance + closing the loop between a
 * schedule and the record that proves it was done.
 */
class ScheduleCompletionTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $mechanic;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel']]);
    }

    private function vehicle(): Vehicle
    {
        $category = VehicleCategory::create(['category_name' => 'Ambulance ' . uniqid(), 'description' => 'x']);
        return Vehicle::create([
            'vehicle_name' => 'Test Ambulance',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
            'capacity' => '12 pax', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
        ]);
    }

    private function schedule(Vehicle $vehicle, array $overrides = []): VehicleMaintenanceSchedule
    {
        return VehicleMaintenanceSchedule::create(array_merge([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->toDateString(),
            'status' => 'Scheduled',
            'created_by' => $this->admin->id,
        ], $overrides));
    }

    #[Test]
    public function completing_a_schedule_marks_it_done_and_creates_a_linked_record(): void
    {
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle, ['assigned_to' => $this->mechanic->id]); // one-off (no recurrence)

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [
            'maintenance_cost' => 800,
        ])->assertOk();

        // Schedule closed...
        $this->assertSame('Completed', $schedule->fresh()->status);
        // ...and a matching maintenance record now exists (proof of work),
        // always 'For Verification' — pending the same independent
        // Custodian check every other maintenance path requires.
        $this->assertDatabaseHas('vehicle_maintenance_records', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'progress_status' => 'For Verification',
        ]);
        // The vehicle reflects an open maintenance item until that check happens.
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
        // A one-off schedule does NOT spawn a follow-up.
        $this->assertSame(1, VehicleMaintenanceSchedule::where('vehicle_id', $vehicle->vehicle_id)->count());
    }

    #[Test]
    public function attaching_a_receipt_does_not_bypass_custodian_verification(): void
    {
        // Production-readiness final stabilization pass (2026-10-05, P0) —
        // a receipt/photo is supporting evidence only; it must never
        // silently finalize a schedule without an independent Custodian
        // check, even with proof attached.
        \Illuminate\Support\Facades\Storage::fake('supabase');
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle, ['assigned_to' => $this->mechanic->id]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->put("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [
            'maintenance_cost' => 800,
            'receipt' => \Illuminate\Http\UploadedFile::fake()->create('receipt.pdf', 50, 'application/pdf'),
        ])->assertOk();

        $record = VehicleMaintenanceRecord::where('vehicle_id', $vehicle->vehicle_id)->firstOrFail();
        $this->assertNotNull($record->receipt_url, 'The receipt should still be attached as evidence.');
        $this->assertSame('For Verification', $record->progress_status);
        $this->assertNull($record->verification_result);
        $this->assertNull($record->confirmed_by);
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
    }

    #[Test]
    public function completing_a_recurring_schedule_auto_creates_the_next_one(): void
    {
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle, [
            'scheduled_date' => '2026-07-20',
            'recurrence_months' => 3,
            'assigned_to' => $this->mechanic->id,
        ]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $response = $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [
            'date_completed' => '2026-07-20',
        ])->assertOk();

        // The next occurrence is seeded 3 months out, still recurring.
        $next = $response->json('next');
        $this->assertNotNull($next, 'A recurring schedule should seed the next occurrence.');
        $this->assertSame('2026-10-20', substr($next['scheduled_date'], 0, 10));
        $this->assertSame(3, $next['recurrence_months']);
        $this->assertSame('Scheduled', $next['status']);

        // Two schedules now exist: the completed one + the next.
        $this->assertSame(2, VehicleMaintenanceSchedule::where('vehicle_id', $vehicle->vehicle_id)->count());
    }

    #[Test]
    public function completing_a_schedule_dated_jan_31_does_not_skip_february(): void
    {
        // Regression: Carbon::addMonths() overflows past a shorter target
        // month (2026-01-31 + 1 month = 2026-03-03, since Feb has no 31st)
        // instead of clamping. addMonthsNoOverflow() clamps to 2026-02-28
        // (2026 is not a leap year), which is what a monthly recurrence
        // dated on the 31st should produce.
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle, [
            'scheduled_date' => '2026-01-31',
            'recurrence_months' => 1,
            'assigned_to' => $this->mechanic->id,
        ]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $response = $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [
            'date_completed' => '2026-01-31',
        ])->assertOk();

        $next = $response->json('next');
        $this->assertNotNull($next, 'A recurring schedule should seed the next occurrence.');
        $this->assertSame('2026-02-28', substr($next['scheduled_date'], 0, 10));
    }

    #[Test]
    public function completing_a_schedule_dated_jan_31_in_a_leap_year_lands_on_feb_29(): void
    {
        // Same overflow scenario, but 2028 IS a leap year, so the correctly
        // clamped next occurrence is 2028-02-29, not 2028-03-02 (overflow)
        // and not 2028-02-28 (which would be wrong here too).
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle, [
            'scheduled_date' => '2028-01-31',
            'recurrence_months' => 1,
            'assigned_to' => $this->mechanic->id,
        ]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $response = $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [
            'date_completed' => '2028-01-31',
        ])->assertOk();

        $next = $response->json('next');
        $this->assertNotNull($next, 'A recurring schedule should seed the next occurrence.');
        $this->assertSame('2028-02-29', substr($next['scheduled_date'], 0, 10));
    }

    #[Test]
    public function an_already_completed_schedule_cannot_be_completed_again(): void
    {
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle, ['status' => 'Completed', 'assigned_to' => $this->mechanic->id]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [])
            ->assertUnprocessable();
    }

    #[Test]
    public function a_custodian_cannot_complete_a_schedule(): void
    {
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        Sanctum::actingAs($custodian, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [])
            ->assertForbidden();
    }

    #[Test]
    public function an_admin_cannot_complete_a_schedule_directly_and_must_reassign_it_instead(): void
    {
        // Final senior system review (2026-10-05, §2/§12) — "complete" means
        // physically performed the maintenance, and Admin never performs
        // repair work in this system. Previously Admin could complete ANY
        // schedule (even unassigned, silently recording themselves as the
        // performer); now only the assigned Maintenance Personnel can, and
        // Admin's recourse for a stuck/unassigned schedule is reassigning it.
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle, ['assigned_to' => $this->mechanic->id]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [])
            ->assertForbidden();

        $another = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel']]);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/reassign", [
            'assigned_to' => $another->id,
        ])->assertOk();

        Sanctum::actingAs($another, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [])
            ->assertOk();
    }

    #[Test]
    public function maintenance_personnel_can_complete_their_assigned_schedule(): void
    {
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle, ['assigned_to' => $this->mechanic->id]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [
            'maintenance_personnel_id' => $this->mechanic->id,
            'maintenance_cost' => 500,
        ])->assertOk();

        $this->assertSame('Completed', $schedule->fresh()->status);
    }

    #[Test]
    public function a_new_schedule_always_starts_scheduled_even_if_a_different_status_is_submitted(): void
    {
        $vehicle = $this->vehicle();
        // Admin creates schedules (spec §19); this test only cares about the
        // status-ignored behavior.
        $custodian = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);

        Sanctum::actingAs($custodian, ['*']);
        $response = $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addDay()->toDateString(),
            'status' => 'Completed', // must be silently ignored — not a valid create input
        ])->assertCreated();

        $this->assertSame('Scheduled', $response->json('status'));
    }

    #[Test]
    public function marking_a_schedule_completed_through_the_raw_update_endpoint_is_rejected(): void
    {
        // Completing must go through completeSchedule() (creates the proof-of-
        // work record and, if recurring, the next occurrence). The plain edit
        // form must not be able to silently skip both.
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", [
            'status' => 'Completed',
        ])->assertUnprocessable();

        $this->assertSame('Scheduled', $schedule->fresh()->status);
    }

    #[Test]
    public function a_schedule_can_still_be_cancelled_through_the_update_endpoint(): void
    {
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", [
            'status' => 'Cancelled',
        ])->assertOk();

        $this->assertSame('Cancelled', $schedule->fresh()->status);
    }
}
