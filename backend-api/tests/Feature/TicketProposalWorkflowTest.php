<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\MaintenanceTicket;
use App\Models\Province;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Custodian proposes a ticket (own information + a suggested mechanic per
 * sub-issue); Admin reviews, can edit ticket/sub-issue fields, then either
 * approves (dispatches any still-valid suggested mechanic, same effect as
 * assignMechanic()) or declines. Declining is a visible, reversible status
 * (not a delete) — the Custodian sees it was declined and why, and Admin can
 * undecline() it back to Pending Approval or approve it directly from
 * Declined without undeclining first. Admin's own createTicket() is
 * unaffected — this is an additional path in, not a replacement.
 */
class TicketProposalWorkflowTest extends TestCase
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

        $this->admin = $this->user('Admin');
        $this->custodian = $this->user('Custodian');
        $this->mechanic = $this->user('Maintenance Personnel');
    }

    private function user(string $role): User
    {
        return User::factory()->create([
            'role' => $role, 'roles' => [$role], 'barangay_id' => $this->barangayId, 'is_active' => true,
        ]);
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
            'barangay_id' => $this->barangayId,
        ]);
    }

    private function propose(Vehicle $vehicle, array $overrides = []): MaintenanceTicket
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $response = $this->postJson('/api/tickets/propose', array_merge([
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'Runs hot after 10 minutes.',
            'priority' => 'High',
            'sub_issues' => [
                ['title' => 'Worn belt', 'suggested_mechanic_id' => $this->mechanic->id],
            ],
        ], $overrides))->assertCreated();

        return MaintenanceTicket::findOrFail($response->json('ticket_id'));
    }

    #[Test]
    public function a_custodian_can_propose_a_ticket_with_a_suggested_mechanic(): void
    {
        $ticket = $this->propose($this->vehicle());

        $this->assertSame('Pending Approval', $ticket->status);
        $this->assertSame($this->custodian->id, $ticket->assigned_custodian_id);

        $subIssue = $ticket->subIssues->first();
        $this->assertSame('Open', $subIssue->status);
        $this->assertNull($subIssue->assigned_mechanic_id);
        $this->assertSame($this->mechanic->id, $subIssue->suggested_mechanic_id);

        $this->assertDatabaseHas('notifications', [
            'user_id' => $this->admin->id,
            'type' => 'ticket_proposed',
        ]);
    }

    #[Test]
    public function proposing_a_ticket_from_an_issue_report_links_it_without_re_entering_its_data(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
        $issue = $this->postJson('/api/issues', [
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Overheating',
            'issue_description' => 'Runs hot after 10 minutes.',
            'severity_level' => 'High',
        ])->assertCreated()->json();

        $ticket = $this->propose($vehicle, ['issue_report_id' => $issue['issue_report_id']]);

        $this->assertSame($issue['issue_report_id'], $ticket->issue_report_id);
        $this->assertDatabaseHas('vehicle_issue_reports', [
            'issue_report_id' => $issue['issue_report_id'],
            'status' => 'In Maintenance',
        ]);
    }

    #[Test]
    public function admin_and_maintenance_personnel_cannot_propose_a_ticket(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'x',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Worn belt']],
        ])->assertForbidden();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'x',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Worn belt']],
        ])->assertForbidden();
    }

    #[Test]
    public function cannot_propose_a_ticket_on_a_decommissioned_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $vehicle->update(['status' => 'Decommissioned']);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'x',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Worn belt']],
        ])->assertStatus(422);
    }

    #[Test]
    public function a_suggested_mechanic_must_be_maintenance_personnel_in_the_same_barangay(): void
    {
        $outsideMechanic = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel']]);
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'x',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Worn belt', 'suggested_mechanic_id' => $outsideMechanic->id]],
        ])->assertStatus(422);

        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'x',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Worn belt', 'suggested_mechanic_id' => $this->custodian->id]],
        ])->assertStatus(422);
    }

    #[Test]
    public function admin_can_approve_a_proposal_which_dispatches_the_chosen_mechanic(): void
    {
        // Streamlined workflow (2026-10-12) — approval no longer
        // auto-dispatches a sub-issue's suggested_mechanic_id (that legacy
        // dispatch is deliberately skipped now); approveTicket() REQUIRES an
        // explicit assigned_mechanic_id and bulk-dispatches that ONE
        // mechanic to every sub-issue on the ticket.
        $vehicle = $this->vehicle();
        $ticket = $this->propose($vehicle);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertOk();

        $ticket->refresh();
        $this->assertSame('Active', $ticket->status);
        $this->assertSame($this->mechanic->id, $ticket->assigned_mechanic_id);
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);

        $subIssue = $ticket->subIssues->first();
        $this->assertSame('Under Repair', $subIssue->status);
        $this->assertSame($this->mechanic->id, $subIssue->assigned_mechanic_id);
        $this->assertNotNull($subIssue->mechanic_assigned_at);
        $this->assertSame($this->admin->id, $subIssue->mechanic_assigned_by);

        $this->assertDatabaseHas('notifications', ['user_id' => $this->custodian->id, 'type' => 'ticket_approved']);
        $this->assertDatabaseHas('notifications', ['user_id' => $this->mechanic->id, 'type' => 'ticket_assigned']);
    }

    #[Test]
    public function every_sub_issue_is_dispatched_to_the_one_chosen_mechanic_regardless_of_any_suggestion(): void
    {
        // A sub-issue proposed with NO suggested_mechanic_id used to stay
        // Open after approval. Under the streamlined, one-mechanic-per-ticket
        // model there's no such thing any more — approveTicket() bulk-
        // dispatches every sub-issue to the single mechanic the Admin picks.
        $vehicle = $this->vehicle();
        Sanctum::actingAs($this->custodian, ['*']);
        $response = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'x',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Worn belt']],
        ])->assertCreated();
        $ticket = MaintenanceTicket::findOrFail($response->json('ticket_id'));

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertOk();

        $fresh = $ticket->subIssues->first()->fresh();
        $this->assertSame('Under Repair', $fresh->status);
        $this->assertSame($this->mechanic->id, $fresh->assigned_mechanic_id);
    }

    #[Test]
    public function admin_can_edit_fields_while_approving(): void
    {
        $vehicle = $this->vehicle();
        $ticket = $this->propose($vehicle);
        $subIssue = $ticket->subIssues->first();
        $otherMechanic = $this->user('Maintenance Personnel');
        $assignedMechanic = $this->user('Maintenance Personnel');

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [
            'priority' => 'Medium',
            'assigned_mechanic_id' => $assignedMechanic->id,
            'sub_issues' => [
                ['sub_issue_id' => $subIssue->sub_issue_id, 'suggested_mechanic_id' => $otherMechanic->id],
            ],
        ])->assertOk();

        $ticket->refresh();
        // Titles are server-composed and not editable at approval (spec §7).
        $this->assertSame(sprintf('MT-%04d — %s — Worn belt', $ticket->ticket_id, $vehicle->vehicle_name), $ticket->ticket_title);
        $this->assertSame('Medium', $ticket->priority);

        $fresh = $ticket->subIssues->first()->fresh();
        // Every sub-issue is dispatched to the ticket-level assigned
        // mechanic chosen at approval...
        $this->assertSame($assignedMechanic->id, $fresh->assigned_mechanic_id);
        // ...independently of the per-sub-issue field edits approveTicket()
        // still applies (a metadata patch only, no dispatch effect of its own).
        $this->assertSame($otherMechanic->id, $fresh->suggested_mechanic_id);
    }


    #[Test]
    public function a_proposal_gets_a_server_built_mt_number_title_that_a_typed_title_cannot_override(): void
    {
        $vehicle = $this->vehicle();
        // A client-supplied title is ignored; the server builds
        // "MT-0001 — Vehicle — Issue" from the number, vehicle and issue.
        $ticket = $this->propose($vehicle, ['ticket_title' => 'Typed by a user', 'sub_issues' => [['title' => 'Worn belt', 'maintenance_type' => 'Belt Replacement']]]);

        $expected = sprintf('MT-%04d — %s — Belt Replacement', $ticket->ticket_id, $vehicle->vehicle_name);
        $this->assertSame($expected, $ticket->ticket_title);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [
            'ticket_title' => 'Admin override attempt',
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertOk();

        $this->assertSame($expected, $ticket->fresh()->ticket_title);
    }

    #[Test]
    public function custodian_and_maintenance_personnel_cannot_approve(): void
    {
        $ticket = $this->propose($this->vehicle());

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [])->assertForbidden();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [])->assertForbidden();
    }

    #[Test]
    public function admin_can_decline_a_proposal_and_it_stays_visible_as_declined(): void
    {
        $ticket = $this->propose($this->vehicle());
        $subIssueId = $ticket->subIssues->first()->sub_issue_id;

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/decline", [
            'decline_reason' => 'Not urgent enough — defer to next inspection.',
        ])->assertOk();

        $this->assertDatabaseHas('maintenance_tickets', [
            'ticket_id' => $ticket->ticket_id,
            'status' => 'Declined',
            'decline_reason' => 'Not urgent enough — defer to next inspection.',
        ]);
        $this->assertDatabaseHas('ticket_sub_issues', ['sub_issue_id' => $subIssueId]);

        $notification = \App\Models\Notification::where('user_id', $this->custodian->id)
            ->where('type', 'ticket_declined')
            ->firstOrFail();
        $this->assertStringContainsString('Not urgent enough', $notification->message);

        $log = \App\Models\ActivityLog::where('action', 'Decline Ticket')->firstOrFail();
        $this->assertStringContainsString('Not urgent enough', $log->details);
        $this->assertSame((string) $ticket->ticket_id, $log->affected_record_id);

        // The Custodian can still see their own declined proposal — it's
        // not gone, just declined.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->getJson("/api/tickets/{$ticket->ticket_id}")->assertOk()->assertJsonPath('status', 'Declined');
    }

    #[Test]
    public function admin_can_undecline_a_proposal_back_to_pending_approval(): void
    {
        $ticket = $this->propose($this->vehicle());

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/decline", ['decline_reason' => 'x'])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/undecline")->assertOk();

        $this->assertDatabaseHas('maintenance_tickets', [
            'ticket_id' => $ticket->ticket_id,
            'status' => 'Pending Approval',
            'decline_reason' => null,
        ]);

        // Can be declined again, approved, the whole cycle — it's a normal
        // Pending Approval proposal again.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertOk();
        $this->assertDatabaseHas('maintenance_tickets', ['ticket_id' => $ticket->ticket_id, 'status' => 'Active']);
    }

    #[Test]
    public function admin_can_approve_a_declined_proposal_directly_without_undeclining(): void
    {
        $ticket = $this->propose($this->vehicle());

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/decline", ['decline_reason' => 'Reconsidering.'])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertOk();

        $this->assertDatabaseHas('maintenance_tickets', [
            'ticket_id' => $ticket->ticket_id,
            'status' => 'Active',
            'decline_reason' => null,
            'assigned_mechanic_id' => $this->mechanic->id,
        ]);
    }

    #[Test]
    public function only_a_declined_ticket_can_be_undeclined(): void
    {
        $ticket = $this->propose($this->vehicle());

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/undecline")->assertStatus(422);
    }

    #[Test]
    public function custodian_and_maintenance_personnel_cannot_undecline(): void
    {
        $ticket = $this->propose($this->vehicle());
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/decline", ['decline_reason' => 'x'])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/undecline")->assertForbidden();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/undecline")->assertForbidden();
    }

    #[Test]
    public function a_declined_ticket_cannot_be_cancelled(): void
    {
        $ticket = $this->propose($this->vehicle());
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/decline", ['decline_reason' => 'x'])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/cancel")->assertStatus(422);
    }

    #[Test]
    public function declining_requires_a_reason(): void
    {
        $ticket = $this->propose($this->vehicle());

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/decline", [])->assertStatus(422);
        $this->assertDatabaseHas('maintenance_tickets', ['ticket_id' => $ticket->ticket_id]);
    }

    #[Test]
    public function custodian_and_maintenance_personnel_cannot_decline(): void
    {
        $ticket = $this->propose($this->vehicle());

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/decline", ['decline_reason' => 'x'])->assertForbidden();

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/decline", ['decline_reason' => 'x'])->assertForbidden();
    }

    #[Test]
    public function cannot_approve_or_decline_a_ticket_that_is_not_pending_approval(): void
    {
        $ticket = $this->propose($this->vehicle());
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertOk();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertStatus(422);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/decline", ['decline_reason' => 'x'])->assertStatus(422);
    }

    #[Test]
    public function the_proposing_custodian_can_see_their_own_pending_proposal(): void
    {
        $ticket = $this->propose($this->vehicle());

        Sanctum::actingAs($this->custodian, ['*']);
        $this->getJson("/api/tickets/{$ticket->ticket_id}")->assertOk();
        $ids = collect($this->getJson('/api/tickets')->assertOk()->json())->pluck('ticket_id');
        $this->assertTrue($ids->contains($ticket->ticket_id));
    }

    #[Test]
    public function needs_inspection_is_no_longer_a_proposal_mode(): void
    {
        // A Custodian only proposes when something is wrong, so a proposal
        // always states the repair — there is no "inspect it first" option.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $this->vehicle()->vehicle_id, 'ticket_title' => 'X', 'ticket_description' => 'x',
            'priority' => 'High', 'entry_mode' => 'inspection', 'sub_issues' => [['title' => 'Belt']],
        ])->assertStatus(422);
    }

    #[Test]
    public function a_proposal_without_sub_issues_is_rejected(): void
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $this->vehicle()->vehicle_id, 'ticket_title' => 'X', 'ticket_description' => 'x',
            'priority' => 'High', 'sub_issues' => [],
        ])->assertStatus(422);
    }

    #[Test]
    public function a_known_repair_mode_requires_sub_issues(): void
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $this->vehicle()->vehicle_id, 'ticket_title' => 'X', 'ticket_description' => 'x',
            'priority' => 'High', 'entry_mode' => 'in_house', 'sub_issues' => [],
        ])->assertStatus(422);
    }

    #[Test]
    public function a_cannibalized_proposal_requires_and_stores_the_donor_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $donor = $this->vehicle();

        Sanctum::actingAs($this->custodian, ['*']);
        $payload = [
            'vehicle_id' => $vehicle->vehicle_id, 'ticket_title' => 'X', 'ticket_description' => 'x',
            'priority' => 'High', 'entry_mode' => 'cannibalized', 'sub_issues' => [['title' => 'Alternator']],
        ];
        $this->postJson('/api/tickets/propose', $payload)->assertStatus(422);

        $ticket = $this->propose($vehicle, [
            'entry_mode' => 'cannibalized', 'source_vehicle_id' => $donor->vehicle_id,
            'sub_issues' => [['title' => 'Alternator', 'part_missing' => 'Alternator', 'part_needed' => 'Alternator']],
        ]);
        $sub = $ticket->subIssues()->first();
        $this->assertSame('cannibalized', $sub->repair_type);
        $this->assertSame($donor->vehicle_id, $sub->source_vehicle_id);
    }

    #[Test]
    public function an_external_proposal_stores_the_vendor_and_goes_active_on_approval(): void
    {
        $ticket = $this->propose($this->vehicle(), [
            'entry_mode' => 'external', 'external_vendor' => 'ACME Repair Shop', 'warranty_until' => '2027-01-01',
            'external_reason' => \App\Http\Controllers\TicketController::EXTERNAL_REASONS[0],
            'external_work_scope' => 'Replace the battery.',
            'sub_issues' => [['title' => 'Battery replacement']],
        ]);
        $sub = $ticket->subIssues()->first();
        $this->assertSame('external', $sub->repair_type);
        $this->assertSame('ACME Repair Shop', $sub->external_vendor);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/approve", [
            'assigned_mechanic_id' => $this->mechanic->id,
        ])->assertOk();
        $this->assertSame('Active', $ticket->fresh()->status);
    }
}
