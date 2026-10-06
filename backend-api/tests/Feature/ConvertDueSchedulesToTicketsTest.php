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
 * A due Maintenance Schedule never creates a ticket by itself any more: the
 * daily command tells the Custodians once, and the Custodian's own Propose
 * Ticket (carrying schedule_id) is the single way a ticket comes to exist.
 * Closing that ticket then finishes the schedule it came from.
 */
class ConvertDueSchedulesToTicketsTest extends TestCase
{
    use RefreshDatabase;

    private User $custodian;
    private User $mechanic;
    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        $this->custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel']]);
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
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

    private function schedule(Vehicle $vehicle, array $overrides = []): VehicleMaintenanceSchedule
    {
        return VehicleMaintenanceSchedule::create(array_merge([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Brake Inspection',
            'scheduled_date' => now()->toDateString(),
            'created_by' => $this->admin->id,
            'assigned_to' => $this->mechanic->id,
            'status' => 'Scheduled',
        ], $overrides));
    }

    /** The Custodian opens the pre-filled form from the notification and submits. */
    private function proposeFrom(VehicleMaintenanceSchedule $schedule)
    {
        Sanctum::actingAs($this->custodian, ['*']);

        return $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $schedule->vehicle_id,
            'ticket_description' => "Scheduled {$schedule->maintenance_type}.",
            'priority' => 'Medium',
            'schedule_id' => $schedule->schedule_id,
            'sub_issues' => [['title' => 'Scheduled Maintenance', 'maintenance_type' => $schedule->maintenance_type, 'suggested_mechanic_id' => $this->mechanic->id]],
        ]);
    }

    #[Test]
    public function a_due_schedule_notifies_the_custodians_once_and_creates_nothing(): void
    {
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle);

        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);
        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);

        $this->assertDatabaseCount('maintenance_tickets', 0);
        $this->assertNotNull($schedule->fresh()->due_notified_at);
        $this->assertSame(1, \App\Models\Notification::where('user_id', $this->custodian->id)->where('type', 'schedule_due')->where('schedule_id', $schedule->schedule_id)->count());
    }

    #[Test]
    public function a_future_or_retired_vehicle_schedule_is_not_notified(): void
    {
        $future = $this->schedule($this->vehicle(), ['scheduled_date' => now()->addWeek()->toDateString()]);
        $retiredVehicle = $this->vehicle();
        $retiredVehicle->update(['status' => 'Decommissioned']);
        $retired = $this->schedule($retiredVehicle);

        $this->artisan('schedules:convert-due-to-tickets')->assertExitCode(0);

        $this->assertNull($future->fresh()->due_notified_at);
        $this->assertNull($retired->fresh()->due_notified_at);
        $this->assertDatabaseCount('notifications', 0);
    }

    #[Test]
    public function proposing_from_a_schedule_links_it_and_a_schedule_can_only_become_one_ticket(): void
    {
        $schedule = $this->schedule($this->vehicle());

        $id = $this->proposeFrom($schedule)->assertCreated()->json('ticket_id');
        $this->assertSame($id, $schedule->fresh()->resulting_ticket_id);
        $this->assertSame('Pending Approval', MaintenanceTicket::find($id)->status);

        $this->proposeFrom($schedule)->assertUnprocessable();

        $other = $this->schedule($this->vehicle());
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $schedule->vehicle_id, 'ticket_description' => 'x', 'priority' => 'Low', 'schedule_id' => $other->schedule_id,
            'sub_issues' => [['title' => 'x']],
        ])->assertUnprocessable(); // schedule belongs to a different vehicle
    }

    #[Test]
    public function completing_a_schedule_that_already_became_a_ticket_is_blocked(): void
    {
        $schedule = $this->schedule($this->vehicle());
        $this->proposeFrom($schedule)->assertCreated();

        Sanctum::actingAs($this->mechanic, ['*']);
        $response = $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/complete", [])->assertStatus(422);

        $this->assertStringContainsString((string) $schedule->fresh()->resulting_ticket_id, $response->json('message'));
    }

    private function approvedTicketFrom(array $overrides = []): array
    {
        $vehicle = $this->vehicle();
        $schedule = $this->schedule($vehicle, $overrides);
        $id = $this->proposeFrom($schedule)->assertCreated()->json('ticket_id');

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$id}/approve", ['assigned_mechanic_id' => $this->mechanic->id])->assertOk();

        return [$vehicle, $schedule->fresh(), MaintenanceTicket::find($id)];
    }

    private function driveToClosed(MaintenanceTicket $ticket): void
    {
        $sub = $ticket->subIssues->first();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$sub->sub_issue_id}/log-repairs", ['repair_logs' => 'Done.'])->assertOk();
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$sub->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved', 'test_attested' => true,
            'functional_test' => [['item' => 'Brakes respond properly', 'passed' => true]],
        ])->assertOk();
    }

    #[Test]
    public function closing_the_ticket_completes_its_schedule(): void
    {
        [, $schedule, $ticket] = $this->approvedTicketFrom();
        $this->assertSame('Scheduled', $schedule->status);

        $this->driveToClosed($ticket);

        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertSame('Completed', $schedule->fresh()->status);
    }

    #[Test]
    public function closing_the_ticket_of_a_recurring_schedule_seeds_the_next_occurrence(): void
    {
        [$vehicle, , $ticket] = $this->approvedTicketFrom(['recurrence_months' => 3]);

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
        $this->approvedTicketFrom(['scheduled_date' => now()->subDays(2)->toDateString()]);

        Sanctum::actingAs($this->admin, ['*']);
        $dash = $this->getJson('/api/dashboard')->assertOk();

        $overdue = collect($dash->json('metrics'))->firstWhere('label', 'Overdue Maintenance')['value'];
        $this->assertSame(0, $overdue);
        $this->assertSame([], $dash->json('overdue_schedules'));
    }

    #[Test]
    public function cancelling_the_ticket_cancels_its_schedule(): void
    {
        [, $schedule, $ticket] = $this->approvedTicketFrom();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertOk();
        $this->assertSame('Cancelled', $schedule->fresh()->status);
    }
}
