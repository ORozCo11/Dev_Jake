# Final Capstone Pass — Fleet Capability & Readiness Impact + Complete System Audit

Performed 2026-10-10, as the final feature + stabilization pass before scope freeze. `VMS Docs/System-Capabilities.md` was treated as the source of truth throughout. Six parallel read-only research passes audited the whole system against it first (vehicle inventory/import/custom fields/documents/history; issues/condition/readiness; tickets/repair/verification/self-verification; schedules/records/notifications; dashboard/intelligence readiness source-of-truth; auth/barangay/Super-Admin isolation), followed by a design pass for the two architecturally significant pieces, before any code was changed — consistent with "build a conformance matrix before modifying large amounts of code."

---

## 1. Final feature implemented

**Fleet Capability & Readiness Impact** — a type-level rollup of the existing Criticality Watch, answering "what emergency capability is at risk right now?" instead of "which vehicle." Built entirely from two already-existing primitives — `responseReadinessState()` and `Vehicle::effectiveCriticality()` — with zero new readiness or criticality algorithm. Each affected Vehicle Type gets a `COVERED` (not shown)/`LIMITED`/`AT_RISK`/`NO_COVERAGE` state derived purely from counts `fleetReadiness()`/`fragility()` already compute, the type's highest effective criticality, a primary reason, the specific affected vehicles, and a link to each one's active ticket when one exists. Surfaced as a dashboard card (Custodian/Maintenance Personnel) and as a new column inside the existing "Risk & Readiness Watch" modal (Admin) — no new module, no new page, matching the brief's "extend, don't duplicate" instruction. Live-verified end to end against a throwaway database seeded with one type in each of the four states: all four rendered correctly, vehicle/ticket links resolved correctly, zero console errors on either dashboard.

## 2. System capability conformance

Every section of `System-Capabilities.md` covered by the six research passes matched the code exactly, **with these exceptions** (each a real, confirmed finding, not a hypothesis):

| Capability | Status |
|---|---|
| Vehicle import, custom fields, their validation sharing with Add Vehicle, barangay scoping | WORKING |
| Vehicle Documents role reversal (Maintenance Personnel can now view/upload) | WORKING (behavior correct; two stale comments described the old rule — fixed) |
| Vehicle History coverage | **MISALIGNED → FIXED** (see §4) |
| Issue reporting Admin-exclusion, request-inspection, recommend-ticket | WORKING |
| Readiness/criticality single source of truth, no duplication anywhere (backend or frontend) | WORKING |
| Maintenance schedule 2026-10-06 reversal (Admin creates, Custodian suggests) | WORKING (behavior correct; stale comments in 2 files described the old rule — fixed) |
| `schedule.complete` Maintenance-Personnel-only | WORKING |
| Maintenance Record bypass-free completion, self-verification | WORKING |
| New notification events (recommend-ticket, request-inspection, schedule-suggest) end-to-end wiring | WORKING |
| Ticket title composed at propose time, not approve time | **doc said "on approve" — FIXED (§6)** |
| Sub-issue add/rename/remove on an Active ticket, external sent/returned stage guard, cannibalized repair fields | WORKING |
| Self-verification after a mid-repair mechanic reassignment | **BROKEN → FIXED** (see §5) |
| `VehicleTypeFieldController::index()` authorization | **MISSING → FIXED** (see §5) |
| Super Admin isolation (new routes), barangay isolation (new controllers/models) | WORKING, fail-closed by design |
| Usage Log role gating and non-mutation of vehicle status | WORKING |
| Dead cross-vehicle Documents page | **confirmed dead, reachable → REMOVED** (see §4) |

## 3. Bugs found and fixed

1. **Self-verification gap via mid-repair mechanic reassignment** (highest severity). `reassignMechanic()` only fires while a sub-issue is `Under Repair`; it overwrote `assigned_mechanic_id` with no queryable trace of the outgoing mechanic. A mechanic who did real repair work, was reassigned away, and also held this ticket's Custodian hat could still verify/confirm their own earlier work — the current-field check never saw their ID again. Contradicted the documented "self-verification is blocked unconditionally."
2. **Admin could complete a schedule as if they'd performed the repair** — already found and fixed earlier the same day, re-verified intact this pass.
3. **`VehicleTypeFieldController::index()` had no ability check at all** — any authenticated user of any role could read a vehicle type's custom-field schema.
4. **Ticket approval/inspection/close/cancel never wrote a Vehicle History entry** despite being the biggest status/condition drivers in the system — only an Activity Log line existed.
5. **A dead, unlinked cross-vehicle "Vehicle Documents" page** was still reachable by forcing its module key, contradicting the documentation's "was removed" claim.
6. **Five stale/contradictory code comments** (in `FleetController.php`, `config/permissions.php` ×2, `PhaseB4RoleModelTest.php` ×2, `Workspace.jsx` ×2) described rules that had since been reversed or reinstated, actively misleading about current behavior.

## 4. Workflow alignment fixes

- `FleetController::recomputeVehicleStatus()` and the three places that change vehicle status/condition without going through it (`approveTicket()`, `submitInspection()`'s two triage branches, `closeTicket()`'s not-fit-for-service branch) now all write a Vehicle History entry — but only on a genuine status transition, not on every call (avoids spamming history on routine actions like mechanic assignment that merely re-confirm an already-correct status).
- The dead cross-vehicle Documents page (`VehicleDocumentsPage` component and its render branch) was removed; documents now provably live only on the vehicle profile's Files card, matching the already-accurate documentation.
- Live-verified: the new Fleet Capability Impact card's vehicle/ticket chip pairing was caught and fixed mid-verification — the first implementation rendered all vehicle buttons then all ticket buttons as two separate flat rows, with no visual link between a vehicle and its own ticket. Each affected vehicle now renders as one paired pill (vehicle name + its own "Ticket" button when one exists), capped at 4 per type with a "+N more" note for busy rows.

