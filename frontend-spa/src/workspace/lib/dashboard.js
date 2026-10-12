import { firstName } from './format';

// Maps an Action Queue item's type to where clicking it should go, and what
// it should look like — one place to keep type/icon/route in sync.
export const ACTION_QUEUE_META = {
  issue_pending:           { icon: 'alert',       color: '#b45309', route: (basePath, id) => `${basePath}/issues/${id}` },
  subissue_needs_mechanic: { icon: 'wrench',      color: '#7c3aed', route: (basePath, id) => `${basePath}/tickets/${id}` },
  ticket_confirm:          { icon: 'checkCircle', color: '#9d174d', route: (basePath, id) => `${basePath}/tickets/${id}` },
  ticket_close:            { icon: 'checkCircle', color: '#15803d', route: (basePath, id) => `${basePath}/tickets/${id}` },
  recurring_fault_review:  { icon: 'undo',        color: '#c2410c', route: (basePath, id) => `${basePath}/tickets/${id}` },
  readiness_check:         { icon: 'search',      color: '#0369a1', route: (basePath, id) => `${basePath}/vehicles/${id}` },
  schedule_overdue:        { icon: 'wrench',      color: '#b91c1c', route: null },
};

export function buildLocalGreeting(name = 'User', date = new Date()) {
  const displayName = firstName(name);
  const hour = date.getHours();

  if (hour >= 5 && hour < 12) {
    return randomGreeting([
      `Rise and shine, ${displayName}!`,
      `A bright morning to you, ${displayName}!`,
      `Fresh start, ${displayName}! Let's keep the fleet moving.`,
      `Morning momentum is here, ${displayName}!`,
    ]);
  }

  if (hour === 12) {
    return randomGreeting([
      `Happy noon, ${displayName}!`,
      `Midday check-in, ${displayName}! The fleet is ready.`,
      `It's noon, ${displayName}! Keep the day rolling.`,
      `A steady noon to you, ${displayName}!`,
    ]);
  }

  if (hour >= 13 && hour < 15) {
    return randomGreeting([
      `A pleasant afternoon, ${displayName}!`,
      `Good energy this afternoon, ${displayName}!`,
      `Afternoon focus is on, ${displayName}!`,
      `Keep the dashboard sharp this afternoon, ${displayName}!`,
    ]);
  }

  if (hour >= 15 && hour < 18) {
    return randomGreeting([
      `It's late afternoon, ${displayName}!`,
      `Late afternoon focus, ${displayName}!`,
      `A strong late afternoon to you, ${displayName}!`,
      `The day is still moving, ${displayName}!`,
    ]);
  }

  if (hour >= 18 && hour < 22) {
    return randomGreeting([
      `A calm evening to you, ${displayName}!`,
      `Evening check-in, ${displayName}! The fleet is in view.`,
      `Good evening, ${displayName}! Keep things steady.`,
      `The evening shift is looking sharp, ${displayName}!`,
    ]);
  }

  return randomGreeting([
    `Working late, ${displayName}? The dashboard is ready.`,
    `Quiet night watch, ${displayName}!`,
    `Late-night focus, ${displayName}!`,
    `The fleet rests easier with you here, ${displayName}!`,
  ]);
}

export function randomGreeting(messages) {
  return messages[Math.floor(Math.random() * messages.length)];
}

export function dashboardRoleLabel(role = 'User') {
  const labels = {
    Admin: 'Administrator',
    Custodian: 'Custodian',
    'Maintenance Personnel': 'Maintenance',
  };

  return labels[role] ?? role;
}

export function dashboardMetricValue(metrics, label) {
  const rawValue = metrics.find((metric) => metric.label === label)?.value ?? 0;
  if (typeof rawValue === 'number') {
    return rawValue;
  }
  const parsed = Number.parseFloat(String(rawValue).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

