<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\MaintenanceTicket;
use App\Models\Notification;
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
 * Admin's next step on an open issue report that needs no ticket: dismiss it
 * with a reason.
 */
class IssueNextStepTest extends TestCase
{
    use RefreshDatabase;

    private int $barangayId;
    private User $admin;
    private User $custodian;
    private User $otherCustodian;
    private User $mechanic;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangayId = Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id])->id;
        $this->admin = $this->user('Admin');
        $this->custodian = $this->user('Custodian');
        $this->otherCustodian = $this->user('Custodian');
        $this->mechanic = $this->user('Maintenance Personnel');
    }

    private function user(string $role): User
    {
        return User::factory()->create(['role' => $role, 'roles' => [$role], 'barangay_id' => $this->barangayId, 'is_active' => true]);
    }

    private function issue(string $status = 'Pending'): VehicleIssueReport
    {
        $category = VehicleCategory::create(['category_name' => 'Ambulance ' . uniqid(), 'description' => 'x']);
        $vehicle = Vehicle::create([
            'vehicle_name' => 'Test Ambulance', 'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id, 'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
            'capacity' => '1000 kg', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
            'barangay_id' => $this->barangayId,
        ]);

        return VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id, 'issue_type' => 'Body Damage', 'issue_description' => 'Dented door.',
            'severity_level' => 'Medium', 'reported_by' => $this->custodian->id, 'status' => $status,
        ]);
    }

    #[Test]
    public function only_admin_can_dismiss(): void
    {
        $issue = $this->issue();

        foreach ([$this->custodian, $this->mechanic] as $who) {
            Sanctum::actingAs($who, ['*']);
            $this->putJson("/api/issues/{$issue->issue_report_id}/dismiss", ['dismiss_reason' => 'x'])->assertForbidden();
        }
    }

    #[Test]
    public function a_resolved_issue_or_one_that_already_has_a_ticket_cannot_be_dismissed(): void
    {
        Sanctum::actingAs($this->admin, ['*']);

        $resolved = $this->issue('Resolved');
        $this->putJson("/api/issues/{$resolved->issue_report_id}/dismiss", ['dismiss_reason' => 'x'])->assertStatus(422);

        $withTicket = $this->issue('In Maintenance');
        MaintenanceTicket::create([
            'vehicle_id' => $withTicket->vehicle_id, 'issue_report_id' => $withTicket->issue_report_id,
            'created_by' => $this->custodian->id, 'ticket_title' => 'T', 'ticket_description' => 'x', 'priority' => 'High',
            'status' => 'Active', 'assigned_custodian_id' => $this->custodian->id, 'assigned_at' => now(),
        ]);
        $this->putJson("/api/issues/{$withTicket->issue_report_id}/dismiss", ['dismiss_reason' => 'x'])->assertStatus(422);
    }

    #[Test]
    public function dismissing_requires_a_reason_resolves_the_issue_and_tells_the_reporter(): void
    {
        $issue = $this->issue();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/issues/{$issue->issue_report_id}/dismiss", [])->assertStatus(422);
        $this->putJson("/api/issues/{$issue->issue_report_id}/dismiss", ['dismiss_reason' => 'Already fixed yesterday.'])->assertOk();

        $fresh = $issue->fresh();
        $this->assertSame('Resolved', $fresh->status);
        $this->assertStringContainsString('Already fixed yesterday.', $fresh->remarks);
        $this->assertDatabaseHas('notifications', ['user_id' => $this->custodian->id, 'type' => 'issue_dismissed']);
    }

    #[Test]
    public function dismissing_does_not_change_the_vehicle_status(): void
    {
        $issue = $this->issue();
        $issue->vehicle->update(['status' => 'Under Maintenance', 'condition' => 'Needs Repair']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/issues/{$issue->issue_report_id}/dismiss", ['dismiss_reason' => 'Not a real problem.'])->assertOk();

        $this->assertSame('Under Maintenance', $issue->vehicle->fresh()->status);
    }
}
