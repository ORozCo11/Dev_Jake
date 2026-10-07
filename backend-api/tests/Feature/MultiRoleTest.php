<?php

namespace Tests\Feature;

use App\Models\MaintenanceTicket;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * MULTI-ROLE ACCOUNTS
 *
 * A role is a hat, not a headcount. One person in a small barangay can hold
 * several roles on a single account and act under each — the system enforces
 * separation by ROLE (not by person), so the workflow still completes with
 * one human, and every action records which function they performed.
 *
 * One exception: whoever logged a sub-issue's repair can never be the one
 * who verifies it, even under a different hat on the same account — "don't
 * grade your own homework" is enforced per PERSON, not per role. Only an
 * Admin can step in for that specific verification (see
 * TicketController::verifyRepair, VMS-IMPROVEMENT-PLAN.md Phase A2).
 */
class MultiRoleTest extends TestCase
{
    use RefreshDatabase;

    private function vehicle(): Vehicle
    {
        $category = VehicleCategory::create(['category_name' => 'Ambulance ' . uniqid(), 'description' => 'x']);

        return Vehicle::create([
            'vehicle_name' => 'Barangay Ambulance',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
            'capacity' => '12 pax', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
        ]);
    }

    #[Test]
    public function has_role_falls_back_to_primary_role_when_roles_list_is_empty(): void
    {
        $user = User::factory()->create(['role' => 'Admin', 'roles' => null]);

        $this->assertTrue($user->hasRole('Admin'));
        $this->assertFalse($user->hasRole('Custodian'));
    }

    #[Test]
    public function has_role_still_counts_the_primary_role_even_if_the_roles_list_omits_it(): void
    {
        // A split-brain row (e.g. a manual DB edit or migration artifact):
        // roles[] is populated but doesn't happen to list the primary role.
        // hasRole() must still agree with allRoles()/scopeHavingRole(), which
        // both always count the primary role regardless.
        $user = User::factory()->create(['role' => 'Admin', 'roles' => ['Custodian']]);

        $this->assertTrue($user->hasRole('Admin'));
        $this->assertTrue($user->hasRole('Custodian'));
        $this->assertContains('Admin', $user->allRoles());
    }

    #[Test]
    public function a_multi_hat_user_is_offered_as_both_a_custodian_and_a_mechanic(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $juan = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian', 'Maintenance Personnel']]);

        Sanctum::actingAs($admin, ['*']);
        $response = $this->getJson('/api/tickets/lookups')->assertOk();

        $custodianIds = collect($response->json('custodians'))->pluck('id');
        $mechanicIds  = collect($response->json('maintenance_personnel'))->pluck('id');

        $this->assertTrue($custodianIds->contains($juan->id), 'Juan should be assignable as a custodian.');
        $this->assertTrue($mechanicIds->contains($juan->id), 'Juan should also be assignable as a mechanic.');
    }

