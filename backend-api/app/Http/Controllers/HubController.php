<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Models\Vehicle;
use App\Models\VehicleHub;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class HubController extends Controller
{
    use AuthorizesAbilities;

    /**
     * GET /hubs — every workspace role needs the hub list to plot/select vehicle locations.
     */
    public function index()
    {
        return response()->json(
            VehicleHub::orderByDesc('is_default')->orderBy('name')->get()
        );
    }

    /**
     * POST /hubs — Admin pins a new custom hub on the fleet map.
     */
    public function store(Request $request)
    {
        $this->requireAbility($request, 'hub.create');

        $barangayId = $request->user()->barangay_id;

        $data = $request->validate([
            'name' => ['required', 'string', 'max:255', Rule::unique('vehicle_hubs', 'name')->where('barangay_id', $barangayId)],
            'lat' => ['required', 'numeric', 'between:-90,90'],
            'lng' => ['required', 'numeric', 'between:-180,180'],
            'label' => ['nullable', 'string', 'max:8'],
        ]);

        $hub = VehicleHub::create([
            'hub_key' => Str::slug($data['name']).'-'.Str::random(6),
            'name' => $data['name'],
            'label' => $data['label'] ?? Str::upper(Str::substr($data['name'], 0, 2)),
            'lat' => $data['lat'],
            'lng' => $data['lng'],
            'match_names' => [Str::lower($data['name'])],
            'is_default' => false,
            'created_by' => $request->user()->id,
        ]);

        return response()->json($hub, 201);
    }

    /**
     * PUT /hubs/{hub} — Admin renames/relocates a hub, or hides/shows a default hub.
     */
    public function update(Request $request, VehicleHub $hub)
    {
        $this->requireAbility($request, 'hub.edit');

        $data = $request->validate([
            'name' => [
                'sometimes', 'string', 'max:255',
                Rule::unique('vehicle_hubs', 'name')->where('barangay_id', $hub->barangay_id)->ignore($hub->hub_id, 'hub_id'),
            ],
            'lat' => ['sometimes', 'numeric', 'between:-90,90'],
            'lng' => ['sometimes', 'numeric', 'between:-180,180'],
            'is_hidden' => ['sometimes', 'boolean'],
        ]);

        $hub->update($data);

        return $hub->fresh();
    }

    /**
     * DELETE /hubs/{hub} — Admin removes a custom hub. Default hubs can only be hidden, not deleted.
     */
    public function destroy(Request $request, VehicleHub $hub)
    {
        $this->requireAbility($request, 'hub.delete');

        abort_if($hub->is_default, 422, 'Default hubs cannot be deleted. Hide it instead.');

        abort_if(
            Vehicle::where('current_location', $hub->name)->exists(),
            422,
            'This hub is still set as one or more vehicles\' current location.'
        );

        $hub->delete();

        return response()->json(['message' => 'Hub removed.']);
    }
}
