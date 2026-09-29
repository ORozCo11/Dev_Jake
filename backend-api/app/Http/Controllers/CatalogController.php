<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Models\FaultCategory;
use App\Models\MaintenanceTicket;
use App\Models\MaintenanceType;
use App\Models\TicketSubIssue;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceRecord;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * CRUD for the two small, user-growable catalogs (fault categories, used
 * as tickets' fault_category / issue reports' issue_type; and maintenance
 * types, used by sub-issues, maintenance records, and schedules) that the
 * CreatableSelect dropdown lets any user add to on the fly.
 *
 * Deliberately its own endpoints instead of deferring the save to whatever
 * form the dropdown happens to be embedded in — the ticket/issue/record
 * that form submits and the catalog entry it references are two separate
 * things, and tying the catalog write to that unrelated submission meant a
 * newly-typed value was silently lost if the user backed out of that form
 * without submitting it.
 */
class CatalogController extends Controller
{
    use AuthorizesAbilities;

    public function faultCategories()
    {
        return FaultCategory::orderBy('name')->get(['id', 'name']);
    }

    public function storeFaultCategory(Request $request)
    {
        $this->requireAbility($request, 'catalog.create');
        $data = $request->validate(['name' => ['required', 'string', 'max:150']]);

        return response()->json(FaultCategory::findOrCreateByName($data['name']), 201);
    }

    /**
     * Fault categories/maintenance types are referenced by NAME (not a
     * foreign key) from several other tables — a rename has to cascade to
     * every one of them, or old records would keep showing the un-fixed
     * typo forever while the catalog itself moved on. This is the entire
     * reason "edit" is a real endpoint and not just a client-side relabel.
     */
    public function updateFaultCategory(Request $request, FaultCategory $faultCategory)
    {
        $this->requireAbility($request, 'catalog.edit');
        $data = $request->validate(['name' => ['required', 'string', 'max:150']]);
        $newName = trim($data['name']);

        $duplicate = FaultCategory::whereRaw('LOWER(name) = ?', [mb_strtolower($newName)])
            ->where('id', '!=', $faultCategory->id)
            ->first();
        abort_if($duplicate, 422, "\"{$newName}\" already exists as a fault category — pick a different name, or delete this one and use that instead.");

        $oldName = $faultCategory->name;

        DB::transaction(function () use ($faultCategory, $newName, $oldName) {
            $faultCategory->update(['name' => $newName]);
            MaintenanceTicket::withoutGlobalScopes()->where('fault_category', $oldName)->update(['fault_category' => $newName]);
            VehicleIssueReport::withoutGlobalScopes()->where('issue_type', $oldName)->update(['issue_type' => $newName]);
        });

        return $faultCategory->fresh();
    }

    public function destroyFaultCategory(Request $request, FaultCategory $faultCategory)
    {
        $this->requireAbility($request, 'catalog.delete');

        $this->abortIfInUse($faultCategory->name, [
            'ticket'       => MaintenanceTicket::withoutGlobalScopes()->where('fault_category', $faultCategory->name)->count(),
            'issue report' => VehicleIssueReport::withoutGlobalScopes()->where('issue_type', $faultCategory->name)->count(),
        ]);

        $faultCategory->delete();

        return response()->noContent();
    }

    public function maintenanceTypes()
    {
        return MaintenanceType::orderBy('name')->get(['id', 'name']);
    }

    public function storeMaintenanceType(Request $request)
    {
        $this->requireAbility($request, 'catalog.create');
        $data = $request->validate(['name' => ['required', 'string', 'max:150']]);

        return response()->json(MaintenanceType::findOrCreateByName($data['name']), 201);
    }

    public function updateMaintenanceType(Request $request, MaintenanceType $maintenanceType)
    {
        $this->requireAbility($request, 'catalog.edit');
        $data = $request->validate(['name' => ['required', 'string', 'max:150']]);
        $newName = trim($data['name']);

        $duplicate = MaintenanceType::whereRaw('LOWER(name) = ?', [mb_strtolower($newName)])
            ->where('id', '!=', $maintenanceType->id)
            ->first();
        abort_if($duplicate, 422, "\"{$newName}\" already exists as a maintenance type — pick a different name, or delete this one and use that instead.");

        $oldName = $maintenanceType->name;

        DB::transaction(function () use ($maintenanceType, $newName, $oldName) {
            $maintenanceType->update(['name' => $newName]);
            TicketSubIssue::withoutGlobalScopes()->where('maintenance_type', $oldName)->update(['maintenance_type' => $newName]);
            VehicleMaintenanceRecord::withoutGlobalScopes()->where('maintenance_type', $oldName)->update(['maintenance_type' => $newName]);
            VehicleMaintenanceSchedule::withoutGlobalScopes()->where('maintenance_type', $oldName)->update(['maintenance_type' => $newName]);
        });

        return $maintenanceType->fresh();
    }

    public function destroyMaintenanceType(Request $request, MaintenanceType $maintenanceType)
    {
        $this->requireAbility($request, 'catalog.delete');

        $this->abortIfInUse($maintenanceType->name, [
            'work order'         => TicketSubIssue::withoutGlobalScopes()->where('maintenance_type', $maintenanceType->name)->count(),
            'maintenance record' => VehicleMaintenanceRecord::withoutGlobalScopes()->where('maintenance_type', $maintenanceType->name)->count(),
            'schedule'           => VehicleMaintenanceSchedule::withoutGlobalScopes()->where('maintenance_type', $maintenanceType->name)->count(),
        ]);

        $maintenanceType->delete();

        return response()->noContent();
    }

    /**
     * Fault categories and maintenance types are global catalogs — referenced
     * by NAME (not FK) from several tables that are otherwise tenant-scoped
     * (see ScopedThroughVehicle). withoutGlobalScopes() bypasses that scoping
     * deliberately: the guard must see usage across every barangay, not just
     * the deleting Admin's own, or it would let them delete a value that's
     * still actively used somewhere they can't see.
     *
     * $countsByLabel maps a human label (e.g. "ticket") to how many rows
     * reference $name under that label. Aborts 422 listing every non-zero
     * one so the Admin knows exactly what's still depending on it.
     */
    private function abortIfInUse(string $name, array $countsByLabel): void
    {
        $parts = [];
        foreach ($countsByLabel as $label => $count) {
            if ($count > 0) {
                $parts[] = $count . ' ' . $label . ($count === 1 ? '' : 's');
            }
        }

        if ($parts) {
            abort(422, "Can't delete \"{$name}\" — it's still used by " . implode(', ', $parts) . '.');
        }
    }
}
