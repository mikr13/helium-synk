import React from 'react';
import { ArrowUpRight, Bookmark, History, PanelsTopLeft, Plus, RefreshCw } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { request, useAction, useSynk } from '@/entrypoints/options/state';

export function Popup() {
  const { status, error: loadError, onStatus, refresh } = useSynk();
  const { busy, error, run } = useAction();
  const message = error || loadError;
  function openPage(path: string) {
    void run(async () => {
      await browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}#${path}` });
      window.close();
    });
  }
  const connection =
    status?.connection === 'online'
      ? 'Connected'
      : status?.connection === 'syncing'
        ? 'Syncing…'
        : status?.connection === 'waiting'
          ? 'Offline'
          : 'Checking connection…';

  return (
    <main className="flex flex-col gap-4 p-5">
      <header className="flex items-center gap-3 border-b pb-4">
        <img src="/icons/48.png" alt="" width="40" height="40" className="size-10" />
        <h1 className="text-xl font-extrabold tracking-tight">
          helium <span className="text-primary">synk</span>
        </h1>
      </header>
      {message && (
        <Alert variant="destructive">
          <AlertDescription className="break-words">{message}</AlertDescription>
        </Alert>
      )}
      {!status ? (
        <>
          {loadError ? (
            <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
              Try again
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              Opening your saved data…
            </p>
          )}
          <Button variant="outline" disabled={busy} onClick={() => openPage('/')}>
            Open Helium Synk <ArrowUpRight aria-hidden="true" />
          </Button>
        </>
      ) : !status.enrolled ? (
        <>
          <div className="space-y-2">
            <h2 className="text-base font-semibold">
              {status.pairing_pending
                ? 'Finish connecting this device.'
                : 'Your browser, together.'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {status.pairing_pending
                ? 'Your saved connection attempt is ready to resume.'
                : 'Connect once, then choose what to sync.'}
            </p>
          </div>
          <Button
            disabled={busy}
            onClick={() => openPage(status.pairing_pending ? '/setup/join' : '/setup')}
          >
            {status.pairing_pending ? 'Finish connecting' : 'Set up sync'}
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </>
      ) : (
        <>
          <section className="space-y-3" aria-label="Sync status">
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 break-words text-sm font-semibold">{status.name}</h2>
              <Badge
                variant={status.connection === 'online' ? 'secondary' : 'outline'}
                className="shrink-0"
              >
                {loadError ? 'Check connection' : connection}
              </Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground" role="status">
              {loadError
                ? 'Connection status is unavailable. Saved data is kept here.'
                : status.pending > 0
                  ? `${status.pending.toLocaleString()} changes waiting to sync`
                  : status.connection === 'online'
                    ? 'Everything is up to date'
                    : status.connection === 'waiting'
                      ? 'Saved data is available offline.'
                      : 'Checking for changes…'}
            </p>
            <Button
              className="w-full"
              variant="outline"
              disabled={busy || status.connection === 'syncing'}
              onClick={() =>
                void run(async () => onStatus((await request({ type: 'sync' })).status))
              }
            >
              <RefreshCw className={busy ? 'animate-spin' : ''} aria-hidden="true" />
              {busy || status.connection === 'syncing' ? 'Syncing…' : 'Sync now'}
            </Button>
          </section>
          {(status.error ||
            status.storage.warning ||
            status.bookmarks.error ||
            status.sessions.error ||
            status.history.error) && (
            <Alert>
              <AlertDescription>Sync needs attention. Open Synk for details.</AlertDescription>
            </Alert>
          )}
          <nav className="grid grid-cols-3 gap-2" aria-label="Collections">
            {[
              { title: 'Bookmarks', path: '/bookmarks', icon: Bookmark },
              { title: 'Sessions', path: '/sessions', icon: PanelsTopLeft },
              { title: 'History', path: '/history', icon: History },
            ].map(({ title, path, icon: Icon }) => (
              <Button
                key={path}
                variant="ghost"
                className="flex-col gap-2 px-1 py-3 text-xs"
                disabled={busy}
                onClick={() => openPage(path)}
              >
                <Icon className="size-4 text-primary" aria-hidden="true" />
                {title}
              </Button>
            ))}
          </nav>
          <footer className="flex flex-col gap-2 border-t pt-4">
            <Button disabled={busy} onClick={() => openPage('/')}>
              Open Helium Synk <ArrowUpRight aria-hidden="true" />
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => openPage('/devices/add')}>
              <Plus aria-hidden="true" /> Connect another device
            </Button>
          </footer>
        </>
      )}
    </main>
  );
}
