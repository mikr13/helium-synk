import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyDescription } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import React, { useEffect, useState } from 'react';
import {
  restoreUrl,
  canonicalUuid,
  type SessionSnapshot,
  type RestoreSelection,
  type SessionWindow,
} from '@helium-synk/core';
import type { Status, Request, Reply, SessionListItem } from '@/lib/messages';
type Props = {
  status: Status;
  request: (r: Request) => Promise<Reply & { ok: true }>;
  onStatus: (s: Status | undefined) => void;
};
export type SessionFilters = { kind: 'current' | 'closed' | 'previous'; source: string };
export function sessionFilters(search: Record<string, unknown>): SessionFilters {
  return {
    kind: search.kind === 'closed' || search.kind === 'previous' ? search.kind : 'current',
    source: canonicalUuid(search.source) ? (search.source as string) : 'all',
  };
}
function age(value: string): string {
  const seconds = Math.floor((Date.now() - Date.parse(value)) / 1000);
  if (seconds < -60) return 'Source clock is ahead';
  if (seconds < 60) return 'Captured just now';
  if (seconds < 3600) return `Captured ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `Captured ${Math.floor(seconds / 3600)}h ago`;
  return `Captured ${Math.floor(seconds / 86400)}d ago`;
}
function WindowView({
  window: w,
  busy,
  restore,
}: {
  window: SessionWindow;
  busy: boolean;
  restore: (selection: RestoreSelection) => void;
}) {
  const [limit, setLimit] = useState(50);
  return (
    <div className="session-window">
      <div className="session-window-heading">
        <div>
          <h4>
            {w.tabs.length} tabs{' '}
            {w.focused && (
              <Badge variant="outline" className="session-label">
                FOCUSED
              </Badge>
            )}
          </h4>
          <p>
            {w.groups.length} groups · {w.tabs.filter((t) => t.pinned).length} pinned
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => restore({ mode: 'window', window_id: w.id })}
        >
          Open window ↗
        </Button>
      </div>
      {w.groups_unavailable && (
        <p className="fine">
          Group details were unavailable from the recently-closed browser record.
        </p>
      )}
      {w.groups.length > 0 && (
        <div className="session-group-list">
          {w.groups.map((g) => (
            <span key={g.id} className="session-group">
              <i style={{ background: g.color === 'grey' ? '#6d736a' : g.color }} />
              {g.title || 'Untitled group'}
              {g.collapsed ? ' · collapsed' : ''}
            </span>
          ))}
        </div>
      )}
      <ol className="session-tabs">
        {w.tabs.slice(0, limit).map((t) => (
          <li key={t.id}>
            <div className="session-tab-copy">
              <strong>{t.title || t.url || 'Untitled tab'}</strong>
              <span>
                {t.pinned ? 'Pinned · ' : ''}
                {t.active ? 'Active · ' : ''}
                {t.group_id
                  ? `${w.groups.find((g) => g.id === t.group_id)?.title || 'Group'} · `
                  : ''}
                {t.url || 'URL unavailable'}
              </span>
              {!restoreUrl(t.url) && (
                <small>Local, internal or unsupported URL; restore will skip it.</small>
              )}
            </div>
            <Button
              variant="outline"
              disabled={busy || !restoreUrl(t.url)}
              onClick={() => restore({ mode: 'tab', window_id: w.id, tab_id: t.id })}
              aria-label={`Open ${t.title || 'tab'}`}
            >
              Open ↗
            </Button>
          </li>
        ))}
      </ol>
      {w.tabs.length > limit && (
        <Button variant="outline" onClick={() => setLimit(limit + 100)}>
          Show more tabs ({w.tabs.length - limit} remaining)
        </Button>
      )}
    </div>
  );
}
export function SessionPanel({
  status,
  request,
  onStatus,
  filters,
  onFiltersChange,
}: Props & {
  filters: SessionFilters;
  onFiltersChange: (filters: SessionFilters) => void;
}) {
  const [items, setItems] = useState<SessionListItem[]>([]),
    [more, setMore] = useState(false),
    [offset, setOffset] = useState(0);
  const { kind, source } = filters;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const loaded: SessionListItem[] = [];
        let hasMore = false;
        for (let page = 0; page <= offset; page += 100) {
          const r = await request({ type: 'session-list', offset: page });
          loaded.push(...(r.session_list ?? []));
          hasMore = !!r.session_more;
          if (!hasMore || !active) break;
        }
        if (active) {
          setItems([...new Map(loaded.map((s) => [s.id, s])).values()]);
          setMore(hasMore);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load sessions.');
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [request, offset]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Session action failed.');
    } finally {
      setBusy(false);
    }
  }
  async function action(message: Request) {
    const r = await request(message);
    if (r.status) onStatus(r.status);
  }
  const filtered = items.filter(
    (s) =>
      (source === 'all' || s.source_id === source) &&
      (kind === 'current'
        ? s.latest
        : kind === 'closed'
          ? s.kind === 'closed'
          : s.kind === 'previous' || (s.kind === 'current' && !s.latest)),
  );
  const sources = [...new Map(items.map((s) => [s.source_id, s.source_name])).entries()];
  return (
    <Card className="panel session-panel" id="sessions">
      <CardHeader className="panel-heading flex px-0 pt-0">
        <span className="number">03</span>
        <div className="min-w-0 space-y-2">
          <CardTitle>
            <h1>Sessions</h1>
          </CardTitle>
          <CardDescription className="leading-6">
            Current sessions, closed windows and saved snapshots stay available locally.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <div className="actions">
          <Button
            disabled={busy}
            onClick={() =>
              void run(() =>
                action({ type: status.sessions.enabled ? 'session-pause' : 'session-enable' }),
              )
            }
          >
            {status.sessions.enabled ? 'Pause session capture' : 'Enable session capture'}
          </Button>
          {status.sessions.enabled && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => action({ type: 'session-save' }))}
            >
              Save current snapshot
            </Button>
          )}
        </div>
        <p className="fine">
          {status.sessions.enabled
            ? 'Capturing normal windows. Private windows are excluded.'
            : 'Capture is paused. Existing snapshots remain available; re-enabling starts from your current windows.'}{' '}
          Restoring opens pages here and keeps the source session intact.
        </p>
        {(error || status.sessions.error) && (
          <Alert variant="destructive" className="error">
            <AlertDescription>{error || status.sessions.error}</AlertDescription>
          </Alert>
        )}
        {status.sessions.incomplete > 0 && (
          <p className="fine">
            {status.sessions.incomplete} snapshot(s) still downloading. The last complete session
            stays visible.
          </p>
        )}
        <Tabs
          value={kind}
          onValueChange={(kind) =>
            onFiltersChange({ ...filters, kind: sessionFilters({ kind }).kind })
          }
        >
          <div className="session-toolbar">
            <TabsList aria-label="Session type" className="border bg-background">
              {['current', 'closed', 'previous'].map((k) => (
                <TabsTrigger key={k} value={k}>
                  {k[0]!.toUpperCase() + k.slice(1)}
                </TabsTrigger>
              ))}
            </TabsList>

            <Field className="w-full max-w-64">
              <FieldLabel htmlFor="session-source">Source profile</FieldLabel>
              <NativeSelect
                id="session-source"
                value={source}
                onChange={(e) => onFiltersChange({ ...filters, source: e.target.value })}
              >
                <NativeSelectOption value="all">All profiles</NativeSelectOption>
                {sources.map(([id, name]) => (
                  <NativeSelectOption key={id} value={id}>
                    {name} · {id.slice(0, 8)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <p className="fine">
            Capture age describes this snapshot. It does not indicate whether the source device is
            online.
          </p>
          <TabsContent value={kind}>
            {!filtered.length && (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyDescription>No {kind} sessions in this view yet.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {sources
              .filter(([id]) => filtered.some((s) => s.source_id === id))
              .map(([id, name]) => (
                <div className="session-source" key={id}>
                  <h3>
                    {name}
                    <span>{id.slice(0, 8)}</span>
                  </h3>
                  {filtered
                    .filter((s) => s.source_id === id)
                    .map((s) => (
                      <Button
                        variant="ghost"
                        size="row"
                        className="session-card"
                        key={s.id}
                        asChild
                      >
                        <Link
                          to="/sessions/$snapshotId"
                          params={{ snapshotId: s.id }}
                          search={filters}
                        >
                          <div>
                            <strong>
                              {s.windows} window{s.windows !== 1 ? 's' : ''} · {s.tabs} tabs
                            </strong>
                            <span>
                              {age(s.captured_at)} · {new Date(s.captured_at).toLocaleString()}
                            </span>
                          </div>
                          <span>View ↗</span>
                        </Link>
                      </Button>
                    ))}
                </div>
              ))}
            {more && (
              <Button variant="outline" disabled={busy} onClick={() => setOffset(offset + 100)}>
                Load older snapshots
              </Button>
            )}
          </TabsContent>
        </Tabs>
        <SessionJobs
          jobs={status.sessions.restores}
          busy={busy}
          action={(message) => void run(() => action(message))}
        />
      </CardContent>
    </Card>
  );
}

function SessionJobs({
  jobs,
  busy,
  action,
}: {
  jobs: Status['sessions']['restores'];
  busy: boolean;
  action: (message: Request) => void;
}) {
  return (
    <>
      {jobs.length > 0 && (
        <div className="session-jobs">
          <h3>Restoration progress</h3>
          {jobs.map((j) => (
            <div className="session-job" key={j.id}>
              <div>
                <strong>
                  {j.opened}/{j.total} pages opened · {j.windows_done}/{j.windows_total} windows
                  ready
                </strong>
                <p>
                  {j.status} · {j.skipped} unsupported URL(s) skipped
                </p>
                {j.error && (
                  <Alert variant="destructive" className="error">
                    <AlertDescription>{j.error}</AlertDescription>
                  </Alert>
                )}
              </div>
              <div className="actions">
                {j.status === 'blocked' && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => action({ type: 'session-resume', id: j.id })}
                  >
                    Resume safely
                  </Button>
                )}
                {(j.status === 'running' || j.status === 'blocked') && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => action({ type: 'session-cancel', id: j.id })}
                  >
                    Cancel; keep opened tabs
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function SessionDetailPanel({
  status,
  request,
  onStatus,
  snapshotId,
  filters,
}: Props & {
  snapshotId: string;
  filters: SessionFilters;
}) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    setLoading(true);
    setError('');
    async function load() {
      try {
        if (!canonicalUuid(snapshotId)) throw new Error('This saved session is unavailable.');
        const reply = await request({ type: 'session-detail', id: snapshotId });
        if (!reply.session_snapshot) throw new Error('This saved session is unavailable.');
        if (active) setSnapshot(reply.session_snapshot);
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Unable to open this saved session.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [snapshotId, request, retry]);
  async function action(message: Request) {
    setBusy(true);
    setError('');
    try {
      const reply = await request(message);
      if (reply.status) onStatus(reply.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Session action failed.');
    } finally {
      setBusy(false);
    }
  }
  function restore(selection: RestoreSelection) {
    if (snapshot)
      void action({
        type: 'session-restore',
        id: crypto.randomUUID(),
        snapshot_id: snapshot.id,
        selection,
      });
  }
  return (
    <Card className="panel session-panel">
      <CardHeader className="space-y-4 px-0 pt-0">
        <Button asChild variant="ghost" className="w-fit max-w-full justify-start px-0">
          <Link to="/sessions" search={filters}>
            <ArrowLeft aria-hidden="true" />
            Back to sessions
          </Link>
        </Button>
        <CardTitle>
          <h1>Saved session</h1>
        </CardTitle>
        {snapshot && (
          <CardDescription>
            {snapshot.source_name} · {snapshot.kind} · {age(snapshot.captured_at)} ·{' '}
            {new Date(snapshot.captured_at).toLocaleString()}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-6 px-0">
        {loading && <p role="status">Opening saved session…</p>}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!loading && !snapshot && (
          <Button variant="outline" onClick={() => setRetry(retry + 1)}>
            Try again
          </Button>
        )}
        {snapshot && (
          <>
            <div className="session-detail-heading">
              <p className="fine">
                Restoring opens supported pages here and keeps the source session intact.
              </p>
              <Button
                disabled={busy || !snapshot.windows.length}
                onClick={() => restore({ mode: 'all' })}
              >
                Open all windows ↗
              </Button>
            </div>
            <SessionJobs
              jobs={status.sessions.restores.filter((job) => job.snapshot_id === snapshotId)}
              busy={busy}
              action={(message) => void action(message)}
            />
            {snapshot.windows.length ? (
              snapshot.windows.map((window) => (
                <WindowView key={window.id} window={window} busy={busy} restore={restore} />
              ))
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyDescription>This snapshot has no open windows.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
