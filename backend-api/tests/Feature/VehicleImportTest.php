<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleHub;
use App\Models\VehicleImport;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class VehicleImportTest extends TestCase
{
    use RefreshDatabase;

    private const HEADERS = ['Vehicle Name', 'Plate Number', 'Vehicle Type', 'Brand', 'Model', 'Year Model', 'Capacity', 'Fuel Type', 'Vehicle Color', 'Current Location'];

    private int $barangayId;
    private User $admin;
    private User $custodian;
    private User $mechanic;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);
        $this->barangayId = Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id])->id;
        foreach (['admin' => 'Admin', 'custodian' => 'Custodian', 'mechanic' => 'Maintenance Personnel'] as $prop => $role) {
            $this->$prop = User::factory()->create(['role' => $role, 'roles' => [$role], 'barangay_id' => $this->barangayId, 'can_register_vehicles' => $role === 'Custodian']);
        }
        VehicleCategory::create(['category_name' => 'Ambulance', 'domain' => 'Land', 'description' => 'x']);
        VehicleCategory::create(['category_name' => 'Rescue Boat', 'domain' => 'Water', 'description' => 'x']);
        VehicleHub::create(['hub_key' => 'main-depot', 'name' => 'Main Depot', 'label' => 'MD', 'lat' => 10.3, 'lng' => 123.9, 'barangay_id' => $this->barangayId]);
    }

    private function row(array $override = []): array
    {
        return array_replace([
            'Vehicle Name' => 'Ambulance One', 'Plate Number' => 'ABC 1234', 'Vehicle Type' => 'Ambulance',
            'Brand' => 'Toyota', 'Model' => 'HiAce', 'Year Model' => 2022, 'Capacity' => '8 persons',
            'Fuel Type' => 'Diesel', 'Vehicle Color' => 'White', 'Current Location' => 'Main Depot',
        ], $override);
    }

    private function xlsx(array $rows, array $headers = self::HEADERS): UploadedFile
    {
        $sheet = new Spreadsheet();
        $ws = $sheet->getActiveSheet();
        $ws->fromArray($headers, null, 'A1');
        foreach (array_values($rows) as $i => $r) {
            $ws->fromArray(array_map(fn ($h) => $r[$h] ?? null, $headers), null, 'A' . ($i + 2));
        }
        $path = tempnam(sys_get_temp_dir(), 'imp') . '.xlsx';
        (new Xlsx($sheet))->save($path);

        return new UploadedFile($path, 'vehicles.xlsx', null, null, true);
    }

    private function csv(array $rows, array $headers = self::HEADERS): UploadedFile
    {
        $lines = [implode(',', $headers)];
        foreach ($rows as $r) {
            $lines[] = implode(',', array_map(fn ($h) => '"' . ($r[$h] ?? '') . '"', $headers));
        }
        $path = tempnam(sys_get_temp_dir(), 'imp') . '.csv';
        file_put_contents($path, implode("\n", $lines));

        return new UploadedFile($path, 'vehicles.csv', null, null, true);
    }

    private function preview(UploadedFile $file)
    {
        return $this->postJson('/api/vehicle-imports', ['file' => $file]);
    }

    #[Test]
    public function a_valid_xlsx_previews_without_inserting_then_imports_on_confirm_and_logs_it(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $res = $this->preview($this->xlsx([$this->row(), $this->row(['Vehicle Name' => 'Ambulance Two', 'Plate Number' => 'ABC 5678'])]))->assertCreated();
        $res->assertJsonPath('total_rows', 2)->assertJsonPath('valid_rows', 2)->assertJsonPath('error_rows', 0);
        $this->assertSame(0, Vehicle::count());

        $id = $res->json('id');
        $this->postJson("/api/vehicle-imports/{$id}/commit")->assertOk()
            ->assertJsonPath('imported_rows', 2)->assertJsonPath('failed_rows', 0)->assertJsonPath('status', 'completed');

        $this->assertSame(2, Vehicle::count());
        $v = Vehicle::where('plate_number', 'ABC 1234')->first();
        $this->assertSame($this->barangayId, $v->barangay_id);
        $this->assertSame('Available', $v->status);
        $this->assertDatabaseHas('vehicle_histories', ['vehicle_id' => $v->vehicle_id, 'activity_type' => 'Vehicle Added']);
        $this->assertSame(1, ActivityLog::where('action', 'Import')->where('module', 'Vehicle Management')->count());
        $this->assertDatabaseHas('vehicle_imports', ['id' => $id, 'user_id' => $this->admin->id, 'file_name' => 'vehicles.xlsx', 'imported_rows' => 2]);

        // A confirmed import can't be replayed.
        $this->postJson("/api/vehicle-imports/{$id}/commit")->assertUnprocessable();
    }

    #[Test]
    public function a_valid_csv_imports_for_a_delegated_custodian(): void
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $id = $this->preview($this->csv([$this->row()]))->assertCreated()->assertJsonPath('valid_rows', 1)->json('id');
        $this->postJson("/api/vehicle-imports/{$id}/commit")->assertOk()->assertJsonPath('imported_rows', 1);
        $this->assertSame(1, Vehicle::count());
    }

    #[Test]
    public function mixed_rows_import_only_the_valid_ones_and_report_row_and_field(): void
    {
        Vehicle::create(['vehicle_name' => 'Old', 'plate_number' => 'OLD 1111', 'category_id' => VehicleCategory::first()->category_id, 'brand' => 'x', 'model' => 'x', 'year_model' => 2020, 'capacity' => '1', 'vehicle_color' => 'x', 'current_location' => 'Main Depot', 'barangay_id' => $this->barangayId]);

        Sanctum::actingAs($this->admin, ['*']);
        $res = $this->preview($this->xlsx([
            $this->row(),                                                             // row 2 valid
            $this->row(['Plate Number' => 'ABC 1234', 'Vehicle Name' => 'Dup']),      // row 3 duplicate plate in file
            $this->row(['Vehicle Name' => '', 'Plate Number' => 'ABC 2222']),         // row 4 missing required
            $this->row(['Plate Number' => 'ABC 3333', 'Vehicle Type' => 'Spaceship']),// row 5 unknown type
            $this->row(['Plate Number' => 'OLD 1111']),                               // row 6 existing DB conflict
            $this->row(['Plate Number' => 'ABC 4444', 'Year Model' => 'abcd']),       // row 7 invalid year
            $this->row(['Plate Number' => 'ABC 5555', 'Capacity' => '=1+1']),         // row 8 formula
        ]))->assertCreated();

        $res->assertJsonPath('total_rows', 7)->assertJsonPath('valid_rows', 1)->assertJsonPath('error_rows', 6);
        $found = collect($res->json('findings'))->map(fn ($f) => "{$f['row']}:{$f['field']}")->all();
        foreach (['3:plate_number', '4:vehicle_name', '5:vehicle_type', '6:plate_number', '7:year_model', '8:capacity'] as $expected) {
            $this->assertContains($expected, $found);
        }

        $this->postJson('/api/vehicle-imports/' . $res->json('id') . '/commit')->assertOk()
            ->assertJsonPath('imported_rows', 1)->assertJsonPath('failed_rows', 6);
        $this->assertSame(2, Vehicle::count()); // seeded + the one valid row
        $this->postJson('/api/vehicle-imports/' . $res->json('id') . '/errors')->assertStatus(405);
        $this->get('/api/vehicle-imports/' . $res->json('id') . '/errors')->assertOk();
    }

    #[Test]
    public function water_vehicles_require_hull_and_engine_like_the_add_form(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $headers = [...self::HEADERS, 'Hull Material', 'Engine Type'];
        $res = $this->preview($this->xlsx([$this->row(['Vehicle Type' => 'Rescue Boat'])], $headers))->assertCreated();
        $res->assertJsonPath('error_rows', 1);
        $fields = collect($res->json('findings'))->pluck('field')->all();
        $this->assertContains('hull_material', $fields);
        $this->assertContains('engine_type', $fields);

        $ok = $this->preview($this->xlsx([$this->row(['Vehicle Type' => 'Rescue Boat', 'Hull Material' => 'fiberglass', 'Engine Type' => 'Outboard'])], $headers))->assertCreated();
        $ok->assertJsonPath('valid_rows', 1);
    }

    #[Test]
    public function maintenance_personnel_cannot_import_or_download_the_template(): void
    {
        Sanctum::actingAs($this->mechanic, ['*']);
        $this->get('/api/vehicle-imports/template')->assertForbidden();
        $this->preview($this->xlsx([$this->row()]))->assertForbidden();
    }

    #[Test]
    public function a_custodian_can_import_even_without_the_legacy_delegation_flag(): void
    {
        // User::canRegisterVehicles() no longer requires the extra
        // can_register_vehicles flag on top of the role — vehicle
        // registration (including bulk import) is now a standard Custodian
        // duty for ANY Custodian account.
        $this->custodian->update(['can_register_vehicles' => false]);
        Sanctum::actingAs($this->custodian, ['*']);
        $this->preview($this->xlsx([$this->row()]))->assertCreated();
    }

    #[Test]
    public function another_barangays_import_cannot_be_confirmed_or_read_and_locations_are_scoped(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $id = $this->preview($this->xlsx([$this->row()]))->assertCreated()->json('id');

        $province = Province::first();
        $city = City::create(['province_id' => $province->id, 'code' => 'OTHC', 'name' => 'Other City']);
        $otherBarangay = Barangay::create(['name' => 'Other Barangay', 'city_id' => $city->id])->id;
        $outsider = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $otherBarangay]);

        Sanctum::actingAs($outsider, ['*']);
        $this->postJson("/api/vehicle-imports/{$id}/commit")->assertNotFound();
        $this->get("/api/vehicle-imports/{$id}/errors")->assertNotFound();

        // The other barangay has no "Main Depot", so the same sheet can't place a vehicle there.
        $this->preview($this->xlsx([$this->row()]))->assertCreated()->assertJsonPath('error_rows', 1);
    }

    #[Test]
    public function empty_malformed_wrong_type_and_oversized_files_are_rejected(): void
    {
        Sanctum::actingAs($this->admin, ['*']);

        $this->preview($this->xlsx([]))->assertUnprocessable();                       // headers only
        $this->preview($this->csv([], ['Foo', 'Bar']))->assertUnprocessable();        // no data/required columns

        $bad = tempnam(sys_get_temp_dir(), 'imp') . '.xlsx';
        file_put_contents($bad, 'this is not a zip at all');
        $this->preview(new UploadedFile($bad, 'broken.xlsx', null, null, true))->assertUnprocessable();

        $php = tempnam(sys_get_temp_dir(), 'imp') . '.php';
        file_put_contents($php, '<?php echo 1;');
        $this->preview(new UploadedFile($php, 'evil.php', null, null, true))->assertUnprocessable();

        // A real zip renamed to .csv, and a text file renamed to .xlsx, both fail the content check.
        $zipAsCsv = $this->xlsx([$this->row()]);
        $this->preview(new UploadedFile($zipAsCsv->getRealPath(), 'sneaky.csv', null, null, true))->assertUnprocessable();

        $big = tempnam(sys_get_temp_dir(), 'imp') . '.csv';
        file_put_contents($big, str_repeat('a', 3 * 1024 * 1024));
        $this->preview(new UploadedFile($big, 'big.csv', null, null, true))->assertUnprocessable();

        $this->assertSame(0, VehicleImport::count());
    }

    #[Test]
    public function the_template_downloads_as_xlsx_and_csv_with_the_expected_headers(): void
    {
        Sanctum::actingAs($this->custodian, ['*']);
        $this->get('/api/vehicle-imports/template?format=xlsx')->assertOk()->assertDownload('vehicle-import-template.xlsx');
        $csv = $this->get('/api/vehicle-imports/template?format=csv');
        $csv->assertOk()->assertDownload('vehicle-import-template.csv');
        $this->assertStringContainsString('Plate Number', $csv->streamedContent());
    }
}
