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

    #[Test]
    public function a_trip_can_be_started_and_ended_and_leaves_history_and_an_activity_log(): void
    {
        $vehicle = $this->vehicle($this->van, 'VAN 5555');
        Sanctum::actingAs($this->custodian, ['*']);

        $id = $this->postJson("/api/vehicles/{$vehicle->vehicle_id}/usage", ['purpose' => 'Barangay supply run', 'destination' => 'Poblacion', 'odometer_start' => 1000])
            ->assertCreated()->json('usage_id');

        // One open trip at a time.
        $this->postJson("/api/vehicles/{$vehicle->vehicle_id}/usage", ['purpose' => 'Again'])->assertUnprocessable();
        $this->putJson("/api/usage-logs/{$id}/end", ['odometer_end' => 900])->assertUnprocessable(); // odometer can't go backwards
        $this->putJson("/api/usage-logs/{$id}/end", ['odometer_end' => 1042])->assertOk();
        $this->putJson("/api/usage-logs/{$id}/end", [])->assertUnprocessable(); // already ended

        $this->getJson("/api/vehicles/{$vehicle->vehicle_id}/usage")->assertOk()->assertJsonCount(1)->assertJsonPath('0.odometer_end', 1042);
        $this->assertDatabaseHas('vehicle_histories', ['vehicle_id' => $vehicle->vehicle_id, 'activity_type' => 'Vehicle Taken Out']);
        $this->assertDatabaseHas('vehicle_histories', ['vehicle_id' => $vehicle->vehicle_id, 'activity_type' => 'Vehicle Returned']);
        $this->assertDatabaseHas('activity_logs', ['module' => 'Vehicle Usage', 'action' => 'Add']);
    }

    #[Test]
    public function an_unavailable_vehicle_cannot_go_out_and_maintenance_cannot_log_usage(): void
    {
        $down = $this->vehicle($this->van, 'VAN 6666', ['status' => 'Under Maintenance']);
        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson("/api/vehicles/{$down->vehicle_id}/usage", ['purpose' => 'x'])->assertUnprocessable();

        $ok = $this->vehicle($this->van, 'VAN 7777');
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->postJson("/api/vehicles/{$ok->vehicle_id}/usage", ['purpose' => 'x'])->assertForbidden();
        $this->getJson("/api/vehicles/{$ok->vehicle_id}/usage")->assertForbidden();
    }
}
