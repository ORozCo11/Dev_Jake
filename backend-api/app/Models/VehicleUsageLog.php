<?php

namespace App\Models;

use App\Models\Concerns\ScopedThroughVehicle;
use Illuminate\Database\Eloquent\Model;

class VehicleUsageLog extends Model
{
    use ScopedThroughVehicle;

    protected $primaryKey = 'usage_id';

    protected $fillable = ['vehicle_id', 'logged_by', 'purpose', 'destination', 'driver_name', 'started_at', 'ended_at', 'odometer_start', 'odometer_end', 'notes'];

    protected $casts = ['started_at' => 'datetime', 'ended_at' => 'datetime'];

    protected static function vehicleRelationPath(): string
    {
        return 'vehicle';
    }

    public function vehicle()
    {
        return $this->belongsTo(Vehicle::class, 'vehicle_id', 'vehicle_id');
    }

    public function loggedBy()
    {
        return $this->belongsTo(User::class, 'logged_by');
    }
}