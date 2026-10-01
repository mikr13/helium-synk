import React, { useEffect, useState, useRef } from 'react';
import { restoreUrl, type HistoryVisit } from '@helium-synk/core';
import type { Status, Request, Reply } from '../../lib/messages';
type Props = {
  status: Status;
  request: (r: Request) => Promise<Reply & { ok: true }>;
  onStatus: (s: Status | undefined) => void;
};
type Page = NonNullable<(Reply & { ok: true })['history_page']>;
type Removal =
  { type: 'selected'; ids: string[] } | { type: 'scope'; source?: { id: string; name: string } };
function dayStart(value: string): number | undefined {
  return value ? new Date(value + 'T00:00:00').getTime() : undefined;
}
function dayEnd(value: string): number | undefined {
  if (!value) return undefined;
  const date = new Date(value + 'T00:00:00');
  date.setDate(date.getDate() + 1);
  return date.getTime();
}
export function HistoryPanel({ status, request, onStatus }: Props) {
  const [days, setDays] = useState(90),
    [domains, setDomains] = useState(status.history.exclusions.join('\n'));
  const [text, setText] = useState(''),
    [search, setSearch] = useState('');
  const [source, setSource] = useState('all'),
    [start, setStart] = useState(''),
    [end, setEnd] = useState('');
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [visits, setVisits] = useState<(HistoryVisit & { operation_id: string })[]>([]);
  const [page, setPage] = useState<Page>(),
    [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [removal, setRemoval] = useState<Removal>(),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text), 300);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    setDomains(status.history.exclusions.join('\n'));
  }, [status.history.exclusions.join('\n')]);
  const generation = useRef(0);
  const query = {
    text: search,
    source_id: source === 'all' ? undefined : source,
    start_time: dayStart(start),
    end_time: dayEnd(end),
    limit: 100,
  };
  useEffect(() => {
    setSelected([]);
  }, [search, source, start, end]);
  useEffect(() => {
    if (selected.length) return;
    let active = true;
    generation.current++;
    setLoading(true);
    setPage(undefined);
    setVisits([]);
    setError('');
    void request({ type: 'history-query', query })
      .then((r) => {
        if (!active) return;
        setVisits(r.history_page?.visits ?? []);
        setPage(r.history_page);
        setSources(r.history_sources ?? []);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to search history.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    request,
    search,
    source,
    start,
    end,
    status.history.visits,
    status.last_synced,
    refresh,
    selected.length,
  ]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'History action failed.');
    } finally {
      setBusy(false);
    }
  }
  async function action(message: Request) {
    const r = await request(message);
    if (r.status) onStatus(r.status);
    setRefresh((n) => n + 1);
  }
  async function loadMore() {
    const expected = generation.current;
    const r = await request({ type: 'history-query', query: { ...query, cursor: page?.cursor } });
    if (expected !== generation.current) return;
    setVisits((old) => [
      ...new Map([...old, ...(r.history_page?.visits ?? [])].map((v) => [v.id, v])).values(),
    ]);
    setPage(r.history_page);
  }
  function toggle(id: string) {
    if (selected.includes(id)) setSelected(selected.filter((s) => s !== id));
    else if (selected.length < 80) setSelected([...selected, id]);
    else setError('Remove up to 80 selected visits at a time.');
  }
  async function remove() {
    if (!removal) return;
    await action(
      removal.type === 'selected'
        ? { type: 'history-delete', ids: removal.ids }
        : { type: 'history-clear', source_id: removal.source?.id },
    );
    setRemoval(undefined);
    setSelected([]);
  }
  return (
    <section className="panel history-panel" id="history">
      <div className="panel-heading">
        <span className="number">04</span>
        <div>
          <p className="eyebrow">YOUR TRAIL, KEPT CLOSE</p>
          <h2>Find your way back.</h2>
          <p>
            Search visits from every profile, with their original times. Your timeline stays
            available offline.
          </p>
        </div>
      </div>
      <details className="history-settings" open={!status.history.enabled}>
        <summary>
          Capture settings · {status.history.phase === 'off' ? 'not enabled' : status.history.phase}
        </summary>
        <div className="history-settings-grid">
          <label>
            Initial import
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              disabled={status.history.enabled}
            >
              <option value={0}>New visits only</option>
              <option value={7}>Past 7 days</option>
              <option value={30}>Past 30 days</option>
              <option value={90}>Past 90 days</option>
              <option value={365}>Past year</option>
            </select>
          </label>
          <label>
            Excluded domains <span className="muted">/ one per line, including subdomains</span>
            <textarea
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              rows={3}
              placeholder="example.com"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() =>
              void run(() =>
                action({
                  type: 'history-enable',
                  days,
                  exclusions: domains
                    .split(/\r?\n/)
                    .map((d) => d.trim())
                    .filter(Boolean),
                }),
              )
            }
          >
            {status.history.enabled
              ? 'Save capture settings'
              : status.history.phase === 'off'
                ? 'Enable history capture'
                : 'Resume history capture'}
          </button>
          {status.history.enabled && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void run(() => action({ type: 'history-pause' }))}
            >
              Pause capture
            </button>
          )}
        </div>
        <p className="fine">
          Pause cancels unfetched imports and retains captured visits and saved events. Private and
          imported browser visits are excluded. Exclusions affect future collection; existing
          entries remain until removed.
        </p>
      </details>
      {status.history.phase === 'baseline' && (
        <p className="history-notice" role="status">
          Collection is paused while the browser history baseline is checked. Existing visits will
          stay excluded when collection resumes.
        </p>
      )}
      {status.history.pending > 0 && (
        <p className="fine">{status.history.pending} capture/import task(s) saved locally.</p>
      )}
      {(error || status.history.error) && (
        <div className="error" role="alert">
          {error || status.history.error}
        </div>
      )}
      <div className="history-filters">
        <label className="history-search">
          Search your timeline
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            placeholder="Title, URL or profile name"
          />
        </label>
        <label>
          Source profile
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All profiles</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          Through
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <div className="history-actions">
        <span className="fine">
          {visits.length} shown · {selected.length} selected
        </span>
        <div className="actions">
          <button
            className="secondary"
            disabled={busy || loading || !selected.length}
            onClick={() => setRemoval({ type: 'selected', ids: [...selected] })}
          >
            Remove selected
          </button>
          <button
            className="secondary"
            disabled={busy || loading || !status.history.visits}
            onClick={() =>
              setRemoval({
                type: 'scope',
                source:
                  source === 'all'
                    ? undefined
                    : {
                        id: source,
                        name: sources.find((s) => s.id === source)?.name ?? 'Selected profile',
                      },
              })
            }
          >
            {source === 'all' ? 'Clear all profiles' : 'Clear this profile'}
          </button>
        </div>
      </div>
      {removal && (
        <div className="history-removal" role="region" aria-label="Confirm history removal">
          <strong>
            Remove{' '}
            {removal.type === 'selected'
              ? `${removal.ids.length} selected visit(s)`
              : removal.source
                ? `history from ${removal.source.name}`
                : 'history from all profiles'}
            ?
          </strong>
          <p>
            Applies to synchronized history across profiles. Native browser history stays local.
            Permanent erasure of stored copies is still being implemented in this development build.
          </p>
          <div className="actions">
            <button disabled={busy} onClick={() => void run(remove)}>
              Confirm removal
            </button>
            <button className="secondary" disabled={busy} onClick={() => setRemoval(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <p role="status">Searching your local timeline…</p>
      ) : (
        !visits.length && (
          <div className="empty">
            {page?.has_more
              ? 'No matches in this part of the timeline. Continue searching older visits below.'
              : 'No visits match this view.'}
          </div>
        )
      )}
      <ol className="history-visits">
        {visits.map((v) => (
          <li key={v.id}>
            <input
              type="checkbox"
              checked={selected.includes(v.id)}
              onChange={() => toggle(v.id)}
              disabled={busy}
              aria-label={`Select visit to ${v.title || v.url} at ${new Date(v.visited_at).toLocaleString()}`}
            />
            <div className="history-copy">
              <strong>{v.title || 'Untitled page'}</strong>
              {restoreUrl(v.url) ? (
                <a href={v.url} target="_blank" rel="noopener noreferrer">
                  {v.url}
                </a>
              ) : (
                <span>{v.url}</span>
              )}
              <small>
                {v.source_name} · {v.source_id.slice(0, 8)}
                {v.transition ? ` · ${v.transition}` : ''}
              </small>
            </div>
            <time dateTime={new Date(v.visited_at).toISOString()}>
              {new Date(v.visited_at).toLocaleString()}
            </time>
          </li>
        ))}
      </ol>
      {page?.has_more && (
        <button className="secondary" disabled={busy || loading} onClick={() => void run(loadMore)}>
          {page.visits.length ? 'Load older visits' : 'Continue searching older visits'}
        </button>
      )}
      <p className="fine">
        Titles reflect what the browser supplied when captured. Remote visits appear here; they keep
        their original timestamps.
      </p>
    </section>
  );
}
