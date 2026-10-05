<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\VehicleCategory;
use App\Models\VehicleHub;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * INTEGRATION + FUNCTIONAL TESTS
 *
 * These drive the real "Add Vehicle" endpoint end-to-end: HTTP request ->
 * route -> controller -> validation rules -> database.
 *
 *  - INTEGRATION: proves the rules, the API and the database work together.
 *  - FUNCTIONAL : proves the specific business outcome (valid data is saved,
 *                 a text field rejects numbers, a number field rejects letters).
 */
class VehicleValidationTest extends TestCase
{
    use RefreshDatabase;

    private function actingAsAdmin(): User
    {
        $admin = User::factory()->create(['role' => 'Admin']);
        Sanctum::actingAs($admin, ['*']);

        return $admin;
    }

    private function actingAsCustodian(): User
    {
        $custodian = User::factory()->create(['role' => 'Custodian']);
        Sanctum::actingAs($custodian, ['*']);

        return $custodian;
    }

    // Production-readiness audit finding #6 — vehicle registration needs an
    // explicit per-account delegation (can_register_vehicles), not just the
    // Custodian role.
    private function actingAsDelegatedCustodian(): User
    {
        $custodian = User::factory()->create(['role' => 'Custodian', 'can_register_vehicles' => true]);
        Sanctum::actingAs($custodian, ['*']);

        return $custodian;
    }

    private function actingAsMechanic(): User
    {
        $mechanic = User::factory()->create(['role' => 'Maintenance Personnel']);
        Sanctum::actingAs($mechanic, ['*']);

        return $mechanic;
    }

    private function category(): VehicleCategory
    {
        return VehicleCategory::create([
            'category_name' => 'Rescue Vehicle',
            'description' => 'For testing',
        ]);
    }

    private function hub(): VehicleHub
    {
        return VehicleHub::create([
            'hub_key' => 'test-depot',
            'name' => 'Main Depot',
            'label' => 'MD',
            'lat' => 10.3462,
            'lng' => 123.9603,
        ]);
    }

    /**
     * A complete, well-formed payload that should always pass validation.
     * Individual tests override single fields to test one rule at a time.
     */
    private function validPayload(array $overrides = []): array
    {
        return array_merge([
            'vehicle_name' => 'Rescue Truck',
            'plate_number' => 'ABC-1234',
            'category_id' => $this->category()->category_id,
            'brand' => 'Toyota',
            'model' => 'Hilux',
            'year_model' => 2022,
            'capacity' => '1000kg',
            'fuel_type' => 'Diesel',
            'vehicle_color' => 'White',
            'current_location' => $this->hub()->name,
        ], $overrides);
    }

    #[Test]
    public function it_creates_a_vehicle_when_all_data_is_valid(): void
    {
        $this->actingAsAdmin();

        $response = $this->postJson('/api/vehicles', $this->validPayload());

        $response->assertCreated();
        $this->assertDatabaseHas('vehicles', [
            'plate_number' => 'ABC-1234',
            'vehicle_color' => 'White',
        ]);
    }

    #[Test]
    public function it_accepts_a_colour_with_letters_and_separators(): void
    {
        $this->actingAsAdmin();

        $response = $this->postJson('/api/vehicles', $this->validPayload([
            'plate_number' => 'XYZ-9999',
            'vehicle_color' => 'White / Blue',
        ]));

        $response->assertCreated();
    }

    #[Test]
    public function it_rejects_a_colour_that_contains_numbers(): void
    {
        $this->actingAsAdmin();

        $response = $this->postJson('/api/vehicles', $this->validPayload([
            'vehicle_color' => 'Blue123',
        ]));

        $response->assertStatus(422);
        $response->assertJsonValidationErrors('vehicle_color');
        $this->assertDatabaseCount('vehicles', 0);
    }

    #[Test]
    public function it_rejects_a_year_model_that_contains_letters(): void
    {
        $this->actingAsAdmin();

        $response = $this->postJson('/api/vehicles', $this->validPayload([
            'year_model' => '20a4',
        ]));

        $response->assertStatus(422);
        $response->assertJsonValidationErrors('year_model');
        $this->assertDatabaseCount('vehicles', 0);
    }

    #[Test]
    public function it_requires_fuel_type_for_a_land_vehicle(): void
    {
        $this->actingAsAdmin();

        $payload = $this->validPayload();
        unset($payload['fuel_type']);

        $response = $this->postJson('/api/vehicles', $payload);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors('fuel_type');
    }

