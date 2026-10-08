<?php

namespace App\Models;

use App\Models\Concerns\ScopedThroughVehicle;
use Illuminate\Database\Eloquent\Model;

class VehicleMaintenanceRecord extends Model
{
    use ScopedThroughVehicle;

    protected $primaryKey = 'maintenance_id';

    protected $fillable = [
        'vehicle_id',
        'source_vehicle_id',
        'part_name',
        'issue_report_id',
        'maintenance_type',
        'problem_reason',
        'date_started',
        'date_completed',
        'maintenance_personnel_id',
        'performed_by_other',
        'is_external',
        'external_vendor',
        'warranty_until',
        'receipt_url',
        'action_taken',
        'parts_used',
        'maintenance_cost',
        'progress_status',
        'remarks',
        'closure_reason',
        'verification_result',
        'verification_notes',
        'verified_by',
        'verified_at',
        'confirmed_by',
        'confirmed_at',
    ];

    protected $casts = [
        'is_external' => 'boolean',
        'warranty_until' => 'date',
        'verified_at' => 'datetime',
        'confirmed_at' => 'datetime',
    ];

    // Not a real column — computed in getSourceAttribute() below, but always
    // needed by the UI (Maintenance Records list/detail), so it's appended
    // to every JSON response instead of making callers remember to ask for it.
    protected $appends = ['source'];

    public function vehicle()
    {
        return $this->belongsTo(Vehicle::class, 'vehicle_id', 'vehicle_id');
    }

    // The schedule this record was produced FROM, if any (completeSchedule()
    // sets schedule.resulting_maintenance_id back to this record — this is
    // just the inverse side of that link).
    public function originatingSchedule()
    {
        return $this->hasOne(VehicleMaintenanceSchedule::class, 'resulting_maintenance_id', 'maintenance_id');
    }

    // How this record came to exist, for the "Source" column — never stored,
    // always derived, so it can't drift out of sync with the data it reads.
    // Order matters: a schedule-completion record can also carry an
    // issue_report_id/is_external from its schedule, so the schedule check
    // must win first.
    public function getSourceAttribute()
    {
        if ($this->originatingSchedule) {
            return 'Scheduled Maintenance';
        }
        if ($this->issue_report_id && $this->is_external) {
            return 'External Shop';
        }
        if ($this->issue_report_id) {
            return 'From Issue Report';
        }
        return 'Field Repair';
    }

    // The vehicle a part was cannibalized FROM, when this repair used a part
    // taken off another vehicle instead of a newly acquired one.
    public function sourceVehicle()
    {
        return $this->belongsTo(Vehicle::class, 'source_vehicle_id', 'vehicle_id');
    }

    public function issueReport()
    {
        return $this->belongsTo(VehicleIssueReport::class, 'issue_report_id', 'issue_report_id');
    }

    public function maintenancePersonnel()
    {
        return $this->belongsTo(User::class, 'maintenance_personnel_id');
    }

    public function verifiedBy()
    {
        return $this->belongsTo(User::class, 'verified_by');
    }

    public function confirmedBy()
    {
        return $this->belongsTo(User::class, 'confirmed_by');
    }
}
