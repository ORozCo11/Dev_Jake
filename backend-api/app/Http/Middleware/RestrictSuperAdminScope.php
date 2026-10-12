<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Enforces the Super Admin boundary: account administration only, never
 * fleet data. Every other model (Vehicle, MaintenanceTicket, etc.) is only
 * scoped by BelongsToBarangay/ScopedThroughVehicle when the VIEWER has a
 * barangay_id — a Super Admin never does, so those scopes silently no-op
 * and would otherwise leak every barangay's full fleet data through the
 * ordinary /vehicles, /tickets, etc. endpoints. Rather than adding a
 * role check to dozens of individual controller methods, this is an
 * allowlist: a Super Admin may only reach /superadmin/*, /impersonate/*,
 * /notifications/* (scoped strictly to `user_id` in NotificationController
 * — no fleet/barangay data flows through it, and it's how a Super Admin
 * is pushed pending-registration alerts via notifySuperAdmins()), and the
 * handful of account-level routes below — everything else 403s.
 */
class RestrictSuperAdminScope
{
    private const ALLOWED_PREFIXES = ['superadmin', 'impersonate', 'notifications'];
    private const ALLOWED_EXACT = ['logout', 'user', 'profile', 'profile/password', 'greeting'];

    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if (!$user || !$user->hasRole('Super Admin')) {
            return $next($request);
        }

        // Routes are registered under the "api" prefix (bootstrap/app.php),
        // so path() starts with "api/" — strip it before checking segments.
        $path = preg_replace('#^api/#', '', $request->path());
        $firstSegment = explode('/', $path)[0];

        if (in_array($firstSegment, self::ALLOWED_PREFIXES, true) || in_array($path, self::ALLOWED_EXACT, true)) {
            return $next($request);
        }

        abort(403, 'Super Admin accounts are limited to account administration and cannot access fleet data.');
    }
}
