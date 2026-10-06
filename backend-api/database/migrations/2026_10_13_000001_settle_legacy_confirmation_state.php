<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * The Admin "confirm" step no longer exists: a Custodian's approving
 * verification is the final sign-off. Anything already waiting on that
 * step is settled here so nothing is left stranded — verified repairs
 * become Done, and any Active ticket whose jobs are all resolved closes
 * (freeing its vehicle if nothing else is keeping it out of service).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::table('ticket_sub_issues')->where('status', 'For Confirmation')->update([
            'status' => 'Done',
            'confirmation_verdict' => 'Confirmed',
            'confirmed_at' => now(),
        ]);

        $tickets = DB::table('maintenance_tickets')->where('status', 'Active')->get(['ticket_id', 'vehicle_id']);
        foreach ($tickets as $ticket) {
            $unresolved = DB::table('ticket_sub_issues')
                ->where('ticket_id', $ticket->ticket_id)
                ->whereNotIn('status', ['Done', 'Deferred'])
                ->exists();
            $hasJobs = DB::table('ticket_sub_issues')->where('ticket_id', $ticket->ticket_id)->exists();
            if ($unresolved || !$hasJobs) {
                continue;
            }

            DB::table('maintenance_tickets')->where('ticket_id', $ticket->ticket_id)->update([
                'status' => 'Closed',
                'closed_at' => now(),
                'returned_to_service' => true,
                'archived_at' => now(),
            ]);

            $stillActive = DB::table('maintenance_tickets')->where('vehicle_id', $ticket->vehicle_id)->where('status', 'Active')->exists();
            if (!$stillActive) {
                DB::table('vehicles')->where('vehicle_id', $ticket->vehicle_id)->where('status', 'Under Maintenance')->update([
                    'status' => 'Available',
                    'condition' => 'Good',
                    'estimated_return_date' => null,
                ]);
            }
        }
    }

    public function down(): void
    {
        // Settled data is not un-settled.
    }
};
