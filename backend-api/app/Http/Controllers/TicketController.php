<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\ChecksRecurrence;
use App\Http\Controllers\Concerns\UploadsImages;
use App\Models\ActivityLog;
use App\Models\FaultCategory;
use App\Models\MaintenanceTicket;
use App\Models\MaintenanceType;
use App\Models\TicketArchiveLog;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceRecord;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * TicketController — drives the Main Issue / Sub-Issue maintenance workflow.
 *
 * A ticket is a Main Issue container (e.g. "Overheating"). During inspection
 * it's populated with one or more Sub-Issues (e.g. "low coolant level"),
 * each running its own independent pipeline with its own mechanic:
 *
 *   Open -> Under Repair -> For Inspection -> For Confirmation -> Done
 *
 * The ticket's progress is X/N sub-issues Done. New sub-issues can be
 * appended for as long as the ticket is Active. Once an Admin explicitly
 * Closes the ticket (only allowed at N/N), it is permanently locked — no
 * further sub-issues, no reopening, ever.
 *
 * Phase 1: Admin creates ticket & assigns to Custodian   -> createTicket()
 * Phase 2: Custodian inspects, populates sub-issues       -> submitInspection()
 *          A new sub-issue can be added later             -> addSubIssue()
 * Phase 3: Admin assigns a mechanic per sub-issue          -> assignMechanic()
 *          Mechanic logs repair per sub-issue              -> logRepairs()
 * Phase 4: Custodian verifies a sub-issue (Tier 1)         -> verifyRepair()
 *          Admin confirms or reworks a sub-issue (Tier 2)  -> confirmSubIssue()
 * Phase 5: Admin explicitly closes the ticket (N/N only)   -> closeTicket()
 */
class TicketController extends Controller
{
    use UploadsImages;
    use ChecksRecurrence;

    private array $priorities       = ['Low', 'Medium', 'High'];

    // ===================================================================
    // READ ENDPOINTS
    // ===================================================================

