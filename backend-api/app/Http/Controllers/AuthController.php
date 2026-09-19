<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Http\Controllers\Concerns\UploadsImages;
use App\Models\ActivityLog;
use App\Models\Barangay;
use App\Models\RegistrationSetting;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;

class AuthController extends Controller
{
    use UploadsImages;

    /**
     * Whether this city has a real barangay list to pick from. Cities whose
     * barangays have been imported (`boundaries:import`) require a selection;
     * only a city with nothing on file still accepts a free-typed name.
     */
    private function cityHasBarangays($cityId): bool
    {
        return $cityId && Barangay::where('city_id', $cityId)->exists();
    }

    /**
     * Public self-registration. Residents/staff sign up naming their own
     * barangay, but the account is created inactive — an Admin must approve
     * (activate) it via the existing Users management screen before it can
     * log in, the same gate `login()` already enforces for any deactivated
     * account.
     *
     * Barangays are independent tenants (see BelongsToBarangay/
     * ScopedThroughVehicle) — every barangay gets its own bootstrap, not
     * just the very first account system-wide:
     * - The first account to register under a GIVEN barangay becomes that
     *   barangay's Admin immediately, active, no approval needed — there's
     *   nobody else there yet who could review them. This can happen once
     *   per barangay, whenever it happens to get its first registrant.
     * - Everyone registering under a barangay — first person included —
     *   must supply THAT barangay's own Staff Registration Code. Without
     *   this, anyone could just claim to be "first" for a real barangay
     *   whose Admin seat happens to still be empty and become its Admin
     *   uncontested. The code for every real, pre-seeded barangay is
     *   generated ahead of time (see BarangaySeeder) and handed to that
     *   barangay's office outside the app, so only someone who actually
     *   went through that office can ever complete this step.
     */
    public function register(Request $request)
    {
        $data = $request->validate([
            // Letters, spaces, and the punctuation that legitimately shows up
            // in PH names (hyphenated surnames, "Ñ", apostrophes, "Jr.").
            'name' => ['required', 'string', 'max:255', 'regex:/^[A-Za-zÀ-ÖØ-öø-ÿ.\'\- ]+$/u'],
            'email' => ['required', 'email', 'unique:users,email'],
            'password' => ['required', 'string', 'min:8', 'confirmed'],
            // PH mobile format: 09 + 9 digits = 11 digits total.
            'phone' => ['required', 'regex:/^09[0-9]{9}$/'],
            'address' => ['required', 'string', 'max:255'],
            'city_id' => ['required', 'exists:cities,id'],
            'barangay_id' => [
                'nullable',
                Rule::requiredIf(fn () => $this->cityHasBarangays($request->input('city_id'))),
                'exists:barangays,id',
                function ($attribute, $value, $fail) use ($request) {
                    if ($value && (int) Barangay::find($value)?->city_id !== (int) $request->input('city_id')) {
                        $fail('Selected barangay does not belong to the selected city.');
                    }
                },
            ],
            // A city whose barangays have been imported must be picked from
            // the list. Free text is *prohibited* rather than merely ignored
            // there, so a client skipping the dropdown can't mint duplicate,
            // code-less barangays alongside the real ones. It stays available
            // only as the fallback for a city with no list yet.
            'barangay_name' => [
                'nullable',
                $this->cityHasBarangays($request->input('city_id')) ? 'prohibited' : 'required_without:barangay_id',
                'string',
                'max:255',
            ],
        ], [
            'name.regex' => 'Name may only contain letters.',
            'phone.regex' => 'Phone number must be 11 digits starting with 09 (e.g. 09171234567).',
        ]);

        $barangayId = $data['barangay_id'] ?? null;

        // Everything from here on runs inside a transaction that locks the
        // Barangay row: without it, two people registering for the same
        // brand-new barangay within the same instant could both read "no
        // admin yet" (a plain SELECT, not itself a lock) and both get
        // created as that barangay's Admin. lockForUpdate() serializes any
        // concurrent registration for the SAME barangay behind this one —
        // registrations for a DIFFERENT barangay lock a different row and
        // proceed independently.
        [$user, $isFirstForBarangay] = DB::transaction(function () use ($data, $barangayId, $request) {
            // No barangay picked from a dropdown (the city has no seeded
            // list yet) — turn the free-typed name into a real Barangay
            // row, scoped to this city. Resolved INSIDE the transaction
            // (not before it) so that if registration fails later in this
            // same closure (e.g. a bad staff code), the row creation rolls
            // back with everything else instead of leaving an orphaned
            // Barangay nobody ever actually registered under.
            $barangayId = $barangayId ?: (!empty($data['barangay_name'])
                ? Barangay::fallbackForCity((int) $data['city_id'], $data['barangay_name'])->id
                : null);

            Barangay::where('id', $barangayId)->lockForUpdate()->first();

            // Deliberately unscoped (User carries no global scope) and looks
            // across every barangay — this is the one place that's supposed to.
            $isFirstForBarangay = !User::where('barangay_id', $barangayId)->exists();

            $roleData = $request->validate([
                // The first-for-this-barangay account has no role choice (it's
                // always Admin) — but still has to prove they're actually from
                // this barangay, same as anyone else. Otherwise a stranger
                // could just claim to be "first" for a real barangay whose
                // Admin seat is simply still empty and grab it uncontested.
                'requested_role' => [$isFirstForBarangay ? 'nullable' : 'required', Rule::in(['Custodian', 'Maintenance Personnel'])],
                'staff_code' => ['required', 'string'],
            ], [
                'requested_role.required' => 'Please select whether you are a Custodian or Maintenance Personnel.',
                'staff_code.required' => 'Please enter the staff registration code given to you by your barangay office.',
            ]);

            abort_unless(
                hash_equals(RegistrationSetting::for($barangayId)->staff_code, strtoupper(trim($roleData['staff_code']))),
                422,
                'That staff registration code is not correct. Ask your barangay office for the current code.'
            );

            $role = $isFirstForBarangay ? 'Admin' : $roleData['requested_role'];

            $user = User::create([
                'name' => $data['name'],
                'email' => $data['email'],
                'password' => Hash::make($data['password']),
                'phone' => $data['phone'],
                'address' => $data['address'],
                'city_id' => $data['city_id'],
                'barangay_id' => $barangayId,
                'barangay_name' => $data['barangay_name'] ?? null,
                'role' => $role,
                'roles' => [$role],
                'is_active' => $isFirstForBarangay,
                'approved_at' => $isFirstForBarangay ? now() : null,
            ]);

            return [$user, $isFirstForBarangay];
        });

        return response()->json([
            'message' => $isFirstForBarangay
                ? 'Admin account created for your barangay. You can sign in now.'
                : 'Registration submitted. An administrator must approve your account before you can sign in.',
            'user' => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
            ],
        ], 201);
    }

    /**
     * Public, side-effect-free preview for the Register form: "if I submit
     * with this barangay, will I become its first Admin?" Lets the
     * frontend show that up front instead of only after submitting.
     * Never creates anything — a free-typed barangay that doesn't exist
     * yet is trivially "first" without touching the database.
     */
    public function registrationStatus(Request $request)
    {
        $data = $request->validate([
            'city_id' => ['required', 'exists:cities,id'],
            'barangay_id' => ['nullable', 'exists:barangays,id'],
            'barangay_name' => ['nullable', 'string', 'max:255'],
        ]);

        $barangayId = $data['barangay_id'] ?? null;

        if (!$barangayId && !empty($data['barangay_name'])) {
            $barangayId = Barangay::where('city_id', $data['city_id'])
                ->whereRaw('LOWER(name) = ?', [strtolower(trim($data['barangay_name']))])
                ->value('id');
        }

        $isFirst = !$barangayId || !User::where('barangay_id', $barangayId)->exists();

        return response()->json(['is_first' => $isFirst]);
    }

    /**
     * Handle stateless frontend login requests.
     */
    public function login(Request $request)
    {
        // 1. Validate incoming user inputs from React
        $request->validate([
            'email' => 'required|email',
            'password' => 'required|string',
        ]);

        // 2. Locate the user profile row in the database
        $user = User::where('email', $request->email)->first();

        // 3. Verify the record exists and evaluate the encrypted password match
        if (!$user || !Hash::check($request->password, $user->password)) {
            return response()->json([
                'message' => 'Invalid credentials provided. Please check your email or password.'
            ], 401); // Returns 401 Unauthorized status code
        }

        if (!$user->is_active) {
            // approved_at is only ever set the moment an Admin first approves
            // an account (UserController::activate) — a still-NULL value
            // means this account has never been approved yet at all (a
            // brand-new registrant waiting in the queue), which reads very
            // differently from an account an Admin actively deactivated
            // after it was already in use.
            $message = $user->approved_at === null
                ? 'Your account is still awaiting approval from your barangay\'s Admin.'
                : 'This account has been deactivated. Contact an administrator.';

            return response()->json(['message' => $message], 403);
        }

        // 4. Issue a secure, unique Sanctum token, tagged with every role
        //    (hat) the account may wear so token abilities match its access.
        $token = $user->createToken('auth_token', $user->allRoles())->plainTextToken;

        // 5. Send data bundle back to the React client application
        return response()->json([
            'message' => 'Login authenticated successfully!',
            'access_token' => $token,
            'token_type' => 'Bearer',
            'user' => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'role' => $user->role, // Primary role — drives the portal layout
                'roles' => $user->allRoles(), // Every hat this account may wear
            ]
        ], 200);
    }

    /**
     * DEV-ONLY for an Admin: returns 404 outside local/testing, so an
     * ordinary barangay Admin's shortcut never exists in a deployed app.
     * A Super Admin is exempt — production impersonation, for real account
     * support/recovery, is exactly what that role is for; every use is
     * still logged (see impersonate() below).
     */
    private function assertImpersonationEnabled(Request $request): void
    {
        if ($request->user()?->hasRole('Super Admin')) {
            return;
        }
        abort_unless(app()->environment(['local', 'testing']), 404);
    }

    /**
     * True for the real Admin/Super Admin who kicked off impersonation, AND
     * for every account they've since jumped into — the 'impersonated'
     * ability travels with the token so switching accounts (or back to
     * yourself) mid-session doesn't require logging out. A genuine
     * Custodian's normal login token never carries this ability, since it's
     * only ever added by impersonate() below, which itself requires the
     * caller to already pass this same check — a real Custodian has no way
     * to obtain it.
     */
    private function canImpersonate(Request $request): bool
    {
        return $request->user()?->hasRole('Admin')
            || $request->user()?->hasRole('Super Admin')
            || (bool) $request->user()?->currentAccessToken()?->can('impersonated');
    }

    /**
     * List accounts an authenticated user can jump into. For an Admin this
     * is DEV-ONLY (see assertImpersonationEnabled); for a Super Admin it
     * works in production too — that's the real account-recovery path.
     *
     * Deliberately spans every barangay, not just the caller's own — an
     * Admin's use of this is dev-only and never exists in production, so
     * the usual "don't leak other tenants' data" concern doesn't apply to
     * them; a Super Admin is explicitly meant to see across every barangay.
     * The frontend groups the result by province/barangay so the caller can
     * jump to any staff account in any barangay.
     */
    public function impersonationCandidates(Request $request)
    {
        $this->assertImpersonationEnabled($request);
        abort_unless($this->canImpersonate($request), 403, 'Only an Admin or Super Admin can impersonate another account.');

        return User::with('barangay.city.province')
            ->orderBy('name')
            ->get(['id', 'name', 'email', 'role', 'roles', 'is_active', 'barangay_id'])
            ->map(fn ($u) => [
                'id' => $u->id,
                'name' => $u->name,
                'email' => $u->email,
                'role' => $u->role,
                'roles' => $u->roles,
                'is_active' => $u->is_active,
                'barangay_id' => $u->barangay_id,
                'province_id' => $u->barangay?->city?->province?->id,
                'province_name' => $u->barangay?->city?->province?->name,
                'city_name' => $u->barangay?->city?->name,
                'barangay_name' => $u->barangay?->name,
            ]);
    }

    /**
     * Issue a token for another account so the caller can switch roles
     * without logging out and back in. For an Admin: DEV-ONLY, guarded by
     * environment (404 in production), the canImpersonate check, AND, on
     * the client, by import.meta.env.DEV — all three must hold. For a
     * Super Admin: works in production too, for real account support —
     * every use is logged below.
     */
    public function impersonate(Request $request, User $user)
    {
        $this->assertImpersonationEnabled($request);
        abort_unless($this->canImpersonate($request), 403, 'Only an Admin or Super Admin can impersonate another account.');
        // Server-side guard, independent of the frontend candidate list
        // (which already filters role !== 'Super Admin' out of what it
        // shows): nobody — not even another Super Admin — may impersonate a
        // Super Admin account via a direct API call. Checked before the
        // is_active gate so the rejection reason is unambiguous either way.
        abort_if($user->hasRole('Super Admin'), 403, 'Super Admin accounts cannot be impersonated.');
        // Deliberately allowed to cross barangays — see impersonationCandidates
        // above.
        abort_if(!$user->is_active, 422, 'That account is deactivated.');

        // Impersonation is a brief, deliberate admin action, not a persistent
        // login — give it a short explicit expiry regardless of the global
        // Sanctum 'expiration' setting (config/sanctum.php), which governs
        // ordinary login tokens instead.
        $token = $user->createToken('impersonation_token', [...$user->allRoles(), 'impersonated'], now()->addHours(4))->plainTextToken;

        $actingAsSuperAdmin = $request->user()?->hasRole('Super Admin');
        ActivityLog::create([
            'user_id' => $request->user()?->id,
            'role'    => $request->user()?->role,
            'action'  => 'Impersonate',
            'module'  => $actingAsSuperAdmin ? 'Super Admin' : 'Dev Tools',
            'details' => ($request->user()?->name ?? 'Someone') . " impersonated {$user->name}"
                . ($actingAsSuperAdmin ? '.' : ' (dev only).'),
        ]);

        return response()->json([
            'access_token' => $token,
            'token_type'   => 'Bearer',
            'user' => [
                'id'    => $user->id,
                'name'  => $user->name,
                'email' => $user->email,
                'role'  => $user->role,
                'roles' => $user->allRoles(),
            ],
        ]);
    }

    /**
     * Terminate active sessions and revoke active tokens.
     */
    public function logout(Request $request)
    {
        // Revoke the exact token string utilized to authenticate the active API request
        $request->user()->currentAccessToken()->delete();

        return response()->json([
            'message' => 'Session terminated and token revoked successfully.'
        ], 200);
    }

    /**
     * Return a time-aware greeting for the authenticated workspace user.
     */
    public function greeting(Request $request)
    {
        $user = $request->user();
        $timezone = 'Asia/Manila';
        $now = now($timezone);
        $hour = (int) $now->format('G');
        $displayName = strtoupper(strtok(trim($user->name), ' ') ?: $user->name);

        $period = match (true) {
            $hour >= 5 && $hour < 12 => 'morning',
            $hour === 12 => 'noon',
            $hour >= 13 && $hour < 15 => 'afternoon',
            $hour >= 15 && $hour < 18 => 'late_afternoon',
            $hour >= 18 && $hour < 22 => 'evening',
            default => 'night',
        };

        $messages = [
            'morning' => [
                "Rise and shine, {$displayName}!",
                "A bright morning to you, {$displayName}!",
                "Fresh start, {$displayName}! Let's keep the fleet moving.",
                "Morning momentum is here, {$displayName}!",
            ],
            'noon' => [
                "Happy noon, {$displayName}!",
                "Midday check-in, {$displayName}! The fleet is ready.",
                "It's noon, {$displayName}! Keep the day rolling.",
                "A steady noon to you, {$displayName}!",
            ],
            'afternoon' => [
                "A pleasant afternoon, {$displayName}!",
                "Good energy this afternoon, {$displayName}!",
                "Afternoon focus is on, {$displayName}!",
                "Keep the dashboard sharp this afternoon, {$displayName}!",
            ],
            'late_afternoon' => [
                "It's late afternoon, {$displayName}!",
                "Late afternoon focus, {$displayName}!",
                "A strong late afternoon to you, {$displayName}!",
                "The day is still moving, {$displayName}!",
            ],
            'evening' => [
                "A calm evening to you, {$displayName}!",
                "Evening check-in, {$displayName}! The fleet is in view.",
                "Good evening, {$displayName}! Keep things steady.",
                "The evening shift is looking sharp, {$displayName}!",
            ],
            'night' => [
                "Working late, {$displayName}? The dashboard is ready.",
                "Quiet night watch, {$displayName}!",
                "Late-night focus, {$displayName}!",
                "The fleet rests easier with you here, {$displayName}!",
            ],
        ];

        $roleLabel = match ($user->role) {
            'Admin' => 'Administrator',
            'Maintenance Personnel' => 'Maintenance',
            default => $user->role,
        };

        $periodMessages = $messages[$period];
        $greeting = $periodMessages[random_int(0, count($periodMessages) - 1)];

        return response()->json([
            'greeting' => $greeting,
            'period' => $period,
            'role_label' => $roleLabel,
            'timezone' => $timezone,
            'generated_at' => $now->toIso8601String(),
            'user' => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'role' => $user->role,
            ],
        ]);
    }

    /**
     * Self-service edit of the authenticated user's own contact details —
     * the same fields an Admin can edit for someone else via
     * UserController::update, minus role and password (role is
     * Admin-reviewed only; password stays on its own old-password-verified
     * endpoint above).
     */
    public function updateProfile(Request $request)
    {
        $user = $request->user();

        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:255'],
            'email' => ['sometimes', 'required', 'email', Rule::unique('users', 'email')->ignore($user->id)],
            'phone' => ['nullable', 'string', 'max:30'],
            'address' => ['nullable', 'string', 'max:255'],
            'photo' => ['nullable', 'image', 'max:4096'],
        ]);

        if ($request->hasFile('photo')) {
            $data['photo_url'] = $this->storeUploadedImage($request->file('photo'), 'profile-photos');
        }
        unset($data['photo']);

        $user->update($data);

        ActivityLog::create([
            'user_id' => $user->id,
            'role' => $user->role,
            'action' => 'Edit',
            'module' => 'Profile',
            'affected_record_id' => (string) $user->id,
            'details' => "{$user->name} updated their profile details.",
        ]);

        return $user->fresh();
    }

    /**
     * Update the authenticated user's security password.
     */
    public function updatePassword(Request $request)
    {
        $data = $request->validate([
            'old_password' => ['required', 'string'],
            'new_password' => ['required', 'string', 'min:8', 'confirmed'],
        ]);

        if (! Hash::check($data['old_password'], $request->user()->password)) {
            return response()->json([
                'message' => 'The old password you entered is incorrect.',
            ], 422);
        }

        $request->user()->update([
            'password' => Hash::make($data['new_password']),
        ]);

        ActivityLog::create([
            'user_id' => $request->user()->id,
            'role' => $request->user()->role,
            'action' => 'Edit',
            'module' => 'Profile',
            'affected_record_id' => (string) $request->user()->id,
            'details' => "{$request->user()->name} updated account security credentials.",
        ]);

        return response()->json([
            'message' => 'Password updated successfully.',
        ]);
    }
}
