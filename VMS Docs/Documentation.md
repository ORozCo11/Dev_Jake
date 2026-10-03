# Barangay Vehicle Management System (VMS) — Documentation

## 1. What this system is

The Barangay VMS is a fleet management platform for a barangay's emergency response vehicles — ambulances, fire trucks, and rescue boats. It tracks whether a vehicle is ready to respond right now, and manages the full lifecycle of keeping it that way: reporting problems, inspecting them, repairing them, verifying the repair, and scheduling preventive maintenance before problems happen.

It is explicitly **not** a dispatch/operations system, a document-compliance tracker, or a mileage-based service planner — those are out of scope by design.

See `System-Architecture.svg` in this folder for the full component diagram.

## 2. Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 (Vite 8), react-router-dom 7, axios, Leaflet/react-leaflet for maps |
| Backend | Laravel 13 (PHP 8.3), Laravel Sanctum for auth |
| Database | SQLite for local development; PostgreSQL (Supabase-managed) in deployment |
| File storage | Supabase Storage (S3-compatible) via `league/flysystem-aws-s3-v3` |
| Auth | Sanctum bearer tokens, tagged with the user's role(s) as token abilities |

The frontend is almost entirely one large component tree (`frontend-spa/src/views/Workspace.jsx`) that renders different modules based on the logged-in user's role and the current route, rather than a page-per-file structure. The Super Admin portal (`SuperAdminWorkspace.jsx`) is a separate, smaller tree.

## 3. Roles

| Role | Scope | What they do |
|---|---|---|
| **Admin** | One Barangay | Runs the fleet: creates tickets, approves accounts, manages vehicles/types/locations, generates reports. |
| **Custodian** | One Barangay | Inspects vehicles when a ticket is opened, verifies mechanic repairs, records preventive-maintenance checks. |
| **Maintenance Personnel** | One Barangay | Repairs assigned sub-issues, logs work and parts used. |
| **Super Admin** | Platform-wide | Manages Barangays and their user accounts, approves each Barangay's first-ever Admin, regenerates registration codes, handles concern reports, can impersonate accounts for support. Sees **no** fleet data — vehicles, tickets, and issues are intentionally out of its scope. |

Admin, Custodian, and Maintenance Personnel are strictly scoped to the one Barangay they registered under. A user can hold more than one of these three roles at once (e.g. a small Barangay's one staff member covering both Custodian and Maintenance Personnel duties).

## 4. Registration & onboarding

- Anyone can reach the public `/register` page, but every registration requires a **Staff Registration Code** — a per-Barangay code the barangay office hands out, checked server-side (`hash_equals`).
- The **first person to register for a given Barangay becomes its Admin** — but, like every other registrant, starts inactive and cannot log in until approved. Because that Barangay has no Admin yet to approve them, a **Super Admin** reviews and approves this specific case instead, from a dedicated Pending Approvals queue; they're notified the moment the registration happens.
- Everyone who registers after that must choose Custodian or Maintenance Personnel, and their account stays inactive until an existing Admin approves them from the Users page.
- See `Must-Haves.md`'s "Resolved Gaps" for why this two-track approval flow replaced the old "first registrant goes live instantly" behavior.

## 5. Core workflow: the maintenance ticket lifecycle

This is the heart of the system. A ticket can start one of two ways:

- **Admin-created** — the Admin opens a ticket directly (from a reported Issue, a Condition Monitoring check, or from scratch) and assigns a Custodian to inspect the vehicle in person; sub-issues are filled in once that inspection happens.
- **Custodian-proposed** — a Custodian who already knows what's wrong submits a full proposal for the Admin to approve or decline, picking one repair path: **in-house** (repaired by the barangay's own mechanics; can optionally be flagged as **cannibalized**, swapping in a part taken from a donor vehicle instead of a new one), or **external** (sent to an outside shop). Each sub-issue in the proposal carries its own Maintenance Type and Suggested Mechanic — a single ticket can mix different kinds of repair (e.g. a brake job and an electrical fix) without forcing one category on every sub-issue. The ticket's title is generated automatically from the vehicle and repair type (the Custodian never types one); on approval, the ticket's own number is folded into it, e.g. `#42 - Ambulance 1 - Brake Repair`. A proposal can optionally link to an existing open Issue Report on that vehicle instead of creating an untracked duplicate.

