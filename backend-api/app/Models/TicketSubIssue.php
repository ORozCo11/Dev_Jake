<?php

namespace App\Models;

use App\Models\Concerns\ScopedThroughVehicle;
use Illuminate\Database\Eloquent\Model;

/**
 * One root cause / line item under a MaintenanceTicket's Main Issue,
 * e.g. "Low coolant level" under the "Overheating" ticket. Runs its own
 * copy of the assign -> repair -> verify -> confirm pipeline, independent
 * of every other sub-issue on the same ticket.
 */
class TicketSubIssue extends Model
{
    use ScopedThroughVehicle;

    protected $primaryKey = 'sub_issue_id';

    protected static function vehicleRelationPath(): string
    {
        // Reaches Vehicle through its parent ticket, not directly.
        return 'ticket.vehicle';
    }

    protected $fillable = [
        'ticket_id',
        'issue_report_id',
        'created_by',
        'title',
        'status',
        'assigned_mechanic_id',
        // A Custodian's proposed mechanic, before an Admin has approved the
        // ticket — see the 2026_09_28_000002 migration's docblock.
        'suggested_mechanic_id',
        'maintenance_type',
        // How this sub-issue's repair was/will be carried out — in_house,
        // cannibalized, or external. Set at ticket creation when already
        // known, or at the Log Repairs step once a mechanic starts the work.
        'repair_type',
        'source_vehicle_id',
        'part_missing',
        'part_needed',
        'part_quantity',
        'part_condition',
        'cannibal_reason',
        'part_installed_at',
        'external_sent_at',
        'external_returned_at',
        'external_return_notes',
        'external_actual_cost',
        // Only meaningful when repair_type is 'external' — which shop did
        // the work, and how long the repair is warrantied for.
        'external_vendor',
        'external_reason',
        'external_work_scope',
        'external_shop_contact',
        'external_sent_by',
        'external_contact_person',
        'external_estimated_cost',
        'warranty_until',
        'work_order_notes',
        'mechanic_assigned_at',
        'mechanic_assigned_by',
        'repair_logs',
        'parts_used',
        'attachment_url',
        'repair_started_at',
        'repair_completed_at',
        'maintenance_cost',
        'verification_verdict',
        'verification_notes',
        'verified_by',
        'verified_at',
        'verification_assigned_to',
        // Problem 2 — functional test ("UAT") recorded at the verify gate
        'functional_test',
        'test_attested',
        'confirmation_verdict',
        'confirmation_notes',
        'confirmed_by',
        'confirmed_at',
        'reopened_by',
        'reopened_at',
        // Problem 1 — "Deferred" outcome (a recorded decision not to fix now)
        'deferred_reason',
        'deferred_by',
        'deferred_at',
        'deferred_issue_report_id',
        // VMS-IMPROVEMENT-PLAN.md Phase A3 — an Admin's sign-off gate for a
        // cannibalized repair, before it's allowed on to Custodian
        // verification. Null for in_house/external repairs entirely.
        'cannibalization_status',
        'cannibalization_rejection_reason',
        'cannibalization_reviewed_by',
        'cannibalization_reviewed_at',
        'cannibalization_issue_report_id',
    ];

    protected $casts = [
        'mechanic_assigned_at' => 'datetime',
        'verified_at'          => 'datetime',
        'confirmed_at'         => 'datetime',
        'warranty_until'       => 'date',
        'part_installed_at'    => 'date:Y-m-d',
        'external_sent_at'     => 'datetime',
        'external_returned_at' => 'datetime',
        'deferred_at'          => 'datetime',
        'cannibalization_reviewed_at' => 'datetime',
        'maintenance_cost'     => 'decimal:2',
        'external_estimated_cost' => 'decimal:2',
        'functional_test'      => 'array',
        'test_attested'        => 'boolean',
    ];

    public function ticket()
    {
        return $this->belongsTo(MaintenanceTicket::class, 'ticket_id', 'ticket_id');
    }

    public function issueReport()
    {
        return $this->belongsTo(VehicleIssueReport::class, 'issue_report_id', 'issue_report_id');
    }

    public function createdBy()
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function assignedMechanic()
    {
        return $this->belongsTo(User::class, 'assigned_mechanic_id');
    }

    public function suggestedMechanic()
    {
        return $this->belongsTo(User::class, 'suggested_mechanic_id');
    }

    public function sourceVehicle()
    {
        return $this->belongsTo(Vehicle::class, 'source_vehicle_id', 'vehicle_id');
    }

    public function mechanicAssignedBy()
    {
        return $this->belongsTo(User::class, 'mechanic_assigned_by');
    }

    public function verifiedBy()
    {
        return $this->belongsTo(User::class, 'verified_by');
    }

    public function verificationAssignedTo()
    {
        return $this->belongsTo(User::class, 'verification_assigned_to');
    }

    public function confirmedBy()
    {
        return $this->belongsTo(User::class, 'confirmed_by');
    }

    public function reopenedBy()
    {
        return $this->belongsTo(User::class, 'reopened_by');
    }

    public function deferredBy()
    {
        return $this->belongsTo(User::class, 'deferred_by');
    }

    public function cannibalizationReviewedBy()
    {
        return $this->belongsTo(User::class, 'cannibalization_reviewed_by');
    }

    public function cannibalizationIssueReport()
    {
        return $this->belongsTo(VehicleIssueReport::class, 'cannibalization_issue_report_id', 'issue_report_id');
    }

    /**
     * A sub-issue is "resolved" when it has reached a terminal state —
     * either genuinely fixed (Done) or a recorded decision not to fix it
     * now (Deferred). Ticket closing keys off this, not off Done alone.
     */
    public function isResolved(): bool
    {
        return in_array($this->status, ['Done', 'Deferred'], true);
    }
}
