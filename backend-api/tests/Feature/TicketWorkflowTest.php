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
 * WORKFLOW GUARD TESTS — streamlined ticket workflow (2026-10-12).
 *
 * A ticket is now one job: ONE assigned mechanic for every sub-issue on it,
 * and ONE plain verification by the assigned Custodian that closes the
 * whole ticket at once. There is no more per-sub-issue mechanic dispatch,
 * no per-sub-issue verify/confirm, and no Admin "close" step — a ticket
 * reaches Active only via a Custodian's proposal that an Admin approves
 * (which also dispatches the one mechanic), and it reaches Closed only via
 * the assigned Custodian's single attestation (TicketController::
 * verifyTicket()), which finalizes every sub-issue in the same transaction.
 *
 * These tests prove: who may act at each step (propose -> approve ->
 * log repairs -> submit for verification -> verify), that the old
 * per-sub-issue lifecycle endpoints (assign/reassign mechanic, verify,
 * confirm, defer, close) are now permanently unreachable by anyone, that
 * self-verification is blocked at the ticket level (including across a
 * mechanic reassignment), and that a vehicle only returns to service once
 * none of its tickets are still open.
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
     * HTTP) exactly like the old createTicket() endpoint's default
     * 'inspection' entry mode used to. That endpoint is gated by
     * ticket.create, which no role holds any more (nobody can create a
     * ticket directly; only propose+approve), so tests that just need "a
     * ticket exists, never touched" build one straight via the model
     * instead of depending on a permission this suite is itself proving
     * is gone.
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
     * Pure test scaffolding for a ticket in the ONLY way it can now reach
     * Active — a Custodian's proposal (ticket.propose), approved by an
     * Admin (ticket.approve) with a single assigned_mechanic_id.
     * TicketController::approveTicket() bulk-dispatches EVERY sub-issue to
     * that one mechanic (status 'Under Repair'), replacing the old
     * per-sub-issue assignMechanic() dispatch. Returns the fresh ticket
     * with its sub-issues loaded.
     */
    private function activeTicket(Vehicle $vehicle, array $titles, ?User $mechanic = null, ?User $custodian = null): MaintenanceTicket
    {
        $mechanic ??= $this->mechanic;
        $custodian ??= $this->custodian;

        Sanctum::actingAs($custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Engine runs hot after 10 minutes.',
            'priority' => 'High',
            'sub_issues' => array_map(fn ($t) => ['title' => $t], $titles),
        ])->assertCreated()->json('ticket_id');

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/approve", [
            'assigned_mechanic_id' => $mechanic->id,
        ])->assertOk();

        return MaintenanceTicket::with('subIssues')->findOrFail($ticketId);
    }

    /** The ticket's assigned mechanic logs a repair on every sub-issue. */
    private function logRepairsForEverySubIssue(MaintenanceTicket $ticket, ?User $mechanic = null): void
    {
        $mechanic ??= $this->mechanic;

        Sanctum::actingAs($mechanic, ['*']);
        foreach ($ticket->subIssues()->get() as $subIssue) {
            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
                'repair_logs' => 'Fixed it.',
            ])->assertOk();
        }
    }

    /** Mechanic submits the ticket for verification; Custodian attests and closes it. */
    private function submitAndVerify(MaintenanceTicket $ticket, ?User $mechanic = null, ?User $custodian = null): void
    {
        $mechanic ??= $this->mechanic;
        $custodian ??= $this->custodian;

        Sanctum::actingAs($mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        Sanctum::actingAs($custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertOk();
    }

    /** Full happy path: log repairs on every sub-issue, submit, verify -> Closed. */
    private function driveTicketToClosed(MaintenanceTicket $ticket, ?User $mechanic = null, ?User $custodian = null): MaintenanceTicket
    {
        $this->logRepairsForEverySubIssue($ticket, $mechanic);
        $this->submitAndVerify($ticket, $mechanic, $custodian);

        return $ticket->fresh(['subIssues']);
    }

    #[Test]
    public function nobody_can_create_a_ticket_directly_any_more(): void
    {
        // ticket.create has no role (config/permissions.php) — every ticket
        // must now originate as a Custodian's proposal (see the propose/
        // approve tests below) that an Admin reviews and approves.
        $vehicle = $this->vehicle();
        $payload = [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Nope',
            'ticket_description' => 'Nobody can open a ticket directly.',
            'priority' => 'Low',
            'assigned_custodian_id' => $this->custodian->id,
        ];

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets', $payload)->assertForbidden();

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/tickets', $payload)->assertForbidden();
    }

    #[Test]
    public function nobody_can_submit_an_inspection_any_more(): void
    {
        // ticket.inspect has no role — the inspection phase (Open ->
        // submitInspection() -> Active) is gone entirely. A proposal always
        // states what's wrong and how it'll be fixed up front; there is no
        // "Custodian diagnoses first" step left to submit.
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);

        foreach ([$this->custodian, $this->admin, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->putJson("/api/tickets/{$ticket->ticket_id}/inspect", [
                'inspection_result' => 'No Issues',
            ])->assertForbidden();
        }
    }

    #[Test]
    public function the_old_per_sub_issue_verify_confirm_close_and_defer_endpoints_are_now_unreachable_by_anyone(): void
    {
        // subissue.verify, subissue.confirm, ticket.close and subissue.defer
        // are all empty ability grants now — requireAbility() 403s literally
        // everyone, including Admin, the role that used to hold several of
        // these. The ticket-level replacements (submit-for-verification,
        // verify) are exercised by their own dedicated tests below.
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        foreach ([$this->admin, $this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);

            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/verify", [
                'verification_verdict' => 'Approved',
                'test_attested'        => true,
                'functional_test'      => [['item' => 'Engine starts', 'passed' => true]],
            ])->assertForbidden();

            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/confirm", [
                'confirmation_verdict' => 'Confirmed',
            ])->assertForbidden();

            $this->putJson("/api/tickets/{$ticket->ticket_id}/close", [])->assertForbidden();

            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/defer", [
                'deferred_reason' => 'trying to defer',
            ])->assertForbidden();
        }
    }

    #[Test]
    public function nobody_can_assign_or_reassign_a_mechanic_on_an_individual_sub_issue_any_more(): void
    {
        // subissue.assign_mechanic / subissue.reassign_mechanic are both
        // empty ability grants now — the whole ticket gets ONE mechanic via
        // approveTicket() at approval time, changeable only ticket-wide via
        // assignTicketMechanic() (see the dedicated tests below).
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        foreach ([$this->admin, $this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);

            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
                'assigned_mechanic_id' => $this->mechanic2->id,
                'maintenance_type' => 'Engine Repair',
            ])->assertForbidden();

            $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/reassign-mechanic", [
                'assigned_mechanic_id' => $this->mechanic2->id,
                'reassign_reason' => 'x',
            ])->assertForbidden();
        }
    }

    #[Test]
    public function verifying_requires_attestation_and_every_sub_issue_ready(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->logRepairsForEverySubIssue($ticket);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);

        // No attestation at all -> rejected.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", [])->assertUnprocessable();

        // An explicit false attestation -> rejected (accepted rule).
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => false])->assertUnprocessable();

        $this->assertSame('For Verification', $ticket->fresh()->status);

        // A truthy attestation succeeds and closes the ticket.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertOk();
        $this->assertSame('Closed', $ticket->fresh()->status);
    }

    #[Test]
    public function a_valid_attestation_closes_the_ticket_and_finalizes_every_sub_issue(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level', 'Faulty radiator']);
        $this->driveTicketToClosed($ticket);

        $fresh = $ticket->fresh(['subIssues']);
        $this->assertSame('Closed', $fresh->status);
        $this->assertSame($this->custodian->id, $fresh->closed_by);
        $this->assertNotNull($fresh->closed_at);
        $this->assertTrue($fresh->returned_to_service);
        $this->assertNotNull($fresh->archived_at);

        foreach ($fresh->subIssues as $subIssue) {
            $this->assertSame('Done', $subIssue->status);
            $this->assertSame('Approved', $subIssue->verification_verdict);
            $this->assertSame($this->custodian->id, $subIssue->verified_by);
            $this->assertNotNull($subIssue->verified_at);
            $this->assertSame('Confirmed', $subIssue->confirmation_verdict);
        }

        $this->assertSame(2, VehicleMaintenanceRecord::where('vehicle_id', $vehicle->vehicle_id)->where('progress_status', 'Completed')->count());
    }

    #[Test]
    public function approving_a_proposal_pulls_the_vehicle_out_of_service_immediately(): void
    {
        $vehicle = $this->vehicle();
        $this->assertSame('Available', $vehicle->fresh()->status);

        Sanctum::actingAs($this->custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Overheating.',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Low coolant level']],
        ])->assertCreated()->json('ticket_id');

        // Still available — a Pending Approval proposal has not taken the
        // vehicle out of service yet.
        $this->assertSame('Available', $vehicle->fresh()->status);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/approve", [
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertOk();

        // Approval dispatches the mechanic AND pulls the vehicle out of
        // service in the same atomic step — there is no separate "mechanic
        // assignment" step any more for this to lag behind.
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
        $this->assertSame('Needs Repair', $vehicle->fresh()->condition);
    }

    #[Test]
    public function a_mechanic_can_attach_a_photo_or_document_when_logging_repairs(): void
    {
        Storage::fake('supabase');

        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

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
    public function proposing_a_ticket_from_an_issue_report_links_them_both_ways(): void
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

        Sanctum::actingAs($this->custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Engine Problem',
            'ticket_description' => $issue->issue_description,
            'priority' => 'High',
            'issue_report_id' => $issue->issue_report_id,
            'sub_issues' => [['title' => 'Overheating on long drives']],
        ])->assertCreated()->json('ticket_id');

        // The issue moves out of Pending as soon as it's proposed, not only
        // once an Admin approves — same timing createTicket() used to have.
        $this->assertSame('In Maintenance', $issue->fresh()->status);

        // ...and the /issues listing exposes the link back to that ticket, so
        // the Issue Report detail page can show "Linked Ticket".
        $listed = collect($this->getJson('/api/issues')->assertOk()->json())
            ->firstWhere('issue_report_id', $issue->issue_report_id);
        $this->assertNotNull($listed['maintenance_ticket'] ?? null);
        $this->assertSame($ticketId, $listed['maintenance_ticket']['ticket_id']);
    }

    #[Test]
    public function only_admin_and_the_assigned_custodian_can_append_sub_issues_to_an_active_ticket(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level']);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", ['title' => 'Another problem'])->assertForbidden();

        foreach ([$this->custodian, $this->admin] as $who) {
            Sanctum::actingAs($who, ['*']);
            $response = $this->postJson("/api/tickets/{$ticket->ticket_id}/sub-issues", ['title' => 'Another problem'])->assertCreated();
            // The ticket already has one assigned mechanic by the time it's
            // Active — a line item added afterwards is simply more work for
            // that same mechanic (per-sub-issue dispatch no longer exists to
            // pick it up), not a fresh unassigned 'Open' item.
            $this->assertSame('Under Repair', $response->json('status'));
            $this->assertSame($this->mechanic->id, $response->json('assigned_mechanic_id'));
        }
        $this->assertSame(3, $ticket->fresh()->subIssues()->count());
    }

    #[Test]
    public function a_sub_issue_can_be_edited_or_removed_any_time_before_its_repair_is_logged(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level', 'Faulty radiator']);
        [$coolant, $radiator] = $ticket->subIssues;

        // Already 'Under Repair' (auto-dispatched at approval) — still
        // editable/removable, since its repair hasn't been logged yet.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$coolant->sub_issue_id}", [
            'title' => 'Low coolant level (confirmed)',
        ])->assertOk();

        // Once a repair is logged (-> 'For Inspection'), it's locked.
        $this->logRepairsForEverySubIssue($ticket->fresh(['subIssues']));
        $radiator->refresh();
        $coolant->refresh();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$coolant->sub_issue_id}", [
            'title' => 'Too late',
        ])->assertUnprocessable();
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$radiator->sub_issue_id}")->assertUnprocessable();
    }

    #[Test]
    public function a_ticket_exposes_its_age_in_days(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->createTicket($vehicle);

        // Freshly created -> 0 whole days old, and the attribute is exposed.
        $this->assertSame(0, $ticket->fresh()->days_open);
    }

    // =======================================================================
    // Ticket-level mechanic assignment/reassignment (assignTicketMechanic)
    // =======================================================================

    #[Test]
    public function only_admin_can_reassign_the_tickets_mechanic(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level']);

        foreach ([$this->custodian, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
                'assigned_mechanic_id' => $this->mechanic2->id,
                'reassign_reason' => 'trying to reassign',
            ])->assertForbidden();
        }

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'Original mechanic is out sick.',
        ])->assertOk();

        $fresh = $ticket->fresh(['subIssues']);
        $this->assertSame($this->mechanic2->id, $fresh->assigned_mechanic_id);
        foreach ($fresh->subIssues as $subIssue) {
            $this->assertSame($this->mechanic2->id, $subIssue->assigned_mechanic_id);
            $this->assertSame([$this->mechanic->id], $subIssue->prior_mechanic_ids);
        }
    }

    #[Test]
    public function the_tickets_mechanic_cannot_be_reassigned_unless_active_or_for_verification(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Overheating.',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Low coolant level']],
        ])->assertCreated()->json('ticket_id');

        // Still Pending Approval — no assigned_mechanic_id to reassign yet.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'reassign_reason' => 'too early',
        ])->assertUnprocessable();

        $this->putJson("/api/tickets/{$ticketId}/approve", ['assigned_mechanic_id' => $this->mechanic->id])->assertOk();

        $ticket = MaintenanceTicket::findOrFail($ticketId);
        $this->driveTicketToClosed($ticket);

        // Now Closed — can no longer be reassigned.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'too late',
        ])->assertUnprocessable();
    }

    #[Test]
    public function reassigning_the_mechanic_bumps_a_for_verification_ticket_back_to_active(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level']);
        $this->logRepairsForEverySubIssue($ticket);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();
        $this->assertSame('For Verification', $ticket->fresh()->status);

        // The new mechanic's work needs re-verifying — not the old one's.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'Swapping mechanics after submission.',
        ])->assertOk();

        $this->assertSame('Active', $ticket->fresh()->status);
    }

    #[Test]
    public function prior_mechanic_ids_accumulate_across_ticket_level_reassignments_without_duplicates(): void
    {
        $ticket = $this->activeTicket($this->vehicle(), ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();
        $third = User::factory()->create(['role' => 'Maintenance Personnel']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'first handoff',
        ])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $third->id,
            'reassign_reason' => 'second handoff',
        ])->assertOk();

        $this->assertSame([$this->mechanic->id, $this->mechanic2->id], $subIssue->fresh()->prior_mechanic_ids);
    }

    #[Test]
    public function a_ticket_with_every_sub_issue_already_resolved_cannot_be_cancelled(): void
    {
        // Real, confirmed repair work is on record here — cancelling would
        // void it instead of just abandoning an unstarted/unfinished ticket.
        // Simulated as pre-existing (legacy-style) progress via direct model
        // update, since under the new flow a sub-issue reaching Done always
        // closes the whole ticket in the same transaction (verifyTicket()) —
        // there's no live path that leaves a ticket Active with every
        // sub-issue already Done, but this guard still protects historical
        // data left in that shape.
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $ticket->subIssues->first()->update(['status' => 'Done']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertUnprocessable();

        $this->assertSame('Active', $ticket->fresh()->status);
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
        $this->driveTicketToClosed($ticket);

        $listedAfterClose = $this->getJson('/api/conditions')->assertOk()->json();
        $rowAfterClose = collect($listedAfterClose)->firstWhere('condition_check_id', $condition->condition_check_id);
        $this->assertSame('Closed', $rowAfterClose['resulting_ticket']['status']);
        $this->assertSame('Needs Repair', $rowAfterClose['condition_result']);
    }

    #[Test]
    public function closed_tickets_are_permanently_locked(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->driveTicketToClosed($ticket);

        // ...it cannot be cancelled/uncancelled either — Closed is final.
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
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}")->assertOk();

        $this->assertFalse(MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->exists());
        $this->assertFalse(TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->exists());
    }

    #[Test]
    public function deleting_a_ticket_with_real_progress_is_archived_and_reopenable(): void
    {
        // One sub-issue already Done (simulated as pre-existing progress —
        // see the note on cancellation above), the other still mid-flight.
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level', 'Faulty radiator']);
        $ticket->subIssues[0]->update(['status' => 'Done']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/tickets/{$ticket->ticket_id}")->assertOk();

        $this->assertFalse(MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->exists());
        $archive = TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->first();
        $this->assertNotNull($archive);
        $this->assertSame('Deleted', $archive->final_status);

        // Vehicle should be freed since nothing else is open on it.
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
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->driveTicketToClosed($ticket);
        $archive = TicketArchiveLog::where('ticket_id', $ticket->ticket_id)->firstOrFail();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/ticket-archives/{$archive->archive_id}/reopen", [])->assertUnprocessable();
    }

    #[Test]
    public function the_vehicle_only_returns_to_service_once_every_open_ticket_is_closed(): void
    {
        $vehicle = $this->vehicle();

        $overheating = $this->activeTicket($vehicle, ['Low coolant level']);
        $flatTire = $this->activeTicket($vehicle, ['Replace rear right tire']);

        // Close the Flat Tire ticket first — Overheating is still open.
        $this->driveTicketToClosed($flatTire);

        $this->assertSame('Under Maintenance', $vehicle->fresh()->status, 'Overheating ticket is still open — vehicle must not be marked Available yet.');

        // Now close Overheating too — only now should the vehicle free up.
        $this->driveTicketToClosed($overheating->fresh());

        $this->assertSame('Available', $vehicle->fresh()->status);
        $this->assertSame('Good', $vehicle->fresh()->condition);
    }

    #[Test]
    public function dashboard_badge_counts_reflect_assignment_and_verification(): void
    {
        // Verification is now a ticket-level step (one Custodian attestation
        // closes the whole job), so 'ticketVerifications' counts TICKETS at
        // For Verification, not sub-issues — 'ticketWorkOrders' is still per
        // sub-issue (FleetController::dashboard()).
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->getJson('/api/dashboard')->assertOk()->assertJsonPath('badge_counts.ticketWorkOrders', 1);

        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Topped up coolant.',
        ])->assertOk();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->getJson('/api/dashboard')->assertOk()->assertJsonPath('badge_counts.ticketVerifications', 1);
    }

    #[Test]
    public function a_mechanic_cannot_create_a_standalone_maintenance_record_at_all(): void
    {
        // Phase B4 — standalone Maintenance Records are now an Admin-only
        // manual/historical ledger; a Maintenance Personnel account has no
        // create/edit access to them whatsoever (they log real repairs
        // through a ticket sub-issue instead).
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson('/api/maintenance-records', [
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'problem_reason' => 'Routine oil change',
            'progress_status' => 'Under Repair',
        ])->assertForbidden();
    }

    #[Test]
    public function double_booking_a_vehicle_warns_instead_of_blocking_and_a_confirm_proceeds(): void
    {
        // Spec §19 (2026-10-06) moved schedule.create from Admin to
        // Custodian — see config/permissions.php. This test is about the
        // double-booking rule itself, which used to be a hard 422 and is now
        // a warning the caller can confirm past (see FleetController::
        // checkScheduleConflicts()).
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
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
    public function a_cancelled_ticket_blocks_every_subsequent_ticket_level_action(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level', 'Faulty radiator']);

        // Cancel while both sub-issues are still mid-flight (neither Done
        // nor Deferred, so cancelTicket() allows it).
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertOk();
        $this->assertSame('Cancelled', $ticket->fresh()->status);

        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Should be blocked.',
        ])->assertUnprocessable();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertUnprocessable();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic2->id,
            'reassign_reason' => 'testing',
        ])->assertUnprocessable();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertUnprocessable();
    }

    // =======================================================================
    // Self-verification is blocked at the TICKET level, even across a
    // mechanic reassignment and for a dual-role account.
    // =======================================================================

    #[Test]
    public function a_mechanic_who_also_holds_the_verifying_custodians_account_cannot_approve_their_own_repair(): void
    {
        $vehicle = $this->vehicle();

        // $this->custodian is this ticket's assigned Custodian/verifier —
        // give them the Maintenance Personnel hat too, then assign the
        // ticket's repair work to themself.
        $this->custodian->update(['roles' => ['Custodian', 'Maintenance Personnel']]);
        $ticket = $this->activeTicket($vehicle, ['Low coolant level'], $this->custodian, $this->custodian);
        $this->logRepairsForEverySubIssue($ticket, $this->custodian);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])
            ->assertForbidden()
            ->assertJsonFragment(['message' => 'You performed repair work on this ticket — it must be verified by a different Custodian. Reassign this ticket to another Custodian.']);

        $this->assertSame('For Verification', $ticket->fresh()->status);
    }

    #[Test]
    public function a_mechanic_reassigned_away_mid_repair_who_is_also_the_custodian_still_cannot_verify_their_own_earlier_work(): void
    {
        // Closes a self-verification gap: the guard must check EVERY
        // sub-issue's prior_mechanic_ids, not just the ticket's CURRENT
        // assigned_mechanic_id — a mechanic who did real repair work and was
        // then reassigned away before the ticket reached verification must
        // still be blocked, even though assignTicketMechanic() now names
        // someone else entirely.
        $vehicle = $this->vehicle();
        $this->custodian->update(['roles' => ['Custodian', 'Maintenance Personnel']]);

        $ticket = $this->activeTicket($vehicle, ['Low coolant level'], $this->custodian, $this->custodian);

        // Reassigned away before the custodian-mechanic ever submits repair
        // logs for their own work.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/assign-mechanic", [
            'assigned_mechanic_id' => $this->mechanic->id,
            'reassign_reason' => 'Reassigning mid-repair for testing.',
        ])->assertOk();

        $subIssue = $ticket->subIssues->first();
        $this->assertSame([$this->custodian->id], $subIssue->fresh()->prior_mechanic_ids);

        // A different mechanic finishes and submits the paperwork.
        $this->logRepairsForEverySubIssue($ticket->fresh(['subIssues']), $this->mechanic);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        // The original mechanic — now only wearing the Custodian hat on
        // paper, but who actually did earlier repair work on this ticket —
        // still cannot verify it, even though assigned_mechanic_id now
        // names someone else entirely.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])
            ->assertForbidden()
            ->assertJsonFragment(['message' => 'You performed repair work on this ticket — it must be verified by a different Custodian. Reassign this ticket to another Custodian.']);
    }

    #[Test]
    public function an_admin_cannot_verify_a_repair_even_as_a_fallback_and_must_reassign_the_custodian_instead(): void
    {
        // Production-readiness audit finding #2 — Admin was previously a
        // general Tier-1 verification fallback. That's removed: verification
        // is Custodian-only, full stop (ticket.verify's ability grant is
        // ['Custodian']). An unavailable Custodian is handled by reassigning
        // the ticket, not by Admin quietly standing in for the check.
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->logRepairsForEverySubIssue($ticket);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertForbidden();

        // The actual, correct fix: reassign the ticket to a different
        // Custodian, who can then verify it normally.
        $standInCustodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $standInCustodian->id,
            'reassign_reason' => 'Original custodian unavailable.',
        ])->assertOk();

        Sanctum::actingAs($standInCustodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertOk();

        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertSame($standInCustodian->id, $ticket->fresh()->closed_by);
    }

    #[Test]
    public function a_maintenance_personnel_only_account_still_cannot_call_verify_at_all(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level']);
        $this->logRepairsForEverySubIssue($ticket);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertForbidden();
    }

    #[Test]
    public function reassigning_the_custodian_to_the_subissues_own_mechanic_warns_but_does_not_block(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level'], $this->mechanic);

        // $this->mechanic is about to become the ticket's Custodian while
        // also still being this ticket's assigned mechanic.
        $this->mechanic->update(['roles' => ['Maintenance Personnel', 'Custodian']]);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($this->admin, ['*']);
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

    #[Test]
    public function reassigning_the_custodian_ignores_a_conflict_on_an_already_done_sub_issue(): void
    {
        // A Done sub-issue is already verified — no conflict left to warn
        // about. Simulated as pre-existing progress via direct model update
        // (see the cancellation guard test above for why).
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Low coolant level'], $this->mechanic);
        $this->mechanic->update(['roles' => ['Maintenance Personnel', 'Custodian']]);
        $ticket->subIssues->first()->update(['status' => 'Done']);

        Sanctum::actingAs($this->admin, ['*']);
        $response = $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $this->mechanic->id,
            'reassign_reason' => 'Original custodian is out.',
        ])->assertOk();

        $this->assertArrayNotHasKey('warning', $response->json(), 'A Done sub-issue is already verified — no conflict left to warn about.');
    }

    // =======================================================================
    // VMS-IMPROVEMENT-PLAN.md Phase A3 — a cannibalized repair needs an
    // Admin's sign-off, and approving one opens an Issue Report on the
    // donor vehicle instead of the "part just vanished" it used to be.
    // Unaffected by the ticket-workflow simplification other than the
    // mechanic already being dispatched to every sub-issue at approval.
    // =======================================================================

    private function logCannibalizedRepair(MaintenanceTicket $ticket, TicketSubIssue $subIssue, Vehicle $donorVehicle, ?User $mechanic = null)
    {
        $mechanic ??= $this->mechanic;

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
        $ticket = $this->activeTicket($vehicle, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();

        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        $subIssue->refresh();
        $this->assertSame('Pending Approval', $subIssue->status);
        $this->assertSame('Pending', $subIssue->cannibalization_status);
        $this->assertSame($donor->vehicle_id, $subIssue->source_vehicle_id);
    }

    #[Test]
    public function a_ticket_cannot_be_submitted_for_verification_while_a_repair_is_pending_cannibalization_approval(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->activeTicket($vehicle, ['Broken alternator']);
        $subIssue = $ticket->subIssues->first();
        $this->logCannibalizedRepair($ticket, $subIssue, $donor)->assertOk();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertUnprocessable();
    }

    #[Test]
    public function approving_a_cannibalized_repair_releases_it_to_inspection_and_opens_an_issue_report_on_the_donor(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->activeTicket($vehicle, ['Broken alternator']);
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
        $this->assertNotNull($subIssue->cannibalization_issue_report_id);

        $donor->refresh();
        $this->assertSame('Needs Inspection', $donor->condition);
        $this->assertDatabaseHas('vehicle_issue_reports', [
            'issue_report_id' => $subIssue->cannibalization_issue_report_id,
            'vehicle_id' => $donor->vehicle_id,
            'status' => 'Pending',
        ]);
        $this->assertDatabaseHas('vehicle_histories', [
            'vehicle_id' => $donor->vehicle_id,
            'activity_type' => 'Issue Reported',
            'related_record_id' => (string) $subIssue->cannibalization_issue_report_id,
        ]);

        // Now released to the normal pipeline — the ticket can be submitted
        // and the Custodian can verify it, closing the ticket.
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertOk();
        $this->assertSame('Closed', $ticket->fresh()->status);
    }

    #[Test]
    public function rejecting_a_cannibalized_repair_sends_it_back_to_under_repair_with_no_donor_side_effects(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle(['vehicle_name' => 'Donor Vehicle']);
        $ticket = $this->activeTicket($vehicle, ['Broken alternator']);
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
        $ticket = $this->activeTicket($vehicle, ['Broken alternator']);
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
        $ticket = $this->activeTicket($vehicle, ['Broken alternator']);
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
        $ticket = $this->activeTicket($vehicle, ['Broken alternator']);
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
        $ticket = $this->activeTicket($vehicle, ['Loose bolt']);
        $subIssue = $ticket->subIssues->first();

        $this->logRepairsForEverySubIssue($ticket);

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
    public function declining_a_proposal_puts_its_linked_issue_report_back_to_pending(): void
    {
        $vehicle = $this->vehicle();
        $issue = $this->pendingIssue($vehicle);
        $ticketId = $this->propose($vehicle, ['issue_report_id' => $issue->issue_report_id])->assertCreated()->json('ticket_id');
        $this->assertSame('In Maintenance', $issue->fresh()->status);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/decline", ['decline_reason' => 'Not needed.'])->assertOk();

        $this->assertSame('Pending', $issue->fresh()->status);
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
    public function a_proposal_cannot_link_another_vehicles_issue_or_an_already_handled_one(): void
    {
        $vehicle = $this->vehicle();
        $other = $this->vehicle();

        $this->propose($vehicle, ['issue_report_id' => $this->pendingIssue($other)->issue_report_id])->assertStatus(422);
        $this->propose($vehicle, ['issue_report_id' => $this->pendingIssue($vehicle, 'In Maintenance')->issue_report_id])->assertStatus(422);
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
        $ticket = $this->createTicket($vehicle); // Open, never touched

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel", [])->assertOk();

        $this->assertSame('Needs Inspection', $vehicle->fresh()->condition);
    }

    #[Test]
    public function a_clean_close_always_returns_the_vehicle_to_service(): void
    {
        // The old "close with an explicit not-fit-for-service answer" option
        // is gone — verifyTicket() is a single plain attestation with only
        // "approve" (see its docblock); a repair that didn't actually work
        // is handled by reassigning the mechanic or cancelling the ticket,
        // not by closing it anyway and leaving the vehicle flagged down.
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Loose bolt']);
        $this->driveTicketToClosed($ticket);

        $this->assertSame('Available', $vehicle->fresh()->status);
        $this->assertTrue($ticket->fresh()->returned_to_service);
    }

    #[Test]
    public function a_cannibalized_repair_cannot_use_its_own_vehicle_as_the_donor(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->activeTicket($vehicle, ['Alternator']);
        $subIssue = $ticket->subIssues->first();

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
        $ticket = $this->activeTicket($vehicle, ['Alternator']);
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
        $ticket = $this->activeTicket($vehicle, ['Alternator']);
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
