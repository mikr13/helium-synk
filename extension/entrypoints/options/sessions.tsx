import React, { useEffect, useState } from 'react';
import {
  restoreUrl,
  type SessionSnapshot,
  type RestoreSelection,
  type SessionWindow,
} from '@helium-synk/core';
import type { Status, Request, Reply, SessionListItem } from '../../lib/messages';
type Props = {
  status: Status;
  request: (r: Request) => Promise<Reply & { ok: true }>;
  onStatus: (s: Status | undefined) => void;
};
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
            {w.tabs.length} tabs {w.focused && <span className="session-label">FOCUSED</span>}
          </h4>
          <p>
            {w.groups.length} groups · {w.tabs.filter((t) => t.pinned).length} pinned
          </p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => restore({ mode: 'window', window_id: w.id })}
        >
          Open window ↗
        </button>
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
            <button
              className="secondary"
              disabled={busy || !restoreUrl(t.url)}
              onClick={() => restore({ mode: 'tab', window_id: w.id, tab_id: t.id })}
              aria-label={`Open ${t.title || 'tab'}`}
            >
              Open ↗
            </button>
          </li>
        ))}
      </ol>
      {w.tabs.length > limit && (
        <button className="secondary" onClick={() => setLimit(limit + 100)}>
          Show more tabs ({w.tabs.length - limit} remaining)
        </button>
      )}
    </div>
  );
}
export function SessionPanel({ status, request, onStatus }: Props) {
  const [items, setItems] = useState<SessionListItem[]>([]),
    [more, setMore] = useState(false),
    [offset, setOffset] = useState(0);
  const [kind, setKind] = useState('current'),
    [source, setSource] = useState('all');
  const [selected, setSelected] = useState<SessionSnapshot>(),
    [busy, setBusy] = useState(false),
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
  async function inspect(id: string) {
    const r = await request({ type: 'session-detail', id });
    setSelected(r.session_snapshot);
  }
  function restore(selection: RestoreSelection) {
    if (selected)
      void run(() =>
        action({
          type: 'session-restore',
          id: crypto.randomUUID(),
          snapshot_id: selected.id,
          selection,
        }),
      );
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
    <section className="panel session-panel" id="sessions">
      <div className="panel-heading">
        <span className="number">03</span>
        <div>
          <p className="eyebrow">ACROSS YOUR DEVICES</p>
          <h2>Your open worlds.</h2>
          <p>Current sessions, closed windows and saved snapshots stay available locally.</p>
        </div>
      </div>
      <div className="actions">
        <button
          disabled={busy}
          onClick={() =>
            void run(() =>
              action({ type: status.sessions.enabled ? 'session-pause' : 'session-enable' }),
            )
          }
        >
          {status.sessions.enabled ? 'Pause session capture' : 'Enable session capture'}
        </button>
        {status.sessions.enabled && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void run(() => action({ type: 'session-save' }))}
          >
            Save current snapshot
          </button>
        )}
      </div>
      <p className="fine">
        {status.sessions.enabled
          ? 'Capturing normal windows. Private windows are excluded.'
          : 'Capture is paused. Existing snapshots remain available; re-enabling starts from your current windows.'}{' '}
        Restoring opens pages here and keeps the source session intact.
      </p>
      {(error || status.sessions.error) && (
        <div className="error" role="alert">
          {error || status.sessions.error}
        </div>
      )}
      {status.sessions.incomplete > 0 && (
        <p className="fine">
          {status.sessions.incomplete} snapshot(s) still downloading. The last complete session
          stays visible.
        </p>
      )}
      <div className="session-toolbar">
        <div className="session-switch" role="group" aria-label="Session type">
          {['current', 'closed', 'previous'].map((k) => (
            <button key={k} className={kind === k ? '' : 'secondary'} onClick={() => setKind(k)}>
              {k[0]!.toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <label>
          Source profile
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All profiles</option>
            {sources.map(([id, name]) => (
              <option key={id} value={id}>
                {name} · {id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="fine">
        Capture age describes this snapshot. It does not indicate whether the source device is
        online.
      </p>
      {!filtered.length && <div className="empty">No {kind} sessions in this view yet.</div>}
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
                <button
                  className={`session-card ${selected?.id === s.id ? 'selected' : ''}`}
                  key={s.id}
                  disabled={busy}
                  onClick={() => void run(() => inspect(s.id))}
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
                </button>
              ))}
          </div>
        ))}
      {more && (
        <button className="secondary" disabled={busy} onClick={() => setOffset(offset + 100)}>
          Load older snapshots
        </button>
      )}
      {selected && (
        <div className="session-detail">
          <div className="session-detail-heading">
            <div>
              <p className="eyebrow">
                {selected.source_name} / {selected.kind.toUpperCase()}
              </p>
              <h3>{age(selected.captured_at)}</h3>
              <p className="fine">
                Restores HTTP/HTTPS pages. Local, internal and unsupported URLs are skipped.
              </p>
            </div>
            <button disabled={busy} onClick={() => restore({ mode: 'all' })}>
              Open all windows ↗
            </button>
          </div>
          {selected.windows.length ? (
            selected.windows.map((w) => (
              <WindowView key={w.id} window={w} busy={busy} restore={restore} />
            ))
          ) : (
            <div className="empty">This snapshot has no open windows.</div>
          )}
        </div>
      )}
      {status.sessions.restores.length > 0 && (
        <div className="session-jobs">
          <h3>Restoration progress</h3>
          {status.sessions.restores.map((j) => (
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
                  <p className="error" role="alert">
                    {j.error}
                  </p>
                )}
              </div>
              <div className="actions">
                {j.status === 'blocked' && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void run(() => action({ type: 'session-resume', id: j.id }))}
                  >
                    Resume safely
                  </button>
                )}
                {(j.status === 'running' || j.status === 'blocked') && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void run(() => action({ type: 'session-cancel', id: j.id }))}
                  >
                    Cancel; keep opened tabs
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
