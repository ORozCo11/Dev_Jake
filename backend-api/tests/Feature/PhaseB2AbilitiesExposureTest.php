<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase B2 — the frontend gates on a computed
 * `abilities` list instead of role strings. This is exposed at exactly two
 * places: the login response and GET /user ("who am I").
 */
class PhaseB2AbilitiesExposureTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function login_response_includes_this_accounts_abilities(): void
    {
        $admin = User::factory()->create([
            'role' => 'Admin', 'roles' => ['Admin'], 'password' => bcrypt('password123'), 'is_active' => true,
        ]);

        $response = $this->postJson('/api/login', [
            'email' => $admin->email,
            'password' => 'password123',
        ])->assertOk();

        $abilities = $response->json('user.abilities');
        $this->assertIsArray($abilities);
        $this->assertContains('vehicle.create', $abilities);
        $this->assertNotContains('ticket.inspect', $abilities);
    }

    #[Test]
    public function get_user_includes_this_accounts_abilities(): void
    {
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);

        Sanctum::actingAs($custodian, ['*']);
        $response = $this->getJson('/api/user')->assertOk();

        $abilities = $response->json('abilities');
        $this->assertIsArray($abilities);
        $this->assertContains('ticket.inspect', $abilities);
        // A Custodian may register a vehicle when delegated to (role
        // realignment decision 6), but still can't edit one afterward.
        $this->assertContains('vehicle.create', $abilities);
        $this->assertNotContains('vehicle.edit', $abilities);
    }
}
