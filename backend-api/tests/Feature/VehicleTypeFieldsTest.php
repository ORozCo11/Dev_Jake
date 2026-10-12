<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleHub;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class VehicleTypeFieldsTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private VehicleCategory $type;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $barangay = Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id])->id;
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $barangay]);
        $this->custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $barangay, 'can_register_vehicles' => true]);
        $this->type = VehicleCategory::create(['category_name' => 'Fire Truck', 'domain' => 'Land', 'description' => 'x']);
        VehicleHub::create(['hub_key' => 'main-depot', 'name' => 'Main Depot', 'label' => 'MD', 'lat' => 10.3, 'lng' => 123.9, 'barangay_id' => $barangay]);
    }

    private function addField(array $override = []): array
    {
        return $this->postJson("/api/categories/{$this->type->category_id}/fields", $override + ['label' => 'Tank Capacity', 'field_type' => 'number', 'is_required' => true, 'unit' => 'L'])
            ->assertCreated()->json();
    }

    private function vehiclePayload(array $override = []): array
    {
        return $override + [
            'vehicle_name' => 'Engine 1', 'plate_number' => 'FIR 1234', 'category_id' => $this->type->category_id,
            'brand' => 'Isuzu', 'model' => 'Giga', 'year_model' => 2021, 'capacity' => '6 pax',
            'fuel_type' => 'Diesel', 'vehicle_color' => 'Red', 'current_location' => 'Main Depot',
        ];
    }

    #[Test]
    public function only_admin_manages_fields_and_keys_are_generated_and_dropdowns_need_options(): void
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson("/api/categories/{$this->type->category_id}/fields", ['label' => 'X', 'field_type' => 'text'])->assertForbidden();

        Sanctum::actingAs($this->admin, ['*']);
        $field = $this->addField();
        $this->assertSame('tank_capacity', $field['key']);
        $this->assertSame('tank_capacity_2', $this->addField()['key']);

        $this->postJson("/api/categories/{$this->type->category_id}/fields", ['label' => 'Pump', 'field_type' => 'dropdown'])->assertUnprocessable();
        $this->postJson("/api/categories/{$this->type->category_id}/fields", ['label' => 'Pump', 'field_type' => 'bogus'])->assertUnprocessable();
        $this->postJson("/api/categories/{$this->type->category_id}/fields", ['label' => 'Pump', 'field_type' => 'dropdown', 'options' => ['Front', 'Rear']])->assertCreated();

        $this->getJson('/api/categories')->assertOk()->assertJsonCount(3, '0.fields');
        $this->assertDatabaseHas('activity_logs', ['module' => 'Vehicle Categories', 'action' => 'Add']);
    }

    #[Test]
    public function reading_a_types_field_schema_requires_authentication_and_any_barangay_role_can_read_it(): void
    {
        // Final senior system review — index() previously had no ability
        // check at all, reachable by any authenticated user of any role.
        // vehicle_type.view closes that while still allowing everyone who
        // legitimately needs the field schema (anyone viewing a vehicle
        // with custom fields filled in) to read it.
        $this->getJson("/api/categories/{$this->type->category_id}/fields")->assertUnauthorized();

        $mechanic = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel']]);

        foreach ([$this->admin, $this->custodian, $mechanic] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->getJson("/api/categories/{$this->type->category_id}/fields")->assertOk();
        }
    }

    #[Test]
    public function a_vehicle_must_satisfy_its_types_active_fields_and_stores_the_values(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $required = $this->addField();
        $this->addField(['label' => 'Ladder', 'field_type' => 'yes_no', 'is_required' => false, 'unit' => null]);

        $this->postJson('/api/vehicles', $this->vehiclePayload())->assertUnprocessable()->assertJsonValidationErrors(['custom_fields.tank_capacity']);
        $this->postJson('/api/vehicles', $this->vehiclePayload(['custom_fields' => ['tank_capacity' => 'lots']]))->assertUnprocessable();
        $this->postJson('/api/vehicles', $this->vehiclePayload(['custom_fields' => ['tank_capacity' => 4000, 'ladder' => 'Maybe']]))->assertUnprocessable();

        // Flat cf_<key> inputs (how the multipart form posts them) work too.
        $this->postJson('/api/vehicles', $this->vehiclePayload(['cf_tank_capacity' => '4000', 'cf_ladder' => 'Yes']))->assertCreated();
        $this->assertEquals(['tank_capacity' => '4000', 'ladder' => 'Yes'], Vehicle::first()->custom_values);
    }

    #[Test]
    public function an_archived_field_stops_being_required_but_existing_values_are_kept_on_edit(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $field = $this->addField();
        $created = $this->postJson('/api/vehicles', $this->vehiclePayload(['custom_fields' => ['tank_capacity' => 4000]]))->assertCreated()->json();

        $this->putJson("/api/category-fields/{$field['field_id']}", ['label' => 'Tank Capacity', 'is_active' => false])->assertOk();
        // The type is immutable once created.
        $this->putJson("/api/category-fields/{$field['field_id']}", ['label' => 'Tank', 'field_type' => 'text'])->assertOk()->assertJsonPath('field_type', 'number');

        $this->putJson("/api/vehicles/{$created['vehicle_id']}", $this->vehiclePayload(['vehicle_name' => 'Engine 1b']))->assertOk();
        $this->assertEquals(['tank_capacity' => '4000'], Vehicle::first()->custom_values);

        $this->postJson('/api/vehicles', $this->vehiclePayload(['plate_number' => 'FIR 5678']))->assertCreated();
    }

    #[Test]
    public function an_optional_value_and_the_criticality_override_can_be_cleared_on_edit(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $this->addField(['label' => 'Ladder', 'field_type' => 'yes_no', 'is_required' => false, 'unit' => null]);
        $created = $this->postJson('/api/vehicles', $this->vehiclePayload(['cf_ladder' => 'Yes', 'criticality' => 'Critical']))->assertCreated()->json();
        $this->assertSame('Critical', Vehicle::first()->criticality);

        $this->putJson("/api/vehicles/{$created['vehicle_id']}", $this->vehiclePayload(['cf_ladder' => '__clear__', 'criticality' => 'Inherit']))->assertOk();
        $this->assertNull(Vehicle::first()->custom_values);
        $this->assertNull(Vehicle::first()->criticality);
    }

    #[Test]
    public function import_reads_custom_columns_for_the_rows_own_type_and_flags_bad_values(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $this->addField();
        $this->addField(['label' => 'Pump', 'field_type' => 'dropdown', 'is_required' => false, 'options' => ['Front', 'Rear'], 'unit' => null]);

        $headers = ['Vehicle Name', 'Plate Number', 'Vehicle Type', 'Brand', 'Model', 'Year Model', 'Capacity', 'Fuel Type', 'Vehicle Color', 'Current Location', 'Tank Capacity', 'Pump'];
        $base = ['Engine', 'FIR 1111', 'Fire Truck', 'Isuzu', 'Giga', 2021, '6 pax', 'Diesel', 'Red', 'Main Depot'];
        $sheet = new Spreadsheet();
        $ws = $sheet->getActiveSheet();
        $ws->fromArray($headers, null, 'A1');
        $ws->fromArray([...$base, 4000, 'rear'], null, 'A2');                                   // valid, dropdown case-normalised
        $ws->fromArray([...array_replace($base, [1 => 'FIR 2222']), 'many', 'Front'], null, 'A3'); // bad number
        $ws->fromArray([...array_replace($base, [1 => 'FIR 3333']), 4000, 'Middle'], null, 'A4'); // bad dropdown
        $path = tempnam(sys_get_temp_dir(), 'imp') . '.xlsx';
        (new Xlsx($sheet))->save($path);

        $res = $this->postJson('/api/vehicle-imports', ['file' => new UploadedFile($path, 'v.xlsx', null, null, true)])->assertCreated();
        $res->assertJsonPath('valid_rows', 1)->assertJsonPath('error_rows', 2);
        $fields = collect($res->json('findings'))->map(fn ($f) => "{$f['row']}:{$f['field']}")->all();
        $this->assertContains('3:Tank Capacity', $fields);
        $this->assertContains('4:Pump', $fields);

        $this->postJson('/api/vehicle-imports/' . $res->json('id') . '/commit')->assertOk();
        $this->assertEquals(['tank_capacity' => '4000', 'pump' => 'Rear'], Vehicle::where('plate_number', 'FIR 1111')->first()->custom_values);
    }
}