    /** Propose + approve — the only live way a ticket now reaches Active. */
    private function activeTicket(Vehicle $vehicle, User $custodian, User $mechanic): MaintenanceTicket
    {
        Sanctum::actingAs($custodian, ['*']);
        $ticketId = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_description' => 'Runs hot.',
            'priority' => 'High',
            'sub_issues' => [['title' => 'Low coolant level']],
        ])->assertCreated()->json('ticket_id');

        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/approve", [
            'assigned_mechanic_id' => $mechanic->id,
        ])->assertOk();

        return MaintenanceTicket::with('subIssues')->findOrFail($ticketId);
    }

    #[Test]
    public function one_person_holding_two_hats_can_run_the_whole_pipeline_except_verifying_their_own_repair(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        // Juan is the barangay's single utility staffer — Custodian AND Maintenance.
        $juan = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian', 'Maintenance Personnel']]);
        $vehicle = $this->vehicle();

        // Juan proposes (as Custodian) and an Admin approves, dispatching
        // Juan himself (now wearing his Maintenance hat) as the ticket's one
        // mechanic — exactly the setup that creates a self-verification
        // conflict (Juan is both the assigned mechanic AND the Custodian).
        $ticket = $this->activeTicket($vehicle, $juan, $juan);
        $subIssue = $ticket->subIssues->first();

        // Juan (as Maintenance) logs the repair.
        Sanctum::actingAs($juan, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Refilled coolant, tested.',
        ])->assertOk();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        // Juan (back in his Custodian hat) CANNOT attest to his own repair —
        // "don't grade your own homework" holds per person, not per role,
        // even though he's this ticket's assigned Custodian.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])
            ->assertForbidden()
            ->assertJsonFragment(['message' => 'You performed repair work on this ticket — it must be verified by a different Custodian. Reassign this ticket to another Custodian.']);

        // Admin is no longer a verification fallback (production-readiness
        // audit finding #2) — the actual fix is reassigning the ticket to a
        // different Custodian, who can then verify it normally.
        $standInCustodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/reassign-custodian", [
            'assigned_custodian_id' => $standInCustodian->id,
            'reassign_reason' => 'Juan cannot verify his own repair.',
        ])->assertOk();

        Sanctum::actingAs($standInCustodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertOk();

        $this->assertSame('Closed', $ticket->fresh()->status);
        $this->assertSame('Available', $vehicle->fresh()->status);
    }

    #[Test]
    public function the_activity_log_records_which_hat_a_dual_role_user_acted_under(): void
    {
        // Juan's PRIMARY role is Custodian, but he also holds Maintenance
        // Personnel. Logging a repair is a Maintenance-only action — the
        // audit trail should say so, not just repeat his primary role.
        $juan = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian', 'Maintenance Personnel']]);
        $vehicle = $this->vehicle();

        $ticket = $this->activeTicket($vehicle, $juan, $juan);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($juan, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Refilled coolant, tested.',
        ])->assertOk();

        $this->assertDatabaseHas('activity_logs', [
            'user_id' => $juan->id,
            'role' => 'Maintenance Personnel',
            'action' => 'Repairs Logged',
        ]);
    }

    #[Test]
    public function a_dual_role_mechanic_custodian_is_still_blocked_even_after_the_ticket_is_submitted_for_verification(): void
    {
        // Juan here holds Admin AND Maintenance Personnel. A different
        // Custodian verifies the repair, clearing the self-verification
        // guard — Admin never holds ticket.verify at all (Custodian-only),
        // so Juan's Admin hat gives him no path to sign off on his own work
        // either, mirroring the old two-tier "don't grade your own
        // homework" guarantee with the simplified single-attestation flow.
        $juan = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin', 'Maintenance Personnel']]);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $vehicle = $this->vehicle();

        $ticket = $this->activeTicket($vehicle, $custodian, $juan);
        $subIssue = $ticket->subIssues->first();

        Sanctum::actingAs($juan, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Refilled coolant, tested.',
        ])->assertOk();
        $this->putJson("/api/tickets/{$ticket->ticket_id}/submit-for-verification", [])->assertOk();

        // Juan (as Admin) cannot verify at all — ticket.verify is
        // Custodian-only, full stop.
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertForbidden();

        Sanctum::actingAs($custodian, ['*']);
        $this->putJson("/api/tickets/{$ticket->ticket_id}/verify", ['test_attested' => true])->assertOk();

        $this->assertSame('Closed', $ticket->fresh()->status);
    }

    #[Test]
    public function scope_having_role_agrees_with_has_role_for_every_role_storage_shape(): void
    {
        // scopeHavingRole() (SQL) and hasRole() (PHP) are two independent
        // implementations of "does this user hold role X" (see the comment
        // on scopeHavingRole()) — this is the guard that would catch them
        // silently disagreeing, across every shape role data can take.
        $primaryOnly = User::factory()->create(['role' => 'Custodian', 'roles' => null]);
        $rolesListOnly = User::factory()->create(['role' => 'Admin', 'roles' => ['Custodian']]);
        $both = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian', 'Maintenance Personnel']]);
        $neither = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);

        foreach ([$primaryOnly, $rolesListOnly, $both, $neither] as $user) {
            $matchedBySql = User::havingRole('Custodian')->whereKey($user->id)->exists();
            $this->assertSame(
                $user->hasRole('Custodian'),
                $matchedBySql,
                "scopeHavingRole()/hasRole() disagree for user #{$user->id} (role={$user->role}, roles=" . json_encode($user->roles) . ')'
            );
        }
    }
}
