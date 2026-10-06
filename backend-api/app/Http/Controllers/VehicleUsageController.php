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
 * Vehicle Usage — a recorded checkout, not dispatch tracking. "Take Out" opens
 * a record, "Mark Returned" closes it. Usage is its own indicator (At Base /
 * Currently Out) and never changes the vehicle's fleet status. A vehicle can
 * only be taken out while it is Available AND verified Ready (a fresh passing
 * readiness check) — a deferred or repaired vehicle is not ready until a
 * Custodian has checked it.
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
        abort_if(VehicleUsageLog::where('vehicle_id', $vehicle->vehicle_id)->whereNull('ended_at')->exists(), 422, 'This vehicle is already out. Mark it returned first.');

        $latest = $vehicle->readinessChecks()->orderByDesc('checked_at')->first();
        $state = app(FleetController::class)->responseReadinessState($vehicle, $latest);
        abort_unless($state === 'ready', 422, 'This vehicle is not verified ready. Run a readiness check first.');

        $data = $request->validate([
            'purpose' => ['required', 'string', 'max:255'],
            'destination' => ['nullable', 'string', 'max:255'],
            'driver_name' => ['nullable', 'string', 'max:255'],
            'notes' => ['nullable', 'string'],
        ]);

        $log = DB::transaction(function () use ($data, $vehicle, $request) {
            $log = VehicleUsageLog::create($data + ['vehicle_id' => $vehicle->vehicle_id, 'logged_by' => $request->user()->id, 'started_at' => now()]);
            $this->record($request, $vehicle, 'Vehicle Taken Out', "{$vehicle->vehicle_name} went out: {$log->purpose}" . ($log->destination ? " → {$log->destination}" : '') . '.', $log);

            return $log;
        });

        return response()->json($log->load('loggedBy:id,name'), 201);
    }

    public function end(Request $request, VehicleUsageLog $log)
    {
        $this->requireAbility($request, 'usage.log');
        abort_if($log->ended_at, 422, 'This trip has already been ended.');

        $data = $request->validate(['notes' => ['nullable', 'string']]);

        DB::transaction(function () use ($log, $data, $request) {
            $log->update(['ended_at' => now(), 'notes' => $data['notes'] ?? $log->notes]);
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