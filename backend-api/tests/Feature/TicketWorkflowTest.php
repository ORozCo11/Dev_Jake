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

    private function createTicket(Vehicle $vehicle, string $title = 'Overheating'): MaintenanceTicket
    {
        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->postJson('/api/tickets', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => $title,
            'ticket_description' => 'Engine runs hot after 10 minutes.',
            'priority' => 'High',
            'assigned_custodian_id' => $this->custodian->id,
        ]);
        $response->assertCreated();

        return MaintenanceTicket::findOrFail($response->json('ticket_id'));
    }

    /** Inspects and populates the sub-issue list in one call. */
    private function inspectWithSubIssues(MaintenanceTicket $ticket, array $titles): MaintenanceTicket
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/inspect", [
            'inspection_result' => 'Needs Maintenance',
            'inspection_notes' => 'Confirmed on physical check.',
            'sub_issues' => array_map(fn ($t) => ['title' => $t], $titles),
        ])->assertOk();

        return $ticket->fresh();
    }

    private function driveSubIssueToDone(MaintenanceTicket $ticket, TicketSubIssue $subIssue, ?User $mechanic = null): void
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

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [
                ['item' => 'Engine starts / powers on', 'passed' => true],
                ['item' => 'Reported issue no longer reproduces', 'passed' => true],
            ],
        ])->assertOk();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/confirm", [
            'confirmation_verdict' => 'Confirmed',
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
        $this->assertSame('For Confirmation', $fresh->status);
        $this->assertTrue($fresh->test_attested);
        $this->assertCount(2, $fresh->functional_test);
        $this->assertSame('Engine starts / powers on', $fresh->functional_test[0]['item']);
    }

    #[Test]
    public function a_confirmed_maintenance_need_pulls_the_vehicle_immediately_not_at_mechanic_assignment(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);

        $this->assertSame('Available', $vehicle->fresh()->status);

        $this->inspectWithSubIssues($ticket, ['Low coolant level']);

        // The vehicle must already be pulled from service the moment the
        // Custodian confirms real repair is needed — not later, whenever
        // an Admin happens to get around to assigning a mechanic.
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
        $this->assertSame('Needs Repair', $vehicle->fresh()->condition);
    }

    #[Test]
    public function a_no_issues_inspection_clears_a_stale_needs_inspection_flag(): void
    {
        $vehicle = $this->vehicle(['condition' => 'Needs Inspection']);
        $ticket = $this->createTicket($vehicle);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/inspect", [
            'inspection_result' => 'No Issues',
            'inspection_notes' => 'Checked, nothing wrong.',
        ])->assertOk();

        $this->assertSame('Good', $vehicle->fresh()->condition);
        $this->assertSame('Available', $vehicle->fresh()->status);
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
    public function only_an_admin_can_create_a_ticket(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Nope',
            'ticket_description' => 'Custodians cannot open tickets.',
            'priority' => 'Low',
            'assigned_custodian_id' => $this->custodian->id,
        ])->assertForbidden();
    }

    #[Test]
    public function the_same_main_issue_cannot_open_twice_while_one_is_still_active(): void
    {
        $vehicle = $this->vehicle();
        $this->createTicket($vehicle, 'Overheating');

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/tickets', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'overheating', // case/whitespace-insensitive match
            'ticket_description' => 'Reported again.',
            'priority' => 'Medium',
            'assigned_custodian_id' => $this->custodian->id,
        ])->assertUnprocessable();
    }

    #[Test]
    public function a_different_main_issue_can_open_concurrently_on_the_same_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $this->createTicket($vehicle, 'Overheating');

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/tickets', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Flat Tire',
            'ticket_description' => 'Rear right tire is flat.',
            'priority' => 'Medium',
            'assigned_custodian_id' => $this->custodian->id,
        ])->assertCreated();

        $this->assertSame(2, MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)->count());
    }

    #[Test]
    public function creating_a_ticket_from_an_issue_report_links_them_both_ways(): void
    {
        $vehicle = $this->vehicle();
        $issue = VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Engine Problem',
            'issue_description' => 'Overheating on long drives.',
            'severity_level' => 'High',
            'reported_by' => $this->custodian->id,
            'status' => 'Pending',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $ticketId = $this->postJson('/api/tickets', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Engine Problem',
            'ticket_description' => $issue->issue_description,
            'priority' => 'High',
            'assigned_custodian_id' => $this->custodian->id,
            'issue_report_id' => $issue->issue_report_id,
        ])->assertCreated()->json('ticket_id');

        // The issue moves out of Pending...
        $this->assertSame('In Maintenance', $issue->fresh()->status);

        // ...and the /issues listing exposes the link back to that ticket, so
        // the Issue Report detail page can show "Linked Ticket".
        $listed = collect($this->getJson('/api/issues')->assertOk()->json())
            ->firstWhere('issue_report_id', $issue->issue_report_id);
        $this->assertNotNull($listed['maintenance_ticket'] ?? null);
        $this->assertSame($ticketId, $listed['maintenance_ticket']['ticket_id']);
    }

    #[Test]
    public function a_mechanic_cannot_be_assigned_before_a_sub_issue_exists(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        // A random other user cannot skip straight to a state that isn't Open.
        $subIssue->update(['status' => 'For Inspection']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertUnprocessable();
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
    public function a_sub_issue_can_be_appended_while_the_ticket_is_active_and_grows_the_denominator(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level', 'Faulty radiator']);

        // The assigned Custodian — not Admin — appends the newly found issue.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", [
            'title' => 'Broken water pump',
        ])->assertCreated();

        $this->assertSame(['done' => 0, 'deferred' => 0, 'total' => 3], $ticket->fresh()->progress);
    }

    #[Test]
    public function a_mechanic_already_working_the_ticket_can_also_append_a_sub_issue(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $this->driveSubIssueToInspection($ticket, $ticket->subIssues->first(), $this->mechanic);

        // The mechanic found something else while repairing the first issue.
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", [
            'title' => 'Cracked brake fluid line',
        ])->assertCreated();

        $this->assertSame(2, $ticket->fresh()->progress['total']);
    }

    #[Test]
    public function admin_cannot_add_a_sub_issue(): void
    {
        // Admin never has firsthand contact with the vehicle — only the
        // assigned Custodian or a mechanic already on this ticket may
        // declare a newly discovered problem.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", [
            'title' => 'Reported by phone call',
        ])->assertForbidden();
    }

    #[Test]
    public function a_mechanic_not_assigned_to_this_ticket_cannot_add_a_sub_issue(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        // mechanic2 has no work order on this ticket at all.

        Sanctum::actingAs($this->mechanic2, ['*']);
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", [
            'title' => 'Unrelated finding',
        ])->assertForbidden();
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
    public function a_ticket_cannot_close_until_every_sub_issue_is_done(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level', 'Faulty radiator']);

        $this->driveSubIssueToDone($ticket, $ticket->subIssues[0]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->assertUnprocessable();

        $this->driveSubIssueToDone($ticket->fresh(), $ticket->fresh()->subIssues[1]);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->assertOk();

        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertTrue(TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->exists());
        $this->assertSame(2, VehicleMaintenanceRecord::where('vehicle_id', $vehicle->vehicle_id)->where('progress_status', 'Completed')->count());
    }

    #[Test]
    public function a_stuck_sub_issue_can_be_deferred_so_the_ticket_can_close(): void
    {
        // The scenario the whole feature exists for: one item is fixed, the
        // other genuinely cannot be finished (no budget). Deferring the stuck
        // one lets the ticket reach a closeable state instead of rotting.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Brake pads', 'Water pump seal']);
        [$brakes, $pump] = $ticket->subIssues;

        $this->driveSubIssueToDone($ticket, $brakes);

        Sanctum::actingAs($this->admin, ['*']);
        // Can't close yet — the pump is still unresolved and no reason given.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->assertUnprocessable();

        // Defer the pump with a reason.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$pump->sub_issue_id}/defer", [
            'deferred_reason' => 'Seal on back-order, no budget until Q4.',
        ])->assertOk();

        $this->assertSame('Deferred', $pump->fresh()->status);

        // Now every sub-issue is resolved (1 Done, 1 Deferred) — it closes cleanly.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->assertOk();
        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertSame(['done' => 1, 'deferred' => 1, 'total' => 2], $ticket->fresh()->progress);
    }

    #[Test]
    public function deferring_a_sub_issue_opens_a_breadcrumb_issue_report(): void
    {
        // A deferred defect must not vanish — an inspection-found item with no
        // formal report gets a fresh Pending Issue Report so it stays visible.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Water pump seal']);
        $pump = $ticket->subIssues->first();

        $this->assertSame(0, VehicleIssueReport::where('vehicle_id', $vehicle->vehicle_id)->count());

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$pump->sub_issue_id}/defer", [
            'deferred_reason' => 'No budget until Q4.',
        ])->assertOk();

        $breadcrumb = VehicleIssueReport::where('vehicle_id', $vehicle->vehicle_id)->first();
        $this->assertNotNull($breadcrumb, 'A breadcrumb issue report should have been created.');
        $this->assertSame('Pending', $breadcrumb->status);
        $this->assertSame($breadcrumb->issue_report_id, $pump->fresh()->deferred_issue_report_id);
    }

    #[Test]
    public function a_decision_close_defers_leftovers_and_requires_a_reason_and_a_fitness_call(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Brake pads', 'Water pump seal']);
        [$brakes, $pump] = $ticket->subIssues;
        $this->driveSubIssueToDone($ticket, $brakes);

        Sanctum::actingAs($this->admin, ['*']);
        // Reason given, but no fit-for-service answer -> rejected.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [
            'deferral_reason' => 'No budget for the pump.',
        ])->assertUnprocessable();

        // Both provided -> closes, and the leftover pump is auto-deferred.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [
            'deferral_reason'     => 'No budget for the pump.',
            'returned_to_service' => true,
        ])->assertOk();

        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertSame('Deferred', $pump->fresh()->status);
        $this->assertSame('No budget for the pump.', $pump->fresh()->deferred_reason);
    }

    #[Test]
    public function a_decision_close_that_is_not_fit_for_service_keeps_the_vehicle_out(): void
    {
        // Deferring a *safety* item and declaring the vehicle unfit must NOT
        // return an emergency vehicle to Available just because the ticket closed.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Brakes still spongy']);
        $brakes = $ticket->subIssues->first();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [
            'deferral_reason'     => 'Brake parts unavailable — unsafe to dispatch.',
            'returned_to_service' => false,
        ])->assertOk();

        $vehicle->refresh();
        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertFalse($ticket->fresh()->returned_to_service);
        $this->assertSame('Under Maintenance', $vehicle->status);
        $this->assertSame('Needs Repair', $vehicle->condition);
    }

    #[Test]
    public function closing_a_ticket_finalizes_an_approved_awaiting_confirmation_sub_issue_instead_of_deferring_it(): void
    {
        // Regression for: closeTicket() used to sweep EVERY unresolved
        // sub-issue into Deferred, including one that was already
        // repaired and Custodian-Approved (sitting at For Confirmation) —
        // silently discarding a verified repair the Admin just hadn't
        // gotten around to clicking "Confirm" on. It must be finalized
        // (Done/Confirmed, with a maintenance record) instead.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level', 'Faulty radiator']);
        [$coolant, $radiator] = $ticket->subIssues;

        // First sub-issue goes all the way to Done (fully confirmed).
        $this->driveSubIssueToDone($ticket, $coolant);

        // Second sub-issue is repaired and Custodian-approved, but never
        // explicitly Confirmed by the Admin before the ticket is closed.
        $this->driveSubIssueToInspection($ticket, $radiator);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$radiator->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [
                ['item' => 'Engine starts / powers on', 'passed' => true],
            ],
        ])->assertOk();
        $this->assertSame('For Confirmation', $radiator->fresh()->status);

        // Nothing is genuinely unfinished, so this is NOT a decision-close —
        // no deferral_reason/returned_to_service should be required.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->assertOk();

        $fresh = $radiator->fresh();
        $this->assertSame('Done', $fresh->status);
        $this->assertSame('Confirmed', $fresh->confirmation_verdict);
        $this->assertNotNull($fresh->confirmed_at);

        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertSame(['done' => 2, 'deferred' => 0, 'total' => 2], $ticket->fresh()->progress);
        $this->assertSame(2, VehicleMaintenanceRecord::where('vehicle_id', $vehicle->vehicle_id)->where('progress_status', 'Completed')->count());
    }

    #[Test]
    public function reopening_a_confirmed_sub_issue_re_stamps_verification_to_the_current_custodian(): void
    {
        // Regression for: reopenConfirmedSubIssue() cleared the verification
        // fields but never re-pointed verification_assigned_to at the
        // ticket's CURRENT custodian. If the custodian was reassigned while
        // this sub-issue was already Done (reassignCustodian only cascades
        // sub-issues currently For Inspection), reopening it for
        // re-verification left the stale former custodian's id in place —
        // and verifyRepair() checks only that exact id, blocking the real
        // current custodian.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        $this->driveSubIssueToDone($ticket, $subIssue);
        $this->assertSame('Done', $subIssue->fresh()->status);
        $this->assertSame($this->custodian->id, $subIssue->fresh()->verification_assigned_to);

        // Reassign the ticket's Custodian AFTER this sub-issue is already
        // Done — it is deliberately left stamped with the old custodian.
        $newCustodian = User::factory()->create(['role' => 'Custodian']);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $newCustodian->id,
            'reassign_reason'       => 'Original custodian left the barangay.',
        ])->assertOk();
        $this->assertSame($this->custodian->id, $subIssue->fresh()->verification_assigned_to);

        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reopen-confirmed", [
            'reopen_reason' => 'Found a leak after all.',
        ])->assertOk();

        $fresh = $subIssue->fresh();
        $this->assertSame('For Inspection', $fresh->status);
        $this->assertSame($newCustodian->id, $fresh->verification_assigned_to);

        // The current custodian can now actually verify it.
        Sanctum::actingAs($newCustodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested'        => true,
            'functional_test'      => [
                ['item' => 'Engine starts / powers on', 'passed' => true],
            ],
        ])->assertOk();
    }

    #[Test]
    public function only_admin_can_defer_a_sub_issue(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Water pump seal']);
        $pump = $ticket->subIssues->first();

        foreach ([$this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$pump->sub_issue_id}/defer", [
                'deferred_reason' => 'trying to defer',
            ])->assertForbidden();
        }

        // And a reason is mandatory even for the Admin.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$pump->sub_issue_id}/defer", [])
            ->assertUnprocessable();
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

        $this->assertSame('Active', $ticket->fresh()->status);
    }

    #[Test]
    public function creating_a_ticket_from_a_condition_check_links_it_and_stays_live(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Needs Repair',
            'observations' => 'Brakes feel soft.',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->postJson('/api/tickets', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Condition Check: Needs Repair',
            'ticket_description' => 'From condition check.',
            'priority' => 'High',
            'assigned_custodian_id' => $this->custodian->id,
            'entry_mode' => 'in_house',
            'condition_check_id' => $condition->condition_check_id,
            'sub_issues' => [['title' => 'Brakes feel soft.']],
        ])->assertCreated();
        $ticketId = $response->json('ticket_id');

        // The link is set once, immediately...
        $this->assertSame($ticketId, $condition->fresh()->resulting_ticket_id);

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
        $this->putJson("/api/tickets/{$ticketId}/close", [])->assertOk();

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

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->assertOk();

        // No new sub-issue can ever be appended to a Closed ticket — checked
        // as the assigned Custodian, who otherwise has standing to add one.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", [
            'title' => 'New problem found later',
        ])->assertUnprocessable();

        // ...and it cannot be cancelled/uncancelled either — Closed is final.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertUnprocessable();

        // ...nor deleted — that would create a SECOND, reopenable "Deleted"
        // archive row alongside the permanent "Closed" one, defeating the
        // "closed tickets can never be reopened" guarantee.
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}")->assertUnprocessable();
        $this->assertTrue(MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->exists());
        $this->assertSame(1, TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->count());
    }

    #[Test]
    public function deleting_a_ticket_with_no_finished_sub_issues_leaves_no_archive_trace(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}")->assertOk();

        $this->assertFalse(MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->exists());
        $this->assertFalse(TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->exists());
    }

    #[Test]
    public function deleting_a_ticket_with_real_progress_is_archived_and_reopenable(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level', 'Faulty radiator']);

        // One sub-issue reaches Done, the other is still mid-flight.
        $this->driveSubIssueToDone($ticket, $ticket->subIssues[0]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}")->assertOk();

        $this->assertFalse(MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->exists());
        $archive = TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->first();
        $this->assertNotNull($archive);
        $this->assertSame('Deleted', $archive->final_status);

        // AMB-101-style vehicle should be freed since nothing else is open on it.
        $this->assertSame('Available', $vehicle->fresh()->status);

        $this->putJson("/api/ticket-archives/{$archive->archive_id}/reopen", [])->assertCreated();

        $reopened = MaintenanceTicket::where('ticket_title', $ticket->ticket_title)
            ->where('vehicle_id', $vehicle->vehicle_id)
            ->first();
        $this->assertNotNull($reopened);
        $this->assertSame(2, $reopened->subIssues()->count());
        $this->assertSame(1, $reopened->subIssues()->where('status', 'Done')->count());
        $this->assertFalse(TicketArchiveLog::where('archive_id', $archive->archive_id)->exists());
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
    }

    #[Test]
    public function a_closed_archive_entry_can_never_be_reopened(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);
        $ticket = $this->inspectWithSubIssues($ticket, ['Low coolant level']);
        $this->driveSubIssueToDone($ticket, $ticket->subIssues[0]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->assertOk();
        $archive = TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->firstOrFail();

        $this->putJson("/api/ticket-archives/{$archive->archive_id}/reopen", [])->assertUnprocessable();
    }

    #[Test]
    public function the_vehicle_only_returns_to_service_once_every_open_ticket_is_closed(): void
    {
        $vehicle = $this->vehicle();

        $overheating = $this->createTicket($vehicle, 'Overheating');
        $overheating = $this->inspectWithSubIssues($overheating, ['Low coolant level']);

        Sanctum::actingAs($this->admin, ['*']);
        $flatTire = MaintenanceTicket::findOrFail(
            $this->postJson('/api/tickets', [
                'vehicle_id' => $vehicle->vehicle_id,
                'ticket_title' => 'Flat Tire',
                'ticket_description' => 'Rear right tire is flat.',
                'priority' => 'Medium',
                'assigned_custodian_id' => $this->custodian->id,
            ])->assertCreated()->json('ticket_id')
        );
        $flatTire = $this->inspectWithSubIssues($flatTire, ['Replace rear right tire']);

        // Close the Flat Tire ticket first — Overheating is still open.
        $this->driveSubIssueToDone($flatTire, $flatTire->subIssues[0]);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$flatTire->ticket_id}/close", [])->assertOk();

        $this->assertSame('Under Maintenance', $vehicle->fresh()->status, 'Overheating ticket is still open — vehicle must not be marked Available yet.');

        // Now close Overheating too — only now should the vehicle free up.
        $this->driveSubIssueToDone($overheating->fresh(), $overheating->fresh()->subIssues[0]);
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$overheating->ticket_id}/close", [])->assertOk();

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
    public function a_mechanic_cannot_close_their_own_maintenance_record(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->mechanic, ['*']);
        $create = $this->postJson('/api/maintenance-records', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Routine oil change',
            'progress_status' => 'Under Repair',
        ]);
        $create->assertCreated();
        $recordId = $create->json('maintenance_id');

        $this->putJson("/api/maintenance-records/{$recordId}", [
            'progress_status' => 'Completed',
        ])->assertOk();

        $this->assertSame(
            'For Verification',
            VehicleMaintenanceRecord::findOrFail($recordId)->progress_status
        );
    }

    #[Test]
    public function a_vehicle_cannot_be_double_booked_for_the_same_date(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => '2026-08-01',
        ])->assertCreated();

        $this->postJson('/api/maintenance-schedules', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Tire Rotation',
            'scheduled_date' => '2026-08-01',
        ])->assertUnprocessable();
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

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$confirmSub->sub_issue_id}/confirm", [
            'confirmation_verdict' => 'Confirmed',
        ])->assertUnprocessable();
    }
}
