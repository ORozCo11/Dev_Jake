# VMS GeoJSON Boundary Sources — Rules and Responsibilities

## Objective

The VMS must support registering a new Province, City/Municipality, or Barangay and display its actual polygon boundary on the Vehicle Location map whenever valid GeoJSON boundary data is available.

The implementation uses two external projects with different responsibilities:

1. `faeldon/philippines-json-maps`
2. `mapbox/geojson.io`

They must not be treated as interchangeable data sources.

---

# 1. philippines-json-maps

Repository: `https://github.com/faeldon/philippines-json-maps.git`

## Role

**Primary Philippine administrative boundary data source.**

This repository should be checked first whenever the VMS needs a boundary for: Region, Province, City, Municipality, or Barangay.

## Responsibilities

### A. Provide Existing Philippine Boundaries

Use the GeoJSON datasets from this repository as the preferred source for existing Philippine administrative polygons. When an administrator registers a location, the system should attempt to match that location with the corresponding boundary from this dataset.

Expected flow:

```text
Register Barangay
      ↓
Identify PSGC/location record
      ↓
Search Philippines JSON Maps dataset
      ↓
Find matching Barangay Feature
      ↓
Extract GeoJSON geometry
      ↓
Store in barangays.boundary
      ↓
Display polygon on VMS map
```

### B. Preserve GeoJSON Geometry

Do not manually alter coordinate ordering. GeoJSON coordinates must remain `[longitude, latitude]`. Valid geometry types are `Polygon` and `MultiPolygon`.

### C. Match Using Stable Location Identifiers

Preferred matching order:

1. PSGC code
2. Province + City + Barangay relationship
3. Exact normalized location name

Do not rely only on raw barangay names — identical barangay names exist across different cities (e.g. "Poblacion"). Always match through the full Province → City → Barangay relationship.

### D. Do Not Modify the External Dataset

Treat `philippines-json-maps` as an external source. Do not change its files to make the VMS work — extract the required Feature/geometry and store a VMS-owned copy in the VMS database or seed data.

---

# 2. geojson.io

Repository: `https://github.com/mapbox/geojson.io.git`

## Role

**GeoJSON creation, inspection, editing, validation, and fallback boundary tool.** Not the authoritative source for Philippine barangay boundaries.

Used when: a boundary needs inspection; an existing polygon needs correction/simplification; administrators need to preview coordinates; no usable polygon exists in the primary dataset; or a custom operational boundary must be drawn.

## Responsibilities

### A. Preview Existing Boundaries

Before importing a `philippines-json-maps` polygon into VMS, verify in geojson.io: location is correct, polygon is closed, shape isn't corrupted, it isn't in the wrong province/city, and geometry is `Polygon`/`MultiPolygon`.

### B. Draw Missing Boundaries

```text
Open geojson.io → Navigate to target location → Select Polygon tool →
Trace administrative boundary → Close polygon → Inspect GeoJSON →
Copy geometry → Validate → Store in VMS
```

### C. Edit Existing GeoJSON

Move incorrect vertices, remove accidental points, correct malformed shapes, inspect MultiPolygon islands, preview the final shape.

### D. Never Invent a Boundary Without Verification

A manually drawn boundary is not automatically an official administrative boundary. Compare against PSGC-related datasets, official government GIS data, OpenStreetMap administrative boundaries, or PSA/NAMRIA data where possible. Manual tracing is a fallback, not the first source.

---

# 3. Boundary Source Priority

```text
1. Existing VMS database boundary
2. philippines-json-maps
3. Official PSA / NAMRIA boundary
4. OpenStreetMap administrative boundary
5. Manual geojson.io drawing
```

Do not manually draw a boundary when a reliable existing polygon is already available.

---

# 4. Barangay Registration Rule

Boundary handling is part of registering a new barangay:

```text
Create/Locate Province
        ↓
Create/Locate City
        ↓
Register Barangay
        ↓
Search available boundary
        ↓
       Found?
      /      \
    YES       NO
     ↓         ↓
Import      boundary = null
geometry       ↓
     ↓      Allow manual
Validate    GeoJSON later
     ↓
Save barangays.boundary
```

---

# 5. Map Rendering Rule

`LocationDensityMap.jsx` must not contain hardcoded barangay polygons. The frontend only receives `{ geometry: barangay.boundary, label: barangay.name }`. The map component is responsible only for rendering the polygon, fitting the camera, highlighting the selected area, and showing its label — never for finding Philippine administrative boundary data.

---

# 6. Backend Responsibility

The backend owns: location registration, PSGC/location matching, GeoJSON validation, boundary storage, boundary API responses, and source tracking.

Recommended fields:

```text
barangays
---------
id
city_id
code
name
boundary
boundary_source
boundary_verified_at
created_at
updated_at
```

`boundary_source` examples: `"philippines-json-maps"`, `"geojson.io-manual"` — makes it clear where each polygon originated.

---

# 7. GeoJSON Validation Rules

**Required before saving any boundary:** valid JSON; `Polygon` or `MultiPolygon`; valid longitude/latitude values; closed polygon rings; enough vertices to form an area; non-empty geometry.

**Reject:** `Point`, `LineString`, empty coordinates, invalid JSON, reversed lat/lng, unclosed polygon, geometry outside the selected city/province.

---

# 8. Parent Boundary Validation

A Barangay boundary should approximately exist inside its parent City/Municipality boundary (Province → City/Municipality → Barangay hierarchy). If a supplied polygon lands in a different city than the one it's being registered under, the VMS should reject or flag it.

---

# 9. Registration Success Requirement

Registering a barangay alone doesn't guarantee an outline appears — `barangays.boundary` must be non-null and valid GeoJSON:

```text
Admin selects Barangay → GET /barangays/{id} → boundary returned →
boundaryOverride → LocationDensityMap → Polygon displayed
```

---

# 10. Fallback Behaviour

If a registered barangay has no boundary: do not crash the map, and do not fabricate a fake rectangle/circle. Fall back to the City/Municipality boundary as the visual fallback, and surface it in the UI, e.g. "Barangay boundary not yet available. Showing whole city boundary."

---

# 11. Testing Requirement

```text
1. Register Province
2. Register/Select City
3. Register Barangay
4. Attach/import GeoJSON polygon
5. Save
6. Reload application
7. Select Province
8. Select City
9. Select Barangay
10. Verify polygon appears
11. Verify map zooms to polygon
12. Verify polygon corresponds to correct location
13. Refresh browser
14. Verify polygon remains available
```

A test is successful only when the polygon comes from stored boundary data, never a hardcoded frontend value.

---

# Golden Rule

| Component | Responsibility |
|---|---|
| **philippines-json-maps** | Find and supply existing Philippine administrative boundaries. |
| **geojson.io** | View, validate, edit, or manually create GeoJSON boundaries. |
| **VMS Backend** | Match, validate, persist, and serve the boundary. |
| **VMS Frontend** | Render the boundary returned by the backend. |

The frontend must never become the source of truth for geographic boundaries.

## Reference repositories

- https://github.com/mapbox/geojson.io.git
- https://github.com/faeldon/philippines-json-maps.git
