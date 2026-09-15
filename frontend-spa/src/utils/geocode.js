// Free, keyless address geocoding via OpenStreetMap's Nominatim — fine for
// the occasional "add a location by address" lookup this form does. Not
// meant for bulk/high-volume use; see Nominatim's usage policy if that
// ever changes (https://operations.osmfoundation.org/policies/nominatim/).

const REQUEST_TIMEOUT_MS = 10000;

// AbortController-based timeout — a slow/unresponsive lookup (flaky wifi, a
// Nominatim hiccup) must fail loudly rather than hang forever, since the
// caller disables its Save button while a lookup is in flight. An
// indefinite hang would otherwise lock that button permanently.
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('The address lookup timed out — please try again.');
    }
    throw new Error('The address lookup service is unavailable right now — please try again.');
  } finally {
    clearTimeout(timer);
  }
}

export async function geocodeAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error('The address lookup service is unavailable right now — please try again.');
  }

  const results = await response.json();
  if (!results.length) {
    return null;
  }

  const [match] = results;
  return { lat: Number(match.lat), lng: Number(match.lon), displayName: match.display_name };
}

// The reverse of geocodeAddress — turns a clicked/dropped map point back
// into a human-readable address, so pinpointing on the map can fill in the
// Address field the same way typing an address fills in the map pin.
// Returns null (rather than throwing) when Nominatim has nothing for the
// point, since a missing reverse-lookup shouldn't block placing the pin —
// the admin can still type the address in by hand.
export async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error('The address lookup service is unavailable right now — please try again.');
  }

  const result = await response.json();
  return result?.display_name ?? null;
}
