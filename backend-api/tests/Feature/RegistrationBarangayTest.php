<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * REGISTRATION PICKS A REAL PLACE
 *
 * Once a city's barangays are on file, signing up means choosing one of them —
 * a typed name can no longer mint a second, code-less row alongside the real
 * one. Cities with nothing on file yet still accept a typed name, so missing
 * data can never lock a whole city out of the system.
 */
class RegistrationBarangayTest extends TestCase
{
    use RefreshDatabase;

    private City $city;

    protected function setUp(): void
    {
        parent::setUp();

        $province = Province::create(['code' => '072200000', 'name' => 'Cebu']);
        $this->city = City::create(['province_id' => $province->id, 'code' => '072230000', 'name' => 'Mandaue City']);
    }

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'name' => 'Juan Dela Cruz',
            'email' => 'juan' . random_int(1000, 9999) . '@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
            'phone' => '09171234567',
            'address' => '123 Some Street',
            'city_id' => $this->city->id,
            'staff_code' => 'WRONG-CODE',
        ], $overrides);
    }

    #[Test]
    public function a_city_with_barangays_on_file_requires_picking_one(): void
    {
        Barangay::create(['city_id' => $this->city->id, 'code' => '072230001', 'name' => 'Alang-alang']);

        $this->postJson('/api/register', $this->payload())
            ->assertStatus(422)
            ->assertJsonValidationErrors('barangay_id');
    }

    #[Test]
    public function a_typed_name_is_refused_when_the_city_has_a_list(): void
    {
        $real = Barangay::create(['city_id' => $this->city->id, 'code' => '072230001', 'name' => 'Alang-alang']);

        $this->postJson('/api/register', $this->payload(['barangay_name' => 'Alang alang']))
            ->assertStatus(422)
            ->assertJsonValidationErrors('barangay_name');

        $this->assertSame(1, Barangay::count(), 'A typed name must not create a rival row.');
        $this->assertSame('Alang-alang', $real->fresh()->name);
    }

    #[Test]
    public function a_city_with_no_list_still_accepts_a_typed_name(): void
    {
        // Validation passes; the request then fails on the staff code, which
        // is all we need to know — the barangay fields were accepted.
        $this->postJson('/api/register', $this->payload(['barangay_name' => 'Brand New Barangay']))
            ->assertStatus(422)
            ->assertJsonMissingValidationErrors(['barangay_id', 'barangay_name']);
    }

    #[Test]
    public function a_barangay_from_another_city_is_refused(): void
    {
        $otherCity = City::create(['province_id' => $this->city->province_id, 'code' => '072209000', 'name' => 'Bantayan']);
        $elsewhere = Barangay::create(['city_id' => $otherCity->id, 'code' => '072209007', 'name' => 'Doong']);
        Barangay::create(['city_id' => $this->city->id, 'code' => '072230001', 'name' => 'Alang-alang']);

        $this->postJson('/api/register', $this->payload(['barangay_id' => $elsewhere->id]))
            ->assertStatus(422)
            ->assertJsonValidationErrors('barangay_id');
    }

    #[Test]
    public function registering_never_reaches_out_to_the_network(): void
    {
        Http::preventStrayRequests();

        $barangay = Barangay::create(['city_id' => $this->city->id, 'code' => '072230001', 'name' => 'Alang-alang']);

        // Rejected on the staff code, never on a network call: preventStrayRequests
        // turns any outbound HTTP during registration into a failure.
        $this->postJson('/api/register', $this->payload(['barangay_id' => $barangay->id]))
            ->assertStatus(422);
    }
}
