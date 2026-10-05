# VMS Role, Permission, Workflow & Sidebar Realignment — Analysis

Produced against the target design specified 2026-10-05. **This is analysis only — no code has been changed.** All findings below were verified by reading the actual code (file:line citations throughout), not assumed. Where a claim could not be independently verified, it's flagged as such rather than stated as fact.

---

## 0. Executive summary

The target spec's "mandatory fixes" are **mostly already built**:

| Mandatory fix requested | Status |
|---|---|
| `POST /tickets` → Custodian only, not Admin | **Already true.** `ticket.create` is a deliberately empty ability (`permissions.php:112`) — Admin has no reachable ticket-creation path. `ticket.propose` is Custodian-only (`permissions.php:113`) and is the sole real entry point. |
| Self-verification must never be allowed | **Already enforced**, backend (`TicketController.php:1462-1466`) and frontend (`Workspace.jsx:15850-15863` and `:12958`), and it correctly covers the dual-role (Custodian + Maintenance Personnel) case. |

The real, verified gaps are narrower than the spec assumes:

1. **A genuine bug, unrelated to roles**: there is currently no reachable UI path for *anyone* — Admin, Custodian, or Maintenance Personnel — to create a new Issue Report, even though all three already hold the `issue.create` ability server-side. This should be fixed regardless of any other decision below.
2. **Two deliberate past design decisions conflict with the spec** and need your explicit call, not a silent revert: Maintenance Schedule ownership (Custodian currently creates, not Admin), and Vehicle registration (Admin-only currently, spec allows delegated Custodian).
3. A handful of small, low-risk technical-debt items (duplicated role-matching logic, audit log recording only a user's primary role, a missing `document.view` ability, an unreachable dead-code path for Admin ticket creation).

Everything else — mechanic assignment, repair logging, confirmation, closing, cancelling, document/schedule ownership checks — already matches the spec's intent.

---

## 1. Current system role summary

Condensed from `backend-api/config/permissions.php` (full grant list verified by direct read, lines 16-174):

**Admin** — vehicle create/edit/archive/restore/decommission; vehicle type & hub management; condition delete; issue view/create/edit/delete/dismiss; document create/edit/delete; maintenance record create/edit/confirm/decision-close; schedule edit(any)/reassign/delete/restore; reports; activity log; ticket approve/decline/reassign-custodian/close/cancel/uncancel/delete/reopen-archived; sub-issue assign/reassign mechanic/confirm/reopen/defer; cannibalization approve/reject; catalog management; full user management.

**Custodian** — vehicle readiness check, mark-available; condition create/edit; issue view/create/edit(own, Pending only); document create/edit(own upload); schedule create/edit(own)/suggest; maintenance record verify; ticket propose/inspect/check-recurrence; sub-issue verify (with self-verification block).

**Maintenance Personnel** — issue view/create (for self-filed records); sub-issue log-repair (only if they're the assigned mechanic — `FleetController.php` ownership check); schedule complete.

**Super Admin** — platform-only: barangays, platform user approval/activation, registration codes, concern reports, platform activity log. No fleet data access, confirmed separate from the three operational roles.

---

## 2. Current role conflicts

| # | Conflict | Current state | Spec wants | Verdict |
|---|---|---|---|---|
| 1 | Ticket creation | `ticket.create` → nobody (`permissions.php:112`); `ticket.propose` → Custodian only (`:113`). Comment at `:106-111` confirms this is deliberate. | Custodian only | **No conflict — already matches.** |
| 2 | Self-verification | Blocked in `TicketController::verifyRepair()` (`:1462-1466`), applies even to Admin accounts that also hold the mechanic hat. Frontend mirrors it at `Workspace.jsx:15850-15863` and `:12958`. | Must never be allowed | **No conflict — already matches**, with one minor gap: `confirmSubIssue()` (Admin's second-tier confirmation, `TicketController.php:1549-1624`) has no independent self-check of its own. Low risk today (confirm is Admin-only and the first tier already filtered out the self-verifier), but it's not defense-in-depth. |
| 3 | **Maintenance Schedule ownership** | `schedule.create` → **Custodian only** (`permissions.php:87`). Admin holds edit-any/reassign/delete/restore but **not create**. The file's own comment (`:79-86`) states this was *deliberately reversed* from an earlier Admin-owned model, specifically so the role closest to day-to-day vehicle condition (Custodian) originates preventive maintenance. | Admin creates/edits/cancels/restores; Custodian only views/suggests | **Real conflict with a prior explicit decision in this project.** Not an oversight — needs your call (see §3). |
| 4 | **Vehicle registration** | `vehicle.create` → **Admin only** (`permissions.php:23`; `FleetController.php:833-858`, no ownership carve-out for any other role). | Admin direct; Custodian also allowed *if delegated by actual barangay procedure* | Not a contradiction (current is a stricter subset), but also not implemented as "optional." Needs your call on whether delegated Custodian registration is worth adding. |
| 5 | Issue report creation — **permissions** | `issue.create` → Admin, Custodian, **and** Maintenance Personnel (`permissions.php:50`) | Custodian creates operational reports, Maintenance creates technical reports, Admin manages | **No conflict — already matches** at the permission layer. |
| 6 | Issue report creation — **UI reachability** | **Bug, not a role conflict.** The create form exists (`isNewIssuePage`, `Workspace.jsx:419`) and is properly gated, but zero code anywhere calls `navigate()` to `/issues/new`. The Custodian's "Report / Propose" sidebar entry (`reportOrPropose`) just opens the Issue Reports *list* (`Workspace.jsx:2744`), not the create form. A comment at `:2741-2743` describes a "flag vs. propose" chooser that does not exist in the code — stale documentation of a removed feature. Maintenance Personnel has no sidebar path near Issue Reports at all. | A working creation flow for both roles | **Confirmed bug.** Fix regardless of any other decision in this document. |
| 7 | Vehicle documents — `document.view` | No `document.view` ability exists at all; the GET list route has **no ability gate** (`FleetController.php:1621-1627`), reachable by any authenticated active user. This happens to produce the desired outcome (Maintenance Personnel can view), but by *absence of a restriction* rather than an explicit grant. | Maintenance can view, not delete | Behaviorally fine; flagged as technical debt (§19). |
| 8 | Role-resolution duplication | `User::scopeHavingRole()` (`User.php:112-118`) re-implements "does this user hold role X" via a raw SQL `LIKE` pattern against the JSON `roles` column, separate from the canonical `allRoles()`/`hasRole()` PHP path used everywhere else (`canDo()`, `getAbilities()`). Two independent implementations of the same check. | One source of truth | Low-risk but real duplication; flagged for cleanup (§19). |
| 9 | Audit log fidelity | `TicketController::log()` (`:2296`) records only the user's **primary** `role` field, never the specific role/ability a dual-role user actually exercised for that action. | Every audited action should capture "role/function used" (per your Audit Log requirement) | Gap against your own stated audit requirement; flagged (§19, §21). |

---

## 3. Final recommended role model

For items 1, 2, 5, 7, 8, 9 above: **keep current behavior**, it already matches the spec's intent (apply only the small hardening/cleanup items in §19-21).

For items 3 and 4, here are the two decisions that actually need you, specifically, to choose — I'm not picking for you because both were deliberate choices made earlier in this project, not defaults:

**Decision A — Maintenance Schedule ownership.**
- *Keep current (Custodian creates, Admin oversees)*: matches the real workflow of whoever is physically with the vehicle noticing it's due for service; was already built, tested, and deliberately chosen once.
- *Revert to spec (Admin creates, Custodian views/suggests)*: matches the spec's "Admin = management/scheduling authority" framing, and the `schedule.suggest` ability (currently Admin+Custodian, flagged in the code itself as "now redundant" at `permissions.php:86`) would become meaningful again as the Custodian's actual tool.
- **My read**: keep current. It's a working, tested design, and a Custodian "suggesting" a schedule Admin must then separately re-enter adds friction without adding safety — scheduling isn't a separation-of-duties issue the way ticket creation/verification is. But this is genuinely your call.

**Decision B — Delegated Custodian vehicle registration.**
- *Keep current (Admin only)*: simplest, already matches "Admin owns the vehicle master record" cleanly, no new audit trail needed.
- *Add delegated Custodian registration*: only worth doing if your actual barangay process has Custodians physically registering new vehicles in practice. Requires an explicit ability (not a silent `vehicle.create` grant) plus a `registered_by`/delegated-flag so Admin oversight isn't lost per §21.
- **My read**: keep Admin-only unless you know of a concrete barangay scenario where a Custodian registers a vehicle without an Admin present. Low value, nonzero audit cost.

Everything else in the role model — Admin manages/assigns/monitors/confirms/closes; Custodian observes/reports/creates ticket/inspects/verifies; Maintenance diagnoses/repairs/records/completes; Super Admin is platform-only — already matches the code exactly as built.

---

## 4. Final permission matrix

Only showing abilities where the spec's intent could plausibly differ from current; everything not listed already matches with no change needed (full current grant list is in §1 and was verified line-by-line in `permissions.php:16-174`).

| Ability | Current roles | Change needed? |
|---|---|---|
| `ticket.create` | nobody (dead) | No |
| `ticket.propose` | Custodian | No |
| `subissue.verify` (+ self-block) | Custodian, Admin | No (optional: add matching self-block to `subissue.confirm`) |
| `schedule.create` | Custodian | **Decision A** |
| `schedule.suggest` | Admin, Custodian | Depends on Decision A |
| `vehicle.create` | Admin | **Decision B** |
| `issue.create` | Admin, Custodian, Maintenance Personnel | No (fix UI reachability, not permission) |
| `document.view` | *(doesn't exist; route ungated)* | Add explicit ability for clarity (§19) |

---

## 5. Final ticket workflow

Already matches the target exactly, verified end-to-end in code:

```
Vehicle problem
   ↓
Issue Report (Admin/Custodian/Maintenance can file — issue.create)
   ↓
CUSTODIAN proposes a ticket (ticket.propose) — TicketController::proposeTicket, :445
   ↓
ADMIN approves/declines (ticket.approve/.decline) — :662, :796
   ↓
ADMIN assigns mechanic (subissue.assign_mechanic) — :920
   ↓
MAINTENANCE PERSONNEL repairs & logs (subissue.log_repair, ownership-checked to the assigned mechanic) — :1171, :1174
   ↓
CUSTODIAN verifies (subissue.verify) — BLOCKED if verifier === the repairing mechanic, even for a dual-role/Admin account — :1440, :1462-1466
   ↓
PASS → ADMIN final confirmation (subissue.confirm) — :1551
FAIL → back to Maintenance (reopen path)
   ↓
ADMIN closes ticket (ticket.close) — :1703
```

No workflow changes required.

---

## 6. Current sidebar (as implemented)

Verified against `Workspace.jsx:73-225` (`roleRoutes`, `modulesByRole`, `moduleEndpoints`). Note: there's no React-Router route per item — a single `renderModule()` branches on in-memory `activeModule` state; "route" below means the pathname the app recognizes.

**Admin** — Dashboard · *Operations:* Issue Reports, Maintenance Tickets, Maintenance Schedule, Maintenance Records, Condition Monitoring, Ticket Archives · *Fleet & Assets:* Vehicle Management, Vehicle Types, Vehicle Location · *Administration:* Users, Reports, Activity Log.

**Custodian** — Dashboard · *Daily Tasks:* View Vehicles, "Report / Propose" (actually opens the Issue Reports list, not a report form — see §2.6), My Tasks (a shim jumping to whichever of Inspections/Verifications/Work Tracker was last open) · *Monitoring & Schedules:* Condition Monitoring, Maintenance Schedule, Maintenance Records (a thin two-tab wrapper).

**Maintenance Personnel** — Dashboard, My Work Orders (also now surfaces their assigned schedules inline, per a prior deliberate simplification), Work Tracker. No Issue Reports, Condition, or Schedule entries at all.

**Vehicle Documents** has no sidebar entry for any role — it's a modal (`VehicleFilesModal`) opened from within a vehicle's profile page, not a standalone module.

---

## 7. Proposed sidebar

Adjusted from the spec's suggested direction to match what's actually true about the codebase (e.g., Documents stays a per-vehicle modal, not a new top-level page; Maintenance's schedule visibility stays folded into My Work Orders rather than becoming a separate item, since that fold was itself a deliberate prior simplification worth keeping).

**Admin** — unchanged, except Ticket Archives moves inside the Maintenance Tickets module as a tab instead of its own sidebar row.

**Custodian** — unchanged structure, but "Report / Propose" is fixed to actually offer "Report an Issue" (→ real `/issues/new`) alongside "Propose Ticket", instead of silently opening the Issues list.

**Maintenance Personnel** — add a lightweight "Report an Issue" entry/button (fixing the same underlying bug for this role), otherwise unchanged.

No other structural sidebar changes are justified by this review — the existing structure already reflects several good, deliberate simplifications (My Tasks shim, folded schedule visibility for Maintenance) that the spec's generic recommendation would have undone for no real benefit.

---

## 8. Sidebar change-by-change table

| Item | Current | Proposed | Category | Reason |
|---|---|---|---|---|
| Ticket Archives (Admin) | Standalone sidebar row | Tab inside Maintenance Tickets | SIMPLIFY | Reduces top-level clutter; archives are a view mode of tickets, not a separate concern. |
| Custodian "Report / Propose" | Opens Issues list only | Opens a real choice: Report an Issue / Propose Ticket | FIX (not in spec's taxonomy, but mandatory) | Currently dead-ends into the wrong screen; the described chooser doesn't exist. |
| Maintenance Personnel nav | No issue-reporting path at all | Add "Report an Issue" | ADD | They already hold `issue.create` server-side with no way to use it. |
| Vehicle Documents | Modal from vehicle profile | Unchanged | KEEP EXACTLY AS IS | Documents are inherently per-vehicle; a standalone sidebar page would just re-ask "which vehicle" immediately. |
| Maintenance's folded schedule/condition visibility | Surfaced inside My Work Orders | Unchanged | KEEP EXACTLY AS IS | A prior deliberate simplification (Phase B4); reintroducing separate items would be a regression, not an improvement. |
| Custodian "My Tasks" shim | Jumps to last-open of 3 tabs | Unchanged | KEEP EXACTLY AS IS | Already functions as the spec's "Assigned Inspections / Repair Verification" combined, just under one label. |
| Everything else in §6 | — | Unchanged | KEEP EXACTLY AS IS | Already matches intended responsibilities; no reason found to touch it. |

---

## 9-16. Features to KEEP / RENAME / MOVE / MERGE / RESTRICT / SIMPLIFY / REMOVE / ADD

- **KEEP**: Vehicle Management, Vehicle Types, Vehicle Location, Condition Monitoring, Maintenance Records, Reports, Activity Log, Users, My Tasks shim, Maintenance's folded work-order view, Vehicle Documents as a per-vehicle modal.
- **RENAME**: none found necessary — current labels are already clear and match their function.
- **MOVE**: none beyond the archive change below (no feature currently sits under the wrong role).
- **MERGE**: Ticket Archives → into Maintenance Tickets (as a tab).
- **RESTRICT**: none — current restrictions (document delete Admin-only, schedule reassign/delete/restore Admin-only, etc.) already match intent.
- **SIMPLIFY**: `schedule.suggest` — currently granted to Admin+Custodian but the code's own comment calls it "now redundant" (`permissions.php:86`); worth removing *only if* Decision A keeps Custodian as the schedule creator (in which case "suggest" has no remaining purpose distinct from "create"). If Decision A reverts to Admin-owned scheduling, `suggest` becomes the Custodian's real tool again and should stay.
- **REMOVE**: the unreachable Admin "New Ticket" direct-create code path (`Workspace.jsx` ~2950-2966) and its backend twin (`TicketController::createTicket`, `:207-430`) are both dead code kept intentionally documented as unreachable. Low priority, but if you want less dead weight in the codebase, these can be deleted outright now that the Custodian-propose path is confirmed to be the only one ever used.
- **ADD**: a real "Report an Issue" entry point for both Custodian and Maintenance Personnel (the confirmed bug in §2.6).

---

## 17. Legal alignment

Verified against primary sources (lawphil.net, officialgazette.gov.ph, gppb.gov.ph, coa.gov.ph):

- **RA 7160 (Local Government Code), §§375-377**: §375 establishes *primary* accountability for government property with the department/office head (for a barangay, the Punong Barangay or the person they designate), and *secondary* ("immediate") accountability with whoever physically holds custody of it. §376 requires that person to exercise due diligence in use/safekeeping. §377 sets liability for loss/damage from negligence. This is the actual legal basis for an Admin-oversight / Custodian-custody split — **not** a mandate that software ticket-creation specifically belongs to one title or another.
- **RA 10121 (PDRRM Act of 2010), §12**: establishes an **LDRRMO** (Local DRRM *Office*) at province/city/municipality level, and a **BDRRMC** (Barangay DRRM *Committee*, not an "Office") at barangay level, chaired by the Punong Barangay. **Correction applied**: "BDRRMO Head" is not a statutory term and should not appear in the capstone document — use BDRRMC for barangay-level references. §12(c)(12) does require maintaining "a database of human resource, equipment, directories, and location of critical infrastructures and their capacities," which is a legitimate, citable justification for *why a VMS is operationally useful here* — not for *who must click which button*.
- **PD 1445 (Government Auditing Code), §§101-102**: the general-law version of the same primary/secondary accountability logic later specialized for LGUs in RA 7160 §375 — the agency head is primarily responsible for property, custodians are secondarily responsible.
- **COA Circular 2020-006** (Jan. 31, 2020): governs physical inventory/verification procedures for government property, requiring an inventory committee and reconciliation against accountability records — supports the *concept* of independent verification (a different party checking what another party reported) that this VMS's Custodian-verifies-Maintenance's-repair step mirrors, though the circular itself is about periodic property counts, not maintenance tickets specifically.

**Recommended framing for your document** (verified not to overclaim): *"The VMS assigns ticket creation to the Custodian as an internal operational workflow, based on the Custodian's direct custodial involvement under RA 7160 §375's secondary-accountability framework, while the Admin retains RA 7160 §375's primary-accountability oversight role. This is a software design decision informed by that legal accountability structure — not a specific statutory requirement that a 'ticket' be created by any particular titled individual."*

One sourcing caveat carried over from the research: the exact text of RA 7160 §§375-377 was corroborated across multiple independent search excerpts but not rendered as a single clean full-page fetch — worth a quick manual check against the primary PDF before it goes in front of a panel.

---

## 18. Existing fleet-system comparison

From official vendor documentation (Fleetio, Geotab, Samsara):

- **Fleetio**: separate granular permissions for "Issues" (create/edit/delete/view) vs. "Work Orders" (create/edit/delete/view/manage labor), scoped by vehicle groupings — not by job title. No documented approval/verification role distinct from whoever marks a work order complete.
- **Geotab**: a multi-stage pipeline (Schedule → Work Request → Work Order → Job) with three generic clearance tiers (View/Edit/Full Access) applied per stage — again not mapped to named roles in its public docs, and no documented approval gate before completion.
- **Samsara**: the most explicit of the three — drivers submit DVIRs and certify defects; mechanics separately resolve/certify them; and the *next* driver must re-certify that a previously reported defect was actually fixed before operating the vehicle again. This is a real three-party verification loop, though it's tied specifically to DVIRs, not a general "supervisor approves" permission.

**Takeaway for the capstone**: none of these three vendors documents a clean three-role separation (reporter / repairer / approver) as a hard-coded permission structure the way this VMS does. This is a legitimate point of differentiation — the VMS's explicit report → ticket → repair → verify → close chain, with a server-enforced self-verification block, is more rigorous than what's publicly documented for any of the three.

(Caveat: Samsara's KB pages returned HTTP 403 to direct fetch during research; citations rely on search-indexed excerpts of the same official URLs rather than full-page renders — worth a manual spot-check if exact wording is quoted.)

---

## 19. Backend authorization changes required

1. **Optional hardening**: add the same self-verification `abort_if` pattern from `verifyRepair()` (`TicketController.php:1462-1466`) into `confirmSubIssue()` (`:1549-1624`) for defense-in-depth, even though it's currently low-risk (Tier 1 already filters out the self-verifier before a sub-issue can reach "For Confirmation").
2. **Decision A-dependent**: if reverting schedule ownership to Admin, change `permissions.php:87` (`schedule.create`) to `Admin`, and reconsider `schedule.suggest` (`:88`) as the Custodian's replacement action.
3. **Decision B-dependent**: if adding delegated Custodian vehicle registration, add it as its own ability (not a bare `vehicle.create` grant) and ensure the registering user and their role-at-the-time are captured on the vehicle record.
4. **Minor cleanup**: refactor `User::scopeHavingRole()` (`User.php:112-118`) to reuse `allRoles()`/`hasRole()` instead of a separate SQL `LIKE` implementation.
5. **Minor cleanup**: have `TicketController::log()` (`:2296`) capture the specific role/ability exercised for that action, not just the user's primary `role`, to satisfy your own audit-log requirement for dual-role accounts.
6. **Clarity, not behavior change**: add an explicit `document.view` ability rather than leaving the GET documents route ungated by omission (`FleetController.php:1621-1627`).
7. **Optional**: delete the dead `createTicket()` method (`TicketController.php:207-430`) and its `ticket.create` ability entry now that it's confirmed permanently unreachable, if you'd rather not carry documented-dead code.

## 20. Frontend permission/UI changes required

1. **Fix the confirmed bug**: wire a real path to `/issues/new` for both Custodian and Maintenance Personnel — either a chooser on "Report / Propose" (matching the stale comment's original intent at `Workspace.jsx:2741-2743`) or a direct "Report an Issue" button, plus add the missing sidebar entry for Maintenance Personnel.
2. Move Ticket Archives into the Maintenance Tickets module as a tab (§8).
3. Remove the stale comment at `Workspace.jsx:2741-2743` describing a chooser that doesn't exist, regardless of which fix direction is chosen.
4. **Optional**: remove the unreachable Admin "New Ticket" UI branch (`~2950-2966`) to match a backend cleanup if §19.7 is done.

## 21. Database/model changes required

- **None** for the ticket workflow or self-verification — already correct as-is.
- **Decision A**: no schema change, config-only.
- **Decision B** (if adopted): likely needs a `registered_by`/role-at-registration capture on the vehicle record if not already present — **not verified by this research pass**; check the `vehicles` migration/model before implementing.
- **If §19.5 (audit fidelity) is adopted**: `ActivityLog` would need a column capturing the specific role/ability used per entry, since it currently only has the user's primary role available.

## 22. Migration risks

Overall risk is **low**. Every recommended change here is either (a) already-implemented behavior requiring no code change, (b) a config-only permission grant change (`permissions.php`), or (c) additive UI/routing fixes. None require a data migration except the optional `ActivityLog` column in §21, which is additive and backward-compatible. Changing `schedule.create`'s grant (Decision A) would immediately change which existing users see the "Add Schedule" button — no data is at risk, only who can see the action.

## 23. Testing requirements

- Backend: the existing PHPUnit suite (309 tests passing as of the last run this session) already covers ticket propose/approve and the self-verification block. If §19.1's `confirmSubIssue` hardening is added, add a dedicated test asserting it rejects self-confirmation the same way `verifyRepair` does.
- If Decision A changes `schedule.create`'s grant, update/extend the existing maintenance-schedule feature tests to assert the new allowed/forbidden role combinations.
- Frontend: after fixing the issue-creation bug, manually click through (or script via the existing throwaway-DB/Playwright harness from this session) both a Custodian and a Maintenance Personnel account reaching and submitting `/issues/new` end-to-end — this was never actually exercised before because the entry point didn't exist.
- Standard regression for this project: full PHPUnit suite + `npx vite build` + `npx eslint` after any `permissions.php` or `Workspace.jsx` sidebar change.

---

## What I need from you before touching any code

1. **Decision A** — keep Custodian-owned scheduling, or revert to Admin-owned per the spec?
2. **Decision B** — add delegated Custodian vehicle registration, or keep Admin-only?
3. Should I go ahead and fix the confirmed Issue Report creation bug (§2.6) regardless of A/B — it's broken for everyone today and isn't tied to either decision?
4. Any appetite for the small cleanup items in §19.4/19.5/19.7 (role-matching duplication, audit-log fidelity, dead-code removal), or save those for later?

---

## Implementation status (as of the authoritative decisions that followed this analysis)

The user decided: keep Custodian-owned scheduling (Decision A), add delegated Custodian vehicle registration (Decision B), and fix the Issue Report bug regardless. Shipped:

- **Vehicle registration delegation** — `vehicle.create` now grants Admin + Custodian (`permissions.php`); `vehicle.edit` stays Admin-only, so a Custodian who registers a vehicle still can't change its protected master data afterward. Every "+ Add Vehicle" gate in the frontend that was hardcoded to `hasRole(user, 'Admin')` was switched to `canDo(user, 'vehicle.create')` so the ability grant is the single source of truth.
- **Issue Report creation bug, fixed** — a real "Report Vehicle Issue" / "Report Technical Issue" action now exists in the Issue Reports list header for every role holding `issue.create`. Submitting lands directly on that report's own detail page (not back on the list), which already carried a "Create Maintenance Ticket" action for whoever holds `ticket.propose`.
- **Maintenance Personnel issue visibility** — added a "Vehicle Issues" sidebar entry; they see only the reports they personally filed (not the whole barangay's queue — that stays a Custodian/Admin concern, per the original Phase B3 reasoning, just no longer zero visibility into their own).
- **Maintenance → Custodian routing** — filing an issue now notifies that barangay's Admins, and additionally notifies its Custodians when the reporter is Maintenance Personnel only, so the "mechanic finds a fault → Custodian reviews → Custodian proposes a ticket" chain in Decision 4 actually fires a notification instead of relying on someone stumbling onto the report.
- **Audit log role fidelity** — `requireAbility()` now records which of a user's (possibly several) roles actually granted the ability being exercised; `TicketController::log()` and `FleetController::log()` both read that instead of always stamping the primary `role`. A dual-role account's action is now attributed to the hat it was actually performed under.
- **Ticket creation, self-verification, document permissions, schedule ownership, repair-verification chain** — all confirmed already correct against the authoritative decisions; no code changes needed (see §2 for the exact citations proving this).
- **Documentation.md** updated to match (§3, §5, §6).
- **Backend**: 315/315 tests passing, including 6 new/updated tests covering the vehicle-registration delegation, the Maintenance-sees-own-reports scoping change, the audit-log role fidelity, and the Issue Report → Ticket carry-forward (no duplicate data entry). Frontend: `vite build` and `eslint` both clean (eslint's 26 pre-existing `react-hooks/set-state-in-effect` findings are unrelated, in untouched code).

**Deliberately deferred** (flagged, not forgotten) — these are sidebar/navigation polish, not business-rule or security changes, and were left alone to avoid a risky rewrite of the shared sidebar structure under the same pass as the functional changes above:

- Standalone "Vehicle Documents" and "Vehicle History" sidebar pages for Custodian/Admin/Maintenance (documents currently stay a per-vehicle modal reached from a vehicle's profile — functionally complete, just not a separate nav item).
- Merging "Ticket Archives" into the Maintenance Tickets module as a tab instead of its own Admin sidebar row.
- The full Custodian sidebar section regrouping into "Vehicles" / "Vehicle Operations" / "Maintenance" exactly as laid out in the authoritative decisions (the underlying pages all already exist and are reachable; only the grouping/labels differ from the exact spec).
