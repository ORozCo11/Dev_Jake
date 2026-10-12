# Barangay VMS — Improvement Plan (for Claude Code)

You are working on our capstone project, the Barangay Vehicle Management System (VMS). Before anything else, read:
- the VMS documentation, `Must-Haves.md`, `ERD.svg`, `System-Architecture.svg`
- `ROLE-AUDIT.md` (a full audit of the current code; all file:line references below come from it — re-verify them, since lines may have shifted)

Where the root `README.md` disagrees with the documentation, the documentation and the code are correct.

Key files: `frontend-spa/src/views/Workspace.jsx`, `frontend-spa/src/views/SuperAdminWorkspace.jsx`, `frontend-spa/src/components/ProtectedRoute.jsx`, `backend-api/app/Http/Controllers/{AuthController,FleetController,TicketController,HubController,UserController,SuperAdminController,CatalogController}.php`, `backend-api/routes/api.php`.

---

## Progress (read this first — continuing on a different machine/session starts here)

**Phase A — Critical fixes: DONE, merged into `dev-paul`.** All 5 items (A1–A5) implemented, tested, and verified against the real dev database. Backend: 212/212 tests passing (`cd backend-api && php artisan test`). Frontend: builds clean, zero new ESLint issues. Two new migrations were run against the real local `database.sqlite` and confirmed safe (existing data survived).

What landed, briefly (full detail in each item's section below, and in `Must-Haves.md`'s "Resolved Gaps"):
- **A1**: `role` column widened off the old enum (new migration `2026_09_25_000001_widen_users_role_column.php`); `php artisan superadmin:create` added; `UserSeeder` gated to local/testing.
- **A2**: `TicketController::verifyRepair` blocks self-verification regardless of role; Admin is a general fallback verifier; `assignMechanic`/`reassignCustodian` warn (non-blocking) on a future conflict.
- **A3**: new sub-issue status `Pending Approval` for cannibalized repairs; new `approveCannibalization`/`rejectCannibalization` endpoints (new migration `2026_09_25_000002_add_cannibalization_approval_to_ticket_sub_issues.php`); approval auto-opens an Issue Report on the donor vehicle.
- **A4**: new `GuardsLastAdmin` trait (shared by `UserController`/`SuperAdminController`) blocks zeroing out a Barangay's active Admins; proactive warning banner on the Admin dashboard and in the Super Admin's barangay list.
- **A5**: impersonation now requires a written reason, expires in 30 minutes (was 4 hours), is read-only via new `RestrictImpersonatedToReadOnly` middleware, logs start+end to both the target Barangay's own Activity Log and the Super Admin's log, and shows a persistent banner while active.

Known trade-offs left open on purpose (see `Must-Haves.md` Known Gaps for the full wording): impersonation's read-only rule is backend-enforced only — individual buttons aren't disabled in the UI during an impersonated session, a blocked write just surfaces as a 403 toast. A2's frontend self-verify check and A3's cannibalization UI are new and haven't been click-tested in a real browser.

**A note on Laravel/Sanctum test infrastructure**, worth knowing before writing more feature tests: `Sanctum::actingAs($user, ['*'])` — this whole suite's normal way of authenticating — makes `$token->can('anything')` return `true` for every ability, including ones a real token would never have. Don't gate new behavior on `$token->can('someAbility')` without also checking something concrete like the token's `name`, or a full test run can silently break everywhere that pattern is used (this happened once already during A5 — caught before merging, see `RestrictImpersonatedToReadOnly`'s docblock). Also: Laravel's HTTP test client does not reliably re-resolve the authenticated user across two different real bearer tokens (or `actingAs` + a later real token) used in the same test method — build a token directly via `$user->createToken(...)` instead of chaining a live HTTP call when a test needs to act as a second identity.

**Next: Phase B** (single permission map, frontend ability checks, data scoping — see below). Not started. Per "How to work" below: explore and report what exists first, propose a plan, wait for approval before writing code — same cadence Phase A used throughout.

---

## How to work

1. Work **one phase at a time, in order** (A → B → C → D → E).
2. For each phase: explore and report what already exists (fully / partially / not at all, with file:line), then give me a plan. **Wait for my approval before writing code.**
3. After each phase, stop and summarize: files changed, migrations added, tests added, and what I should test manually.
4. If anything is ambiguous or conflicts with existing code, **ask me — do not guess.**
5. If you run out of room mid-phase, tell me exactly where you stopped.

