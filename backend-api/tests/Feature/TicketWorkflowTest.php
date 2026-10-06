<?php

namespace Tests\Feature;

use App\Models\MaintenanceTicket;
use App\Models\TicketArchiveLog;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceRecord;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * WORKFLOW GUARD TESTS
 *
 * A ticket is a Main Issue container holding one or more independently
 * tracked Sub-Issues, each running assign -> repair -> verify -> confirm
 * on its own. These tests prove: who may act at each phase, that sub-issues
 * can be appended while a ticket is Active, that closing requires every
 * sub-issue Done, and that a vehicle only returns to service once NONE of
 * its tickets are still open — not just the one that happened to close.
 */
class TicketWorkflowTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private User $mechanic;
    private User $mechanic2;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin']);
        $this->custodian = User::factory()->create(['role' => 'Custodian']);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel']);
        $this->mechanic2 = User::factory()->create(['role' => 'Maintenance Personnel']);
    }

    private function vehicle(array $overrides = []): Vehicle
    {
        $category = VehicleCategory::create([
            'category_name' => 'Ambulance ' . uniqid(),
            'description' => 'For testing',
        ]);

        return Vehicle::create(array_merge([
            'vehicle_name' => 'Test Ambulance',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota',
            'model' => 'HiAce',
            'year_model' => 2022,
            'capacity' => '1000 kg',
            'vehicle_color' => 'White',
            'current_location' => 'Main Depot',
        ], $overrides));
    }

    /**
     * Pure test scaffolding — builds an Open ticket directly (bypassing
     * HTTP) exactly like createTicket()'s default 'inspection' entry mode
     * used to. That endpoint is gated by ticket.create, which no role holds
     * any more (nobody can create a ticket directly; only propose+approve),
     * so tests that just need "an Open ticket exists" build one straight
     * via the model instead of depending on a permission this suite is
     * itself proving is gone.
     */
    private function createTicket(Vehicle $vehicle, string $title = 'Overheating'): MaintenanceTicket
    {
        return MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => $title,
            'ticket_description' => 'Engine runs hot after 10 minutes.',
            'priority' => 'High',
            'status' => 'Open',
            'assigned_custodian_id' => $this->custodian->id,
            'assigned_at' => now(),
        ]);
    }

    /**
     * Puts the ticket in the state a Custodian's proposal reaches once Admin
     * approves it (Active, vehicle under maintenance) with the given jobs —
     * the old Custodian inspection step no longer exists.
     */
    private function inspectWithSubIssues(MaintenanceTicket $ticket, array $titles): MaintenanceTicket
    {
        $ticket->update(['status' => 'Active', 'inspection_result' => 'Needs Maintenance', 'inspected_by' => $this->custodian->id, 'inspected_at' => now()]);
        foreach ($titles as $title) {
            TicketSubIssue::create(['ticket_id' => $ticket->ticket_id, 'created_by' => $this->custodian->id, 'title' => $title, 'status' => 'Open']);
        }
        $ticket->vehicle->update(['condition' => 'Needs Repair', 'status' => 'Under Maintenance']);

        return $ticket->fresh();
    }

    private function driveSubIssueToDone(MaintenanceTicket $ticket, TicketSubIssue $subIssue, ?User $mechanic = null): void
    {
        $mechanic ??= $this->mechanic;

        // A job approved with a mechanic is already dispatched.
        if ($subIssue->fresh()->status === 'Open') {
            Sanctum::actingAs($this->admin, ['*']);
            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
                'assigned_mechanic_id' => $mechanic->id,
                'maintenance_type' => 'Engine Repair',
            ])->assertOk();
        }

        Sanctum::actingAs($mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Fixed it.',
        ])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [
                ['item' => 'Engine starts / powers on', 'passed' => true],
                ['item' => 'Reported issue no longer reproduces', 'passed' => true],
            ],
        ])->assertOk();
    }

    /** Assign a mechanic and log repairs so a sub-issue sits at For Inspection. */
    private function driveSubIssueToInspection(MaintenanceTicket $ticket, TicketSubIssue $subIssue, ?User $mechanic = null): void
    {
        $mechanic ??= $this->mechanic;

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        Sanctum::actingAs($mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Fixed it.',
        ])->assertOk();
    }

    #[Test]
    public function verification_requires_a_recorded_functional_test(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();
        $this->driveSubIssueToInspection($ticket, $subIssue);

        // Approving with no functional test at all is rejected — the whole
        // point is that a repair is proven, not rubber-stamped.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
        ])->assertUnprocessable();
    }

    #[Test]
    public function approving_requires_attestation_and_a_clean_test(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();
        $this->driveSubIssueToInspection($ticket, $subIssue);

        Sanctum::actingAs($this->custodian, ['*']);

        // A failed check cannot be Approved.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Brakes respond', 'passed' => false]],
        ])->assertUnprocessable();

        // A clean test but no attestation cannot be Approved.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => false,
            'functional_test'      => [['item' => 'Brakes respond', 'passed' => true]],
        ])->assertUnprocessable();

        $this->assertSame('For Inspection', $subIssue->fresh()->status);
    }

    #[Test]
    public function a_passing_functional_test_is_recorded_and_advances_the_sub_issue(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();
        $this->driveSubIssueToInspection($ticket, $subIssue);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [
                ['item' => 'Engine starts / powers on', 'passed' => true],
                ['item' => 'Reported issue no longer reproduces', 'passed' => true],
            ],
        ])->assertOk();

        $fresh = $subIssue->fresh();
        // Verification is the final sign-off now: the job is Done and the ticket closes.
        $this->assertSame('Done', $fresh->status);
        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertTrue($fresh->test_attested);
        $this->assertCount(2, $fresh->functional_test);
        $this->assertSame('Engine starts / powers on', $fresh->functional_test[0]['item']);
    }

    #[Test]
    public function a_mechanic_can_attach_a_photo_or_document_when_logging_repairs(): void
    {
        Storage::fake('supabase');

        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->put("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Topped up coolant.',
            'photo' => UploadedFile::fake()->create('receipt.pdf', 100, 'application/pdf'),
        ])->assertOk();

        $subIssue->refresh();
        $this->assertNotNull($subIssue->attachment_url);
    }

    #[Test]
    public function the_same_main_issue_cannot_be_proposed_twice_while_one_is_still_active(): void
    {
        // Duplicate-Main-Issue guard used to live only in createTicket();
        // proposeTicket() now carries the same check since it's the only
        // way a ticket comes into existence.
        $vehicle = $this->vehicle();
        $this->createTicket($vehicle, 'Overheating');

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Reported again.',
            'priority' => 'Medium',
            // Same Main Issue = same issue summary (here the maintenance type),
            // matched case-insensitively against the legacy 'Overheating' title.
            'sub_issues' => [['title' => 'Still overheating', 'maintenance_type' => 'overheating']],
        ])->assertUnprocessable();
    }

    #[Test]
    public function a_different_main_issue_can_be_proposed_concurrently_on_the_same_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $this->createTicket($vehicle, 'Overheating');

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Flat Tire',
            'ticket_description' => 'Rear right tire is flat.',
            'priority' => 'Medium',
            'sub_issues' => [['title' => 'Replace rear right tire']],
        ])->assertCreated();

        $this->assertSame(2, MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)->count());
    }

    #[Test]
    public function sub_issues_can_go_to_different_mechanics_and_progress_counts_correctly(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level', 'Faulty radiator']);

        $this->assertSame(['done' => 0, 'deferred' => 0, 'total' => 2], $ticket->progress);

        [$coolant, $radiator] = $ticket->subIssues;

        $this->driveSubIssueToDone($ticket, $coolant, $this->mechanic);
        $this->assertSame(['done' => 1, 'deferred' => 0, 'total' => 2], $ticket->fresh()->progress);

        $this->driveSubIssueToDone($ticket, $radiator, $this->mechanic2);
        $this->assertSame(['done' => 2, 'deferred' => 0, 'total' => 2], $ticket->fresh()->progress);

        $this->assertSame($this->mechanic->id, $coolant->fresh()->assigned_mechanic_id);
        $this->assertSame($this->mechanic2->id, $radiator->fresh()->assigned_mechanic_id);
    }

    #[Test]
    public function a_rejected_verification_sends_the_sub_issue_back_to_repair(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Topped up coolant.',
        ])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Rejected',
            'verification_notes' => 'Still overheating.',
            'functional_test' => [
                ['item' => 'Reported issue no longer reproduces', 'passed' => false],
            ],
        ])->assertOk();

        $this->assertSame('Under Repair', $subIssue->fresh()->status);
    }

    #[Test]
    public function a_ticket_exposes_its_age_in_days(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);

        // Freshly created -> 0 whole days old, and the attribute is exposed.
        $this->assertSame(0, $ticket->fresh()->days_open);
    }

    #[Test]
    public function only_admin_can_assign_a_mechanic(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        foreach ([$this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
                'assigned_mechanic_id' => $this->mechanic->id,
                'maintenance_type' => 'Engine Repair',
            ])->assertForbidden();
        }

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        $this->assertSame($this->mechanic->id, $subIssue->fresh()->assigned_mechanic_id);
    }

    #[Test]
    public function an_admin_can_reassign_an_in_progress_work_order(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        // Assign to the first mechanic -> now Under Repair.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        // The first mechanic is out — hand it to the second, with a reason.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reassign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'Original mechanic is out sick.',
        ])->assertOk();

        $this->assertSame($this->mechanic2->id, $subIssue->fresh()->assigned_mechanic_id);
        $this->assertSame('Under Repair', $subIssue->fresh()->status);
    }

    #[Test]
    public function a_work_order_cannot_be_reassigned_unless_it_is_under_repair(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first(); // still Open, no mechanic yet

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reassign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'trying too early',
        ])->assertUnprocessable();
    }

    #[Test]
    public function only_admin_can_reassign_a_work_order(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        foreach ([$this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reassign-mechanic", [
                'assigned_mechanic_id' => $this->mechanic2->id,
                'reassign_reason' => 'x',
            ])->assertForbidden();
        }
    }

    #[Test]
    public function a_ticket_with_every_sub_issue_already_resolved_cannot_be_cancelled(): void
    {
        // Real, confirmed repair work is on record here — cancelling would
        // void it instead of just abandoning an unstarted/unfinished ticket.
        // Close it instead.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $this->driveSubIssueToDone($ticket, $ticket->subIssues[0]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertUnprocessable();

        $this->assertSame('Closed', $ticket->fresh()->status);
    }

    #[Test]
    public function proposing_a_ticket_from_a_condition_check_links_it_and_stays_live(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Needs Repair',
            'observations' => 'Brakes feel soft.',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $response = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Condition Check: Needs Repair',
            'ticket_description' => 'From condition check.',
            'priority' => 'High',
            'condition_check_id' => $condition->condition_check_id,
            'sub_issues' => [['title' => 'Brakes feel soft.']],
        ])->assertCreated();
        $ticketId = $response->json('ticket_id');

        // The link is set once, immediately at proposal time...
        $this->assertSame($ticketId, $condition->fresh()->resulting_ticket_id);

        // ...and stays 'Pending Approval' until an Admin approves it.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/approve", ['assigned_mechanic_id' => $this->mechanic->id])->assertOk();

        // ...and the listing endpoint reads the ticket's LIVE status through
        // it, not a snapshot — no change to the condition check itself.
        Sanctum::actingAs($this->admin, ['*']);
        $listed = $this->getJson('/api/conditions')->assertOk()->json();
        $row = collect($listed)->firstWhere('condition_check_id', $condition->condition_check_id);
        $this->assertSame($ticketId, $row['resulting_ticket']['ticket_id']);
        $this->assertSame('Active', $row['resulting_ticket']['status']);
        // The historical entry is untouched by any of this.
        $this->assertSame('Needs Repair', $row['condition_result']);
        $this->assertSame('Brakes feel soft.', $row['observations']);

        // Close the ticket — the SAME condition check row now reflects the
        // new status automatically, no extra step.
        $ticket = MaintenanceTicket::findOrFail($ticketId);
        $this->driveSubIssueToDone($ticket, $ticket->subIssues[0]);

        $listedAfterClose = $this->getJson('/api/conditions')->assertOk()->json();
        $rowAfterClose = collect($listedAfterClose)->firstWhere('condition_check_id', $condition->condition_check_id);
        $this->assertSame('Closed', $rowAfterClose['resulting_ticket']['status']);
        $this->assertSame('Needs Repair', $rowAfterClose['condition_result']);
    }

    #[Test]
    public function closed_tickets_are_permanently_locked(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $this->driveSubIssueToDone($ticket, $ticket->subIssues[0]);

        // Verification closed it; Closed is final — it cannot be cancelled.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertUnprocessable();
        $this->assertTrue(MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->exists());
        $this->assertSame(1, TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->count());
    }

    #[Test]
    public function the_vehicle_only_returns_to_service_once_every_open_ticket_is_closed(): void
    {
        $vehicle = $this->vehicle();

        $overheating = $this->createTicket($vehicle, 'Overheating');
        $overheating = $this->inspectWithSubIssues($overheating, ['Low coolant level']);

        $flatTire = $this->createTicket($vehicle, 'Flat Tire');
        $flatTire = $this->inspectWithSubIssues($flatTire, ['Replace rear right tire']);

        // Close the Flat Tire ticket first — Overheating is still open.
        $this->driveSubIssueToDone($flatTire, $flatTire->subIssues[0]);

        $this->assertSame('Under Maintenance', $vehicle->fresh()->status, 'Overheating ticket is still open — vehicle must not be marked Available yet.');

        // Now close Overheating too — only now should the vehicle free up.
        $this->driveSubIssueToDone($overheating->fresh(), $overheating->fresh()->subIssues[0]);

        $this->assertSame('Available', $vehicle->fresh()->status);
        $this->assertSame('Good', $vehicle->fresh()->condition);
    }

    #[Test]
    public function dashboard_badge_counts_reflect_sub_issue_assignment_and_verification(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->getJson('/api/dashboard')->assertOk()->assertJsonPath('badge_counts.ticketWorkOrders', 1);

        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Topped up coolant.',
        ])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->getJson('/api/dashboard')->assertOk()->assertJsonPath('badge_counts.ticketVerifications', 1);
    }

    #[Test]
    public function double_booking_a_vehicle_warns_instead_of_blocking_and_a_confirm_proceeds(): void
    {
        // Admin creates schedules (spec §19) — see PhaseB4RoleModelTest
        // for that reversal's own dedicated coverage. This test is about the
        // double-booking rule itself, which used to be a hard 422 and is now
        // a warning the caller can confirm past (see FleetController::
        // checkScheduleConflicts()).
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => '2026-08-01',
        ])->assertCreated();

        $unconfirmed = $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Tire Rotation',
            'scheduled_date' => '2026-08-01',
        ])->assertStatus(409);
        $this->assertTrue($unconfirmed->json('same_vehicle_conflict'));
        $this->assertDatabaseCount('vehicle_maintenance_schedules', 1);

        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Tire Rotation',
            'scheduled_date' => '2026-08-01',
            'confirm_conflicts' => true,
        ])->assertCreated();
        $this->assertDatabaseCount('vehicle_maintenance_schedules', 2);
    }

    #[Test]
    public function a_cancelled_ticket_blocks_every_sub_issue_action(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, [
            'Open issue', 'Under repair issue', 'For inspection issue', 'For confirmation issue',
        ]);
        [$openSub, $repairSub, $inspectSub, $confirmSub] = $ticket->subIssues()->orderBy('sub_issue_id')->get();

        // Drive each sub-issue to the exact stage needed to exercise its guard.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$repairSub->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        $this->driveSubIssueToInspection($ticket, $inspectSub);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$confirmSub->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();
        Sanctum::actingAs($this->mechanic2, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$confirmSub->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Done.',
        ])->assertOk();
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$confirmSub->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
        ])->assertOk();

        // Cancel the whole ticket.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertOk();

        // Every sub-issue action must now be blocked, regardless of the
        // sub-issue's own status — a cancelled ticket is dead, not just
        // frozen at the top level.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$openSub->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertUnprocessable();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$repairSub->sub_issue_id}/reassign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'testing',
        ])->assertUnprocessable();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$repairSub->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Should be blocked.',
        ])->assertUnprocessable();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$inspectSub->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
        ])->assertUnprocessable();
    }

    // =======================================================================
    // VMS-IMPROVEMENT-PLAN.md Phase A2 — self-verification is blocked even
    // for a dual-role account, with Admin as a general fallback.
    // =======================================================================

    #[Test]
    public function a_mechanic_who_also_holds_the_verifying_custodians_account_cannot_approve_their_own_repair(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        // $this->custodian is this ticket's assigned Custodian/verifier —
        // give them the Maintenance Personnel hat too, then assign the
        // repair to themself.
        $this->custodian->update(['roles' => ['Custodian', 'Maintenance Personnel']]);

        $this->driveSubIssueToInspection($ticket, $subIssue, $this->custodian);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
        ])->assertForbidden()
            ->assertJsonFragment(['message' => 'You performed repair work on this sub-issue — it must be verified by a different Custodian. Reassign this ticket to another Custodian.']);

        $this->assertSame('For Inspection', $subIssue->fresh()->status);
    }

    #[Test]
    public function a_mechanic_reassigned_away_mid_repair_who_is_also_the_custodian_still_cannot_verify_their_own_earlier_work(): void
    {
        // Final senior system review — closes a self-verification gap: the
        // old guard only ever checked the CURRENT assigned_mechanic_id, so a
        // mechanic who did real repair work and was then reassigned away
        // before finalizing it (reassignMechanic() only fires while still
        // 'Under Repair') was never blocked, as long as they also held this
        // ticket's Custodian hat — because by the time it reached
        // verification, assigned_mechanic_id named someone else entirely.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        $this->custodian->update(['roles' => ['Custodian', 'Maintenance Personnel']]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->custodian->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        // Reassigned away before the custodian-mechanic ever submits repair
        // logs for their own work.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reassign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'reassign_reason' => 'Reassigning mid-repair for testing.',
        ])->assertOk();

        $this->assertSame([$this->custodian->id], $subIssue->fresh()->prior_mechanic_ids);

        // A different mechanic finishes and submits the paperwork.
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Picked up where the reassigned mechanic left off.',
        ])->assertOk();

        // The original mechanic — now only wearing the Custodian hat on
        // paper, but who actually did earlier repair work on this exact
        // sub-issue — still cannot verify it, even though assigned_mechanic_id
        // now names someone else entirely.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
        ])->assertForbidden()
            ->assertJsonFragment(['message' => 'You performed repair work on this sub-issue — it must be verified by a different Custodian. Reassign this ticket to another Custodian.']);
    }

    #[Test]
    public function prior_mechanic_ids_accumulate_across_reassignments_without_duplicates(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();
        $third = User::factory()->create(['role' => 'Maintenance Personnel']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reassign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'first handoff',
        ])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reassign-mechanic", [
            'assigned_mechanic_id' => $third->id,
            'reassign_reason' => 'second handoff',
        ])->assertOk();

        $this->assertSame([$this->mechanic->id, $this->mechanic2->id], $subIssue->fresh()->prior_mechanic_ids);
    }

    #[Test]
    public function an_admin_cannot_verify_a_repair_even_as_a_fallback_and_must_reassign_the_custodian_instead(): void
    {
        // Production-readiness audit finding #2 — Admin was previously a
        // general Tier-1 verification fallback. That's removed: Tier-1
        // verification is Custodian-only, full stop. An unavailable
        // Custodian is handled by reassigning the ticket, not by Admin
        // quietly standing in for the check.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        $this->driveSubIssueToInspection($ticket, $subIssue);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
        ])->assertForbidden();

        // The actual, correct fix: reassign the ticket to a different
        // Custodian, who can then verify it normally.
        $standInCustodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $standInCustodian->id,
            'reassign_reason' => 'Original custodian unavailable.',
        ])->assertOk();

        Sanctum::actingAs($standInCustodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
        ])->assertOk();

        $this->assertSame('Done', $subIssue->fresh()->status);
        $this->assertSame($standInCustodian->id, $subIssue->fresh()->verified_by);
    }

    #[Test]
    public function a_maintenance_personnel_only_account_still_cannot_call_verify_at_all(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();
        $this->driveSubIssueToInspection($ticket, $subIssue);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
        ])->assertForbidden();
    }

    #[Test]
    public function assigning_a_mechanic_who_is_also_this_tickets_custodian_warns_but_does_not_block(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        $this->custodian->update(['roles' => ['Custodian', 'Maintenance Personnel']]);

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->custodian->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        $response->assertJsonPath(
            'warning',
            "{$this->custodian->name} is also this ticket's Custodian — they won't be able to verify their own repair. Reassign the ticket to a different Custodian before it reaches verification."
        );
        $this->assertSame('Under Repair', $subIssue->fresh()->status, 'The conflict is a warning, not a block.');
    }

    #[Test]
    public function assigning_an_ordinary_mechanic_carries_no_warning(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        $this->assertArrayNotHasKey('warning', $response->json());
    }

    #[Test]
    public function reassigning_the_custodian_to_the_subissues_own_mechanic_warns_but_does_not_block(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        // $this->mechanic is about to become the ticket's Custodian while
        // also still being this sub-issue's assigned mechanic.
        $this->mechanic->update(['roles' => ['Maintenance Personnel', 'Custodian']]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        $response = $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $this->mechanic->id,
            'reassign_reason' => 'Original custodian is out.',
        ])->assertOk();

        $response->assertJsonPath(
            'warning',
            "{$this->mechanic->name} is also the assigned mechanic on: {$subIssue->title}. They won't be able to verify their own repair there — reassign those sub-issues to a different mechanic, or this ticket to a different Custodian."
        );
        $this->assertSame($this->mechanic->id, $ticket->fresh()->assigned_custodian_id, 'The conflict is a warning, not a block.');
    }

    // =======================================================================
    // VMS-IMPROVEMENT-PLAN.md Phase A3 — a cannibalized repair needs an
    // Admin's sign-off, and approving one opens an Issue Report on the
    // donor vehicle instead of the "part just vanished" it used to be.
    // =======================================================================

    private function logCannibalizedRepair(MaintenanceTicket $ticket, TicketSubIssue $subIssue, Vehicle $donorVehicle, ?User $mechanic = null)
    {
        $mechanic ??= $this->mechanic;

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        Sanctum::actingAs($mechanic, ['*']);
        return $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Swapped in a part from another vehicle.',
            'repair_type' => 'cannibalized',
            'source_vehicle_id' => $donorVehicle->vehicle_id,
        ]);
    }

    #[Test]
    public function logging_a_cannibalized_repair_parks_at_pending_approval_instead_of_going_straight_to_inspection(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();

        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        $subIssue->refresh();
        $this->assertSame('Pending Approval', $subIssue->status);
        $this->assertSame('Pending', $subIssue->cannibalization_status);
        $this->assertSame($donor->vehicle_id, $subIssue->source_vehicle_id);
    }

    #[Test]
    public function a_custodian_cannot_verify_a_repair_still_pending_cannibalization_approval(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
        ])->assertUnprocessable();
    }

    #[Test]
    public function approving_a_cannibalized_repair_releases_it_to_inspection_and_flags_the_donor(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/approve-cannibalization", [])
            ->assertOk();

        $subIssue->refresh();
        $this->assertSame('For Inspection', $subIssue->status);
        $this->assertSame('Approved', $subIssue->cannibalization_status);
        $this->assertSame($this->admin->id, $subIssue->cannibalization_reviewed_by);
        $this->assertNotNull($subIssue->cannibalization_reviewed_at);

        $donor->refresh();
        $this->assertSame('Needs Inspection', $donor->condition);
        $this->assertDatabaseHas('vehicle_histories', [
            'vehicle_id' => $donor->vehicle_id,
            'activity_type' => 'Part Removed',
            'related_record_id' => (string) $ticket->ticket_id,
        ]);

        // Now released to the normal pipeline — Custodian can verify it.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
        ])->assertOk();
    }

    #[Test]
    public function rejecting_a_cannibalized_repair_sends_it_back_to_under_repair_with_no_donor_side_effects(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reject-cannibalization", [
            'cannibalization_rejection_reason' => 'We need that part on the donor vehicle itself.',
        ])->assertOk();

        $subIssue->refresh();
        $this->assertSame('Under Repair', $subIssue->status);
        $this->assertSame('Rejected', $subIssue->cannibalization_status);
        $this->assertSame('We need that part on the donor vehicle itself.', $subIssue->cannibalization_rejection_reason);
        $this->assertNull($subIssue->cannibalization_issue_report_id);

        $donor->refresh();
        $this->assertNotSame('Needs Inspection', $donor->condition);
        $this->assertDatabaseMissing('vehicle_issue_reports', ['vehicle_id' => $donor->vehicle_id]);
    }

    #[Test]
    public function rejecting_a_cannibalized_repair_requires_a_reason(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reject-cannibalization", [])
            ->assertUnprocessable();
    }

    #[Test]
    public function only_an_admin_can_approve_or_reject_a_cannibalized_repair(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/approve-cannibalization", [])->assertForbidden();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reject-cannibalization", [
            'cannibalization_rejection_reason' => 'nope',
        ])->assertForbidden();
    }

    #[Test]
    public function cannibalization_approval_cannot_be_actioned_twice(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/approve-cannibalization", [])->assertOk();

        // Already Approved — a second approval (or a reject) must not be
        // allowed to silently re-open/re-run this gate.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/approve-cannibalization", [])->assertUnprocessable();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reject-cannibalization", [
            'cannibalization_rejection_reason' => 'too late',
        ])->assertUnprocessable();
    }

    #[Test]
    public function an_in_house_repair_is_unaffected_and_still_goes_straight_to_inspection(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Loose bolt']);
        $subIssue = $ticket->subIssues->first();

        $this->driveSubIssueToInspection($ticket, $subIssue);

        $subIssue->refresh();
        $this->assertSame('For Inspection', $subIssue->status);
        $this->assertNull($subIssue->cannibalization_status);
    }

    // ---- Ticketing-process review fixes -----------------------------------

    private function pendingIssue(Vehicle $vehicle, string $status = 'Pending'): VehicleIssueReport
    {
        return VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id, 'issue_type' => 'Engine Problem',
            'issue_description' => 'Overheating.', 'severity_level' => 'High',
            'reported_by' => $this->custodian->id, 'status' => $status,
        ]);
    }

    private function propose(Vehicle $vehicle, array $extra = []): \Illuminate\Testing\TestResponse
    {
        Sanctum::actingAs($this->custodian, ['*']);

        return $this->postJson('/api/tickets/propose', array_merge([
            'vehicle_id' => $vehicle->vehicle_id, 'ticket_title' => 'Engine Problem',
            'ticket_description' => 'Overheating.', 'priority' => 'High',
            'sub_issues' => [['title' => 'Overheating']],
        ], $extra));
    }

    #[Test]
    public function a_proposal_awaiting_approval_cannot_be_cancelled(): void
    {
        $ticketId = $this->propose($this->vehicle())->assertCreated()->json('ticket_id');

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/cancel", [])->assertStatus(422);
        $this->assertSame('Pending Approval', MaintenanceTicket::find($ticketId)->status);
    }

    #[Test]
    public function a_pending_proposal_does_not_hold_a_vehicle_out_of_service_when_another_ticket_ends(): void
    {
        $vehicle = $this->vehicle();
        $activeId = $this->propose($vehicle, ['sub_issues' => [['title' => 'Brakes']]])->assertCreated()->json('ticket_id');
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$activeId}/approve", ['assigned_mechanic_id' => $this->mechanic->id])->assertOk();
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);

        // A second, still-unapproved proposal on the same vehicle.
        $this->propose($vehicle, ['sub_issues' => [['title' => 'Radio']]])->assertCreated();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$activeId}/cancel", [])->assertOk();

        $this->assertSame('Available', $vehicle->fresh()->status);
    }

    #[Test]
    public function an_unrelated_ticket_ending_does_not_touch_a_vehicle_that_was_never_taken_out_of_service(): void
    {
        $vehicle = $this->vehicle(['status' => 'Available', 'condition' => 'Needs Inspection']);
        $ticket = $this->createTicket($vehicle); // Open, awaiting inspection

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertOk();

        $this->assertSame('Needs Inspection', $vehicle->fresh()->condition);
    }

    #[Test]
    public function a_cannibalized_repair_cannot_use_its_own_vehicle_as_the_donor(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->inspectWithSubIssues($this->createTicket($vehicle), ['Alternator']);
        $subIssue = $ticket->subIssues->first();
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id, 'maintenance_type' => 'Electrical',
        ])->assertOk();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Swapped it.', 'repair_type' => 'cannibalized', 'source_vehicle_id' => $vehicle->vehicle_id,
        ])->assertStatus(422);
    }

    #[Test]
    public function approving_a_cannibalization_on_a_cancelled_ticket_is_refused(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle();
        $ticket = $this->inspectWithSubIssues($this->createTicket($vehicle), ['Alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $donor);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertOk();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/approve-cannibalization", [])->assertStatus(422);
        $this->assertSame(0, VehicleIssueReport::where('vehicle_id', $donor->vehicle_id)->count());
    }

    #[Test]
    public function reassigning_the_custodian_also_moves_a_repair_awaiting_cannibalization_approval(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->inspectWithSubIssues($this->createTicket($vehicle), ['Alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $this->vehicle());

        $newCustodian = User::factory()->create(['role' => 'Custodian']);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $newCustodian->id, 'reassign_reason' => 'Left the barangay.',
        ])->assertOk();

        $this->assertSame($newCustodian->id, $subIssue->fresh()->verification_assigned_to);
    }
}