A Custodian-proposed ticket sits in **Pending Approval** until the Admin approves it (it becomes Active, sub-issues and all, since the Custodian already supplied them) or declines it (it's removed). An Admin-created ticket instead moves through 3 top-level statuses, with real work happening per **sub-issue** underneath it:

1. **Open** — Admin has created the ticket and assigned a Custodian to inspect the vehicle in person.
2. **Active** — the Custodian's inspection produced one or more sub-issues (root causes). Each sub-issue is independently:
   - assigned to a mechanic (Under Repair),
   - logged with repair notes/parts once done (For Inspection),
   - verified by the Custodian (For Confirmation),
   - given a final verdict by the Admin (Done / Reopened).
   A sub-issue can also be **Deferred** instead of fixed (e.g. no budget, waiting on a part) — this opens a follow-up Issue Report automatically so the defect isn't forgotten.
3. **Closed** — once every sub-issue is resolved (Done or Deferred), the Admin closes the ticket. If there are still unresolved sub-issues, the Admin can force a **decision close**, which requires a written reason and an explicit call on whether the vehicle is safe to return to service.

Extra signals layered on top: **recurrence detection** (the same fault reported again soon after a "fix" flags as a likely rework) and **aging** (a ticket open more than 30 days is flagged).

## 6. Other modules

- **Issue Reports** — a running to-do list of known, not-yet-repaired vehicle defects: deferred sub-issues, leftover notes from a cannibalized-repair donor vehicle, and other flagged concerns. It's not an action queue — the only thing an Admin does with one directly is **Dismiss** it (with a required reason) once it's no longer relevant. If a Custodian has already proposed a ticket for it, the report's View action opens that ticket directly instead of the report itself.
- **Vehicle Management / Vehicle Types** — the vehicle catalog. Vehicle Types carry a Domain (Land/Water) that changes which fields a vehicle of that type asks for (Hull Material/Engine Type for Water vehicles).
- **Vehicle Location** — a map of hubs (named parking/stationing points) with vehicles grouped under them; hubs can't be deleted while a vehicle is still assigned to them.
- **Vehicle History** — an automatic timeline of every location/issue/condition/maintenance event per vehicle.
- **Condition Monitoring** — a Custodian's routine physical check-in on a vehicle, independent of any reported issue.
- **Maintenance Schedule** — preventive maintenance planning, with optional recurrence (fixed intervals or a custom number of months) and an urgency view (Overdue / 1–3 / 4–7 / 8+ days).
- **Maintenance Records** — a direct log of maintenance done outside the ticket workflow (external shop work, historical records).
- **Reports** — generated summaries across fleet, maintenance, issues, and users, exportable per report type.
- **Activity Log** — a full audit trail of actions taken across the fleet, scoped per Barangay.
- **Users** — account management: roles, activation, and (for Admin) approving pending signups.

## 7. Security posture

- Sanctum bearer tokens, no server-side session state.
- Per-role scoping enforced both in the UI (which modules render) and in the backend (`RestrictSuperAdminScope`, `EnsureUserIsActive`, and per-Barangay query scoping via a `BelongsToBarangay` model concern).
- Inactive accounts cannot log in at all.
- Destructive actions that matter operationally (e.g. deleting a hub with vehicles still on it) are blocked server-side, not just hidden in the UI.

## 8. Where to look in the code

| Concern | File |
|---|---|
| Nearly all fleet-facing UI | `frontend-spa/src/views/Workspace.jsx` |
| Super Admin UI | `frontend-spa/src/views/SuperAdminWorkspace.jsx` |
| Shared styling | `frontend-spa/src/App.css` |
| Auth, registration, impersonation | `backend-api/app/Http/Controllers/AuthController.php` |
| Vehicles, issues, conditions, schedules, maintenance records | `backend-api/app/Http/Controllers/FleetController.php` |
| Ticket workflow | `backend-api/app/Http/Controllers/TicketController.php` |
| Map hubs | `backend-api/app/Http/Controllers/HubController.php` |
| Super Admin backend | `backend-api/app/Http/Controllers/SuperAdminController.php` |
| Route definitions | `backend-api/routes/api.php` |

## 9. Related documents

- `System-Architecture.svg` — component diagram (this folder).
- `ERD.svg` — entity-relationship diagram of the database (this folder).
- `Must-Haves.md` — required functionality checklist and known gaps (this folder).
- Root `README.md` — an earlier project overview; **note it predates the Super Admin role and multi-tenancy work**, so where it disagrees with this document, treat this document (and the code) as current.
- `docs/` (project root) — earlier QA, defense, and design documents from previous phases of the project.
