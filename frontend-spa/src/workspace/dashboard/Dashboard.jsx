import { useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import api from '../../api/axios';
import { groupLocationRowsByHub } from '../../data/paknaanLocationDensity';
import TextType from '../../components/TextType';
import { ColumnChart, DonutChart, HorizontalBarChart } from '../../components/lazy';
import Modal from '../components/Modal';
import { ChartLegend } from '../components/ui';
import { ACTION_QUEUE_META, buildLocalGreeting, dashboardMetricValue, dashboardRoleLabel } from '../lib/dashboard';
import { clampPercent, formatForecastDate } from '../lib/format';
import { hasRole } from '../lib/permissions';
import { CAPABILITY_STATE_LABEL, CONDITION_STAT_CARDS } from '../lib/statCards';
import { READINESS_BADGE, isScheduleOverdue } from '../lib/workflow';
import { CapabilityImpactCard, CriticalityWatchCard } from '../vehicles/VehicleProfilePage';

export function ActionQueueRow({ item, basePath, onNavigate, onGoToSchedules }) {
  const meta = ACTION_QUEUE_META[item.type] ?? ACTION_QUEUE_META.issue_pending;
  const goTo = () => (meta.route ? onNavigate(meta.route(basePath, item.id)) : onGoToSchedules());
  return (
    <button
      type="button"
      onClick={goTo}
      className="action-queue-row"
      style={{ '--aq-color': meta.color }}
    >
      <span className="action-queue-row-icon"><Icon name={meta.icon} size={15} /></span>
      <span className="action-queue-row-body">
        <span className="action-queue-row-label">{item.label}</span>
        {item.vehicle_name && <span className="action-queue-row-vehicle">{item.vehicle_name}</span>}
      </span>
      {item.severity && <span className="action-queue-row-severity">{item.severity}</span>}
      <Icon name="chevronRight" size={14} className="action-queue-row-chevron" />
    </button>
  );
}

// A mechanic's personal task list — the counterpart to the Admin's Action
// Queue, but scoped to "what's assigned to ME" instead of "what needs an
// Admin decision". Same visual language (reuses .action-queue-* styles) so
// it reads as part of the same "here's what to do" pattern on the dashboard.
export function MyScheduledWorkRow({ item, onClick }) {
  const overdue = isScheduleOverdue(item);
  return (
    <button
      type="button"
      onClick={onClick}
      className="action-queue-row"
      style={{ '--aq-color': overdue ? '#b91c1c' : '#0369a1' }}
    >
      <span className="action-queue-row-icon"><Icon name="wrench" size={15} /></span>
      <span className="action-queue-row-body">
        <span className="action-queue-row-label">{item.maintenance_type}</span>
        {item.vehicle && <span className="action-queue-row-vehicle">{item.vehicle.vehicle_name}</span>}
      </span>
      <span className="action-queue-row-severity">{overdue ? 'OVERDUE' : item.scheduled_date}</span>
      <Icon name="chevronRight" size={14} className="action-queue-row-chevron" />
    </button>
  );
}

// Lightweight read-only popup — no form/notice machinery like FormModal,
// just the same modal-overlay/modal-box chrome so it looks consistent with
// every other modal in the app.
export function DashboardListModal({ title, tag, onClose, children }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      bodyClassName="dashboard-list-modal-body"
      beforeBody={tag && <div className="dashboard-list-modal-tag">{tag}</div>}
    >
      {children}
    </Modal>
  );
}

// Shared row for both the Emergency Readiness modal and the compact
// "Readiness by Vehicle Type" dashboard panel — a status dot + fill bar so
// which categories are covered is readable at a glance, not just from text.
export function ReadinessRow({ r }) {
  const verifiedReady = typeof r.verified_ready === 'number' ? r.verified_ready : r.ready;
  const unverified = r.ready - verifiedReady;
  const state = verifiedReady > 0 ? 'ready' : r.ready > 0 ? 'unverified' : 'none';
  const pct = r.total > 0 ? Math.max(4, Math.round((verifiedReady / r.total) * 100)) : 0;

  return (
    <div className={`emergency-readiness-row is-${state}`}>
      <span className={`emergency-readiness-row-dot is-${state}`} />
      <div className="emergency-readiness-row-main">
        <span className="emergency-readiness-row-name">{r.category}</span>
        <span className="emergency-readiness-row-detail">
          {r.ready} available
          {unverified > 0 && <> · <span className="emergency-readiness-row-unverified">{unverified} unverified</span></>}
        </span>
      </div>
      <div className="emergency-readiness-row-stat">
        <span className={`emergency-readiness-row-tag${verifiedReady > 0 ? ' is-ready' : ''}`}>
          {verifiedReady}/{r.total} READY
        </span>
        <span className="emergency-readiness-row-bar">
          <span className={`emergency-readiness-row-bar-fill is-${state}`} style={{ width: `${pct}%` }} />
        </span>
      </div>
    </div>
  );
}

