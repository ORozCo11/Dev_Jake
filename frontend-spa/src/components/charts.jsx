// Recharts-based replacements for the old hand-rolled SVG/CSS charts
// (stroke-dasharray rings, width-percentage divs). These give real axes,
// gridlines, and tooltips — the "business report" look — while keeping the
// same prop shapes the call sites in Workspace.jsx already pass in
// (segments: [{label, value, color}], rows: [{label, value, color}]).
import { useState } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LabelList,
} from 'recharts';

const BAR_CHART_PALETTE = ['#2563eb', '#f97316', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#eab308', '#ef4444'];

const AXIS_TICK_STYLE = { fill: 'var(--text-muted, #8f929a)', fontSize: 12, fontWeight: 600 };
const AXIS_LINE_STYLE = { stroke: 'var(--border, #25272d)' };
const GRID_STROKE = 'var(--border-subtle, #1b1d22)';
const EMPTY_SLICE_COLOR = 'var(--border-subtle, #1b1d22)';
// Every hover tooltip: drawn above sibling overlays (e.g. a donut's centre
// label) and never catches the pointer itself, so it can't flicker or block.
const TOOLTIP_PROPS = { wrapperStyle: { zIndex: 20, pointerEvents: 'none' }, isAnimationActive: false };

function ChartTooltipCard({ rows }) {
  return (
    <div className="chart-tooltip-card">
      {rows.map((row) => (
        <div className="chart-tooltip-row" key={row.label}>
          {row.color && <span className="chart-tooltip-dot" style={{ background: row.color }} />}
          <span className="chart-tooltip-label">{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}

function pieTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  return <ChartTooltipCard rows={[{ label: point.name, value: point.value, color: point.payload.color }]} />;
}

function barTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  return <ChartTooltipCard rows={[{ label: point.payload.label, value: point.value, color: point.payload.color }]} />;
}

// No floating tooltip here — on a ring this small it always lands on the
// centre label or the legend. Hovering a slice swaps the centre text to that
// slice instead ("6 · Good"), and it falls back to the total on leave.
export function DonutChart({ segments, centerLabel, centerSubLabel }) {
  const data = segments.filter((s) => s.value > 0);
  const pieData = data.length ? data : [{ label: 'None', value: 1, color: EMPTY_SLICE_COLOR }];
  const [activeIndex, setActiveIndex] = useState(null);
  const active = data.length && activeIndex != null ? data[activeIndex] : null;

  return (
    <div className="donut-chart">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="label"
            innerRadius="72%"
            outerRadius="100%"
            paddingAngle={data.length > 1 ? 2 : 0}
            stroke="none"
            isAnimationActive={false}
            onMouseEnter={(_, index) => setActiveIndex(index)}
            onMouseLeave={() => setActiveIndex(null)}
          >
            {pieData.map((seg, i) => (
              <Cell key={seg.label} fill={seg.color} fillOpacity={active && i !== activeIndex ? 0.45 : 1} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className={`donut-center${active ? ' is-active' : ''}`}>
        <strong style={active ? { color: 'var(--text-strong)' } : undefined}>{active ? active.value : centerLabel}</strong>
        <span>
          {active && <i className="donut-center-dot" style={{ background: active.color }} aria-hidden="true" />}
          {active ? active.label : centerSubLabel}
        </span>
      </div>
    </div>
  );
}

export function SolidPieChart({ segments, size = 170 }) {
  const data = segments.filter((s) => s.value > 0);
  const pieData = data.length ? data : [{ label: 'None', value: 1, color: EMPTY_SLICE_COLOR }];

  return (
    <div className="solid-pie-chart" style={{ width: size, maxWidth: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="label"
            innerRadius={0}
            outerRadius="100%"
            stroke="none"
            isAnimationActive={false}
          >
            {pieData.map((seg) => <Cell key={seg.label} fill={seg.color} />)}
          </Pie>
          {data.length > 0 && <Tooltip {...TOOLTIP_PROPS} content={pieTooltip} />}
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HorizontalBarChart({ rows = [] }) {
  if (!rows.length) {
    return <p className="empty-state">No graph data yet.</p>;
  }

  const data = rows.map((row, i) => ({
    label: row.label || 'Unassigned',
    value: Number(row.value) || 0,
    color: row.color || BAR_CHART_PALETTE[i % BAR_CHART_PALETTE.length],
  }));
  const height = Math.max(140, data.length * 38 + 24);

  return (
    <div className="horizontal-bars" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 34, bottom: 4, left: 0 }}>
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis type="number" tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="label" width={112} tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} />
          <Tooltip {...TOOLTIP_PROPS} cursor={{ fill: 'var(--surface-hover, #202126)' }} content={barTooltip} />
          <Bar dataKey="value" radius={[0, 6, 6, 0]} maxBarSize={22} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.label} fill={d.color} />)}
            <LabelList dataKey="value" position="right" style={{ fill: 'var(--text-strong, #fff8ef)', fontSize: 12, fontWeight: 700 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ColumnChart({ rows = [] }) {
  // Recharts' BarChart/XAxis/YAxis throw while computing an empty domain if
  // handed zero data points (e.g. the Dashboard's first render, before its
  // fetch resolves and vehicles_by_condition is still []) — same empty-state
  // guard HorizontalBarChart already has, just missing here until now.
  if (!rows.length) {
    return <p className="empty-state">No graph data yet.</p>;
  }

  const data = rows.map((row, i) => ({
    label: row.label,
    value: Number(row.value) || 0,
    color: row.color || BAR_CHART_PALETTE[i % BAR_CHART_PALETTE.length],
  }));

  return (
    <div className="column-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis dataKey="label" tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={false} interval={0} />
          <YAxis tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} allowDecimals={false} width={34} />
          <Tooltip {...TOOLTIP_PROPS} cursor={{ fill: 'var(--surface-hover, #202126)' }} content={barTooltip} />
          <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={46} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.label} fill={d.color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StackedBarChart({ title, segments }) {
  const visible = segments.filter((s) => Number(s.value) > 0);
  const row = { name: 'total', ...Object.fromEntries(visible.map((s) => [s.label, Number(s.value)])) };

  return (
    <div className="stacked-bar-chart">
      {title && <h3 className="stacked-bar-chart-title">{title}</h3>}
      <div className="stacked-bar">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={[row]} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
            <XAxis type="number" hide domain={[0, 'dataMax']} />
            <YAxis type="category" dataKey="name" hide />
            <Tooltip
              {...TOOLTIP_PROPS}
              cursor={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const tRows = payload.map((p) => ({
                  label: p.dataKey,
                  value: p.value,
                  color: visible.find((s) => s.label === p.dataKey)?.color,
                }));
                return <ChartTooltipCard rows={tRows} />;
              }}
            />
            {visible.length === 0 ? (
              <Bar dataKey="__empty" stackId="a" fill="var(--surface-2, #15161a)" isAnimationActive={false} />
            ) : visible.map((s) => (
              <Bar key={s.label} dataKey={s.label} stackId="a" fill={s.color} isAnimationActive={false}>
                <LabelList
                  dataKey={s.label}
                  position="center"
                  formatter={(v) => (v > 0 ? v : '')}
                  style={{ fill: '#ffffff', fontWeight: 700, fontSize: 13 }}
                />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="stacked-bar-legend">
        {segments.map((s) => (
          <span key={s.label} className="stacked-bar-legend-item">
            <span style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
