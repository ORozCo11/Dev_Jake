<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class SidebarBadgeCountsTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function admin_badge_counts_include_records_awaiting_verification_and_pending_users(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $admin->barangay_id, 'is_active' => false, 'approved_at' => null]);

        Sanctum::actingAs($admin, ['*']);
        $counts = $this->getJson('/api/dashboard')->assertOk()->json('badge_counts');

        $this->assertSame(1, $counts['users']);
        $this->assertSame(0, $counts['maintenance']);
        $this->assertArrayHasKey('schedules', $counts);
    }
}