    #[Test]
    public function it_requires_hull_material_and_engine_type_for_a_water_vehicle(): void
    {
        $this->actingAsAdmin();

        $waterCategory = VehicleCategory::create([
            'category_name' => 'Rescue Boat',
            'domain' => 'Water',
            'description' => 'For testing',
        ]);

        $payload = $this->validPayload(['category_id' => $waterCategory->category_id]);
        unset($payload['fuel_type']);

        $response = $this->postJson('/api/vehicles', $payload);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors(['hull_material', 'engine_type']);
    }

    #[Test]
    public function it_creates_a_water_vehicle_with_hull_and_engine_details(): void
    {
        $this->actingAsAdmin();

        $waterCategory = VehicleCategory::create([
            'category_name' => 'Rescue Boat',
            'domain' => 'Water',
            'description' => 'For testing',
        ]);

        // Fuel Type is required for Water vehicles too, alongside Hull
        // Material and Engine Type — a boat's engine still burns something.
        $payload = $this->validPayload([
            'category_id' => $waterCategory->category_id,
            'hull_material' => 'Fiberglass',
            'engine_type' => 'Outboard 40HP',
            'fuel_type' => 'Gasoline',
        ]);

        $response = $this->postJson('/api/vehicles', $payload);

        $response->assertCreated();
        $this->assertDatabaseHas('vehicles', [
            'plate_number' => 'ABC-1234',
            'hull_material' => 'Fiberglass',
            'engine_type' => 'Outboard 40HP',
            'fuel_type' => 'Gasoline',
        ]);
    }

    #[Test]
    public function a_water_vehicle_also_requires_fuel_type(): void
    {
        $this->actingAsAdmin();

        $waterCategory = VehicleCategory::create([
            'category_name' => 'Rescue Boat',
            'domain' => 'Water',
            'description' => 'For testing',
        ]);

        $payload = $this->validPayload([
            'category_id' => $waterCategory->category_id,
            'hull_material' => 'Fiberglass',
            'engine_type' => 'Outboard 40HP',
        ]);
        unset($payload['fuel_type']);

        $response = $this->postJson('/api/vehicles', $payload);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors(['fuel_type']);
    }

    // =======================================================================
    // Vehicle registration — Admin + a delegated Custodian may register a
    // vehicle; Maintenance Personnel may not. Registration is data entry,
    // not a transfer of accountability — vehicle.edit stays Admin-only (see
    // PhaseB4RoleModelTest), so a Custodian who registers one still can't
    // freely change its protected master data afterward.
    // =======================================================================

    #[Test]
    public function a_custodian_can_register_a_vehicle_when_delegated(): void
    {
        $this->actingAsDelegatedCustodian();

        $response = $this->postJson('/api/vehicles', $this->validPayload());

        $response->assertCreated();
        $this->assertDatabaseHas('vehicles', ['plate_number' => 'ABC-1234']);
    }

    #[Test]
    public function a_custodian_without_delegation_cannot_register_a_vehicle(): void
    {
        $this->actingAsCustodian();

        $response = $this->postJson('/api/vehicles', $this->validPayload());

        $response->assertForbidden();
        $this->assertDatabaseCount('vehicles', 0);
    }

    #[Test]
    public function maintenance_personnel_cannot_register_a_vehicle(): void
    {
        $this->actingAsMechanic();

        $response = $this->postJson('/api/vehicles', $this->validPayload());

        $response->assertForbidden();
        $this->assertDatabaseCount('vehicles', 0);
    }

    #[Test]
    public function a_custodian_who_registered_a_vehicle_still_cannot_edit_its_master_data(): void
    {
        $custodian = $this->actingAsDelegatedCustodian();
        $created = $this->postJson('/api/vehicles', $this->validPayload())->assertCreated()->json();

        Sanctum::actingAs($custodian, ['*']);
        $response = $this->putJson("/api/vehicles/{$created['vehicle_id']}", [
            'plate_number' => 'ZZZ-9999',
        ]);

        $response->assertForbidden();
    }

    #[Test]
    public function registering_a_vehicle_logs_the_role_it_was_registered_under(): void
    {
        $custodian = $this->actingAsDelegatedCustodian();

        $created = $this->postJson('/api/vehicles', $this->validPayload())->assertCreated()->json();

        $this->assertDatabaseHas('activity_logs', [
            'user_id' => $custodian->id,
            'role' => 'Custodian',
            'affected_record_id' => $created['vehicle_id'],
        ]);
    }
}
