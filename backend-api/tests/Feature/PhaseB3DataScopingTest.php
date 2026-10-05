<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\MaintenanceTicket;
use App\Models\Province;
use App\Models\RegistrationSetting;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceRecord;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase B3 (role checks + data scoping on GET routes
 * that previously had none) and Phase B6 (notify a barangay's own Admins on
 * an ordinary staff registration, not just the first-Admin case).
 */
class PhaseB3DataScopingTest extends TestCase
{
    use RefreshDatabase;

    private int $barangayId;
    private int $cityId;
    private User $admin;
    private User $custodian;
    private User $mechanic;
    private User $otherMechanic;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->cityId = $city->id;
        $this->barangayId = Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id])->id;

        $this->admin = $this->user('Admin');
        $this->custodian = $this->user('Custodian');
        $this->mechanic = $this->user('Maintenance Personnel');
        $this->otherMechanic = $this->user('Maintenance Personnel');
    }

    private function user(string $role): User
    {
        return User::factory()->create([
            'role' => $role, 'roles' => [$role], 'barangay_id' => $this->barangayId, 'is_active' => true,
        ]);
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
            'barangay_id' => $this->barangayId,
        ]);
    }

    private function ticket(Vehicle $vehicle, ?int $assignedCustodianId = null): MaintenanceTicket
    {
        return MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'Runs hot after 10 minutes.',
            'assigned_custodian_id' => $assignedCustodianId,
        ]);
    }

    private function subIssue(MaintenanceTicket $ticket, ?int $assignedMechanicId = null): TicketSubIssue
    {
        return TicketSubIssue::create([
            'ticket_id' => $ticket->ticket_id,
            'created_by' => $this->admin->id,
            'title' => 'Worn belt',
            'assigned_mechanic_id' => $assignedMechanicId,
        ]);
    }

    // =======================================================================
    // GET /tickets/{id} — mirrors index()'s scoping, applied to a single record
    // =======================================================================

    #[Test]
    public function admin_can_view_any_ticket_in_the_barangay(): void
    {
        $ticket = $this->ticket($this->vehicle(), $this->custodian->id);

        Sanctum::actingAs($this->admin, ['*']);
        $this->getJson("/api/tickets/{$ticket->ticket_id}")->assertOk();
    }

    #[Test]
    public function the_assigned_custodian_can_view_their_own_ticket(): void
    {
        $ticket = $this->ticket($this->vehicle(), $this->custodian->id);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->getJson("/api/tickets/{$ticket->ticket_id}")->assertOk();
    }

    #[Test]
    public function a_custodian_not_assigned_to_the_ticket_is_blocked(): void
    {
        $otherCustodian = $this->user('Custodian');
        $ticket = $this->ticket($this->vehicle(), $otherCustodian->id);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->getJson("/api/tickets/{$ticket->ticket_id}")->assertForbidden();
    }

    #[Test]
    public function a_mechanic_assigned_to_a_sub_issue_can_view_the_ticket(): void
    {
        $ticket = $this->ticket($this->vehicle());
        $this->subIssue($ticket, $this->mechanic->id);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->getJson("/api/tickets/{$ticket->ticket_id}")->assertOk();
    }

    #[Test]
    public function a_mechanic_with_no_sub_issue_on_the_ticket_is_blocked(): void
    {
        $ticket = $this->ticket($this->vehicle());
        $this->subIssue($ticket, $this->mechanic->id);

        Sanctum::actingAs($this->otherMechanic, ['*']);
        $this->getJson("/api/tickets/{$ticket->ticket_id}")->assertForbidden();
    }

    // =======================================================================
    // GET /issues — Custodian sees ALL (not just own); Maintenance Personnel
    // sees only the technical issues THEY filed (their "Vehicle Issues"
    // sidebar entry tracks their own reports, not the whole barangay's queue
    // — that stays a Custodian/Admin concern).
    // =======================================================================

    #[Test]
    public function custodian_sees_every_issue_report_in_the_barangay_not_just_their_own(): void
    {
        $vehicle = $this->vehicle();
        VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Flat tire',
            'issue_description' => 'Front-left tire flat.',
            'reported_by' => $this->admin->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $response = $this->getJson('/api/issues')->assertOk();
        $this->assertCount(1, $response->json());
    }

    #[Test]
    public function maintenance_personnel_sees_only_their_own_issue_reports(): void
    {
        $vehicle = $this->vehicle();
        VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Flat tire',
            'issue_description' => 'Front-left tire flat.',
            'reported_by' => $this->mechanic->id,
        ]);
        VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Overheating',
            'issue_description' => 'Reported by someone else entirely.',
            'reported_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $response = $this->getJson('/api/issues')->assertOk();
        $this->assertCount(1, $response->json());
        $this->assertSame('Flat tire', $response->json()[0]['issue_type']);
    }

    // =======================================================================
    // GET /maintenance-schedules — Maintenance scoped to assigned_to = me
    // =======================================================================

    #[Test]
    public function maintenance_personnel_sees_only_schedules_assigned_to_them(): void
    {
        $vehicle = $this->vehicle();
        VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->admin->id,
            'assigned_to' => $this->mechanic->id,
        ]);
        VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Brake Check',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->admin->id,
            'assigned_to' => $this->otherMechanic->id,
        ]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $response = $this->getJson('/api/maintenance-schedules')->assertOk();
        $this->assertCount(1, $response->json());
        $this->assertSame('Oil Change', $response->json('0.maintenance_type'));
    }

    #[Test]
    public function admin_sees_every_schedule_in_the_barangay(): void
    {
        $vehicle = $this->vehicle();
        VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->admin->id,
            'assigned_to' => $this->mechanic->id,
        ]);
        VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Brake Check',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->admin->id,
            'assigned_to' => $this->otherMechanic->id,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->getJson('/api/maintenance-schedules')->assertOk();
        $this->assertCount(2, $response->json());
    }

    // =======================================================================
    // GET /conditions — Maintenance sees NONE
    // =======================================================================

    #[Test]
    public function maintenance_personnel_sees_no_condition_checks(): void
    {
        $vehicle = $this->vehicle();
        VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $response = $this->getJson('/api/conditions')->assertOk();
        $this->assertCount(0, $response->json());
    }

    #[Test]
    public function custodian_still_sees_condition_checks(): void
    {
        $vehicle = $this->vehicle();
        VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $response = $this->getJson('/api/conditions')->assertOk();
        $this->assertCount(1, $response->json());
    }

    // =======================================================================
    // GET /maintenance-records — Maintenance sees NONE (sees history via the
    // vehicle profile instead)
    // =======================================================================

    #[Test]
    public function maintenance_personnel_sees_no_maintenance_records(): void
    {
        $vehicle = $this->vehicle();
        VehicleMaintenanceRecord::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Scheduled service.',
            'maintenance_personnel_id' => $this->mechanic->id,
        ]);

        Sanctum::actingAs($this->mechanic, ['*']);
        $response = $this->getJson('/api/maintenance-records')->assertOk();
        $this->assertCount(0, $response->json());
    }

    // =======================================================================
    // GET /vehicles — Maintenance scoped to vehicles tied to their own
    // assigned sub-issues or schedules
    // =======================================================================

    #[Test]
    public function maintenance_personnel_sees_only_vehicles_tied_to_their_own_assigned_work(): void
    {
        $ownVehicle = $this->vehicle();
        $ticket = $this->ticket($ownVehicle);
        $this->subIssue($ticket, $this->mechanic->id);

        $scheduledVehicle = $this->vehicle();
        VehicleMaintenanceSchedule::create([
            'vehicle_id' => $scheduledVehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->admin->id,
            'assigned_to' => $this->mechanic->id,
        ]);

        $unrelatedVehicle = $this->vehicle();

        Sanctum::actingAs($this->mechanic, ['*']);
        $response = $this->getJson('/api/vehicles')->assertOk();
        $ids = collect($response->json())->pluck('vehicle_id');

        $this->assertTrue($ids->contains($ownVehicle->vehicle_id));
        $this->assertTrue($ids->contains($scheduledVehicle->vehicle_id));
        $this->assertFalse($ids->contains($unrelatedVehicle->vehicle_id));
    }

    #[Test]
    public function admin_sees_every_vehicle_in_the_barangay(): void
    {
        $this->vehicle();
        $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->getJson('/api/vehicles')->assertOk();
        $this->assertCount(2, $response->json());
    }

    // =======================================================================
    // Phase B6 — an ordinary (non-first-Admin) registration notifies the
    // barangay's own existing Admin(s), not just Super Admins
    // =======================================================================

    #[Test]
    public function an_ordinary_staff_registration_notifies_the_barangays_existing_admins(): void
    {
        $setting = RegistrationSetting::for($this->barangayId);

        $this->postJson('/api/register', [
            'name' => 'New Custodian',
            'email' => 'new-custodian@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
            'phone' => '09171234567',
            'address' => '123 Test St',
            'city_id' => $this->cityId,
            'barangay_id' => $this->barangayId,
            'staff_code' => $setting->staff_code,
            'requested_role' => 'Custodian',
        ])->assertCreated();

        $this->assertDatabaseHas('notifications', [
            'user_id' => $this->admin->id,
            'type' => 'pending_staff_approval',
        ]);
    }
}
