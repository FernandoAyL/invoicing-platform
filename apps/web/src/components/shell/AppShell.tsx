import { Outlet, useLocation } from 'react-router-dom';
import type { CurrentUser } from '../../lib/api.ts';
import { color } from '../../theme.ts';
import { pageTitleFor } from './page-title.ts';
import { Sidebar } from './Sidebar.tsx';
import { Topbar } from './Topbar.tsx';

export interface AppShellProps {
  user: CurrentUser;
}

// Sidebar (238px) + topbar (60px) + scrolling canvas content, replacing the
// old plain-nav AuthedLayout. docs/design-system.md "App shell".
export function AppShell({ user }: AppShellProps) {
  const location = useLocation();

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100%',
        overflow: 'hidden',
        background: color.canvas,
      }}
    >
      <Sidebar user={user} />
      <div
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}
      >
        <Topbar pageTitle={pageTitleFor(location.pathname)} />
        <main style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          <Outlet context={user} />
        </main>
      </div>
    </div>
  );
}
