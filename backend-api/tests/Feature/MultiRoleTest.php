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

    #[Test]
    public function one_person_holding_two_hats_can_run_the_whole_pipeline_except_verifying_their_own_repair(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        // Juan is the barangay's single utility staffer — Custodian AND Maintenance.
        $juan = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian', 'Maintenance Personnel']]);
        $vehicle = $this->vehicle();

        // A ticket assigning Juan (as Custodian) to inspect — built directly
        // rather than through the (now permission-less) create-ticket
        // endpoint, since this test isn't about who may create a ticket.
        $ticketId = MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $admin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'Runs hot.',
            'priority' => 'High',
            'status' => 'Open',
            'assigned_custodian_id' => $juan->id,
            'assigned_at' => now(),
        ])->ticket_id;

        // Juan (as Custodian) inspects and logs a sub-issue.
        Sanctum::actingAs($juan, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/inspect", [
            'inspection_result' => 'Needs Maintenance',
            'inspection_notes' => 'Confirmed.',
            'sub_issues' => [['title' => 'Low coolant level']],
        ])->assertOk();

        $subIssue = MaintenanceTicket::find($ticketId)->subIssues->first();

        // Admin assigns the repair to Juan (now wearing his Maintenance hat).
        // This is exactly the setup that creates a self-verification conflict
        // (Juan is both this sub-issue's mechanic AND the ticket's
        // Custodian/verifier), so the response carries a warning about it.
        Sanctum::actingAs($admin, ['*']);
        $assignResponse = $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $juan->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();
        $assignResponse->assertJsonPath('warning', "{$juan->name} is also this ticket's Custodian — they won't be able to verify their own repair. Reassign the ticket to a different Custodian before it reaches verification.");

        // Juan (as Maintenance) logs the repair.
        Sanctum::actingAs($juan, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Refilled coolant, tested.',
        ])->assertOk();

        // Juan (back in his Custodian hat) CANNOT run the functional test on
        // his own repair — "don't grade your own homework" holds per person,
        // not per role, even though he's the sub-issue's assigned verifier.
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested' => true,
            'functional_test' => [['item' => 'Reported issue no longer occurs', 'passed' => true]],
        ])->assertForbidden()
            ->assertJsonFragment(['message' => 'You performed repair work on this sub-issue — it must be verified by a different Custodian. Reassign this ticket to another Custodian.']);

        // Admin is no longer a verification fallback (production-readiness
        // audit finding #2) — the actual fix is reassigning the ticket to a
        // different Custodian, who can then verify it normally.
        $standInCustodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/reassign-custodian", [
            'assigned_custodian_id' => $standInCustodian->id,
            'reassign_reason' => 'Juan cannot verify his own repair.',
        ])->assertOk();

        Sanctum::actingAs($standInCustodian, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested' => true,
            'functional_test' => [['item' => 'Reported issue no longer occurs', 'passed' => true]],
        ])->assertOk();

        // Admin gives the final verdict and closes.
        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/confirm", [
            'confirmation_verdict' => 'Confirmed',
        ])->assertOk();
        $this->putJson("/api/tickets/{$ticketId}/close", [])->assertOk();

        $this->assertSame('Closed', MaintenanceTicket::find($ticketId)->status);
        $this->assertSame('Available', $vehicle->fresh()->status);
    }

    #[Test]
    public function the_activity_log_records_which_hat_a_dual_role_user_acted_under(): void
    {
        // Juan's PRIMARY role is Custodian, but he also holds Maintenance
        // Personnel. Logging a repair is a Maintenance-only action — the
        // audit trail should say so, not just repeat his primary role.
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $juan = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian', 'Maintenance Personnel']]);
        $vehicle = $this->vehicle();

        $ticketId = MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $admin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'Runs hot.',
            'priority' => 'High',
            'status' => 'Open',
            'assigned_custodian_id' => $juan->id,
            'assigned_at' => now(),
        ])->ticket_id;

        Sanctum::actingAs($juan, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/inspect", [
            'inspection_result' => 'Needs Maintenance',
            'inspection_notes' => 'Confirmed.',
            'sub_issues' => [['title' => 'Low coolant level']],
        ])->assertOk();
        $subIssue = MaintenanceTicket::find($ticketId)->subIssues->first();

        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $juan->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        Sanctum::actingAs($juan, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Refilled coolant, tested.',
        ])->assertOk();

        $this->assertDatabaseHas('activity_logs', [
            'user_id' => $juan->id,
            'role' => 'Maintenance Personnel',
            'action' => 'Repairs Logged',
        ]);
    }

    #[Test]
    public function an_admin_who_also_performed_the_repair_cannot_give_its_final_confirmation_either(): void
    {
        // Juan here holds Admin AND Maintenance Personnel — a different
        // Custodian (not Juan) verifies the repair, clearing Tier 1, but
        // Juan (acting as Admin) still cannot be the one to confirm it:
        // "don't grade your own homework" applies at both confirmation
        // tiers, not just the first.
        $otherAdmin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $juan = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin', 'Maintenance Personnel']]);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $vehicle = $this->vehicle();

        $ticketId = MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $otherAdmin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'Runs hot.',
            'priority' => 'High',
            'status' => 'Open',
            'assigned_custodian_id' => $custodian->id,
            'assigned_at' => now(),
        ])->ticket_id;

        Sanctum::actingAs($custodian, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/inspect", [
            'inspection_result' => 'Needs Maintenance',
            'inspection_notes' => 'Confirmed.',
            'sub_issues' => [['title' => 'Low coolant level']],
        ])->assertOk();
        $subIssue = MaintenanceTicket::find($ticketId)->subIssues->first();

        Sanctum::actingAs($otherAdmin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/assign-mechanic", [
            'assigned_mechanic_id' => $juan->id,
            'maintenance_type' => 'Engine Repair',
        ])->assertOk();

        Sanctum::actingAs($juan, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/log-repairs", [
            'repair_logs' => 'Refilled coolant, tested.',
        ])->assertOk();

        Sanctum::actingAs($custodian, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved',
            'test_attested' => true,
            'functional_test' => [['item' => 'Reported issue no longer occurs', 'passed' => true]],
        ])->assertOk();

        Sanctum::actingAs($juan, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/confirm", [
            'confirmation_verdict' => 'Confirmed',
        ])->assertForbidden()
            ->assertJsonFragment(['message' => 'You performed repair work on this sub-issue — another Admin needs to give the final confirmation.']);

        Sanctum::actingAs($otherAdmin, ['*']);
        $this->putJson("/api/tickets/{$ticketId}/sub-issues/{$subIssue->sub_issue_id}/confirm", [
            'confirmation_verdict' => 'Confirmed',
        ])->assertOk();
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
