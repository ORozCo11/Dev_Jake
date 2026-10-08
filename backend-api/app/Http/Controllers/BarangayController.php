<?php

namespace App\Http\Controllers;

use App\Models\Barangay;
use Illuminate\Http\Request;

class BarangayController extends Controller
{
    /**
     * Public list for the registration form's barangay dropdown. Scoped to
     * a city — today only Mandaue City has a real barangay list, so the
     * frontend falls back to a free-text field whenever this comes back
     * empty for the selected city.
     */
    public function index(Request $request)
    {
        $request->validate([
            'city_id' => ['required', 'exists:cities,id'],
        ]);

        return Barangay::where('city_id', $request->city_id)
            ->orderBy('name')
            ->get(['id', 'name']);
    }

    /**
     * Barangays with at least one real registered user, scoped to a city —
     * used by the admin Vehicle Location map's boundary selector, which
     * should only offer barangays actual residents have signed up under,
     * not the full seeded address list. Paknaan is always included: it's
     * the system's built-in home barangay (hubs, vehicles, the original
     * map), not something a resident registered into.
     */
    public function registered(Request $request)
    {
        $request->validate([
            'city_id' => ['required', 'exists:cities,id'],
        ]);

        return Barangay::where('city_id', $request->city_id)
            ->where(fn ($query) => $query->where('name', 'Paknaan')->orWhereHas('users'))
            ->with('city:id,name')
            ->orderBy('name')
            ->get(['id', 'name', 'city_id'])
            ->map(fn ($barangay) => [
                'id' => $barangay->id,
                'name' => $barangay->name,
                'city_name' => $barangay->city?->name,
            ]);
    }

    /**
     * Single barangay lookup, boundary geometry included — used by the
     * admin Vehicle Location map's boundary selector. Carries the parent
     * city's name too: several barangay names (e.g. "Banilad", "Basak")
     * are reused by a neighboring city, so the map must label the drawn
     * outline "Banilad, Mandaue City" rather than a bare "Banilad" that a
     * viewer could easily mistake for the same-named barangay next door.
     */
    public function show(Barangay $barangay)
    {
        $barangay->load('city:id,name');

        return $barangay->setVisible(['id', 'name', 'boundary'])->append('city_name');
    }
}