    public function index(Request $request)
    {
        $user  = $request->user();
        $query = MaintenanceTicket::with($this->eagerLoads());

        // Non-admins see only what's relevant to a hat they wear. A person
        // holding BOTH Custodian and Maintenance sees tickets assigned to
        // them as custodian OR any with a sub-issue assigned to them.
        if (!$user->hasRole('Admin')) {
            $query->where(function ($scoped) use ($user) {
                if ($user->hasRole('Custodian')) {
                    $scoped->orWhere('assigned_custodian_id', $user->id);
                }
                if ($user->hasRole('Maintenance Personnel')) {
                    $scoped->orWhereHas('subIssues', fn ($q) => $q->where('assigned_mechanic_id', $user->id));
                }
            });
        }

        $query
            ->when($request->filled('status'), fn ($q) => $q->where('status', $request->status))
            ->when($request->filled('vehicle_id'), fn ($q) => $q->where('vehicle_id', $request->vehicle_id))
            ->when($request->filled('priority'), fn ($q) => $q->where('priority', $request->priority));

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('ticket_title', 'like', "%{$search}%")
                    ->orWhere('ticket_description', 'like', "%{$search}%")
                    ->orWhereHas('vehicle', fn ($v) => $v
                        ->where('vehicle_name', 'like', "%{$search}%")
                        ->orWhere('plate_number', 'like', "%{$search}%"));
            });
        }

        return $query->latest('ticket_id')->get();
    }

    public function show(Request $request, MaintenanceTicket $ticket)
    {
        return $ticket->load($this->eagerLoads());
    }

    public function lookups(Request $request)
    {
        return response()->json([
            'vehicles'              => Vehicle::whereNotIn('status', ['Inactive', 'Decommissioned'])
                ->with('category:category_id,category_name')
                ->orderBy('vehicle_name')
                ->get(['vehicle_id', 'vehicle_name', 'plate_number', 'status', 'condition', 'photo_url', 'brand', 'model', 'category_id', 'current_location']),
            // User carries no global scope — filter by barangay by hand,
            // or a ticket could get assigned to staff from another barangay.
            'custodians'            => User::where('barangay_id', $request->user()->barangay_id)->havingRole('Custodian')->orderBy('name')->get(['id', 'name', 'email', 'photo_url']),
            'maintenance_personnel' => User::where('barangay_id', $request->user()->barangay_id)->havingRole('Maintenance Personnel')->orderBy('name')->get(['id', 'name', 'email']),
            'priorities'            => $this->priorities,
            'fault_categories'      => FaultCategory::orderBy('name')->pluck('name'),
            'maintenance_types'     => MaintenanceType::orderBy('name')->pluck('name'),
            'ticket_statuses'       => ['Open', 'Active', 'Closed', 'Cancelled'],
            'sub_issue_statuses'    => ['Open', 'Under Repair', 'For Inspection', 'For Confirmation', 'Done', 'Deferred'],
        ]);
    }

    /**
     * Layer 2 duplicate-prevention aid — every currently open (non-Closed/
     * Cancelled) ticket on a vehicle, regardless of title wording. Title
     * matching alone can never catch "Brake Problem" vs "Brakes Squeaking"
     * being the same real Main Issue, so the Create Ticket form calls this
     * as soon as a vehicle is picked and shows a non-blocking warning
     * listing whatever comes back — letting the Admin catch it visually.
     */
    public function openTicketsForVehicle(Request $request, Vehicle $vehicle)
    {
        $this->requireRole($request, ['Admin']);

        return MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->orderByDesc('ticket_id')
            ->get(['ticket_id', 'ticket_title', 'status', 'priority']);
    }

    public function archives(Request $request)
    {
        $this->requireRole($request, ['Admin']);

        $query = TicketArchiveLog::with(['vehicle', 'archivedBy'])
            ->when($request->filled('vehicle_id'), fn ($q) => $q->where('vehicle_id', $request->vehicle_id));

        if ($request->filled('q')) {
            $search = $request->string('q');
            $query->where(function ($nested) use ($search) {
                $nested->where('ticket_title', 'like', "%{$search}%")
                    ->orWhere('vehicle_name', 'like', "%{$search}%")
                    ->orWhere('plate_number', 'like', "%{$search}%");
            });
        }

        return $query->orderByDesc('archived_at')->get();
    }

    // ===================================================================
    // PHASE 1 — Admin: Create Ticket (Main Issue) & Assign to Custodian
    // ===================================================================

    public function createTicket(Request $request)
    {
        $this->requireRole($request, ['Admin']);

        $data = $request->validate([
            'vehicle_id'            => ['required', 'exists:vehicles,vehicle_id'],
            'issue_report_id'       => ['nullable', 'exists:vehicle_issue_reports,issue_report_id'],
            'condition_check_id'    => ['nullable', 'exists:vehicle_condition_checks,condition_check_id'],
            'ticket_title'          => ['required', 'string', 'max:255'],
            'fault_category'        => ['nullable', 'string', 'max:150'],
            'ticket_description'    => ['required', 'string'],
            'priority'              => ['required', Rule::in($this->priorities)],
            'assigned_custodian_id' => ['required', 'exists:users,id'],
            // #3 — when the vehicle actually became unavailable (may be backdated).
            'down_since'            => ['nullable', 'date'],
            // #1 — entry mode. 'inspection' = today's flow (Custodian diagnoses
            // first). The other three mean the problem AND how it'll be fixed
            // are already known, so the ticket is born Active with its
            // sub-issues and skips inspection — replaces the old generic
            // 'prediagnosed' value, since picking a specific repair type
            // already implies the issue is diagnosed.
            'entry_mode'            => ['nullable', Rule::in(['inspection', 'in_house', 'cannibalized', 'external'])],
            'sub_issues'                    => ['required_if:entry_mode,in_house,cannibalized,external', 'array', 'min:1'],
            'sub_issues.*.title'            => ['required_with:sub_issues', 'string', 'max:255'],
            'sub_issues.*.maintenance_type' => ['nullable', 'string', 'max:150'],
            // Only meaningful (and required) when the repair is already
            // known to use a part cannibalized from another vehicle.
            'source_vehicle_id'     => ['nullable', 'required_if:entry_mode,cannibalized', 'exists:vehicles,vehicle_id', 'different:vehicle_id'],
            // Only meaningful when already known to be going to an external
            // shop — the vendor may not be picked yet, so optional even then.
            'external_vendor'       => ['nullable', 'string', 'max:255'],
            'warranty_until'        => ['nullable', 'date'],
        ]);

        // Fault category / maintenance type are a growing catalog, not a
        // fixed enum — a value that doesn't exist yet is persisted here so
        // it's offered as a real option everywhere else next time.
        if (!empty($data['fault_category'])) {
            $data['fault_category'] = FaultCategory::resolve($data['fault_category']);
        }
        if (!empty($data['sub_issues'])) {
            foreach ($data['sub_issues'] as &$subIssueInput) {
                if (!empty($subIssueInput['maintenance_type'])) {
                    $subIssueInput['maintenance_type'] = MaintenanceType::resolve($subIssueInput['maintenance_type']);
                }
            }
            unset($subIssueInput);
        }

        $entryMode = $data['entry_mode'] ?? 'inspection';
        $preDiagnosed = $entryMode !== 'inspection';
        // Only set on sub-issues when the repair type is already known —
        // 'inspection' tickets genuinely don't know it yet, that's decided
        // later at the Log Repairs step.
        $repairType = $preDiagnosed ? $entryMode : null;

        // A retired/archived vehicle is out of the fleet — no new work on it.
        $vehicle = Vehicle::findOrFail($data['vehicle_id']);
        abort_if(
            in_array($vehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'Cannot open a ticket on an archived or decommissioned vehicle.'
        );

        // The "no duplicate open Main Issue on this vehicle" check happens
        // again, for real, inside the transaction below under a row lock —
        // this is just a fast, friendly precheck so the common case gets an
        // immediate, well-formed error without waiting on a lock.
        $normalizedIncomingTitle = $this->normalizeTicketTitle($data['ticket_title']);
        $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_id', 'ticket_title'])
            ->first(fn ($t) => $this->normalizeTicketTitle($t->ticket_title) === $normalizedIncomingTitle);

        if ($duplicateMainIssue) {
            return response()->json([
                'message' => "This vehicle already has an open ticket for \"{$data['ticket_title']}\" (Ticket #{$duplicateMainIssue->ticket_id}). Add this as a sub-issue on that ticket instead of opening a new one."
            ], 422);
        }

        $custodian = User::findOrFail($data['assigned_custodian_id']);
        abort_unless($custodian->hasRole('Custodian'), 422, 'The selected user is not a Custodian.');
        abort_unless($custodian->barangay_id === $vehicle->barangay_id, 422, 'The selected Custodian does not belong to this barangay.');

        // #8 — a ticket's fault category defaults to the linked issue report's
        // standardized issue type when the Admin didn't pick one, so recurrence
        // and cost grouping have a reliable category to key on.
        $faultCategory = $data['fault_category'] ?? null;
        if (!$faultCategory && !empty($data['issue_report_id'])) {
            $faultCategory = optional(VehicleIssueReport::find($data['issue_report_id']))->issue_type;
        }

        // #9 — recurrence: how many times this same fault was already
        // fixed on this vehicle in the last 90 days — via a Closed ticket OR
        // a Completed Maintenance Record (a roadside/external-shop fix would
        // otherwise be invisible here). Keyed on fault_category when
        // available, else normalized title (best-effort).
        $recurrenceInfo = $this->checkRecurrence((int) $data['vehicle_id'], $faultCategory, $data['ticket_title']);
        $recurrence = $recurrenceInfo['count'];

        $ticket = DB::transaction(function () use ($data, $request, $recurrence, $recurrenceInfo, $preDiagnosed, $repairType, $faultCategory, $normalizedIncomingTitle) {
            // Lock the vehicle row first — serializes concurrent createTicket
            // calls for the SAME vehicle so two requests can't both pass the
            // "no duplicate Main Issue" check before either has inserted.
            // Same TOCTOU class, same fix, as AuthController::register()'s
            // Barangay lock: registrations/tickets for a DIFFERENT vehicle
            // lock a different row and proceed independently.
            $vehicle = Vehicle::where('vehicle_id', $data['vehicle_id'])->lockForUpdate()->first();

            $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
                ->whereNotIn('status', ['Closed', 'Cancelled'])
                ->get(['ticket_id', 'ticket_title'])
                ->first(fn ($t) => $this->normalizeTicketTitle($t->ticket_title) === $normalizedIncomingTitle);

            abort_if(
                $duplicateMainIssue,
                422,
                "This vehicle already has an open ticket for \"{$data['ticket_title']}\" (Ticket #{$duplicateMainIssue?->ticket_id}). Add this as a sub-issue on that ticket instead of opening a new one."
            );

            $ticket = MaintenanceTicket::create([
                'vehicle_id'            => $data['vehicle_id'],
                'issue_report_id'       => $data['issue_report_id'] ?? null,
                'created_by'            => $request->user()->id,
                'ticket_title'          => $data['ticket_title'],
                'fault_category'        => $faultCategory,
                'ticket_description'    => $data['ticket_description'],
                'priority'              => $data['priority'],
                // #1 — pre-diagnosed tickets are born Active (inspection skipped);
                // inspection-mode tickets start Open awaiting the Custodian.
                'status'                => $preDiagnosed ? 'Active' : 'Open',
                // #3 — pre-diagnosed means the vehicle is already down; default
                // the downtime clock to now unless a real (possibly backdated)
                // time was supplied.
                'down_since'            => $data['down_since'] ?? ($preDiagnosed ? now() : null),
                'assigned_custodian_id' => $data['assigned_custodian_id'],
                'assigned_at'           => now(),
                'recurrence_count'      => $recurrence,
                // #9 — the most recent prior occurrence, so "it broke again"
                // is a clickable link, not just a count. This FK only ever
                // points at another TICKET — when the last occurrence was a
                // Maintenance Record instead, there's nothing to link here,
                // but recurrence_count above still reflects it.
                'recurrence_of_ticket_id' => $recurrenceInfo['last_type'] === 'ticket' ? $recurrenceInfo['last_id'] : null,
            ]);

            if ($preDiagnosed) {
                // The problem is already known: record the sub-issues now and
                // stamp a skipped-inspection so the audit trail is honest.
                foreach ($data['sub_issues'] as $sub) {
                    TicketSubIssue::create([
                        'ticket_id'          => $ticket->ticket_id,
                        'created_by'         => $request->user()->id,
                        'title'              => $sub['title'],
                        'maintenance_type'   => $sub['maintenance_type'] ?? null,
                        'repair_type'        => $repairType,
                        'source_vehicle_id'  => $repairType === 'cannibalized' ? ($data['source_vehicle_id'] ?? null) : null,
                        'external_vendor'    => $repairType === 'external' ? ($data['external_vendor'] ?? null) : null,
                        'warranty_until'     => $repairType === 'external' ? ($data['warranty_until'] ?? null) : null,
                        'status'             => 'Open',
                    ]);
                }
                $ticket->update([
                    'inspection_result' => 'Needs Maintenance',
                    'inspection_notes'  => 'Pre-diagnosed at creation — inspection skipped (issue already known).',
                    'inspected_by'      => $request->user()->id,
                    'inspected_at'      => now(),
                ]);
                // Known problem => the vehicle is out of service immediately.
                $vehicle->update(['condition' => 'Needs Repair', 'status' => 'Under Maintenance']);
            }

            if (!empty($data['issue_report_id'])) {
                VehicleIssueReport::where('issue_report_id', $data['issue_report_id'])->update([
                    'status' => 'In Maintenance',
                ]);
            }

            // Set once, never touched again — Condition Monitoring reads the
            // linked ticket's live status through this instead of a snapshot,
            // so the historical check row itself never has to change.
            if (!empty($data['condition_check_id'])) {
                VehicleConditionCheck::where('condition_check_id', $data['condition_check_id'])->update([
                    'resulting_ticket_id' => $ticket->ticket_id,
                ]);
            }

            $repairTypeLabels = ['in_house' => 'in-house repair', 'cannibalized' => 'cannibalized part', 'external' => 'external shop'];
            $repairTypeLabel = $repairTypeLabels[$repairType] ?? $repairType;
            $modeLabel = $preDiagnosed ? "pre-diagnosed as {$repairTypeLabel} (inspection skipped)" : 'assigned to custodian for inspection';
            $this->log($request, 'Create Ticket', "Ticket #{$ticket->ticket_id} ({$data['ticket_title']}) created for {$vehicle->vehicle_name} — {$modeLabel}.");

            if ($preDiagnosed) {
                $this->notifyAdmins(
                    'Pre-Diagnosed Ticket Ready for Assignment',
                    "Ticket #{$ticket->ticket_id} ({$data['ticket_title']}) on {$vehicle->vehicle_name} is pre-diagnosed ({$repairTypeLabel}) and ready — assign a mechanic to each sub-issue.",
                    'ticket_prediagnosed',
                    $ticket->ticket_id,
                    $vehicle->barangay_id
                );
            } else {
                $this->notifyUser(
                    $ticket->assigned_custodian_id,
                    'New Inspection Assignment',
                    "Ticket #{$ticket->ticket_id} for {$vehicle->vehicle_name} has been assigned to you for physical inspection.",
                    'inspection_assigned',
                    $ticket->ticket_id
                );
            }

            // #9 — a repeat failure is worth flagging loudly, not hiding in a counter.
            if ($recurrence > 0) {
                $lastFixSource = $recurrenceInfo['last_type'] === 'record'
                    ? "Maintenance Record #{$recurrenceInfo['last_id']}"
                    : "Ticket #{$recurrenceInfo['last_id']}";
                // Was hardcoded "th" regardless of number ("3th time") — fixed
                // to the same ordinal-suffix pattern used in the ticket detail
                // page's own "Recurring — Nth time" badge.
                // Indexed by $recurrence directly (not -1) — same convention as
                // the ticket detail page's ['st','nd','rd'][ticket.recurrence_count].
                $ordinal = ['st', 'nd', 'rd'][$recurrence] ?? 'th';
                $this->notifyAdmins(
                    'Recurring Fault Detected',
                    "This is the " . ($recurrence + 1) . "{$ordinal} time \"" . ($faultCategory ?? $data['ticket_title']) . "\" has been logged on {$vehicle->vehicle_name} in 90 days — last fixed via {$lastFixSource} (Ticket #{$ticket->ticket_id}). Consider a deeper fix or decommission review.",
                    'recurring_fault',
                    $ticket->ticket_id,
                    $vehicle->barangay_id
                );
            }

            return $ticket;
        });

        return response()->json($ticket->load($this->eagerLoads()), 201);
    }

    // ===================================================================
    // PHASE 2 — Custodian: Submit Inspection, Populate Sub-Issues
    // ===================================================================

    public function submitInspection(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireRole($request, ['Custodian']);

        abort_unless($ticket->assigned_custodian_id === $request->user()->id, 403, 'This ticket is not assigned to you.');
        abort_unless($ticket->status === 'Open', 422, "Inspection can only be submitted when the ticket is Open. Current status: {$ticket->status}.");

        $data = $request->validate([
            'inspection_result'             => ['required', Rule::in(['Needs Maintenance', 'No Issues'])],
            'inspection_notes'               => ['nullable', 'string'],
            'sub_issues'                     => ['required_if:inspection_result,Needs Maintenance', 'array', 'min:1'],
            'sub_issues.*.title'             => ['required_with:sub_issues', 'string', 'max:255'],
            'sub_issues.*.maintenance_type'  => ['nullable', 'string', 'max:150'],
        ]);

        if (!empty($data['sub_issues'])) {
            foreach ($data['sub_issues'] as &$subIssueInput) {
                if (!empty($subIssueInput['maintenance_type'])) {
                    $subIssueInput['maintenance_type'] = MaintenanceType::resolve($subIssueInput['maintenance_type']);
                }
            }
            unset($subIssueInput);
        }

        DB::transaction(function () use ($ticket, $data, $request) {
            $ticket->update([
                'status'            => 'Active',
                'inspection_result' => $data['inspection_result'],
                'inspection_notes'  => $data['inspection_notes'] ?? null,
                'inspected_by'      => $request->user()->id,
                'inspected_at'      => now(),
            ]);

            if ($data['inspection_result'] === 'Needs Maintenance') {
                foreach ($data['sub_issues'] as $subIssue) {
                    TicketSubIssue::create([
                        'ticket_id'        => $ticket->ticket_id,
                        'created_by'       => $request->user()->id,
                        'title'            => $subIssue['title'],
                        'maintenance_type' => $subIssue['maintenance_type'] ?? null,
                        'status'           => 'Open',
                    ]);
                }
                // Status and condition move together — the moment the
                // Custodian confirms a real problem, the vehicle is no
                // longer available for dispatch, regardless of whether a
                // mechanic has been assigned yet.
                $ticket->vehicle->update([
                    'condition' => 'Needs Repair',
                    'status'    => 'Under Maintenance',
                ]);
            } elseif ($ticket->vehicle->condition !== 'Good') {
                // "No Issues" clears whatever flagged this vehicle for
                // inspection in the first place — don't leave it reading
                // Needs Inspection after it's just been cleared.
                $ticket->vehicle->update(['condition' => 'Good']);
            }

            $count = $data['inspection_result'] === 'Needs Maintenance' ? count($data['sub_issues']) : 0;
            $this->log($request, 'Inspection Submitted', "Ticket #{$ticket->ticket_id} inspected. Result: {$data['inspection_result']}" . ($count ? " ({$count} sub-issue(s) logged)." : '.'));

            $vehicleName = $ticket->vehicle->vehicle_name;
            $custodianName = $request->user()->name;
            $this->notifyAdmins(
                'Inspection Submitted',
                "Custodian {$custodianName} submitted inspection for Ticket #{$ticket->ticket_id} ({$vehicleName}). Result: {$data['inspection_result']}.",
                'inspection_submitted',
                $ticket->ticket_id,
                $ticket->vehicle->barangay_id
            );
        });

        return $ticket->fresh($this->eagerLoads());
    }

    /**
     * PUT /tickets/:ticket/sub-issues — append a newly discovered root
     * cause to a still-Active ticket. Once the ticket is Closed, this is
     * never available — a new issue at that point must open a fresh ticket.
     *
     * Deliberately NOT available to Admin. Declaring "there's another real
     * problem with this vehicle" requires firsthand contact with it — the
     * same reason the initial inspection is Custodian-only. Only the
     * assigned Custodian (re-inspecting) or a mechanic already working a
     * sub-issue on this ticket (found something else mid-repair) has that
     * standing. An Admin who genuinely needs to log a discovery does it by
     * holding the Custodian/Maintenance role on their account and acting
     * under that hat — not through an office role with no firsthand basis.
     */
    public function addSubIssue(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireRole($request, ['Custodian', 'Maintenance Personnel']);
        $user = $request->user();

        $isAssignedCustodian = $user->hasRole('Custodian') && $ticket->assigned_custodian_id === $user->id;
        $isAssignedMechanic = $user->hasRole('Maintenance Personnel')
            && $ticket->subIssues()->where('assigned_mechanic_id', $user->id)->exists();

        abort_unless($isAssignedCustodian || $isAssignedMechanic, 403, 'You are not currently assigned to this ticket.');

        abort_unless($ticket->status === 'Active', 422, "Sub-issues can only be added while the ticket is Active. Current status: {$ticket->status}.");

        $data = $request->validate([
            'title'            => ['required', 'string', 'max:255'],
            'maintenance_type' => ['nullable', 'string', 'max:150'],
            'issue_report_id'  => ['nullable', 'exists:vehicle_issue_reports,issue_report_id'],
        ]);

        if (!empty($data['maintenance_type'])) {
            $data['maintenance_type'] = MaintenanceType::resolve($data['maintenance_type']);
        }

        $subIssue = DB::transaction(function () use ($ticket, $data, $request) {
            $subIssue = TicketSubIssue::create([
                'ticket_id'        => $ticket->ticket_id,
                'issue_report_id'  => $data['issue_report_id'] ?? null,
                'created_by'       => $request->user()->id,
                'title'            => $data['title'],
                'maintenance_type' => $data['maintenance_type'] ?? null,
                'status'           => 'Open',
            ]);

            if (!empty($data['issue_report_id'])) {
                VehicleIssueReport::where('issue_report_id', $data['issue_report_id'])->update(['status' => 'In Maintenance']);
            }

            $progress = $ticket->fresh()->progress;
            $this->log($request, 'Sub-Issue Added', "Ticket #{$ticket->ticket_id} — sub-issue \"{$data['title']}\" added. Progress {$progress['done']}/{$progress['total']}.");

            return $subIssue;
        });

        return response()->json($subIssue, 201);
    }

    // ===================================================================
    // PHASE 3 — Admin: Assign Mechanic to a Sub-Issue (Work Order)
    // ===================================================================

    public function assignMechanic(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireRole($request, ['Admin']);
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "Work orders can only be dispatched while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Open', 422, "A mechanic can only be assigned when the sub-issue is Open. Current: {$subIssue->status}.");

        $data = $request->validate([
            'assigned_mechanic_id' => ['required', 'exists:users,id'],
            'maintenance_type'     => ['required', 'string', 'max:150'],
            'work_order_notes'     => ['nullable', 'string'],
        ]);

        $data['maintenance_type'] = MaintenanceType::resolve($data['maintenance_type']);

        $mechanic = User::findOrFail($data['assigned_mechanic_id']);
        abort_unless($mechanic->hasRole('Maintenance Personnel'), 422, 'The selected user is not Maintenance Personnel.');
        abort_unless($mechanic->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected mechanic does not belong to this barangay.');

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            // Lock the sub-issue row for the duration of this assignment so
            // two concurrent work-order dispatches on the same sub-issue
            // serialize instead of racing.
            TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();

            $subIssue->update([
                'status'               => 'Under Repair',
                'assigned_mechanic_id' => $data['assigned_mechanic_id'],
                'maintenance_type'     => $data['maintenance_type'],
                'work_order_notes'     => $data['work_order_notes'] ?? null,
                'mechanic_assigned_at' => now(),
                'mechanic_assigned_by' => $request->user()->id,
            ]);

            $this->recomputeVehicleStatus($ticket->vehicle_id);

            $this->log($request, 'Mechanic Assigned', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" assigned to mechanic ID {$data['assigned_mechanic_id']}.");

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->notifyUser(
                $data['assigned_mechanic_id'],
                'New Work Order Assigned',
                "You have been assigned to \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}).",
                'work_order_assigned',
                $ticket->ticket_id
            );
        });

        return $subIssue->fresh();
    }

    /**
     * PUT /tickets/:ticket/sub-issues/:subIssue/reassign-mechanic — hand an
     * in-progress work order to a different mechanic (e.g. the assigned one is
     * out sick), so a repair on the only ambulance is never frozen. Only while
     * Under Repair; the reason and both mechanics are recorded.
     */
    public function reassignMechanic(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireRole($request, ['Admin']);
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "Work orders can only be reassigned while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Under Repair', 422, "A work order can only be reassigned while it is Under Repair. Current: {$subIssue->status}.");

        $data = $request->validate([
            'assigned_mechanic_id' => ['required', 'exists:users,id'],
            'reassign_reason'      => ['required', 'string'],
        ]);

        $newMechanic = User::findOrFail($data['assigned_mechanic_id']);
        abort_unless($newMechanic->hasRole('Maintenance Personnel'), 422, 'The selected user is not Maintenance Personnel.');
        abort_unless($newMechanic->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected mechanic does not belong to this barangay.');
        abort_if($newMechanic->id === $subIssue->assigned_mechanic_id, 422, 'That mechanic is already assigned to this work order.');

        $previousMechanicId = $subIssue->assigned_mechanic_id;

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $newMechanic, $previousMechanicId) {
            $previousName = $previousMechanicId ? (User::find($previousMechanicId)?->name ?? 'the previous mechanic') : 'the previous mechanic';

            $subIssue->update([
                'assigned_mechanic_id' => $data['assigned_mechanic_id'],
                'mechanic_assigned_at' => now(),
                'mechanic_assigned_by' => $request->user()->id,
            ]);

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->log($request, 'Work Order Reassigned', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" reassigned from {$previousName} to {$newMechanic->name}. Reason: {$data['reassign_reason']}");

            // Let the new mechanic know they're now on it...
            $this->notifyUser(
                $newMechanic->id,
                'Work Order Reassigned to You',
                "You have been assigned to \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}).",
                'work_order_assigned',
                $ticket->ticket_id
            );
            // ...and the previous mechanic that it's off their plate.
            if ($previousMechanicId) {
                $this->notifyUser(
                    $previousMechanicId,
                    'Work Order Reassigned',
                    "\"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}) was reassigned to {$newMechanic->name}.",
                    'work_order_reassigned',
                    $ticket->ticket_id
                );
            }
        });

        return $subIssue->fresh();
    }

    // ===================================================================
    // Admin: Reassign the ticket's Custodian
    // ===================================================================

    /**
     * The Custodian chosen at creation is hard-locked as BOTH the inspector
     * (submitInspection) and the verifier (verifyRepair, via each sub-issue's
     * verification_assigned_to). Without this endpoint, that person going on
     * leave or leaving the barangay strands the ticket permanently: nobody
     * else can inspect it, nobody else can verify its repairs, and a ticket
     * still sitting at Open can't even be closed (closeTicket requires
     * Active) — the only exits were cancel or delete.
     *
     * Deliberately narrow, mirroring reassignMechanic(): this changes WHO is
     * responsible and nothing else. It cannot touch status, verdicts, costs,
     * or sub-issue content, so it can't be used to rewrite history.
     */
    public function reassignCustodian(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireRole($request, ['Admin']);

        // Allowed while Open (stuck awaiting inspection — the main case this
        // exists for) or Active. A finished ticket is left alone: reassigning
        // responsibility for completed work would only muddy the audit trail.
        abort_if(
            in_array($ticket->status, ['Closed', 'Cancelled'], true),
            422,
            "A {$ticket->status} ticket's Custodian cannot be reassigned."
        );

        $data = $request->validate([
            'assigned_custodian_id' => ['required', 'exists:users,id'],
            'reassign_reason'       => ['required', 'string'],
        ], [
            'reassign_reason.required' => 'A reason is required so the audit trail shows why responsibility moved.',
        ]);

        $newCustodian = User::findOrFail($data['assigned_custodian_id']);
        abort_unless($newCustodian->hasRole('Custodian'), 422, 'The selected user is not a Custodian.');
        abort_unless($newCustodian->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected Custodian does not belong to this barangay.');
        abort_if($newCustodian->id === $ticket->assigned_custodian_id, 422, 'That Custodian is already assigned to this ticket.');

        $previousCustodianId = $ticket->assigned_custodian_id;

        DB::transaction(function () use ($ticket, $data, $request, $newCustodian, $previousCustodianId) {
            $previousName = User::find($previousCustodianId)?->name ?? 'the previous Custodian';

            $ticket->update(['assigned_custodian_id' => $newCustodian->id]);

            // Sub-issues already handed off for verification have the OLD
            // custodian stamped on them (logRepairs copies it at that moment),
            // and verifyRepair matches on that stamp — so without this cascade
            // the reassignment wouldn't actually unstick those verifications.
            // Sub-issues not yet at that stage need nothing: they'll pick up
            // the new custodian from the ticket when they reach logRepairs.
            $cascaded = $ticket->subIssues()
                ->where('status', 'For Inspection')
                ->update(['verification_assigned_to' => $newCustodian->id]);

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->log(
                $request,
                'Custodian Reassigned',
                "Ticket #{$ticket->ticket_id} — Custodian reassigned from {$previousName} to {$newCustodian->name}."
                . ($cascaded > 0 ? " {$cascaded} pending verification(s) moved with it." : '')
                . " Reason: {$data['reassign_reason']}"
            );

            $this->notifyUser(
                $newCustodian->id,
                'Ticket Reassigned to You',
                "You are now the Custodian for Ticket #{$ticket->ticket_id} ({$vehicleName})."
                . ($cascaded > 0 ? " {$cascaded} repair(s) are awaiting your verification." : ''),
                'ticket_reassigned',
                $ticket->ticket_id
            );

            if ($previousCustodianId) {
                $this->notifyUser(
                    $previousCustodianId,
                    'Ticket Reassigned',
                    "Ticket #{$ticket->ticket_id} ({$vehicleName}) was reassigned to {$newCustodian->name}.",
                    'ticket_reassigned',
                    $ticket->ticket_id
                );
            }
        });

        return $ticket->fresh($this->eagerLoads());
    }

    // ===================================================================
    // PHASE 3 — Mechanic: Log Repair on a Sub-Issue
    // ===================================================================

    public function logRepairs(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireRole($request, ['Maintenance Personnel']);
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($subIssue->assigned_mechanic_id === $request->user()->id, 403, 'This work order is not assigned to you.');
        abort_unless($ticket->status === 'Active', 422, "Repairs can only be logged while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Under Repair', 422, "Repairs can only be logged when the sub-issue is Under Repair. Current: {$subIssue->status}.");

        $data = $request->validate([
            'repair_logs'           => ['required', 'string'],
            'parts_used'            => ['nullable', 'string'],
            'photo'                 => ['nullable', 'file', 'mimes:jpg,jpeg,png,pdf,doc,docx', 'max:8192'],
            'repair_started_at'     => ['nullable', 'date'],
            'repair_completed_at'   => ['nullable', 'date'],
            'maintenance_cost'      => ['nullable', 'numeric', 'min:0'],
            'estimated_return_date' => ['nullable', 'date'],
            // May already be set from ticket creation (pre-diagnosed) — this
            // lets the mechanic confirm it, or correct it if the actual
            // repair ended up differing from the original plan.
            'repair_type'           => ['nullable', Rule::in(['in_house', 'cannibalized', 'external'])],
            'source_vehicle_id'     => ['nullable', 'required_if:repair_type,cannibalized', 'exists:vehicles,vehicle_id'],
            'external_vendor'       => ['nullable', 'string', 'max:255'],
            'warranty_until'        => ['nullable', 'date'],
        ]);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            $existingLogs = $subIssue->repair_logs ? $subIssue->repair_logs . "\n\n" : '';

            $subIssue->update([
                'status'                    => 'For Inspection',
                'verification_assigned_to'  => $ticket->assigned_custodian_id,
                'repair_logs'               => $existingLogs . '[' . now()->format('Y-m-d H:i') . '] ' . $data['repair_logs'],
                'parts_used'                => $data['parts_used'] ?? $subIssue->parts_used,
                'attachment_url'            => $request->hasFile('photo')
                    ? $this->storeUploadedImage($request->file('photo'), 'repair-attachments')
                    : $subIssue->attachment_url,
                'repair_started_at'         => $data['repair_started_at'] ?? $subIssue->repair_started_at,
                'repair_completed_at'       => $data['repair_completed_at'] ?? null,
                'maintenance_cost'          => $data['maintenance_cost'] ?? $subIssue->maintenance_cost,
                'repair_type'               => $data['repair_type'] ?? $subIssue->repair_type,
                'source_vehicle_id'         => ($data['repair_type'] ?? $subIssue->repair_type) === 'cannibalized'
                    ? ($data['source_vehicle_id'] ?? $subIssue->source_vehicle_id)
                    : null,
                'external_vendor'           => ($data['repair_type'] ?? $subIssue->repair_type) === 'external'
                    ? ($data['external_vendor'] ?? $subIssue->external_vendor)
                    : null,
                'warranty_until'            => ($data['repair_type'] ?? $subIssue->repair_type) === 'external'
                    ? ($data['warranty_until'] ?? $subIssue->warranty_until)
                    : null,
            ]);

            if (array_key_exists('estimated_return_date', $data) && $data['estimated_return_date']) {
                $ticket->vehicle->update(['estimated_return_date' => $data['estimated_return_date']]);
            }

            $this->log($request, 'Repairs Logged', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" repair logs submitted.");

            $mechanicName = $request->user()->name;
            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Verification Required: Repairs Completed',
                "Mechanic {$mechanicName} logged repair work for \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}). Please verify.",
                'repairs_completed',
                $ticket->ticket_id
            );
        });

        return $subIssue->fresh();
    }

    // ===================================================================
    // PHASE 4 Tier 1 — Custodian: Verify a Sub-Issue's Repair
    // ===================================================================

    public function verifyRepair(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireRole($request, ['Custodian']);
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($subIssue->verification_assigned_to === $request->user()->id, 403, "This verification is assigned to {$subIssue->verificationAssignedTo?->name}.");
        abort_unless($ticket->status === 'Active', 422, "Verification can only be submitted while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'For Inspection', 422, "Verification can only be submitted when the sub-issue is For Inspection. Current: {$subIssue->status}.");

        // Problem 2 — verification is now a real functional test ("UAT"):
        // the Custodian operates the vehicle against a checklist and attests
        // to it. This is deliberately the CUSTODIAN's gate, not the mechanic's
        // — the tester must be independent of whoever did the repair
        // ("don't grade your own homework"). A failed check cannot be
        // Approved; rejecting bounces the sub-issue back to Under Repair.
        $data = $request->validate([
            'verification_verdict'     => ['required', Rule::in(['Approved', 'Rejected'])],
            'verification_notes'       => ['nullable', 'string'],
            'functional_test'          => ['required', 'array', 'min:1'],
            'functional_test.*.item'   => ['required', 'string', 'max:255'],
            'functional_test.*.passed' => ['required', 'boolean'],
            'test_attested'            => ['boolean'],
        ]);

        $approved = $data['verification_verdict'] === 'Approved';

        if ($approved) {
            abort_unless(
                $request->boolean('test_attested'),
                422,
                'Before approving, you must attest that you actually operated and tested the vehicle.'
            );
            $anyFailed = collect($data['functional_test'])->contains(fn ($i) => !$i['passed']);
            abort_if(
                $anyFailed,
                422,
                'This functional test has a failed check — it cannot be Approved. Reject it so the mechanic can redo the work.'
            );
        }

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $approved) {
            // Lock the sub-issue row for the duration of this verification
            // so it can't race a concurrent verify/confirm on the same
            // sub-issue.
            TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();

            $subIssue->update([
                'status'               => $approved ? 'For Confirmation' : 'Under Repair',
                'verification_verdict' => $data['verification_verdict'],
                'verification_notes'   => $data['verification_notes'] ?? null,
                'verified_by'          => $request->user()->id,
                'verified_at'          => now(),
                'repair_completed_at'  => $approved ? $subIssue->repair_completed_at : null,
                'functional_test'      => $data['functional_test'],
                'test_attested'        => $request->boolean('test_attested'),
            ]);

            $this->log($request, 'Repair Verified', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" verification: {$data['verification_verdict']}.");

            $custodianName = $request->user()->name;
            $vehicleName = $ticket->vehicle->vehicle_name;
            if ($approved) {
                $this->notifyAdmins(
                    'Repairs Approved by Custodian',
                    "Custodian {$custodianName} approved \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}). Please give final confirmation.",
                    'repairs_approved',
                    $ticket->ticket_id,
                    $ticket->vehicle->barangay_id
                );
            } else {
                $this->notifyUser(
                    $subIssue->assigned_mechanic_id,
                    'Work Order Rejected',
                    "Custodian {$custodianName} rejected \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}). Please re-perform repairs.",
                    'repairs_rejected',
                    $ticket->ticket_id
                );
            }
        });

        return $subIssue->fresh();
    }

    // ===================================================================
    // PHASE 4 Tier 2 — Admin: Confirm (or Rework) a Sub-Issue
    // ===================================================================

    public function confirmSubIssue(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireRole($request, ['Admin']);
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "A sub-issue can only be confirmed while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'For Confirmation', 422, "A sub-issue can only be confirmed when it is For Confirmation. Current: {$subIssue->status}.");

        $data = $request->validate([
            'confirmation_verdict' => ['required', Rule::in(['Confirmed', 'Reopened'])],
            'confirmation_notes'   => ['nullable', 'string'],
        ]);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            // Lock the sub-issue row for the duration of this confirmation
            // so it can't race a concurrent confirm/reopen on the same
            // sub-issue (e.g. closeTicket() finalizing it at the same time).
            TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();

            $confirmed = $data['confirmation_verdict'] === 'Confirmed';
            $vehicleName = $ticket->vehicle->vehicle_name;

            if ($confirmed) {
                $this->finalizeConfirmedSubIssue($ticket, $subIssue, $request->user()->id, $data['confirmation_notes'] ?? null);

                $progress = $ticket->fresh()->progress;
                $this->log($request, 'Sub-Issue Confirmed', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" confirmed Done. Progress {$progress['done']}/{$progress['total']}.");

                $this->notifyUser(
                    $ticket->assigned_custodian_id,
                    'Sub-Issue Confirmed',
                    "\"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}) has been confirmed Done ({$progress['done']}/{$progress['total']}).",
                    'sub_issue_confirmed',
                    $ticket->ticket_id
                );

                if ($progress['done'] === $progress['total']) {
                    $this->notifyAdmins(
                        'Ticket Ready to Close',
                        "All sub-issues on Ticket #{$ticket->ticket_id} ({$vehicleName}) are Done ({$progress['done']}/{$progress['total']}). You may now close the ticket.",
                        'ticket_ready_to_close',
                        $ticket->ticket_id,
                        $ticket->vehicle->barangay_id
                    );
                }
            } else {
                // Rework loop — the sub-issue isn't actually done yet, so
                // this is not the "reopen a Closed ticket" case at all.
                $subIssue->update([
                    'status'               => 'Under Repair',
                    'confirmation_verdict' => 'Reopened',
                    'confirmation_notes'   => $data['confirmation_notes'] ?? null,
                    'confirmed_by'         => $request->user()->id,
                    'confirmed_at'         => now(),
                    'verification_verdict' => null,
                    'verification_notes'   => null,
                    'verified_by'          => null,
                    'verified_at'          => null,
                    'repair_completed_at'  => null,
                ]);

                $this->log($request, 'Sub-Issue Sent Back', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" sent back to Under Repair by Admin.");

                $this->notifyUser(
                    $subIssue->assigned_mechanic_id,
                    'Work Order Sent Back',
                    "\"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}) was sent back by Admin. Please re-perform repairs.",
                    'work_order_reopened',
                    $ticket->ticket_id
                );
            }
        });

        return $subIssue->fresh();
    }

    public function reopenConfirmedSubIssue(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireRole($request, ['Admin']);
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($subIssue->status === 'Done', 422, "Only Done sub-issues can be unconfirmed. Current status: {$subIssue->status}.");
        abort_unless($subIssue->confirmation_verdict === 'Confirmed', 422, "Only confirmed sub-issues can be unconfirmed.");
        abort_unless($ticket->status === 'Active', 422, "Ticket must be Active to unconfirm a sub-issue.");

        $data = $request->validate([
            'reopen_reason' => ['nullable', 'string'],
        ]);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            $subIssue->update([
                'status'                   => 'For Inspection',
                // Re-stamp to the ticket's CURRENT custodian — not whoever
                // was custodian back when this sub-issue first reached
                // Done. Without this, a custodian reassigned off the
                // ticket while a sub-issue sat Done/Confirmed leaves that
                // stale id here, and verifyRepair() checks only against
                // verification_assigned_to, so the real current custodian
                // gets blocked from re-verifying (see reassignCustodian(),
                // which cascades the same field for pending 'For
                // Inspection' sub-issues at reassignment time).
                'verification_assigned_to' => $ticket->assigned_custodian_id,
                'verification_verdict'     => null,
                'verification_notes'       => null,
                'verified_by'              => null,
                'verified_at'              => null,
                'confirmation_verdict'     => null,
                'confirmation_notes'       => $data['reopen_reason'] ?? null,
                'confirmed_by'             => null,
                'confirmed_at'             => null,
                'reopened_by'              => $request->user()->id,
                'reopened_at'              => now(),
            ]);

            $this->log($request, 'Confirmed Sub-Issue Reopened', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" reopened by Admin. Reason: {$data['reopen_reason']}");

            $vehicleName = $ticket->vehicle->vehicle_name;
            $adminName = $request->user()->name;
            $reason = $data['reopen_reason'] ? "Reason: {$data['reopen_reason']}" : 'Admin request for re-verification.';

            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Repair Re-Verification Required',
                "Admin {$adminName} has reopened \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}) for re-verification. {$reason}",
                'repair_reopened_for_verification',
                $ticket->ticket_id
            );
        });

        return $subIssue->fresh();
    }

    // ===================================================================
    // PHASE 5 — Admin: Explicit Ticket Closure (only at N/N)
    // ===================================================================

    public function closeTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireRole($request, ['Admin']);

        abort_unless($ticket->status === 'Active', 422, "Only an Active ticket can be closed. Current: {$ticket->status}.");

        $ticket->load('subIssues');

        $data = $request->validate([
            'closing_notes'       => ['nullable', 'string'],
            'deferral_reason'     => ['nullable', 'string'],
            'returned_to_service' => ['nullable', 'boolean'],
        ]);

        // A "decision-close" is any close made while sub-issues are still
        // unfinished (not Done, not already Deferred). The Admin is choosing
        // to end the ticket anyway — so the leftovers become Deferred, and
        // the Admin must justify it AND make the fit-for-service call.
        //
        // A sub-issue already sitting at For Confirmation is NOT part of
        // that "unfinished" bucket: the Custodian already ran the
        // functional test and Approved it (that's the only way to reach
        // this status — see verifyRepair()), so there's nothing left to
        // decide. Closing the ticket finalizes it exactly like an Admin
        // hitting "Confirm" would — see finalizeConfirmedSubIssue(). Only
        // genuinely open/in-progress sub-issues get deferred.
        $unresolved = $ticket->unresolvedSubIssues();
        $toFinalize = $unresolved->filter(fn ($s) => $s->status === 'For Confirmation');
        $toDefer = $unresolved->reject(fn ($s) => $s->status === 'For Confirmation');
        $isDecisionClose = $toDefer->isNotEmpty();

        if ($isDecisionClose) {
            abort_if(
                blank($data['deferral_reason'] ?? null),
                422,
                'This ticket still has unfinished sub-issues. To close it now, provide a reason — they will be recorded as Deferred.'
            );
            abort_unless(
                array_key_exists('returned_to_service', $data) && $data['returned_to_service'] !== null,
                422,
                'You must state whether the vehicle is fit to return to service before closing with unfinished work.'
            );
        }

        // A clean close (everything already Done/Deferred) returns the
        // vehicle to service as before; a decision-close honours the
        // Admin's explicit fit-for-service answer.
        $returnToService = $isDecisionClose ? (bool) $data['returned_to_service'] : true;

        DB::transaction(function () use ($ticket, $data, $request, $toDefer, $toFinalize, $returnToService, $isDecisionClose) {
            // Lock the ticket row for the duration of this close so a
            // concurrent action on the same ticket (another close, a
            // confirm, a defer) serializes behind this one instead of
            // racing it.
            MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->lockForUpdate()->first();

            $vehicleName = $ticket->vehicle->vehicle_name;

            // Already-verified-and-approved sub-issues finalize exactly like
            // an explicit Confirm would — see the comment above.
            foreach ($toFinalize as $subIssue) {
                $this->finalizeConfirmedSubIssue($ticket, $subIssue, $request->user()->id, $data['closing_notes'] ?? null);
            }

            // Sweep every still-unfinished (and non-confirmable) sub-issue
            // into Deferred, each with the shared reason and its own
            // forget-me-not breadcrumb.
            $deferredReportIds = [];
            foreach ($toDefer as $subIssue) {
                $rid = $this->deferOneSubIssue($ticket, $subIssue, $data['deferral_reason'], $request->user()->id);
                if ($rid) {
                    $deferredReportIds[] = $rid;
                }
            }

            $ticket->update([
                'status'              => 'Closed',
                'closed_by'           => $request->user()->id,
                'closed_at'           => now(),
                'closing_notes'       => $data['closing_notes'] ?? null,
                'returned_to_service' => $returnToService,
                'archived_at'         => now(),
            ]);

            // Resolve the ticket's originating report only on a fit-for-service
            // close, and never if that same report was just deferred instead.
            if ($ticket->issue_report_id && $returnToService && !in_array($ticket->issue_report_id, $deferredReportIds, true)) {
                VehicleIssueReport::where('issue_report_id', $ticket->issue_report_id)->update(['status' => 'Resolved']);
            }

            $ticket->refresh()->load('subIssues');
            $this->archiveCompleted($ticket, $request->user()->id, 'Closed');

            // Single choke point + fit-for-service gate: closing frees the
            // vehicle ONLY if the Admin judged it fit. If not, the ticket is
            // closed but the vehicle stays flagged out of service (the
            // deferred defect lives on as its breadcrumb Issue Report).
            if ($returnToService) {
                $this->recomputeVehicleStatus($ticket->vehicle_id);
            } else {
                Vehicle::where('vehicle_id', $ticket->vehicle_id)->update([
                    'status'    => 'Under Maintenance',
                    'condition' => 'Needs Repair',
                ]);
            }

            $progress = $ticket->progress;
            $summary = $isDecisionClose
                ? "Decision-close: {$progress['deferred']} sub-issue(s) deferred. Fit for service: " . ($returnToService ? 'Yes' : 'No') . '.'
                : "Progress: {$progress['done']}/{$progress['total']}.";
            $this->log($request, 'Ticket Closed', "Ticket #{$ticket->ticket_id} ({$vehicleName}) closed by Admin. {$summary}");

            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Ticket Closed',
                "Ticket #{$ticket->ticket_id} ({$vehicleName}) has been closed by Admin." . ($isDecisionClose ? ' Some sub-issues were deferred.' : ''),
                'ticket_closed',
                $ticket->ticket_id
            );
            foreach ($ticket->subIssues->pluck('assigned_mechanic_id')->filter()->unique() as $mechanicId) {
                $this->notifyUser($mechanicId, 'Ticket Closed', "Ticket #{$ticket->ticket_id} ({$vehicleName}) has been closed by Admin.", 'ticket_closed', $ticket->ticket_id);
            }
        });

        return $ticket->fresh($this->eagerLoads());
    }

    /**
     * PUT /tickets/:ticket/sub-issues/:subIssue/defer — Admin records a
     * decision NOT to fix a single sub-issue now (no budget, part on
     * back-order, etc.). It becomes Deferred (a terminal, "resolved" state)
     * with a mandatory reason, and a breadcrumb Issue Report is opened so
     * the unfixed defect isn't forgotten. Available while the ticket is
     * Active and the sub-issue hasn't already ended.
     */
    public function deferSubIssue(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireRole($request, ['Admin']);
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "Sub-issues can only be deferred while the ticket is Active. Current: {$ticket->status}.");
        abort_if($subIssue->isResolved(), 422, "This sub-issue is already {$subIssue->status} and cannot be deferred.");
        // For Confirmation means the Custodian already verified the repair
        // works — there's nothing left to "decide not to fix". Confirm or
        // Reopen is the only choice that still makes sense at that point.
        abort_if($subIssue->status === 'For Confirmation', 422, 'This sub-issue has already been repaired and verified — confirm or reopen it instead of deferring.');

        $data = $request->validate([
            'deferred_reason' => ['required', 'string'],
        ]);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            $this->deferOneSubIssue($ticket, $subIssue, $data['deferred_reason'], $request->user()->id);
            $this->recomputeVehicleStatus($ticket->vehicle_id);

            $this->log($request, 'Sub-Issue Deferred', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" deferred: {$data['deferred_reason']}");

            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Sub-Issue Deferred',
                "\"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$ticket->vehicle->vehicle_name}) was deferred by Admin. A follow-up issue report was opened so it isn't forgotten.",
                'sub_issue_deferred',
                $ticket->ticket_id
            );
        });

        return $subIssue->fresh();
    }

    /**
     * PUT /tickets/:ticket/cancel — Admin cancels a ticket at any stage
     * before it's Closed.
     */
    public function cancelTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireRole($request, ['Admin']);

        abort_unless(!in_array($ticket->status, ['Closed', 'Cancelled'], true), 422, 'This ticket is already closed and cannot be cancelled.');

        // Every sub-issue already resolved (fixed or deferred) — this is
        // real, confirmed repair work on record, not something to void.
        // Close it instead; cancel is for abandoning a ticket, not for
        // discarding finished work.
        abort_if(
            $ticket->subIssues->isNotEmpty() && $ticket->unresolvedSubIssues()->isEmpty(),
            422,
            'This ticket\'s repairs are already complete — close it instead of cancelling.'
        );

        $data = $request->validate([
            'closing_notes' => ['nullable', 'string'],
        ]);

        DB::transaction(function () use ($ticket, $data, $request) {
            $ticket->update([
                'status'        => 'Cancelled',
                'closing_notes' => $data['closing_notes'] ?? null,
            ]);

            $this->resetLinkedIssueReports($ticket, 'Pending');
            $this->recomputeVehicleStatus($ticket->vehicle_id);

            $this->log($request, 'Ticket Cancelled', "Ticket #{$ticket->ticket_id} was cancelled by admin.");
        });

        return $ticket->fresh($this->eagerLoads());
    }

    /**
     * PUT /tickets/:ticket/uncancel — Admin restores a cancelled ticket.
     * Cancelling is not the same as Closing, so this remains available —
     * it only ever targets a ticket that was never actually completed.
     */
    public function uncancelTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireRole($request, ['Admin']);

        abort_unless($ticket->status === 'Cancelled', 422, 'Only cancelled tickets can be restored.');

        $restoredStatus = $ticket->inspected_at ? 'Active' : 'Open';

        DB::transaction(function () use ($ticket, $restoredStatus, $request) {
            $ticket->update([
                'status'        => $restoredStatus,
                'closing_notes' => null,
            ]);

            $this->resetLinkedIssueReports($ticket, 'In Maintenance');
            $this->recomputeVehicleStatus($ticket->vehicle_id);

            $this->log($request, 'Ticket Restored', "Ticket #{$ticket->ticket_id} was restored back to '{$restoredStatus}' by Admin.");
        });

        return $ticket->fresh($this->eagerLoads());
    }

    /**
     * DELETE /tickets/:ticket — Admin deletes a ticket completely.
     *
     * A ticket that never had any real progress (no sub-issue ever reached
     * Done) is just discarded, same as always. But a ticket that already
     * had at least one sub-issue confirmed Done represents real completed
     * work — deleting that is exactly the "accidental click on unfinished
     * work" case reopening exists for, so it's archived as "Deleted" and
     * recoverable via Reopen (same safety net Cancel/Uncancel already has).
     * A ticket the Admin has explicitly Closed is a separate, permanent
     * action — see closeTicket() — and is never reachable from here.
     */
    public function deleteTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireRole($request, ['Admin']);

        abort_if($ticket->status === 'Closed', 422, 'A closed ticket is permanent and cannot be deleted.');

        DB::transaction(function () use ($ticket, $request) {
            $vehicleId = $ticket->vehicle_id;
            $ticket->load('subIssues');
            $hadProgress = $ticket->subIssues->contains(fn (TicketSubIssue $s) => $s->status === 'Done');

            $this->resetLinkedIssueReports($ticket, 'Pending');

            if ($hadProgress) {
                $this->archiveCompleted($ticket, $request->user()->id, 'Deleted');
            }

            $ticket->delete(); // cascades to ticket_sub_issues

            $this->recomputeVehicleStatus($vehicleId);

            $this->log($request, 'Delete Ticket', "Ticket #{$ticket->ticket_id} was deleted by Admin." . ($hadProgress ? ' Archived as recoverable — it had at least one completed sub-issue.' : ''));
        });

        return response()->json(['message' => 'Ticket deleted successfully.'], 200);
    }

    /**
     * PUT /ticket-archives/:archive/reopen — Admin recovers an accidentally
     * deleted ticket that had real progress on it. Only ever available for
     * archive entries tagged "Deleted" — a "Closed" entry is permanently
     * locked and this will refuse it.
     */
    public function reopenArchive(Request $request, TicketArchiveLog $archive)
    {
        $this->requireRole($request, ['Admin']);

        abort_unless($archive->final_status === 'Deleted', 422, 'Only a deleted, not-yet-finished ticket can be reopened — a Closed ticket is permanently locked.');

        $snapshot = $archive->full_ticket_snapshot;

        $normalizedSnapshotTitle = $this->normalizeTicketTitle($snapshot['ticket_title']);
        $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $archive->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_title'])
            ->contains(fn ($t) => $this->normalizeTicketTitle($t->ticket_title) === $normalizedSnapshotTitle);

        abort_if($duplicateMainIssue, 422, 'This vehicle already has an open ticket for this Main Issue — cannot reopen a duplicate.');

        $ticket = DB::transaction(function () use ($snapshot, $archive, $request) {
            $ticket = MaintenanceTicket::create([
                'vehicle_id'            => $snapshot['vehicle_id'],
                'issue_report_id'       => $snapshot['issue_report_id'] ?? null,
                'created_by'            => $snapshot['created_by'],
                'ticket_title'          => $snapshot['ticket_title'],
                'ticket_description'    => $snapshot['ticket_description'],
                'priority'              => $snapshot['priority'],
                'status'                => $snapshot['status'],
                'assigned_custodian_id' => $snapshot['assigned_custodian_id'] ?? null,
                'assigned_at'           => $snapshot['assigned_at'] ?? null,
                'inspection_notes'      => $snapshot['inspection_notes'] ?? null,
                'inspection_result'     => $snapshot['inspection_result'] ?? null,
                'inspected_by'          => $snapshot['inspected_by'] ?? null,
                'inspected_at'          => $snapshot['inspected_at'] ?? null,
            ]);

            $subIssueFields = [
                'issue_report_id', 'created_by', 'title', 'status', 'assigned_mechanic_id',
                'maintenance_type', 'work_order_notes', 'mechanic_assigned_at', 'mechanic_assigned_by',
                'repair_logs', 'parts_used', 'repair_started_at', 'repair_completed_at', 'maintenance_cost',
                'verification_verdict', 'verification_notes', 'verified_by', 'verified_at',
                'confirmation_verdict', 'confirmation_notes', 'confirmed_by', 'confirmed_at',
                'deferred_reason', 'deferred_by', 'deferred_at', 'deferred_issue_report_id',
            ];

            foreach ($snapshot['sub_issues'] ?? [] as $si) {
                TicketSubIssue::create([
                    'ticket_id' => $ticket->ticket_id,
                    ...array_intersect_key($si, array_flip($subIssueFields)),
                ]);

                if (!empty($si['issue_report_id'])) {
                    VehicleIssueReport::where('issue_report_id', $si['issue_report_id'])->update(['status' => 'In Maintenance']);
                }
            }

            if ($ticket->issue_report_id) {
                VehicleIssueReport::where('issue_report_id', $ticket->issue_report_id)->update(['status' => 'In Maintenance']);
            }

            $this->recomputeVehicleStatus($ticket->vehicle_id);

            $archive->delete();

            $this->log($request, 'Ticket Reopened', "Deleted Ticket #{$snapshot['ticket_id']} was reopened by Admin as new Ticket #{$ticket->ticket_id}.");

            $this->notifyUser($ticket->assigned_custodian_id, 'Ticket Reopened', "A deleted ticket for {$archive->vehicle_name} was reopened by Admin as Ticket #{$ticket->ticket_id}.", 'ticket_reopened', $ticket->ticket_id);

            return $ticket;
        });

        return response()->json($ticket->load($this->eagerLoads()), 201);
    }

    // ===================================================================
    // Internal helpers
    // ===================================================================

    /**
     * Every closed/cancelled ticket check runs through here: a vehicle
     * only returns to Available once NONE of its tickets are still open.
     * This is the single choke point — no other action may flip the
     * vehicle's status, which is what prevents an emergency vehicle from
     * being marked ready while a second, unrelated ticket is still open.
     */
    private function recomputeVehicleStatus(int $vehicleId): void
    {
        $stillOpen = MaintenanceTicket::where('vehicle_id', $vehicleId)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->exists();

        if ($stillOpen) {
            Vehicle::where('vehicle_id', $vehicleId)->update(['status' => 'Under Maintenance']);
        } else {
            Vehicle::where('vehicle_id', $vehicleId)->update([
                'status'                => 'Available',
                'condition'             => 'Good',
                'estimated_return_date' => null,
            ]);
        }
    }

    /**
     * Shared "Confirmed" finalization for a sub-issue — marks it Done,
     * resolves its linked Issue Report, and writes the permanent
     * VehicleMaintenanceRecord ledger line. Used by confirmSubIssue()'s
     * Confirmed branch AND by closeTicket(), which must finalize (not
     * defer) a sub-issue that's already sitting at For Confirmation with
     * an Approved verdict when the ticket is closed.
     */
    private function finalizeConfirmedSubIssue(MaintenanceTicket $ticket, TicketSubIssue $subIssue, int $userId, ?string $confirmationNotes = null): void
    {
        $subIssue->update([
            'status'               => 'Done',
            'confirmation_verdict' => 'Confirmed',
            'confirmation_notes'   => $confirmationNotes,
            'confirmed_by'         => $userId,
            'confirmed_at'         => now(),
        ]);

        if ($subIssue->issue_report_id) {
            VehicleIssueReport::where('issue_report_id', $subIssue->issue_report_id)->update(['status' => 'Resolved']);
        }

        // Unify ledger: every confirmed sub-issue is a line in the
        // single complete maintenance history, same as before.
        if ($subIssue->assigned_mechanic_id) {
            VehicleMaintenanceRecord::create([
                'vehicle_id'               => $ticket->vehicle_id,
                'issue_report_id'          => $subIssue->issue_report_id,
                'maintenance_type'         => $subIssue->maintenance_type ?? 'Repair',
                'problem_reason'           => $ticket->ticket_title . ': ' . $subIssue->title,
                'date_started'             => $subIssue->repair_started_at,
                'date_completed'           => $subIssue->repair_completed_at ?? now()->toDateString(),
                'maintenance_personnel_id' => $subIssue->assigned_mechanic_id,
                'action_taken'             => $subIssue->repair_logs ?? 'No logs provided.',
                'parts_used'               => $subIssue->parts_used,
                'maintenance_cost'         => $subIssue->maintenance_cost,
                'progress_status'          => 'Completed',
                'remarks'                  => $subIssue->confirmation_notes ?? "Confirmed through Ticket #{$ticket->ticket_id}",
                'verification_result'      => 'Passed',
                'verification_notes'       => $subIssue->verification_notes,
                'verified_by'              => $subIssue->verified_by,
                'verified_at'              => $subIssue->verified_at,
                'confirmed_by'             => $subIssue->confirmed_by,
                'confirmed_at'             => $subIssue->confirmed_at,
            ]);
        }
    }

    /**
     * Mark one sub-issue Deferred (a recorded decision not to fix it now)
     * and leave a breadcrumb so the defect stays visible. Returns the id of
     * the breadcrumb Issue Report (or null if none was linkable).
     */
    private function deferOneSubIssue(MaintenanceTicket $ticket, TicketSubIssue $subIssue, string $reason, int $userId): ?int
    {
        $breadcrumbId = $this->createDeferralBreadcrumb($ticket, $subIssue, $reason, $userId);

        $subIssue->update([
            'status'                   => 'Deferred',
            'deferred_reason'          => $reason,
            'deferred_by'              => $userId,
            'deferred_at'              => now(),
            'deferred_issue_report_id' => $breadcrumbId,
        ]);

        return $breadcrumbId;
    }

    /**
     * The "breadcrumb": a deferred defect must not vanish. If the sub-issue
     * came from a real Issue Report, resurface that same report as Pending
     * so it's back on the active radar. Otherwise (a defect first found
     * during inspection, with no formal report) open a fresh one. Returns
     * the report id either way.
     */
    private function createDeferralBreadcrumb(MaintenanceTicket $ticket, TicketSubIssue $subIssue, string $reason, int $userId): ?int
    {
        if ($subIssue->issue_report_id) {
            VehicleIssueReport::where('issue_report_id', $subIssue->issue_report_id)->update([
                'status'  => 'Pending',
                'remarks' => "Deferred from Ticket #{$ticket->ticket_id}: {$reason}",
            ]);

            return $subIssue->issue_report_id;
        }

        $report = VehicleIssueReport::create([
            'vehicle_id'        => $ticket->vehicle_id,
            'issue_type'        => 'Other',
            'issue_description' => "[Deferred from Ticket #{$ticket->ticket_id}] {$subIssue->title}",
            'severity_level'    => 'Medium',
            'reported_by'       => $userId,
            'status'            => 'Pending',
            'remarks'           => "Auto-created when this repair was deferred. Reason: {$reason}. Re-open a ticket when it can be addressed.",
        ]);

        return $report->issue_report_id;
    }

    private function resetLinkedIssueReports(MaintenanceTicket $ticket, string $status): void
    {
        $ids = $ticket->subIssues()->pluck('issue_report_id')
            ->push($ticket->issue_report_id)
            ->filter()
            ->unique();

        if ($ids->isNotEmpty()) {
            VehicleIssueReport::whereIn('issue_report_id', $ids)->update(['status' => $status]);
        }
    }

    private function assertBelongsToTicket(MaintenanceTicket $ticket, TicketSubIssue $subIssue): void
    {
        abort_unless($subIssue->ticket_id === $ticket->ticket_id, 404, 'That sub-issue does not belong to this ticket.');
    }

    private function archiveCompleted(MaintenanceTicket $ticket, int $userId, ?string $finalStatus = null): void
    {
        $vehicle = $ticket->vehicle;

        TicketArchiveLog::create([
            'ticket_id'            => $ticket->ticket_id,
            'vehicle_id'           => $ticket->vehicle_id,
            'ticket_title'         => $ticket->ticket_title,
            'vehicle_name'         => $vehicle->vehicle_name,
            'plate_number'         => $vehicle->plate_number,
            'final_status'         => $finalStatus ?? $ticket->status,
            'maintenance_cost'     => $ticket->subIssues->sum('maintenance_cost'),
            'full_ticket_snapshot' => $ticket->toArray(),
            'archived_by'          => $userId,
            'archived_at'          => now(),
        ]);
    }

    private function eagerLoads(): array
    {
        return [
            'vehicle',
            'vehicle.category',
            'issueReport',
            'createdBy',
            'assignedCustodian',
            'inspectedBy',
            'closedBy',
            'recurrenceOf:ticket_id,ticket_title,closed_at',
            'subIssues.assignedMechanic',
            'subIssues.mechanicAssignedBy',
            'subIssues.verifiedBy',
            'subIssues.confirmedBy',
            'subIssues.reopenedBy',
            'subIssues.deferredBy',
            'subIssues.createdBy',
            'subIssues.verificationAssignedTo',
            'subIssues.sourceVehicle:vehicle_id,vehicle_name,plate_number',
        ];
    }

    private function log(Request $request, string $action, string $details): void
    {
        ActivityLog::create([
            'user_id' => $request->user()?->id,
            'role'    => $request->user()?->role,
            'action'  => $action,
            'module'  => 'Maintenance Tickets',
            'details' => $details,
        ]);
    }

    private function requireRole(Request $request, array $roles): void
    {
        abort_unless($request->user()->hasAnyRole($roles), 403, 'Your account role cannot perform this action.');
    }

    private function notifyUser($userId, $title, $message, $type, $ticketId)
    {
        if (!$userId) return;
        \App\Models\Notification::create([
            'user_id'   => $userId,
            'title'     => $title,
            'message'   => $message,
            'type'      => $type,
            'ticket_id' => $ticketId,
        ]);
    }

    // User carries no global scope — pass the relevant vehicle's
    // barangay_id explicitly, or this would notify every barangay's
    // Admins about something that only happened in one of them.
    private function notifyAdmins($title, $message, $type, $ticketId, ?int $barangayId)
    {
        $admins = User::where('barangay_id', $barangayId)->havingRole('Admin')->get();
        foreach ($admins as $admin) {
            $this->notifyUser($admin->id, $title, $message, $type, $ticketId);
        }
    }
}
