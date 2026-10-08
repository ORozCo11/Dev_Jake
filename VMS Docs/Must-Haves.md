# Barangay VMS — Must-Haves

What the system must do to be considered complete, grouped by area. "Done" reflects the current `dev-paul` branch; "Gap" items are must-haves that are not fully met yet.

## 1. Fleet Records

- [x] Register a vehicle with type, capacity, brand/model, plate/registration, photo, and current location.
- [x] Support both Land and Water vehicle domains, with domain-specific fields (Hull Material/Engine Type for Water).
- [x] Track vehicle status (Available / Under Maintenance / Inactive) and physical condition independently.
- [x] Vehicle location on a map, grouped by named hubs; hubs cannot be deleted while vehicles are still assigned to them.
- [x] Full activity history per vehicle (location changes, issues, condition checks, maintenance).

## 2. Issue → Repair Workflow

- [x] Anyone can report a vehicle issue with severity, category, and description.
- [x] Admin creates a Maintenance Ticket from an issue (or from scratch), assigning a Custodian.
- [x] 5-phase ticket lifecycle: Open → Custodian inspection → Active (repair/verify/confirm per sub-issue) → Closed.
- [x] A ticket can be closed with unresolved sub-issues only via an explicit "decision close" that records why and whether the vehicle is fit for service.
- [x] Recurring-failure detection: flags when the same fault on the same vehicle has come back.
- [x] Aging flag on tickets open past 30 days.

## 3. Preventive Maintenance

- [x] Schedule a service with a date, type, assigned mechanic, and optional recurrence (Month / Quarter / 6 Months / Year / custom interval).
- [x] Completing a recurring schedule auto-creates the next occurrence.
- [x] Urgency view of upcoming/overdue schedules (Overdue, 1–3 days, 4–7 days, 8+ days).

## 4. Roles & Access

- [x] Three fleet-facing roles — Admin, Custodian, Maintenance Personnel — each sees only the modules relevant to their work.
- [x] A Super Admin role, separate from the fleet app, for platform-level account and Barangay administration.
- [x] Every fleet record (vehicles, tickets, issues, schedules, hubs, activity log) is isolated to its own Barangay.
- [x] New accounts require approval before they can log in — an existing Admin approves Custodian/Maintenance Personnel signups; a Super Admin approves a Barangay's first-ever Admin.
- [x] A repair can never be verified by the same person who logged it, even under a different role on a dual-role account — only an Admin can step in for that case.
- [x] A cannibalized repair (parts taken from another vehicle) requires Admin approval before it proceeds to verification; approving it opens an Issue Report on the donor vehicle.
- [x] A Barangay can never be left with zero active Admins through deactivation or a role change — blocked with a clear error, and flagged as a standing warning (dashboard + Super Admin barangay list) while only one remains.
- [x] Impersonation requires a written reason, expires in 30 minutes, is read-only (every write is rejected except ending the session), and is logged both to the impersonated account's own Barangay Activity Log and the Super Admin's account log — start and end.
- [x] A Super Admin account can be provisioned outside local/testing via `php artisan superadmin:create` — no hardcoded/demo credentials exist in that path.

## 5. Auditability

- [x] Every create/update/status-change is written to an Activity Log, attributable to a user and timestamped.
- [x] Ticket detail view reflects other users' actions without a manual page reload.

## 6. Reporting

- [x] Exportable reports by category (fleet, maintenance, issues, users).
- [x] CSV export and print view on the tables that need it (Vehicle History, Activity Log, Reports).

---

## Known Gaps (must-have, not yet fully met)

