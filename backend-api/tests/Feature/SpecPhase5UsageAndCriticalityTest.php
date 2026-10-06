<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleHub;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class SpecPhase5UsageAndCriticalityTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private User $mechanic;
    private VehicleCategory $ambulance;
    private VehicleCategory $van;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $this->custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'can_register_vehicles' => true]);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel']]);
        $this->ambulance = VehicleCategory::create(['category_name' => 'Ambulance', 'domain' => 'Land', 'description' => 'x', 'default_criticality' => 'Critical']);
        $this->van = VehicleCategory::create(['category_name' => 'Service Van', 'domain' => 'Land', 'description' => 'x']);
        VehicleHub::create(['hub_key' => 'main-depot', 'name' => 'Main Depot', 'label' => 'MD', 'lat' => 10.3, 'lng' => 123.9]);
    }

    private function vehicle(VehicleCategory $category, string $plate, array $extra = []): Vehicle
    {
        return Vehicle::create($extra + [
            'vehicle_name' => "V {$plate}", 'plate_number' => $plate, 'category_id' => $category->category_id,
            'brand' => 'T', 'model' => 'T', 'year_model' => 2022, 'capacity' => '1', 'vehicle_color' => 'x', 'current_location' => 'Main Depot',
            'status' => 'Available', 'condition' => 'Good',
        ]);
    }

    #[Test]
    public function criticality_defaults_from_the_type_and_an_admin_override_wins(): void
    {
        $a = $this->vehicle($this->ambulance, 'AMB 1111');
        $v = $this->vehicle($this->van, 'VAN 1111');
        $this->assertSame('Critical', $a->effectiveCriticality());
        $this->assertSame('Normal', $v->effectiveCriticality());

        $v->update(['criticality' => 'High']);
        $this->assertSame('High', $v->fresh()->effectiveCriticality());

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/categories/{$this->van->category_id}", ['category_name' => 'Service Van', 'domain' => 'Land', 'default_criticality' => 'Bogus'])->assertUnprocessable();
        $this->putJson("/api/categories/{$this->van->category_id}", ['category_name' => 'Service Van', 'domain' => 'Land', 'default_criticality' => 'High'])->assertOk();
    }

    #[Test]
    public function a_custodian_cannot_set_criticality_when_registering_a_vehicle(): void
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/vehicles', [
            'vehicle_name' => 'New', 'plate_number' => 'NEW 1234', 'category_id' => $this->van->category_id, 'brand' => 'T', 'model' => 'T',
            'year_model' => 2022, 'capacity' => '1', 'fuel_type' => 'Diesel', 'vehicle_color' => 'x', 'current_location' => 'Main Depot', 'criticality' => 'Critical',
        ])->assertCreated();
        $this->assertNull(Vehicle::where('plate_number', 'NEW 1234')->first()->criticality);
    }

    #[Test]
    public function the_dashboard_watch_ranks_unready_vehicles_by_criticality(): void
    {
        $this->vehicle($this->van, 'VAN 2222');                                      // Normal, never checked
        $this->vehicle($this->ambulance, 'AMB 2222', ['status' => 'Under Maintenance']); // Critical, in maintenance
        $this->vehicle($this->van, 'VAN 3333', ['criticality' => 'High']);           // High override, never checked
        $this->vehicle($this->van, 'VAN 4444', ['status' => 'Decommissioned']);     // retired — excluded

        Sanctum::actingAs($this->admin, ['*']);
        $watch = $this->getJson('/api/dashboard')->assertOk()->json('criticality_watch');

        $this->assertSame(['Critical', 'High', 'Normal'], array_column($watch, 'criticality'));
        $this->assertSame('In maintenance', $watch[0]['reason']);
        $this->assertCount(3, $watch);
    }

    private function markReady(Vehicle $vehicle): void
    {
        \App\Models\VehicleReadinessCheck::create([
            'vehicle_id' => $vehicle->vehicle_id, 'checked_by' => $this->custodian->id,
            'checklist' => [['item' => 'Fuel', 'passed' => true]], 'all_passed' => true, 'checked_at' => now(),
        ]);
    }

    #[Test]
    public function a_trip_can_be_taken_out_and_returned_and_leaves_history_and_an_activity_log(): void
    {
        $vehicle = $this->vehicle($this->van, 'VAN 5555');
        $this->markReady($vehicle);
        Sanctum::actingAs($this->custodian, ['*']);

        $id = $this->postJson("/api/vehicles/{$vehicle->vehicle_id}/usage", ['purpose' => 'Barangay supply run', 'destination' => 'Poblacion'])
            ->assertCreated()->json('usage_id');

        // The list reads the vehicle as Currently Out — usage is an indicator, the fleet status is untouched.
        $row = collect($this->getJson('/api/vehicles')->assertOk()->json())->firstWhere('vehicle_id', $vehicle->vehicle_id);
        $this->assertSame('out', $row['usage_state']);
        $this->assertSame('Available', $row['status']);

        // One open trip at a time.
        $this->postJson("/api/vehicles/{$vehicle->vehicle_id}/usage", ['purpose' => 'Again'])->assertUnprocessable();
        $this->putJson("/api/usage-logs/{$id}/end", [])->assertOk();
        $this->putJson("/api/usage-logs/{$id}/end", [])->assertUnprocessable(); // already ended

        $row = collect($this->getJson('/api/vehicles')->assertOk()->json())->firstWhere('vehicle_id', $vehicle->vehicle_id);
        $this->assertSame('at_base', $row['usage_state']);
        $this->assertNotNull($row['last_used_at']);

        $this->getJson("/api/vehicles/{$vehicle->vehicle_id}/usage")->assertOk()->assertJsonCount(1);
        $this->assertDatabaseHas('vehicle_histories', ['vehicle_id' => $vehicle->vehicle_id, 'activity_type' => 'Vehicle Taken Out']);
        $this->assertDatabaseHas('vehicle_histories', ['vehicle_id' => $vehicle->vehicle_id, 'activity_type' => 'Vehicle Returned']);
        $this->assertDatabaseHas('activity_logs', ['module' => 'Vehicle Usage', 'action' => 'Add']);
    }

    #[Test]
    public function only_an_available_and_verified_ready_vehicle_can_be_taken_out(): void
    {
        $down = $this->vehicle($this->van, 'VAN 6666', ['status' => 'Under Maintenance']);
        $this->markReady($down);
        $unchecked = $this->vehicle($this->van, 'VAN 6667');

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson("/api/vehicles/{$down->vehicle_id}/usage", ['purpose' => 'x'])->assertUnprocessable();
        $this->postJson("/api/vehicles/{$unchecked->vehicle_id}/usage", ['purpose' => 'x'])->assertUnprocessable();

        $failed = $this->vehicle($this->van, 'VAN 6668');
        \App\Models\VehicleReadinessCheck::create(['vehicle_id' => $failed->vehicle_id, 'checked_by' => $this->custodian->id, 'checklist' => [['item' => 'Fuel', 'passed' => false]], 'all_passed' => false, 'checked_at' => now()]);
        $this->postJson("/api/vehicles/{$failed->vehicle_id}/usage", ['purpose' => 'x'])->assertUnprocessable();
    }

    #[Test]
    public function maintenance_personnel_cannot_log_or_view_usage(): void
    {
        $ok = $this->vehicle($this->van, 'VAN 7777');
        $this->markReady($ok);
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson("/api/vehicles/{$ok->vehicle_id}/usage", ['purpose' => 'x'])->assertForbidden();
        $this->getJson("/api/vehicles/{$ok->vehicle_id}/usage")->assertForbidden();
    }
}