## Global rules (apply to every change)

- **Roles are fixed:** Super Admin, Admin, Custodian, Maintenance Personnel. Do NOT add a Driver role or any other role. Drivers never log in.
- **Guiding rule:** anyone who logs in can report; the Custodian runs the repair; Maintenance Personnel fixes; the Admin decides anything involving money or accepting risk; the Super Admin manages accounts, never fleet data.
- **Enforce every permission and status transition in the backend.** The UI hiding something is never enough.
- Keep `BelongsToBarangay`, `ScopedThroughVehicle`, `RestrictSuperAdminScope`, and `EnsureUserIsActive`.
- **Migrations must work on SQLite (local) AND PostgreSQL (Supabase production).** Never edit old migrations. Existing data must survive: give new columns safe defaults or backfill them.
- **Feature tests** for every permission rule and status transition, for both the allowed and the blocked (403 / scoped-result) cases.
- **Remove access, not code.** Delete code only if NO role uses it anymore, and list those deletions for my approval first.
- Do not refactor unrelated code. New UI goes in separate component files where practical, not deeper into `Workspace.jsx`.
- Record every new action in the Activity Log.
- Do not rename database tables, models, or API routes. Renames are UI labels only.
- Update the documentation (roles table, workflow, module list, `Must-Haves.md`) at the end of each phase.

---

## Target role model (source of truth for all phases)

