import React, { useState } from 'react';
import { parsePairingBundle } from '@helium-synk/core';
import type { Reply, Request, Status } from '../../lib/messages';
import { grantEndpoint } from '../../lib/endpoint-permission';
import { downloadJson } from './bookmarks';
export function PairingPanel({
  status,
  request,
  onStatus,
}: {
  status: Status;
  request: (message: Request) => Promise<Reply & { ok: true }>;
  onStatus: (status: Status) => void;
}) {
  const [json, setJson] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expires, setExpires] = useState<number>();
  const [discard, setDiscard] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to pair this profile.');
      // A failed registration can still have durably staged a claim.
      try {
        const reply = await request({ type: 'status' });
        if (reply.status) onStatus(reply.status);
      } catch {
        /* retain visible error */
      }
    } finally {
      setBusy(false);
    }
  }
  const pending = status.pairing_pending;
  return (
    <section className="panel pairing" id="pairing">
      <div className="panel-heading">
        <span className="number">↔</span>
        <div>
          <h2>
            {status.enrolled
              ? 'Connect another profile'
              : pending
                ? 'Finish connecting'
                : 'Join your devices'}
          </h2>
          <p>
            {status.enrolled
              ? 'Create a private invitation for one new browser profile.'
              : 'Use a pairing bundle from an already connected profile.'}
          </p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status.enrolled ? (
        <>
          <p className="fine">
            The bundle contains your encryption keys. Transfer it privately, then remove the
            transfer copy after pairing. New registrations expire after 15 minutes.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const reply = await request({ type: 'pairing-create' });
                if (!reply.pairing) throw new Error('Pairing invitation was not returned.');
                downloadJson(reply.pairing, 'helium-synk-pairing.json');
                setExpires(reply.pairing.expires_at);
              })
            }
          >
            {busy ? 'Creating invitation…' : 'Save pairing bundle'}
            <span>↗</span>
          </button>
          {expires && (
            <p className="fine" role="status">
              Invitation saved. Register the new profile before{' '}
              {new Date(expires * 1000).toLocaleString()}.
            </p>
          )}
        </>
      ) : pending ? (
        <>
          <p>
            <strong>{pending.name}</strong> has a saved connection attempt.
          </p>
          <p className="endpoint">{pending.endpoint}</p>
          <p className="fine">
            Retry uses the same installation identity, including when the relay registered it but
            its reply was lost. An accepted claim can retry for one hour after invitation expiry.
          </p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await grantEndpoint(pending.endpoint);
                  const reply = await request({ type: 'pairing-retry' });
                  if (reply.status) onStatus(reply.status);
                })
              }
            >
              {busy ? 'Connecting…' : 'Retry connection'}
              <span>↗</span>
            </button>
            <button className="secondary" disabled={busy} onClick={() => setDiscard(true)}>
              Discard setup attempt
            </button>
          </div>
          {discard && (
            <div className="pairing-review" role="group" aria-label="Discard connection attempt">
              <p>
                This removes the saved setup secrets. The relay may already have registered this
                profile; revoke that installation from the relay if you discard it.
              </p>
              <p className="fine">
                Installation: <code>{pending.device_id}</code>
              </p>
              <div className="actions">
                <button className="secondary" disabled={busy} onClick={() => setDiscard(false)}>
                  Keep and retry
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const reply = await request({ type: 'pairing-discard' });
                      if (reply.status) onStatus(reply.status);
                      setDiscard(false);
                    })
                  }
                >
                  Discard saved attempt
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const bundle = parsePairingBundle(JSON.parse(json));
              await grantEndpoint(bundle.server_url);
              const reply = await request({ type: 'pairing-start', bundle, name });
              if (reply.status) onStatus(reply.status);
              setJson('');
              setName('');
            });
          }}
        >
          <label htmlFor="pairing-name">Profile name</label>
          <input
            id="pairing-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            autoComplete="off"
            placeholder="My MacBook · Helium"
          />
          <label htmlFor="pairing-bundle">Private pairing bundle JSON</label>
          <textarea
            id="pairing-bundle"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            required
            rows={4}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste the bundle saved by your connected profile"
          />
          <p className="fine">
            Each browser profile receives its own relay credential. This build unlocks automatically
            using keys saved in the local profile.
          </p>
          <button disabled={busy || !name.trim() || !json.trim()}>
            {busy ? 'Connecting…' : 'Connect with invitation'}
            <span>↗</span>
          </button>
        </form>
      )}
    </section>
  );
}
