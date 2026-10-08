# Role Audit — Barangay Fleet/Vehicle Management System

Scope: `backend-api/` (Laravel) + `frontend-spa/` (React). This report describes what the code actually does, with file:line citations. Where something could not be verified from the code, it is marked **UNCLEAR** with the reason.

Roles found in code: **Super Admin, Admin, Custodian, Maintenance Personnel.**

---

## 1. How roles work in the code

### 1.1 Where roles are defined and stored

- The `users` table's `role` column is a true DB enum, originally `enum('role', ['Admin', 'Custodian', 'Maintenance Personnel'])` (`backend-api/database/migrations/0001_01_01_000000_create_users_table.php:20`), defaulting to `'Custodian'`.
- A `roles` JSON column was added later (`backend-api/database/migrations/2026_07_19_000003_add_roles_to_users.php:23`) to support **multi-role accounts**. Its docblock (lines 10-19) states: `role` stays the account's PRIMARY role (routing/dashboards/display); `roles` holds every hat the account may wear (permission checks). Existing users were backfilled to `roles = [their role]`.
- **`Super Admin` is not in the original DB enum.** It is inserted directly by a seeder, `backend-api/database/migrations/2026_08_31_000001_create_super_admin_account.php:24-46`, which only runs when `app()->environment(['local','testing'])` (line 26). This works because the project's `.env` sets `DB_CONNECTION=sqlite` (verified: `backend-api/.env:33`, `backend-api/config/database.php:20`), and no migration ever widens the MySQL-style enum — a real MySQL deployment inserting `'Super Admin'` into a strict enum column would fail. No migration alters the `role` column's enum list anywhere in `backend-api/database/migrations/`. This is **UNCLEAR/worth flagging**: the code has no migration that formally adds `'Super Admin'` to the enum; it only works because local/testing runs on sqlite, which does not enforce the enum as a hard constraint the way MySQL would.
- `backend-api/app/Models/User.php` casts `roles` to an array (`:46`) and provides:
  - `hasRole(string $role): bool` (`User.php:75-81`) — delegates to `allRoles()`.
  - `hasAnyRole(array $roles): bool` (`User.php:83-92`).
  - `allRoles(): array` (`User.php:97-105`) — the effective role set, always including the primary `role` even if `roles` doesn't list it.
  - `scopeHavingRole($query, string $role)` (`User.php:112-118`) — a query scope matching users whose primary `role` equals the value OR whose `roles` JSON text contains it (portable `LIKE` match, not a JSON-column operator, so it works identically on sqlite and Postgres).

### 1.2 How a multi-role user is handled

- **Combined permissions, not a merged role.** Per `User.php:68-74`'s docblock: "One person in a small barangay can hold, e.g., `['Custodian', 'Maintenance Personnel']` and act under each — the action taken records which function they performed." Every backend authorization check (`hasRole`/`hasAnyRole`) is OR-based across the full `roles` array, so a dual-role user simply passes every gate either role individually would pass.
- **Admin creation UI**: `backend-api/app/Http/Controllers/UserController.php:40-51` (`normalizeRoles`) accepts a `roles[]` multi-select or a single `role`, and sets the *first* role in the list as primary.
- **Self-lockout guard**: if a sole Admin edits their own account and removes `'Admin'` from their own `roles[]`, `UserController.php:129-135` aborts 422 — "You cannot remove your own Admin role." No equivalent check exists elsewhere for "the last Admin in a barangay" being deactivated by *someone else* (see §7).
- **Frontend nav**: `frontend-spa/src/views/Workspace.jsx:163-187` (`resolveModuleGroups`) shows the **union** of every sidebar module across all of a user's roles — a Custodian+Maintenance Personnel account's sidebar shows both role's module groups merged (confirmed directly and by background research; e.g. both "Assigned Inspections"/"Repair Verifications" (Custodian) and "My Work Orders" (Maintenance Personnel) appear together).
- **⚠️ Route-level gate uses only the PRIMARY role, not the multi-role array.** `frontend-spa/src/components/ProtectedRoute.jsx:30`: `if (allowedRoles && !allowedRoles.includes(user?.role))` — checks `user.role` (primary) only. `frontend-spa/src/App.jsx:41-72` wires `/admin/*`→`['Admin']`, `/custodian/*`→`['Custodian']`, `/maintenance/*`→`['Maintenance Personnel']`, `/superadmin/*`→`['Super Admin']`. A multi-role user can therefore only ever land on the route matching their PRIMARY role; navigating directly to a secondary role's dedicated URL (e.g. a primary-Custodian account typing `/maintenance`) is blocked by `ProtectedRoute` even though, once inside their primary-role `Workspace`, the merged sidebar already gives them that role's modules and in-page actions. This is an inconsistency between the route guard (primary-role-only) and the in-page module/action gates (mostly roles-array-aware via `hasRole`) — flagged in §4/§8b.
- **⚠️ Inconsistent client-side gating style inside `Workspace.jsx` itself**: most gates use the roles-array-aware `hasRole(user, 'X')` helper (`Workspace.jsx:139-144`), but several spots use a plain primary-role string compare (`role === 'Admin'`) instead, which would behave differently for a multi-role user whose primary role isn't the exact string, even though `hasRole` would still say true. Concretely:
  - `UserViewPage`'s Edit button: `role === 'Admin'` — `Workspace.jsx:5280`.
  - `IssueViewPage`'s Create Ticket / Send to External Shop buttons: `role === 'Admin'` — `Workspace.jsx:5391`.
  - `conditionColumns(user.role, ...)` action-column gate: `['Custodian', 'Admin'].includes(role)` — `Workspace.jsx:8316`, called with the primary role string at `Workspace.jsx:1827`.
  - `TicketDetailPanel`/`TicketProfilePage` are passed `role={user.role}` (primary string only, `Workspace.jsx:2579`), and internally `isAdmin = role === 'Admin'` (`Workspace.jsx:11233`) — every Admin-only ticket action (reassign, assign mechanic, defer, close, cancel, delete, confirm) is gated on this primary-role string, not `hasRole`.
  - In practice this is likely harmless since Admin does not appear to be combined with other roles in the seed data, but it is a real inconsistency in the code, not just a naming quirk.

### 1.3 How the role gets into the Sanctum token, and where abilities are checked

- On login, `backend-api/app/Http/Controllers/AuthController.php:264`: `$user->createToken('auth_token', $user->allRoles())->plainTextToken` — the token's Sanctum **abilities** are set to the user's full role list.
- On impersonation, `AuthController.php:374`: `$user->createToken('impersonation_token', [...$user->allRoles(), 'impersonated'], now()->addHours(4))` — same role-list abilities plus a special `'impersonated'` ability, and an explicit 4-hour expiry independent of the global Sanctum token-expiration setting.
- **However, these role-name abilities are never actually checked anywhere.** A full-repo search found no `->tokenCan(...)` calls and exactly one `->can(...)` call on a token: `AuthController.php:310`, inside `canImpersonate()`, checking `$request->user()?->currentAccessToken()?->can('impersonated')` — i.e. only the special `'impersonated'` ability is ever consulted. Every other authorization check in every controller (`requireRole`, `requireAdmin`, `requireSuperAdmin`, `hasRole`, `hasAnyRole`) queries the **live `User` model's `role`/`roles` columns** via `$request->user()`, not the token's baked-in abilities. So baking role names into the token abilities is effectively informational/vestigial except for the one `'impersonated'` ability, which exists purely so an impersonation session can be told apart from a normal login (used in `canImpersonate()`, `AuthController.php:306-311`, to let an already-impersonating session switch to yet another account).
- **Where roles are actually checked**: every protected controller method calls a small private helper — `requireRole($request, [...])` / `requireAdmin($request)` / `requireSuperAdmin($request)` — which all reduce to `abort_unless($request->user()->hasAnyRole($roles), 403, ...)` or `hasRole('Admin')`/`hasRole('Super Admin')`. See e.g. `FleetController.php:2685-2688`, `TicketController.php:1595-1598`, `UserController.php:18-21`, `SuperAdminController.php:43-46`.

### 1.4 Every middleware or scoping mechanism related to roles/tenancy

All four registered middleware classes are in `backend-api/app/Http/Middleware/`. The protected-route group is defined once, in `backend-api/routes/api.php:58`: `Route::middleware(['auth:sanctum', EnsureUserIsActive::class, RestrictSuperAdminScope::class])->group(...)` — i.e. every route inside that group (essentially the whole app except `/login`, `/register`, `/registration-status`, `/provinces*`, `/cities*`, `/barangays*`, `/concern-reports`) runs all three of these in order:

| Middleware | File | What it does | Applies to |
|---|---|---|---|
| `auth:sanctum` (Laravel/Sanctum built-in) | — | Resolves the Bearer token to a `User`; 401s if invalid/missing. | Every route in the group, `routes/api.php:58`. |
| `EnsureUserIsActive` | `app/Http/Middleware/EnsureUserIsActive.php:15-27` | `abort(401, 'This account has been deactivated.')` if `$user->is_active` is false. Exists because deactivation must take effect immediately, not just block future logins — a token issued before deactivation would otherwise keep working. | Every route in the group. |
| `RestrictSuperAdminScope` | `app/Http/Middleware/RestrictSuperAdminScope.php:23-47` | If the user `hasRole('Super Admin')`, only lets the request through when its first path segment is `superadmin`, `impersonate`, or `notifications` (`ALLOWED_PREFIXES`, line 25), or the exact path is `logout`, `user`, `profile`, `profile/password`, or `greeting` (`ALLOWED_EXACT`, line 26) — otherwise `abort(403, 'Super Admin accounts are limited to account administration and cannot access fleet data.')`. Non-Super-Admin users pass through untouched (line 32-34). This is the mechanism that keeps a Super Admin out of every fleet endpoint. | Every route in the group. |
| `SanitizeInput` | `app/Http/Middleware/SanitizeInput.php:26-56` | Strips NULL/control bytes from string input (not an HTML sanitizer; explicitly not role-related). Registered as global middleware in `bootstrap/app.php` per its docblock, not tied to roles. | Not role/tenancy related; included here only because it was named as an "any middleware" candidate. |
| `SecurityHeaders` | `app/Http/Middleware/SecurityHeaders.php:24-53` | Adds security response headers (CSP, X-Frame-Options, etc.). Not role/tenancy related. | Global. |

**`BelongsToBarangay` and `ScopedThroughVehicle` are NOT HTTP middleware — they are Eloquent model traits** (`backend-api/app/Models/Concerns/`) that add a global query scope + creation-time stamp:

