<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Models\ActivityLog;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleHistory;
use App\Models\VehicleHub;
use App\Models\VehicleImport;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Validator;
use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Writer\Csv as CsvWriter;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx as XlsxWriter;

/**
 * "Import Vehicle Data": template -> upload -> preview (validate only) ->
 * confirm -> import valid rows -> summary + Activity Log.
 *
 * Nothing in a spreadsheet is trusted: every row is run through the same rules
 * the Add Vehicle form uses (FleetController::vehicleRules), the barangay is
 * always the importer's own, and the confirm step re-reads and re-validates the
 * stored file rather than accepting rows back from the client.
 */
class VehicleImportController extends Controller
{
    use AuthorizesAbilities;

    private const MAX_BYTES = 2 * 1024 * 1024;
    private const MAX_ROWS = 500;

    // key => [header label, aliases (normalized: lowercase letters/digits only)]
    private const COLUMNS = [
        'vehicle_name'     => ['Vehicle Name', ['vehiclename', 'name']],
        'plate_number'     => ['Plate Number', ['platenumber', 'plate', 'plateno', 'identifier']],
        'vehicle_type'     => ['Vehicle Type', ['vehicletype', 'type', 'category', 'vehiclecategory']],
        'brand'            => ['Brand', ['brand', 'make']],
        'model'            => ['Model', ['model']],
        'year_model'       => ['Year Model', ['yearmodel', 'year', 'modelyear']],
        'capacity'         => ['Capacity', ['capacity']],
        'fuel_type'        => ['Fuel Type', ['fueltype', 'fuel']],
        'vehicle_color'    => ['Vehicle Color', ['vehiclecolor', 'color', 'colour']],
        'current_location' => ['Current Location', ['currentlocation', 'location', 'hub', 'garage']],
        'acquisition_cost' => ['Acquisition Cost', ['acquisitioncost', 'cost', 'price']],
        'hull_material'    => ['Hull Material', ['hullmaterial', 'hull']],
        'engine_type'      => ['Engine Type', ['enginetype', 'engine']],
        'remarks'          => ['Remarks', ['remarks', 'notes']],
    ];

    private const REQUIRED_COLUMNS = ['vehicle_name', 'plate_number', 'vehicle_type', 'brand', 'model', 'year_model', 'capacity', 'fuel_type', 'vehicle_color', 'current_location'];

    private const HULL_MATERIAL_OPTIONS = ['Fiberglass', 'Aluminum', 'Steel', 'Wood', 'Rubber/Inflatable'];

    public function template(Request $request)
    {
        $this->requireAbility($request, 'vehicle.import');
        $format = $request->query('format') === 'csv' ? 'csv' : 'xlsx';

        $sheet = new Spreadsheet();
        $data = $sheet->getActiveSheet()->setTitle('Vehicles');
        $col = 1;
        foreach (self::COLUMNS as $key => [$label]) {
            $data->setCellValue([$col, 1], $label . (in_array($key, self::REQUIRED_COLUMNS, true) ? ' *' : ''));
            $col++;
        }
        $example = ['Rescue Boat 1', 'ABC 1234', VehicleCategory::orderBy('category_name')->value('category_name') ?? 'Ambulance', 'Toyota', 'HiAce', 2022, '10 persons', 'Diesel', 'White', VehicleHub::orderBy('name')->value('name') ?? 'Main Depot', 1500000, '', '', 'Sample row - delete me'];
        foreach ($example as $i => $value) {
            $data->setCellValueExplicit([$i + 1, 2], (string) $value, \PhpOffice\PhpSpreadsheet\Cell\DataType::TYPE_STRING);
        }

        $guide = $sheet->createSheet()->setTitle('Instructions');
        $guide->fromArray([
            ['Columns marked * are required. Delete the sample row before uploading.'],
            ['Hull Material and Engine Type are required for Water vehicles only.'],
            [''],
            ['Valid Vehicle Types'],
            ...VehicleCategory::orderBy('category_name')->pluck('category_name')->map(fn ($n) => [$n])->all(),
            [''],
            ['Valid Current Locations'],
            ...VehicleHub::orderBy('name')->pluck('name')->map(fn ($n) => [$n])->all(),
            [''],
            ['Valid Hull Materials'],
            ...array_map(fn ($n) => [$n], self::HULL_MATERIAL_OPTIONS),
        ]);
        $guide->getColumnDimension('A')->setWidth(70);

        if ($format === 'csv') {
            $sheet->setActiveSheetIndex(0);
            $writer = new CsvWriter($sheet);
            $writer->setSheetIndex(0);
        } else {
            $writer = new XlsxWriter($sheet);
        }

        return response()->streamDownload(fn () => $writer->save('php://output'), "vehicle-import-template.{$format}", [
            'Content-Type' => $format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ]);
    }

