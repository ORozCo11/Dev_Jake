<?php

namespace Tests\Feature;

use App\Models\MaintenanceTicket;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * App\Console\Commands\ConvertDueSchedulesToTickets — a Scheduled entry
 * whose date has arrived becomes a real, pre-diagnosed ticket automatically,
 * and completeSchedule() refuses to also complete the schedule directly
 * once that's happened (the ticket is the live process from then on).
 */
class ConvertDueSchedulesToTicketsTest extends TestCase
{
    use RefreshDatabase;

    private User $custodian;
    private User $mechanic;

    protected function setUp(): void
    {
        parent::setUp();
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
    public function a_due_schedule_with_no_assignee_becomes_an_open_pre_diagnosed_ticket(): void
    {
        $vehicle = $this->vehicle();
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->toDateString(),
            'created_by' => $this->custodian->id,
            'status' => 'Scheduled',
        ]);

        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);

        $schedule->refresh();
        $this->assertNotNull($schedule->resulting_ticket_id);

        $ticket = MaintenanceTicket::findOrFail($schedule->resulting_ticket_id);
        $this->assertSame('Active', $ticket->status);
        $this->assertSame($this->custodian->id, $ticket->assigned_custodian_id);
        $this->assertCount(1, $ticket->subIssues);
        $this->assertSame('Open', $ticket->subIssues->first()->status);
        $this->assertNull($ticket->subIssues->first()->assigned_mechanic_id);
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
    }

    #[Test]
    public function a_due_schedule_with_an_assignee_creates_a_sub_issue_already_under_repair(): void
    {
        $vehicle = $this->vehicle();
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Brake Check',
            'scheduled_date' => now()->subDay()->toDateString(), // overdue, still due
            'created_by' => $this->custodian->id,
            'assigned_to' => $this->mechanic->id,
            'status' => 'Scheduled',
        ]);

        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);

        $ticket = MaintenanceTicket::findOrFail($schedule->fresh()->resulting_ticket_id);
        $subIssue = $ticket->subIssues->first();
        $this->assertSame('Under Repair', $subIssue->status);
        $this->assertSame($this->mechanic->id, $subIssue->assigned_mechanic_id);

        $this->assertDatabaseHas('notifications', [
            'user_id' => $this->mechanic->id,
            'type' => 'work_order_assigned',
        ]);
    }

    #[Test]
    public function a_future_schedule_is_not_converted(): void
    {
        $vehicle = $this->vehicle();
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $this->custodian->id,
            'status' => 'Scheduled',
        ]);

        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);

        $this->assertNull($schedule->fresh()->resulting_ticket_id);
        $this->assertDatabaseCount('maintenance_tickets', 0);
    }

    #[Test]
    public function running_the_command_twice_does_not_create_a_second_ticket(): void
    {
        $vehicle = $this->vehicle();
        VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->toDateString(),
            'created_by' => $this->custodian->id,
            'status' => 'Scheduled',
        ]);

        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);
        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);

        $this->assertDatabaseCount('maintenance_tickets', 1);
    }

    #[Test]
    public function a_due_schedule_on_a_retired_vehicle_is_skipped_without_failing_the_run(): void
    {
        $vehicle = $this->vehicle();
        $vehicle->update(['status' => 'Decommissioned']);
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->toDateString(),
            'created_by' => $this->custodian->id,
            'status' => 'Scheduled',
        ]);

        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);

        $this->assertNull($schedule->fresh()->resulting_ticket_id);
    }

    #[Test]
    public function completing_a_schedule_that_already_became_a_ticket_is_blocked(): void
    {
        $vehicle = $this->vehicle();
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->toDateString(),
            'created_by' => $this->custodian->id,
            'status' => 'Scheduled',
        ]);
        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);

        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        Sanctum::actingAs($admin, ['*']);
        $response = $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [])
            ->assertStatus(422);

        $this->assertStringContainsString((string) $schedule->fresh()->resulting_ticket_id, $response->json('message'));
    }
}
