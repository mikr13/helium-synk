import React, { useEffect, useState } from 'react';
import type { Reply, Request, Status, KeySummary } from '../../lib/messages';
export function KeyPanel({
  status,
  request,
  onStatus,
}: {
  status: Status;
  request: (message: Request) => Promise<Reply & { ok: true }>;
  onStatus: (status: Status) => void;
}) {
  const [keys, setKeys] = useState<KeySummary>();
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<number>();
  async function load() {
    const reply = await request({ type: 'keys-list' });
    if (!reply.keys) throw new Error('Installation list was not returned.');
    setKeys(reply.keys);
    if (reply.status) onStatus(reply.status);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update installation access.');
      try {
        const reply = await request({ type: 'status' });
        if (reply.status) onStatus(reply.status);
      } catch {
        /* Keep the operation error. */
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void request({ type: 'keys-list' })
      .then((reply) => {
        if (active) {
          setKeys(reply.keys);
          if (reply.status) onStatus(reply.status);
        }
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Unable to load installations.');
      });
    return () => {
      active = false;
    };
  }, [status.key_epoch]);
  const pending = status.rotation_pending;
  const retainedUnready =
    keys?.devices.filter((d) => !d.revoked && !selected.includes(d.device_id) && !d.ready) ?? [];
  const names =
    keys?.devices.filter((d) => selected.includes(d.device_id)).map((d) => d.name) ?? [];
  return (
    <section className="panel key-panel" id="devices">
      <div className="panel-heading">
        <span className="number">◇</span>
        <div>
          <h2>Installation access</h2>
          <p>Remove an installation and create new encryption keys for your remaining profiles.</p>
        </div>
      </div>
      <p className="fine">
        Content-key generation {status.key_epoch ?? 1}. Old keys and downloaded data remain known to
        removed installations. After rotation, save an updated recovery bundle.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="key-complete">
          Access updated. Your profiles now use content-key generation {done}. Save a new recovery
          bundle from This device.
        </p>
      )}
      {pending && (
        <div className="pairing-review">
          <strong>A rotation is saved</strong>
          <p className="fine">
            Retry keeps the same keys and request. The relay may already have committed it even if
            its reply was lost.
          </p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const reply = await request({ type: 'keys-retry' });
                  if (reply.status) {
                    onStatus(reply.status);
                    setDone(reply.status.key_epoch);
                  }
                  await load();
                  setReview(false);
                  setSelected([]);
                })
              }
            >
              {busy ? 'Updating…' : 'Retry saved rotation'}
              <span>↗</span>
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await load();
                  setSelected(pending.revoke_ids);
                  setReview(true);
                })
              }
            >
              Review updated devices
            </button>
          </div>
        </div>
      )}
      <ul className="key-devices">
        {keys?.devices.map((d) => (
          <li key={d.device_id}>
            <input
              type="checkbox"
              id={`remove-${d.device_id}`}
              disabled={busy || d.revoked || d.device_id === keys.device_id}
              checked={selected.includes(d.device_id)}
              onChange={(e) => {
                setSelected(
                  e.target.checked
                    ? [...selected, d.device_id]
                    : selected.filter((id) => id !== d.device_id),
                );
                setReview(false);
                setDone(undefined);
              }}
            />
            <label htmlFor={`remove-${d.device_id}`}>
              <strong>{d.name}</strong>
              <small>
                {d.device_id === keys.device_id
                  ? 'This profile'
                  : d.revoked
                    ? 'Access removed'
                    : d.ready
                      ? 'Ready for key rotation'
                      : 'Needs to sync with an upgraded client'}
              </small>
            </label>
          </li>
        ))}
      </ul>
      {!keys && !error && <p className="fine">Loading installations…</p>}
      <div className="actions">
        <button className="secondary" disabled={busy} onClick={() => void run(load)}>
          Refresh installations
        </button>
        <button
          disabled={busy || !keys || (!selected.length && !pending)}
          onClick={() => setReview(true)}
        >
          Review removal<span>↗</span>
        </button>
      </div>
      {review && (
        <div className="pairing-review" role="group" aria-label="Review installation removal">
          <p>
            {names.length
              ? `Remove access for ${names.join(', ')}.`
              : 'Rotate the keys for the current retained installations.'}{' '}
            API access and distribution of new keys change together.
          </p>
          <p className="fine">
            Each retained profile needs to have synced with this version. Offline profiles that
            already have wrapping keys can reconnect later. Replacing a saved proposal cannot undo a
            removal that already committed.
          </p>
          {!!retainedUnready.length && (
            <p className="error" role="alert">
              Sync or select these installations for removal first:{' '}
              {retainedUnready.map((d) => d.name).join(', ')}.
            </p>
          )}
          <div className="actions">
            <button className="secondary" disabled={busy} onClick={() => setReview(false)}>
              Keep access
            </button>
            <button
              disabled={busy || !!retainedUnready.length}
              onClick={() =>
                void run(async () => {
                  const reply = await request({
                    type: 'keys-rotate',
                    revoke_ids: selected,
                    replace: !!pending,
                  });
                  if (reply.status) {
                    onStatus(reply.status);
                    setDone(reply.status.key_epoch);
                  }
                  setSelected([]);
                  setReview(false);
                  await load();
                })
              }
            >
              {busy
                ? 'Updating access…'
                : pending
                  ? 'Replace proposal and rotate'
                  : 'Remove and rotate keys'}
              <span>↗</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
