<?php

namespace App\Models;

use App\Models\Concerns\ScopedThroughVehicle;
use Illuminate\Database\Eloquent\Model;

class MaintenanceTicket extends Model
{
    use ScopedThroughVehicle;

    protected $primaryKey = 'ticket_id';

    // The one place a ticket title is built — always server-side, never typed:
    // "MT-0010 — Fire Truck Uno — Brake Failure".
    public static function composeTitle(int $ticketId, string $vehicleName, string $summary): string
    {
        return sprintf('MT-%04d — %s — %s', $ticketId, $vehicleName, $summary);
    }

    protected $fillable = [
        'vehicle_id',
        'issue_report_id',
        'created_by',
        'ticket_title',
        'fault_category',
        'ticket_description',
        'priority',
        'status',
        'down_since',
        'assigned_custodian_id',
        'assigned_at',
        'inspection_notes',
        'inspection_result',
        'inspected_by',
        'inspected_at',
        'closed_by',
        'closed_at',
        'closing_notes',
        'archived_at',
        'returned_to_service',
        'recurrence_count',
        'recurrence_of_ticket_id',
    ];

    protected $casts = [
        'assigned_at'         => 'datetime',
        'down_since'          => 'datetime',
        'inspected_at'        => 'datetime',
        'closed_at'           => 'datetime',
        'archived_at'         => 'datetime',
        'returned_to_service' => 'boolean',
    ];

    protected $appends = ['progress', 'days_open'];

    // -------------------------------------------------------
    // Relationships
    // -------------------------------------------------------

    public function vehicle()
    {
        return $this->belongsTo(Vehicle::class, 'vehicle_id', 'vehicle_id');
    }

    public function createdBy()
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function assignedCustodian()
    {
        return $this->belongsTo(User::class, 'assigned_custodian_id');
    }

    public function inspectedBy()
    {
        return $this->belongsTo(User::class, 'inspected_by');
    }

    public function closedBy()
    {
        return $this->belongsTo(User::class, 'closed_by');
    }

    public function archiveLog()
    {
        return $this->hasOne(TicketArchiveLog::class, 'ticket_id', 'ticket_id');
    }

    public function issueReport()
    {
        return $this->belongsTo(VehicleIssueReport::class, 'issue_report_id', 'issue_report_id');
    }

    public function subIssues()
    {
        return $this->hasMany(TicketSubIssue::class, 'ticket_id', 'ticket_id');
    }

    /**
     * #9 — the prior closed ticket this one is a recurrence of, if any.
     */
    public function recurrenceOf()
    {
        return $this->belongsTo(MaintenanceTicket::class, 'recurrence_of_ticket_id', 'ticket_id');
    }

    /**
     * #9 — later tickets that recurred from this one, forming the other
     * direction of the same trail.
     */
    public function recurrences()
    {
        return $this->hasMany(MaintenanceTicket::class, 'recurrence_of_ticket_id', 'ticket_id');
    }

    // -------------------------------------------------------
    // Progress rollup
    // -------------------------------------------------------

    /**
     * "X/N sub-issues Done" — the ticket-level progress counter shown
     * in the UI, e.g. Overheating [2/3]. `deferred` is broken out so the
     * UI can show, e.g., "2 Done · 1 Deferred" rather than hiding the
     * fact that a line item was closed without being fixed.
     */
    public function getProgressAttribute(): array
    {
        $total    = $this->subIssues->count();
        $done     = $this->subIssues->where('status', 'Done')->count();
        $deferred = $this->subIssues->where('status', 'Deferred')->count();

        return ['done' => $done, 'deferred' => $deferred, 'total' => $total];
    }

    /**
     * How long the ticket has been open, in whole days — the "aging"
     * signal that answers "how long has this been sitting?". Measured up
     * to now while live, or up to when it ended once Closed/Cancelled.
     */
    public function getDaysOpenAttribute(): ?int
    {
        if (!$this->created_at) {
            return null;
        }

        $end = in_array($this->status, ['Closed', 'Cancelled'], true)
            ? ($this->closed_at ?? $this->updated_at ?? now())
            : now();

        return (int) $this->created_at->diffInDays($end);
    }

    /**
     * A ticket is eligible to Close when every sub-issue is *resolved* —
     * i.e. Done (fixed) OR Deferred (a recorded decision not to fix now).
     * A ticket with zero sub-issues (a "No Issues" inspection) is also
     * eligible — there was nothing to fix.
     */
    public function isEligibleToClose(): bool
    {
        return $this->subIssues->every(fn (TicketSubIssue $s) => $s->isResolved());
    }

    /**
     * Sub-issues that are neither Done nor Deferred — the ones a
     * decision-close would have to defer before the ticket can close.
     */
    public function unresolvedSubIssues()
    {
        return $this->subIssues->reject(fn (TicketSubIssue $s) => $s->isResolved());
    }
}
