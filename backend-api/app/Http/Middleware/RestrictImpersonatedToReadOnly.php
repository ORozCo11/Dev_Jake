<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase A5 — impersonation is for looking at an
 * account to support or recover it, never for acting as it. A token
 * carrying the 'impersonated' ability (see AuthController::impersonate())
 * may only read: every GET/HEAD/OPTIONS request passes through untouched,
 * every other verb is rejected outright — except ending the session itself
 * (logout — including Workspace.jsx's "Return to..." control, which calls
 * it before swapping back to the real account) and switching to a
 * different impersonated account (impersonate/*), both of which are about
 * the impersonation session, not the impersonated account's own data.
 *
 * Bypassed in 'local' only (a developer's own machine) so impersonating an
 * account while building/testing a feature doesn't also require logging in
 * as that account separately. Deliberately NOT bypassed in 'testing' —
 * that's PHPUnit's environment name, and ImpersonationTest specifically
 * exercises this block; including it here would silently stop testing the
 * one thing this class exists to guarantee. Production is never affected.
 */
class RestrictImpersonatedToReadOnly
{
    private const ALLOWED_WRITE_PREFIXES = ['impersonate', 'logout'];

    public function handle(Request $request, Closure $next): Response
    {
        $token = $request->user()?->currentAccessToken();

        // Deliberately keyed off the token's NAME, not ->can('impersonated')
        // — Sanctum::actingAs($user, ['*']) (this whole test suite's usual
        // way of authenticating as "any user, no ability restrictions") stubs
        // ->can() to return true for every ability including this one, which
        // would otherwise make every non-GET request in the entire test
        // suite look impersonated. A real impersonation token's name is
        // always exactly 'impersonation_token' (see
        // AuthController::impersonate()); nothing else ever uses that name.
        if (!$token || $token->name !== 'impersonation_token' || $request->isMethod('get') || $request->isMethod('head') || $request->isMethod('options') || app()->environment('local')) {
            return $next($request);
        }

        // Routes are registered under the "api" prefix (bootstrap/app.php),
        // so path() starts with "api/" — strip it before checking segments.
        $path = preg_replace('#^api/#', '', $request->path());
        $firstSegment = explode('/', $path)[0];

        if (in_array($firstSegment, self::ALLOWED_WRITE_PREFIXES, true)) {
            return $next($request);
        }

        abort(403, 'You are viewing this account in read-only impersonation mode. Return to your own account to make changes.');
    }
}
