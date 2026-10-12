import Icon from './Icon';

// The backdrop + drawer header (wordmark and close button) shown only while
// the sidebar is a mobile drawer. Pair with useResponsiveNav().
export function SidebarBackdrop({ nav }) {
  if (!nav.isDrawer || !nav.isDrawerOpen) return null;
  return <div className="sidebar-backdrop" onClick={nav.close} aria-hidden="true" />;
}

export function SidebarDrawerHead({ nav }) {
  if (!nav.isDrawer) return null;
  return (
    <div className="sidebar-drawer-head">
      <span className="vms-wordmark vms-wordmark-sm">vms</span>
      <button type="button" className="sidebar-drawer-close" onClick={nav.close} aria-label="Close navigation">
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}
