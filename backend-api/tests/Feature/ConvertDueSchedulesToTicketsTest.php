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
 * whose date has arrived becomes a ticket PROPOSAL automatically (Pending
 * Approval, same as a human Custodian proposal — production-readiness audit
 * finding #1), and completeSchedule() refuses to also complete the schedule
 * directly once that's happened (the ticket is the live process from then
 * on, once Admin approves it).
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
    public function a_due_schedule_becomes_a_pending_approval_proposal_not_an_active_ticket(): void
    {
        $vehicle = $this->vehicle();
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $vehicle->barangay_id]);
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
        // Production-readiness audit finding #1 — this must be a proposal
        // awaiting Admin review, exactly like a human Custodian's, not an
        // Active ticket that skipped review entirely.
        $this->assertSame('Pending Approval', $ticket->status);
        $this->assertSame($this->custodian->id, $ticket->assigned_custodian_id);
        $this->assertCount(1, $ticket->subIssues);
        $this->assertSame('Open', $ticket->subIssues->first()->status);
        $this->assertNull($ticket->subIssues->first()->assigned_mechanic_id);
        // Nothing about the vehicle changes until Admin actually approves —
        // same as any other proposal.
        $this->assertSame('Available', $vehicle->fresh()->status);

        $this->assertDatabaseHas('notifications', [
            'user_id' => $this->custodian->id,
            'type' => 'schedule_due_ticket_created',
        ]);
        $this->assertDatabaseHas('notifications', [
            'user_id' => $admin->id,
            'type' => 'ticket_proposed',
        ]);
    }

    #[Test]
    public function a_due_schedules_assignee_rides_along_as_a_suggestion_not_a_direct_dispatch(): void
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
        // Not dispatched yet — a suggestion for Admin to review, same as a
        // human proposal's suggested_mechanic_id. No direct work order.
        $this->assertSame('Open', $subIssue->status);
        $this->assertNull($subIssue->assigned_mechanic_id);
        $this->assertSame($this->mechanic->id, $subIssue->suggested_mechanic_id);
        $this->assertDatabaseMissing('notifications', [
            'user_id' => $this->mechanic->id,
            'type' => 'work_order_assigned',
        ]);

        // Admin approves — THIS is what actually dispatches the suggested
        // mechanic, exactly like any other Custodian proposal.
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [])->assertOk();

        $subIssue->refresh();
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

    // ---- Ticket end finishes the schedule it came from ----------------------

    private function convertedSchedule(array $overrides = []): array
    {
        $vehicle = $this->vehicle();
        $schedule = VehicleMaintenanceSchedule::create(array_merge([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Brake Inspection',
            'scheduled_date' => now()->toDateString(),
            'created_by' => $this->custodian->id,
            'assigned_to' => $this->mechanic->id,
            'status' => 'Scheduled',
        ], $overrides));
        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);

        $ticket = MaintenanceTicket::findOrFail($schedule->fresh()->resulting_ticket_id);

        // The auto-proposal still needs Admin approval before it's Active —
        // same as any human Custodian proposal (production-readiness audit
        // finding #1). The tests using this helper are about what happens
        // once a ticket is live, not about the approval step itself (that's
        // covered separately above), so approve it here to get there.
        $approver = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        Sanctum::actingAs($approver, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [])->assertOk();

        return [$vehicle, $schedule->fresh(), $ticket->fresh()];
    }

    private function driveToClosed(MaintenanceTicket $ticket): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $sub = $ticket->subIssues->first();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$sub->sub_issue_id}/log-repairs", ['repair_logs' => 'Done.'])->assertOk();
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$sub->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved', 'test_attested' => true,
            'functional_test' => [['item' => 'Brakes respond properly', 'passed' => true]],
        ])->assertOk();
        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$sub->sub_issue_id}/confirm", ['confirmation_verdict' => 'Confirmed'])->assertOk();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->assertOk();
    }

    #[Test]
    public function closing_the_auto_created_ticket_completes_its_schedule(): void
    {
        [, $schedule, $ticket] = $this->convertedSchedule();
        $this->assertSame('Scheduled', $schedule->status);

        $this->driveToClosed($ticket);

        $this->assertSame('Completed', $schedule->fresh()->status);
    }

    #[Test]
    public function closing_the_ticket_of_a_recurring_schedule_seeds_the_next_occurrence(): void
    {
        [$vehicle, , $ticket] = $this->convertedSchedule(['recurrence_months' => 3]);

        $this->driveToClosed($ticket);

        $next = VehicleMaintenanceSchedule::where('vehicle_id', $vehicle->vehicle_id)->where('status', 'Scheduled')->first();
        $this->assertNotNull($next, 'A recurring service must keep recurring after its ticket closes.');
        $this->assertSame(now()->addMonthsNoOverflow(3)->toDateString(), substr((string) $next->scheduled_date, 0, 10));
        $this->assertSame(3, $next->recurrence_months);
        $this->assertSame($this->mechanic->id, $next->assigned_to);
        $this->assertNull($next->resulting_ticket_id);
    }

    #[Test]
    public function a_schedule_being_worked_as_a_ticket_is_not_counted_overdue(): void
    {
        $this->convertedSchedule(['scheduled_date' => now()->subDays(2)->toDateString()]);
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);

        Sanctum::actingAs($admin, ['*']);
        $dash = $this->getJson('/api/dashboard')->assertOk();

        $overdue = collect($dash->json('metrics'))->firstWhere('label', 'Overdue Maintenance')['value'];
        $this->assertSame(0, $overdue);
        $this->assertSame([], $dash->json('overdue_schedules'));
    }

    #[Test]
    public function cancelling_the_ticket_cancels_its_schedule_and_restoring_it_brings_it_back(): void
    {
        [, $schedule, $ticket] = $this->convertedSchedule();
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);

        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertOk();
        $this->assertSame('Cancelled', $schedule->fresh()->status);

        $this->putJson("/api/tickets/{$ticket->ticket_id}/uncancel", [])->assertOk();
        $this->assertSame('Scheduled', $schedule->fresh()->status);
    }
}
