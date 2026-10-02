import React, { useEffect } from 'react';
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { Bookmark, History, LayoutDashboard, Laptop, PanelsTopLeft, Settings } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SynkProvider, request, useSynk } from '@/entrypoints/options/state';
import { BookmarkPanel } from '@/entrypoints/options/bookmarks';
import { SessionPanel } from '@/entrypoints/options/sessions';
import { HistoryPanel } from '@/entrypoints/options/history';
import { HomePage } from '@/entrypoints/options/home';
import { DevicesPage, AddDevicePage } from '@/entrypoints/options/devices';
import { SetupWelcome, SetupJoin, SetupFirst, SetupCollections } from '@/entrypoints/options/setup';
import {
  SettingsPage,
  RecoveryPage,
  SecurityPage,
  DiagnosticsPage,
} from '@/entrypoints/options/settings';

const navigation = [
  { to: '/', title: 'Home', icon: LayoutDashboard },
  { to: '/bookmarks', title: 'Bookmarks', icon: Bookmark },
  { to: '/sessions', title: 'Sessions', icon: PanelsTopLeft },
  { to: '/history', title: 'History', icon: History },
  { to: '/devices', title: 'Devices', icon: Laptop },
  { to: '/settings', title: 'Settings', icon: Settings },
] as const;

function AppShell() {
  const { status, error, refresh } = useSynk();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const setup = pathname.startsWith('/setup');
  const current = setup
    ? 'Setup'
    : (navigation.find(({ to }) =>
        to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`),
      )?.title ?? 'Helium Synk');
  useEffect(() => {
    document.title = `${current} · Helium Synk`;
    window.scrollTo(0, 0);
    document.getElementById('page-content')?.focus({ preventScroll: true });
  }, [pathname, current]);
  if (!status)
    return (
      <div className="setup-loading">
        <img src="/icons/128.png" alt="" width="64" height="64" />
        <h1>Helium Synk</h1>
        {error ? (
          <>
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <Button onClick={() => void refresh()}>Try again</Button>
          </>
        ) : (
          <p role="status">Opening your saved data…</p>
        )}
      </div>
    );
  if (!status.enrolled && (!setup || pathname === '/setup/collections'))
    return <Navigate to={status.pairing_pending ? '/setup/join' : '/setup'} replace />;
  const connection =
    status.connection === 'online'
      ? 'Connected'
      : status.connection === 'syncing'
        ? 'Syncing…'
        : 'Offline';
  return (
    <div className={`shell ${!status.enrolled ? 'setup-shell' : ''}`}>
      <a
        className="skip-link"
        href="#page-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('page-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <Link to={status.enrolled ? '/' : '/setup'} className="brand">
          <img className="brand-mark" src="/icons/128.png" alt="" width="55" height="55" />
          <span>
            helium
            <br />
            <strong>synk</strong>
          </span>
        </Link>
        {status.enrolled ? (
          <nav className="sidebar-nav" aria-label="Main navigation">
            {navigation.map(({ to, title, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className="nav"
                activeProps={{ className: 'nav active', 'aria-current': 'page' }}
                activeOptions={{ exact: to === '/' }}
              >
                <span className="nav-label">
                  <Icon aria-hidden="true" />
                  {title}
                </span>
              </Link>
            ))}
          </nav>
        ) : (
          <div className="setup-aside">
            <span className="eyebrow">PRIVATE SYNC</span>
            <p>
              Your bookmarks.
              <br />
              Your tabs.
              <br />
              Your history.
            </p>
          </div>
        )}
        <div className="aside-footer">
          Encrypted between your devices.
          <br />
          Saved locally for offline use.
        </div>
      </aside>
      <main className="workspace" id="page-content" tabIndex={-1}>
        <header className="workspace-header">
          <span className="eyebrow">HELIUM SYNK / {current.toUpperCase()}</span>
          {status.enrolled && (
            <Badge variant="outline" className="connection-badge">
              <span className={`dot ${status.connection === 'online' ? 'green' : ''}`} />
              {connection}
            </Badge>
          )}
        </header>
        {(error || status.error) && (
          <Alert variant="destructive" className="error mt-6">
            <AlertDescription>{error || status.error}</AlertDescription>
          </Alert>
        )}
        <div className="route-content">
          <Outlet />
        </div>
        <footer className="workspace-footer">
          <span>DEVELOPMENT BUILD</span>
          <p>Collection starts only when you enable it.</p>
        </footer>
      </main>
    </div>
  );
}

function BookmarksPage() {
  const { status, onStatus } = useSynk();
  return status && <BookmarkPanel status={status} request={request} onStatus={onStatus} />;
}
function SessionsPage() {
  const { status, onStatus } = useSynk();
  return status && <SessionPanel status={status} request={request} onStatus={onStatus} />;
}
function HistoryPage() {
  const { status, onStatus } = useSynk();
  return status && <HistoryPanel status={status} request={request} onStatus={onStatus} />;
}

const root = createRootRoute({
  component: () => (
    <SynkProvider>
      <AppShell />
    </SynkProvider>
  ),
  notFoundComponent: () => (
    <>
      <h1>Page not found</h1>
      <Link to="/">Go to Home</Link>
    </>
  ),
});
const routes = [
  createRoute({ getParentRoute: () => root, path: '/', component: HomePage }),
  createRoute({ getParentRoute: () => root, path: '/setup', component: SetupWelcome }),
  createRoute({ getParentRoute: () => root, path: '/setup/join', component: SetupJoin }),
  createRoute({ getParentRoute: () => root, path: '/setup/first', component: SetupFirst }),
  createRoute({
    getParentRoute: () => root,
    path: '/setup/recover',
    component: () => <SetupFirst recovery />,
  }),
  createRoute({
    getParentRoute: () => root,
    path: '/setup/collections',
    component: SetupCollections,
  }),
  createRoute({ getParentRoute: () => root, path: '/bookmarks', component: BookmarksPage }),
  createRoute({ getParentRoute: () => root, path: '/sessions', component: SessionsPage }),
  createRoute({ getParentRoute: () => root, path: '/history', component: HistoryPage }),
  createRoute({ getParentRoute: () => root, path: '/devices', component: DevicesPage }),
  createRoute({ getParentRoute: () => root, path: '/devices/add', component: AddDevicePage }),
  createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage }),
  createRoute({ getParentRoute: () => root, path: '/settings/recovery', component: RecoveryPage }),
  createRoute({ getParentRoute: () => root, path: '/settings/security', component: SecurityPage }),
  createRoute({
    getParentRoute: () => root,
    path: '/settings/diagnostics',
    component: DiagnosticsPage,
  }),
];

// Keep links to sections from earlier builds useful after installing the routed UI.
const legacy: Record<string, string> = {
  overview: '/',
  bookmarks: '/bookmarks',
  sessions: '/sessions',
  history: '/history',
  devices: '/devices',
  pairing: '/devices/add',
};
const oldSection = location.hash.slice(1);
if (legacy[oldSection])
  window.history.replaceState(
    null,
    '',
    `${location.pathname}${location.search}#${legacy[oldSection]}`,
  );

export const router = createRouter({
  routeTree: root.addChildren(routes),
  history: createHashHistory(),
  defaultPreload: false,
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
