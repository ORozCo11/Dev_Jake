<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * DEV-ONLY impersonation — the dangerous part is making sure it CANNOT work
 * in production. These tests pin both the happy path and the hard gate.
 *
 * VMS-IMPROVEMENT-PLAN.md Phase A5 restrictions are also covered here: a
 * written reason, a 30-minute expiry, read-only enforcement, and a
 * start/end trail on both the target barangay's Activity Log and the
 * Super Admin's own account log.
 */
class ImpersonationTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function a_developer_can_impersonate_another_account_in_the_test_environment(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        Sanctum::actingAs($admin, ['*']);
        $response = $this->postJson("/api/impersonate/{$custodian->id}", ['reason' => 'Testing the workflow'])->assertOk();

        $this->assertNotEmpty($response->json('access_token'));
        $this->assertSame($custodian->id, $response->json('user.id'));
        $this->assertSame('Custodian', $response->json('user.role'));
    }

    #[Test]
    public function impersonation_does_not_exist_in_production(): void
    {
        // The whole safety of the feature rests on this: outside local/testing
        // the endpoint 404s, so a deployed app has no impersonation surface.
        $this->app['env'] = 'production';

        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $target = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        Sanctum::actingAs($admin, ['*']);
        $this->postJson("/api/impersonate/{$target->id}", ['reason' => 'test'])->assertNotFound();
        $this->getJson('/api/impersonate/candidates')->assertNotFound();
    }

    #[Test]
    public function a_deactivated_account_cannot_be_impersonated(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $inactive = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'is_active' => false]);

        Sanctum::actingAs($admin, ['*']);
        $this->postJson("/api/impersonate/{$inactive->id}", ['reason' => 'test'])->assertStatus(422);
    }

    #[Test]
    public function impersonation_requires_authentication(): void
    {
        $target = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        $this->postJson("/api/impersonate/{$target->id}", ['reason' => 'test'])->assertUnauthorized();
    }

    #[Test]
    public function a_super_admin_cannot_impersonate_another_super_admin_via_a_direct_api_call(): void
    {
        // The frontend's candidate list filters role !== 'Super Admin' out of
        // what it shows, but that's a UI-only guard — this pins the
        // server-side check that a direct API call can't bypass it.
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
        $otherSuperAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);

        Sanctum::actingAs($superAdmin, ['*']);
        $this->postJson("/api/impersonate/{$otherSuperAdmin->id}", ['reason' => 'test'])->assertStatus(403);
    }

    // =======================================================================
    // Phase A5 — reason, expiry, read-only, and the activity trail
    // =======================================================================

    #[Test]
    public function impersonating_without_a_reason_is_rejected(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        Sanctum::actingAs($admin, ['*']);
        $this->postJson("/api/impersonate/{$custodian->id}", [])
            ->assertStatus(422)
            ->assertJsonValidationErrors('reason');
    }

    #[Test]
    public function the_impersonation_token_expires_in_thirty_minutes(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        Sanctum::actingAs($admin, ['*']);
        $this->postJson("/api/impersonate/{$custodian->id}", ['reason' => 'Support ticket #42'])->assertOk();

        $token = \Laravel\Sanctum\PersonalAccessToken::where('name', 'impersonation_token')->latest('id')->first();
        $this->assertNotNull($token);
        $this->assertTrue($token->expires_at->between(now()->addMinutes(29), now()->addMinutes(31)));
    }

    /**
     * A real impersonation token for $user, built the exact same way
     * AuthController::impersonate() itself builds one — used instead of
     * actually calling POST /impersonate as a separate admin identity
     * first. Laravel's test HTTP client caches the resolved guard user for
     * the rest of the test process once ANY request has authenticated
     * (Sanctum::actingAs() OR a real bearer token) — a second, different
     * real identity's token in the same test does not reliably re-resolve
     * on subsequent calls (see AccountDeactivationTest's docblock for the
     * same caveat). Building the token directly keeps each of these tests
     * to exactly one authenticated identity throughout.
     */
    private function impersonationToken(User $user): string
    {
        return $user->createToken('impersonation_token', [...$user->allRoles(), 'impersonated'], now()->addMinutes(30))->plainTextToken;
    }

    #[Test]
    public function an_impersonated_session_cannot_write_but_can_still_read(): void
    {
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $token = $this->impersonationToken($custodian);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->getJson('/api/user')
            ->assertOk()
            ->assertJsonPath('id', $custodian->id);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->postJson('/api/issues', ['vehicle_id' => 999, 'issue_type' => 'x', 'issue_description' => 'x', 'severity_level' => 'Low'])
            ->assertStatus(403);
    }

    #[Test]
    public function an_impersonated_session_can_still_log_out_and_switch_to_a_different_account(): void
    {
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $mechanic = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel']]);
        $token = $this->impersonationToken($custodian);

        // Switching to a different impersonated account is itself a write
        // (POST) but must not be blocked — see impersonate/* in the
        // middleware's allowlist.
        $this->withHeader('Authorization', "Bearer {$token}")
            ->postJson("/api/impersonate/{$mechanic->id}", ['reason' => 'Same ticket, different account'])
            ->assertOk();

        $this->withHeader('Authorization', "Bearer {$token}")
            ->postJson('/api/logout')
            ->assertOk();
    }

    #[Test]
    public function impersonating_logs_a_start_entry_visible_in_the_targets_own_barangay_and_to_super_admins(): void
    {
        $province = \App\Models\Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = \App\Models\City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $barangayId = \App\Models\Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id])->id;

        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin'], 'barangay_id' => null]);
        $targetAdmin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $barangayId]);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $barangayId]);

        Sanctum::actingAs($superAdmin, ['*']);
        $this->postJson("/api/impersonate/{$custodian->id}", ['reason' => 'Support ticket #42'])->assertOk();

        $this->assertDatabaseHas('activity_logs', [
            'action' => 'Impersonate',
            'barangay_id' => $barangayId,
            'module' => 'Super Admin',
        ]);

        // Visible to the TARGET barangay's own Admin via FleetController::logs()
        // (scoped to their barangay_id by BelongsToBarangay's global scope).
        Sanctum::actingAs($targetAdmin, ['*']);
        $barangayLogs = collect($this->getJson('/api/logs')->assertOk()->json());
        $this->assertTrue($barangayLogs->contains(fn ($l) => $l['action'] === 'Impersonate'));

        // Also visible to the Super Admin's own account-level log.
        Sanctum::actingAs($superAdmin, ['*']);
        $superAdminLogs = collect($this->getJson('/api/superadmin/activity-log')->assertOk()->json());
        $this->assertTrue($superAdminLogs->contains(fn ($l) => $l['action'] === 'Impersonate'));
    }

    #[Test]
    public function returning_to_self_via_logout_logs_an_end_entry(): void
    {
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $token = $this->impersonationToken($custodian);

        $this->withHeader('Authorization', "Bearer {$token}")->postJson('/api/logout')->assertOk();

        $this->assertDatabaseHas('activity_logs', [
            'action' => 'Impersonation Ended',
            'user_id' => $custodian->id,
        ]);
    }

    #[Test]
    public function an_ordinary_logout_does_not_log_an_impersonation_end_entry(): void
    {
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        // Deliberately NOT Sanctum::actingAs($custodian, ['*']) — this
        // suite's usual convention for "any authenticated user", but the
        // wildcard '*' ability it grants would itself satisfy
        // can('impersonated') and defeat the point of this test. A real
        // login token only ever carries the user's own role names (see
        // AuthController::login()), never '*'.
        Sanctum::actingAs($custodian, $custodian->allRoles());
        $this->postJson('/api/logout')->assertOk();

        $this->assertDatabaseMissing('activity_logs', ['action' => 'Impersonation Ended']);
    }
}
