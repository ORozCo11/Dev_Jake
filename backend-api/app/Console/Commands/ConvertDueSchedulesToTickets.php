<?php

namespace App\Console\Commands;

use App\Http\Controllers\Concerns\ChecksRecurrence;
use App\Models\ActivityLog;
use App\Models\MaintenanceTicket;
use App\Models\Notification;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Runs daily (see routes/console.php). A Scheduled maintenance entry whose
 * date has arrived becomes a ticket PROPOSAL automatically, instead of
 * relying on someone noticing and converting it by hand.
 *
 * Production-readiness audit finding #1 — this used to create the ticket
 * directly as Active, with its sub-issue pre-assigned to a mechanic,
 * completely bypassing Admin review, the human proposeTicket() path's
 * duplicate-title guard, and the subissue.assign_mechanic ability. That's
 * fixed here: a due schedule now produces a 'Pending Approval' proposal —
 * identical in every respect to a Custodian manually proposing one — that
 * still has to go through the normal approveTicket()/declineTicket() review.
 * Any schedule's suggested mechanic rides along as `suggested_mechanic_id`
 * (a suggestion only, same as a human proposal) rather than being dispatched
 * directly; approveTicket() is what actually assigns them, exactly as it
 * already does for a Custodian's own proposals.
 *
 * `resulting_ticket_id` is stamped once a proposal is created, which is also
 * what stops this command from converting the same schedule twice on
 * consecutive days if it's ever left un-reviewed past its date.
 *
 * Deliberately does NOT touch completeSchedule()'s existing standalone
 * behavior — a schedule with a resulting_ticket_id set is expected to be
 * finished by closing that TICKET, not by completing the schedule row
 * directly; completeSchedule() itself is guarded against double-completion
 * once a ticket exists (see FleetController::completeSchedule).
 */
class ConvertDueSchedulesToTickets extends Command
{
    use ChecksRecurrence;

    protected $signature = 'schedules:convert-due-to-tickets';

    protected $description = 'Auto-propose a ticket for every Scheduled maintenance entry whose date has arrived';

    public function handle(): int
    {
        $due = VehicleMaintenanceSchedule::where('status', 'Scheduled')
            ->whereNull('resulting_ticket_id')
            ->whereDate('scheduled_date', '<=', now()->toDateString())
            ->with('vehicle')
            ->get();

        $converted = 0;
        $skipped = 0;

        foreach ($due as $schedule) {
            if ($this->convertOne($schedule)) {
                $converted++;
            } else {
                $skipped++;
            }
        }

        $this->info("Proposed {$converted} due schedule(s) as ticket(s); skipped {$skipped}.");

        return self::SUCCESS;
    }

