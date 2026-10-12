<?php

namespace App\Http\Controllers\Concerns;

use App\Models\User;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase A4 — a barangay with zero active Admins is
 * effectively orphaned (nobody left who can manage its users, vehicles,
 * fleet data, or approve anyone new — see SuperAdminController's own
 * "recover a barangay" flow, which exists specifically to fix this AFTER
 * it's already happened). Shared by UserController (an Admin acting on
 * their own barangay) and SuperAdminController (a Super Admin acting
 * across every barangay) so the same rule is enforced identically from
 * both places, rather than drifting apart as two separately-maintained
 * copies of the same query.
 */
trait GuardsLastAdmin
{
    /**
     * True if $user is an active Admin and no OTHER active Admin exists in
     * the same barangay — i.e. deactivating them, or taking their Admin
     * role away, would leave that barangay with zero active Admins.
     * A Super Admin's own barangay_id is always null, so this is never
     * true for one — nothing to protect there; RestrictSuperAdminScope
     * already keeps Super Admin accounts out of every barangay-scoped flow
     * this guard is used in.
     */
    private function isLastActiveAdminForBarangay(User $user): bool
    {
        if (!$user->is_active || !$user->hasRole('Admin') || !$user->barangay_id) {
            return false;
        }

        return !User::where('barangay_id', $user->barangay_id)
            ->where('id', '!=', $user->id)
            ->where('is_active', true)
            ->havingRole('Admin')
            ->exists();
    }

    private function abortIfLastActiveAdmin(User $user, string $action): void
    {
        abort_if(
            $this->isLastActiveAdminForBarangay($user),
            422,
            "{$user->name} is the only active Admin for their barangay — {$action} would leave it with no one who can manage users, vehicles, or approvals. Promote another user to Admin first."
        );
    }
}
