import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapContainer, Marker, Polygon, Popup, TileLayer, Tooltip, useMap, ZoomControl } from 'react-leaflet';
import { toPng } from 'html-to-image';
import api from '../api/axios';
import {
  PAKNAAN_CENTER,
  PAKNAAN_POLYGON,
} from '../data/paknaanLocationDensity';
import { geoJsonToRings } from '../utils/boundary';

// Normalizes a hub record from the Laravel `/hubs` API into the shape the map/UI expects.
function normalizeHub(record) {
  return {
    id: String(record.hub_id),
    hub_id: record.hub_id,
    name: record.name,
    address: record.name,
    lat: Number(record.lat),
    lng: Number(record.lng),
    label: record.label || record.name.slice(0, 2).toUpperCase(),
    matchNames: Array.isArray(record.match_names) && record.match_names.length
      ? record.match_names
      : [record.name.toLowerCase()],
    isCustom: !record.is_default,
    isHidden: !!record.is_hidden,
  };
}

// Was CARTO's basemaps.cartocdn.com "light_all" — free and keyless when this
// was first built, but CARTO has since started requiring an API key for
// that tier, so every tile just showed an "API KEY REQUIRED" watermark.
// Esri's World Street Map is the same free/keyless deal as the satellite
// layer below (same provider, same REST tile pattern), so it's the
// lowest-risk swap rather than introducing a third tile source.
const STREET_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const STREET_ATTRIBUTION = 'Tiles &copy; Esri — Source: Esri, HERE, Garmin, USGS, Intermap, and the GIS User Community';

// Free satellite/aerial imagery (Esri World Imagery — no API key required),
// with a transparent labels overlay so street/place names still show on top
// of the imagery (a "hybrid" view, like Google's Satellite).
const ESRI_IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIBUTION = 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createHubIcon(label, isCustom = false) {
  const borderColor = isCustom ? '#4ADE80' : '#22C55E';
  const bgColor = isCustom ? '#064E3B' : '#052E16';
  const innerColor = isCustom ? '#15803D' : '#14532D';
  const safeLabel = escapeSvgText(label);

  return L.divIcon({
    className: 'location-density-hub-icon',
    html: `
      <svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 42 42" aria-hidden="true">
        <circle cx="21" cy="21" r="20" fill="${bgColor}" stroke="${borderColor}" stroke-width="2"/>
        <circle cx="21" cy="21" r="15" fill="${innerColor}" stroke="#86EFAC" stroke-width="1"/>
        <path d="M12 24.5 21 17l9 7.5" fill="none" stroke="#DCFCE7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M15.5 23.5v8h11v-8" fill="none" stroke="#DCFCE7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="21" y="15" text-anchor="middle" fill="#BBF7D0" font-size="8" font-family="Arial, sans-serif" font-weight="800">${safeLabel}</text>
      </svg>
    `,
    iconSize: [42, 42],
    iconAnchor: [21, 21],
    popupAnchor: [0, -21],
  });
}

function createVehicleDotIcon(count) {
  return L.divIcon({
    className: 'location-density-vehicle-dot-icon',
    html: `
      <span class="location-density-vehicle-dot">
        ${count > 1 ? `<span class="location-density-vehicle-count">${count}</span>` : ''}
      </span>
    `,
    iconSize: [18, 18],
    // Shifted up-right of center so this renders as a corner badge on the
    // hub pin (both markers share the same lat/lng) instead of stacking
    // directly on top of it — was iconAnchor: [9, 9] (dead center).
    iconAnchor: [-7, 25],
    popupAnchor: [0, -10],
  });
}

