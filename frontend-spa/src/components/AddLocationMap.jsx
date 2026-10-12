import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Polygon, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const ESRI_IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIBUTION = 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

// Same blue teardrop pin as VehicleLocationMap — not shared from there since
// that component doesn't export it, and duplicating one small icon constant
// is cheaper than restructuring an already-working, unrelated component.
const pickPin = L.divIcon({
  className: 'veh-map-pin',
  html: `
    <svg xmlns="http://www.w3.org/2000/svg" width="34" height="42" viewBox="0 0 34 42" aria-hidden="true">
      <path d="M17 1C8.7 1 2 7.7 2 16c0 10.5 13.4 23.6 14 24.2a1.4 1.4 0 0 0 2 0C18.6 39.6 32 26.5 32 16 32 7.7 25.3 1 17 1z" fill="#2563eb" stroke="#ffffff" stroke-width="2"/>
      <circle cx="17" cy="16" r="6" fill="#ffffff"/>
    </svg>`,
  iconSize: [34, 42],
  iconAnchor: [17, 42],
});

function ClickToPick({ onPick }) {
  useMapEvents({
    click(e) {
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

// Address typed in the form re-centers the map on the geocoded point —
// clicking the map itself already puts the view there, so this only needs
// to react to marker changes that came from OUTSIDE a click (i.e. typing).
function FlyToMarker({ marker }) {
  const map = useMap();
  useEffect(() => {
    if (!marker) return;
    map.flyTo([marker.lat, marker.lng], Math.max(map.getZoom(), 16), { animate: true, duration: 0.6 });
  }, [marker, map]);
  return null;
}

// Same resize-on-container-change pattern as the other two map components —
// Leaflet only measures its container at mount, so a sidebar collapse/expand
// or any other layout-driven resize needs an explicit invalidateSize() or
// the map keeps rendering into a stale-sized canvas.
function ResizeMapOnContainerResize() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    if (!container || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);

    return () => observer.disconnect();
  }, [map]);

  return null;
}

// Focused, single-purpose map for the "Add Location" page: click anywhere
// to drop/move the pin (the parent reverse-geocodes it into the Address
// field), and re-centers itself when the parent moves the pin instead (the
// admin typed an address that got geocoded). The service-area boundary is
// drawn so it's obvious at a glance where a click will actually be accepted.
export default function AddLocationMap({ marker, boundaryRings, onPick }) {
  const bounds = useMemo(() => L.latLngBounds(boundaryRings.flat()), [boundaryRings]);
  const initialCenter = bounds.getCenter();

  return (
    <MapContainer
      center={[initialCenter.lat, initialCenter.lng]}
      zoom={16}
      scrollWheelZoom
      className="add-location-map-canvas"
      attributionControl
    >
      <ResizeMapOnContainerResize />
      <TileLayer url={ESRI_IMAGERY_URL} attribution={ESRI_ATTRIBUTION} maxZoom={19} crossOrigin="anonymous" />
      <TileLayer url={ESRI_LABELS_URL} attribution="" maxZoom={19} crossOrigin="anonymous" />
      <ClickToPick onPick={onPick} />
      {boundaryRings.map((ring, index) => (
        <Polygon
          key={index}
          positions={ring}
          pathOptions={{ color: '#facc15', fillColor: '#facc15', fillOpacity: 0.05, opacity: 1, weight: 3 }}
        />
      ))}
      {marker && <Marker position={[marker.lat, marker.lng]} icon={pickPin} />}
      <FlyToMarker marker={marker} />
    </MapContainer>
  );
}
