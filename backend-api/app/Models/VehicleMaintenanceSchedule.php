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
    ];

    protected $casts = [
        'recurrence_months' => 'integer',
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
}
