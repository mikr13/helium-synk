import React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Bookmark, History, PanelsTopLeft, Plus, RefreshCw } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardContent,
  CardFooter,
  CardTitle,
  CardDescription,
  CardAction,
} from '@/components/ui/card';
import { Item, ItemMedia, ItemContent, ItemTitle, ItemActions } from '@/components/ui/item';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { request, useAction, useSynk } from '@/entrypoints/options/state';

export function PageTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="page-title">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
  );
}

export function CollectionChoices() {
  const { status } = useSynk();
  if (!status) return null;
  const collections = [
    {
      to: '/bookmarks',
      title: 'Bookmarks',
      icon: Bookmark,
      enabled: status.bookmarks.phase === 'active',
      hasSavedData: status.bookmarks.nodes > 0,
      description: 'Keep the same links and folders everywhere.',
      count: `${status.bookmarks.nodes} shared entries`,
    },
    {
      to: '/sessions',
      title: 'Sessions',
      icon: PanelsTopLeft,
      enabled: status.sessions.enabled,
      hasSavedData: status.sessions.snapshots > 0,
      description: 'Pick up your open tabs and closed windows.',
      count: `${status.sessions.snapshots} saved snapshots`,
    },
    {
      to: '/history',
      title: 'History',
      icon: History,
      enabled: status.history.enabled,
      hasSavedData: status.history.visits > 0,
      description: 'Find pages visited on any connected device.',
      count: `${status.history.visits} saved visits`,
    },
  ] as const;
  return (
    <div className="collection-grid">
      {collections.map(({ to, title, icon: Icon, enabled, hasSavedData, description, count }) => (
        <Card key={to} className="collection-card">
          <CardHeader>
            <div className="collection-heading">
              <Icon aria-hidden="true" />
              <Badge variant={enabled ? 'secondary' : 'outline'}>{enabled ? 'On' : 'Off'}</Badge>
            </div>
            <CardTitle>
              <h2>{title}</h2>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="collection-count">{count}</CardContent>
          <CardFooter>
            <Button asChild variant="outline" className="w-full justify-between">
              <Link to={to}>
                {enabled || hasSavedData ? 'Open' : 'Set up'} {title.toLowerCase()}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}

export function HomePage() {
  const { status, onStatus } = useSynk();
  const { busy, error, run } = useAction();
  if (!status) return null;
  return (
    <>
      <PageTitle
        title="Your sync, at a glance."
        description="Choose a collection to pick up where you left off."
      />
      <Card className="connection-summary">
        <CardHeader className="block space-y-2 sm:grid sm:space-y-0">
          <p className="eyebrow">THIS DEVICE</p>
          <CardTitle>
            <h2>{status.name}</h2>
          </CardTitle>
          <CardDescription>
            {status.connection === 'online'
              ? status.pending
                ? `${status.pending} changes waiting to send`
                : 'Everything is up to date'
              : status.connection === 'syncing'
                ? 'Syncing your changes…'
                : status.connection === 'not-connected'
                  ? 'Checking your connection…'
                  : 'Server unavailable. Saved data is available here.'}
          </CardDescription>
          <CardAction className="row-span-3 justify-self-start pt-2 sm:justify-self-end sm:pt-0">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => onStatus((await request({ type: 'sync' })).status))
              }
            >
              <RefreshCw className={busy ? 'animate-spin' : ''} aria-hidden="true" />
              {busy ? 'Syncing…' : 'Sync now'}
            </Button>
          </CardAction>
        </CardHeader>
        <CardFooter className="sync-meta border-t">
          <span>
            Last synced {status.last_synced ? new Date(status.last_synced).toLocaleString() : '—'}
          </span>
          <Button asChild variant="link" className="h-auto min-h-0 p-0 has-[>svg]:px-0">
            <Link to="/devices">
              Devices <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </CardFooter>
      </Card>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <CollectionChoices />
      <Item asChild variant="outline" className="border-dashed bg-card">
        <Link to="/devices/add">
          <ItemMedia>
            <Plus className="size-5 text-primary" aria-hidden="true" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Connect another device</ItemTitle>
          </ItemContent>
          <ItemActions>
            <ArrowRight className="size-4 text-primary" aria-hidden="true" />
          </ItemActions>
        </Link>
      </Item>
    </>
  );
}
