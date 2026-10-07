<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleMaintenanceRecord;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Final stabilization pass (2026-10-05, P0) — a receipt or photo is
 * supporting evidence only. It must never let a standalone Maintenance
 * Record skip independent Custodian verification, even when Admin is the
 * one attaching it. The required chain is always:
 *
 *   Logged (Assigned/Under Repair) -> For Verification (Custodian passes
 *   it) -> Completed (Admin confirms, via confirmMaintenance()).
 */
class MaintenanceRecordVerificationBypassTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private User $mechanic;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $this->custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
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
            'capacity' => '1000 kg', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
        ]);
    }

    #[Test]
    public function creating_a_record_with_a_receipt_cannot_skip_straight_to_completed(): void
    {
        Storage::fake('supabase');
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->post('/api/maintenance-records', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Scheduled service.',
            'maintenance_personnel_id' => $this->mechanic->id,
            'progress_status' => 'Completed',
            'receipt' => UploadedFile::fake()->create('receipt.pdf', 50, 'application/pdf'),
        ])->assertCreated();

        $record = VehicleMaintenanceRecord::findOrFail($response->json('maintenance_id'));
        $this->assertSame('For Verification', $record->progress_status);
        $this->assertNotNull($record->receipt_url, 'The receipt should still be attached as evidence.');
        $this->assertNull($record->verification_result);
        $this->assertNull($record->confirmed_by);
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
    }

    #[Test]
    public function editing_a_record_to_completed_with_a_receipt_is_rejected_without_verification(): void
    {
        Storage::fake('supabase');
        $vehicle = $this->vehicle();
        $record = VehicleMaintenanceRecord::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Scheduled service.',
            'maintenance_personnel_id' => $this->mechanic->id,
            'progress_status' => 'Under Repair',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->put("/api/maintenance-records/{$record->maintenance_id}", [
            'progress_status' => 'Completed',
            'receipt' => UploadedFile::fake()->create('receipt.pdf', 50, 'application/pdf'),
        ])->assertStatus(422);

        $this->assertSame('Under Repair', $record->fresh()->progress_status);
    }

    #[Test]
    public function completing_a_record_still_works_through_the_dedicated_confirm_action_after_verification_passes(): void
    {
        $vehicle = $this->vehicle();
        $record = VehicleMaintenanceRecord::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Scheduled service.',
            'maintenance_personnel_id' => $this->mechanic->id,
            'progress_status' => 'For Verification',
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}/verify", [
            'verification_result' => 'Passed',
        ])->assertOk();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}/confirm", [
            'confirmed' => true,
        ])->assertOk();

        $record->refresh();
        $this->assertSame('Completed', $record->progress_status);
        $this->assertSame($this->admin->id, $record->confirmed_by);
        $this->assertSame('Available', $vehicle->fresh()->status);
    }
}
