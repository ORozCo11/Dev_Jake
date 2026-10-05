<?php

namespace App\Http\Controllers\Concerns;

use Illuminate\Http\Request;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase B1 — replaces the four near-identical private
 * requireRole() copies (Fleet/Ticket/Hub/CatalogController) and the two
 * single-role variants (UserController::requireAdmin,
 * SuperAdminController::requireSuperAdmin) with one call that reads
 * config/permissions.php instead of a role list hardcoded at the call site.
 * Ownership/live-state conditions (own report, not-the-repairer, last active
 * Admin, same barangay) are NOT this trait's job — they stay as separate
 * guard calls in the controller, same as GuardsLastAdmin.
 */
trait AuthorizesAbilities
{
    protected function requireAbility(Request $request, string $ability, string $message = 'Your account role cannot perform this action.'): void
    {
        abort_unless($request->user()->canDo($ability), 403, $message);

        // Record which of this account's (possibly several) roles actually
        // granted the ability, so an audit-log entry written later in the
        // same request can attribute the action to the function the user
        // was acting under, not just their primary role. See User::log()
        // call sites and User::effectiveRoleFor().
        $request->attributes->set('vms_acted_as_role', $request->user()->effectiveRoleFor($ability));
    }
}
