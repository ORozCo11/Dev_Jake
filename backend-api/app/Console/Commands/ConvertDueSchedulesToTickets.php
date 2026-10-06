<?php

namespace App\Console\Commands;

use App\Models\Notification;
use App\Models\User;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Console\Command;

/**
 * Runs daily (see routes/console.php). A Scheduled maintenance entry whose
 * date has arrived no longer creates anything on its own: it tells the
 * barangay's Custodians, once, that the work is due. The notification opens
 * the normal Propose Ticket form pre-filled from the schedule (the proposal
 * carries `schedule_id`), so there is exactly one way a ticket is ever
 * created — a Custodian's proposal — and the schedule is only its reason.
 *
 * (The command keeps its historical name so the scheduler entry is unchanged.)
 */
class ConvertDueSchedulesToTickets extends Command
{
    protected $signature = 'schedules:convert-due-to-tickets';

    protected $description = 'Notify Custodians, once, about every Scheduled maintenance entry whose date has arrived';

    public function handle(): int
    {
        $due = VehicleMaintenanceSchedule::where('status', 'Scheduled')
            ->whereNull('resulting_ticket_id')
            ->whereNull('due_notified_at')
            ->whereDate('scheduled_date', '<=', now()->toDateString())
            ->with('vehicle')
            ->get();

        $notified = 0;

        foreach ($due as $schedule) {
            $vehicle = $schedule->vehicle;
            if (!$vehicle || in_array($vehicle->status, ['Inactive', 'Decommissioned'], true)) {
                continue;
            }

            $custodians = User::where('barangay_id', $vehicle->barangay_id)->havingRole('Custodian')->where('is_active', true)->get();
            if ($custodians->isEmpty()) {
                continue;
            }

            foreach ($custodians as $custodian) {
                Notification::create([
                    'user_id' => $custodian->id,
                    'title' => 'Scheduled Maintenance Is Due',
                    'message' => "{$schedule->maintenance_type} for {$vehicle->vehicle_name} is due. Open it to propose a maintenance ticket — the form is pre-filled.",
                    'type' => 'schedule_due',
                    'schedule_id' => $schedule->schedule_id,
                ]);
            }

            $schedule->update(['due_notified_at' => now()]);
            $notified++;
        }

        $this->info("Notified Custodians about {$notified} due schedule(s).");

        return self::SUCCESS;
    }
}