- `BelongsToBarangay` (`app/Models/Concerns/BelongsToBarangay.php:30-46`): applied to a model that carries its own `barangay_id` column (`Vehicle`, `VehicleHub`, `ActivityLog`). Its `bootBelongsToBarangay()` adds a global scope that, whenever `Auth::check() && Auth::user()->barangay_id`, filters every query (including route-model-binding lookups) to `barangay_id = Auth::user()->barangay_id` (lines 34-38), and stamps new rows with it on create (lines 40-44). A no-op for an unauthenticated request or for a user with no `barangay_id` (a Super Admin never has one — see line 21 docblock — which is exactly what lets a Super Admin see across barangays on the few endpoints they can reach). **Deliberately never applied to `User` itself** — the docblock (lines 21-28) explains that doing so would recurse into Sanctum's own `Auth::user()` resolution and crash the dev server; `User` scoping is instead done by hand with explicit `->where('barangay_id', ...)` filters in `UserController`.
- `ScopedThroughVehicle` (`app/Models/Concerns/ScopedThroughVehicle.php:16-36`): for a model with no `barangay_id` of its own but that always belongs to a `Vehicle` (directly or via a parent relation, e.g. `TicketSubIssue` overrides `vehicleRelationPath()` to `'ticket.vehicle'`, `TicketSubIssue.php:20-24`). Its global scope does `whereRelation($vehicleRelationPath, 'barangay_id', Auth::user()->barangay_id)`. Applied to: `MaintenanceTicket`, `TicketSubIssue`, `VehicleIssueReport`, `VehicleMaintenanceRecord`, `VehicleMaintenanceSchedule`, `VehicleConditionCheck`, `VehicleReadinessCheck`, `VehicleDocument`, `VehicleHistory`, `VehicleLocation`, `TicketArchiveLog`.

Neither trait distinguishes between Admin/Custodian/Maintenance Personnel — it is purely tenant (barangay) scoping, identical for all three fleet roles. Role-specific restriction is layered on top, per-endpoint, by the `requireRole`/`requireAdmin` calls described in §1.3.

**No Laravel Policy classes exist anywhere in the codebase** (`app/Policies/` does not exist; a repo-wide search for policy classes found none). All authorization is done imperatively inside controller methods.

---

## 2. Backend: every API route

Source: `backend-api/routes/api.php` (255 lines, read in full). "Allowed-but-scoped" means the role can call the route but only sees/affects data already scoped to their own barangay (via the traits in §1.4) or to records tied to their own id. A route with **no role check at all** (any authenticated, active, non-Super-Admin user can call it) is flagged ⚠️. Public routes (no `auth:sanctum`) are marked accordingly and have no role columns in the normal sense.

### 2.1 Public routes (no Bearer token required) — `routes/api.php:26-51`

| Method | URI | Controller@method | What it does | Where enforced |
|---|---|---|---|---|
| POST | /login | AuthController@login | Authenticates, issues Sanctum token. Rate-limited 10/min. | Public; `routes/api.php:26` |
| POST | /register | AuthController@register | Self-registration; account created inactive pending approval. Rate-limited 5/min. | Public; `routes/api.php:29` |
| GET | /registration-status | AuthController@registrationStatus | "Would I become this barangay's first Admin?" preview. Rate-limited 20/min. | Public; `routes/api.php:33` |
| GET | /provinces | ProvinceController@index | Full nationwide province list. | Public; `routes/api.php:37` |
| GET | /provinces/with-barangays | ProvinceController@withBarangays | Provinces that have a city with real barangay data (map selector). | Public; `routes/api.php:40` |
| GET | /cities | CityController@index | Cities for a given province. | Public; `routes/api.php:41` |
| GET | /cities/{city} | CityController@show | Single city + boundary geometry. | Public; `routes/api.php:42` |
| GET | /barangays | BarangayController@index | Barangays for a given city. | Public; `routes/api.php:43` |
| GET | /barangays/registered | BarangayController@registered | Barangays with ≥1 real registered user (+ Paknaan always). | Public; `routes/api.php:46` |
| GET | /barangays/{barangay} | BarangayController@show | Single barangay + boundary geometry. | Public; `routes/api.php:47` |
| POST | /concern-reports | ConcernReportController@store | Public "Report a Concern" form, no account needed. Rate-limited 5/min. | Public; `routes/api.php:51` |

### 2.2 Protected routes — `auth:sanctum, EnsureUserIsActive, RestrictSuperAdminScope` group, `routes/api.php:58-255`

Legend: A=Admin, C=Custodian, M=Maintenance Personnel, SA=Super Admin. "—" = blocked by `RestrictSuperAdminScope` (any route not under `superadmin/`, `impersonate/`, `notifications/`, or the small `ALLOWED_EXACT` list is 403 for SA).

