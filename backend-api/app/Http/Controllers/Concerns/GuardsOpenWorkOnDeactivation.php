<?php

namespace App\Http\Controllers\Concerns;

use App\Models\MaintenanceTicket;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\VehicleMaintenanceSchedule;

/**
 * VMS-IMPROVEMENT-PLAN.md Phase B5 — deactivating a user today only flips
 * is_active and revokes tokens; it never touches anything they were
 * assigned to. The only "unstick" tools are reassignCustodian()/
 * reassignMechanic() (TicketController) and reassignSchedule() (below) —
 * none of them fire automatically, so an Admin who deactivates someone
 * with open work has to notice and fix it by hand, after the fact. This
 * guard forces that reassignment to happen FIRST, before the account goes
 * inactive, by returning exactly what's still open and blocking until it
 * isn't. Shared by UserController (an Admin acting on their own barangay)
 * and SuperAdminController (a Super Admin acting across every barangay).
 *
 * Deliberately NOT covering "custodian of a vehicle" — that's a Phase D11
 * concept (a persistent vehicle -> custodian column) that doesn't exist in
 * the schema yet; extend this guard when that column lands.
 */
trait GuardsOpenWorkOnDeactivation
{
    /**
     * Plain-English list of everything still open and assigned to $user.
     * Empty means safe to deactivate.
     */
    private function openWorkFor(User $user): array
    {
        $items = [];

        MaintenanceTicket::where('assigned_custodian_id', $user->id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_id', 'ticket_title'])
            ->each(function (MaintenanceTicket $ticket) use (&$items) {
                $items[] = "Ticket #{$ticket->ticket_id} \"{$ticket->ticket_title}\" — assigned Custodian";
            });

        TicketSubIssue::where('assigned_mechanic_id', $user->id)
            ->whereNotIn('status', ['Done', 'Deferred'])
            ->with('ticket:ticket_id,ticket_title')
            ->get()
            ->each(function (TicketSubIssue $subIssue) use (&$items) {
                $ticketLabel = $subIssue->ticket?->ticket_title ?? "Ticket #{$subIssue->ticket_id}";
                $items[] = "\"{$subIssue->title}\" on {$ticketLabel} — assigned mechanic";
            });

        VehicleMaintenanceSchedule::where('assigned_to', $user->id)
            ->where('status', 'Scheduled')
            ->get(['schedule_id', 'maintenance_type'])
            ->each(function (VehicleMaintenanceSchedule $schedule) use (&$items) {
                $items[] = "Schedule #{$schedule->schedule_id} ({$schedule->maintenance_type}) — assigned";
            });

        return $items;
    }

    private function abortIfHasOpenWork(User $user, string $action): void
    {
        $openWork = $this->openWorkFor($user);

        if (empty($openWork)) {
            return;
        }

        abort(response()->json([
            'message' => "{$user->name} still has open work assigned to them — {$action} would leave it with no one responsible. Reassign these first:",
            'open_work' => $openWork,
        ], 422));
    }
}
