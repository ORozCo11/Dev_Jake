<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\AuthorizesAbilities;
use App\Http\Controllers\Concerns\ChecksRecurrence;
use App\Http\Controllers\Concerns\UploadsImages;
use App\Models\ActivityLog;
use App\Models\FaultCategory;
use App\Models\MaintenanceTicket;
use App\Models\MaintenanceType;
use App\Models\ReportedPerson;
use App\Models\TicketArchiveLog;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleHistory;
use App\Models\VehicleIssueReport;
use App\Models\VehicleMaintenanceSchedule;
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
 * A cannibalized repair (repair_type = cannibalized, a part taken from
 * another vehicle) takes a detour between Under Repair and For Inspection:
 *
 *   Under Repair -> Pending Approval -> [Admin approves] -> For Inspection
 *                                     -> [Admin rejects]  -> Under Repair
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
 *          Admin approves/rejects a cannibalized repair    -> approveCannibalization()/rejectCannibalization()
 * Phase 4: Custodian verifies a sub-issue (Tier 1)         -> verifyRepair()
 *          Admin confirms or reworks a sub-issue (Tier 2)  -> confirmSubIssue()
 * Phase 5: Admin explicitly closes the ticket (N/N only)   -> closeTicket()
 */
class TicketController extends Controller
{
    use UploadsImages;
    use ChecksRecurrence;
    use AuthorizesAbilities;

    private array $priorities       = ['Low', 'Medium', 'High'];

    // Objective grounds for sending a repair outside — each is something the
    // Admin can verify, rather than a Custodian's opinion of the mechanics.
    public const EXTERNAL_REASONS = [
        'Covered by dealer / manufacturer warranty',
        'Parts or service only available from an authorized shop',
        'Needs specialized shop equipment (e.g. alignment, A/C recovery, dyno)',
        'Requires licensed / certified service (e.g. emissions, LTO inspection)',
        'Mechanic assessed and recommended external repair',
    ];

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
        $user = $request->user();

        // Mirrors index()'s scoping so a ticket id can't be opened directly
        // by someone it wasn't already visible to in the list (VMS-IMPROVEMENT-PLAN.md
        // Phase B3). A dual-hat account (e.g. Custodian + Maintenance Personnel)
        // passes if EITHER hat gives them a reason to be here.
        if (!$user->hasRole('Admin')) {
            $isAssignedCustodian = $user->hasRole('Custodian') && $ticket->assigned_custodian_id === $user->id;
            $isAssignedMechanic = $user->hasRole('Maintenance Personnel')
                && $ticket->subIssues()->where('assigned_mechanic_id', $user->id)->exists();

            abort_unless($isAssignedCustodian || $isAssignedMechanic, 403, 'You are not assigned to this ticket.');
        }

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
            'maintenance_types'     => MaintenanceType::orderBy('name')->pluck('name'),
            // 'Pending Approval' included so a Custodian's proposal has a
            // checkbox of its own in the ticket list's status filter — it
            // used to have none, so narrowing by any of the other 4 statuses
            // silently hid every pending proposal with no way to bring it
            // back except clicking the "Proposals" stat card specifically.
            'ticket_statuses'       => ['Open', 'Pending Approval', 'Active', 'Closed', 'Cancelled'],
            'sub_issue_statuses'    => ['Open', 'Under Repair', 'Pending Approval', 'For Inspection', 'For Confirmation', 'Done', 'Deferred'],
            'external_reasons'      => self::EXTERNAL_REASONS,
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
        $this->requireAbility($request, 'ticket.view_open_for_vehicle');

