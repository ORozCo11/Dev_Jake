import { useRef, useState } from 'react';
import useDepsChanged from './useDepsChanged';
import useDialogA11y from './useDialogA11y';
import useMediaQuery from './useMediaQuery';

export const DRAWER_QUERY = '(max-width: 768px)';
export const RAIL_QUERY = '(max-width: 1100px)';

// Shared sidebar behaviour for both workspaces:
// - <=768px: off-canvas drawer (hamburger opens it; backdrop, close button,
//   focus trap and Escape close it; any navigation closes it),
// - 769-1100px: icon-only rail (CSS), same as a manual collapse,
// - wider: full sidebar, collapsible by the user.
// `navKey` should change whenever the user navigates (module/tab/path).
export default function useResponsiveNav(navKey) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const isDrawer = useMediaQuery(DRAWER_QUERY);
  const isNarrow = useMediaQuery(RAIL_QUERY);
  const isRail = !isDrawer && (isCollapsed || isNarrow);
  const sidebarRef = useRef(null);

  if (useDepsChanged([navKey, isDrawer]) && isDrawerOpen) setIsDrawerOpen(false);
  useDialogA11y(sidebarRef, { open: isDrawer && isDrawerOpen, onClose: () => setIsDrawerOpen(false) });

  const toggle = () => {
    if (isDrawer) setIsDrawerOpen((open) => !open);
    else setIsCollapsed((collapsed) => !collapsed);
  };
  const close = () => setIsDrawerOpen(false);
  const toggleLabel = isDrawer
    ? (isDrawerOpen ? 'Close navigation' : 'Open navigation')
    : (isCollapsed ? 'Expand sidebar' : 'Collapse sidebar');

  return {
    isCollapsed,
    isDrawer,
    isDrawerOpen,
    isRail,
    close,
    toggle,
    toggleButtonProps: {
      'aria-label': toggleLabel,
      'aria-controls': 'workspace-sidebar',
      'aria-expanded': isDrawer ? isDrawerOpen : !isRail,
      title: toggleLabel,
      onClick: toggle,
    },
    workspaceClassName: `workspace${isCollapsed && !isDrawer ? ' sidebar-collapsed' : ''}`,
    sidebarProps: {
      id: 'workspace-sidebar',
      ref: sidebarRef,
      className: [
        'sidebar',
        isCollapsed && !isDrawer ? 'collapsed' : '',
        isDrawer ? 'is-drawer' : '',
        isDrawer && isDrawerOpen ? 'is-open' : '',
      ].filter(Boolean).join(' '),
      // A closed drawer is off-screen: keep it out of the tab order and the
      // accessibility tree too.
      inert: isDrawer && !isDrawerOpen,
      role: isDrawer && isDrawerOpen ? 'dialog' : undefined,
      'aria-modal': isDrawer && isDrawerOpen ? 'true' : undefined,
      'aria-label': isDrawer ? 'Navigation' : undefined,
      tabIndex: isDrawer ? -1 : undefined,
    },
  };
}