    private function convertOne(VehicleMaintenanceSchedule $schedule): bool
    {
        $vehicle = $schedule->vehicle;

        if (!$vehicle || in_array($vehicle->status, ['Inactive', 'Decommissioned'], true)) {
            $this->warn("Schedule #{$schedule->schedule_id}: vehicle missing or retired, skipped.");
            return false;
        }

        // The schedule's own creator is a Custodian under normal operation
        // (schedule.create is Custodian-only) — fall back to any active
        // Custodian in the same barangay for an older schedule created
        // before that rule, rather than failing the whole run over it.
        $custodian = User::find($schedule->created_by);
        if (!$custodian || !$custodian->hasRole('Custodian') || !$custodian->is_active) {
            $custodian = User::where('barangay_id', $vehicle->barangay_id)
                ->havingRole('Custodian')
                ->where('is_active', true)
                ->first();
        }

        if (!$custodian) {
            $this->warn("Schedule #{$schedule->schedule_id}: no active Custodian available in this barangay, skipped.");
            return false;
        }

        // Same guard proposeTicket() runs before creating a human proposal —
        // a schedule must never silently spawn a second Main Issue when one
        // already covers the same maintenance type on this vehicle. Left
        // 'Scheduled' (not converted) so a human can sort out the conflict;
        // this command will simply try again on the next run. Normalized
        // against the same "Preventive Maintenance - {type}" format the
        // ticket below is actually titled with, so this stays self-consistent
        // across runs instead of comparing against a title nothing uses.
        $ticketTitle = "Preventive Maintenance - {$schedule->maintenance_type}";
        $normalizedTitle = $this->normalizeTicketTitle($ticketTitle);
        $duplicate = MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_id', 'ticket_title'])
            ->first(fn ($t) => $this->normalizeTicketTitle($t->ticket_title) === $normalizedTitle);

        if ($duplicate) {
            $this->warn("Schedule #{$schedule->schedule_id}: vehicle already has an open ticket (#{$duplicate->ticket_id}) for \"{$schedule->maintenance_type}\", skipped.");
            return false;
        }

        DB::transaction(function () use ($schedule, $vehicle, $custodian, $ticketTitle) {
            $ticket = MaintenanceTicket::create([
                'vehicle_id' => $vehicle->vehicle_id,
                'created_by' => $custodian->id,
                'ticket_title' => $ticketTitle,
                'ticket_description' => "Auto-proposed from Maintenance Schedule #{$schedule->schedule_id}, due {$schedule->scheduled_date}."
                    . ($schedule->notes ? " Notes: {$schedule->notes}" : ''),
                'priority' => 'Medium',
                'status' => 'Pending Approval',
                'assigned_custodian_id' => $custodian->id,
                'assigned_at' => now(),
            ]);

            // A rider for Admin to review, same as a human proposal's
            // suggested_mechanic_id — not a real dispatch. approveTicket()
            // is what actually assigns them, exactly like any other proposal.
            $suggestedMechanic = $schedule->assigned_to
                ? User::find($schedule->assigned_to)
                : null;

            // Final senior system review (2026-10-05, §3) — a preventive
            // schedule isn't a diagnosed defect, so its sub-issue shouldn't
            // be titled as though it is. "Scheduled Maintenance" names what
            // kind of work this is; maintenance_type still carries the real
            // type for every downstream list/filter/report that reads it.
            TicketSubIssue::create([
                'ticket_id' => $ticket->ticket_id,
                'created_by' => $custodian->id,
                'title' => 'Scheduled Maintenance',
                'maintenance_type' => $schedule->maintenance_type,
                'suggested_mechanic_id' => $suggestedMechanic?->id,
                'status' => 'Open',
            ]);

            $schedule->update(['resulting_ticket_id' => $ticket->ticket_id]);

            // No authenticated request in a console command, so
            // BelongsToBarangay's auto-stamp (which reads Auth::user())
            // never fires here — barangay_id (and role, for consistency
            // with every HTTP-triggered log entry) must be set explicitly.
            ActivityLog::create([
                'user_id' => $custodian->id,
                'role' => $custodian->role,
                'action' => 'Auto-Propose Ticket',
                'module' => 'Maintenance Tickets',
                'affected_record_id' => (string) $ticket->ticket_id,
                'details' => "Ticket #{$ticket->ticket_id} auto-proposed (Pending Approval) from due Maintenance Schedule #{$schedule->schedule_id} ({$vehicle->vehicle_name}) — awaiting Admin review.",
                'barangay_id' => $vehicle->barangay_id,
            ]);

            Notification::create([
                'user_id' => $custodian->id,
                'title' => 'Scheduled Maintenance Proposed as a Ticket',
                'message' => "Your scheduled {$schedule->maintenance_type} for {$vehicle->vehicle_name} was due, so Ticket #{$ticket->ticket_id} was proposed for it and is awaiting Admin review.",
                'type' => 'schedule_due_ticket_created',
                'ticket_id' => $ticket->ticket_id,
            ]);

            foreach (User::where('barangay_id', $vehicle->barangay_id)->havingRole('Admin')->where('is_active', true)->get() as $admin) {
                Notification::create([
                    'user_id' => $admin->id,
                    'title' => 'New Ticket Proposal Awaiting Review',
                    'message' => "A due Maintenance Schedule auto-proposed Ticket #{$ticket->ticket_id} — \"{$schedule->maintenance_type}\" for {$vehicle->vehicle_name}. Review, edit if needed, then approve or decline.",
                    'type' => 'ticket_proposed',
                    'ticket_id' => $ticket->ticket_id,
                ]);
            }
        });

        return true;
    }
}
