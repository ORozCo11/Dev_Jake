<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleDocument;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceRecord;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase B4 — tightens Custodian/Maintenance
 * Personnel down to the target role model: condition-check delete and
 * document delete become Admin-only (edit narrows to "own row" for
 * Custodian); standalone Maintenance Records and Maintenance Schedules
 * become Admin-only to create; Maintenance Personnel loses issue-report
 * edit entirely; catalog values (fault categories, maintenance types)
 * become Admin-only to create.
 */
class PhaseB4RoleModelTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private User $otherCustodian;
    private User $mechanic;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $this->custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $this->otherCustodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel']]);
    }

    private function vehicle(): Vehicle
    {
        $category = VehicleCategory::create([
            'category_name' => 'Ambulance ' . uniqid(),
            'description' => 'For testing',
        ]);

        return Vehicle::create([
            'vehicle_name' => 'Test Ambulance',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota',
            'model' => 'HiAce',
            'year_model' => 2022,
            'capacity' => '1000 kg',
            'vehicle_color' => 'White',
            'current_location' => 'Main Depot',
        ]);
    }

    // =======================================================================
    // Condition checks — delete narrowed to Admin only; edit narrowed to
    // "own row" for Custodian
    // =======================================================================

    #[Test]
    public function a_custodian_can_edit_a_condition_check_they_performed_themselves(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/conditions/{$condition->condition_check_id}", [
            'observations' => 'Updated by the checker.',
        ])->assertOk();
    }

    #[Test]
    public function a_custodian_cannot_edit_a_condition_check_performed_by_someone_else(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
            'checked_by' => $this->otherCustodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/conditions/{$condition->condition_check_id}", [
            'observations' => 'Trying to edit someone else\'s check.',
        ])->assertForbidden();
    }

    #[Test]
    public function admin_can_no_longer_record_or_edit_a_condition_check(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/conditions/{$condition->condition_check_id}", [
            'observations' => 'Admin override.',
        ])->assertForbidden();
        $this->postJson('/api/conditions', [
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
        ])->assertForbidden();
    }

    #[Test]
    public function a_custodian_can_no_longer_delete_any_condition_check(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->deleteJson("/api/conditions/{$condition->condition_check_id}")->assertForbidden();
    }

    #[Test]
    public function admin_can_still_delete_a_condition_check(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/conditions/{$condition->condition_check_id}")->assertOk();
    }

    // =======================================================================
    // Vehicle documents — final stabilization pass (2026-10-05, P0):
    // Maintenance Personnel has NO access at all now, not even view;
    // Custodian may edit only their own upload; delete is Admin-only.
    // =======================================================================

    #[Test]
    public function maintenance_personnel_cannot_upload_a_document(): void
    {
        Storage::fake('supabase');
        $vehicle = $this->vehicle();
        $file = UploadedFile::fake()->create('registration.pdf', 50, 'application/pdf');

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson("/api/vehicles/{$vehicle->vehicle_id}/documents", [
            'title' => 'Registration',
            'file' => $file,
        ])->assertForbidden();
    }

    #[Test]
    public function maintenance_personnel_cannot_even_view_vehicle_documents(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->getJson("/api/vehicles/{$vehicle->vehicle_id}/documents")->assertForbidden();
    }

    #[Test]
    public function admin_and_custodian_can_view_vehicle_documents(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        $this->getJson("/api/vehicles/{$vehicle->vehicle_id}/documents")->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->getJson("/api/vehicles/{$vehicle->vehicle_id}/documents")->assertOk();
    }

    #[Test]
    public function a_custodian_can_upload_a_document(): void
    {
        Storage::fake('supabase');
        $vehicle = $this->vehicle();
        $file = UploadedFile::fake()->create('registration.pdf', 50, 'application/pdf');

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson("/api/vehicles/{$vehicle->vehicle_id}/documents", [
            'title' => 'Registration',
            'file' => $file,
        ])->assertCreated();
    }

    #[Test]
    public function a_custodian_can_edit_a_document_they_uploaded_themselves(): void
    {
        $vehicle = $this->vehicle();
        $document = VehicleDocument::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'title' => 'Registration',
            'file_url' => 'documents/test.pdf',
            'added_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/documents/{$document->document_id}", [
            'title' => 'Updated title',
        ])->assertOk();
    }

    #[Test]
    public function a_custodian_cannot_edit_a_document_uploaded_by_someone_else(): void
    {
        $vehicle = $this->vehicle();
        $document = VehicleDocument::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'title' => 'Registration',
            'file_url' => 'documents/test.pdf',
            'added_by' => $this->otherCustodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/documents/{$document->document_id}", [
            'title' => 'Trying to edit someone else\'s upload',
        ])->assertForbidden();
    }

    #[Test]
    public function a_custodian_can_no_longer_delete_any_document(): void
    {
        $vehicle = $this->vehicle();
        $document = VehicleDocument::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'title' => 'Registration',
            'file_url' => 'documents/test.pdf',
            'added_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->deleteJson("/api/documents/{$document->document_id}")->assertForbidden();
    }

    #[Test]
    public function admin_can_still_delete_a_document(): void
    {
        $vehicle = $this->vehicle();
        $document = VehicleDocument::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'title' => 'Registration',
            'file_url' => 'documents/test.pdf',
            'added_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/documents/{$document->document_id}")->assertOk();
    }

    // =======================================================================
    // Maintenance Records — Admin-only to create/edit now
    // =======================================================================

    #[Test]
    public function a_custodian_can_no_longer_create_a_standalone_maintenance_record(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/maintenance-records', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Routine oil change',
        ])->assertForbidden();
    }

    #[Test]
    public function admin_can_still_create_a_standalone_maintenance_record(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/maintenance-records', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Routine oil change',
            'maintenance_personnel_id' => $this->mechanic->id,
        ])->assertCreated();
    }

    #[Test]
    public function a_custodian_can_no_longer_edit_a_maintenance_record(): void
    {
        $vehicle = $this->vehicle();
        $record = VehicleMaintenanceRecord::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Routine oil change.',
            'maintenance_personnel_id' => $this->mechanic->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-records/{$record->maintenance_id}", [
            'problem_reason' => 'Trying to edit.',
        ])->assertForbidden();
    }

    // =======================================================================
    // Maintenance Schedules — REVERSED after this test file was first
    // written: Custodian creates directly now (they have the day-to-day
    // visibility a booking decision needs); Admin keeps oversight
    // (edit/cancel/reassign) but no longer originates one directly.
    // =======================================================================

    #[Test]
    public function a_custodian_can_create_a_maintenance_schedule(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
        ])->assertCreated();
    }

    #[Test]
    public function maintenance_personnel_still_cannot_create_a_maintenance_schedule(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
        ])->assertForbidden();
    }

    #[Test]
    public function admin_can_no_longer_create_a_maintenance_schedule_directly(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
        ])->assertForbidden();
    }

    #[Test]
    public function admin_can_still_edit_any_schedule_though_not_create_one(): void
    {
        $vehicle = $this->vehicle();
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", [
            'notes' => 'Admin oversight edit.',
        ])->assertOk();
    }

    #[Test]
    public function a_custodian_can_edit_a_schedule_they_created_themselves(): void
    {
        $vehicle = $this->vehicle();
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", [
            'notes' => 'Fixing a typo.',
        ])->assertOk();
    }

    #[Test]
    public function a_custodian_cannot_edit_a_schedule_created_by_someone_else(): void
    {
        $otherCustodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $vehicle = $this->vehicle();
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $otherCustodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}", [
            'notes' => 'Trying to edit someone else\'s schedule.',
        ])->assertForbidden();
    }

    // schedule.suggest / suggestSchedule() removed in the final stabilization
    // pass (2026-10-05, P1) — confirmed zero frontend callers (the
    // Condition Monitoring "Suggest Schedule from Condition" action uses the
    // normal POST /maintenance-schedules create endpoint, pre-filled, not
    // this one), matching the dead-code note that used to sit on the ability
    // in config/permissions.php.

    // =======================================================================
    // Issue reports — Maintenance Personnel loses edit entirely; Custodian's
    // own-report-while-Pending path is unaffected
    // =======================================================================

    #[Test]
    public function maintenance_personnel_can_no_longer_edit_an_issue_report(): void
    {
        $vehicle = $this->vehicle();
        $issue = VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Flat tire',
            'issue_description' => 'Front-left tire flat.',
            'reported_by' => $this->mechanic->id,
        ]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/issues/{$issue->issue_report_id}", [
            'status' => 'In Maintenance',
        ])->assertForbidden();
    }

    #[Test]
    public function a_custodian_can_still_edit_their_own_pending_issue_report(): void
    {
        $vehicle = $this->vehicle();
        $issue = VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Flat tire',
            'issue_description' => 'Front-left tire flat.',
            'reported_by' => $this->custodian->id,
            'status' => 'Pending',
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/issues/{$issue->issue_report_id}", [
            'issue_description' => 'Updated description.',
        ])->assertOk();
    }

    // =======================================================================
    // Catalogs — Admin-only to create now (everyone else picks "Other" +
    // a note in the UI, no backend catalog row is minted)
    // =======================================================================

    #[Test]
    public function a_custodian_can_no_longer_create_a_fault_category(): void
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/fault-categories', ['name' => 'New Fault ' . uniqid()])->assertForbidden();
    }

    #[Test]
    public function maintenance_personnel_can_no_longer_create_a_maintenance_type(): void
    {
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson('/api/maintenance-types', ['name' => 'New Type ' . uniqid()])->assertForbidden();
    }

    #[Test]
    public function admin_can_still_create_a_fault_category(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/fault-categories', ['name' => 'New Fault ' . uniqid()])->assertCreated();
    }
}