export function DashboardMicroMetric({ icon, label, value, tone = 'neutral', onClick }) {
  const content = (
    <>
      <span><Icon name={icon} size={15} /></span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`dashboard-micro-metric is-${tone} is-clickable`} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={`dashboard-micro-metric is-${tone}`}>{content}</div>;
}

export function DashboardSignalCard({ icon, label, value, detail, tone = 'neutral', meter = 0, onClick }) {
  const content = (
    <>
      <div className="dashboard-signal-card-head">
        <span className="dashboard-signal-card-icon"><Icon name={icon} size={16} /></span>
        <span>{label}</span>
        {onClick && <Icon name="chevronRight" size={14} className="dashboard-signal-card-chevron" />}
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
      <span className="dashboard-signal-meter" aria-hidden="true">
        <span style={{ width: `${clampPercent(meter)}%` }} />
      </span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`dashboard-signal-card is-${tone}`} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <article className={`dashboard-signal-card is-${tone}`}>{content}</article>;
}

export function DashboardStatusStrip({ rows }) {
  return (
    <div className="dashboard-status-strip">
      {rows.map((row) => (
        <div key={row.label} style={{ '--strip-color': row.color }}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}

const formatClock = (date) => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// Shown above everything else when nothing in the fleet is verified ready —
// the single most important fact on the dashboard for an emergency service.
function NoReadyUnitAlert({ available, total, onReview }) {
  return (
    <section className="dashboard-no-ready-alert full-span" role="alert">
      <span className="dashboard-no-ready-alert-icon" aria-hidden="true"><Icon name="alert" size={22} /></span>
      <div>
        <strong>No vehicle is verified ready to respond</strong>
        <p>
          {available > 0
            ? `${available} of ${total} vehicles are available, but none has passed a readiness check in the last 24 hours.`
            : `None of the ${total} vehicles is available right now.`}
        </p>
      </div>
      {onReview && <button type="button" className="primary-button" onClick={onReview}>Review readiness</button>}
    </section>
  );
}

export function Dashboard({ data, hubs = null, user, basePath, onNavigate, onGoToSchedules, onGoToModule, updatedAt = null }) {
  const [weather, setWeather] = useState(null);
  const [greeting, setGreeting] = useState(() => buildLocalGreeting(user?.name));
  const [greetingRole, setGreetingRole] = useState(() => dashboardRoleLabel(user?.role));
  const [now, setNow] = useState(() => new Date());
  // Dashboard = summary, not the complete list — Action Queue, Emergency
  // Readiness, and Risk & Readiness Watch each collapse to one glance-able
  // card; tapping one opens its full list in a popup instead of the list
  // living permanently on the page. null = no modal open.
  const [openDashboardModal, setOpenDashboardModal] = useState(null);

  useEffect(() => {
    // Displayed time is minute-precision (no seconds), so a 1s tick would
    // just be wasted re-renders — once a minute is enough to stay current.
    const interval = setInterval(() => setNow(new Date()), 60000);

    // Fetch Mandaue City, Cebu, Philippines (10.3446, 123.9392) weather
    fetch('https://api.open-meteo.com/v1/forecast?latitude=10.3446&longitude=123.9392&current=temperature_2m,relative_humidity_2m,weather_code')
      .then((res) => res.json())
      .then((resData) => {
        if (resData && resData.current) {
          const temp = Math.round(resData.current.temperature_2m);
          const code = resData.current.weather_code;
          const humidity = resData.current.relative_humidity_2m;
          
          let desc = 'Sunny';
          let icon = '☀️';
          
          if (code === 0) { desc = 'Clear Sky'; icon = '☀️'; }
          else if ([1, 2, 3].includes(code)) { desc = 'Partly Cloudy'; icon = '⛅'; }
          else if ([45, 48].includes(code)) { desc = 'Foggy'; icon = '🌫️'; }
          else if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) { desc = 'Rainy'; icon = '🌧️'; }
          else if ([95, 96, 99].includes(code)) { desc = 'Thunderstorm'; icon = '⛈️'; }
          
          setWeather({ temp, desc, icon, humidity });
        }
      })
      .catch(() => {
        // No reading is better than a made-up one: hide the widget.
        setWeather(null);
      });

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadGreeting = async () => {
      try {
        const response = await api.get('/greeting');
        if (!cancelled) {
          setGreeting(response.data.greeting ?? buildLocalGreeting(user?.name));
          setGreetingRole(response.data.role_label ?? dashboardRoleLabel(user?.role));
        }
      } catch {
        if (!cancelled) {
          setGreeting(buildLocalGreeting(user?.name));
          setGreetingRole(dashboardRoleLabel(user?.role));
        }
      }
    };

    loadGreeting();
    const interval = setInterval(loadGreeting, 60000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.name, user?.role]);

  if (!data) {
    return <p className="empty-state">No dashboard data available yet.</p>;
  }

  const metricValue = (label) => dashboardMetricValue(data.metrics, label);
  const totalVehicles = metricValue('Total Vehicles');
  const availableVehicles = metricValue('Available Vehicles');
  const underMaintenanceVehicles = metricValue('Vehicles Under Maintenance');
  const inactiveVehicles = metricValue('Inactive Vehicles');
  const reportedIssues = metricValue('Reported Issues');
  const upcomingMaintenance = metricValue('Upcoming Maintenance');
  const overdueMaintenanceCount = metricValue('Overdue Maintenance');
  const maintenanceExpenses = data.metrics.find((metric) => metric.label === 'Total Maintenance Expenses')?.value ?? '0';

  // Re-group raw location rows into the same hubs the map shows, so the
  // "Vehicles by Location" chart always matches the map's pins.
  const locationsByHub = groupLocationRowsByHub(data.vehicles_by_location ?? [], hubs);

  // Availability Forecast — vehicles currently out and when they're due back.
  const forecast = data.availability_forecast ?? { available_now: availableVehicles, under_maintenance: [] };
  const forecastOut = forecast.under_maintenance ?? [];
  const overdueSchedules = data.overdue_schedules ?? [];

  // Gap 1 — readiness/coverage by vehicle type; Gap 2 — preventive watch.
  const readiness = data.readiness ?? [];
  const noCoverage = readiness.filter((r) => r.no_coverage);
  const fleetSummary = data.fleet_readiness_summary ?? null;
  const preventiveWatch = data.preventive_watch ?? [];
  // Gap A — readiness watch; Gap B — fragility; Gap C — failure patterns.
  const readinessWatch = data.readiness_watch ?? [];
  const criticalityWatch = data.criticality_watch ?? [];
  // Final feature pass — Fleet Capability & Readiness Impact: the same
  // signals above, rolled up to "which emergency capability is at risk?".
  const capabilityImpact = data.capability_impact ?? [];
  const fragility = data.fragility ?? [];
  const failurePatterns = data.failure_patterns ?? [];

  // Action Queue — everything currently waiting on an Admin decision,
  // ranked and pulled from across the whole system, so the dashboard
  // answers "what do I do right now" instead of just "what's currently
  // true". Admin-only (the backend already returns [] for other roles).
  const actionQueue = data.action_queue ?? [];
  const criticalActionCount = actionQueue.filter((item) => item.severity === 'Critical').length;

  // My Scheduled Work — a mechanic's own assigned schedules, surfaced right
  // on their dashboard instead of only living in the shared schedule table.
  const myScheduledWork = data.my_scheduled_work ?? [];

  // Fleet health (Good/Needs Inspection/Needs Repair) — a different
  // signal than Available/Under Maintenance/Inactive, which already have
  // their own KPI tiles just below this card, so this donut wouldn't just
  // be re-drawing the same three numbers. Colors match the same condition
  // badges used everywhere else (Condition Monitoring's stat cards, etc).
  const vehicleCondition = (data.vehicles_by_condition ?? []).map((row) => ({
    label: row.label,
    value: row.value,
    color: CONDITION_STAT_CARDS.find((c) => c.key === row.label)?.color ?? '#94a3b8',
  }));
  const goodConditionCount = vehicleCondition.find((c) => c.label === 'Good')?.value ?? 0;
  const goodConditionRate = totalVehicles ? Math.round((goodConditionCount / totalVehicles) * 100) : 0;

  const operationalTotal = fleetSummary?.operational_total ?? totalVehicles;
  const verifiedReady = fleetSummary?.verified_ready ?? Math.max(0, availableVehicles - readinessWatch.length);
  const readinessRate = operationalTotal ? clampPercent((verifiedReady / operationalTotal) * 100) : 0;
  const noVerifiedReady = operationalTotal > 0 && verifiedReady === 0;
  const atRiskCount = noCoverage.length + readinessWatch.length + fragility.length + forecastOut.length + preventiveWatch.length + overdueMaintenanceCount;
  const notReadyVehicles = Math.max(0, totalVehicles - availableVehicles);
  const opsTone = notReadyVehicles === 0 ? 'ok' : availableVehicles === 0 ? 'alert' : 'warn';
  const maintenanceLoad = underMaintenanceVehicles + upcomingMaintenance + overdueMaintenanceCount;
  const statusSegments = [
    { label: 'Available', value: availableVehicles, color: '#16a34a' },
    { label: 'In shop', value: underMaintenanceVehicles, color: '#d97706' },
    { label: 'Inactive', value: inactiveVehicles, color: '#64748b' },
  ];
  const operationsQueue = [
    { label: 'Issues', value: reportedIssues, color: '#ef4444' },
    { label: 'Upcoming', value: upcomingMaintenance, color: '#f59e0b' },
    { label: 'Overdue', value: overdueMaintenanceCount, color: '#dc2626' },
    { label: 'Available', value: availableVehicles, color: '#22c55e' },
  ];
  const topFailurePattern = failurePatterns[0];
  const visibleReadiness = readiness.slice(0, 5);
  const visibleLocationRows = locationsByHub.slice(0, 4);
  const visibleTypeRows = (data.vehicles_by_type ?? []).slice(0, 5);
  const isAdminDashboard = hasRole(user, 'Admin');
  const isMaintenanceDashboard = hasRole(user, 'Maintenance Personnel') && !isAdminDashboard;
  // Phase A4 — one departure away from an orphaned barangay (nobody left
  // who can manage users, vehicles, or approvals). GuardsLastAdmin blocks
  // that departure from happening through deactivate/role-change, but not
  // e.g. this Admin simply leaving with no successor ever promoted — this
  // is the "before it happens" half of that protection.
  const primaryActionCount = isAdminDashboard
    ? actionQueue.length
    : isMaintenanceDashboard
      ? myScheduledWork.length
      : reportedIssues;
  const primaryActionLabel = isAdminDashboard
    ? (actionQueue[0]?.label ?? 'No urgent action')
    : isMaintenanceDashboard
      ? (myScheduledWork[0]?.maintenance_type ?? 'Nothing assigned')
      : (reportedIssues > 0 ? 'Open reports need follow-up' : 'No open reported issues');
  const primaryActionTitle = isAdminDashboard ? 'Action Queue' : isMaintenanceDashboard ? 'My Work' : 'My Reports';
  const primaryActionIcon = isMaintenanceDashboard ? 'wrench' : reportedIssues > 0 ? 'alert' : 'checkCircle';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Custodian / Maintenance Personnel get their own, leaner dashboard: their
  // own queues first, then only the fleet context their job actually uses.
  // The fleet-wide analytics (expenses, risk watch, sites/types, maintenance
  // load) are Admin's — the backend doesn't even send those numbers to these
  // roles, so they used to render as misleading zeroes.
  if (!isAdminDashboard) {
    const badges = data.badge_counts ?? {};
    const isCustodianView = hasRole(user, 'Custodian');
    const needsCheck = readinessWatch.slice(0, 5);
    const toneFor = (n, hot = 'warn') => (n > 0 ? hot : 'ok');
    const quick = [];
    if (isCustodianView) {
      quick.push(
        { icon: 'checkCircle', label: 'To Verify', value: badges.ticketVerifications ?? 0, go: () => onGoToModule('ticketVerifications', []) },
        { icon: 'alert', label: 'My Open Reports', value: badges.issues ?? 0, go: () => onGoToModule('issues', []) },
      );
    }
    if (isMaintenanceDashboard) {
      quick.push(
        { icon: 'wrench', label: 'Work Orders', value: badges.ticketWorkOrders ?? 0, go: () => onGoToModule('ticketWorkOrders', []) },
        { icon: 'calendar', label: 'My Schedule', value: myScheduledWork.length, go: onGoToSchedules },
        { icon: 'alert', label: 'Needs Attention', value: metricValue('Vehicles Needing Attention'), go: () => onGoToModule('vehicles', []) },
      );
    }

    return (
      <div className="dashboard-grid dashboard-grid-smart">
        {noVerifiedReady && <NoReadyUnitAlert available={availableVehicles} total={operationalTotal} onReview={() => onGoToModule('vehicles', [])} />}
        <section className={`dashboard-command-center full-span is-${opsTone}`}>
          <div className="dashboard-command-copy">
            <span className="dashboard-command-role">{greetingRole}</span>
            <TextType
              key={greeting}
              as="h2"
              text={[greeting]}
              typingSpeed={150}
              pauseDuration={1500}
              loop={false}
              showCursor={true}
              cursorCharacter="|"
            />
            <p>{dateStr || 'Today'}</p>
          </div>

          <div className="dashboard-ready-split">
            <div className="dashboard-ready-stat" style={{ '--ready-pct': `${totalVehicles ? (availableVehicles / totalVehicles) * 100 : 0}%` }}>
              <span className="dashboard-hologram-scan" />
              <div className="dashboard-ready-stat-inner">
                <div className="dashboard-ready-row is-ready">
                  <strong>{availableVehicles}</strong>
                  <span>Available</span>
                </div>
                <div className="dashboard-ready-row is-not-ready">
                  <strong>{notReadyVehicles}</strong>
                  <span>Unavailable</span>
                </div>
              </div>
            </div>
          </div>

          <div className="dashboard-command-side">
            <div className="dashboard-live-chips">
              <div>
                <span>Local time</span>
                <strong>{timeStr}</strong>
                {updatedAt && <small>Data updated {formatClock(updatedAt)}</small>}
              </div>
              {weather && (
                <div>
                  <span>Mandaue City, Cebu</span>
                  <strong><span className="dashboard-weather-mark">{weather.icon}</span>{weather.temp}C</strong>
                  <small>{weather.desc} / {weather.humidity}% humidity</small>
                </div>
              )}
            </div>
            <div className="dashboard-command-mini-grid">
              {quick.slice(0, 4).map((q) => (
                <DashboardMicroMetric key={q.label} icon={q.icon} label={q.label} value={q.value} tone={toneFor(q.value)} onClick={q.go} />
              ))}
            </div>
          </div>
        </section>

        {isMaintenanceDashboard && (
          <section className="panel col-span-7 action-queue-panel dashboard-lean-panel">
            <div className="panel-header-bar">
              <h3><Icon name="wrench" size={16} /> My Scheduled Work</h3>
              {myScheduledWork.length > 0 && <span className="area-chart-tag">{myScheduledWork.length} assigned to you</span>}
            </div>
            {myScheduledWork.length === 0 ? (
              <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> Nothing scheduled for you right now.</p>
            ) : (
              <div className="action-queue-list action-queue-list-compact">
                {myScheduledWork.map((item) => (
                  <MyScheduledWorkRow key={item.schedule_id} item={item} onClick={onGoToSchedules} />
                ))}
              </div>
            )}
          </section>
        )}

        {isCustodianView && (
          <section className="panel col-span-7 dashboard-lean-panel">
            <div className="panel-header-bar">
              <h3><Icon name="checkCircle" size={16} /> Needs a Readiness Check</h3>
              {readinessWatch.length > 0 && <span className="area-chart-tag">{readinessWatch.length} vehicle{readinessWatch.length === 1 ? '' : 's'}</span>}
            </div>
            {needsCheck.length === 0 ? (
              <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> Every available vehicle has a current readiness check.</p>
            ) : (
              <div className="risk-watch-col">
                {needsCheck.map((r) => (
                  <button
                    key={r.vehicle_id}
                    type="button"
                    className={`risk-watch-item risk-watch-item-clickable${r.state === 'not_ready' ? ' is-critical' : ''}`}
                    onClick={() => onNavigate(`${basePath}/vehicles/${r.vehicle_id}`)}
                  >
                    <span className={`risk-watch-item-dot${r.state === 'not_ready' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{r.vehicle_name}</span>
                        <span className={`risk-watch-tag${r.state === 'not_ready' ? ' is-critical' : ''}`}>
                          {(READINESS_BADGE[r.state]?.label ?? r.state).toUpperCase()}
                        </span>
                      </span>
                      <span className="risk-watch-item-sub">{r.category ?? '—'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {readinessWatch.length > needsCheck.length && (
              <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.78rem' }}>+ {readinessWatch.length - needsCheck.length} more — open Vehicles to see them all.</p>
            )}
          </section>
        )}

        <CriticalityWatchCard items={criticalityWatch} onNavigate={onNavigate} basePath={basePath} />
        <CapabilityImpactCard items={capabilityImpact} onNavigate={onNavigate} basePath={basePath} />

        <section className="panel col-span-5 dashboard-lean-panel">
          <div className="panel-header-bar">
            <h3>Fleet Condition</h3>
            <span className="area-chart-tag">{goodConditionRate}% in good condition</span>
          </div>
          <div className="fleet-status-compact">
            <div className="donut-chart-small">
              <DonutChart centerLabel={totalVehicles} centerSubLabel="Vehicles" segments={vehicleCondition} />
            </div>
            <div className="fleet-status-legend-col">
              <ChartLegend rows={vehicleCondition} />
            </div>
          </div>
        </section>

        {/* Same vehicle-condition data as the donut above, as a bar graph —
            the donut reads the share (percent in good condition), this
            reads the actual counts per bucket at a glance. */}
        <section className="panel col-span-7 dashboard-lean-panel">
          <div className="panel-header-bar">
            <h3>Fleet Condition by Count</h3>
          </div>
          <ColumnChart rows={vehicleCondition} />
        </section>
      </div>
    );
  }

  return (
    <div className="dashboard-grid dashboard-grid-smart">
      {noVerifiedReady && <NoReadyUnitAlert available={availableVehicles} total={operationalTotal} onReview={readiness.length > 0 ? () => setOpenDashboardModal('emergencyReadiness') : undefined} />}
      <section className={`dashboard-command-center full-span is-${opsTone}`}>
        <div className="dashboard-command-copy">
          <span className="dashboard-command-role">{greetingRole}</span>
          <TextType
            key={greeting}
            as="h2"
            text={[greeting]}
            typingSpeed={150}
            pauseDuration={1500}
            loop={false}
            showCursor={true}
            cursorCharacter="|"
          />
          <p>{dateStr || 'Today'}</p>
          <div className="dashboard-command-pills">
            <button type="button" onClick={() => onGoToModule('vehicles', [])}>{totalVehicles} fleet units</button>
            <button type="button" onClick={() => onGoToModule('locations', [])}>{locationsByHub.length} active sites</button>
            <button type="button" onClick={() => onGoToModule('categories', [])}>{data.vehicles_by_type?.length ?? 0} vehicle types</button>
          </div>
        </div>

        <div className="dashboard-ready-split">
          <div className="dashboard-ready-stat" style={{ '--ready-pct': `${totalVehicles ? (availableVehicles / totalVehicles) * 100 : 0}%` }}>
            <span className="dashboard-hologram-scan" />
            <div className="dashboard-ready-stat-inner">
              <div className="dashboard-ready-row is-ready">
                <strong>{availableVehicles}</strong>
                <span>Available</span>
              </div>
              <div className="dashboard-ready-row is-not-ready">
                <strong>{notReadyVehicles}</strong>
                <span>Unavailable</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-command-side">
          <div className="dashboard-live-chips">
            <div>
              <span>Local time</span>
              <strong>{timeStr}</strong>
              {updatedAt && <small>Data updated {formatClock(updatedAt)}</small>}
            </div>
            {weather && (
              <div>
                <span>Mandaue City, Cebu</span>
                <strong><span className="dashboard-weather-mark">{weather.icon}</span>{weather.temp}C</strong>
                <small>{weather.desc} / {weather.humidity}% humidity</small>
              </div>
            )}
          </div>
          <div className="dashboard-command-mini-grid">
            <DashboardMicroMetric icon="vehicle" label="Available" value={availableVehicles} tone="ok" onClick={() => onGoToModule('vehicles', ['Available'])} />
            <DashboardMicroMetric icon="wrench" label="In Shop" value={underMaintenanceVehicles} tone="warn" onClick={() => onGoToModule('vehicles', ['Under Maintenance'])} />
            <DashboardMicroMetric icon="alert" label="Issues" value={reportedIssues} tone={reportedIssues > 0 ? 'alert' : 'ok'} onClick={() => onGoToModule('issues', [])} />
            <DashboardMicroMetric icon="calendar" label="Overdue" value={overdueMaintenanceCount} tone={overdueMaintenanceCount > 0 ? 'alert' : 'neutral'} onClick={onGoToSchedules} />
          </div>
        </div>
      </section>

      <section className="dashboard-signal-grid full-span" aria-label="Dashboard signals">
        <DashboardSignalCard
          icon={primaryActionIcon}
          label={primaryActionTitle}
          value={primaryActionCount === 0 ? 'Clear' : primaryActionCount}
          detail={primaryActionLabel}
          tone={criticalActionCount > 0 ? 'alert' : primaryActionCount > 0 ? 'warn' : 'ok'}
          meter={primaryActionCount > 0 ? Math.min(100, primaryActionCount * 18) : 100}
          onClick={isAdminDashboard ? () => setOpenDashboardModal('actionQueue') : undefined}
        />
        <DashboardSignalCard
          icon="checkCircle"
          label="Emergency Coverage"
          value={operationalTotal ? `${verifiedReady}/${operationalTotal}` : '0/0'}
          detail={noCoverage.length > 0 ? `No coverage: ${noCoverage.map((r) => r.category).join(', ')}` : `${readinessRate}% verified ready`}
          tone={noCoverage.length > 0 ? 'alert' : readinessRate >= 75 ? 'ok' : 'warn'}
          meter={readinessRate}
          onClick={readiness.length > 0 ? () => setOpenDashboardModal('emergencyReadiness') : undefined}
        />
        <DashboardSignalCard
          icon="flag"
          label="Risk Watch"
          value={atRiskCount === 0 ? 'Stable' : atRiskCount}
          detail={fragility.length > 0 ? `${fragility.length} no-backup categories` : `${readinessWatch.length} available but unverified`}
          tone={atRiskCount > 0 ? 'alert' : 'ok'}
          meter={atRiskCount > 0 ? Math.min(100, atRiskCount * 12) : 100}
          onClick={atRiskCount > 0 ? () => setOpenDashboardModal('riskWatch') : undefined}
        />
        <DashboardSignalCard
          icon="calendar"
          label="Maintenance Load"
          value={maintenanceLoad}
          detail={`${underMaintenanceVehicles} in shop / ${upcomingMaintenance} upcoming / ${overdueMaintenanceCount} overdue`}
          tone={overdueMaintenanceCount > 0 ? 'alert' : maintenanceLoad > 0 ? 'warn' : 'ok'}
          meter={totalVehicles ? Math.min(100, (maintenanceLoad / Math.max(totalVehicles, 1)) * 100) : 0}
          onClick={onGoToSchedules}
        />
      </section>

      <section className="dashboard-intelligence-grid full-span">
        <article className="dashboard-smart-panel dashboard-readiness-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Response Matrix</span>
              <h3>Readiness by Vehicle Type</h3>
            </div>
            <strong>{readinessRate}%</strong>
          </div>
          {readiness.length === 0 ? (
            <p className="empty-state">No vehicle types to show yet.</p>
          ) : (
            <div className="dashboard-readiness-compact-list">
              {visibleReadiness.map((r) => <ReadinessRow key={r.category} r={r} />)}
            </div>
          )}
          {readiness.length > visibleReadiness.length && (
            <button type="button" className="dashboard-inline-action" onClick={() => setOpenDashboardModal('emergencyReadiness')}>
              View all {readiness.length} types
            </button>
          )}
        </article>

        <article className="dashboard-smart-panel dashboard-condition-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Fleet Health</span>
              <h3>Condition and Status</h3>
            </div>
            <strong>{goodConditionRate}%</strong>
          </div>
          <div className="dashboard-condition-core">
            <div className="dashboard-condition-donut">
              <DonutChart centerLabel={totalVehicles} centerSubLabel="Vehicles" segments={vehicleCondition} />
            </div>
            <ChartLegend rows={vehicleCondition} />
          </div>
          <DashboardStatusStrip rows={statusSegments} />
        </article>

        <article className="dashboard-smart-panel dashboard-operations-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Operations Pulse</span>
              <h3>Workload Pressure</h3>
            </div>
            <strong title="Sum of maintenance costs recorded so far — unrecorded work is not included">
              {maintenanceExpenses}
              <small className="dashboard-smart-panel-head-note">recorded costs</small>
            </strong>
          </div>
          <ColumnChart rows={operationsQueue} />
          <p className="dashboard-panel-note">
            {topFailurePattern
              ? `${topFailurePattern.type} leads the last 12 months with ${topFailurePattern.count} case${topFailurePattern.count === 1 ? '' : 's'}.`
              : 'No recurring failure pattern logged yet.'}
          </p>
        </article>

        <article className="dashboard-smart-panel dashboard-distribution-matrix">
          <div className="dashboard-smart-panel-head">
            <div>
              <span>Fleet Distribution</span>
              <h3>Sites and Types</h3>
            </div>
            <strong>{totalVehicles}</strong>
          </div>
          <div className="dashboard-dual-bars">
            <div>
              <h4>Sites</h4>
              <HorizontalBarChart rows={visibleLocationRows} />
            </div>
            <div>
              <h4>Types</h4>
              <HorizontalBarChart rows={visibleTypeRows} />
            </div>
          </div>
        </article>
      </section>
      {hasRole(user, 'Maintenance Personnel') && (
        <section className="panel col-span-7 action-queue-panel">
          <div className="panel-header-bar">
            <h3><Icon name="wrench" size={16} /> My Scheduled Work</h3>
            {myScheduledWork.length > 0 && <span className="area-chart-tag">{myScheduledWork.length} assigned to you</span>}
          </div>
          {myScheduledWork.length === 0 ? (
            <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> Nothing scheduled for you right now.</p>
          ) : (
            <div className="action-queue-list action-queue-list-compact">
              {myScheduledWork.map((item) => (
                <MyScheduledWorkRow
                  key={item.schedule_id}
                  item={item}
                  onClick={onGoToSchedules}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {openDashboardModal === 'actionQueue' && (
        <DashboardListModal
          title="Action Queue"
          tag={actionQueue.length > 0 ? `${actionQueue.length} need${actionQueue.length === 1 ? 's' : ''} you` : undefined}
          onClose={() => setOpenDashboardModal(null)}
        >
          {actionQueue.length === 0 ? (
            <p className="action-queue-clear"><Icon name="checkCircle" size={16} /> All clear — nothing needs your attention right now.</p>
          ) : (
            <div className="action-queue-list">
              {actionQueue.map((item) => (
                <ActionQueueRow
                  key={`${item.type}-${item.id}`}
                  item={item}
                  basePath={basePath}
                  onNavigate={(path) => { setOpenDashboardModal(null); onNavigate(path); }}
                  onGoToSchedules={() => { setOpenDashboardModal(null); onGoToSchedules(); }}
                />
              ))}
            </div>
          )}
        </DashboardListModal>
      )}

      {openDashboardModal === 'emergencyReadiness' && (
        <DashboardListModal
          title="Emergency Readiness"
          tag={fleetSummary ? `${fleetSummary.verified_ready} of ${fleetSummary.operational_total} verified ready` : undefined}
          onClose={() => setOpenDashboardModal(null)}
        >
          <div className="emergency-readiness-rows">
            {readiness.map((r) => <ReadinessRow key={r.category} r={r} />)}
          </div>
          {fragility.length > 0 && fragility.length === readiness.length && (
            <p className="emergency-readiness-note">
              <Icon name="alert" size={13} /> Every emergency type has exactly one vehicle — no backup if any of the {readiness.length} goes down. Verify all {readiness.length} to clear this panel.
            </p>
          )}
          {noCoverage.length > 0 && (
            <p className="emergency-readiness-alert"><Icon name="alert" size={13} /> No coverage: {noCoverage.map((r) => r.category).join(', ')}</p>
          )}
        </DashboardListModal>
      )}

      {openDashboardModal === 'riskWatch' && (
        <DashboardListModal
          title="Risk & Readiness Watch"
          tag={fragility.length > 0 ? `${fragility.length} single point${fragility.length === 1 ? '' : 's'} of failure` : undefined}
          onClose={() => setOpenDashboardModal(null)}
        >
          <div className="risk-watch-columns">
            {criticalityWatch.some((r) => r.criticality !== 'Normal') && (
              <div className="risk-watch-col">
                <h4>Critical &amp; high-priority vehicles not ready</h4>
                {criticalityWatch.filter((r) => r.criticality !== 'Normal').map((r) => (
                  <div key={r.vehicle_id} className={`risk-watch-item${r.criticality === 'Critical' ? ' is-critical' : ''}`}>
                    <span className={`risk-watch-item-dot${r.criticality === 'Critical' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{r.vehicle_name}</span>
                        <span className={`risk-watch-tag${r.criticality === 'Critical' ? ' is-critical' : ''}`}>{r.criticality.toUpperCase()}</span>
                      </span>
                      <span className="risk-watch-item-sub">{r.category ?? '—'} · {r.reason}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {fragility.length > 0 && (
              <div className="risk-watch-col">
                <h4>No backup if it goes down</h4>
                {fragility.map((f) => (
                  <div key={f.category} className={`risk-watch-item${f.critical ? ' is-critical' : ''}`}>
                    <span className={`risk-watch-item-dot${f.critical ? ' is-critical' : ''}`} />
                    Only 1 {f.category}
                  </div>
                ))}
              </div>
            )}
            {capabilityImpact.length > 0 && (
              <div className="risk-watch-col">
                <h4>Capability impact by type</h4>
                {capabilityImpact.map((row) => (
                  <button
                    key={row.category}
                    type="button"
                    className={`risk-watch-item risk-watch-item-clickable${row.criticality === 'Critical' ? ' is-critical' : ''}`}
                    onClick={() => { setOpenDashboardModal(null); onNavigate(`${basePath}/vehicles`); }}
                  >
                    <span className={`risk-watch-item-dot${row.criticality === 'Critical' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{row.category}</span>
                        <span className={`risk-watch-tag${row.coverage_state === 'NO_COVERAGE' ? ' is-critical' : ''}`}>
                          {CAPABILITY_STATE_LABEL[row.coverage_state] ?? row.coverage_state}
                        </span>
                      </span>
                      <span className="risk-watch-item-sub">{row.ready}/{row.total} ready · {row.primary_reason ?? 'Based on current records.'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {readinessWatch.length > 0 && (
              <div className="risk-watch-col">
                <h4>Available, not verified</h4>
                {readinessWatch.map((r) => (
                  <button
                    key={r.vehicle_id}
                    type="button"
                    className={`risk-watch-item risk-watch-item-clickable${r.state === 'not_ready' ? ' is-critical' : ''}`}
                    onClick={() => { setOpenDashboardModal(null); onNavigate(`${basePath}/vehicles/${r.vehicle_id}`); }}
                  >
                    <span className={`risk-watch-item-dot${r.state === 'not_ready' ? ' is-critical' : ''}`} />
                    <div className="risk-watch-item-body">
                      <span className="risk-watch-item-top">
                        <span className="risk-watch-item-title">{r.vehicle_name}</span>
                        <span className={`risk-watch-tag${r.state === 'not_ready' ? ' is-critical' : ''}`}>
                          {(READINESS_BADGE[r.state]?.label ?? r.state).toUpperCase()}
                        </span>
                      </span>
                      <span className="risk-watch-item-sub">{r.category ?? '—'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {forecastOut.length === 0 && preventiveWatch.length === 0 && overdueSchedules.length === 0 ? (
            <p className="risk-watch-footer-ok">
              <Icon name="checkCircle" size={13} /> All vehicles available — nothing out for maintenance.
              <span className="area-chart-tag">{forecast.available_now} ready</span>
            </p>
          ) : (
            <div className="risk-watch-footer-list">
              {forecastOut.map((v) => (
                <div key={v.vehicle_id} className="risk-watch-footer-row">
                  <span>{v.vehicle_name}</span>
                  <span>{v.estimated_return_date ? `Ready by ${formatForecastDate(v.estimated_return_date)}` : 'No estimate yet'}</span>
                </div>
              ))}
              {(preventiveWatch.length > 0 ? preventiveWatch : overdueSchedules).map((s) => (
                <div key={s.schedule_id} className="risk-watch-footer-row">
                  <span>{s.vehicle_name ?? s.vehicle?.vehicle_name ?? '—'} · {s.maintenance_type}</span>
                  <span className={(s.state ? s.state === 'overdue' : true) ? 'is-overdue' : ''}>
                    {(s.state ? s.state === 'overdue' : true) ? 'OVERDUE' : 'DUE SOON'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </DashboardListModal>
      )}

    </div>
  );
}
