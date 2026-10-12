<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\RegistrationSetting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class AuthControllerTest extends TestCase
{
    use RefreshDatabase;

    private City $city;

    protected function setUp(): void
    {
        parent::setUp();
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $this->city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
    }

    #[Test]
    public function a_failed_registration_for_a_brand_new_barangay_leaves_no_orphaned_barangay_row(): void
    {
        $before = Barangay::count();

        $this->postJson('/api/register', [
            'name' => 'Test Person',
            'email' => 'test-person@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
            'phone' => '09171234567',
            'address' => '123 Test St',
            'city_id' => $this->city->id,
            'barangay_name' => 'Brand New Barangay',
            // No staff_code — this barangay has never been seeded/configured
            // with one, so this registration must fail...
        ])->assertUnprocessable();

        // ...and must not leave a Barangay row behind for a registration
        // that never actually completed.
        $this->assertSame($before, Barangay::count());
        $this->assertFalse(Barangay::where('name', 'Brand New Barangay')->exists());
    }

    #[Test]
    public function a_pending_never_approved_account_gets_a_distinct_login_message(): void
    {
        $user = User::factory()->create([
            'role' => 'Custodian',
            'roles' => ['Custodian'],
            'is_active' => false,
            'approved_at' => null,
            'password' => bcrypt('password123'),
        ]);

        $response = $this->postJson('/api/login', [
            'email' => $user->email,
            'password' => 'password123',
        ])->assertForbidden();

        $response->assertJsonFragment(['message' => 'Your account is still awaiting approval from your barangay\'s Admin.']);
    }

    #[Test]
    public function a_previously_approved_then_deactivated_account_still_gets_the_deactivated_message(): void
    {
        $user = User::factory()->create([
            'role' => 'Custodian',
            'roles' => ['Custodian'],
            'is_active' => false,
            'approved_at' => now()->subDays(10),
            'password' => bcrypt('password123'),
        ]);

        $response = $this->postJson('/api/login', [
            'email' => $user->email,
            'password' => 'password123',
        ])->assertForbidden();

        $response->assertJsonFragment(['message' => 'This account has been deactivated. Contact an administrator.']);
    }

    #[Test]
    public function registering_the_first_admin_for_a_barangay_starts_inactive_and_notifies_every_super_admin(): void
    {
        $barangay = Barangay::create(['name' => 'Fresh Barangay', 'city_id' => $this->city->id]);
        $setting = RegistrationSetting::for($barangay->id);
        $superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);

        $this->postJson('/api/register', [
            'name' => 'First Admin',
            'email' => 'first-admin@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
            'phone' => '09171234567',
            'address' => '123 Test St',
            'city_id' => $this->city->id,
            'barangay_id' => $barangay->id,
            'staff_code' => $setting->staff_code,
        ])->assertCreated();

        // Was: is_active/approved_at set as though this account were already
        // reviewed. Now every registrant, first-for-barangay or not, starts
        // exactly the same way — unreviewed — closing the race where anyone
        // holding the shared staff code could win an uncontested Admin seat.
        $user = User::where('email', 'first-admin@example.com')->firstOrFail();
        $this->assertSame('Admin', $user->role);
        $this->assertFalse($user->is_active);
        $this->assertNull($user->approved_at);

        $this->assertDatabaseHas('notifications', [
            'user_id' => $superAdmin->id,
            'type' => 'pending_admin_approval',
        ]);
    }

    #[Test]
    public function a_pending_first_admin_of_an_orphaned_barangay_is_told_to_wait_on_a_super_admin(): void
    {
        $barangay = Barangay::create(['name' => 'Orphaned Barangay', 'city_id' => $this->city->id]);
        $user = User::factory()->create([
            'role' => 'Admin',
            'roles' => ['Admin'],
            'barangay_id' => $barangay->id,
            'is_active' => false,
            'approved_at' => null,
            'password' => bcrypt('password123'),
        ]);

        $response = $this->postJson('/api/login', [
            'email' => $user->email,
            'password' => 'password123',
        ])->assertForbidden();

        $response->assertJsonFragment([
            'message' => 'Your account is still awaiting approval from a Super Admin, as the first Admin for your barangay.',
        ]);
    }

    #[Test]
    public function a_pending_admin_whose_barangay_already_has_an_active_admin_gets_the_ordinary_message(): void
    {
        $barangay = Barangay::create(['name' => 'Staffed Barangay', 'city_id' => $this->city->id]);
        User::factory()->create([
            'role' => 'Admin',
            'roles' => ['Admin'],
            'barangay_id' => $barangay->id,
            'is_active' => true,
            'approved_at' => now(),
        ]);
        $pending = User::factory()->create([
            'role' => 'Admin',
            'roles' => ['Admin'],
            'barangay_id' => $barangay->id,
            'is_active' => false,
            'approved_at' => null,
            'password' => bcrypt('password123'),
        ]);

        $response = $this->postJson('/api/login', [
            'email' => $pending->email,
            'password' => 'password123',
        ])->assertForbidden();

        $response->assertJsonFragment(['message' => 'Your account is still awaiting approval from your barangay\'s Admin.']);
    }
}