        return MaintenanceTicket::where('vehicle_id', $vehicle->vehicle_id)
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->orderByDesc('ticket_id')
            ->get(['ticket_id', 'ticket_title', 'status', 'priority']);
    }

    // ===================================================================
    // PHASE 1 — Create Ticket (Main Issue) & Assign to Custodian
    // Deliberately unreachable now — ticket.create has no role assigned
    // (config/permissions.php). Every ticket must originate as a Custodian's
    // proposal (proposeTicket() below) that an Admin reviews/edits/approves.
    // Left in place (not deleted) since its business rules — duplicate-Main-
    // Issue guard, recurrence stamping, entry-mode/repair-type handling —
    // document what a ticket "being created" means; proposeTicket() reuses
    // the first two directly.
    // ===================================================================

    // ===================================================================
    // Custodian: propose a ticket; Admin: review, edit, approve or decline
    // ===================================================================

    /**
     * A Custodian's own version of createTicket()'s pre-diagnosed mode —
     * they log what's wrong and who they think should fix it, but nothing
     * goes live until an Admin approves it (see approveTicket()). This is
     * now the ONLY way a ticket comes into existence — createTicket() above
     * is unreachable (ticket.create has no role) — so it carries the same
     * duplicate-Main-Issue guard, recurrence stamping, and Issue Report /
     * Condition Check linking that endpoint used to be the sole source of.
     */
    public function proposeTicket(Request $request)
    {
        $this->requireAbility($request, 'ticket.propose');

        $data = $request->validate([
            'vehicle_id'          => ['required', 'exists:vehicles,vehicle_id'],
            'condition_check_id'  => ['nullable', 'exists:vehicle_condition_checks,condition_check_id'],
            // Ignored if sent — the server composes the "MT-0010 — Vehicle — Issue" title.
            'ticket_title'        => ['nullable', 'string', 'max:255'],
            'ticket_description'  => ['required', 'string'],
            'priority'            => ['required', Rule::in($this->priorities)],
            // How the repair will be done. A proposal always states what is
            // wrong and how it will be fixed (the Custodian has already seen
            // the vehicle; Admin's approval is the check), so there is no
            // "needs inspection" mode and sub-issues are always required.
            'entry_mode'          => ['nullable', Rule::in(['in_house', 'cannibalized', 'external'])],
            'source_vehicle_id'   => ['nullable', 'required_if:entry_mode,cannibalized', 'exists:vehicles,vehicle_id', 'different:vehicle_id'],
            'external_vendor'     => ['nullable', 'string', 'max:255'],
            // The basis for sending it out must be an objective reason Admin
            // can check, not a judgment call about the in-house mechanics.
            'external_reason'     => ['nullable', 'required_if:entry_mode,external', Rule::in(self::EXTERNAL_REASONS)],
            'external_work_scope' => ['nullable', 'required_if:entry_mode,external', 'string', 'max:5000'],
            'external_shop_contact'   => ['nullable', 'string', 'max:255'],
            'external_sent_by'        => ['nullable', 'string', 'max:255'],
            'external_contact_person' => ['nullable', 'string', 'max:255'],
            'external_estimated_cost' => ['nullable', 'numeric', 'min:0'],
            // One ticket = one maintenance job; a second problem is a second ticket.
            // Set when the proposal comes from a due Maintenance Schedule.
            'schedule_id'         => ['nullable', 'exists:vehicle_maintenance_schedules,schedule_id'],
            'sub_issues'                          => ['required', 'array', 'min:1', 'max:1'],
            'sub_issues.*.title'                  => ['required', 'string', 'max:255'],
            'sub_issues.*.maintenance_type'        => ['nullable', 'string', 'max:150'],
            // Cannibalized: one row per part — what's missing here, and the
            // part pulled off the (single, shared) donor to replace it.
            'sub_issues.*.part_missing'           => ['nullable', 'required_if:entry_mode,cannibalized', 'string', 'max:255'],
            'sub_issues.*.part_needed'            => ['nullable', 'required_if:entry_mode,cannibalized', 'string', 'max:255'],
            // Who the Custodian THINKS should do the repair — a suggestion
            // only. Doesn't become a real work-order dispatch (and doesn't
            // notify the mechanic) unless an Admin approves it.
            'sub_issues.*.suggested_mechanic_id'   => ['nullable', 'exists:users,id'],
        ]);

        if (!empty($data['external_sent_by'])) {
            $data['external_sent_by'] = ReportedPerson::resolve($data['external_sent_by']);
        }
        $data['sub_issues'] = $data['sub_issues'] ?? [];
        foreach ($data['sub_issues'] as &$sub) {
            if (!empty($sub['maintenance_type'])) {
                $sub['maintenance_type'] = MaintenanceType::resolve($sub['maintenance_type']);
            }
        }
        unset($sub);

        $entryMode = $data['entry_mode'] ?? null;
        // Only stamped on sub-issues when the repair type is actually known.
        $repairType = in_array($entryMode, ['in_house', 'cannibalized', 'external'], true) ? $entryMode : null;

        $vehicle = Vehicle::findOrFail($data['vehicle_id']);
        abort_if(
            in_array($vehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'Cannot propose a ticket on an archived or decommissioned vehicle.'
        );

        foreach ($data['sub_issues'] as $sub) {
            if (empty($sub['suggested_mechanic_id'])) {
                continue;
            }
            $suggested = User::findOrFail($sub['suggested_mechanic_id']);
            abort_unless($suggested->hasRole('Maintenance Personnel'), 422, 'A suggested mechanic must be Maintenance Personnel.');
            abort_unless($suggested->barangay_id === $vehicle->barangay_id, 422, 'The suggested mechanic does not belong to this barangay.');
        }

        // Linked records must really belong to this vehicle and not already be
        // in someone's hands — otherwise a proposal could flip another
        // vehicle's report or steal a condition check's ticket link.
        if (!empty($data['schedule_id'])) {
            $linkedSchedule = VehicleMaintenanceSchedule::findOrFail($data['schedule_id']);
            abort_unless((int) $linkedSchedule->vehicle_id === (int) $data['vehicle_id'], 422, 'That schedule belongs to a different vehicle.');
            abort_unless($linkedSchedule->status === 'Scheduled' && !$linkedSchedule->resulting_ticket_id, 422, 'That schedule already has a ticket or is no longer scheduled.');
        }
        if (!empty($data['condition_check_id'])) {
            $linkedCheck = VehicleConditionCheck::findOrFail($data['condition_check_id']);
            abort_unless((int) $linkedCheck->vehicle_id === (int) $data['vehicle_id'], 422, 'That condition check belongs to a different vehicle.');
            abort_if($linkedCheck->resulting_ticket_id, 422, 'That condition check already has a ticket.');
        }
        if (!empty($data['source_vehicle_id'])) {
            $donor = Vehicle::findOrFail($data['source_vehicle_id']);
            abort_unless($donor->barangay_id === $vehicle->barangay_id, 422, 'The donor vehicle must be in the same barangay.');
            abort_if(in_array($donor->status, ['Inactive', 'Decommissioned'], true), 422, 'The donor vehicle is archived or decommissioned.');
        }

        $maintenanceTypes = array_column($data['sub_issues'], 'maintenance_type');
        $issueType = null;
        $issueSummary = collect($maintenanceTypes)->filter()->first() ?: ($issueType ?: ($data['sub_issues'][0]['title'] ?? 'Maintenance'));
        // Provisional (no number yet) — gets its MT-#### prefix once the row has an id.
        $data['ticket_title'] = "{$vehicle->vehicle_name} — {$issueSummary}";

        // Same "no duplicate open Main Issue on this vehicle" precheck
        // createTicket() does — a fast, friendly rejection before the real,
        // row-locked recheck inside the transaction below.
        $normalizedIncomingTitle = $this->normalizeTicketTitle($issueSummary);
        $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
            ->whereNotIn('status', ['Closed', 'Cancelled'])
            ->get(['ticket_id', 'ticket_title'])
            ->first(fn ($t) => $this->normalizeSummaryForVehicle($t->ticket_title, $vehicle->vehicle_name) === $normalizedIncomingTitle);

        if ($duplicateMainIssue) {
            return response()->json([
                'message' => "This vehicle already has an open ticket for \"{$issueSummary}\" (Ticket #{$duplicateMainIssue->ticket_id}). Open a new ticket only for a different problem."
            ], 422);
        }

        $recurrenceInfo = $this->checkRecurrence((int) $data['vehicle_id'], $maintenanceTypes, $issueType, $issueSummary);
        $recurrence = $recurrenceInfo['count'];
        $recurrenceLabel = implode(' / ', array_filter(array_unique($maintenanceTypes))) ?: ($issueType ?? $data['ticket_title']);

        $ticket = DB::transaction(function () use ($data, $request, $vehicle, $recurrence, $recurrenceInfo, $normalizedIncomingTitle, $repairType, $recurrenceLabel, $issueSummary) {
            // Lock the vehicle row first — same TOCTOU fix as createTicket(),
            // serializing concurrent proposals for the SAME vehicle so two
            // requests can't both pass the duplicate check before either has
            // inserted.
            Vehicle::where('vehicle_id', $data['vehicle_id'])->lockForUpdate()->first();

            $duplicateMainIssue = MaintenanceTicket::where('vehicle_id', $data['vehicle_id'])
                ->whereNotIn('status', ['Closed', 'Cancelled'])
                ->get(['ticket_id', 'ticket_title'])
                ->first(fn ($t) => $this->normalizeSummaryForVehicle($t->ticket_title, $vehicle->vehicle_name) === $normalizedIncomingTitle);

            abort_if(
                $duplicateMainIssue,
                422,
                "This vehicle already has an open ticket for \"{$data['ticket_title']}\" (Ticket #{$duplicateMainIssue?->ticket_id}). Open a new ticket only for a different problem."
            );

            $ticket = MaintenanceTicket::create([
                'vehicle_id'              => $data['vehicle_id'],
                'created_by'              => $request->user()->id,
                'ticket_title'            => $data['ticket_title'],
                'ticket_description'      => $data['ticket_description'],
                'priority'                => $data['priority'],
                'status'                  => 'Pending Approval',
                'assigned_custodian_id'   => $request->user()->id,
                'assigned_at'             => now(),
                'recurrence_count'        => $recurrence,
                'recurrence_of_ticket_id' => $recurrenceInfo['last_type'] === 'ticket' ? $recurrenceInfo['last_id'] : null,
            ]);

            // The number only exists now — finish the "MT-0010 — Vehicle —
            // Issue" title (and use it in the log/notification text below).
            $data['ticket_title'] = MaintenanceTicket::composeTitle($ticket->ticket_id, $vehicle->vehicle_name, $issueSummary);
            $ticket->update(['ticket_title' => $data['ticket_title']]);

            foreach ($data['sub_issues'] as $sub) {
                TicketSubIssue::create([
                    'ticket_id'              => $ticket->ticket_id,
                    'created_by'             => $request->user()->id,
                    'title'                  => $sub['title'],
                    'maintenance_type'       => $sub['maintenance_type'] ?? null,
                    'suggested_mechanic_id'  => $sub['suggested_mechanic_id'] ?? null,
                    'repair_type'            => $repairType,
                    'source_vehicle_id'      => $repairType === 'cannibalized' ? ($data['source_vehicle_id'] ?? null) : null,
                    'part_missing'           => $repairType === 'cannibalized' ? ($sub['part_missing'] ?? null) : null,
                    'part_needed'            => $repairType === 'cannibalized' ? ($sub['part_needed'] ?? null) : null,
                    'external_vendor'        => $repairType === 'external' ? ($data['external_vendor'] ?? null) : null,
                    'external_reason'        => $repairType === 'external' ? ($data['external_reason'] ?? null) : null,
                    'external_work_scope'    => $repairType === 'external' ? ($data['external_work_scope'] ?? null) : null,
                    'external_shop_contact'  => $repairType === 'external' ? ($data['external_shop_contact'] ?? null) : null,
                    'external_sent_by'       => $repairType === 'external' ? ($data['external_sent_by'] ?? null) : null,
                    'external_contact_person' => $repairType === 'external' ? ($data['external_contact_person'] ?? null) : null,
                    'external_estimated_cost' => $repairType === 'external' ? ($data['external_estimated_cost'] ?? null) : null,
                    'status'                 => 'Open',
                ]);
            }

            // A schedule is only the reason for this ticket: link it once so
            // closing the ticket finishes the schedule (and seeds a recurring one).
            if (!empty($data['schedule_id'])) {
                VehicleMaintenanceSchedule::where('schedule_id', $data['schedule_id'])->update(['resulting_ticket_id' => $ticket->ticket_id]);
            }

            // Set once, never touched again — Condition Monitoring reads the
            // linked ticket's live status through this instead of a snapshot,
            // so the historical check row itself never has to change.
            if (!empty($data['condition_check_id'])) {
                VehicleConditionCheck::where('condition_check_id', $data['condition_check_id'])->update([
                    'resulting_ticket_id' => $ticket->ticket_id,
                ]);
            }

            $this->log($request, 'Propose Ticket', "Ticket proposal \"{$data['ticket_title']}\" for {$vehicle->vehicle_name} submitted for Admin review.", $ticket->ticket_id);

            $this->notifyAdmins(
                'New Ticket Proposal Awaiting Review',
                "{$request->user()->name} proposed a ticket — \"{$data['ticket_title']}\" for {$vehicle->vehicle_name}. Review, edit if needed, then approve or decline.",
                'ticket_proposed',
                $ticket->ticket_id,
                $vehicle->barangay_id
            );

            if ($recurrence > 0) {
                $lastFixSource = $recurrenceInfo['last_type'] === 'record'
                    ? "Maintenance Record #{$recurrenceInfo['last_id']}"
                    : "Ticket #{$recurrenceInfo['last_id']}";
                $ordinal = ['st', 'nd', 'rd'][$recurrence] ?? 'th';
                $this->notifyAdmins(
                    'Recurring Fault Detected',
                    "This is the " . ($recurrence + 1) . "{$ordinal} time \"" . $recurrenceLabel . "\" has been logged on {$vehicle->vehicle_name} in 90 days — last fixed via {$lastFixSource} (Ticket #{$ticket->ticket_id}). Consider a deeper fix or decommission review.",
                    'recurring_fault',
                    $ticket->ticket_id,
                    $vehicle->barangay_id
                );
            }

            return $ticket;
        });

        return response()->json($ticket->load($this->eagerLoads()), 201);
    }

    /**
     * Admin reviews a Pending Approval ticket: optionally edits ticket-level
     * fields and/or individual sub-issues (matched by sub_issue_id — only
     * the ones you want to change need to be included), then approves.
     * Approving is what actually dispatches any suggested mechanic (the
     * same effect as assignMechanic()) and puts the vehicle out of service —
     * none of that happens at proposal time.
     */
    public function approveTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.approve');

        abort_unless($ticket->status === 'Pending Approval', 422, "Only a Pending Approval ticket can be approved. Current: {$ticket->status}.");

        $data = $request->validate([
            'ticket_description'    => ['sometimes', 'string'],
            'priority'              => ['sometimes', Rule::in($this->priorities)],
            'assigned_custodian_id' => ['sometimes', 'exists:users,id'],
            // Approve and assign in one step: who will do the work.
            'assigned_mechanic_id'  => ['nullable', 'exists:users,id'],
            'sub_issues'                        => ['nullable', 'array'],
            'sub_issues.*.sub_issue_id'          => ['required_with:sub_issues', 'exists:ticket_sub_issues,sub_issue_id'],
            'sub_issues.*.title'                 => ['nullable', 'string', 'max:255'],
            'sub_issues.*.maintenance_type'      => ['nullable', 'string', 'max:150'],
            'sub_issues.*.suggested_mechanic_id' => ['nullable', 'exists:users,id'],
        ]);

        if (isset($data['assigned_custodian_id'])) {
            $newCustodian = User::findOrFail($data['assigned_custodian_id']);
            abort_unless($newCustodian->hasRole('Custodian'), 422, 'The selected user is not a Custodian.');
            abort_unless($newCustodian->barangay_id === $ticket->vehicle->barangay_id, 422, 'The selected Custodian does not belong to this barangay.');
        }

        abort_if(
            in_array($ticket->vehicle->status, ['Inactive', 'Decommissioned'], true),
            422,
            'This vehicle has been archived or decommissioned since it was proposed — decline the proposal instead.'
        );
        abort_if($ticket->subIssues()->count() === 0, 422, 'A proposal needs at least one sub-issue before it can be approved.');

        $ticket = DB::transaction(function () use ($ticket, $data, $request) {
            // Serialize against a concurrent approve/decline of the same proposal.
            $locked = MaintenanceTicket::where('ticket_id', $ticket->ticket_id)->lockForUpdate()->first();
            abort_unless($locked && $locked->status === 'Pending Approval', 422, 'This proposal was already approved or declined.');

            $ticket->update(array_intersect_key($data, array_flip([
                'ticket_description', 'priority', 'assigned_custodian_id',
            ])));

            foreach ($data['sub_issues'] ?? [] as $subData) {
                $subIssue = TicketSubIssue::where('ticket_id', $ticket->ticket_id)
                    ->where('sub_issue_id', $subData['sub_issue_id'])
                    ->firstOrFail();

                $patch = [];
                if (array_key_exists('title', $subData) && $subData['title'] !== null) {
                    $patch['title'] = $subData['title'];
                }
                if (array_key_exists('maintenance_type', $subData) && $subData['maintenance_type'] !== null) {
                    $patch['maintenance_type'] = MaintenanceType::resolve($subData['maintenance_type']);
                }
                if (array_key_exists('suggested_mechanic_id', $subData)) {
                    $patch['suggested_mechanic_id'] = $subData['suggested_mechanic_id'];
                }
                if ($patch) {
                    $subIssue->update($patch);
                }
            }

            // A mechanic named at approval becomes the job's assignee.
            if (!empty($data['assigned_mechanic_id'])) {
                $ticket->subIssues()->update(['suggested_mechanic_id' => $data['assigned_mechanic_id']]);
            }

            $vehicle = $ticket->vehicle;
            $hasValidMechanic = $ticket->subIssues()->get()->contains(function ($sub) use ($vehicle) {
                $m = $sub->suggested_mechanic_id ? User::find($sub->suggested_mechanic_id) : null;

                return $m && $m->hasRole('Maintenance Personnel') && $m->barangay_id === $vehicle->barangay_id;
            });
            abort_unless($hasValidMechanic, 422, 'Pick the Maintenance Personnel who will do the work before approving.');

            $ticket->update([
                'status'            => 'Active',
                'down_since'        => $ticket->down_since ?? now(),
                'inspection_result' => 'Needs Maintenance',
                'inspection_notes'  => 'Proposed by Custodian, reviewed and approved by Admin — inspection skipped.',
                'inspected_by'      => $ticket->assigned_custodian_id,
                'inspected_at'      => $ticket->created_at,
            ]);
            $vehicle->update(['condition' => 'Needs Repair', 'status' => 'Under Maintenance']);
            $this->history($vehicle, 'Ticket Approved', "Ticket #{$ticket->ticket_id} (\"{$ticket->ticket_title}\") was approved — {$vehicle->vehicle_name} moved to Under Maintenance.", 'maintenance_tickets', $ticket->ticket_id, $request);

            $dispatchedMechanics = [];
            foreach ($ticket->subIssues()->get() as $subIssue) {
                if (!$subIssue->suggested_mechanic_id) {
                    continue;
                }
                $mechanic = User::find($subIssue->suggested_mechanic_id);
                if (!$mechanic || !$mechanic->hasRole('Maintenance Personnel') || $mechanic->barangay_id !== $vehicle->barangay_id) {
                    // The suggestion is no longer valid (e.g. the account was
                    // deactivated or reassigned barangays since it was
                    // proposed) — leave the sub-issue Open for a manual
                    // assignMechanic() instead of silently dispatching to it.
                    continue;
                }

                $subIssue->update([
                    'status'               => 'Under Repair',
                    'assigned_mechanic_id' => $mechanic->id,
                    'mechanic_assigned_at' => now(),
                    'mechanic_assigned_by' => $request->user()->id,
                ]);
                $dispatchedMechanics[] = $mechanic;
            }

            $this->log($request, 'Approve Ticket', "Ticket #{$ticket->ticket_id} ({$ticket->ticket_title}) proposal approved.", $ticket->ticket_id);

            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Ticket Proposal Approved',
                "Your proposed ticket \"{$ticket->ticket_title}\" for {$vehicle->vehicle_name} was approved.",
                'ticket_approved',
                $ticket->ticket_id
            );
            foreach ($dispatchedMechanics as $mechanic) {
                $this->notifyUser(
                    $mechanic->id,
                    'New Work Order Assigned',
                    "You have been assigned to work on Ticket #{$ticket->ticket_id} ({$vehicle->vehicle_name}).",
                    'work_order_assigned',
                    $ticket->ticket_id
                );
            }

            return $ticket;
        });

        $payload = $ticket->load($this->eagerLoads())->toArray();
        // Non-blocking: work can't start on a vehicle that hasn't come back yet.
        if (\App\Models\VehicleUsageLog::where('vehicle_id', $ticket->vehicle_id)->whereNull('ended_at')->exists()) {
            $payload['warning'] = 'This vehicle is currently recorded as Out. Maintenance cannot begin until it is marked returned.';
        }

        return response()->json($payload);
    }

    /**
     * Admin declines a proposal outright — no partial/soft state, the row
     * is gone (sub-issues cascade with it). The reason lives only in the
     * notification sent to the Custodian who proposed it; there is
     * deliberately no other trace once this returns.
     */
    public function declineTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.decline');

        abort_unless($ticket->status === 'Pending Approval', 422, "Only a Pending Approval ticket can be declined. Current: {$ticket->status}.");

        $data = $request->validate([
            'decline_reason' => ['required', 'string'],
        ]);

        $custodianId = $ticket->assigned_custodian_id;
        $custodianName = $ticket->assignedCustodian?->name ?? "user #{$custodianId}";
        $ticketId = $ticket->ticket_id;
        $ticketTitle = $ticket->ticket_title;
        $vehicleName = $ticket->vehicle->vehicle_name;

        DB::transaction(function () use ($ticket) {
            $ticket->delete();
        });

        // The ticket row itself is gone after this — this is the only
        // place its decline is ever recorded, so it has to carry everything
        // a reader would otherwise have looked up on the ticket itself.
        $this->log(
            $request,
            'Decline Ticket',
            "Ticket #{$ticketId} (\"{$ticketTitle}\" for {$vehicleName}, proposed by {$custodianName}) declined. Reason: {$data['decline_reason']}",
            $ticketId
        );

        $this->notifyUser(
            $custodianId,
            'Ticket Proposal Declined',
            "Your proposed ticket \"{$ticketTitle}\" for {$vehicleName} was declined. Reason: {$data['decline_reason']}",
            'ticket_declined',
            null
        );

        return response()->json(['message' => 'Ticket proposal declined.']);
    }

    // ===================================================================
    // PHASE 2 — Custodian: Submit Inspection, Populate Sub-Issues
    // ===================================================================

    // ===================================================================
    // PHASE 3 — Admin: Assign Mechanic to a Sub-Issue (Work Order)
    // ===================================================================

    public function assignMechanic(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.assign_mechanic');
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

        // Not blocked — a small barangay may genuinely have no one else to
        // assign — but the eventual verifier is already knowable here: it's
        // whoever logRepairs()/verifyRepair() will later stamp/require,
        // i.e. this ticket's current Custodian (see reassignCustodian's
        // docblock for that cascade). If they match, this mechanic won't be
        // able to verify their own work — verifyRepair() enforces that;
        // this just tells the Admin up front instead of them discovering it
        // when the sub-issue gets stuck at For Inspection.
        $selfVerificationWarning = $mechanic->id === $ticket->assigned_custodian_id
            ? "{$mechanic->name} is also this ticket's Custodian — they won't be able to verify their own repair. Reassign the ticket to a different Custodian before it reaches verification."
            : null;

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $selfVerificationWarning) {
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

            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

            $this->log(
                $request,
                'Mechanic Assigned',
                "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" assigned to mechanic ID {$data['assigned_mechanic_id']}."
                . ($selfVerificationWarning ? " ⚠ {$selfVerificationWarning}" : ''),
                $ticket->ticket_id
            );

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->notifyUser(
                $data['assigned_mechanic_id'],
                'New Work Order Assigned',
                "You have been assigned to \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}).",
                'work_order_assigned',
                $ticket->ticket_id
            );
        });

        $response = $subIssue->fresh()->toArray();
        if ($selfVerificationWarning) {
            $response['warning'] = $selfVerificationWarning;
        }

        return $response;
    }

    /**
     * PUT /tickets/:ticket/sub-issues/:subIssue/reassign-mechanic — hand an
     * in-progress work order to a different mechanic (e.g. the assigned one is
     * out sick), so a repair on the only ambulance is never frozen. Only while
     * Under Repair; the reason and both mechanics are recorded.
     */
    public function reassignMechanic(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.reassign_mechanic');
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

        // Final senior system review — closes a self-verification gap: the
        // outgoing mechanic may have already logged real repair work before
        // being reassigned away, so their ID has to survive here even though
        // assigned_mechanic_id is about to point at someone else.
        $priorMechanicIds = $subIssue->prior_mechanic_ids ?? [];
        if ($previousMechanicId && !in_array($previousMechanicId, $priorMechanicIds, true)) {
            $priorMechanicIds[] = $previousMechanicId;
        }

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $newMechanic, $previousMechanicId, $priorMechanicIds) {
            $previousName = $previousMechanicId ? (User::find($previousMechanicId)?->name ?? 'the previous mechanic') : 'the previous mechanic';

            $subIssue->update([
                'assigned_mechanic_id' => $data['assigned_mechanic_id'],
                'mechanic_assigned_at' => now(),
                'mechanic_assigned_by' => $request->user()->id,
                'prior_mechanic_ids'   => $priorMechanicIds,
            ]);

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->log($request, 'Work Order Reassigned', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" reassigned from {$previousName} to {$newMechanic->name}. Reason: {$data['reassign_reason']}", $ticket->ticket_id);

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
        $this->requireAbility($request, 'ticket.reassign_custodian');

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

        // Not blocked, same reasoning as assignMechanic()'s equivalent
        // check — but checked the other way around: does the incoming
        // Custodian already have a still-open work order of their own on
        // THIS ticket? 'Done' is excluded — that repair is already
        // verified, so there's no self-verification risk left to warn about.
        $conflictingSubIssueTitles = $ticket->subIssues()
            ->where('assigned_mechanic_id', $newCustodian->id)
            ->where('status', '!=', 'Done')
            ->pluck('title');
        $selfVerificationWarning = $conflictingSubIssueTitles->isNotEmpty()
            ? "{$newCustodian->name} is also the assigned mechanic on: {$conflictingSubIssueTitles->implode(', ')}. They won't be able to verify their own repair there — reassign those sub-issues to a different mechanic, or this ticket to a different Custodian."
            : null;

        DB::transaction(function () use ($ticket, $data, $request, $newCustodian, $previousCustodianId, $selfVerificationWarning) {
            $previousName = User::find($previousCustodianId)?->name ?? 'the previous Custodian';

            $ticket->update(['assigned_custodian_id' => $newCustodian->id]);

            // Sub-issues already handed off for verification have the OLD
            // custodian stamped on them (logRepairs copies it at that moment),
            // and verifyRepair matches on that stamp — so without this cascade
            // the reassignment wouldn't actually unstick those verifications.
            // Sub-issues not yet at that stage need nothing: they'll pick up
            // the new custodian from the ticket when they reach logRepairs.
            $cascaded = $ticket->subIssues()
                ->whereIn('status', ['For Inspection', 'Pending Approval'])
                ->update(['verification_assigned_to' => $newCustodian->id]);

            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->log(
                $request,
                'Custodian Reassigned',
                "Ticket #{$ticket->ticket_id} — Custodian reassigned from {$previousName} to {$newCustodian->name}."
                . ($cascaded > 0 ? " {$cascaded} pending verification(s) moved with it." : '')
                . " Reason: {$data['reassign_reason']}"
                . ($selfVerificationWarning ? " ⚠ {$selfVerificationWarning}" : ''),
                $ticket->ticket_id
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

        $response = $ticket->fresh($this->eagerLoads())->toArray();
        if ($selfVerificationWarning) {
            $response['warning'] = $selfVerificationWarning;
        }

        return $response;
    }

    // ===================================================================
    // PHASE 3 — Mechanic: Log Repair on a Sub-Issue
    // ===================================================================

    /** The mechanic hands the vehicle (or part) to an outside shop. */
    public function markExternalSent(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.log_repair');
        $this->assertBelongsToTicket($ticket, $subIssue);
        abort_unless($subIssue->assigned_mechanic_id === $request->user()->id, 403, 'This work order is not assigned to you.');
        abort_unless($subIssue->status === 'Under Repair', 422, "Only an Under Repair sub-issue can be sent out. Current: {$subIssue->status}.");
        abort_if($subIssue->external_sent_at, 422, 'This repair has already been sent out.');

        $data = $request->validate([
            'external_vendor' => ['required', 'string', 'max:255'],
            'external_reason' => ['required', 'string', 'max:255'],
            'external_work_scope' => ['required', 'string'],
            'external_shop_contact' => ['nullable', 'string', 'max:255'],
            'external_contact_person' => ['nullable', 'string', 'max:255'],
            'external_estimated_cost' => ['nullable', 'numeric', 'min:0'],
        ]);

        $subIssue->update($data + [
            'repair_type' => 'external',
            'external_sent_at' => now(),
            'external_sent_by' => $request->user()->id,
        ]);
        $this->log($request, 'Sent Out', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" sent to {$data['external_vendor']}.", $ticket->ticket_id);

        return $subIssue->fresh();
    }

    /** The shop returns it; the mechanic records the outcome before writing up the repair. */
    public function markExternalReturned(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.log_repair');
        $this->assertBelongsToTicket($ticket, $subIssue);
        abort_unless($subIssue->assigned_mechanic_id === $request->user()->id, 403, 'This work order is not assigned to you.');
        abort_unless($subIssue->external_sent_at, 422, 'This repair has not been sent out yet.');
        abort_if($subIssue->external_returned_at, 422, 'This repair has already been marked returned.');

        $data = $request->validate([
            'external_return_notes' => ['required', 'string'],
            'external_actual_cost' => ['nullable', 'numeric', 'min:0'],
            'warranty_until' => ['nullable', 'date'],
        ]);

        $subIssue->update($data + ['external_returned_at' => now()]);
        $this->log($request, 'Returned From Shop', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" returned from {$subIssue->external_vendor}.", $ticket->ticket_id);

        return $subIssue->fresh();
    }

    public function logRepairs(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'subissue.log_repair');
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
            'part_missing'          => ['nullable', 'string', 'max:255'],
            'part_needed'           => ['nullable', 'string', 'max:255'],
            'part_quantity'         => ['nullable', 'integer', 'min:1'],
            'part_condition'        => ['nullable', 'string', 'max:255'],
            'cannibal_reason'       => ['nullable', 'string'],
            'part_installed_at'     => ['nullable', 'date'],
        ]);

        $effectiveRepairType = $data['repair_type'] ?? $subIssue->repair_type;

        // Once a repair has been sent out to a shop it can't be written up as
        // done until the vehicle is marked back (markExternalReturned()).
        abort_if(
            $effectiveRepairType === 'external' && $subIssue->external_sent_at && !$subIssue->external_returned_at,
            422,
            'This repair was sent to an outside shop. Mark it as returned before submitting the repair.'
        );

        if ($effectiveRepairType === 'cannibalized') {
            $donorId = $data['source_vehicle_id'] ?? $subIssue->source_vehicle_id;
            abort_if(!$donorId, 422, 'A cannibalized repair needs a donor vehicle.');
            $donor = Vehicle::find($donorId);
            abort_if(!$donor, 422, 'The donor vehicle no longer exists.');
            abort_if((int) $donor->vehicle_id === (int) $ticket->vehicle_id, 422, 'The donor vehicle must be a different vehicle from the one being repaired.');
            abort_unless($donor->barangay_id === $ticket->vehicle->barangay_id, 422, 'The donor vehicle must be in the same barangay.');
            abort_if(in_array($donor->status, ['Inactive', 'Decommissioned'], true), 422, 'The donor vehicle is archived or decommissioned.');
        }

        // A cannibalized repair is really two actions in one — fixing this
        // vehicle by un-fixing another — so it doesn't go straight to
        // Custodian verification like an in_house/external repair does. It
        // parks at Pending Approval for an Admin to sign off first
        // (approveCannibalization()/rejectCannibalization() below).
        $needsCannibalizationApproval = $effectiveRepairType === 'cannibalized'
            && ($data['source_vehicle_id'] ?? $subIssue->source_vehicle_id);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request, $effectiveRepairType, $needsCannibalizationApproval) {
            $existingLogs = $subIssue->repair_logs ? $subIssue->repair_logs . "\n\n" : '';

            $subIssue->update([
                'status'                    => $needsCannibalizationApproval ? 'Pending Approval' : 'For Inspection',
                'verification_assigned_to'  => $ticket->assigned_custodian_id,
                'repair_logs'               => $existingLogs . '[' . now()->format('Y-m-d H:i') . '] ' . $data['repair_logs'],
                'parts_used'                => $data['parts_used'] ?? $subIssue->parts_used,
                'attachment_url'            => $request->hasFile('photo')
                    ? $this->storeUploadedImage($request->file('photo'), 'repair-attachments')
                    : $subIssue->attachment_url,
                'repair_started_at'         => $data['repair_started_at'] ?? $subIssue->repair_started_at,
                'repair_completed_at'       => $data['repair_completed_at'] ?? null,
                'maintenance_cost'          => $data['maintenance_cost'] ?? $subIssue->maintenance_cost,
                'repair_type'               => $effectiveRepairType,
                'source_vehicle_id'         => $effectiveRepairType === 'cannibalized'
                    ? ($data['source_vehicle_id'] ?? $subIssue->source_vehicle_id)
                    : null,
                'external_vendor'           => $effectiveRepairType === 'external'
                    ? ($data['external_vendor'] ?? $subIssue->external_vendor)
                    : null,
                'part_missing'              => $effectiveRepairType === 'cannibalized' ? ($data['part_missing'] ?? $subIssue->part_missing) : $subIssue->part_missing,
                'part_needed'               => $effectiveRepairType === 'cannibalized' ? ($data['part_needed'] ?? $subIssue->part_needed) : $subIssue->part_needed,
                'part_quantity'             => $effectiveRepairType === 'cannibalized' ? ($data['part_quantity'] ?? $subIssue->part_quantity) : null,
                'part_condition'            => $effectiveRepairType === 'cannibalized' ? ($data['part_condition'] ?? $subIssue->part_condition) : null,
                'cannibal_reason'           => $effectiveRepairType === 'cannibalized' ? ($data['cannibal_reason'] ?? $subIssue->cannibal_reason) : null,
                'part_installed_at'         => $effectiveRepairType === 'cannibalized' ? ($data['part_installed_at'] ?? $subIssue->part_installed_at) : null,
                'warranty_until'            => $effectiveRepairType === 'external'
                    ? ($data['warranty_until'] ?? $subIssue->warranty_until)
                    : null,
                // Reset on every (re-)submission, not just the first: if a
                // previously-rejected cannibalized repair is resubmitted
                // (same or different donor vehicle), it needs a fresh
                // Pending review, not to still read Rejected.
                'cannibalization_status'            => $needsCannibalizationApproval ? 'Pending' : null,
                'cannibalization_rejection_reason'  => null,
                'cannibalization_reviewed_by'       => null,
                'cannibalization_reviewed_at'       => null,
            ]);

            if (array_key_exists('estimated_return_date', $data) && $data['estimated_return_date']) {
                $ticket->vehicle->update(['estimated_return_date' => $data['estimated_return_date']]);
            }

            $this->log($request, 'Repairs Logged', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" repair logs submitted.", $ticket->ticket_id);

            $mechanicName = $request->user()->name;
            $vehicleName = $ticket->vehicle->vehicle_name;

            if ($needsCannibalizationApproval) {
                $this->notifyAdmins(
                    'Cannibalized Repair Needs Approval',
                    "Mechanic {$mechanicName} logged a cannibalized repair for \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}), using a part from another vehicle. Please review before it goes to verification.",
                    'cannibalization_pending',
                    $ticket->ticket_id,
                    $ticket->vehicle->barangay_id
                );
            } else {
                $this->notifyUser(
                    $ticket->assigned_custodian_id,
                    'Verification Required: Repairs Completed',
                    "Mechanic {$mechanicName} logged repair work for \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}). Please verify.",
                    'repairs_completed',
                    $ticket->ticket_id
                );
            }
        });

        return $subIssue->fresh();
    }

    /**
     * Admin approves a cannibalized repair — releases the sub-issue to
     * Custodian verification (same handoff logRepairs() does for every
     * other repair type) and records the donor vehicle's side of the
     * trade: an Issue Report so "this vehicle is now missing a part" is
     * never invisible, and a readiness recompute so that shows up
     * immediately, not just whenever someone next inspects it.
     */
    public function approveCannibalization(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'repair.approve_cannibalized');
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "A cannibalized repair can only be approved while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Pending Approval' && $subIssue->cannibalization_status === 'Pending', 422, 'This sub-issue is not awaiting cannibalization approval.');

        $donorVehicle = Vehicle::findOrFail($subIssue->source_vehicle_id);
        $vehicleName = $ticket->vehicle->vehicle_name;

        DB::transaction(function () use ($ticket, $subIssue, $request, $donorVehicle, $vehicleName) {
            // Re-read under a lock so a double-click (or an approve racing a
            // reject) can't run this twice and create two donor reports.
            $fresh = TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();
            abort_unless(
                $fresh && $fresh->status === 'Pending Approval' && $fresh->cannibalization_status === 'Pending',
                422,
                'This sub-issue is not awaiting cannibalization approval.'
            );

            // The donor is now missing a part: flag it for a Custodian check and
            // leave a history entry (once per ticket, even if a rejected repair
            // is resubmitted against the same donor).
            $donorVehicle->update(['condition' => 'Needs Inspection']);
            $alreadyNoted = VehicleHistory::where('vehicle_id', $donorVehicle->vehicle_id)
                ->where('activity_type', 'Part Removed')
                ->where('related_table', 'maintenance_tickets')
                ->where('related_record_id', (string) $ticket->ticket_id)
                ->exists();
            if (!$alreadyNoted) {
                VehicleHistory::create([
                    'vehicle_id'        => $donorVehicle->vehicle_id,
                    'activity_type'     => 'Part Removed',
                    'description'       => "A part was removed from {$donorVehicle->vehicle_name} for use on {$vehicleName} (Ticket #{$ticket->ticket_id}).",
                    'related_table'     => 'maintenance_tickets',
                    'related_record_id' => (string) $ticket->ticket_id,
                    'updated_by'        => $request->user()->id,
                ]);
            }

            $subIssue->update([
                // Re-stamp to the ticket's CURRENT custodian — the Custodian
                // may have been reassigned while this sat awaiting approval.
                'verification_assigned_to'     => $ticket->assigned_custodian_id,
                'status'                       => 'For Inspection',
                'cannibalization_status'       => 'Approved',
                'cannibalization_reviewed_by'  => $request->user()->id,
                'cannibalization_reviewed_at'  => now(),
            ]);

            $this->log(
                $request,
                'Cannibalization Approved',
                "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" cannibalized repair approved. Donor: {$donorVehicle->vehicle_name} ({$donorVehicle->plate_number}).",
                $ticket->ticket_id
            );

            $adminName = $request->user()->name;
            $this->notifyUser(
                $subIssue->assigned_mechanic_id,
                'Cannibalization Approved',
                "{$adminName} approved the cannibalized repair for \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}).",
                'cannibalization_approved',
                $ticket->ticket_id
            );
            $this->notifyUser(
                $ticket->assigned_custodian_id,
                'Verification Required: Repairs Completed',
                "A cannibalized repair for \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}) was approved and is ready for your verification.",
                'repairs_completed',
                $ticket->ticket_id
            );
        });

        return $subIssue->fresh();
    }

    /**
     * Admin rejects a cannibalized repair — sends it back to the mechanic
     * (Under Repair) instead of on to verification. No donor-vehicle side
     * effects happen at all: nothing was actually removed from another
     * vehicle on a rejection, so there's nothing to record there.
     */
    public function rejectCannibalization(Request $request, MaintenanceTicket $ticket, TicketSubIssue $subIssue)
    {
        $this->requireAbility($request, 'repair.reject_cannibalized');
        $this->assertBelongsToTicket($ticket, $subIssue);

        abort_unless($ticket->status === 'Active', 422, "A cannibalized repair can only be rejected while the ticket is Active. Current status: {$ticket->status}.");
        abort_unless($subIssue->status === 'Pending Approval' && $subIssue->cannibalization_status === 'Pending', 422, 'This sub-issue is not awaiting cannibalization approval.');

        $data = $request->validate([
            'cannibalization_rejection_reason' => ['required', 'string'],
        ], [
            'cannibalization_rejection_reason.required' => 'A reason is required so the mechanic knows what to do instead.',
        ]);

        DB::transaction(function () use ($ticket, $subIssue, $data, $request) {
            $fresh = TicketSubIssue::where('sub_issue_id', $subIssue->sub_issue_id)->lockForUpdate()->first();
            abort_unless(
                $fresh && $fresh->status === 'Pending Approval' && $fresh->cannibalization_status === 'Pending',
                422,
                'This sub-issue is not awaiting cannibalization approval.'
            );

            $subIssue->update([
                'status'                            => 'Under Repair',
                'cannibalization_status'            => 'Rejected',
                'cannibalization_rejection_reason'  => $data['cannibalization_rejection_reason'],
                'cannibalization_reviewed_by'       => $request->user()->id,
                'cannibalization_reviewed_at'       => now(),
            ]);

            $this->log(
                $request,
                'Cannibalization Rejected',
                "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" cannibalized repair rejected. Reason: {$data['cannibalization_rejection_reason']}",
                $ticket->ticket_id
            );

            $adminName = $request->user()->name;
            $vehicleName = $ticket->vehicle->vehicle_name;
            $this->notifyUser(
                $subIssue->assigned_mechanic_id,
                'Cannibalization Rejected',
                "{$adminName} rejected the cannibalized repair for \"{$subIssue->title}\" on Ticket #{$ticket->ticket_id} ({$vehicleName}). Reason: {$data['cannibalization_rejection_reason']}",
                'cannibalization_rejected',
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
        $this->requireAbility($request, 'subissue.verify');
        $this->assertBelongsToTicket($ticket, $subIssue);

        // Production-readiness audit finding #2 — Tier-1 verification is a
        // Custodian-only action; Admin no longer holds subissue.verify at
        // all (config/permissions.php), so this unconditionally requires
        // being the SPECIFIC verifier this sub-issue was assigned to. If
        // that Custodian is unavailable, the correct fix is reassigning the
        // ticket to a different Custodian (reassignCustodian(), which
        // already carries verification_assigned_to to the new one) — not an
        // Admin quietly standing in for the Custodian's own check.
        abort_unless($subIssue->verification_assigned_to === $request->user()->id, 403, "This verification is assigned to {$subIssue->verificationAssignedTo?->name}.");

        // Independent check is the entire point of this step — "don't grade
        // your own homework." A dual-role (Custodian + Maintenance
        // Personnel) account that logged this repair can never be the one
        // who signs off on it, even if they're also this sub-issue's
        // assigned verifier — the ticket's Custodian has to be reassigned to
        // someone else entirely for it to proceed. Also checks
        // prior_mechanic_ids, not just the current assigned_mechanic_id — a
        // mechanic reassigned away mid-repair may have already logged real
        // work on this exact sub-issue before handing it off.
        abort_if(
            $subIssue->assigned_mechanic_id === $request->user()->id
                || in_array($request->user()->id, $subIssue->prior_mechanic_ids ?? [], true),
            403,
            'You performed repair work on this sub-issue — it must be verified by a different Custodian. Reassign this ticket to another Custodian.'
        );

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

            $this->log($request, 'Repair Verified', "Ticket #{$ticket->ticket_id} — sub-issue \"{$subIssue->title}\" verification: {$data['verification_verdict']}.", $ticket->ticket_id);

            $custodianName = $request->user()->name;
            $vehicleName = $ticket->vehicle->vehicle_name;
            if ($approved) {
                // Simplified flow: the Custodian's verification IS the final
                // sign-off — no separate Admin confirmation step. The repair
                // is finalized here and the ticket closes as soon as nothing
                // on it is left unresolved.
                $this->finalizeConfirmedSubIssue($ticket, $subIssue->fresh(), $request->user()->id, $data['verification_notes'] ?? null);
                $this->closeWhenAllDone($request, $ticket);
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

    // ===================================================================
    // PHASE 5 — Admin: Explicit Ticket Closure (only at N/N)
    // ===================================================================

    /**
     * PUT /tickets/:ticket/cancel — Admin cancels a ticket at any stage
     * before it's Closed.
     */
    public function cancelTicket(Request $request, MaintenanceTicket $ticket)
    {
        $this->requireAbility($request, 'ticket.cancel');

        abort_unless(!in_array($ticket->status, ['Closed', 'Cancelled'], true), 422, 'This ticket is already closed and cannot be cancelled.');
        abort_if($ticket->status === 'Pending Approval', 422, 'A proposal awaiting approval cannot be cancelled — approve or decline it instead.');

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

            // The job the schedule asked for was abandoned with the ticket.
            VehicleMaintenanceSchedule::where('resulting_ticket_id', $ticket->ticket_id)
                ->where('status', 'Scheduled')->update(['status' => 'Cancelled']);
            $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

            $this->log($request, 'Ticket Cancelled', "Ticket #{$ticket->ticket_id} was cancelled by admin.", $ticket->ticket_id);
        });

        return $ticket->fresh($this->eagerLoads());
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
    /**
     * Marks the Maintenance Schedule a ticket was auto-created from as
     * Completed and, if it repeats, seeds the next occurrence. No-op for a
     * ticket that didn't come from a schedule.
     */
    private function completeLinkedSchedule(MaintenanceTicket $ticket, int $userId): void
    {
        $schedule = VehicleMaintenanceSchedule::where('resulting_ticket_id', $ticket->ticket_id)
            ->where('status', 'Scheduled')
            ->first();
        if (!$schedule) {
            return;
        }

        $schedule->update(['status' => 'Completed']);
        $schedule->seedNextRecurrence(now()->toDateString(), $userId);
    }

    private function recomputeVehicleStatus(int $vehicleId, Request $request): void
    {
        // Only an Active ticket means work is really under way. A Pending
        // Approval proposal or an Open ticket still awaiting inspection has
        // not put the vehicle out of service yet (approveTicket() and
        // submitInspection() are what do that), so they must not either.
        $stillOpen = MaintenanceTicket::where('vehicle_id', $vehicleId)
            ->where('status', 'Active')
            ->exists();

        $vehicle = Vehicle::where('vehicle_id', $vehicleId)->first();
        // A retired vehicle stays retired.
        if (!$vehicle || in_array($vehicle->status, ['Inactive', 'Decommissioned'], true)) {
            return;
        }

        if ($stillOpen) {
            // Only a real transition is worth a History entry — this gets
            // called on nearly every sub-issue action while a ticket is
            // Active, and the vehicle is almost always already Under
            // Maintenance by then.
            if ($vehicle->status !== 'Under Maintenance') {
                $vehicle->update(['status' => 'Under Maintenance']);
                $this->history($vehicle, 'Ticket Updated', "{$vehicle->vehicle_name} moved to Under Maintenance — an active ticket is open on it.", 'vehicles', $vehicle->vehicle_id, $request);
            }
        } elseif ($vehicle->status === 'Under Maintenance') {
            // Release only a vehicle that a ticket had actually taken out of
            // service — don't overwrite the condition of one that was never
            // down (e.g. a cancelled proposal on an Available vehicle).
            $vehicle->update([
                'status'                => 'Available',
                'condition'             => 'Good',
                'estimated_return_date' => null,
            ]);
            $this->history($vehicle, 'Ticket Closed', "{$vehicle->vehicle_name} returned to Available — no more active tickets on it.", 'vehicles', $vehicle->vehicle_id, $request);
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
    /**
     * Closes the ticket once every job on it is resolved (Done/Deferred) —
     * called straight after a Custodian's approving verification, so
     * "verify" and "close" are one action. Frees the vehicle through the
     * single recomputeVehicleStatus() choke point, writes the archive
     * snapshot, finishes any linked schedule, logs and notifies.
     */
    private function closeWhenAllDone(Request $request, MaintenanceTicket $ticket): bool
    {
        $ticket->load('subIssues');
        if ($ticket->unresolvedSubIssues()->isNotEmpty()) {
            return false;
        }

        $vehicleName = $ticket->vehicle->vehicle_name;
        $userId = $request->user()->id;

        $ticket->update([
            'status'              => 'Closed',
            'closed_by'           => $userId,
            'closed_at'           => now(),
            'returned_to_service' => true,
            'archived_at'         => now(),
        ]);

        $ticket->refresh()->load('subIssues');
        $this->archiveCompleted($ticket, $userId, 'Closed');
        $this->completeLinkedSchedule($ticket, $userId);
        $this->recomputeVehicleStatus($ticket->vehicle_id, $request);

        $this->log($request, 'Ticket Closed', "Ticket #{$ticket->ticket_id} ({$vehicleName}) verified and closed by the Custodian.", $ticket->ticket_id);

        $this->notifyAdmins(
            'Ticket Closed',
            "Ticket #{$ticket->ticket_id} ({$vehicleName}) was verified and closed by Custodian {$request->user()->name}.",
            'ticket_closed',
            $ticket->ticket_id,
            $ticket->vehicle->barangay_id
        );
        foreach ($ticket->subIssues->pluck('assigned_mechanic_id')->filter()->unique() as $mechanicId) {
            $this->notifyUser($mechanicId, 'Ticket Closed', "Ticket #{$ticket->ticket_id} ({$vehicleName}) was verified and closed.", 'ticket_closed', $ticket->ticket_id);
        }

        return true;
    }

    private function finalizeConfirmedSubIssue(MaintenanceTicket $ticket, TicketSubIssue $subIssue, int $userId, ?string $confirmationNotes = null): void
    {
        $subIssue->update([
            'status'               => 'Done',
            'confirmation_verdict' => 'Confirmed',
            'confirmation_notes'   => $confirmationNotes,
            'confirmed_by'         => $userId,
            'confirmed_at'         => now(),
        ]);

        // Unify ledger: every confirmed sub-issue is a line in the
        // single complete maintenance history, same as before.
        if ($subIssue->assigned_mechanic_id) {
            VehicleMaintenanceRecord::create([
                'vehicle_id'               => $ticket->vehicle_id,
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
            'subIssues.cannibalizationReviewedBy',
        ];
    }

    private function log(Request $request, string $action, string $details, $affectedRecordId = null): void
    {
        ActivityLog::create([
            'user_id' => $request->user()?->id,
            // The role this action was actually authorized under, when a
            // requireAbility() call ran earlier in this request — falls back
            // to the primary role for endpoints with no ability gate.
            'role'    => $request->attributes->get('vms_acted_as_role') ?? $request->user()?->role,
            'action'  => $action,
            'module'  => 'Maintenance Tickets',
            'affected_record_id' => $affectedRecordId,
            'details' => $details,
        ]);
    }

    /**
     * Final senior system review — ticket actions that change a vehicle's
     * status/condition (approve, triage, close, cancel) previously only
     * wrote an Activity Log entry, leaving zero trace on the vehicle's own
     * History tab despite being the biggest status/condition drivers in the
     * system. Mirrors FleetController::history() exactly (same table,
     * same fields) since that method is private to its own controller.
     */
    private function history(Vehicle $vehicle, string $activityType, string $description, string $relatedTable, int|string $relatedRecordId, Request $request): void
    {
        VehicleHistory::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'activity_type' => $activityType,
            'description' => $description,
            'related_table' => $relatedTable,
            'related_record_id' => (string) $relatedRecordId,
            'updated_by' => $request->user()?->id,
        ]);
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
