<?php

namespace Tests\Feature;

use App\Models\MaintenanceTicket;
use App\Models\Notification;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * The mechanic -> Custodian handoff and the Custodian's verification
 * outcomes:
 *
 *  - Logging the LAST outstanding repair moves the ticket to For
 *    Verification on its own and notifies the assigned Custodian once —
 *    previously the Custodian was told "please verify" on every individual
 *    log while the ticket was still Active (and so not yet verifiable),
 *    and the ticket only advanced if the mechanic also found a separate
 *    "Submit for Verification" button.
 *  - Verification is a functional test: approving needs the attestation and
 *    a checklist with no failed check; a failed test returns the ticket to
 *    the repair stage (Active / Under Repair) with the result recorded and
 *    the mechanic notified.
 *  - Every existing verifier guard still applies to both outcomes.
 */
class CustodianVerificationHandoffTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private User $mechanic;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin']);
        $this->custodian = User::factory()->create(['role' => 'Custodian']);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel']);
    }

    private function activeTicket(array $titles, ?User $mechanic = null, ?User $custodian = null): MaintenanceTicket
    {
        $category = VehicleCategory::create(['category_name' => 'Fire Truck ' . uniqid(), 'description' => 'test']);
        $vehicle = Vehicle::create([
            'vehicle_name' => 'Autumn Response Pumper',
            'plate_number' => 'FDT ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Sutphen',
            'model' => 'Monarch',
            'year_model' => 2020,
            'capacity' => '1000 kg',
            'vehicle_color' => 'Red',
            'current_location' => 'Main Depot',
        ]);

        Sanctum::actingAs($custodian ?? $this->custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Body panel damage.',
            'priority' => 'High',
            'sub_issues' => array_map(fn ($t) => ['title' => $t], $titles),
        ])->assertCreated()->json('ticket_id');

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/approve", [
            'assigned_mechanic_id' => ($mechanic ?? $this->mechanic)->id,
        ])->assertOk();

        return MaintenanceTicket::with('subIssues')->findOrFail($ticketId);
    }

    private function logRepair(MaintenanceTicket $ticket, int $subIssueId, ?User $mechanic = null): void
    {
        Sanctum::actingAs($mechanic ?? $this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssueId}/log-repairs", [
            'repair_logs' => 'Repaired.',
        ])->assertOk();
    }

    private function readyNotifications(User $user, MaintenanceTicket $ticket)
    {
        return Notification::where('user_id', $user->id)
            ->where('type', 'repairs_completed')
            ->where('ticket_id', $ticket->ticket_id)
            ->get();
    }

    private function passingChecklist(): array
    {
        return [
            ['item' => 'Engine / power system starts normally', 'passed' => true],
            ['item' => 'The reported problem no longer occurs', 'passed' => true],
        ];
    }

    #[Test]
    public function logging_the_last_repair_sends_the_ticket_to_its_custodian_exactly_once(): void
    {
        $ticket = $this->activeTicket(['Dented door', 'Cracked mirror']);
        [$first, $second] = $ticket->subIssues->pluck('sub_issue_id')->all();

        // One of two logged: still Active, and the Custodian is NOT told to
        // verify something they can't verify yet.
        $this->logRepair($ticket, $first);
        $this->assertSame('Active', $ticket->fresh()->status);
        $this->assertCount(0, $this->readyNotifications($this->custodian, $ticket));

        // The last one: For Verification, one notification linked to the ticket.
        $this->logRepair($ticket, $second);
        $this->assertSame('For Verification', $ticket->fresh()->status);
        $notes = $this->readyNotifications($this->custodian, $ticket);
        $this->assertCount(1, $notes);
        $this->assertSame('Repair Ready for Verification', $notes->first()->title);

        // The old manual button is now a harmless no-op — no duplicate notice.
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();
        $this->assertSame('For Verification', $ticket->fresh()->status);
        $this->assertCount(1, $this->readyNotifications($this->custodian, $ticket));
    }

    #[Test]
    public function the_custodian_badge_counts_the_ticket_once_it_is_ready(): void
    {
        $ticket = $this->activeTicket(['Dented door']);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->assertSame(0, $this->getJson('/api/dashboard')->json('badge_counts.ticketVerifications'));

        $this->logRepair($ticket, $ticket->subIssues->first()->sub_issue_id);

        Sanctum::actingAs($this->custodian, ['*']);
        $this->assertSame(1, $this->getJson('/api/dashboard')->json('badge_counts.ticketVerifications'));
    }

    #[Test]
    public function approving_requires_the_attestation_and_a_fully_passing_checklist(): void
    {
        $ticket = $this->activeTicket(['Dented door']);
        $this->logRepair($ticket, $ticket->subIssues->first()->sub_issue_id);

        Sanctum::actingAs($this->custodian, ['*']);
        $failing = [['item' => 'Brakes respond properly', 'passed' => false]];

        // A failed check can never be approved, even if the client says so.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", [
            'verification_verdict' => 'Approved', 'functional_test' => $failing, 'test_attested' => true,
        ])->assertUnprocessable();
        // Approving without the attestation is refused.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", [
            'verification_verdict' => 'Approved', 'functional_test' => $this->passingChecklist(),
        ])->assertUnprocessable();
        $this->assertSame('For Verification', $ticket->fresh()->status);

        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", [
            'verification_verdict' => 'Approved', 'functional_test' => $this->passingChecklist(), 'test_attested' => true,
        ])->assertOk();

        $fresh = $ticket->fresh(['subIssues']);
        $this->assertSame('Closed', $fresh->status);
        $this->assertSame('Approved', $fresh->subIssues->first()->verification_verdict);
        $this->assertCount(2, $fresh->subIssues->first()->functional_test);
        $this->assertTrue($fresh->subIssues->first()->test_attested);
    }

    #[Test]
    public function a_failed_test_returns_the_ticket_to_repair_and_records_the_result(): void
    {
        $ticket = $this->activeTicket(['Dented door']);
        $subIssueId = $ticket->subIssues->first()->sub_issue_id;
        $this->logRepair($ticket, $subIssueId);

        Sanctum::actingAs($this->custodian, ['*']);
        // Returning needs a reason: a failed check or a note.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", [
            'verification_verdict' => 'Rejected', 'functional_test' => $this->passingChecklist(),
        ])->assertUnprocessable();

        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", [
            'verification_verdict' => 'Rejected',
            'functional_test' => [['item' => 'The reported problem no longer occurs', 'passed' => false]],
            'verification_notes' => 'Door still will not latch.',
        ])->assertOk();

        $fresh = $ticket->fresh(['subIssues']);
        $sub = $fresh->subIssues->first();
        $this->assertSame('Active', $fresh->status);
        $this->assertSame('Under Repair', $sub->status);
        $this->assertSame('Rejected', $sub->verification_verdict);
        $this->assertSame('Door still will not latch.', $sub->verification_notes);
        $this->assertSame($this->custodian->id, $sub->verified_by);
        $this->assertFalse($sub->functional_test[0]['passed']);

        $this->assertTrue(Notification::where('user_id', $this->mechanic->id)
            ->where('type', 'repairs_rejected')->where('ticket_id', $ticket->ticket_id)->exists());

        // The mechanic re-logs and it comes straight back to the same Custodian.
        $this->logRepair($ticket, $subIssueId);
        $this->assertSame('For Verification', $ticket->fresh()->status);
        $this->assertCount(2, $this->readyNotifications($this->custodian, $ticket));
    }

    #[Test]
    public function only_the_assigned_custodian_can_verify_or_return_and_admin_is_never_a_fallback(): void
    {
        $ticket = $this->activeTicket(['Dented door']);
        $this->logRepair($ticket, $ticket->subIssues->first()->sub_issue_id);
        $otherCustodian = User::factory()->create(['role' => 'Custodian']);
        $reject = ['verification_verdict' => 'Rejected', 'verification_notes' => 'Not fixed.'];
        $approve = ['functional_test' => $this->passingChecklist(), 'test_attested' => true];

        foreach ([$otherCustodian, $this->admin, $this->mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", $approve)->assertForbidden();
            $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", $reject)->assertForbidden();
        }
        $this->assertSame('For Verification', $ticket->fresh()->status);

        // Reassigning the Custodian carries the verification with it.
        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $otherCustodian->id,
            'reassign_reason' => 'Original Custodian on leave.',
        ])->assertOk();

        Sanctum::actingAs($this->custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", $approve)->assertForbidden();

        Sanctum::actingAs($otherCustodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", $approve)->assertOk();
        $this->assertSame('Closed', $ticket->fresh()->status);
    }

    #[Test]
    public function a_dual_role_account_can_neither_approve_nor_return_its_own_repair(): void
    {
        $both = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian', 'Maintenance Personnel']]);
        $ticket = $this->activeTicket(['Dented door'], $both, $both);
        $this->logRepair($ticket, $ticket->subIssues->first()->sub_issue_id, $both);
        $this->assertSame('For Verification', $ticket->fresh()->status);

        Sanctum::actingAs($both, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", [
            'functional_test' => $this->passingChecklist(), 'test_attested' => true,
        ])->assertForbidden();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", [
            'verification_verdict' => 'Rejected', 'verification_notes' => 'x',
        ])->assertForbidden();
        $this->assertSame('For Verification', $ticket->fresh()->status);
    }
}
