<?php

namespace App\Console\Commands;

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
 * date has arrived becomes a real ticket automatically, instead of relying
 * on someone noticing and converting it by hand — the auto-created ticket
 * is a normal pre-diagnosed (Active) ticket with one sub-issue, so it flows
 * through the exact same assign/repair/verify/confirm cycle as any other.
 *
 * `resulting_ticket_id` is stamped once conversion happens, which is also
 * what stops this command from converting the same schedule twice on
 * consecutive days if it's ever left un-completed past its date.
 *
 * Deliberately does NOT touch completeSchedule()'s existing standalone
 * behavior — a schedule with a resulting_ticket_id set is expected to be
 * finished by closing that TICKET, not by completing the schedule row
 * directly; completeSchedule() itself is guarded against double-completion
 * once a ticket exists (see FleetController::completeSchedule).
 */
class ConvertDueSchedulesToTickets extends Command
{
    protected $signature = 'schedules:convert-due-to-tickets';

    protected $description = 'Auto-create a ticket for every Scheduled maintenance entry whose date has arrived';

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

        $this->info("Converted {$converted} due schedule(s) to ticket(s); skipped {$skipped}.");

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

        DB::transaction(function () use ($schedule, $vehicle, $custodian) {
            $ticket = MaintenanceTicket::create([
                'vehicle_id' => $vehicle->vehicle_id,
                'created_by' => $custodian->id,
                'ticket_title' => $schedule->maintenance_type,
                'ticket_description' => "Auto-created from Maintenance Schedule #{$schedule->schedule_id}, due {$schedule->scheduled_date}."
                    . ($schedule->notes ? " Notes: {$schedule->notes}" : ''),
                'priority' => 'Medium',
                'status' => 'Active',
                'down_since' => now(),
                'assigned_custodian_id' => $custodian->id,
                'assigned_at' => now(),
                'inspection_result' => 'Needs Maintenance',
                'inspection_notes' => 'Pre-diagnosed from a due Maintenance Schedule — inspection skipped.',
                'inspected_by' => $custodian->id,
                'inspected_at' => now(),
            ]);

            $assignedMechanic = $schedule->assigned_to
                ? User::find($schedule->assigned_to)
                : null;

            TicketSubIssue::create([
                'ticket_id' => $ticket->ticket_id,
                'created_by' => $custodian->id,
                'title' => $schedule->maintenance_type,
                'maintenance_type' => $schedule->maintenance_type,
                'status' => $assignedMechanic ? 'Under Repair' : 'Open',
                'assigned_mechanic_id' => $assignedMechanic?->id,
                'mechanic_assigned_at' => $assignedMechanic ? now() : null,
                'mechanic_assigned_by' => $assignedMechanic ? $custodian->id : null,
            ]);

            $vehicle->update(['condition' => 'Needs Repair', 'status' => 'Under Maintenance']);

            $schedule->update(['resulting_ticket_id' => $ticket->ticket_id]);

            // No authenticated request in a console command, so
            // BelongsToBarangay's auto-stamp (which reads Auth::user())
            // never fires here — barangay_id (and role, for consistency
            // with every HTTP-triggered log entry) must be set explicitly.
            ActivityLog::create([
                'user_id' => $custodian->id,
                'role' => $custodian->role,
                'action' => 'Add',
                'module' => 'Maintenance Tickets',
                'affected_record_id' => (string) $ticket->ticket_id,
                'details' => "Ticket #{$ticket->ticket_id} auto-created from due Maintenance Schedule #{$schedule->schedule_id} ({$vehicle->vehicle_name}).",
                'barangay_id' => $vehicle->barangay_id,
            ]);

            Notification::create([
                'user_id' => $custodian->id,
                'title' => 'Scheduled Maintenance Due',
                'message' => "Your scheduled {$schedule->maintenance_type} for {$vehicle->vehicle_name} is due today — Ticket #{$ticket->ticket_id} was created for it.",
                'type' => 'schedule_due_ticket_created',
                'ticket_id' => $ticket->ticket_id,
            ]);

            if ($assignedMechanic) {
                Notification::create([
                    'user_id' => $assignedMechanic->id,
                    'title' => 'New Work Order Assigned',
                    'message' => "You've been assigned \"{$schedule->maintenance_type}\" on Ticket #{$ticket->ticket_id} ({$vehicle->vehicle_name}), from your scheduled maintenance.",
                    'type' => 'work_order_assigned',
                    'ticket_id' => $ticket->ticket_id,
                ]);
            }
        });

        return true;
    }
}
