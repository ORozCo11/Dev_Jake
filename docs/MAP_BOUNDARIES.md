# Map Boundaries — Setup and How It Works

How the VMS gets Philippine administrative outlines, and what to run when
setting up a new machine. For the rules this implements, see
[GEOJSON_BOUNDARY_RULES.md](GEOJSON_BOUNDARY_RULES.md).

---

## Setup (run once, after seeding)

```bash
cd backend-api
php artisan migrate --seed          # geography + everything else, no network
php artisan boundaries:import       # nationwide outlines (~5 min, needs internet)
```

To start smaller, import one province first:

```bash
php artisan boundaries:import --province=072200000   # Cebu: 53 cities, ~1,200 barangays
```

The import is **idempotent** — re-running changes nothing. Pass `--force` to
re-download and overwrite existing outlines.

### If downloads fail with a certificate error

PHP on Windows often ships without a CA bundle, so HTTPS verification fails
(`cURL error 60`) even though `curl` on the command line works. Either:

- **Fix PHP once** — download <https://curl.se/ca/cacert.pem>, then point both
  `curl.cainfo` and `openssl.cafile` at its full path in your `php.ini`; or
- **Work offline** — download the files with `curl` and import from disk:

```bash
php artisan boundaries:import --from=/path/to/downloaded/geojson
```

## Where the data comes from

[`faeldon/philippines-json-maps`](https://github.com/faeldon/philippines-json-maps),
**2019 vintage**, fetched at import time (never at runtime, never during
registration).

| Level | Source | Coverage |
|---|---|---|
| Provinces | `2019/.../provinces-region-ph{REGION}.json` | 84 |
| Cities/municipalities | bundled `database/data/city-boundaries.json`, seeded offline | 1,610 of 1,634 |
| Barangays | `2019/.../barangays-municity-ph{CITY_CODE}.json` | ~42,000 |

**Why 2019 and not the newer 2023 set:** 2023 uses the revised PSGC numbering
(Bantayan is `702209000` there, `072209000` in our tables), so adopting it
would mean building and maintaining a crosswalk for all 1,634 cities. The 2019
codes match `provinces.code` / `cities.code` exactly.

The ~24 cities without an outline are independent cities the upstream city-level
source doesn't carry standalone — Mandaue City among them. Their barangays still
import fine; only the city-level shape is missing.

## How a boundary reaches the map

```
boundaries:import  →  provinces/cities/barangays .boundary  →  GET /barangays/{id}
                                                            →  boundaryOverride
                                                            →  LocationDensityMap
```

Nothing is hardcoded in React, and registration never reads a file or calls the
network — it only selects an existing row.

### Fallback

A barangay with no outline of its own shows its **city's** outline instead, with
a notice naming what was actually asked for. If neither has one, the map says so
and draws nothing — never an invented circle or rectangle.

## Registration

Cities whose barangays have been imported require picking one from the dropdown;
a typed name is rejected there, so it can't mint a duplicate alongside the real
row. A city with nothing on file yet still accepts a typed name — that fallback
exists so missing data can't lock a whole city out of the system.

## Reconciliation rules

When the importer meets a barangay this instance already has:

- Matched by PSGC code, or by name (normalized — `Pakna-an`/`Paknaan` and
  `Centro (Pob.)`/`Centro (Poblacion)` are the same place) → the existing row
  absorbs the code and outline. **The local spelling is kept**, and every
  divergence is printed at the end of the run.
- No upstream match → the row is left exactly as it is, with a null code.

The importer **never deletes a row, never renames one, and never moves one
between cities** — those rows are what `users.barangay_id` points at.

## Adding an outline that's still missing

For the ~24 cities with no city-level shape, or any barangay upstream doesn't
carry: trace it on [geojson.io](https://geojson.io) (satellite view, polygon
tool, close the loop, copy the geometry) and store it against the row, setting
`boundary_source` to something that says where it came from (e.g.
`geojson.io-manual`). Keep GeoJSON's `[longitude, latitude]` order — don't
reverse it by hand. geojson.io is a maintenance tool only; it is never part of
the registration flow.
