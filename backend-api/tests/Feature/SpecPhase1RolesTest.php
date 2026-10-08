<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleIssueReport;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Phase 1 of the 2026-10-06 spec: Admin can't report issues, Maintenance
 * recommends (not creates) tickets, Admin requests a Custodian inspection
 * instead, and a Custodian suggests (not books) a schedule.
 */
class SpecPhase1RolesTest extends TestCase
{
    use RefreshDatabase;

    private int $barangayId;
    private User $admin;
    private User $custodian;
    private User $mechanic;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangayId = Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id])->id;
        foreach (['admin' => 'Admin', 'custodian' => 'Custodian', 'mechanic' => 'Maintenance Personnel'] as $prop => $role) {
            $this->$prop = User::factory()->create(['role' => $role, 'roles' => [$role], 'barangay_id' => $this->barangayId]);
        }
    }

    private function vehicle(?int $barangayId = null): Vehicle
    {
        $category = VehicleCategory::create(['category_name' => 'Ambulance ' . uniqid(), 'description' => 'x']);

        return Vehicle::create([
            'vehicle_name' => 'Fire Truck Uno',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
            'capacity' => '1000 kg', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
            'barangay_id' => $barangayId ?? $this->barangayId,
        ]);
    }

    private function issue(Vehicle $vehicle): VehicleIssueReport
    {
        return VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id, 'issue_type' => 'Brake Problem',
            'issue_description' => 'Soft pedal.', 'severity_level' => 'High',
            'reported_by' => $this->custodian->id, 'status' => 'Pending',
        ]);
    }

    #[Test]
    public function admin_cannot_report_an_issue_but_custodian_and_maintenance_can(): void
    {
        $vehicle = $this->vehicle();
        $payload = [
            'vehicle_id' => $vehicle->vehicle_id, 'issue_type' => 'Brake Problem',
            'issue_description' => 'Soft pedal.', 'severity_level' => 'High',
        ];

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/issues', $payload)->assertForbidden();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/issues', $payload)->assertCreated();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson('/api/issues', $payload)->assertCreated();
    }

    #[Test]
    public function maintenance_can_recommend_a_ticket_and_the_custodian_is_pointed_at_the_exact_issue(): void
    {
        $issue = $this->issue($this->vehicle());

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson("/api/issues/{$issue->issue_report_id}/recommend-ticket", ['note' => 'Pads are gone.'])->assertCreated();

        $this->assertDatabaseHas('notifications', [
            'user_id' => $this->custodian->id,
            'type' => 'ticket_recommended',
            'issue_report_id' => $issue->issue_report_id,
        ]);
        $this->assertDatabaseMissing('notifications', ['user_id' => $this->admin->id, 'type' => 'ticket_recommended']);
    }

    #[Test]
    public function only_maintenance_can_recommend_and_a_ticketed_issue_cannot_be_recommended_again(): void
    {
        $issue = $this->issue($this->vehicle());

        foreach ([$this->admin, $this->custodian] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->postJson("/api/issues/{$issue->issue_report_id}/recommend-ticket")->assertForbidden();
        }

        $issue->update(['status' => 'In Maintenance']);
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson("/api/issues/{$issue->issue_report_id}/recommend-ticket")->assertUnprocessable();
    }

    #[Test]
    public function requesting_an_inspection_is_now_a_dead_endpoint_for_everyone(): void
    {
        // vehicle.request_inspection's ability grant is now [] (deprecated
        // workflow, config/permissions.php) — an Admin who suspects a
        // problem can no longer start a standalone inspection from the live
        // application; condition history remains readable, but nothing can
        // reach this endpoint any more, including Admin.
        $vehicle = $this->vehicle();

        foreach ([$this->admin, $this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->postJson("/api/vehicles/{$vehicle->vehicle_id}/request-inspection", ['note' => 'Smells like fuel.'])->assertForbidden();
        }

        $this->assertDatabaseCount('notifications', 0);
        $this->assertDatabaseCount('vehicle_issue_reports', 0);
        $this->assertDatabaseCount('maintenance_tickets', 0);
    }

    #[Test]
    public function only_admin_can_request_an_inspection_and_other_barangays_vehicles_are_out_of_reach(): void
    {
        $vehicle = $this->vehicle();

        foreach ([$this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->postJson("/api/vehicles/{$vehicle->vehicle_id}/request-inspection")->assertForbidden();
        }

        $otherProvince = Province::create(['code' => 'OTH', 'name' => 'Other Province']);
        $otherCity = City::create(['province_id' => $otherProvince->id, 'code' => 'OTHC', 'name' => 'Other City']);
        $otherBarangay = Barangay::create(['name' => 'Other Barangay', 'city_id' => $otherCity->id])->id;
        $foreign = $this->vehicle($otherBarangay);

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson("/api/vehicles/{$foreign->vehicle_id}/request-inspection")->assertNotFound();
    }

    #[Test]
    public function suggesting_a_schedule_is_now_a_dead_endpoint_for_everyone(): void
    {
        // schedule.suggest's ability grant is now [] (config/permissions.php,
        // streamlined-workflow spec 2026-10-12) — creating a schedule
        // directly is a standard Custodian duty now (schedule.create), so
        // the old "propose, Admin books it" detour no longer exists.
        $vehicle = $this->vehicle();
        $payload = ['vehicle_id' => $vehicle->vehicle_id, 'maintenance_type' => 'Brake Inspection'];

        foreach ([$this->mechanic, $this->custodian, $this->admin] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->postJson('/api/maintenance-schedules/suggest', $payload)->assertForbidden();
        }

        $this->assertDatabaseCount('vehicle_maintenance_schedules', 0);
    }
}
