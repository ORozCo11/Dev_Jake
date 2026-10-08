<?php

namespace App\Models;

use App\Models\Concerns\ScopedThroughVehicle;
use Illuminate\Database\Eloquent\Model;

class VehicleMaintenanceSchedule extends Model
{
    use ScopedThroughVehicle;

    protected $primaryKey = 'schedule_id';

    protected $fillable = [
        'vehicle_id',
        'maintenance_type',
        'scheduled_date',
        'scheduled_time',
        'service_location',
        'notes',
        'status',
        'created_by',
        'assigned_to',
        'recurrence_months',
        'resulting_maintenance_id',
        'resulting_ticket_id',
        'due_notified_at',
    ];

    protected $casts = [
        'recurrence_months' => 'integer',
        'due_notified_at' => 'datetime',
    ];

    public function vehicle()
    {
        return $this->belongsTo(Vehicle::class, 'vehicle_id', 'vehicle_id');
    }

    public function createdBy()
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    // Named assignedToUser (not assignedTo) deliberately — Eloquent appends
    // an eager-loaded relation to the array/JSON output under the snake_case
    // of the relation's method name. "assignedTo" snake-cases to "assigned_to",
    // the EXACT name of the raw FK column below, so the loaded User object
    // would silently overwrite the plain id in every response.
    public function assignedToUser()
    {
        return $this->belongsTo(User::class, 'assigned_to');
    }

    // The Maintenance Record this schedule produced once marked done — lets a
    // completed row show real completion detail (date, cost, verification)
    // and link straight to it, instead of only ever showing scheduled_date.
    public function resultingMaintenance()
    {
        return $this->belongsTo(VehicleMaintenanceRecord::class, 'resulting_maintenance_id', 'maintenance_id');
    }

    // The ticket auto-created for this schedule on its due date (see
    // App\Console\Commands\ConvertDueSchedulesToTickets). Null until then.
    public function resultingTicket()
    {
        return $this->belongsTo(MaintenanceTicket::class, 'resulting_ticket_id', 'ticket_id');
    }

    /**
     * If this schedule repeats, create the next one at completed date +
     * interval. Shared by completing the schedule directly (FleetController)
     * and by closing the ticket it was auto-converted into (TicketController),
     * so a recurring service keeps recurring either way.
     *
     * Same double-booking rule as the manual create/edit paths — an
     * auto-generated recurrence is not exempt from it. If the natural next
     * date already has a Scheduled entry on this vehicle, nudge forward a day
     * at a time until a free date is found instead of silently double-booking.
     */
    public function seedNextRecurrence(string $completedDate, int $userId): ?self
    {
        if (!$this->recurrence_months) {
            return null;
        }

        // addMonthsNoOverflow(), not addMonths(): plain addMonths() overflows
        // past a shorter target month (Jan 31 + 1 month lands on Mar 3, not
        // Feb 28) instead of clamping to that month's last day.
        $nextDate = \Illuminate\Support\Carbon::parse($completedDate)->addMonthsNoOverflow($this->recurrence_months);
        for ($shift = 0; $shift < 60; $shift++) {
            $candidate = $nextDate->copy()->addDays($shift);
            $collides = static::where('vehicle_id', $this->vehicle_id)
                ->whereDate('scheduled_date', $candidate->toDateString())
                ->where('status', 'Scheduled')
                ->exists();
            if (!$collides) {
                $nextDate = $candidate;
                break;
            }
        }

        return static::create([
            'vehicle_id'        => $this->vehicle_id,
            'maintenance_type'  => $this->maintenance_type,
            'scheduled_date'    => $nextDate->toDateString(),
            'scheduled_time'    => $this->scheduled_time,
            'service_location'  => $this->service_location,
            'notes'             => $this->notes,
            'status'            => 'Scheduled',
            'created_by'        => $userId,
            'assigned_to'       => $this->assigned_to,
            'recurrence_months' => $this->recurrence_months,
        ]);
    }
}