1. **Vehicle photo upload.** Currently broken in at least one environment due to invalid/missing Supabase storage credentials — this is a configuration issue, not a code defect, and needs valid credentials supplied by whoever owns the Supabase project.
2. **User profile completeness from partial lookups.** A user's profile page can show blank Role/Phone/Address when opened from a form that only carried a name+email lookup (e.g. a ticket's assigned-custodian dropdown) instead of fetching the full record by ID.
3. **Automated tests.** No automated frontend tests exist for the UI flows described above; verification has been manual/visual. A must-have for long-term maintainability, not yet started. (Backend feature/permission tests are now extensive — see `backend-api/tests/Feature/`.)
4. **Impersonation read-only enforcement is backend-only.** `RestrictImpersonatedToReadOnly` rejects every write server-side, and a persistent banner tells the impersonator the session is read-only, but individual buttons/forms in the UI aren't disabled during an impersonated session — an attempted write still gets rejected, just via a 403 toast rather than the button not being there at all.
5. **A single permission map does not exist yet.** Role checks are still spread across each controller method (`requireRole`, `hasRole`, etc.) rather than one central ability list — planned for Phase B of `VMS-IMPROVEMENT-PLAN.md`.

## Resolved Gaps

- **Registration security (resolved).** The first person to register for a new Barangay used to become its Admin automatically and instantly active, gated only by a shared "Staff Registration Code" that also gated ordinary staff signup — anyone holding that code could race to register first and claim Admin uncontested. **Fix:** every registrant, first-for-Barangay or not, now starts `is_active: false` with no `approved_at`; login is hard-blocked until approved. An existing Admin still approves ordinary Custodian/Maintenance Personnel signups, but a Barangay's first-ever Admin is instead approved by a Super Admin, who is notified the moment that registration happens and reviews it from a dedicated Pending Approvals queue (reject deletes the account outright; approve activates it). See `AuthController::register()`/`notifySuperAdmins()`, `SuperAdminController::pendingApprovals()`/`rejectUser()`, and the Super Admin portal's Pending Approvals tab.
- **Super Admin unusable in production (resolved, Phase A1).** `users.role` was an `enum(['Admin','Custodian','Maintenance Personnel'])` — on a freshly-migrated PostgreSQL database this compiles to a real CHECK constraint that rejects `'Super Admin'` outright (SQLite happened to silently lose the same constraint via an unrelated table rebuild, masking the problem locally). **Fix:** `role` is now a plain validated string (migration `2026_09_25_000001_widen_users_role_column.php`), the demo seeder (`UserSeeder`) is gated to local/testing like the bootstrap migration already was, and `php artisan superadmin:create` is the only production-safe way to provision a real one.
- **Self-verification of a repair (resolved, Phase A2).** A dual-role (Custodian + Maintenance Personnel) account could log a repair and then verify their own work. **Fix:** `TicketController::verifyRepair` now blocks the sub-issue's own mechanic regardless of role, with Admin as a general fallback verifier; `assignMechanic`/`reassignCustodian` warn (non-blocking) when an assignment would create this conflict.
- **Cannibalized repairs had no approval gate (resolved, Phase A3).** Taking a part from another vehicle to fix this one went straight to verification with no record on the donor vehicle. **Fix:** a cannibalized repair now parks at `Pending Approval`; an Admin approves (auto-opens an Issue Report on the donor vehicle, marks it `Needs Inspection`) or rejects (back to `Under Repair`, reason required).
- **A Barangay could be left with zero active Admins (resolved, Phase A4).** Nothing stopped a Super Admin from deactivating, or changing the role of, a Barangay's last remaining Admin. **Fix:** `GuardsLastAdmin` blocks it with a 422 from every relevant endpoint (`UserController::deactivate/update`, `SuperAdminController::deactivateUser/updateUserRole`), and a warning surfaces proactively before it happens (Admin dashboard, Super Admin's barangay list).
- **Impersonation was unrestricted (resolved, Phase A5).** No reason required, a 4-hour expiry, full read/write access, and no visibility into the target Barangay's own Activity Log. **Fix:** reason required, 30-minute expiry, `RestrictImpersonatedToReadOnly` middleware blocks every write except ending/switching the session, start and end are both logged with the target's `barangay_id` set (visible to that Barangay's own Admin as well as the Super Admin), and a persistent banner marks the session throughout.

---

*This list reflects the state of the codebase as of the `Paul/UI-Cleanup-Filters-Tables-Vehicle-Types-Ticket-Detail` and `Paul/Forms-Persist-Draft-On-Back-Navigation` branches merged into `dev-paul`, plus Phase A (Critical fixes) of `VMS-IMPROVEMENT-PLAN.md`. Update it as gaps are closed or new must-haves are identified.*