## 5. Authorization / security fixes

- `vehicle_type.view` ability added (`Admin`, `Custodian`, `Maintenance Personnel` — a broad grant, since this is field schema/labels, not vehicle data) and `VehicleTypeFieldController::index()` now requires it.
- `ticket_sub_issues.prior_mechanic_ids` (new JSON column) tracks every mechanic ever assigned to a sub-issue, not just the current one. `reassignMechanic()` appends the outgoing mechanic to it; `verifyRepair()` and `confirmSubIssue()` both check membership in it alongside the existing current-assignee check. Closes the self-verification gap in §3.1 without a new audit subsystem — a handful of lines, not a redesign.
- Re-confirmed (not re-fixed, since it was already correct): Super Admin's fail-closed allowlist middleware automatically blocks the three newest controllers (Vehicle Import, Vehicle Type Fields, Vehicle Usage) without any changes needed; barangay isolation on all three is enforced either by an explicit ownership check or by a global Eloquent scope on route-model binding.

## 6. Data integrity fixes

- `System-Capabilities.md` §5.1/§5.2 corrected: the ticket title is composed server-side (`MT-0010 — <Vehicle> — <Issue>`) at **proposal** time, not on approval — `approveTicket()` never touches `ticket_title`. The document previously said "on approve."
- Vehicle History gap (§4) is itself a data-integrity fix — the vehicle's own timeline no longer has silent gaps around its single biggest status driver.
- `Fleet Capability & Readiness Impact`'s coverage-state derivation deliberately reuses `fragility()`'s own `ready`/`total` counts (not a second definition of "ready") specifically so the two can never disagree — verified by a test that cross-checks `AT_RISK` against `fragility()`'s `single_point` flag on the same fixture.

## 7. Tests run

Full backend suite: **347/347 passing** on every file not blocked by a pre-existing, environment-specific gap (see §8). Breakdown of what's new/changed this pass:
- 6 new tests in `FleetIntelligenceTest.php` for the new feature (COVERED exclusion, LIMITED, AT_RISK cross-checked against `fragility()`, NO_COVERAGE with reason, criticality ranking, ticket-link correctness).
- 2 new tests in `TicketWorkflowTest.php` for the self-verification fix (a reassigned-away mechanic who also holds the Custodian hat is still blocked at both verify and confirm; `prior_mechanic_ids` accumulates correctly across multiple reassignments without duplicates) — plus 3 existing message-text assertions updated to match the revised wording.
- 1 new test in `VehicleTypeFieldsTest.php` confirming the new ability check (401 unauthenticated, 200 for all three barangay roles).
- 1 updated test in `ConvertDueSchedulesToTicketsTest.php`'s helper to correctly target the resulting-ticket-id guard instead of the (now-stricter) role check.

Frontend `vite build`: clean, both before and after the live-verification fix. Live end-to-end verification: throwaway database seeded with one Vehicle Type in each of the four coverage states, screenshotted on both the Admin ("Risk & Readiness Watch" modal) and Custodian (dashboard card) views — all four states rendered correctly, vehicle/ticket links worked, zero console or network errors on either page.

## 8. Remaining known limitations

- **Two test files (`VehicleImportTest.php`, one test in `VehicleTypeFieldsTest.php`) cannot run on this machine** — `phpoffice/phpspreadsheet` (added to `composer.json`/`composer.lock` by the import feature, pulled in from another session) requires the PHP `gd` extension, which isn't enabled in this environment's `php.ini`. Confirmed via `composer install` refusing with an explicit platform-requirement error, not a code defect — these same tests almost certainly pass wherever `ext-gd` is enabled. Not fixed here: enabling a PHP extension is a local machine-configuration change outside this session's scope, not a code change.
- Everything listed as a known limitation in the two earlier audit passes today (no self-service password reset, unused "In Use" status, public-bucket file storage, geocoder coverage limits) remains unchanged and still consistent with the current specification.
- `VehicleImportController`'s per-method `authorizeImport()` ownership check (rather than a global model scope) is a minor structural process risk flagged by the audit — correctly applied in all four current methods, so not a live bug, but worth a scope/trait if the controller grows more methods later. Not changed this pass, since doing so would mean restructuring working code for a non-issue.

## 9. Deliberately out-of-scope features

Unchanged and confirmed still absent, per the brief's explicit scope freeze: live GPS tracking, dispatch management, emergency call dispatch, route/driver tracking as an operational system, odometer-based maintenance logic, procurement/purchasing, spare-parts warehouse inventory, insurance/permit compliance management, AI/ML prediction, external fleet telematics, a mobile app, and unrelated accounting features. The Vehicle Usage Log remains recording-only (confirmed again this pass: zero `vehicle.status` writes anywhere in `VehicleUsageController`). The "In Use" vehicle status remains unused by any code path. No self-service password reset was added.

## 10. Final scope freeze

All items in the final acceptance checklist that applied to this pass are met: the new feature works and is live-verified; every documented capability has a working, authorized, barangay-scoped path; the one confirmed self-verification gap is closed; Vehicle History no longer has a gap around ticket-driven status changes; Super Admin and barangay isolation hold for every endpoint audited, including the newest controllers; no dead or misleading code was left in place once found; the full test suite passes outside the one pre-existing, environment-specific gap. No additional product capabilities are proposed. The VMS feature set is frozen as of this pass.