| Method | URI | Controller@method | What it does | SA | A | C | M | Where enforced |
|---|---|---|---|---|---|---|---|---|
| POST | /logout | AuthController@logout | Revoke current token. | Allowed | Allowed | Allowed | Allowed | `RestrictSuperAdminScope.php:26` (ALLOWED_EXACT) |
| GET | /user | (closure) return $request->user() | Current user info. | Allowed | Allowed | Allowed | Allowed | `RestrictSuperAdminScope.php:26`; route closure `routes/api.php:64-66` |
| GET | /impersonate/candidates | AuthController@impersonationCandidates | List accounts that can be impersonated. | Allowed | ⚠️ dev-only, Admin or SA | Blocked (403) | Blocked (403) | `AuthController.php:325-328` (`assertImpersonationEnabled`, `canImpersonate`) |
| POST | /impersonate/{user} | AuthController@impersonate | Issue a 4h token as another user. | Allowed (prod) | ⚠️ dev-only | Blocked | Blocked | `AuthController.php:356-368` |
| GET | /greeting | AuthController@greeting | Time-of-day greeting text. | Allowed | Allowed | Allowed | Allowed | `RestrictSuperAdminScope.php:26` |
| PUT | /profile/password | AuthController@updatePassword | Self password change. | Allowed | Allowed | Allowed | Allowed | `RestrictSuperAdminScope.php:26` |
| PUT | /profile | AuthController@updateProfile | Self profile edit. | Allowed | Allowed | Allowed | Allowed | `RestrictSuperAdminScope.php:26` |
| GET | /lookups | FleetController@lookups | Dropdown data (categories, vehicles, personnel, catalogs). | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:41` (no `requireRole`) |
| GET | /dashboard | FleetController@dashboard | Role-varying dashboard payload (see §3/§4). | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:81` |
| GET | /fault-categories | CatalogController@faultCategories | List fault-category catalog. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `CatalogController.php:30` |
| POST | /fault-categories | CatalogController@storeFaultCategory | Add a fault category. | — | Allowed | Allowed | Allowed | `CatalogController.php:37` (`requireRole(['Admin','Custodian','Maintenance Personnel'])`) |
| PUT | /fault-categories/{id} | CatalogController@updateFaultCategory | Rename (cascades to tickets/issue reports). | — | Allowed | Blocked | Blocked | `CatalogController.php:52` |
| DELETE | /fault-categories/{id} | CatalogController@destroyFaultCategory | Delete if unused. | — | Allowed | Blocked | Blocked | `CatalogController.php:74` |
| GET | /maintenance-types | CatalogController@maintenanceTypes | List maintenance-type catalog. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `CatalogController.php:86` |
| POST | /maintenance-types | CatalogController@storeMaintenanceType | Add a maintenance type. | — | Allowed | Allowed | Allowed | `CatalogController.php:93` |
| PUT | /maintenance-types/{id} | CatalogController@updateMaintenanceType | Rename (cascades). | — | Allowed | Blocked | Blocked | `CatalogController.php:101` |
| DELETE | /maintenance-types/{id} | CatalogController@destroyMaintenanceType | Delete if unused. | — | Allowed | Blocked | Blocked | `CatalogController.php:124` |
| GET | /categories | FleetController@categories | List vehicle types. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:681` |
| POST | /categories | FleetController@storeCategory | Add vehicle type. | — | Allowed | Blocked | Blocked | `FleetController.php:688` |
| PUT | /categories/{id} | FleetController@updateCategory | Edit vehicle type. | — | Allowed | Blocked | Blocked | `FleetController.php:704` |
| DELETE | /categories/{id} | FleetController@deleteCategory | Delete if unused fleet-wide. | — | Allowed | Blocked | Blocked | `FleetController.php:725` |
| GET | /vehicles | FleetController@vehicles | List vehicles (barangay-scoped). | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:746` |
| POST | /vehicles | FleetController@storeVehicle | Add vehicle. | — | Allowed | Blocked | Blocked | `FleetController.php:801` |
| PUT | /vehicles/{id} | FleetController@updateVehicle | Edit vehicle. | — | Allowed | Blocked | Blocked | `FleetController.php:828` |
| DELETE | /vehicles/{id} | FleetController@archiveVehicle | Archive (soft, blocks if open tickets). | — | Allowed | Blocked | Blocked | `FleetController.php:869` |
| POST | /vehicles/{id}/restore | FleetController@restoreVehicle | Un-archive/un-decommission. | — | Allowed | Blocked | Blocked | `FleetController.php:894` |
| PUT | /vehicles/{id}/decommission | FleetController@decommissionVehicle | End-of-life write-off. | — | Allowed | Blocked | Blocked | `FleetController.php:934` |
| GET | /vehicles/{id}/reliability | FleetController@vehicleReliability | Reliability/cost analytics for one vehicle. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:625` |
| GET | /vehicles/{id}/readiness | FleetController@vehicleReadiness | Readiness state + check history. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:1076` |
| POST | /vehicles/{id}/readiness-check | FleetController@storeReadinessCheck | Log a pre-deployment checklist. | — | Allowed | Allowed | Blocked | `FleetController.php:975` |
| PUT | /vehicles/{id}/mark-available | FleetController@markVehicleAvailable | Shortcut after a passing check. | — | Allowed | Allowed | Blocked | `FleetController.php:1031` |
| GET | /vehicles/{id}/open-tickets | TicketController@openTicketsForVehicle | Duplicate-ticket aid. | — | Allowed | Blocked | Blocked | `TicketController.php:128` |
| GET | /vehicles/{id}/recurrence | FleetController@checkVehicleRecurrence | On-demand recurrence check. | — | Allowed | Allowed | Blocked | `FleetController.php:1278` |
| GET | /vehicles/{id}/documents | FleetController@vehicleDocuments | List a vehicle's file cabinet. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:1490` |
| POST | /vehicles/{id}/documents | FleetController@storeVehicleDocument | Upload a document. | — | Allowed | Allowed | Allowed | `FleetController.php:1500` |
| PUT | /documents/{id} | FleetController@updateVehicleDocument | Edit/replace a document. | — | Allowed | Allowed | Allowed | `FleetController.php:1528` |
| DELETE | /documents/{id} | FleetController@destroyVehicleDocument | Delete any document. | — | Allowed | Allowed | Allowed | `FleetController.php:1549` |
| GET | /locations | FleetController@locations | List location-change records. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:1093` |
| POST | /locations | FleetController@storeLocation | Update a vehicle's location. | — | Allowed | Blocked | Blocked | `FleetController.php:1110` |
| GET | /users | UserController@index | List users in own barangay. | — | Allowed | Blocked | Blocked | `UserController.php:55`; barangay filter `:57` |
| POST | /users | UserController@store | Add a user to own barangay. | — | Allowed | Blocked | Blocked | `UserController.php:79` |
| PUT | /users/{id} | UserController@update | Edit a user (own barangay only). | — | Allowed-but-scoped | Blocked | Blocked | `UserController.php:112-113` (`requireAdmin`+`requireSameBarangay`) |
| PUT | /users/{id}/deactivate | UserController@deactivate | Deactivate (own barangay, not self). | — | Allowed-but-scoped | Blocked | Blocked | `UserController.php:155-157` |
| PUT | /users/{id}/activate | UserController@activate | Activate/approve (own barangay). | — | Allowed-but-scoped | Blocked | Blocked | `UserController.php:169-170` |
| GET | /registration-settings | UserController@registrationSettings | View own barangay's staff code. | — | Allowed | Blocked | Blocked | `UserController.php:200` |
| POST | /registration-settings/regenerate | UserController@regenerateRegistrationCode | Regenerate own barangay's code. | — | Allowed | Blocked | Blocked | `UserController.php:207` |
| GET | /superadmin/barangays | SuperAdminController@barangays | Every barangay + admin/coverage status. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:66` |
| POST | /superadmin/barangays | SuperAdminController@storeBarangay | Add a barangay (any province/city). | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:98` |
| GET | /superadmin/users | SuperAdminController@users | Every user, every barangay. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:318` |
| GET | /superadmin/pending-approvals | SuperAdminController@pendingApprovals | Every unapproved account. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:394` |
| PUT | /superadmin/users/{id}/activate | SuperAdminController@activateUser | Approve/activate any user. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:344` |
| PUT | /superadmin/users/{id}/deactivate | SuperAdminController@deactivateUser | Deactivate any user (not self). | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:354-355` |
| DELETE | /superadmin/users/{id}/reject | SuperAdminController@rejectUser | Delete a never-approved registration. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:374-375` |
| PUT | /superadmin/users/{id}/role | SuperAdminController@updateUserRole | Change any user's role. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:420-422` |
| GET | /superadmin/barangays/{id}/registration-code | SuperAdminController@registrationCode | View any barangay's staff code. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:436` |
| POST | /superadmin/barangays/{id}/registration-code/regenerate | SuperAdminController@regenerateRegistrationCode | Regenerate any barangay's code. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:443` |
| POST | /superadmin/barangays/{id}/boundary/refresh | SuperAdminController@refreshBarangayBoundary | Retry OSM boundary lookup. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:148` |
| GET | /superadmin/activity-log | SuperAdminController@activityLog | Account-level activity log, platform-wide. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:463` |
| GET | /superadmin/concern-reports | SuperAdminController@concernReports | List "Report a Concern" submissions. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:481` |
| PUT | /superadmin/concern-reports/{id}/resolve | SuperAdminController@resolveConcernReport | Mark resolved. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:488` |
| PUT | /superadmin/concern-reports/{id}/reopen | SuperAdminController@reopenConcernReport | Reopen. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:502` |
| DELETE | /superadmin/concern-reports/{id} | SuperAdminController@destroyConcernReport | Permanently delete. | Allowed | Blocked | Blocked | Blocked | `SuperAdminController.php:518` |
| GET | /hubs | HubController@index | List location hubs. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `HubController.php:16` |
| POST | /hubs | HubController@store | Add a custom hub. | — | Allowed | Blocked | Blocked | `HubController.php:28` |
| PUT | /hubs/{id} | HubController@update | Edit/hide a hub. | — | Allowed | Blocked | Blocked | `HubController.php:58` |
| DELETE | /hubs/{id} | HubController@destroy | Delete a non-default hub. | — | Allowed | Blocked | Blocked | `HubController.php:80` |
| GET | /conditions | FleetController@conditions | List condition checks. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:1133` |
| POST | /conditions | FleetController@storeCondition | Log a condition check. | — | Allowed | Allowed | Blocked | `FleetController.php:1145` |
| PUT | /conditions/{id} | FleetController@updateCondition | Edit any condition check. | — | Allowed | Allowed | Blocked | `FleetController.php:1182` |
| DELETE | /conditions/{id} | FleetController@deleteCondition | Delete any condition check. | — | Allowed | Allowed | Blocked | `FleetController.php:1217` |
| GET | /issues | FleetController@issues | List issue reports (see §3 for scoping). | — | Allowed | Allowed | Allowed | `FleetController.php:1290`; ⚠️ no `requireRole` call — any authenticated role. |
| GET | /vehicles/{id}/open-issues | FleetController@openIssuesForVehicle | Duplicate-report aid. | — | Allowed | Allowed | Allowed | `FleetController.php:1477` |
| GET | /issues/{id} | FleetController@showIssue | Single issue detail. | — | Allowed | Allowed | Allowed | `FleetController.php:1263` |
| POST | /issues | FleetController@storeIssue | File an issue report. | — | Allowed | Allowed | Allowed | `FleetController.php:1327` |
| PUT | /issues/{id} | FleetController@updateIssue | Edit (Admin/Maint: any; pure Custodian: only own, only while Pending). | — | Allowed | Allowed-but-scoped | Allowed | `FleetController.php:1377-1381` |
| DELETE | /issues/{id} | FleetController@destroyIssue | Delete (Admin: any; pure Custodian: only own, only while Pending). | — | Allowed | Allowed-but-scoped | Blocked (falls to `requireRole(['Admin'])`) | `FleetController.php:1454-1461` |
| GET | /maintenance-records | FleetController@maintenanceRecords | List maintenance records. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:1557` |
| GET | /maintenance-records/{id} | FleetController@showMaintenanceRecord | Single record detail. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:1599` |
| POST | /maintenance-records | FleetController@storeMaintenanceRecord | Log a standalone repair. | — | Allowed | Allowed | Allowed | `FleetController.php:1606` |
| PUT | /maintenance-records/{id} | FleetController@updateMaintenanceRecord | Edit a record. | — | Allowed | Allowed | Allowed | `FleetController.php:1764` |
| PUT | /maintenance-records/{id}/verify | FleetController@verifyMaintenance | Custodian pass/fail (not own repair). | — | Blocked | Allowed-but-scoped | Blocked | `FleetController.php:1901`, self-block `1925-1929` |
| PUT | /maintenance-records/{id}/confirm | FleetController@confirmMaintenance | Final Admin confirm/reopen. | — | Allowed | Blocked | Blocked | `FleetController.php:1968` |
| PUT | /maintenance-records/{id}/decision-close | FleetController@decisionCloseMaintenance | Admin closes without verification. | — | Allowed | Blocked | Blocked | `FleetController.php:2053` |
| GET | /maintenance-schedules | FleetController@schedules | List schedules. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `FleetController.php:2129` |
| POST | /maintenance-schedules | FleetController@storeSchedule | Add a schedule entry. | — | Allowed | Allowed | Allowed | `FleetController.php:2165` |
| PUT | /maintenance-schedules/{id} | FleetController@updateSchedule | Edit a schedule. | — | Allowed | Blocked | Blocked | `FleetController.php:2224` |
| PUT | /maintenance-schedules/{id}/complete | FleetController@completeSchedule | Mark done (Admin: any; Maint: only own assignment). | — | Allowed | Blocked | Allowed-but-scoped | `FleetController.php:2287`, ownership `2297-2305` |
| POST | /maintenance-schedules/{id}/restore | FleetController@restoreSchedule | Restore a cancelled schedule. | — | Allowed | Blocked | Blocked | `FleetController.php:2486` |
| DELETE | /maintenance-schedules/{id} | FleetController@deleteSchedule | Cancel (soft) a schedule. | — | Allowed | Blocked | Blocked | `FleetController.php:2468` |
| GET | /histories | FleetController@histories | Vehicle history log. | — | Allowed | Blocked | Blocked | `FleetController.php:2525` |
| GET | /reports | FleetController@reports | Generate a report. | — | Allowed | Blocked | Blocked | `FleetController.php:2558` |
| GET | /logs | FleetController@logs | Activity log (fleet-operational). | — | Allowed | Blocked | Blocked | `FleetController.php:2537` |
| GET | /tickets/lookups | TicketController@lookups | Ticket-form dropdown data. | — | ⚠️ no role check | ⚠️ no role check | ⚠️ no role check | `TicketController.php:99` |
| GET | /tickets | TicketController@index | List tickets (see §3 for scoping). | — | Allowed | Allowed-but-scoped | Allowed-but-scoped | `TicketController.php:56-73`; ⚠️ no `requireRole` — any authenticated role reaches this action, scoping is applied internally |
| GET | /tickets/{id} | TicketController@show | Single ticket + sub-issues, full detail. | — | Allowed | Allowed | Allowed | `TicketController.php:94`; ⚠️ **no role check AND no ownership/assignment scoping** — any authenticated Admin/Custodian/Maintenance user in the same barangay can view ANY ticket by id directly, not just their own assignments (only `ScopedThroughVehicle`'s barangay scope applies) |
| POST | /tickets | TicketController@createTicket | Create Main Issue, assign Custodian. | — | Allowed | Blocked | Blocked | `TicketController.php:161` |
| PUT | /tickets/{id}/inspect | TicketController@submitInspection | Submit inspection, populate sub-issues. | — | Blocked | Allowed-but-scoped | Blocked | `TicketController.php:401`, ownership `403` |
| POST | /tickets/{id}/sub-issues | TicketController@addSubIssue | Append a discovered sub-issue. | — | Blocked | Allowed-but-scoped | Allowed-but-scoped | `TicketController.php:490`, ownership `493-497` |
| PUT | /tickets/{id}/sub-issues/{sid}/assign-mechanic | TicketController@assignMechanic | Dispatch work order. | — | Allowed | Blocked | Blocked | `TicketController.php:540` |
| PUT | /tickets/{id}/sub-issues/{sid}/reassign-mechanic | TicketController@reassignMechanic | Hand off to a different mechanic. | — | Allowed | Blocked | Blocked | `TicketController.php:598` |
| PUT | /tickets/{id}/reassign-custodian | TicketController@reassignCustodian | Hand off inspector/verifier role. | — | Allowed | Blocked | Blocked | `TicketController.php:670` |
| PUT | /tickets/{id}/sub-issues/{sid}/log-repairs | TicketController@logRepairs | Log physical repair work. | — | Blocked | Blocked | Allowed-but-scoped | `TicketController.php:749`, ownership `752` |
| PUT | /tickets/{id}/sub-issues/{sid}/verify | TicketController@verifyRepair | Functional-test verify/reject. | — | Blocked | Allowed-but-scoped | Blocked | `TicketController.php:825`, ownership `828` — **no check against who logged the repair (see §5)** |
| PUT | /tickets/{id}/sub-issues/{sid}/confirm | TicketController@confirmSubIssue | Final Admin Confirm/Reopen. | — | Allowed | Blocked | Blocked | `TicketController.php:912` |
| PUT | /tickets/{id}/sub-issues/{sid}/reopen-confirmed | TicketController@reopenConfirmedSubIssue | Un-confirm a Done sub-issue. | — | Allowed | Blocked | Blocked | `TicketController.php:988` |
| PUT | /tickets/{id}/sub-issues/{sid}/defer | TicketController@deferSubIssue | Record a "won't fix now" decision. | — | Allowed | Blocked | Blocked | `TicketController.php:1183` |
| PUT | /tickets/{id}/close | TicketController@closeTicket | Explicit close (N/N or decision-close). | — | Allowed | Blocked | Blocked | `TicketController.php:1048` |
| PUT | /tickets/{id}/cancel | TicketController@cancelTicket | Cancel before close. | — | Allowed | Blocked | Blocked | `TicketController.php:1221` |
| PUT | /tickets/{id}/uncancel | TicketController@uncancelTicket | Restore a cancelled ticket. | — | Allowed | Blocked | Blocked | `TicketController.php:1261` |
| DELETE | /tickets/{id} | TicketController@deleteTicket | Delete (blocked once Closed). | — | Allowed | Blocked | Blocked | `TicketController.php:1296` |
| GET | /ticket-archives | TicketController@archives | Archived-ticket audit log. | — | Allowed | Blocked | Blocked | `TicketController.php:138` |
| PUT | /ticket-archives/{id}/reopen | TicketController@reopenArchive | Reopen a "Deleted" archive entry. | — | Allowed | Blocked | Blocked | `TicketController.php:1329` |
| GET | /notifications | NotificationController@index | Own notifications only. | Allowed | Allowed | Allowed | Allowed | `NotificationController.php:13-23`, self-scoped by `user_id` query, no role check |
| PUT | /notifications/read-all | NotificationController@markAllAsRead | Mark all own as read. | Allowed | Allowed | Allowed | Allowed | `NotificationController.php:44-55` |
| PUT | /notifications/{id}/read | NotificationController@markAsRead | Mark one as read (own only, else 403). | Allowed | Allowed | Allowed | Allowed | `NotificationController.php:28-39` |
| DELETE | /notifications/{id} | NotificationController@destroy | Delete (own only, else 403). | Allowed | Allowed | Allowed | Allowed | `NotificationController.php:60-69` |

---

## 3. Data scoping per list endpoint

| Endpoint | Backend scoping | Notes |
|---|---|---|
| `/vehicles` | `BelongsToBarangay` global scope → all vehicles in the viewer's own barangay. No role-based narrowing — Admin, Custodian, Maintenance Personnel all see the identical barangay-wide list. | `FleetController.php:746-797`, `Vehicle.php:10` |
| `/issues` | `ScopedThroughVehicle` → barangay-wide by default. **Frontend adds `?mine=1` only for a pure Custodian** (`hasRole(user,'Custodian') && !hasRole(user,'Admin')`, `Workspace.jsx:740-742`), which the backend honors at `FleetController.php:1298-1299` (`if ($request->boolean('mine')) $query->where('reported_by', ...)`). Admin and Maintenance Personnel get the full barangay-wide, non-retired-vehicle list (`FleetController.php:1295-1296` excludes Inactive/Decommissioned vehicles' issues). So: **Custodian receives only their own filed reports; Admin and Maintenance Personnel receive every issue report in the barangay.** The backend's `mine` param is opt-in — it is the frontend, not the backend, that decides who gets scoped. | `FleetController.php:1290-1319`, `Workspace.jsx:740-742` |
| `/tickets` | `ScopedThroughVehicle` (barangay) PLUS an internal role filter at `TicketController.php:64-73`: if `!$user->hasRole('Admin')`, the query is `WHERE (assigned_custodian_id = me) OR (a sub-issue's assigned_mechanic_id = me)` (OR'd across whichever of Custodian/Maintenance the account holds). **Admin sees every ticket in the barangay; Custodian sees only tickets where they are the assigned Custodian; Maintenance Personnel sees only tickets containing a sub-issue assigned to them; a dual-role account sees the union.** This is real backend scoping, not just frontend filtering. | `TicketController.php:56-92` |
| `/tickets/{id}` (single) | **No ownership scoping at all** — only the barangay scope from `ScopedThroughVehicle`. Any Custodian or Maintenance Personnel in the barangay can open any ticket's full detail by id/URL, not just tickets assigned to them. | `TicketController.php:94-97` |
| `/ticket-archives` | Admin-only route; barangay-scoped via `ScopedThroughVehicle` on `TicketArchiveLog`. | `TicketController.php:136-153` |
| `/conditions` | `ScopedThroughVehicle` (barangay). No role-based narrowing — Admin/Custodian both see every condition check in the barangay (Maintenance Personnel cannot reach the module in the UI, though the GET route itself has no role check). | `FleetController.php:1133-1141` |
| `/maintenance-schedules` | `ScopedThroughVehicle` (barangay). No `mine` filter is applied server-side or by the frontend's generic `loadModule` — **every role that can reach the module sees the full barangay-wide schedule list** (the Maintenance Personnel-only "Assigned to You" *stat card and sort order* are client-side presentational sugar on top of the same full list, `Workspace.jsx:3457, 3472`, not a separate scoped fetch). | `FleetController.php:2129-2156`, `Workspace.jsx:721-757` |
| `/maintenance-records` | `ScopedThroughVehicle` (barangay). Optional `?mine=1` (self, by `maintenance_personnel_id`), `?history=1` (Completed only), `?for_verification=1` (For Verification only) — **the frontend only ever sends `for_verification=1`** (for the Custodian "Maintenance Status" module, `Workspace.jsx:744-746`); it never sends `mine=1` for this endpoint, so **every role sees the full barangay-wide record list** by default in the "Maintenance Records" module. | `FleetController.php:1557-1597`, `Workspace.jsx:721-757` |
| `/histories`, `/reports`, `/logs` | Admin-only routes; barangay-scoped via the underlying models' traits (`VehicleHistory`/`ActivityLog` use `ScopedThroughVehicle`/`BelongsToBarangay` respectively). Not applicable to other roles since they cannot reach these routes. | `FleetController.php:2523-2554` |
| `/users` | Explicit hand-written scope (User has no global scope): `User::where('barangay_id', $request->user()->barangay_id)` — Admin-only, own barangay only, never other barangays. | `UserController.php:53-57` |
| `/superadmin/users`, `/superadmin/barangays`, `/superadmin/pending-approvals`, `/superadmin/activity-log`, `/superadmin/concern-reports` | Deliberately **unscoped** — Super Admin sees every barangay/user/log entry platform-wide. `activityLog()` is further restricted to `ACCOUNT_MODULES = ['Super Admin','Dev Tools','Profile']` so fleet-operational log entries never leak through. | `SuperAdminController.php:41, 316-320, 392-398, 461-470` |
| `/notifications` | Self-scoped by `user_id` — every role only ever sees their own notifications; no role check needed since ownership is the only relevant boundary. | `NotificationController.php:13-23` |

---

## 4. Frontend: what each role sees

Source: `frontend-spa/src/views/Workspace.jsx` (15,736 lines, shared by Admin/Custodian/Maintenance Personnel) and `frontend-spa/src/views/SuperAdminWorkspace.jsx` (1,789 lines, Super Admin only). Sidebar structure: `modulesByRole`, `Workspace.jsx:84-134`; a multi-role user's sidebar is the **union** of every held role's modules (`resolveModuleGroups`, `Workspace.jsx:163-187`).

### 4.1 Admin

Sidebar (`Workspace.jsx:85-105`): Dashboard · Operations (Issue Reports, Maintenance Tickets, Ticket Archives, Condition Monitoring, Maintenance Schedule, Maintenance Records) · Fleet & Assets (Vehicle Management, Vehicle Types, Vehicle Location) · Administration (Users, Reports, Activity Log).

| Module | Actions available | Condition | File:line |
|---|---|---|---|
| Dashboard | Action Queue card (opens modal), "What's Breaking Most" chart, Risk/Readiness Watch quick-cards row | `hasRole(user,'Admin')` | `Workspace.jsx:4442,4529,4394,4920,4696` |
| Vehicle Management | Add Vehicle, Export CSV, Edit/Archive/Restore per row, Edit vehicle record (profile page `canManage`), Decommission/Recommission, Readiness Check (with Custodian) | `hasRole(user,'Admin')` (Add/Edit/Archive/Restore/profile `canManage`); readiness check also open to Custodian | `Workspace.jsx:2818,2820,8140,2569,13268,13278,13283,13273` |
| Vehicle Documents | Upload/Edit/Delete any document | `canManageDocuments` = Admin OR Custodian OR Maintenance Personnel (all three) | `Workspace.jsx:2570,12888,13025-13037` |
| Vehicle Types | Add, Edit, Delete | ⚠️ **no in-component role check** — gated only by the module being Admin-only in the sidebar | `Workspace.jsx:2854,8172-8193` |
| Vehicle Location | Add Location (map + record tab), Manage Hubs, Edit row | `hasRole(user,'Admin')` | `Workspace.jsx:3010,3054,8277` |
| Condition Monitoring | View, Add, Edit, Delete, Create Ticket from a condition, Suggest Maintenance Schedule | Add/Edit/Delete: `['Custodian','Admin'].includes(role)` at `8316`; Create Ticket: `role === 'Admin'` at `8342` | `Workspace.jsx:8316,8342,8361,8364-8365` |
| Issue Reports | View all (barangay-wide, not `mine`-filtered), edit/delete any, Create Ticket, Send to External Shop; NO inline "Report Issue" button | Create Ticket/Send to Shop: `role === 'Admin'` | `Workspace.jsx:5391,7532,3279` (Admin excluded from the Add button) |
| Maintenance Tickets | Full ticket list/board (`TicketModule`), Create Ticket, and every Admin-gated action inside `TicketDetailPanel` (assign/reassign mechanic, reassign custodian, add-sub-issue-if-also-assigned, confirm/reopen sub-issue, defer, close, decision-close, cancel/uncancel, delete, send to external shop) | `isAdmin = role === 'Admin'` (primary-role string, not `hasRole`) | `Workspace.jsx:11233,11456-11964,12543-12712` |
| Ticket Archives | View list, Reopen a "Deleted" entry | ⚠️ no in-component role check — sidebar-gated only | `Workspace.jsx:3786-3997,1871-1924` |
| Maintenance Schedule | Add, Edit, Cancel, Restore, Mark Complete (any) | `isAdmin = hasRole(currentUser,'Admin')` | `Workspace.jsx:3509-3511,9404-9416,9391` |
| Maintenance Records | View (barangay-wide, not scoped), Confirm/Reopen/Decision-Close, "Performed By" field on manual entry | `canManage = hasRole(user,'Admin')` | `Workspace.jsx:2591,9075,9198-9243,7662` |
| Reports | Generate any of the report catalog | ⚠️ no in-component role check — sidebar-gated only (Admin-only per sidebar) | `Workspace.jsx:7844-7896` |
| Users | View/Add/Edit/Activate/Deactivate (own barangay), view/regenerate Staff Registration Code | Staff Code panel: `hasRole(user,'Admin')`; Add/Edit/Activate/Deactivate buttons themselves: ⚠️ **no in-component role check**, sidebar-gated only | `Workspace.jsx:2918,2941,8195-8229,8218-8224,604` |
| Activity Log | View fleet-operational log | ⚠️ no in-component role check — sidebar-gated only | `Workspace.jsx:3723-3744,9686-9803` |
| Catalog dropdowns (Fault Category, Maintenance Type, etc.) | Rename/Delete catalog entries | `canDeleteCatalogItems = hasRole(currentUser,'Admin')` | `Workspace.jsx:14867,15096,15105-15115` |
| Any list/table (vehicles, issues, condition, etc.) | "+ Add New X" for a catalog value while filling a form | ⚠️ no role check — any role reaching that form field can add a catalog value | `Workspace.jsx:15086,15132` |
| Impersonation | Dev-only "Impersonate" dropdown+button (switch account for testing); a "Return to..." button never shows for an Admin session (only for one that came from a Super Admin) | `import.meta.env.DEV` gated | `Workspace.jsx:2251-2260,1997` |

⚠️ **Systemic finding**: every "new/edit" full-page route (`vehicles/new`, `categories/new`, `schedules/new`, `issues/new`, `conditions/new`, `maintenance/new`, `users/new`, `locations/new`, and their `/edit` counterparts) has **no role check inside the page component itself** — the gate is only the sidebar/inline button being hidden. Direct URL navigation (e.g. a Custodian typing `/custodian/vehicles/new`) renders the full form for any authenticated role; only the backend endpoint (see §2) actually blocks the submit. — `Workspace.jsx:2505-2554, 2596-2689`

### 4.2 Custodian

Sidebar (`Workspace.jsx:106-121`): Dashboard · Daily Tasks (View Vehicles, Report Vehicle Issue, Assigned Inspections, Repair Verifications, Work Tracker) · Monitoring & Schedules (Condition Monitoring, Maintenance Schedule, Maintenance Status, Maintenance Records).

| Module | Actions available | Condition | File:line |
|---|---|---|---|
| Dashboard | Fleet KPIs, condition/location charts (no Action Queue, no "My Scheduled Work") | Action Queue/What's-Breaking-Most/Quick-Cards row all gated `hasRole(user,'Admin')`, so excluded; "My Scheduled Work" gated `hasRole(user,'Maintenance Personnel')`, also excluded for a pure Custodian | `Workspace.jsx:4442,4696,4758` |
| Vehicle Management | View-only list (description text explicitly says "View-only"), no Add/Edit/Archive button; can still open a vehicle profile and Readiness-Check it | `hasRole(user,'Custodian') && !hasRole(user,'Admin')` drives the "View-only" copy; `canCheckReadiness = Admin OR Custodian` | `Workspace.jsx:2771,2571,13273` |
| Vehicle Documents | Upload/Edit/Delete any document | `canManageDocuments` includes Custodian | `Workspace.jsx:2570` |
| Condition Monitoring | View, Add, Edit, Delete (any row, not just own), Suggest Maintenance Schedule | `['Custodian','Admin'].includes(role)` | `Workspace.jsx:8316,8361,8364-8365` |
| Report Vehicle Issue (issues) | View OWN reports only (`?mine=1`), Add, Edit/Delete own while still Pending | `hasRole(user,'Custodian')` for Add; ownership+status check for Edit/Delete | `Workspace.jsx:3279,740-742`; backend `FleetController.php:1379-1381,1456-1458` |
| Assigned Inspections (ticketInspections) | Submit Inspection ("Inspect" button when status Open) | Reachable only via Custodian sidebar; per-row gate is just `status === 'Open'`, list itself is backend-scoped to tickets where they are `assigned_custodian_id` | `Workspace.jsx:13694`; backend `TicketController.php:64-73` |
| Repair Verifications (ticketVerifications) | Verify Repair (functional-test checklist, Approve/Reject) when a sub-issue is assigned to them for verification | `isAssignedToUser = verification_assigned_to === user.id` | `Workspace.jsx:14012-14019` |
| Work Tracker | Read-only outcome feed of every sub-issue where they're mechanic and/or verifier; "My Role" filter only appears if also Maintenance Personnel | `isMechanic`/`isVerifier` per row, `Workspace.jsx:10634-10639`; role filter needs both roles, `10873` | `Workspace.jsx:10777-11156` |
| Maintenance Schedule | Add; Complete only a schedule assigned to them (if also holding Maintenance role) — otherwise view only; cannot Edit/Cancel/Restore | Add: any of Admin/Custodian/Maintenance; Complete requires `assigned_to === userId`; Edit/Cancel/Restore Admin-only | `Workspace.jsx:3509-3511,9391,9404-9416` |
| Maintenance Status | Verify a maintenance record `For Verification`, blocked from verifying own repair | `isOwnRepair` check hides the button | `Workspace.jsx:9302-9306`; backend self-block `FleetController.php:1925-1929` |
| Maintenance Records | View full barangay-wide list (not `mine`-scoped); can log a standalone record as self | `FleetController.php:1606` any of Admin/Custodian/Maintenance | `Workspace.jsx:721-757` |
| Ticket detail (opened from any of the above) | Add Sub-Issue (only if they are the assigned Custodian on that ticket or a mechanic on one of its sub-issues) | `canAddSubIssue`: `ticket.status==='Active' && (assigned_custodian_id===userId || some sub-issue.assigned_mechanic_id===userId)` | `Workspace.jsx:11269-11272,11857-11875` |

### 4.3 Maintenance Personnel

Sidebar (`Workspace.jsx:122-133`): Dashboard · Work Orders & Repairs (My Work Orders, Work Tracker, View Vehicle Issues, Maintenance Schedule) · Monitoring & Schedules (Maintenance Records).

| Module | Actions available | Condition | File:line |
|---|---|---|---|
| Dashboard | "My Scheduled Work" personal task list; no Action Queue | `hasRole(user,'Maintenance Personnel')` for the panel; Admin-only items excluded | `Workspace.jsx:4758,4696` |
| My Work Orders (ticketWorkOrders) | Log Repairs on a sub-issue assigned to them (status Under Repair) | List pre-filtered client-side to `assigned_mechanic_id === user.id` (`Workspace.jsx:10574,10679`); button gate `status === 'Under Repair'` | `Workspace.jsx:14300-14302` |
| Log Repairs form | Free choice of `repair_type` (In-House/Cannibalized/External), `source_vehicle_id` (any other vehicle, unrestricted), external vendor/warranty text, cost, dates, photo | No role gating inside the form (reachability already implies "assigned mechanic") | `Workspace.jsx:14315-14532,14395-14433` |
| Work Tracker | Same read-only feed as Custodian's; "My Role" filter appears only if also Custodian | `isMechanic` per row | `Workspace.jsx:10634-10639,10873` |
| View Vehicle Issues (issues) | View barangay-wide issue list (not `mine`-scoped — the `mine=1` param is only sent for a *pure* Custodian); Edit is limited to Status+Remarks only (not the full issue-detail fields a Custodian editing their own report gets) | `editTarget?.issue_report_id || role === 'Maintenance Personnel'` → Status+Remarks-only field set | `Workspace.jsx:7532,740-742` |
| Maintenance Schedule | View; Complete only a schedule assigned to them; cannot Add-and-assign-to-others the way Admin can, but CAN use the generic Add button (Admin/Custodian/Maintenance all can add schedules) | Complete: `isAdmin || assigned_to===userId`; Add: any of the three | `Workspace.jsx:3509-3511,9391` |
| Maintenance Records | View full barangay-wide list; can log a standalone record as self; cannot Confirm/Decision-Close (Admin-only) | `canManage = hasRole(user,'Admin')` excludes them from Confirm/Decision-Close | `Workspace.jsx:2591` |
| Vehicle profile (view-only reach via ticket/records links) | Document upload/edit/delete (`canManageDocuments`); Readiness Check button **excluded** (`canCheckReadiness` = Admin OR Custodian only) | `Workspace.jsx:2570,2571,13273` |
| Ticket detail | Add Sub-Issue only if they are a mechanic assigned on one of that ticket's sub-issues | Same `canAddSubIssue` logic as Custodian | `Workspace.jsx:11269-11272` |

### 4.4 Super Admin (`SuperAdminWorkspace.jsx`)

Entirely separate shell/component (never renders `Workspace.jsx` — `RestrictSuperAdminScope` blocks the fleet endpoints server-side anyway). Sidebar (`SuperAdminWorkspace.jsx:24-44`): Dashboard · Approvals (Pending Approvals) · Accounts (All Users, Registration Codes) · Support (Concern Reports) · System (Activity Log). "My Settings" reached via the profile menu, not the sidebar.

| Module | Actions available | File:line |
|---|---|---|
| Dashboard | Stat cards (Pending Approvals, Barangays, Orphaned Barangays, Total Users, Open Concern Reports), province/coverage charts, filterable barangay table, **Add Barangay**, **Retry boundary lookup**, **Recover** an orphaned barangay (promote an existing user in it to Admin) | `SuperAdminWorkspace.jsx:312-568` |
| Pending Approvals | Grouped-by-barangay view, **Approve** / **Reject** (permanently deletes the account) each pending registration; barangays whose pending account is a first-Admin are flagged and float to the top | `SuperAdminWorkspace.jsx:575-725` |
| All Users | Province→Barangay grouped table (excludes Super Admin accounts from the list, `visibleUsers = users.filter(u => u.role !== 'Super Admin')`), inline **role change** dropdown, **Activate/Deactivate** toggle | `SuperAdminWorkspace.jsx:802-898,1409` |
| Registration Codes | Province→City→Barangay cascade, view + **Regenerate** the Staff Registration Code for any barangay | `SuperAdminWorkspace.jsx:900-1051` |
| Concern Reports | View, **Mark Resolved**/**Reopen**, **Delete** any concern report; Open vs All Reports scope toggle | `SuperAdminWorkspace.jsx:1120-1180` |
| Activity Log | Full platform log vs "Super Admin Actions Only" (module === 'Super Admin') scope toggle | `SuperAdminWorkspace.jsx:1182-1215` |
| My Settings | Self password change only | `SuperAdminWorkspace.jsx:1217-1265` |
| Topbar Impersonate (always visible, not dev-gated) | Province→Barangay→Staff cascade, **Impersonate** any non-Super-Admin, non-inactive account; candidate list explicitly filters out `role === 'Super Admin'` | `SuperAdminWorkspace.jsx:1060-1118,1067` |

⚠️/UNCLEAR notes for §4: none of the many "no in-component role check" findings above indicate the backend is actually unprotected — every one of them corresponds to a backend route that DOES enforce a role check (see §2), so the UI gap is purely "sidebar-only" gating, not an actual authorization hole, EXCEPT where §2 itself already flags the backend route as having no role check (`/vehicles`, `/categories`, `/conditions`, `/issues` GET, `/maintenance-records` GET, `/maintenance-schedules` GET, `/hubs` GET, `/locations` GET, `/lookups`, `/dashboard`, `/tickets/{id}` GET) — for those, the UI's lack of a role gate is consistent with the backend's, i.e. **any authenticated non-Super-Admin role really can reach that data via direct API call**, not just via the UI.

---

## 5. Ticket and sub-issue workflow

| Object | From status | To status | Role(s) that can trigger it | Backend enforced? (file:line) | Side effects |
|---|---|---|---|---|---|
| Ticket | (none) | Open (inspection mode) or Active (pre-diagnosed mode) | Admin | `TicketController.php:159-161` | Custodian notified (inspection mode) or Admins notified (pre-diagnosed); vehicle set Under Maintenance/Needs Repair if pre-diagnosed; recurrence check runs and may notify Admins of a repeat fault (`TicketController.php:370-387`) |
| Ticket | Open | Active | Custodian (must be the `assigned_custodian_id`) | `TicketController.php:401,403` | Sub-issues created if "Needs Maintenance"; vehicle set Under Maintenance/Needs Repair, or Good if "No Issues"; Admins notified |
| Sub-issue | (none) | Open | Custodian (inspection) or Custodian/Maintenance Personnel already on the ticket (`addSubIssue`, ticket must be Active) | `TicketController.php:399-472` (inspection); `488-497` (addSubIssue, ownership-based) | — |
| Sub-issue | Open | Under Repair | Admin (assign-mechanic) | `TicketController.php:538,540` | Mechanic notified; vehicle status recomputed |
| Sub-issue | Under Repair | Under Repair (reassigned) | Admin | `TicketController.php:596,598` | Old + new mechanic notified |
| Ticket | Open/Active | (custodian reassigned) | Admin | `TicketController.php:668,670` | New/old Custodian notified; any `For Inspection` sub-issues' `verification_assigned_to` cascades to the new Custodian |
| Sub-issue | Under Repair | For Inspection | Maintenance Personnel (must be the `assigned_mechanic_id`) | `TicketController.php:747,749,752` | `verification_assigned_to` set to the ticket's current Custodian; Custodian notified |
| Sub-issue | For Inspection | For Confirmation (Approved) or Under Repair (Rejected) | Custodian (must match `verification_assigned_to`) | `TicketController.php:823,825,828` | Approved → Admins notified; Rejected → assigned mechanic notified |
| Sub-issue | For Confirmation | Done (Confirmed) or Under Repair (Reopened/sent back) | Admin | `TicketController.php:910,912` | Confirmed: `VehicleIssueReport` resolved, a `VehicleMaintenanceRecord` ledger line is created (`finalizeConfirmedSubIssue`, `TicketController.php:1434-1472`), Custodian/Admins notified if ticket now fully Done; Reopened: mechanic notified, verification fields cleared |
| Sub-issue | Done | For Inspection (un-confirm) | Admin | `TicketController.php:986,988,991-993` | Re-stamps `verification_assigned_to` to the ticket's CURRENT custodian; Custodian notified |
| Sub-issue | Open/Under Repair (not For Confirmation) | Deferred | Admin | `TicketController.php:1181,1183,1186-1191` | Mandatory reason; a breadcrumb `VehicleIssueReport` is created or resurfaced as Pending (`createDeferralBreadcrumb`, `TicketController.php:1501-1523`); Custodian notified |
| Ticket | Active | Closed | Admin (only when every sub-issue is Done/Deferred, or an explicit decision-close with a mandatory reason + fit-for-service call for any still-unfinished ones) | `TicketController.php:1046,1048,1072-1093` | Sub-issues sitting at For Confirmation get auto-finalized; unresolved ones get deferred (each gets its own breadcrumb); vehicle returns to service only if judged fit; ticket archived (`archiveCompleted`) |
| Ticket | any (not Closed/Cancelled) | Cancelled | Admin (blocked if every sub-issue is already resolved — must Close instead) | `TicketController.php:1219,1221,1229-1233` | Linked issue reports reset to Pending; vehicle status recomputed |
| Ticket | Cancelled | Open or Active | Admin | `TicketController.php:1259,1261,1263` | Linked issue reports reset to In Maintenance |
| Ticket | any (not Closed) | deleted | Admin | `TicketController.php:1294,1296,1298` | If any sub-issue had reached Done, archived as recoverable ("Deleted") before deletion; else discarded outright |
| Archived ticket | "Deleted" | new live ticket | Admin | `TicketController.php:1327,1329,1331` | Full snapshot recreated as a brand-new ticket; blocked if a duplicate Main Issue already exists on the vehicle |

**Can a user verify a repair they logged themselves?**

- **Standalone Maintenance Record workflow: NO, explicitly blocked.** `FleetController.php:1899-1929` (`verifyMaintenance`): requires role Custodian, AND `abort_if($record->maintenance_personnel_id === $request->user()->id, 403, 'You performed this repair — another Custodian needs to verify it.')` at lines 1925-1929. The comment at 1921-1924 states this independence check is "the entire point of this step."
- **Ticket sub-issue workflow: NO equivalent backend check exists.** `TicketController::verifyRepair` (`TicketController.php:823-904`) only checks `subIssue->verification_assigned_to === $request->user()->id` (line 828) — there is **no comparison against `assigned_mechanic_id`** anywhere in this method or in `logRepairs()`. The frontend mirrors this exactly: `CustodianVerificationModule`'s "Verify Repair" button gates solely on `verification_assigned_to === user.id` (`Workspace.jsx:14012-14019`), with no check against who logged the repair, and `VerificationForm` (`Workspace.jsx:11024-11156`) only requires the functional-test checklist plus a self-attestation checkbox — not an independence check.
- **Consequence**: if an Admin (who alone controls both `assignMechanic` and `reassignCustodian`/the ticket's original `assigned_custodian_id`) assigns the same dual-role (Custodian + Maintenance Personnel) person as both a sub-issue's mechanic and the ticket's Custodian, that one person can legitimately log the repair via `logRepairs` and then approve their own work via `verifyRepair` — both client-side and server-side permit this for the ticket workflow, even though the parallel standalone Maintenance Record workflow explicitly forbids the equivalent. This is flagged ⚠️ in §8b as a real inconsistency between the two parallel repair-verification workflows in the same codebase.

**What happens when a sub-issue is deferred, and who can see it?**

- The sub-issue's `status` becomes `Deferred` (a terminal/"resolved" state alongside `Done`) with `deferred_reason`, `deferred_by`, `deferred_at` stamped (`TicketController.php:1479-1492`).
- A **breadcrumb `VehicleIssueReport`** is created or resurfaced: if the sub-issue already had a linked issue report, that report is set back to `status = 'Pending'` with a remark noting the deferral (`TicketController.php:1503-1510`); otherwise a brand-new issue report is created with `issue_type = 'Other'`, `status = 'Pending'`, describing the deferred defect (`TicketController.php:1512-1522`). Either way `deferred_issue_report_id` on the sub-issue points at it.
- This breadcrumb is a normal `VehicleIssueReport` row, so it is visible to **whoever can see Issue Reports for that vehicle/barangay** per §3's scoping — Admin and Maintenance Personnel see it in the full barangay-wide Issue Reports list; a Custodian sees it only if they are the `reported_by` on it (which for a Deferred sub-issue is the deferring Admin's own user id, `TicketController.php:1517`, so a plain Custodian would generally NOT see it in their own `?mine=1`-filtered Issue Reports view unless they also hold another role or are the reporting user). It is also visible from the ticket detail itself (a Deferred sub-issue row) and, once the breadcrumb exists, the Admin-only "Send to External Shop" action becomes available on it (`Workspace.jsx:11797`).
- The assigned Custodian of the ticket is notified (`TicketController.php:1203-1209`).

---

## 6. Other modules, per role

| Module | Create | View | Edit | Delete |
|---|---|---|---|---|
| Vehicle Management | Backend+UI: Admin only (`FleetController.php:801`, `Workspace.jsx:2818`) | Backend: all 3 roles (no route role-check, barangay-scoped); UI: all 3 roles, view-only copy for pure Custodian | Backend+UI: Admin only (`FleetController.php:828`, `Workspace.jsx:2569`) | Backend+UI: Admin only — "archive" (soft) (`FleetController.php:869`); Decommission/Restore also Admin-only |
| Vehicle Types | Backend+UI: Admin only (`FleetController.php:688`, sidebar-gated only in UI) | Backend: all 3 (no check); UI: Admin-only sidebar placement | Backend: Admin only (`FleetController.php:704`); UI: ⚠️ no in-component check, sidebar-gated | Backend: Admin only (`FleetController.php:725`), blocked if any vehicle still uses it; UI: sidebar-gated |
| Vehicle Location / Hubs | Backend+UI: Admin only (`FleetController.php:1110`, `HubController.php:28`, `Workspace.jsx:3010,3054`) | Backend: all 3 (no check); UI: all 3 | Backend+UI: Admin only (hub update `HubController.php:58`; location edit `Workspace.jsx:8277`) | Backend+UI: Admin only (hub delete `HubController.php:80`, blocked if any vehicle uses it as current location) |
| Vehicle History | (auto-generated by other actions, never directly created by a user) | Backend+UI: Admin only (`FleetController.php:2525`, `Workspace.jsx:2523-2554` histories module — reached via Vehicle profile's History tab for other roles as read-only, since `VehicleProfilePage` itself is reachable by all roles) | N/A | N/A |
| Condition Monitoring | Backend: Admin or Custodian (`FleetController.php:1145`); UI: Custodian-only Add button (`Workspace.jsx:3191`), though Admin passes the backend check too | Backend: all 3 (no check); UI: reachable module for Admin/Custodian (not in Maintenance Personnel's sidebar) | Backend: Admin or Custodian (`FleetController.php:1182`); UI: same, any row not just own (`Workspace.jsx:8364`) | Backend: Admin or Custodian (`FleetController.php:1217`); UI: same, any row (`Workspace.jsx:8365`) |
| Maintenance Schedule | Backend+UI: Admin, Custodian, or Maintenance Personnel (`FleetController.php:2165`, `Workspace.jsx:3509-3511`) | Backend: all 3 (no check); UI: all 3 (own-assignment sort/stat-card for Maintenance) | Backend: Admin only (`FleetController.php:2224`); Complete: Admin or the assigned Maintenance Personnel (`2287,2297-2305`); UI matches (`Workspace.jsx:9404-9416,9391`) | Backend+UI: Admin only (soft-cancel) (`FleetController.php:2468`, `Workspace.jsx:9404-9416`); Restore also Admin-only |
| Maintenance Records | Backend+UI: Admin, Custodian, or Maintenance Personnel (`FleetController.php:1606`) — non-Admin creators are forced to log themselves as `maintenance_personnel_id` (`1648-1651`) | Backend: all 3 (no check), barangay-wide; UI: all 3, not `mine`-scoped | Backend: all 3 can PUT-edit (`1764`); Confirm/Decision-Close: Admin only (`1968,2053`); Verify: Custodian only, not own repair (`1901,1925-1929`) | No delete endpoint exists for Maintenance Records at all |
| Reports | Backend+UI: Admin only (`FleetController.php:2558`, sidebar-gated, ⚠️ no in-component check) | Backend+UI: Admin only | N/A (reports are generated, not stored/edited) | N/A |
| Activity Log | (auto-generated) | Backend: fleet-operational log — Admin only (`FleetController.php:2537`); account-level log — Super Admin only, platform-wide (`SuperAdminController.php:463`) | N/A | N/A |
| Users | Backend+UI: Admin (own barangay, `UserController.php:79`) or Super Admin (any barangay, via role-promotion/Recover flow, `SuperAdminController.php:96-134,418-432`) | Backend: Admin (own barangay, `UserController.php:55`) or Super Admin (all, `SuperAdminController.php:318`) | Backend+UI: Admin (own barangay, `UserController.php:112-113`) or Super Admin (role only, any barangay, `SuperAdminController.php:418-422`) | No "delete an approved user" endpoint exists for anyone; only `rejectUser` (Super Admin, never-approved accounts only, `SuperAdminController.php:372-383`) actually deletes a row |
| Issue Reports | Backend+UI: Admin, Custodian, or Maintenance Personnel (`FleetController.php:1327`, though UI only shows the Add button to Custodian, `Workspace.jsx:3279`) | Backend: all 3 (no check), Custodian's UI list defaults to own-only; Admin/Maintenance see barangay-wide | Backend: all 3 can call the route; pure Custodian limited to own report while Pending (`1379-1381`); Maintenance Personnel limited to Status+Remarks fields in the UI form (`Workspace.jsx:7532`) | Backend: Admin (any) or pure Custodian (own, while Pending) (`1454-1461`); Maintenance Personnel cannot delete (falls through to the `requireRole(['Admin'])` branch) |

---

## 7. Accounts and Super Admin

### 7.1 Registration flow, step by step

1. Public form (`frontend-spa/src/views/Register.jsx`) collects name/email/phone/address/province/city/barangay + (conditionally) role + staff code.
2. `POST /register` (`AuthController.php:42-168`), inside a DB transaction that row-locks the target `Barangay` (`:83-95`) to prevent a race between two people both claiming to be a barangay's "first" registrant.
3. `$isFirstForBarangay = !User::where('barangay_id', $barangayId)->exists()` (`:99`) — deliberately unscoped, looks across every barangay.
4. **Everyone**, including the would-be first registrant, must supply that barangay's **Staff Registration Code** (`:101-118`, `hash_equals` check against `RegistrationSetting::for($barangayId)->staff_code`) — this prevents a stranger from claiming an empty Admin seat just by asserting they're "first."
5. If first-for-barangay: `role = 'Admin'`, no role choice offered. Otherwise: the registrant picks `Custodian` or `Maintenance Personnel` (`:107,120`).
6. The account is created with **`is_active = false, approved_at = null`** regardless of first-or-not (`:142-143`) — the code comment (`:122-130`) explains this was deliberately changed from "the first person goes live instantly" because the shared staff code alone doesn't prove legitimacy.
7. If first-for-barangay, every `Super Admin` account is notified (`notifySuperAdmins`, `:151-156,173-185`). Otherwise, no explicit notification code path was found for "notify the barangay's existing Admin(s)" on an ordinary registration — **UNCLEAR**: I found no `notifyAdmins`-style call in `register()` for the non-first-Admin case; an existing Admin must apparently notice the pending account via the Users module rather than being pushed a notification. (Checked `AuthController.php` register() in full — no such call exists there.)
8. **Approval paths**: a first-for-barangay Admin registration can only be approved via `SuperAdminController::activateUser` (`:342-350`) — a plain Admin's `UserController::activate` is barangay-scoped (`requireSameBarangay`, `:170`) and there is no other Admin in that barangay yet to do it. Every subsequent (non-first) registration is approved by an existing Admin via `UserController::activate` (`:167-196`), which optionally lets the Admin confirm/override the requested role on this first approval only (`:172-190`).
9. `login()` (`AuthController.php:218-279`) blocks an inactive account with a role-aware message distinguishing "awaiting a Super Admin" (pending first Admin, no other active Admin exists yet in that barangay) from "awaiting your barangay's Admin" (`:236-259`).

### 7.2 Who can activate/deactivate/change roles/delete users, and restrictions

| Action | Who | Restriction found in code |
|---|---|---|
| Activate (approve/re-activate) | Admin (own barangay, `UserController.php:167-196`) or Super Admin (any barangay, `SuperAdminController.php:342-350`) | None beyond scope |
| Deactivate | Admin (own barangay, `UserController.php:153-165`) or Super Admin (any barangay, `SuperAdminController.php:352-362`) | Cannot deactivate **your own** account (`UserController.php:157`, `SuperAdminController.php:355`). **No check anywhere prevents deactivating the LAST active Admin of a barangay** if done by someone else (another Admin in the same barangay, or a Super Admin) — I read both `deactivate()`/`deactivateUser()` in full and found only the self-deactivation guard, nothing checking "is this the barangay's only active Admin." |
| Change role | Admin (edits `role`/`roles[]` via `update()`, own barangay, `UserController.php:110-151`) or Super Admin (`updateUserRole`, any barangay, one role at a time, `SuperAdminController.php:418-432`) | An Admin cannot remove their own `Admin` role via self-edit (`UserController.php:133-135`). A Super Admin cannot change their own role or any `Super Admin` account's role through `updateUserRole` (`SuperAdminController.php:421-422`) — Super Admin roles are only ever set by the local/testing-only seeder (§1.1). |
| Delete a user | Only `SuperAdminController::rejectUser` (`:372-383`) — and only for an account that was **never** approved (`approved_at === null`); it permanently deletes the row. There is no endpoint anywhere that deletes an already-approved user; the only lever for an unwanted-but-approved account is deactivation. | — |

### 7.3 What happens to a deactivated user's open assignments

- Deactivation itself (`UserController::deactivate`/`SuperAdminController::deactivateUser`) only flips `is_active = false` and revokes all their Sanctum tokens (`->tokens()->delete()`) — **it does not touch any ticket, sub-issue, or schedule assignment.** I read both methods in full; neither cascades to `MaintenanceTicket.assigned_custodian_id`, `TicketSubIssue.assigned_mechanic_id`, or `VehicleMaintenanceSchedule.assigned_to`.
- The system provides two dedicated, Admin-only "unstick" endpoints for exactly this situation: `reassignCustodian` (`TicketController.php:668-741`, docblock at `655-667` explicitly frames it as recovering from "that person going on leave or leaving the barangay") and `reassignMechanic` (`TicketController.php:596-649`). Neither is automatically triggered by deactivation — an Admin must notice and act manually.
- For a `VehicleMaintenanceSchedule` whose `assigned_to` user is deactivated, there is no reassignment endpoint at all — only `updateSchedule` (Admin-only) can change `assigned_to`, and only Admin (or the assignee, but a deactivated account can't log in) can `completeSchedule` it.

### 7.4 Impersonation

- **Who**: an Admin (dev-only) or a Super Admin (works in production) — `AuthController::canImpersonate` (`:306-311`): `hasRole('Admin') || hasRole('Super Admin') || currentAccessToken()->can('impersonated')` (the last clause lets an already-impersonating session switch accounts again).
- A Super Admin account itself can never be impersonated by anyone, including another Super Admin (`AuthController.php:365`).
- **What the impersonated session can do**: full read AND write access as that account — the issued token carries `[...$user->allRoles(), 'impersonated']` (`:374`), i.e. every real ability the target account has; there is no read-only mode.
- **Time limit**: 4 hours, explicit, independent of the normal login-token expiry setting (`now()->addHours(4)`, `AuthController.php:373-374`).
- **Reason required?** No — `impersonate()` takes no reason/justification parameter anywhere in its validation or signature.
- **Where logged**: every impersonation writes an `ActivityLog` row (`user_id` = the impersonator, `action = 'Impersonate'`, `module` = `'Super Admin'` if the actor is a Super Admin else `'Dev Tools'`, with a details string naming who impersonated whom) — `AuthController.php:376-384`.
- **Frontend**: for an Admin, the Impersonate control only renders when `import.meta.env.DEV` (`Workspace.jsx:2251`) — i.e. never in a production build. For a Super Admin, the topbar Impersonate cascade in `SuperAdminWorkspace.jsx` is always rendered, not dev-gated (`SuperAdminWorkspace.jsx:1060-1118`), matching the backend's "works in production for Super Admin" design. A "Return to {impersonator}" button appears in `Workspace.jsx` whenever an `impersonator_token` is stashed AND `impersonatorRole === 'Super Admin'` (`Workspace.jsx:1990-1997`) — i.e. it never appears for an Admin's dev-only impersonation, only for a genuine Super Admin session.

### 7.5 Registration code regeneration

- Admin: own barangay only — `UserController::regenerateRegistrationCode` (`:205-212`).
- Super Admin: any barangay — `SuperAdminController::regenerateRegistrationCode` (`:441-449`).
- No other role can regenerate a code.

---

## 8. Summary tables

### 8a. Feature × Role matrix

✔ = enforced both UI and backend · UI-only = frontend shows/hides it but backend doesn't independently check it (or checks something weaker) · API-only = backend enforces it but the UI has no dedicated gate/button (reachable via direct API call or a route with no UI entry point) · ✘ = not available to that role at all.

| Feature / Action | Super Admin | Admin | Custodian | Maintenance Personnel |
|---|---|---|---|---|
| View own barangay's vehicles | ✘ | ✔ | ✔ | ✔ |
| Add/Edit/Archive/Decommission vehicle | ✘ | ✔ | ✘ | ✘ |
| Upload/Edit/Delete vehicle documents | ✘ | ✔ | ✔ | ✔ |
| Readiness Check / Mark Available | ✘ | ✔ | ✔ | ✘ |
| Vehicle Types: Add/Edit/Delete | ✘ | ✔ (UI has no in-component check, but sidebar+backend both restrict to Admin) | ✘ | ✘ |
| Vehicle Location/Hubs: Add/Edit/Delete | ✘ | ✔ | ✘ | ✘ |
| Condition Monitoring: View | ✘ | ✔ | ✔ | API-only (backend route has no role check; not in their sidebar) |
| Condition Monitoring: Add/Edit/Delete | ✘ | ✔ | ✔ | ✘ |
| Issue Reports: File a report | ✘ | API-only (no Add button in UI for Admin) | ✔ | ✔ |
| Issue Reports: View all (barangay-wide) | ✘ | ✔ | ✘ (own-only by default) | ✔ |
| Issue Reports: Edit/Delete any | ✘ | ✔ | ✘ (own, Pending-only) | Edit: UI-only (Status+Remarks); Delete: ✘ |
| Create Ticket | ✘ | ✔ | ✘ | ✘ |
| Submit Inspection | ✘ | ✘ | ✔ (own assignment) | ✘ |
| Add Sub-Issue | ✘ | ✘ (never, by design) | ✔ (if assigned custodian/mechanic on ticket) | ✔ (if assigned mechanic on ticket) |
| Assign/Reassign Mechanic | ✘ | ✔ | ✘ | ✘ |
| Reassign Custodian | ✘ | ✔ | ✘ | ✘ |
| Log Repairs | ✘ | ✘ | ✘ | ✔ (own work order) |
| Verify Repair (functional test) | ✘ | ✘ | ✔ (assigned verification) — **not blocked from verifying own repair if also the assigned mechanic** | ✘ |
| Confirm/Reopen Sub-Issue | ✘ | ✔ | ✘ | ✘ |
| Defer Sub-Issue | ✘ | ✔ | ✘ | ✘ |
| Close/Cancel/Uncancel/Delete Ticket | ✘ | ✔ | ✘ | ✘ |
| Reopen Archived (Deleted) Ticket | ✘ | ✔ | ✘ | ✘ |
| Log standalone Maintenance Record | ✘ | ✔ | ✔ | ✔ |
| Verify standalone Maintenance Record | ✘ | ✘ | ✔ (not own repair — blocked) | ✘ |
| Confirm/Decision-Close Maintenance Record | ✘ | ✔ | ✘ | ✘ |
| Add Maintenance Schedule | ✘ | ✔ | ✔ | ✔ |
| Complete a Schedule | ✘ | ✔ (any) | ✘ (unless also assigned Maintenance) | ✔ (own assignment only) |
| Edit/Cancel/Restore Schedule | ✘ | ✔ | ✘ | ✘ |
| Generate Reports | ✘ | ✔ | ✘ | ✘ |
| View fleet-operational Activity Log | ✘ | ✔ | ✘ | ✘ |
| View/Add/Edit users (own barangay) | ✘ | ✔ | ✘ | ✘ |
| Activate/Deactivate users (own barangay) | ✘ | ✔ | ✘ | ✘ |
| View/Regenerate own barangay's Staff Code | ✘ | ✔ | ✘ | ✘ |
| Impersonate another account | ✔ (production) | UI-only in dev builds | ✘ | ✘ |
| Platform-wide user/barangay management | ✔ | ✘ | ✘ | ✘ |
| Approve pending registrations (incl. first-Admin) | ✔ (any; first-Admin case is exclusively theirs) | ✔ (own barangay, non-first-Admin only) | ✘ | ✘ |
| Change any user's role platform-wide | ✔ | ✔ (own barangay only) | ✘ | ✘ |
| Reject (delete) a never-approved account | ✔ | ✘ | ✘ | ✘ |

### 8b. Everything flagged ⚠️ or UNCLEAR, with reason and section pointer

1. **UNCLEAR — `role='Super Admin'` is never added to the DB enum.** Only works because local/testing uses sqlite. §1.1, `create_super_admin_account.php:24-46` vs. `0001_01_01_000000_create_users_table.php:20`.
2. **⚠️ Route-level guard uses only the primary role.** `ProtectedRoute.jsx:30` checks `user.role`, not the `roles[]` array; a multi-role account can only land on its primary role's dedicated URL even though in-page module/action gates are mostly roles-array-aware. §1.2, §4.
3. **⚠️ Inconsistent gating style (`hasRole` vs. primary-role `role ===`)** in `UserViewPage` (`Workspace.jsx:5280`), `IssueViewPage` (`:5391`), `conditionColumns` (`:8316`, called with primary role at `:1827`), and the entire `TicketDetailPanel`/`TicketProfilePage` Admin gate (`isAdmin = role === 'Admin'`, `:11233`, passed `role={user.role}` at `:2579`). §1.2, §4.
4. **UNCLEAR — Sanctum token abilities carry role names but are never checked**, except the single `'impersonated'` ability. All real authorization re-checks the live `User` model instead. §1.3.
5. **⚠️ Many GET/list backend routes have no role check at all** (any authenticated, active, non-Super-Admin role can call them): `/lookups`, `/dashboard`, `/fault-categories`, `/maintenance-types`, `/categories`, `/vehicles`, `/vehicles/{id}/reliability`, `/vehicles/{id}/readiness`, `/vehicles/{id}/documents`, `/locations`, `/hubs`, `/conditions`, `/issues`, `/maintenance-records`, `/maintenance-records/{id}`, `/maintenance-schedules`, `/tickets`, `/tickets/{id}` (also has no ownership scoping). §2, §3.
6. **⚠️ Frontend "new/edit" full-page routes carry no in-component role check** — only reachable-via-button is gated; direct URL navigation bypasses it (backend still enforces on submit). §4.1, listed at `Workspace.jsx:2505-2554,2596-2689`.
7. **⚠️ `canManageDocuments` grants all three fleet roles full CRUD on vehicle documents** (upload/edit/delete any document, not just their own) — the broadest cross-role grant in the app. §4.1/4.2/4.3, `Workspace.jsx:2570,12888,13025-13037`.
8. **⚠️ Ticket sub-issue self-verification is not blocked**, unlike the parallel standalone Maintenance Record workflow which explicitly is (`FleetController.php:1925-1929` blocks it; `TicketController.php:823-904` `verifyRepair` has no equivalent check). A dual-role (Custodian+Maintenance Personnel) account assigned as both mechanic and verifier on the same sub-issue can log and then approve their own repair, with no client- or server-side block. §5, confirmed independently by both frontend and backend reading.
9. **UNCLEAR — no notification path found for an ordinary (non-first-Admin) registration** to alert the barangay's existing Admin(s); only the first-for-barangay case notifies Super Admins. Checked `AuthController::register()` in full. §7.1.
10. **⚠️ No "last Admin" protection.** Neither `UserController::deactivate` nor `SuperAdminController::deactivateUser` checks whether the target is a barangay's only active Admin before deactivating (only self-deactivation is blocked). §7.2.
11. **⚠️ Deactivating a user does not reassign their open ticket/sub-issue/schedule assignments** — an Admin must notice and manually use `reassignCustodian`/`reassignMechanic`; no equivalent reassignment endpoint exists for `VehicleMaintenanceSchedule.assigned_to` at all. §7.3.
12. **⚠️ Impersonation requires no reason/justification** and grants full read+write access as the target account for up to 4 hours, logged only after the fact via `ActivityLog`. §7.4.

---

*Report generated by direct, full reads of `routes/api.php`, every controller in `backend-api/app/Http/Controllers/`, every relevant model/trait/middleware in `backend-api/app/Models/` and `backend-api/app/Http/Middleware/`, all migrations under `backend-api/database/migrations/`, and `frontend-spa/src/views/Workspace.jsx` (15,736 lines), `SuperAdminWorkspace.jsx` (1,789 lines), `Register.jsx`, `Login.jsx`, `App.jsx`, `ProtectedRoute.jsx`, and `AuthContext.jsx` — the latter's ticket-workflow/vehicle-profile/custodian-mechanic-module sections were extracted with the assistance of a delegated research pass over the same file, whose specific findings are cited above with the same file:line rigor as the rest of this report.*