function createSelectedVehicleIcon() {
  return L.divIcon({
    className: 'location-density-selected-vehicle-icon',
    html: `
      <span class="location-density-selected-vehicle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </span>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -17],
  });
}

function isValidCoordinate(value) {
  return Number.isFinite(value);
}

function normalizeLocation(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Vehicles whose recorded location does not match any known hub are still
// pinned here so every vehicle is accounted for on the map.
const FALLBACK_HUB = {
  id: 'paknaan-area-unassigned',
  name: 'Paknaan Area (Unassigned)',
  address: 'Within Paknaan barangay boundary',
  lat: PAKNAAN_CENTER.lat,
  lng: PAKNAAN_CENTER.lng,
  label: 'PK',
  matchNames: [],
};

function findHubForVehicle(vehicle, hubs) {
  const location = normalizeLocation(vehicle.current_location);

  if (!location) {
    return null;
  }

  // 1. Exact match against any hub alias.
  const exact = hubs.find((hub) => (
    (hub.matchNames ?? [hub.name]).some((name) => location === normalizeLocation(name))
  ));

  if (exact) {
    return exact;
  }

  // 2. Loose contains-match so minor wording differences still land on a hub.
  return hubs.find((hub) => (
    (hub.matchNames ?? [hub.name]).some((name) => {
      const normalized = normalizeLocation(name);
      return location.includes(normalized) || normalized.includes(location);
    })
  )) ?? null;
}

function groupVehiclesByHub(vehicles, hubs) {
  const groups = new Map();

  vehicles.forEach((vehicle) => {
    const matchedHub = findHubForVehicle(vehicle, hubs);
    const hub = (matchedHub && isValidCoordinate(matchedHub.lat) && isValidCoordinate(matchedHub.lng))
      ? matchedHub
      : FALLBACK_HUB;

    const currentGroup = groups.get(hub.id) ?? { hub, vehicles: [] };
    currentGroup.vehicles.push(vehicle);
    groups.set(hub.id, currentGroup);
  });

  return Array.from(groups.values());
}

// Captures the live Leaflet map (tiles + overlays) to a PNG and triggers a download.
async function captureMapToPng(mapEl) {
  if (!mapEl) {
    throw new Error('Map element not found');
  }

  const dataUrl = await toPng(mapEl, {
    cacheBust: true,
    pixelRatio: 2,
    // Light fallback fill instead of black/transparent for any tile that
    // fails to capture (cross-origin CDN tiles can silently fail to draw).
    backgroundColor: '#eef2f7',
    // Skip Leaflet's interactive controls (and our own Map/Satellite toggle)
    // so the export is a clean map snapshot.
    filter: (node) => !(node.classList && (
      node.classList.contains('leaflet-control-zoom')
      || node.classList.contains('leaflet-control-attribution')
      || node.classList.contains('location-density-basemap-toggle')
    )),
  });

  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = `vehicle-map-${new Date().toISOString().split('T')[0]}.png`;
  link.click();
}

function FitBoundsToPolygon({ bounds }) {
  const map = useMap();

  useEffect(() => {
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });

    // maxBounds is re-derived from what's ACTUALLY on screen (not the raw
    // polygon bounds) so a tall/narrow polygon inside a wide/short map
    // container — which forces fitBounds to zoom out far enough that the
    // visible area already exceeds a bounds computed from the polygon
    // alone — always still has slack to pan. This has to be recomputed on
    // every zoom change too: a bounds padding sized for the fitted zoom
    // becomes too tight the moment the user scroll-wheel-zooms OUT (a
    // wider viewport at the same screen size needs a wider allowance), and
    // Leaflet's own maxBounds enforcement was slamming the view back to
    // the original center as soon as that happened — which is what made
    // the map feel completely stuck rather than just edge-limited.
    const syncMaxBounds = () => map.setMaxBounds(map.getBounds().pad(1));
    syncMaxBounds();
    map.on('zoomend', syncMaxBounds);

    return () => {
      map.off('zoomend', syncMaxBounds);
    };
  }, [map, bounds]);

  return null;
}

function FocusVehicleOnMap({ target }) {
  const map = useMap();
  const hubId = target?.hub.id;
  const lat = target?.hub.lat;
  const lng = target?.hub.lng;

  useEffect(() => {
    if (!isValidCoordinate(lat) || !isValidCoordinate(lng)) return;
    map.flyTo([lat, lng], Math.max(map.getZoom(), 18), {
      animate: true,
      duration: 0.8,
    });
  }, [hubId, lat, lng, map]);

  return null;
}

function ResetMapView({ requestKey, bounds }) {
  const map = useMap();

  useEffect(() => {
    if (!requestKey) return;
    map.flyToBounds(bounds, { animate: true, duration: 0.8, padding: [24, 24], maxZoom: 16 });
  }, [map, requestKey, bounds]);

  return null;
}

// Leaflet renders tiles based on the container size at mount; when the shell
// resizes (e.g. toggling fullscreen) the map must be told to recalculate.
// This one is deliberately narrow — it only fires on the isMaximized flip,
// after the CSS fullscreen transition has had time to finish (260ms) — so it
// stays alongside ResizeMapOnContainerResize below rather than replacing it.
function ResizeMapOnToggle({ trigger }) {
  const map = useMap();

  useEffect(() => {
    const timer = setTimeout(() => map.invalidateSize(), 260);
    return () => clearTimeout(timer);
  }, [map, trigger]);

  return null;
}

// General-purpose counterpart to ResizeMapOnToggle: watches the map's own
// container element for ANY size change — a collapsing/expanding sidebar in
// Workspace.jsx resizing the main content column, a window resize, or
// anything else layout-driven — none of which fire a native `resize` event
// or change `isMaximized`. Whenever the container's box actually changes
// size, tell Leaflet to recalculate its tile layout.
function ResizeMapOnContainerResize() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    if (!container || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, [map]);

  return null;
}

function LocationDensityMap({
  vehicles = [],
  selectedVehicleId = null,
  onClearSelectedVehicle = null,
  onHubsChange = null,
  canManageHubs = false,
  // Navigates to the dedicated "Add Location" form page — Add Hub used to
  // start a click-the-map-to-pin mode right here, but that page already
  // does the same POST /hubs with a proper name/address form and its own
  // live map, so this button just goes there now instead of duplicating it.
  onAddHub = null,
  // { geometry: GeoJSON Polygon|MultiPolygon, label: string } | null — set
  // by the admin topbar's barangay/city selector. Falls back to the
  // hardcoded Paknaan outline below when nothing is selected.
  boundaryOverride = null,
}) {
  const [hubRecords, setHubRecords] = useState([]);
  const [pendingLatLng, setPendingLatLng] = useState(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [hubNameDraft, setHubNameDraft] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [mapNotice, setMapNotice] = useState(null);
  const [resetViewRequest, setResetViewRequest] = useState(0);
  const [isMaximized, setIsMaximized] = useState(false);
  const [basemap, setBasemap] = useState('satellite'); // 'map' | 'satellite'
  const mapShellRef = useRef(null);
  const nameInputRef = useRef(null);

  // Allow ESC to exit fullscreen and lock body scroll while maximized.
  useEffect(() => {
    if (!isMaximized) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsMaximized(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isMaximized]);

  const fetchHubs = useCallback(async () => {
    try {
      const response = await api.get('/hubs');
      const normalized = response.data.map(normalizeHub);
      setHubRecords(normalized);
      if (onHubsChange) {
        onHubsChange(normalized.filter((hub) => !hub.isHidden));
      }
    } catch (error) {
      console.error('Failed to load hubs:', error);
    }
  }, [onHubsChange]);

  useEffect(() => {
    fetchHubs().catch(() => {});
  }, [fetchHubs]);

  // When the naming modal opens, focus the input.
  useEffect(() => {
    if (pendingLatLng && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [pendingLatLng]);

  // Opens the same naming dialog without requiring a map click first — the
  // lat/lng inputs in it start at the barangay's known center and are fully
  // editable, so a location can be added by typing coordinates alone (e.g.
  // copied from another map/GPS reading) instead of having to click the
  // exact spot.
  const openManualEntry = useCallback(() => {
    setHubNameDraft('');
    setPendingLatLng({ lat: PAKNAAN_CENTER.lat, lng: PAKNAAN_CENTER.lng });
  }, []);

  const cancelNaming = useCallback(() => {
    setPendingLatLng(null);
    setHubNameDraft('');
  }, []);

  // Both fields are typed as text (not <input type="number">'s value, which
  // silently reverts to "" on an invalid intermediate keystroke like a
  // trailing "-" or ".") — parsed to numbers only at save time, so the
  // field the map click seeded can still be hand-edited digit by digit.
  const updatePendingCoord = useCallback((axis, rawValue) => {
    setPendingLatLng((prev) => ({ ...(prev ?? {}), [axis]: rawValue }));
  }, []);

  const pendingLat = Number(pendingLatLng?.lat);
  const pendingLng = Number(pendingLatLng?.lng);
  const hasValidPendingCoords = pendingLatLng
    && String(pendingLatLng.lat).trim() !== '' && String(pendingLatLng.lng).trim() !== ''
    && Number.isFinite(pendingLat) && Number.isFinite(pendingLng)
    && pendingLat >= -90 && pendingLat <= 90 && pendingLng >= -180 && pendingLng <= 180;

  const confirmNaming = useCallback(async () => {
    const name = hubNameDraft.trim();
    if (!name || !hasValidPendingCoords || !canManageHubs) {
      return;
    }

    try {
      await api.post('/hubs', {
        name,
        lat: pendingLat,
        lng: pendingLng,
        label: name.substring(0, 2).toUpperCase(),
      });
      await fetchHubs();
      setMapNotice({ type: 'success', text: `${name} hub added.` });
    } catch (error) {
      setMapNotice({ type: 'error', text: error.response?.data?.message || 'Failed to add hub.' });
    } finally {
      setPendingLatLng(null);
      setHubNameDraft('');
    }
  }, [canManageHubs, fetchHubs, hasValidPendingCoords, hubNameDraft, pendingLat, pendingLng]);

  const captureMap = useCallback(async () => {
    setCapturing(true);
    setMapNotice(null);
    try {
      await captureMapToPng(mapShellRef.current?.querySelector('.location-density-map'));
      setMapNotice({ type: 'success', text: 'Map image downloaded.' });
    } catch (error) {
      console.error('Failed to capture map:', error);
      setMapNotice({ type: 'error', text: 'The map could not be captured. Please try again.' });
    } finally {
      setCapturing(false);
    }
  }, []);

  const requestDeleteHub = useCallback((hub) => {
    setDeleteCandidate(hub);
  }, []);

  const cancelDeleteHub = useCallback(() => {
    setDeleteCandidate(null);
  }, []);

  const confirmDeleteHub = useCallback(async () => {
    if (!deleteCandidate || !canManageHubs) return;

    try {
      if (deleteCandidate.isCustom) {
        await api.delete(`/hubs/${deleteCandidate.hub_id}`);
      } else {
        await api.put(`/hubs/${deleteCandidate.hub_id}`, { is_hidden: true });
      }
      await fetchHubs();
      setMapNotice({ type: 'success', text: `${deleteCandidate.name} removed from the map.` });
    } catch (error) {
      setMapNotice({ type: 'error', text: error.response?.data?.message || 'Failed to remove hub.' });
    } finally {
      setDeleteCandidate(null);
    }
  }, [canManageHubs, deleteCandidate, fetchHubs]);

  const restoreDefaultHubs = useCallback(async () => {
    const hiddenDefaults = hubRecords.filter((hub) => hub.isHidden);
    try {
      await Promise.all(hiddenDefaults.map((hub) => api.put(`/hubs/${hub.hub_id}`, { is_hidden: false })));
      await fetchHubs();
      setMapNotice({ type: 'success', text: 'Default hubs restored.' });
    } catch {
      setMapNotice({ type: 'error', text: 'Failed to restore hubs.' });
    }
  }, [fetchHubs, hubRecords]);

  const cancelFocusMode = useCallback(() => {
    setResetViewRequest((value) => value + 1);
    setMapNotice({ type: 'success', text: 'Vehicle focus cleared.' });
    if (onClearSelectedVehicle) {
      onClearSelectedVehicle();
    }
  }, [onClearSelectedVehicle]);

  const hasBoundarySelection = boundaryOverride !== null;
  const hasBoundaryGeometry = Boolean(boundaryOverride?.geometry);
  const boundaryLabel = boundaryOverride?.label ?? 'Paknaan';
  // Only the actual outline to draw — deliberately empty when a barangay
  // was picked but has no boundary polygon on file (only Mandaue City
  // barangays do today), rather than silently substituting Paknaan's shape.
  const boundaryRings = useMemo(() => {
    if (hasBoundarySelection && !hasBoundaryGeometry) return [];
    const overrideRings = geoJsonToRings(boundaryOverride?.geometry);
    return overrideRings.length ? overrideRings : [PAKNAAN_POLYGON];
  }, [boundaryOverride, hasBoundarySelection, hasBoundaryGeometry]);
  // The map still needs *some* valid area to frame even when there's
  // nothing to draw — keep the last known region (Paknaan) rather than an
  // empty/invalid Leaflet bounds object.
  const boundaryBounds = useMemo(() => {
    const framingRings = boundaryRings.length ? boundaryRings : [PAKNAAN_POLYGON];
    return L.latLngBounds(framingRings.flat());
  }, [boundaryRings]);
  // Generous padding so panning/zooming still feels free within whichever
  // area is selected, not just the original hand-tuned Paknaan box.
  const boundaryMaxBounds = useMemo(() => boundaryBounds.pad(0.5), [boundaryBounds]);
  const boundaryCenter = useMemo(() => boundaryBounds.getCenter(), [boundaryBounds]);

  const hubs = useMemo(
    () => hubRecords.filter((hub) => !hub.isHidden && isValidCoordinate(hub.lat) && isValidCoordinate(hub.lng)),
    [hubRecords],
  );

  const hubIcons = useMemo(
    () => Object.fromEntries(hubs.map((hub) => [hub.id, createHubIcon(hub.label, hub.isCustom)])),
    [hubs],
  );
  const vehicleGroups = useMemo(() => groupVehiclesByHub(vehicles, hubs), [hubs, vehicles]);
  const vehicleIcons = useMemo(
    () => Object.fromEntries(
      vehicleGroups.map((group) => [group.hub.id, createVehicleDotIcon(group.vehicles.length)]),
    ),
    [vehicleGroups],
  );
  const selectedId = selectedVehicleId == null ? null : String(selectedVehicleId);
  let selectedVehicleGroup = null;
  if (selectedId) {
    for (const group of vehicleGroups) {
      const vehicle = group.vehicles.find((candidate) => String(candidate.vehicle_id) === selectedId);
      if (vehicle) {
        selectedVehicleGroup = { hub: group.hub, vehicle };
        break;
      }
    }
  }
  const selectedVehicleIcon = useMemo(() => createSelectedVehicleIcon(), []);

  // Vehicles still parked at the hub pending deletion — the backend already
  // refuses this delete server-side (a vehicle's current_location still
  // points at it), but surfacing it here lets the Admin see which vehicles
  // are blocking it and act on them, instead of only finding out after the
  // delete request comes back with an error.
  const deleteCandidateVehicles = useMemo(() => {
    if (!deleteCandidate) return [];
    return vehicleGroups.find((group) => group.hub.id === deleteCandidate.id)?.vehicles ?? [];
  }, [deleteCandidate, vehicleGroups]);

  return (
    <div className={`location-density-map-shell${isMaximized ? ' is-maximized' : ''}`} ref={mapShellRef}>
      <div className="location-density-toolbar">
        <span className="location-density-hint">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {canManageHubs
            ? '"Add Hub" opens the add-location form, or use "By Coordinates" to type its name and lat/lng directly.'
            : 'Hubs shown here are shared by every workspace user.'}
        </span>
        <div style={{ display: 'flex', gap: '8px' }}>
          {selectedVehicleId != null && (
            <button
              type="button"
              className="location-density-btn is-secondary is-focus-cancel"
              onClick={cancelFocusMode}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-6 10-6c2.2 0 4.1.7 5.7 1.7" />
                <path d="M22 12s-3.5 6-10 6c-2.2 0-4.1-.7-5.7-1.7" />
                <path d="M3 3l18 18" />
                <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              </svg>
              Cancel Focus
            </button>
          )}
          {canManageHubs && hubRecords.some((hub) => hub.isHidden) && (
            <button
              type="button"
              className="location-density-btn is-secondary"
              onClick={restoreDefaultHubs}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v6h6" />
              </svg>
              Restore Hubs
            </button>
          )}
          {canManageHubs && (
            <button
              type="button"
              className="location-density-btn is-primary"
              onClick={onAddHub}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
                <circle cx="12" cy="9" r="2.5" fill="currentColor" stroke="none" />
              </svg>
              Add Hub
            </button>
          )}
          {canManageHubs && (
            <button
              type="button"
              className="location-density-btn is-secondary"
              onClick={openManualEntry}
              title="Type a name and coordinates instead of clicking the map"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              By Coordinates
            </button>
          )}
          <button
            type="button"
            className="location-density-btn is-secondary"
            onClick={captureMap}
            disabled={capturing}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {capturing ? 'Capturing…' : 'Download Map'}
          </button>
          <button
            type="button"
            className={`location-density-btn ${isMaximized ? 'is-active' : 'is-secondary'}`}
            onClick={() => setIsMaximized((prev) => !prev)}
            title={isMaximized ? 'Exit fullscreen (Esc)' : 'Maximize map'}
          >
            {isMaximized ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 9 4 4M9 9V5M9 9H5" />
                  <path d="m15 9 5-5M15 9V5M15 9h4" />
                  <path d="m9 15-5 5M9 15v4M9 15H5" />
                  <path d="m15 15 5 5M15 15v4M15 15h4" />
                </svg>
                Exit Fullscreen
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6" />
                  <path d="M9 21H3v-6" />
                  <path d="M21 3l-7 7" />
                  <path d="M3 21l7-7" />
                </svg>
                Maximize
              </>
            )}
          </button>
        </div>
      </div>
      <div className="location-density-legend" aria-label="Map legend">
        <span className="location-density-legend-item">
          <span className="legend-symbol legend-symbol-hub" aria-hidden="true" />
          Hub
        </span>
        <span className="location-density-legend-item">
          <span className="legend-symbol legend-symbol-vehicle" aria-hidden="true" />
          Vehicle count
        </span>
        <span className="location-density-legend-item">
          <span className="legend-symbol legend-symbol-focus" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </span>
          FOCUS
        </span>
        {boundaryRings.length > 0 && (
          <span className="location-density-legend-item">
            <span className="legend-symbol legend-symbol-boundary" aria-hidden="true" />
            {boundaryLabel} boundary
          </span>
        )}
      </div>
      {hasBoundarySelection && !hasBoundaryGeometry && (
        <div className="location-density-notice info" role="status">
          <span>No boundary outline on file for {boundaryLabel} yet — only Mandaue City barangays have one today. Hubs and vehicles below aren't affected.</span>
        </div>
      )}
      {mapNotice && (
        <div className={`location-density-notice ${mapNotice.type}`} role="status">
          <span>{mapNotice.text}</span>
          <button type="button" onClick={() => setMapNotice(null)} aria-label="Dismiss map notice">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      <MapContainer
        // Remount on boundary change — the simplest reliable way to make
        // Leaflet's maxBounds/initial center actually take effect for the
        // newly selected area, since react-leaflet doesn't re-apply those
        // constructor-time props on an already-mounted map.
        key={boundaryLabel}
        attributionControl
        center={[boundaryCenter.lat, boundaryCenter.lng]}
        className="location-density-map"
        maxBounds={boundaryMaxBounds}
        maxBoundsViscosity={1}
        scrollWheelZoom
        zoom={16}
        zoomControl={false}
      >
        {basemap === 'satellite' ? (
          <>
            <TileLayer attribution={ESRI_ATTRIBUTION} crossOrigin="anonymous" maxZoom={19} url={ESRI_IMAGERY_URL} />
            <TileLayer attribution="" crossOrigin="anonymous" maxZoom={19} url={ESRI_LABELS_URL} />
          </>
        ) : (
          <TileLayer attribution={STREET_ATTRIBUTION} crossOrigin="anonymous" maxZoom={19} url={STREET_TILE_URL} />
        )}

        {/* Map / Satellite base-layer toggle — floats over the map like Google.
            Rendered inside the Leaflet container; disableClickPropagation keeps
            clicks from panning the map underneath. */}
        <div
          className="location-density-basemap-toggle"
          ref={(el) => { if (el) { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); } }}
        >
          <button type="button" className={basemap === 'map' ? 'is-active' : ''} onClick={() => setBasemap('map')}>Map</button>
          <button type="button" className={basemap === 'satellite' ? 'is-active' : ''} onClick={() => setBasemap('satellite')}>Satellite</button>
        </div>
        {/* Dark casing (halo) drawn UNDER the boundary so the yellow line pops
            on both the light street map and the dark satellite imagery. One
            <Polygon> per ring so a MultiPolygon (e.g. a city with islands)
            renders as separate disjoint shapes rather than shell+holes. */}
        {boundaryRings.map((ring, index) => (
          <Polygon
            key={`halo-${index}`}
            pathOptions={{ color: '#1e293b', weight: 6, opacity: 0.45, fill: false }}
            positions={ring}
          />
        ))}
        {/* Solid yellow boundary on top — high visibility against greens,
            water, and light streets alike. */}
        {boundaryRings.map((ring, index) => (
          <Polygon
            key={`line-${index}`}
            pathOptions={{
              color: '#facc15',
              fillColor: '#facc15',
              fillOpacity: 0.05,
              opacity: 1,
              weight: 3,
            }}
            positions={ring}
          />
        ))}
        {hubs.map((hub) => (
          <Marker
            icon={hubIcons[hub.id]}
            key={hub.id}
            position={[hub.lat, hub.lng]}
            zIndexOffset={1050}
          >
            {/* Hover-only, not permanent — each hub pin already shows its
                short code baked into the icon; several always-on full-name
                labels on closely-spaced hubs were overlapping and cutting
                each other off. */}
            <Tooltip
              className="location-density-hub-tooltip"
              direction="top"
              offset={[0, -24]}
            >
              {hub.name}
            </Tooltip>
            <Popup className="location-density-hub-popup">
              <div className="location-density-popup">
                <strong>{hub.name}</strong>
                <span>{hub.address}</span>
                <span>Latitude: {hub.lat.toFixed(6)}</span>
                <span>Longitude: {hub.lng.toFixed(6)}</span>
                {canManageHubs && (
                  <div className="location-density-popup-actions">
                    <button type="button" className="location-density-delete-hub" onClick={() => requestDeleteHub(hub)}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                      Delete Hub
                    </button>
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
        {vehicleGroups.map(({ hub, vehicles: hubVehicles }) => (
          <Marker
            icon={vehicleIcons[hub.id]}
            key={`vehicles-${hub.id}`}
            position={[hub.lat, hub.lng]}
            zIndexOffset={1400}
          >
            <Tooltip
              className="location-density-vehicle-tooltip"
              direction="top"
              offset={[0, -14]}
            >
              {hubVehicles.length} vehicle{hubVehicles.length === 1 ? '' : 's'} at {hub.name}
            </Tooltip>
            <Popup className="location-density-vehicle-popup">
              <div className="location-density-vehicle-popup-content">
                <strong>{hub.name}</strong>
                <span>{hub.address}</span>
                <span>Latitude: {hub.lat}</span>
                <span>Longitude: {hub.lng}</span>
                <div className="location-density-vehicle-list">
                  {hubVehicles.map((vehicle) => (
                    <article className="location-density-vehicle-item" key={vehicle.vehicle_id}>
                      <b>{vehicle.vehicle_name}</b>
                      <span>Plate: {vehicle.plate_number}</span>
                      <span>Type: {vehicle.category?.category_name ?? '-'}</span>
                      <span>Status: {vehicle.status}</span>
                      <span>Condition: {vehicle.condition ?? '-'}</span>
                      <span>Current Location: {vehicle.current_location}</span>
                    </article>
                  ))}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
        {selectedVehicleGroup && (
          <Marker
            icon={selectedVehicleIcon}
            key={`selected-vehicle-${selectedVehicleGroup.vehicle.vehicle_id}`}
            position={[selectedVehicleGroup.hub.lat, selectedVehicleGroup.hub.lng]}
            zIndexOffset={1750}
          >
            <Tooltip
              className="location-density-selected-vehicle-tooltip"
              direction="top"
              offset={[0, -25]}
              permanent
            >
              Viewing {selectedVehicleGroup.vehicle.vehicle_name}
            </Tooltip>
            <Popup className="location-density-vehicle-popup">
              <div className="location-density-vehicle-popup-content">
                <strong>{selectedVehicleGroup.vehicle.vehicle_name}</strong>
                <span>Plate: {selectedVehicleGroup.vehicle.plate_number}</span>
                <span>Current Location: {selectedVehicleGroup.vehicle.current_location}</span>
                <span>Hub: {selectedVehicleGroup.hub.name}</span>
              </div>
            </Popup>
          </Marker>
        )}
        <ZoomControl position="bottomright" />
        <FitBoundsToPolygon bounds={boundaryBounds} />
        <FocusVehicleOnMap target={selectedVehicleGroup} />
        <ResetMapView requestKey={resetViewRequest} bounds={boundaryBounds} />
        <ResizeMapOnToggle trigger={isMaximized} />
        <ResizeMapOnContainerResize />
      </MapContainer>

      {pendingLatLng && (
        <div className="hub-modal-overlay" onMouseDown={cancelNaming}>
          <div
            className="hub-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hub-modal-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="hub-modal-header">
              <span className="hub-modal-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
                  <circle cx="12" cy="9" r="2.5" fill="currentColor" stroke="none" />
                </svg>
              </span>
              <h3 id="hub-modal-title">Name this location hub</h3>
            </div>

            <label className="hub-modal-label" htmlFor="hub-name-input">Hub name</label>
            <input
              id="hub-name-input"
              ref={nameInputRef}
              className="hub-modal-input"
              type="text"
              placeholder="e.g. Paknaan Health Center"
              value={hubNameDraft}
              onChange={(e) => setHubNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmNaming();
                if (e.key === 'Escape') cancelNaming();
              }}
              maxLength={60}
            />

            {/* Seeded from wherever the map was clicked (or the barangay
                center, for the "By Coordinates" entry point) but always
                editable — clicking gets you close, typing gets you exact. */}
            <div className="hub-modal-coord-fields">
              <div>
                <label className="hub-modal-label" htmlFor="hub-lat-input">Latitude</label>
                <input
                  id="hub-lat-input"
                  className="hub-modal-input"
                  type="number"
                  step="any"
                  min={-90}
                  max={90}
                  placeholder="e.g. 10.346106"
                  value={pendingLatLng.lat}
                  onChange={(e) => updatePendingCoord('lat', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmNaming();
                    if (e.key === 'Escape') cancelNaming();
                  }}
                />
              </div>
              <div>
                <label className="hub-modal-label" htmlFor="hub-lng-input">Longitude</label>
                <input
                  id="hub-lng-input"
                  className="hub-modal-input"
                  type="number"
                  step="any"
                  min={-180}
                  max={180}
                  placeholder="e.g. 123.961186"
                  value={pendingLatLng.lng}
                  onChange={(e) => updatePendingCoord('lng', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmNaming();
                    if (e.key === 'Escape') cancelNaming();
                  }}
                />
              </div>
            </div>
            {!hasValidPendingCoords && (
              <p className="hub-modal-coord-hint">Enter a latitude between -90 and 90, and a longitude between -180 and 180.</p>
            )}

            <div className="hub-modal-actions">
              <button type="button" className="hub-modal-btn hub-modal-cancel" onClick={cancelNaming}>
                Cancel
              </button>
              <button
                type="button"
                className="hub-modal-btn hub-modal-save"
                onClick={confirmNaming}
                disabled={!hubNameDraft.trim() || !hasValidPendingCoords}
              >
                Save Hub
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteCandidate && (
        <div className="hub-modal-overlay" onMouseDown={cancelDeleteHub}>
          <div
            className="hub-modal hub-modal-danger"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hub-delete-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="hub-modal-header">
              <span className="hub-modal-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </span>
              <h3 id="hub-delete-title">Delete hub</h3>
            </div>

            {deleteCandidateVehicles.length > 0 ? (
              <>
                <p className="hub-modal-message">
                  <strong>{deleteCandidate.name}</strong> still has {deleteCandidateVehicles.length} vehicle{deleteCandidateVehicles.length > 1 ? 's' : ''} assigned to it. Relocate or update {deleteCandidateVehicles.length > 1 ? 'those vehicles' : 'that vehicle'} to another location before this hub can be deleted.
                </p>
                <ul className="hub-modal-vehicle-list">
                  {deleteCandidateVehicles.map((vehicle) => (
                    <li key={vehicle.vehicle_id}>{vehicle.vehicle_name} · {vehicle.plate_number}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="hub-modal-message">
                Remove <strong>{deleteCandidate.name}</strong> from the map and location choices?
              </p>
            )}
            {!deleteCandidate.isCustom && deleteCandidateVehicles.length === 0 && (
              <p className="hub-modal-coords">
Built-in hubs are hidden for every user and can be restored later.
              </p>
            )}

            <div className="hub-modal-actions">
              <button type="button" className="hub-modal-btn hub-modal-cancel" onClick={cancelDeleteHub}>
                {deleteCandidateVehicles.length > 0 ? 'Close' : 'Cancel'}
              </button>
              {deleteCandidateVehicles.length === 0 && (
                <button type="button" className="hub-modal-btn hub-modal-delete" onClick={confirmDeleteHub}>
                  Delete Hub
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LocationDensityMap;