    public function preview(Request $request)
    {
        $this->requireAbility($request, 'vehicle.import');
        $this->requireDelegation($request);

        $request->validate(['file' => ['required', 'file', 'max:' . (self::MAX_BYTES / 1024)]]);
        $file = $request->file('file');

        // Extension AND content must agree — a renamed file or a spoofed
        // Content-Type header is rejected here, not just by the browser.
        $ext = strtolower($file->getClientOriginalExtension());
        abort_unless(in_array($ext, ['xlsx', 'csv'], true), 422, 'Only .xlsx or .csv files can be imported.');
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($file->getRealPath());
        $zipMimes = ['application/zip', 'application/x-zip-compressed', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
        $textMimes = ['text/plain', 'text/csv', 'application/csv', 'application/vnd.ms-excel', 'inode/x-empty'];
        abort_unless(in_array($mime, $ext === 'xlsx' ? $zipMimes : $textMimes, true), 422, 'The file contents do not match a valid .' . $ext . ' spreadsheet.');

        try {
            $rows = $this->readRows($file->getRealPath(), $ext);
        } catch (\Throwable $e) {
            abort(422, 'The spreadsheet could not be read. Make sure it is a valid, uncorrupted .xlsx or .csv file.');
        }

        abort_if(count($rows) < 2, 422, 'The spreadsheet has no data rows.');
        abort_if(count($rows) - 1 > self::MAX_ROWS, 422, 'Too many rows — import at most ' . self::MAX_ROWS . ' vehicles at a time.');

        $analysis = $this->analyze($rows, $request->user());
        if ($analysis['missing_columns']) {
            abort(422, 'Missing required column(s): ' . implode(', ', $analysis['missing_columns']) . '. Download the template for the expected headers.');
        }

        $path = $file->storeAs('vehicle-imports', bin2hex(random_bytes(16)) . '.' . $ext, 'local');

        $import = VehicleImport::create([
            'user_id' => $request->user()->id,
            'barangay_id' => $request->user()->barangay_id,
            'file_name' => mb_substr($file->getClientOriginalName(), 0, 255),
            'stored_path' => $path,
            'status' => 'previewed',
            'total_rows' => $analysis['total'],
            'valid_rows' => $analysis['valid'],
            'error_rows' => $analysis['errors'],
            'warning_rows' => $analysis['warnings'],
            'findings' => $analysis['findings'],
        ]);

        return response()->json($this->summary($import) + ['ignored_columns' => $analysis['ignored_columns']], 201);
    }

    public function commit(Request $request, VehicleImport $import)
    {
        $this->requireAbility($request, 'vehicle.import');
        $this->requireDelegation($request);
        $this->authorizeImport($request, $import);
        abort_unless($import->status === 'previewed', 422, 'This import has already been processed.');

        $ext = pathinfo($import->stored_path, PATHINFO_EXTENSION);
        abort_unless(Storage::disk('local')->exists($import->stored_path), 410, 'The uploaded file is no longer available. Upload it again.');

        // Re-read and re-validate from the stored file: the client only names
        // which preview to confirm, never what rows to insert.
        $rows = $this->readRows(Storage::disk('local')->path($import->stored_path), $ext);
        $analysis = $this->analyze($rows, $request->user());

        $imported = 0;
        $failed = $analysis['errors'];
        DB::transaction(function () use ($analysis, $request, &$imported) {
            foreach ($analysis['valid_data'] as $rowNo => $data) {
                $vehicle = Vehicle::create($data + ['status' => 'Available', 'condition' => 'Good']);
                VehicleHistory::create([
                    'vehicle_id' => $vehicle->vehicle_id,
                    'activity_type' => 'Vehicle Added',
                    'description' => "{$vehicle->vehicle_name} was added to the system (spreadsheet import).",
                    'related_table' => 'vehicles',
                    'related_record_id' => (string) $vehicle->vehicle_id,
                    'updated_by' => $request->user()->id,
                ]);
                $imported++;
            }
        });

        $import->update([
            'status' => 'completed',
            'total_rows' => $analysis['total'],
            'valid_rows' => $analysis['valid'],
            'error_rows' => $analysis['errors'],
            'warning_rows' => $analysis['warnings'],
            'imported_rows' => $imported,
            'failed_rows' => $failed,
            'findings' => $analysis['findings'],
            'completed_at' => now(),
        ]);
        Storage::disk('local')->delete($import->stored_path);
        $import->update(['stored_path' => null]);

        ActivityLog::create([
            'user_id' => $request->user()->id,
            'role' => $request->attributes->get('vms_acted_as_role') ?? $request->user()->role,
            'action' => 'Import',
            'module' => 'Vehicle Management',
            'affected_record_id' => (string) $import->id,
            'details' => "Imported vehicles from {$import->file_name}: {$imported} added, {$failed} skipped of {$analysis['total']} rows ({$analysis['warnings']} with warnings).",
        ]);

        return response()->json($this->summary($import->fresh()));
    }

    public function errorReport(Request $request, VehicleImport $import)
    {
        $this->requireAbility($request, 'vehicle.import');
        $this->authorizeImport($request, $import);

        $findings = $import->findings ?? [];

        return response()->streamDownload(function () use ($findings) {
            $out = fopen('php://output', 'w');
            fputcsv($out, ['Row', 'Field', 'Level', 'Message']);
            foreach ($findings as $f) {
                // Cells beginning with = + - @ are prefixed so the report can't run as a formula.
                $msg = preg_match('/^[=+\-@]/', $f['message']) ? "'" . $f['message'] : $f['message'];
                fputcsv($out, [$f['row'], $f['field'], $f['level'], $msg]);
            }
            fclose($out);
        }, "vehicle-import-{$import->id}-report.csv", ['Content-Type' => 'text/csv']);
    }

    // ------------------------------------------------------------------

    private function requireDelegation(Request $request): void
    {
        abort_unless($request->user()->canRegisterVehicles(), 403, 'Vehicle registration has not been delegated to your account. Ask your Admin to enable it.');
    }

    private function authorizeImport(Request $request, VehicleImport $import): void
    {
        abort_unless(
            $import->user_id === $request->user()->id && $import->barangay_id === $request->user()->barangay_id,
            404
        );
    }

    private function summary(VehicleImport $import): array
    {
        return [
            'id' => $import->id,
            'file_name' => $import->file_name,
            'status' => $import->status,
            'total_rows' => $import->total_rows,
            'valid_rows' => $import->valid_rows,
            'error_rows' => $import->error_rows,
            'warning_rows' => $import->warning_rows,
            'imported_rows' => $import->imported_rows,
            'failed_rows' => $import->failed_rows,
            'findings' => $import->findings ?? [],
        ];
    }

    private function readRows(string $path, string $ext): array
    {
        $reader = IOFactory::createReader($ext === 'csv' ? 'Csv' : 'Xlsx');
        $reader->setReadDataOnly(true);
        $sheet = $reader->load($path)->getSheet(0);

        // calculateFormulas=false: formulas arrive as "=..." text we reject below.
        return $sheet->toArray(null, false, false, false);
    }

    private function cell(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (is_float($value) && floor($value) === $value && abs($value) < 1e15) {
            $value = (int) $value;
        }
        $value = trim((string) $value);

        return $value === '' ? null : $value;
    }

    /**
     * Maps headers, validates every row, and returns counts + findings. Used
     * by both preview and commit so the two can never disagree.
     */
    private function analyze(array $rows, $user): array
    {
        $originalHeaders = $rows[0];
        $headers = array_map(fn ($h) => preg_replace('/[^a-z0-9]/', '', strtolower((string) preg_replace('/\*$/', '', trim((string) $h)))), array_shift($rows));

        $map = [];
        $ignored = [];
        foreach ($headers as $i => $h) {
            $key = null;
            foreach (self::COLUMNS as $k => [, $aliases]) {
                if (in_array($h, $aliases, true) && !isset($map[$k])) {
                    $key = $k;
                    break;
                }
            }
            if ($key) {
                $map[$key] = $i;
            } elseif ($h !== '') {
                $ignored[] = trim((string) $originalHeaders[$i]);
            }
        }
        $missing = array_map(fn ($k) => self::COLUMNS[$k][0], array_values(array_diff(self::REQUIRED_COLUMNS, array_keys($map))));

        $categories = VehicleCategory::all()->keyBy(fn ($c) => mb_strtolower(trim($c->category_name)));
        $hubs = VehicleHub::pluck('name')->keyBy(fn ($n) => mb_strtolower(trim($n)));
        $fleet = app(FleetController::class);

        $findings = [];
        $validData = [];
        $seenPlates = [];
        $errorRows = 0;
        $warningRows = 0;
        $total = 0;

        foreach ($rows as $idx => $raw) {
            $rowNo = $idx + 2; // spreadsheet row number (header is row 1)
            $values = [];
            foreach ($map as $key => $col) {
                $values[$key] = $this->cell($raw[$col] ?? null);
            }
            if (!array_filter($values, fn ($v) => $v !== null)) {
                continue; // fully blank row
            }
            $total++;
            $rowErrors = [];
            $rowWarnings = [];

            foreach ($values as $key => $v) {
                if ($v !== null && $v[0] === '=') {
                    $rowErrors[] = [$key, 'Formulas are not allowed — enter the plain value.'];
                    $values[$key] = null;
                }
            }

            $category = isset($values['vehicle_type']) ? $categories->get(mb_strtolower($values['vehicle_type'])) : null;
            if (($values['vehicle_type'] ?? null) !== null && !$category) {
                $rowErrors[] = ['vehicle_type', "Unknown Vehicle Type \"{$values['vehicle_type']}\"."];
            }
            if (isset($values['current_location'], $hubs[mb_strtolower($values['current_location'])])) {
                $values['current_location'] = $hubs[mb_strtolower($values['current_location'])];
            }
            if (isset($values['hull_material'])) {
                foreach (self::HULL_MATERIAL_OPTIONS as $opt) {
                    if (strcasecmp($opt, $values['hull_material']) === 0) {
                        $values['hull_material'] = $opt;
                    }
                }
            }

            $data = $values;
            unset($data['vehicle_type']);
            $data['category_id'] = $category?->category_id;

            $validator = Validator::make($data, $fleet->vehicleRules($category?->domain ?? 'Land'), $fleet->vehicleRuleMessages());
            foreach ($validator->errors()->messages() as $field => $messages) {
                if ($field === 'category_id') {
                    if ($category) {
                        $rowErrors[] = ['vehicle_type', $messages[0]];
                    } elseif (($values['vehicle_type'] ?? null) === null) {
                        $rowErrors[] = ['vehicle_type', 'Vehicle Type is required.'];
                    }
                    continue;
                }
                $rowErrors[] = [$field, $messages[0]];
            }

            if (!empty($values['plate_number'])) {
                $plateKey = preg_replace('/[\s-]/', '', mb_strtolower($values['plate_number']));
                if (isset($seenPlates[$plateKey])) {
                    $rowErrors[] = ['plate_number', "Duplicate plate number — also used on row {$seenPlates[$plateKey]}."];
                } else {
                    $seenPlates[$plateKey] = $rowNo;
                }
            }

            if (!$rowErrors && !empty($values['vehicle_name']) && Vehicle::where('vehicle_name', $values['vehicle_name'])
                ->where('brand', $values['brand'])->where('model', $values['model'])->where('year_model', $values['year_model'])->exists()) {
                $rowWarnings[] = ['vehicle_name', 'A vehicle with the same name, brand, model and year already exists.'];
            }
            if (!empty($values['hull_material']) && ($category?->domain ?? 'Land') !== 'Water') {
                $rowWarnings[] = ['hull_material', 'Hull Material only applies to Water vehicles.'];
            }

            foreach ($rowErrors as [$field, $message]) {
                $findings[] = ['row' => $rowNo, 'field' => $field, 'level' => 'error', 'message' => $message];
            }
            foreach ($rowWarnings as [$field, $message]) {
                $findings[] = ['row' => $rowNo, 'field' => $field, 'level' => 'warning', 'message' => $message];
            }
            if ($rowErrors) {
                $errorRows++;
            } else {
                $validData[$rowNo] = $validator->validated();
                if ($rowWarnings) {
                    $warningRows++;
                }
            }
        }

        abort_if($total === 0, 422, 'The spreadsheet has no data rows.');

        return [
            'total' => $total,
            'valid' => $total - $errorRows,
            'errors' => $errorRows,
            'warnings' => $warningRows,
            'findings' => $findings,
            'valid_data' => $validData,
            'missing_columns' => $missing,
            'ignored_columns' => $ignored,
        ];
    }
}
