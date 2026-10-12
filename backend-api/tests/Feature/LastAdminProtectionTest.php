<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase A4 — a barangay with zero active Admins is
 * orphaned: nobody left who can manage its users, vehicles, or approvals.
 * GuardsLastAdmin (shared by UserController and SuperAdminController) is
 * what stops that from ever being CREATED, as opposed to only being
 * recoverable afterward via SuperAdminController's barangay-recovery flow.
 */
class LastAdminProtectionTest extends TestCase
{
    use RefreshDatabase;

    private int $barangayId;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangayId = Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id])->id;
    }

    private function admin(array $overrides = []): User
    {
        return User::factory()->create(array_merge([
            'role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $this->barangayId, 'is_active' => true,
        ], $overrides));
    }

    // =======================================================================
    // UserController — an Admin acting on their own barangay.
    //
    // requireAdmin() + requireSameBarangay() together guarantee the ACTOR is
    // always an active Admin in the SAME barangay as the target, and the
    // pre-existing self-lockout checks (above the Phase A4 additions) block
    // an Admin only from locking out their OWN account. Put together, this
    // means: whenever the acting Admin manages a DIFFERENT user, the acting
    // Admin themself always remains as "another active Admin" afterward —
    // so GuardsLastAdmin can never actually fire through this controller.
    // It's kept here anyway as defense-in-depth (see its docblock) in case
    // those surrounding guarantees ever change; these tests pin that it
    // never produces a false-positive block on an ordinary fellow-admin
    // action today.
    // =======================================================================

    #[Test]
    public function an_admin_can_deactivate_the_barangays_only_other_admin_because_the_acting_admin_remains(): void
    {
        $actingAdmin = $this->admin();
        $targetAdmin = $this->admin();

        Sanctum::actingAs($actingAdmin, ['*']);
        $this->putJson("/api/users/{$targetAdmin->id}/deactivate", [])->assertOk();

        $this->assertFalse($targetAdmin->fresh()->is_active);
        $this->assertTrue($actingAdmin->fresh()->is_active, 'The acting Admin is exactly why this barangay is not left with zero.');
    }

    #[Test]
    public function an_admin_can_demote_the_barangays_only_other_admin_because_the_acting_admin_remains(): void
    {
        $actingAdmin = $this->admin();
        $targetAdmin = $this->admin();

        Sanctum::actingAs($actingAdmin, ['*']);
        $this->putJson("/api/users/{$targetAdmin->id}", ['roles' => ['Custodian']])->assertOk();

        $this->assertFalse($targetAdmin->fresh()->hasRole('Admin'));
    }

    #[Test]
    public function demoting_a_non_admin_is_never_blocked_by_this_guard(): void
    {
        $actingAdmin = $this->admin();
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $this->barangayId]);

        Sanctum::actingAs($actingAdmin, ['*']);
        $this->putJson("/api/users/{$custodian->id}", ['roles' => ['Maintenance Personnel']])->assertOk();
    }

    // =======================================================================
    // SuperAdminController — acting across every barangay
    // =======================================================================

    #[Test]
    public function a_super_admin_cannot_deactivate_a_barangays_only_active_admin(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
        $soleAdmin = $this->admin();

        Sanctum::actingAs($superAdmin, ['*']);
        $this->putJson("/api/superadmin/users/{$soleAdmin->id}/deactivate", [])->assertStatus(422);

        $this->assertTrue($soleAdmin->fresh()->is_active);
    }

    #[Test]
    public function an_inactive_admin_on_record_does_not_count_toward_the_other_admin_requirement(): void
    {
        $soleActiveAdmin = $this->admin();
        $this->admin(['is_active' => false]); // an already-deactivated Admin — doesn't help
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);

        Sanctum::actingAs($superAdmin, ['*']);
        $this->putJson("/api/superadmin/users/{$soleActiveAdmin->id}/deactivate", [])->assertStatus(422);

        $this->assertTrue($soleActiveAdmin->fresh()->is_active);
    }

    #[Test]
    public function a_super_admin_can_deactivate_an_admin_when_another_admin_remains_in_that_barangay(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
        $targetAdmin = $this->admin();
        $this->admin();

        Sanctum::actingAs($superAdmin, ['*']);
        $this->putJson("/api/superadmin/users/{$targetAdmin->id}/deactivate", [])->assertOk();

        $this->assertFalse($targetAdmin->fresh()->is_active);
    }

    #[Test]
    public function a_super_admin_cannot_change_a_barangays_only_active_admin_to_a_different_role(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
        $soleAdmin = $this->admin();

        Sanctum::actingAs($superAdmin, ['*']);
        $this->putJson("/api/superadmin/users/{$soleAdmin->id}/role", ['role' => 'Custodian'])->assertStatus(422);

        $this->assertSame('Admin', $soleAdmin->fresh()->role);
    }

    #[Test]
    public function a_super_admin_can_change_an_admins_role_when_another_admin_remains(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
        $targetAdmin = $this->admin();
        $this->admin();

        Sanctum::actingAs($superAdmin, ['*']);
        $this->putJson("/api/superadmin/users/{$targetAdmin->id}/role", ['role' => 'Custodian'])->assertOk();

        $this->assertSame('Custodian', $targetAdmin->fresh()->role);
    }

    #[Test]
    public function a_super_admin_promoting_someone_to_admin_is_never_blocked_by_this_guard(): void
    {
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $this->barangayId]);

        Sanctum::actingAs($superAdmin, ['*']);
        $this->putJson("/api/superadmin/users/{$custodian->id}/role", ['role' => 'Admin'])->assertOk();
    }

    // =======================================================================
    // Phase A4 — the warning surfaced on the Admin dashboard and in the
    // Super Admin's barangay list, ahead of the condition GuardsLastAdmin
    // blocks from being created.
    // =======================================================================

    #[Test]
    public function the_dashboard_flags_a_sole_active_admin(): void
    {
        $soleAdmin = $this->admin();

        Sanctum::actingAs($soleAdmin, ['*']);
        $this->getJson('/api/dashboard')->assertOk()->assertJsonPath('sole_active_admin', true);
    }

    #[Test]
    public function the_dashboard_does_not_flag_an_admin_with_a_fellow_admin(): void
    {
        $admin = $this->admin();
        $this->admin();

        Sanctum::actingAs($admin, ['*']);
        $this->getJson('/api/dashboard')->assertOk()->assertJsonPath('sole_active_admin', false);
    }

    #[Test]
    public function the_dashboard_never_flags_a_non_admin(): void
    {
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $this->barangayId]);

        Sanctum::actingAs($custodian, ['*']);
        $this->getJson('/api/dashboard')->assertOk()->assertJsonPath('sole_active_admin', false);
    }

    #[Test]
    public function the_super_admin_barangay_list_flags_a_barangay_with_exactly_one_active_admin(): void
    {
        $this->admin();
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);

        Sanctum::actingAs($superAdmin, ['*']);
        $response = $this->getJson('/api/superadmin/barangays')->assertOk();
        $row = collect($response->json())->firstWhere('id', $this->barangayId);

        $this->assertTrue($row['has_active_admin']);
        $this->assertTrue($row['sole_active_admin']);
    }

    #[Test]
    public function the_super_admin_barangay_list_does_not_flag_a_barangay_with_two_active_admins(): void
    {
        $this->admin();
        $this->admin();
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);

        Sanctum::actingAs($superAdmin, ['*']);
        $response = $this->getJson('/api/superadmin/barangays')->assertOk();
        $row = collect($response->json())->firstWhere('id', $this->barangayId);

        $this->assertTrue($row['has_active_admin']);
        $this->assertFalse($row['sole_active_admin']);
    }
}
