# UAT — Nationwide Philippine Boundary System (SCRUM-80)

**Executed:** 2026-09-19 · **Build:** branch `JakeEngana/SCRUM-80-nationwide-philippine-boundary-system`
**Environment:** local (SQLite), backend `127.0.0.1:8001`, Cebu province imported (53 cities, 1,203 barangays)

**Result: 8 passed, 4 failed.** The imported data itself is sound; every failure is in
surrounding behaviour that only breaks once more than one city has barangays.

---

## Scope

Acceptance criteria taken from `VMS_Automatic_Philippine_Boundary_System.md` §21: outlines load
automatically from stored data, users never draw boundaries, PSGC codes are the matching key, the
system isn't Mandaue-only, and missing barangay geometry falls back to the city.

---

## Results

| # | Scenario | Result |
|---|---|---|
| 1 | Import a province's outlines from the upstream dataset | **Pass** |
| 2 | Imported barangays carry PSGC code, geometry and source label | **Pass** |
| 3 | Re-running the import changes nothing (idempotency) | **Pass** |
| 4 | Existing Mandaue rows absorb codes without duplicating | **Pass** |
| 5 | Local spellings survive an upstream mismatch | **Pass** |
| 6 | Island barangays are not dropped | **Pass** |
| 7 | A polygon from another province is rejected | **Pass** |
| 8 | Registered users are never orphaned by the import | **Pass** |
| 9 | Admin lands on their own barangay when opening the map | **Fail — BUG-1** |
| 10 | A user can register into a newly imported barangay | **Fail — BUG-2** |
| 11 | Super Admin barangay list performs acceptably at scale | **Fail — BUG-3** |
| 12 | Importing one city fetches only that city's data | **Fail — BUG-4** |

---

## Passing scenarios (evidence)

**1-2. Import and data shape.** `boundaries:import --province=072200000` wrote 1 province outline and
1,203 barangays across 53 cities. Verified afterwards: 0 rows with a null boundary, 0 with a null
code, 0 duplicate codes. Bantayan holds 25 barangays; `Doong` carries
`boundary_source = philippines-json-maps-2019` and geometry at `[123.654, 11.080]`, correctly beside
Bantayan (~123.7, 11.2).

**3. Idempotency.** A second run reported `skipped existing: 1204`, wrote nothing, and left the row
count at 1,203.

**4-5. Reconciliation.** Mandaue stayed at exactly 27 barangays — the pre-existing rows absorbed
their PSGC codes rather than gaining duplicates. Both spelling divergences were reported and the
local spelling kept: `Paknaan` (upstream `Pakna-an`) and `Centro (Poblacion)` (upstream
`Centro (Pob.)`).

**6. Islands.** 16 barangays sit outside their municipality's drawn outline — Bantayan's
`Doong`/`Hilotongan`/`Lipayran`/`Botigues`/`Luyongbaybay`/`Sulangan`, Cordova's `Gilutongan`,
Daanbantayan's `Carnaza`, Medellin's `Gibitngil` and others. All were imported and flagged, none
dropped.

**7. Cross-province rejection.** A Davao polygon offered against a Cebu city is refused
(`BoundaryImportTest::it_rejects_a_shape_that_belongs_to_another_province`).

**8. No orphans.** All 4 users with a `barangay_id` still resolve after the import; unmatched local
rows are retained with a null code, never deleted.

---

## Failures

### BUG-1 — Admins land on the wrong municipality *(High)*

`ProvinceController::withBarangays()` reports, per province, the first city that has barangays —
`->first()` over an alphabetical list. That used to mean Mandaue City, because Mandaue was the only
city with any. After the import 53 Cebu cities qualify, so it now returns **Alcantara**.

`Workspace.jsx` uses that value to seed the Vehicle Location map. Observed: the City dropdown
defaults to Alcantara (9 barangays) instead of Mandaue, and the `'Paknaan'` default barangay is
searched among *Alcantara's* barangays, where it doesn't exist. An admin whose account carries a
`barangay_id` gets a contradictory screen — the map draws Paknaan while the City dropdown reads
Alcantara.

Gets worse with every province imported. Reproduce: open the workspace as `admin@barangay.gov`.

### BUG-2 — 1,174 barangays can be selected but not registered into *(High)*

Staff registration codes are minted per barangay by `BarangaySeeder`, which only covers Mandaue's 27.
`RegistrationSetting::for()` lazily generates a *random* code for any barangay that lacks one, and
`AuthController::register()` compares the applicant's input against it — so a barangay with no issued
code can never be registered into, because the code it's compared against is invented at that moment.

Counted after the import: **1,203 barangays, 29 with staff codes — 1,174 unregisterable.**

The failure is also misleading. Registering into Bantayan/Doong returns:

> That staff registration code is not correct. Ask your barangay office for the current code.

There is no code for that office to give. Pre-existing mechanism, but the import turned it from an
edge case into the default outcome: before, these barangays weren't selectable at all.

### BUG-3 — Super Admin barangay list is N+1 and unbounded *(Medium)*

`SuperAdminController::barangays()` calls `->get()` with no pagination and then runs
`$b->users()->havingRole('Admin')->...->exists()` per row.

Measured: **1,203 rows → 1,206 queries, 290 ms.** Projected nationwide (~42,000 barangays):
**~42,000 queries, ~10 s** per page load, with the whole table serialized into one response.

### BUG-4 — Importing one city downloads every province *(Low)*

`ImportBoundaries::importProvinces()` honours `--province` but ignores `--city`, and `--scope`
defaults to `all`. So `boundaries:import --city=072230000` reports *"Importing province outlines
(17 region files)"* — 5.3 MB fetched for someone who asked for a single city. Workaround:
`--scope=barangays`.

---

## Not covered

Browser click-through of the map and Register screens was not performed — findings above are from
API, command and database level checks. BUG-1's screen state is inferred from the resolver's output
and the `Workspace.jsx` seeding logic, not observed visually.
