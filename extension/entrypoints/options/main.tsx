import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { generateRecoveryKey, parseCredentials } from '@helium-synk/core';
import type { Reply, Request, Status } from '../../lib/messages';
import './style.css';
import { BookmarkPanel, downloadJson } from './bookmarks';

async function request(message: Request): Promise<Reply & { ok: true }> {
  const response = (await browser.runtime.sendMessage(message)) as Reply;
  if (!response?.ok)
    throw new Error(
      response && !response.ok ? response.error : 'The background worker did not respond.',
    );
  return response;
}
function App() {
  const [status, setStatus] = useState<Status>();
  const [credential, setCredential] = useState('');
  const [key, setKey] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      request({ type: 'status' })
        .then((r) => {
          if (active) setStatus(r.status);
        })
        .catch((e) => {
          if (active) setError(String(e.message));
        });
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  async function enroll() {
    const credentials = parseCredentials(JSON.parse(credential));
    const origin = `${credentials.server_url}/*`;
    const hostname = new URL(credentials.server_url).hostname;
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      if (!hostname.endsWith('.ts.net'))
        throw new Error('This build supports localhost and Tailscale HTTPS endpoints.');
      if (!(await browser.permissions.request({ origins: [origin] })))
        throw new Error('Server access permission was not granted.');
    }
    const response = await request({
      type: 'enroll',
      credentials,
      recovery_key: key.trim() || generateRecoveryKey(),
    });
    setStatus(response.status);
    setCredential('');
    setKey('');
  }
  async function recovery() {
    const result = await request({ type: 'recovery' });
    downloadJson(result.recovery, 'helium-synk-recovery.json');
  }
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="brand-mark">h.</span>
          <span>
            helium
            <br />
            <strong>synk</strong>
          </span>
        </div>
        <p className="eyebrow">YOUR PRIVATE ORBIT</p>
        <div className="nav active">
          Overview <span>01</span>
        </div>
        <a className="nav" href="#bookmarks">
          Bookmarks <small>Preview</small>
        </a>
        <div className="nav">
          Sessions <small>Planned</small>
        </div>
        <div className="nav">
          History <small>Planned</small>
        </div>
        <div className="aside-footer">
          <span className="dot" /> Local first.
          <br />
          Yours to host.
        </div>
      </aside>
      <main>
        <header>
          <span className="eyebrow">HELIUM SYNK / OVERVIEW</span>
          <span className="tag">DEVELOPMENT BUILD</span>
        </header>
        <div className="hero">
          <p className="eyebrow">A PLACE FOR EVERY DEVICE</p>
          <h1>
            Pick up where
            <br />
            you left off<span>.</span>
          </h1>
          <p>
            Private sync, with a home of its own.
            <br />
            Your Mac Mini connects the dots. Your devices keep their data.
          </p>
        </div>
        <div className="status-strip">
          <div>
            <span className={`dot ${status?.connection === 'online' ? 'green' : ''}`} />
            {status?.connection === 'online'
              ? 'Connected'
              : status?.enrolled
                ? 'Waiting to sync'
                : 'Ready to connect'}
          </div>
          <div>
            <b>{status?.pending ?? 0}</b> pending
          </div>
          <div>
            <b>{status?.records.length ?? 0}</b> test records
          </div>
        </div>
        {(error || status?.error) && (
          <div className="error" role="alert">
            {error || status?.error}
          </div>
        )}
        {!status && !error && <p>Opening your local database…</p>}
        {status && !status.enrolled && (
          <section className="panel">
            <div className="panel-heading">
              <span className="number">01</span>
              <div>
                <h2>Connect this device</h2>
                <p>Use a separate credential file for each browser profile.</p>
              </div>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(enroll);
              }}
            >
              <label htmlFor="credential">Device credential JSON</label>
              <textarea
                id="credential"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                rows={5}
                required
                spellCheck={false}
                placeholder="Paste the file created by synk-server issue-device"
              />
              <label htmlFor="key">
                Shared recovery key{' '}
                <span className="muted">/ leave blank on your first device</span>
              </label>
              <input
                id="key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                placeholder="Use the same key on your other devices"
              />
              <p className="fine">
                The first device creates the encryption key. Save its recovery file, then use that
                key when connecting another device. This build unlocks automatically from your
                browser profile.
              </p>
              <button disabled={busy}>
                {busy ? 'Connecting…' : 'Connect device'} <span>↗</span>
              </button>
            </form>
          </section>
        )}
        {status?.enrolled && (
          <div className="columns">
            <section className="panel device">
              <p className="eyebrow">THIS DEVICE</p>
              <h2>{status.name}</h2>
              <p className="endpoint">{status.endpoint}</p>
              <dl>
                <dt>Last successful sync</dt>
                <dd>
                  {status.last_synced ? new Date(status.last_synced).toLocaleString() : 'Not yet'}
                </dd>
                <dt>Chromium version</dt>
                <dd>{status.browser_version}</dd>
                <dt>Local persistence</dt>
                <dd>IndexedDB · survives restarts</dd>
              </dl>
              <div className="actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const r = await request({ type: 'sync' });
                      setStatus(r.status);
                    })
                  }
                >
                  {busy ? 'Working…' : 'Sync now'} <span>↗</span>
                </button>
                <button className="secondary" disabled={busy} onClick={() => void run(recovery)}>
                  Save recovery key
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await request({ type: 'export' });
                      downloadJson(result.replica, 'helium-synk-local-replica.json');
                    })
                  }
                >
                  Export local replica
                </button>
              </div>
            </section>
            <section className="panel">
              <p className="eyebrow">CHECK THE CONNECTION</p>
              <h2>Send a small signal.</h2>
              <p>
                A test note proves that encrypted data can travel between your devices. It stays
                queued if the server is offline.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const r = await request({ type: 'queue', note });
                    setStatus(r.status);
                    setNote('');
                  });
                }}
              >
                <label htmlFor="note">Test note</label>
                <input
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={2_000}
                  required
                  placeholder="Hello from my Mac Mini"
                />
                <button disabled={busy || !note.trim()}>
                  Queue encrypted note <span>↗</span>
                </button>
              </form>
            </section>
          </div>
        )}
        {status?.enrolled && (
          <BookmarkPanel status={status} request={request} onStatus={setStatus} />
        )}
        {status?.enrolled && (
          <section className="records">
            <div className="records-heading">
              <h2>Signals from your devices</h2>
              <span className="eyebrow">LATEST 100</span>
            </div>
            {status.records.length ? (
              status.records.map((record) => (
                <article key={record.operation_id}>
                  <span className="signal">↗</span>
                  <div>
                    <h3>{record.payload.note}</h3>
                    <p>
                      {record.envelope.device_id === undefined
                        ? ''
                        : record.envelope.device_id.slice(0, 8)}{' '}
                      · {new Date(record.payload.created_at).toLocaleString()}
                    </p>
                  </div>
                  <span className="record-state">
                    {record.sequence ? 'RECEIVED BY SERVER' : 'QUEUED LOCALLY'}
                  </span>
                </article>
              ))
            ) : (
              <div className="empty">
                Your first signal will appear here. Open a second profile to verify it arrives.
              </div>
            )}
          </section>
        )}
        <footer>
          <span>PRIVATE BY DESIGN</span>
          <p>
            Bookmark capture begins after you review and enable its merge. History and sessions are
            not collected yet.
          </p>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
