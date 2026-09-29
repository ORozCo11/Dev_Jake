<?php

namespace App\Models;

use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Database\Eloquent\Factories\HasFactory;

// CHANGE THIS LINE to use Laravel's built-in token trait instead:
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    // Make sure it is included here inside the class wrapper:
    use HasApiTokens, Notifiable, HasFactory;

    /**
     * The attributes that are mass assignable.
     */
    protected $fillable = [
        'name',
        'email',
        'password',
        'role',
        'roles',
        'phone',
        'address',
        'barangay_id',
        'city_id',
        'barangay_name',
        'photo_url',
        'is_active',
        'approved_at',
    ];

    /**
     * The attributes that should be hidden for serialization.
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    protected $casts = [
        'is_active' => 'boolean',
        'roles'     => 'array',
        'approved_at' => 'datetime',
    ];

    // Matches the migration's DB-level default. Without this, a User
    // instance built in PHP without an explicit is_active (e.g. a factory
    // in tests) casts its unset attribute to `false`, not the DB's `true` —
    // a silent mismatch between what's in memory and what's actually stored.
    protected $attributes = [
        'is_active' => true,
    ];

    public function barangay()
    {
        return $this->belongsTo(Barangay::class);
    }

    public function city()
    {
        return $this->belongsTo(City::class);
    }

    /**
     * Multi-role support. `role` remains the user's PRIMARY role (used for
     * routing, dashboards, badges); `roles` is the full set of hats the
     * account may wear (used for permission checks). One person in a small
     * barangay can hold, e.g., ['Custodian', 'Maintenance Personnel'] and act
     * under each — the action taken records which function they performed.
     */
    public function hasRole(string $role): bool
    {
        // Delegate to allRoles() so the primary `role` always counts even if
        // `roles` is populated but happens not to list it — hasRole(),
        // allRoles(), and scopeHavingRole() must always agree on membership.
        return in_array($role, $this->allRoles(), true);
    }

    public function hasAnyRole(array $roles): bool
    {
        foreach ($roles as $role) {
            if ($this->hasRole($role)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The account's effective role set — always includes the primary role.
     */
    public function allRoles(): array
    {
        $roles = $this->roles ?: [];
        if ($this->role && !in_array($this->role, $roles, true)) {
            $roles[] = $this->role;
        }

        return array_values(array_unique($roles));
    }

    /**
     * Match users who hold a given role either as their primary `role` or
     * anywhere in their `roles` list. Uses a portable LIKE against the JSON
     * text so it works identically on SQLite and Postgres (no JSON1 needed).
     */
    public function scopeHavingRole($query, string $role)
    {
        return $query->where(function ($q) use ($role) {
            $q->where('role', $role)
              ->orWhere('roles', 'like', '%"' . $role . '"%');
        });
    }

    /**
     * Single source of truth for "can this account do X" (config/permissions.php),
     * OR'd across every role the account holds. Ownership/live-state rules
     * (own report, not-the-repairer, last-active-Admin, same barangay) are
     * NOT decided here — they stay as separate guard calls next to this one,
     * since they depend on a database record, not just the actor's role.
     */
    /**
     * VMS-IMPROVEMENT-PLAN.md Phase B2 — every ability this account currently
     * holds, for the frontend to gate on instead of role strings. Deliberately
     * a plain method, not an Eloquent accessor/$appends entry: this is only
     * meaningful for "who am I" (login response, GET /user) — appending it
     * globally would silently bloat every OTHER user embedded elsewhere
     * (a ticket's assignedCustodian, an issue's reportedBy, etc.) with an
     * abilities array nobody asked for there.
     */
    public function getAbilities(): array
    {
        return collect(config('permissions'))
            ->filter(fn (array $roles) => $this->hasAnyRole($roles))
            ->keys()
            ->values()
            ->all();
    }

    public function canDo(string $ability): bool
    {
        // Note: config('permissions.' . $ability) would be wrong here — Laravel's
        // config() helper splits every dot into a nested lookup, but
        // config/permissions.php stores each ability as a single flat key that
        // itself contains a dot (e.g. 'vehicle.create'), not a nested array.
        $allowedRoles = config('permissions')[$ability] ?? [];

        return $this->hasAnyRole($allowedRoles);
    }
}