<?php

namespace App\Http\Controllers\Concerns;

use App\Models\MaintenanceTicket;
use App\Models\VehicleMaintenanceRecord;
use Illuminate\Support\Carbon;

/**
 * Recurring-fault detection, shared between TicketController (recurrence at
 * creation time) and FleetController (recurrence checked on-demand, BEFORE a
 * ticket exists, so Admin can see it while still deciding).
 *
 * Originally this only counted Closed Tickets — a fault fixed via a
 * standalone Maintenance Record (a roadside repair, an external shop) was
 * invisible, so a vehicle genuinely fixed 3 times could read as zero
 * recurrences. This counts both, on the same 90-day/same-vehicle window.
 *
 * Matching, most specific first: the repair's Maintenance Types (a prior
 * ticket counts if any of its sub-issues shared one; a record if its own
 * maintenance_type matches), else the linked Issue Report's issue_type, else
 * normalized-title / problem-reason text — best-effort.
 */
trait ChecksRecurrence
{
    // Moved here from TicketController so FleetController can share it too.
    // Compares titles after stripping the "[Issue #N] " prefix a ticket gets
    // when auto-titled from an Issue Report — otherwise a manually-typed
    // "Engine Problem" never matches an existing "[Issue #9] Engine Problem"
    // on the same vehicle even though they're the same Main Issue, letting a
    // true duplicate through. Also used for matching titles/problem_reason in
    // checkRecurrence() below.
    private function normalizeTicketTitle(string $title): string
    {
        $stripped = preg_replace('/^\[Issue #\d+\]\s*/i', '', trim($title));
        // Server titles are "MT-0010 — Vehicle — Issue" (older ones "#42 - …"):
        // the number is identity, not content, so it must not defeat the
        // duplicate-Main-Issue match. Dash style is unified for the same reason.
        $stripped = preg_replace('/^(MT-\d+\s*—\s*|#\d+\s*-\s*)/u', '', $stripped);
        $stripped = str_replace(' — ', ' - ', $stripped);

        return mb_strtolower(trim($stripped));
    }

    // The issue-summary part of a ticket title, vehicle name and MT-#### number
    // stripped — what "is this the same Main Issue?" actually compares, since
    // the vehicle is already fixed by the query's own vehicle_id.
    private function normalizeSummaryForVehicle(string $title, string $vehicleName): string
    {
        $n = $this->normalizeTicketTitle($title);
        $prefix = $this->normalizeTicketTitle($vehicleName) . ' - ';

        return str_starts_with($n, $prefix) ? substr($n, strlen($prefix)) : $n;
    }

    private function checkRecurrence(int $vehicleId, array $maintenanceTypes, ?string $issueType, string $title, int $days = 90): array
    {
        $since = now()->subDays($days);
        $normalizedTitle = $this->normalizeTicketTitle($title);
        $maintenanceTypes = array_values(array_filter(array_unique($maintenanceTypes)));

        $priorTicketsQuery = MaintenanceTicket::where('vehicle_id', $vehicleId)
            ->where('status', 'Closed')
            ->where('closed_at', '>=', $since);
        $priorRecordsQuery = VehicleMaintenanceRecord::where('vehicle_id', $vehicleId)
            ->where('progress_status', 'Completed')
            ->where('date_completed', '>=', $since->toDateString());

        if ($maintenanceTypes) {
            $priorTicketsQuery->whereHas('subIssues', fn ($sq) => $sq->whereIn('maintenance_type', $maintenanceTypes));
            $priorRecordsQuery->whereIn('maintenance_type', $maintenanceTypes);
        } elseif ($issueType) {
            $priorTicketsQuery->whereHas('issueReport', fn ($iq) => $iq->where('issue_type', $issueType));
            $priorRecordsQuery->whereHas('issueReport', fn ($iq) => $iq->where('issue_type', $issueType));
        } else {
            // $title is the issue summary; stored titles are either that alone
            // (older tickets) or "MT-0010 — Vehicle — summary".
            $priorTicketsQuery->whereRaw('(LOWER(TRIM(ticket_title)) = ? OR LOWER(ticket_title) LIKE ?)', [$normalizedTitle, '% — ' . $normalizedTitle]);
            $priorRecordsQuery->whereRaw('LOWER(TRIM(problem_reason)) = ?', [$normalizedTitle]);
        }

        $priorTickets = $priorTicketsQuery->get(['ticket_id as id', 'closed_at as occurred_at']);
        $priorRecords = $priorRecordsQuery->get(['maintenance_id as id', 'date_completed as occurred_at']);

        $all = $priorTickets->map(fn ($t) => ['type' => 'ticket', 'id' => $t->id, 'occurred_at' => $t->occurred_at])
            ->concat($priorRecords->map(fn ($r) => ['type' => 'record', 'id' => $r->id, 'occurred_at' => $r->occurred_at]))
            ->sortByDesc('occurred_at')
            ->values();

        $last = $all->first();

        return [
            'count'         => $all->count(),
            'last_type'     => $last['type'] ?? null,
            'last_id'       => $last['id'] ?? null,
            'last_occurred' => $last ? Carbon::parse($last['occurred_at'])->toDateString() : null,
        ];
    }
}
