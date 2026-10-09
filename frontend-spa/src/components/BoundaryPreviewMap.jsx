import 'leaflet/dist/leaflet.css';
import { MapContainer, Polygon, TileLayer } from 'react-leaflet';

// Read-only preview of a candidate barangay outline (Super Admin boundary
// review). Loaded lazily via components/lazy.jsx.
export default function BoundaryPreviewMap({ center, rings, zoom = 14 }) {
  return (
    <MapContainer center={center} zoom={zoom} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
      <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {rings.map((ring, i) => (
        <Polygon key={i} positions={ring} pathOptions={{ color: '#d97706', fillColor: '#fbbf24', fillOpacity: 0.3 }} />
      ))}
    </MapContainer>
  );
}
