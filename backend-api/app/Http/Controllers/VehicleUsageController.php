<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Models\ActivityLog;
use App\Models\Vehicle;
use App\Models\VehicleHistory;
use App\Models\VehicleUsageLog;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Vehicle Usage Log — a trip is opened when a vehicle goes out and closed when
 * it comes back. It records usage only; it never changes the vehicle's
 * status (that stays owned by the maintenance/readiness flow).
 */
class VehicleUsageController extends Controller
{
    use AuthorizesAbilities;

    public function index(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'usage.view');

        return $vehicle->hasMany(VehicleUsageLog::class, 'vehicle_id', 'vehicle_id')
            ->with('loggedBy:id,name')
            ->orderByDesc('started_at')
            ->limit(50)
            ->get();
    }

    public function start(Request $request, Vehicle $vehicle)
    {
        $this->requireAbility($request, 'usage.log');
        abort_if(in_array($vehicle->status, ['Inactive', 'Decommissioned'], true), 422, 'This vehicle is archived or decommissioned.');
        abort_unless($vehicle->status === 'Available', 422, "This vehicle is {$vehicle->status} and cannot be taken out right now.");
        abort_if(VehicleUsageLog::where('vehicle_id', $vehicle->vehicle_id)->whereNull('ended_at')->exists(), 422, 'This vehicle already has an open trip. End it first.');

        $data = $request->validate([
            'purpose' => ['required', 'string', 'max:255'],
            'destination' => ['nullable', 'string', 'max:255'],
            'driver_name' => ['nullable', 'string', 'max:255'],
            'started_at' => ['nullable', 'date', 'before_or_equal:now'],
            'odometer_start' => ['nullable', 'integer', 'min:0'],
            'notes' => ['nullable', 'string'],
        ]);

        $log = DB::transaction(function () use ($data, $vehicle, $request) {
            $log = VehicleUsageLog::create($data + ['vehicle_id' => $vehicle->vehicle_id, 'logged_by' => $request->user()->id, 'started_at' => $data['started_at'] ?? now()]);
            $this->record($request, $vehicle, 'Vehicle Taken Out', "{$vehicle->vehicle_name} went out: {$log->purpose}" . ($log->destination ? " → {$log->destination}" : '') . '.', $log);

            return $log;
        });

        return response()->json($log->load('loggedBy:id,name'), 201);
    }

    public function end(Request $request, VehicleUsageLog $log)
    {
        $this->requireAbility($request, 'usage.log');
        abort_if($log->ended_at, 422, 'This trip has already been ended.');

        $data = $request->validate([
            'ended_at' => ['nullable', 'date', 'before_or_equal:now', 'after_or_equal:' . $log->started_at->toDateTimeString()],
            'odometer_end' => ['nullable', 'integer', 'min:' . ($log->odometer_start ?? 0)],
            'notes' => ['nullable', 'string'],
        ]);

        DB::transaction(function () use ($log, $data, $request) {
            $log->update([
                'ended_at' => $data['ended_at'] ?? now(),
                'odometer_end' => $data['odometer_end'] ?? null,
                'notes' => $data['notes'] ?? $log->notes,
            ]);
            $this->record($request, $log->vehicle, 'Vehicle Returned', "{$log->vehicle->vehicle_name} returned from: {$log->purpose}.", $log);
        });

        return $log->fresh()->load('loggedBy:id,name');
    }

    private function record(Request $request, Vehicle $vehicle, string $type, string $description, VehicleUsageLog $log): void
    {
        VehicleHistory::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'activity_type' => $type,
            'description' => $description,
            'related_table' => 'vehicle_usage_logs',
            'related_record_id' => (string) $log->usage_id,
            'updated_by' => $request->user()->id,
        ]);
        ActivityLog::create([
            'user_id' => $request->user()->id,
            'role' => $request->attributes->get('vms_acted_as_role') ?? $request->user()->role,
            'action' => $type === 'Vehicle Taken Out' ? 'Add' : 'Edit',
            'module' => 'Vehicle Usage',
            'affected_record_id' => (string) $log->usage_id,
            'details' => $description,
        ]);
    }
}
