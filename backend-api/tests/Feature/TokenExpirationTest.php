<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Sanctum tokens previously never expired (config/sanctum.php did not exist,
 * so the package default of `'expiration' => null` applied, and neither
 * AuthController::login() nor ::impersonate() passed an explicit expiresAt).
 * A leaked token — login or impersonation — stayed valid forever unless
 * someone manually deleted its row from personal_access_tokens.
 *
 * Fix: config/sanctum.php now sets a global 'expiration' (minutes since
 * issue, enforced automatically by Laravel\Sanctum\Guard — see
 * vendor/laravel/sanctum/src/Guard.php), and impersonate() additionally
 * passes a short explicit expiresAt so an impersonation session — meant to
 * be a brief, deliberate admin action — can't outlive a normal login token.
 */
class TokenExpirationTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function a_token_that_has_already_expired_is_rejected(): void
    {
        $user = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        // Bypass the global config expiration entirely by giving this token
        // its own explicit expires_at in the past — Guard::supportsTokens()
        // rejects on `expires_at->isPast()` independently of the config
        // value (see Guard.php line ~129), so this proves expiry is
        // enforced per-token, not just via the global setting.
        $plainTextToken = $user->createToken('expired-token', ['*'], now()->subMinute())->plainTextToken;

        $this->withHeader('Authorization', "Bearer {$plainTextToken}")
            ->getJson('/api/user')
            ->assertUnauthorized();
    }

    #[Test]
    public function a_freshly_issued_login_token_is_not_immediately_expired(): void
    {
        $user = User::factory()->create([
            'role' => 'Custodian',
            'roles' => ['Custodian'],
            'password' => bcrypt('secret123'),
        ]);

        $response = $this->postJson('/api/login', [
            'email' => $user->email,
            'password' => 'secret123',
        ])->assertOk();

        $plainTextToken = $response->json('access_token');

        $this->withHeader('Authorization', "Bearer {$plainTextToken}")
            ->getJson('/api/user')
            ->assertOk();
    }

    #[Test]
    public function login_tokens_now_carry_a_real_expiration_via_global_config(): void
    {
        // login() itself passes no explicit expiresAt — this pins that the
        // global config/sanctum.php 'expiration' setting (10080 minutes / 7
        // days) is what now bounds an otherwise-unbounded login token,
        // rather than relying on login() to compute one itself.
        $this->assertSame(10080, (int) config('sanctum.expiration'));
        $this->assertNotNull(config('sanctum.expiration'));
    }

    #[Test]
    public function an_impersonation_token_expires_sooner_than_a_regular_login_token(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $target = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        $loginToken = $admin->createToken('auth_token', $admin->allRoles());

        \Laravel\Sanctum\Sanctum::actingAs($admin, ['*']);
        $impersonateResponse = $this->postJson("/api/impersonate/{$target->id}", ['reason' => 'Testing token expiry'])->assertOk();

        $impersonationTokenId = (int) explode('|', $impersonateResponse->json('access_token'))[0];
        $impersonationToken = \Laravel\Sanctum\PersonalAccessToken::find($impersonationTokenId);

        // VMS-IMPROVEMENT-PLAN.md Phase A5 — 30 minutes, not the 4 hours
        // this used to be.
        $this->assertNotNull($impersonationToken->expires_at, 'Impersonation tokens must carry an explicit expiry.');
        $this->assertTrue(
            $impersonationToken->expires_at->lte(now()->addMinutes(31)),
            'Impersonation tokens should expire within about 30 minutes.'
        );

        // The regular login-style token created above has no explicit
        // per-token expiry (relies on the global config instead), so it
        // outlives the impersonation token's explicit 30-minute cutoff.
        $this->assertNull($loginToken->accessToken->expires_at);
        $this->assertTrue(
            $impersonationToken->expires_at->lt(now()->addDays(7)),
            'Impersonation token expiry must be shorter than the 7-day global login expiration.'
        );
    }
}
