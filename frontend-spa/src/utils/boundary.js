// Shared boundary/geometry helpers — used by both the fleet map (to draw
// the outline) and the "Add Location" form (to reject an address outside
// it), so both always agree on what "inside the boundary" means.

function isLngLatPair(point) {
  return Array.isArray(point) && point.length >= 2
    && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function toLatLngRing(ring) {
  if (!Array.isArray(ring) || !ring.every(isLngLatPair)) {
    console.warn('boundary: skipping malformed boundary ring', ring);
    return null;
  }
  return ring.map(([lng, lat]) => [lat, lng]);
}

// Converts a GeoJSON Polygon/MultiPolygon geometry into an array of Leaflet
// LatLng rings — one ring per Polygon, one per part of a MultiPolygon (e.g.
// islands). Holes are dropped since every use of this is either a decorative
// outline or an "is this point roughly inside" check, not an exact
// administrative shape. Malformed/unexpected boundary data must not throw
// here — callers run this during render, where an uncaught error would
// crash the whole page — so it's skipped (and logged) instead.
export function geoJsonToRings(geometry) {
  if (!geometry) return [];

  if (geometry.type === 'Polygon') {
    if (!Array.isArray(geometry.coordinates)) {
      console.warn('boundary: skipping malformed Polygon geometry', geometry);
      return [];
    }
    const ring = toLatLngRing(geometry.coordinates[0]);
    return ring ? [ring] : [];
  }
  if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates)) {
      console.warn('boundary: skipping malformed MultiPolygon geometry', geometry);
      return [];
    }
    return geometry.coordinates
      .map((polygon) => (Array.isArray(polygon) ? toLatLngRing(polygon[0]) : null))
      .filter(Boolean);
  }
  return [];
}

// Ray-casting point-in-polygon test (standard even-odd algorithm). `ring`
// is an array of [lat, lng] pairs — Leaflet's convention, used throughout
// this app, NOT GeoJSON's [lng, lat].
function isPointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    const intersects = ((lngI > lng) !== (lngJ > lng))
      && (lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI);
    if (intersects) inside = !inside;
  }
  return inside;
}

// True if {lat, lng} falls inside ANY of the given rings — a MultiPolygon
// (e.g. a city made of several disjoint barangay shapes) counts as "in
// bounds" if the point lands in any one part of it.
export function isPointWithinBoundaryRings(point, rings) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng) || !rings?.length) {
    return false;
  }
  return rings.some((ring) => isPointInRing(point.lat, point.lng, ring));
}
