import Icon from '../components/Icon';

const navIcon = (name) => <Icon className="nav-icon" name={name} size={24} />;

export const moduleIcons = {
  dashboard: navIcon('grid'),
  vehicles: navIcon('vehicle'),
  categories: navIcon('list'),
  locations: navIcon('pin'),
  conditions: navIcon('checkCircle'),
  issues: navIcon('alert'),
  maintenance: navIcon('wrench'),
  maintenanceStatus: navIcon('checkCircle'),
  maintenanceLedger: navIcon('wrench'),
  schedules: navIcon('calendar'),
  tickets: navIcon('ticket'),
  ticketArchives: navIcon('archive'),
  reportOrPropose: navIcon('alert'),
  myTasks: navIcon('clipboard'),
  ticketPropose: navIcon('plus'),
  ticketInspections: navIcon('search'),
  ticketVerifications: navIcon('checkCircle'),
  ticketWorkOrders: navIcon('wrench'),
  workTracker: navIcon('grid'),
  histories: navIcon('clock'),
  reports: navIcon('document'),
  logs: navIcon('document'),
  users: navIcon('users'),
};