**Super Admin** (platform-wide, no fleet data)
- Barangays, all accounts, pending approvals (including a barangay's first Admin), Recover/promote a user to Admin, role changes, registration codes, concern reports, account-level activity log.
- Impersonation: read-only, time-limited, reason required, visible to the barangay (see A5).
- Never: vehicles, tickets, issues, checks, schedules, records.

**Admin** (own barangay)
- Everything in the barangay's fleet: vehicles (add, edit, archive, decommission), vehicle types, hubs and locations, users and approvals, registration code, reports, activity log, catalogs (fault categories, maintenance types).
- Tickets: create, assign/reassign mechanic and custodian, confirm/reopen, **defer, decision-close, cancel, delete**, approve cannibalized-part repairs.
- Maintenance Records: manual entries for past/historical work only.
- Fallback for every Custodian action, including verifying a repair when the Custodian can't (e.g. they performed it).

**Custodian** (own barangay)
- Home: readiness summary and My Tasks.
- Vehicles: view all vehicles and profiles; acknowledge custody. NO add/edit/archive/delete.
- Vehicle checks: perform; edit own. NO delete (Admin only), NO editing check templates or cadence.
- Issue reports: create; view ALL in the barangay; edit/delete own while Pending. Record who reported it ("Reported by").
- Tickets: **open tickets** (Phase D), inspect and create sub-issues, add sub-issues, assign a mechanic or outside shop (Phase D), log repairs done by an outside shop, verify repairs (never their own), **close a ticket when every sub-issue is Done** (Phase D). NO defer, decision-close, cancel, delete, or final verdict changes.
- Maintenance Schedule: view; turn a due item into a ticket (Phase C); "Suggest schedule" sends a notification to Admins. NO create/edit.
- Maintenance Records: read-only. NO create.
- Vehicle documents: upload, edit own. NO delete.
- Hubs: see a vehicle's hub. NO add/edit/delete.
- NO: users, vehicle types, full activity log, reports, creating catalog values.

**Maintenance Personnel** (own barangay)
- Home: My Work Orders only (assigned sub-issues + assigned schedules). No fleet readiness summary.
- Sub-issues assigned to them: log notes, parts, cost, photos; mark repair done. Add a sub-issue on a ticket they're assigned to (found during repair).
- Schedules assigned to them: view and complete.
- Vehicles: only those tied to their assigned sub-issues or schedules — basic details, hub name, past repairs.
- Vehicle documents: view only.
- Work Tracker: keep.
- NO: other mechanics' work, unassigned work, opening/verifying/closing/deferring tickets, issue report list or editing, vehicle checks, schedule creation, Maintenance Records, users, settings, reports, activity log, creating catalog values.

**All roles:** own profile and password, own notifications.

**Multi-role users** get the union of their roles' abilities, except: whoever logged the repair on a sub-issue can never verify that same sub-issue (only an Admin can).

---

## Phase A — Critical fixes

**A1. Super Admin in production.** Verify: on PostgreSQL, does the `users.role` enum (`0001_01_01_000000_create_users_table.php:20`) become a CHECK constraint that rejects 'Super Admin'? Is there ANY way to create a Super Admin outside local/testing (`2026_08_31_000001_create_super_admin_account.php:26`)? Report your findings before fixing. Then: add a new migration that allows 'Super Admin' on both databases (e.g. convert `role` to a string column validated in the app), and add a production-safe `php artisan superadmin:create` command that prompts for email and password. No hardcoded credentials.

**A2. Block self-verification in tickets.** In `TicketController::verifyRepair` (~`:823-904`), reject with 403 when the verifier is the sub-issue's `assigned_mechanic_id`, mirroring `FleetController.php:1925-1929`; in that case only an Admin may verify. `assignMechanic` / `reassignCustodian` must warn the Admin when the same person would become both mechanic and verifier on one sub-issue. Mirror the rule in the UI (`Workspace.jsx:14012-14019`).

**A3. Cannibalized parts need approval.** In `logRepairs` (`TicketController.php:~749`) and the Log Repairs form (`Workspace.jsx:14395-14433`): a repair with `repair_type = Cannibalized` and a `source_vehicle_id` is saved as "Pending Admin approval". The Admin approves or rejects it. On approval, automatically create an issue report on the donor vehicle ("Part removed for use on <vehicle>") and recompute the donor's readiness.

**A4. Last-Admin protection.** Block deactivating, demoting, or removing the Admin role from a barangay's last active Admin — in `UserController::deactivate/update` and `SuperAdminController::deactivateUser/updateUserRole`. Return a clear 422. Also show a warning on the Admin dashboard and in the Super Admin's barangay list when a barangay has only one active Admin.

**A5. Restrict impersonation** (`AuthController.php:356-384`):
- require a written reason
- expiry 30 minutes (not 4 hours)
- read-only: middleware rejects every non-GET request carrying the 'impersonated' ability, except logout / return-to-self
- log start and end in the TARGET barangay's Activity Log (visible to its Admin) as well as the Super Admin log
- persistent banner in `Workspace.jsx` during impersonation
- confirm the backend refuses Admin impersonation outside local/dev, not only the UI

---

## Phase B — Single permission map, scoping, role cleanup

**B1. Permission map.** Create `backend-api/config/permissions.php` mapping each role to abilities (e.g. `vehicle.create`, `ticket.create`, `ticket.close`, `subissue.defer`, `condition.edit_own`, `condition.delete`, `document.delete`, `schedule.create`, `record.create`, `issue.view_all`, `catalog.create`, `repair.approve_cannibalized`). Add one helper (e.g. `$user->canDo('ability')`, OR'd across all of the user's roles). Replace every `requireRole` / `requireAdmin` / `hasRole`-based authorization check with it. Keep checking the live User model; document that the role names in Sanctum token abilities are informational only.

**B2. Frontend uses abilities only.** Return the user's abilities from `/user` and the login response. Replace ALL role checks in the frontend with ability checks, including:
- `ProtectedRoute.jsx:30` (currently checks the primary role only)
- `Workspace.jsx:5280, 5391, 8316/1827, 2579/11233`, `canManageDocuments` (`:2570`)
- every `/new` and `/edit` page (`:2505-2554, 2596-2689`): redirect if the user lacks the ability

**B3. Role checks and data scoping on every GET route** flagged "no role check" in ROLE-AUDIT §8b item 5. Scope in the queries, not in React:
- `/tickets/{id}`: Admin = any in barangay; Custodian = tickets where they are the assigned custodian; Maintenance = tickets containing a sub-issue assigned to them.
- `/issues`: Admin and Custodian = all in barangay (remove the `?mine=1` default at `Workspace.jsx:740-742`); Maintenance = none.
- `/maintenance-schedules`: Maintenance = only `assigned_to = me`.
- `/conditions`: Maintenance = none.
- `/maintenance-records`: Maintenance = none (they see a vehicle's past repairs through its profile).
- `/vehicles`: Maintenance = only vehicles tied to their assigned work.

**B4. Apply the Target role model.** Specific removals found in the audit:
- Custodian: edit/delete ANY condition check → edit own only, delete Admin-only. Remove schedule Add (keep "Suggest schedule" as an Admin notification). Remove standalone Maintenance Record creation. Documents: upload + edit own, delete Admin-only.
- Custodian: "Mark Available" (`FleetController.php:1031`) blocked while the vehicle has any open (not Done/Deferred) sub-issue; show why.
- Maintenance: remove the "View Vehicle Issues" module and the Status+Remarks edit (`Workspace.jsx:7532`) and PUT /issues; remove the Maintenance Records module and record creation; remove schedule Add; merge assigned schedules into My Work Orders and remove the separate Maintenance Schedule module from their sidebar; documents view-only; block condition checks in the backend.
- Everyone except Admin: cannot create fault categories or maintenance types (`CatalogController.php:37, 93`; `Workspace.jsx:15086, 15132`). Offer "Other" + a note field instead.

**B5. Deactivation with open work.** Block deactivating a user who is the assigned custodian, mechanic, or schedule assignee on open work, or the custodian of any vehicle. Return the list of items and let the Admin reassign them in the same screen. Add a reassign endpoint for `VehicleMaintenanceSchedule.assigned_to` (none exists today).

**B6. Registration notification.** Notify the barangay's Admins when a non-first-Admin staff member registers (`AuthController::register`).

---

## Phase C — Consolidate duplicate workflows and navigation

Propose each data change first and wait for my approval on each.

**C1. One repair workflow.** Tickets are the only live repair process. `VehicleMaintenanceRecord` becomes a ledger: rows created automatically by `finalizeConfirmedSubIssue` (`TicketController.php:1434-1472`), plus Admin-only manual entries for past/historical work with no verify/confirm cycle. Retire `verifyMaintenance`, `confirmMaintenance`, and `decisionCloseMaintenance` for new records. Keep existing data readable; propose how to migrate in-progress standalone records. Remove the Custodian "Maintenance Status" module afterwards.

**C2. One vehicle check.** Merge Condition Monitoring (`VehicleConditionCheck`) and Readiness Check (`VehicleReadinessCheck`) into a single "Vehicle Check" flow and UI. Propose the data merge (keep one and migrate the other, or a new table). A failed Critical or Major item automatically creates an issue report linked to that check.

**C3. Deferrals stay on the sub-issue.** Stop creating Admin-authored breadcrumb issue reports (`createDeferralBreadcrumb`, `TicketController.php:1501-1523`). A deferred sub-issue stays visible as an open defect on the vehicle profile and to the ticket's custodian, and can be pulled into a later ticket. Link existing breadcrumbs back to their sub-issue.

**C4. Schedule ↔ ticket.** A due Maintenance Schedule item can be turned into a Preventive ticket with one click (Admin or Custodian). Closing that ticket completes the schedule item and creates the next occurrence.

**C5. One event stream.** Vehicle History and Activity Log should read from one events source; Vehicle History is the log filtered by vehicle. If they're separate tables today, propose a migration plan. Also verify: `/histories` is Admin-only, but the Vehicle Profile History tab is reachable by all roles — does it 403 for non-Admins? Fix so Custodians can see history of vehicles in their barangay, and Maintenance can see history of vehicles they're assigned to.

**C6. New navigation (5 areas).**
- **Home:** readiness summary per vehicle type (e.g. "Ambulances ready: 1 of 2") + **My Tasks**, showing only what's waiting on the logged-in user (Custodian: checks due, tickets to inspect, repairs to verify; Maintenance: assigned sub-issues and schedules; Admin: deferrals, decision-closes, pending approvals, cannibalization approvals).
- **Vehicles:** list → **Vehicle Profile** with tabs: Overview (readiness, custodian, hub, open and deferred defects), Work Orders, Checks, Schedule, History, Documents.
- **Maintenance:** one list of all tickets and ledger records, filterable by type (Corrective / Preventive / External / Past) and status, with Issue Reports as a "Requests" tab.
- **Reports**
- **Settings:** Vehicle Types, Hubs map, Users, Activity Log, check templates, catalogs.
- UI labels only: Ticket → "Work Order", sub-issue → "Finding", Issue Report → "Request".
- Split the new areas out of `Workspace.jsx` into route-level components with lazy loading.

---

## Phase D — Core workflow improvements

**D1. Custodian can open tickets.** Custodians create tickets in their barangay (from an issue report, a vehicle check, or from scratch). Admins are notified in-app and can reassign or cancel. Add `reported_by_name` (nullable text) and `reported_by_type` (Driver / Responder / Resident / Self) to issue reports so drivers' verbal reports are recorded by the Custodian.

**D2. Custodian can close a ticket when every sub-issue is Done.** Deferrals, decision-closes, cancel, and delete remain Admin-only.

**D3. Severity.** Add `severity` (Critical / Major / Minor) to issue reports and sub-issues. Required on new records; backfill existing ones as Minor.

**D4. Readiness from the merged check + severity.** Build on the existing readiness logic — do not create a second system:
- **Out of Service:** any open Critical issue or sub-issue, unless the Admin explicitly marked it safe to use (deferral or decision-close).
- **Limited:** any open Major, or a Critical the Admin marked safe to use.
- **Available:** everything else.
- **Unchecked** (shown alongside the status): the vehicle's check is overdue per its type's cadence (D9).
- A failed Critical check item sets Out of Service immediately, with no approval.
- Archived/decommissioned vehicles are excluded from counts.

**D5. Structured categories for recurrence.** The fault-category catalog may already work as a component category — check first and reuse it rather than adding a new field. Recurrence rule: same vehicle + same category, reported within 60 days of a sub-issue marked Done → flag as possible rework.

**D6. Aging by severity.** Flag an open item after 72 hours if Critical, 14 days if Major, 30 days if Minor. Put thresholds in one config location.

**D7. Deferral rules.** A deferral requires a reason category (No Budget / Waiting for Parts / Low Priority), a review date, and for Critical items the Admin's explicit safe-to-use decision (feeds D4). Show each vehicle's deferred count.

**D8. Check templates per Vehicle Type.** Each Vehicle Type has its own checklist; items can be marked Critical. Water vehicles (Domain = Water) get different items from Land vehicles.

**D9. Check cadence per Vehicle Type** (e.g. every 1 day for ambulances, every 7 days for boats). An overdue check shows "Unchecked" and appears in the Custodian's My Tasks.

**D10. Review open defects at check start.** When a Custodian starts a check, show the vehicle's open and deferred defects first and ask for each: "Still present?" Yes keeps it open; No sends it to the Admin to close as resolved.

**D11. Vehicle custodian and acknowledgment.** When adding a vehicle, the Admin assigns a Custodian, who sees "Acknowledge receipt" (records `custodian_acknowledged_at`). Changing the custodian clears it and requires the new one to acknowledge.

**D12. Last-vehicle warning.** If an action would leave zero Available vehicles of a type, the API returns a warning that must be confirmed. A warning, not a block.

**D13. Officer-in-Charge.** An Admin can delegate Admin abilities to a named active user in their barangay until an end date. It expires automatically and is logged.

**D14. Setup checklist and empty states.** An Admin whose barangay has no vehicles sees a guided checklist: add hubs → add vehicle types → add vehicles → invite staff (share the registration code). Other roles see "No vehicles registered yet — contact your Admin."

**D15. Outside shops.** Outside-shop repairs already exist (repair_type External, "Send to External Shop"). Only verify that a Custodian or Admin can log the repair for an outside shop, and that the cost is recorded.

---

## Phase E — Optional (list with effort estimates; build only what I choose)

- Required before/after photos at inspection and repair completion (Supabase Storage).
- Maintenance cost per vehicle per year report (check what the existing reliability/cost analytics already covers first).
- Vehicle inventory export: property number, acquisition date, custodian, condition, readiness.
- Notifications at every hand-off (check existing coverage first): assigned, repair logged, verified, deferred, critical issue reported.
- Bulk vehicle import from CSV.
- First Admin uploads a designation letter for the Super Admin to review.
- Reject stale updates when two users act on the same ticket or sub-issue (compare `updated_at` or a version column).
- Mobile-friendly screens for vehicle checks, repair logging, and photo upload.

---

## Out of scope (do not add)

Mileage- or engine-hour-based service, document/registration renewal tracking, dispatch or trip management, parts inventory, a Driver login role.

---

## Start

~~Begin with Phase A.~~ Phase A is done (see "Progress" at the top). Continue with **Phase B**, starting with B1 — report findings before writing any code, same as every item in Phase A did.
