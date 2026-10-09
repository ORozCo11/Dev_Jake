// On-demand versions of the heavy visual components. Leaflet (~150 KB min)
// and Recharts (~380 KB min) are only downloaded the first time a map or a
// chart actually renders, instead of with every workspace page. Import from
// here, not from the component files directly.
import { lazy, Suspense } from 'react';

const LocationDensityMapImpl = lazy(() => import('./LocationDensityMap'));
const VehicleLocationMapImpl = lazy(() => import('./VehicleLocationMap'));
const AddLocationMapImpl = lazy(() => import('./AddLocationMap'));
const BoundaryPreviewMapImpl = lazy(() => import('./BoundaryPreviewMap'));

const chart = (name) => lazy(() => import('./charts').then((m) => ({ default: m[name] })));
const DonutChartImpl = chart('DonutChart');
const SolidPieChartImpl = chart('SolidPieChart');
const HorizontalBarChartImpl = chart('HorizontalBarChart');
const ColumnChartImpl = chart('ColumnChart');
const StackedBarChartImpl = chart('StackedBarChart');

function MapFallback() {
  return (
    <div className="lazy-map-fallback" role="status" aria-live="polite">
      <span className="lazy-fallback-spinner" aria-hidden="true" />
      <span>Loading map…</span>
    </div>
  );
}

function ChartFallback() {
  return <div className="lazy-chart-fallback" role="status" aria-label="Loading chart" />;
}

export function LocationDensityMap(props) {
  return <Suspense fallback={<MapFallback />}><LocationDensityMapImpl {...props} /></Suspense>;
}
export function VehicleLocationMap(props) {
  return <Suspense fallback={<MapFallback />}><VehicleLocationMapImpl {...props} /></Suspense>;
}
export function AddLocationMap(props) {
  return <Suspense fallback={<MapFallback />}><AddLocationMapImpl {...props} /></Suspense>;
}
export function BoundaryPreviewMap(props) {
  return <Suspense fallback={<MapFallback />}><BoundaryPreviewMapImpl {...props} /></Suspense>;
}

export function DonutChart(props) {
  return <Suspense fallback={<ChartFallback />}><DonutChartImpl {...props} /></Suspense>;
}
export function SolidPieChart(props) {
  return <Suspense fallback={<ChartFallback />}><SolidPieChartImpl {...props} /></Suspense>;
}
export function HorizontalBarChart(props) {
  return <Suspense fallback={<ChartFallback />}><HorizontalBarChartImpl {...props} /></Suspense>;
}
export function ColumnChart(props) {
  return <Suspense fallback={<ChartFallback />}><ColumnChartImpl {...props} /></Suspense>;
}
export function StackedBarChart(props) {
  return <Suspense fallback={<ChartFallback />}><StackedBarChartImpl {...props} /></Suspense>;
}
