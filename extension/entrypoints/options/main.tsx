import {
  ArrowUpRight,
  Bookmark,
  History,
  LayoutDashboard,
  PanelsTopLeft,
  ShieldCheck,
} from 'lucide-react';
import { Disclosure } from '@/components/disclosure';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { generateRecoveryKey, parseCredentials } from '@helium-synk/core';
import type { Reply, Request, Status } from '@/lib/messages';
import '@/entrypoints/options/style.css';
import { BookmarkPanel, downloadJson } from '@/entrypoints/options/bookmarks';
import { SessionPanel } from '@/entrypoints/options/sessions';
import { HistoryPanel } from '@/entrypoints/options/history';
import { PairingPanel } from '@/entrypoints/options/pairing';
import { KeyPanel } from '@/entrypoints/options/keys';
import { grantEndpoint } from '@/lib/endpoint-permission';

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
  const [recoveryJson, setRecoveryJson] = useState('');
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
    await grantEndpoint(credentials.server_url);
    const response = await request({
      type: 'enroll',
      credentials,
      recovery_key: key.trim() || generateRecoveryKey(),
      ...(recoveryJson.trim() ? { recovery_bundle: JSON.parse(recoveryJson) } : {}),
    });
    setStatus(response.status);
    setCredential('');
    setKey('');
    setRecoveryJson('');
  }
  async function recovery() {
    const result = await request({ type: 'recovery' });
    downloadJson(result.recovery, 'helium-synk-recovery.json');
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/icons/128.png" alt="" width="55" height="55" />
          <span>
            helium
            <br />
            <strong>synk</strong>
          </span>
        </div>
        <p className="eyebrow">YOUR PRIVATE ORBIT</p>
        <nav className="sidebar-nav" aria-label="Dashboard sections">
          <a className="nav active" href="#overview">
            <span className="nav-label">
              <LayoutDashboard aria-hidden="true" />
              Overview
            </span>
            <span>01</span>
          </a>
          {status?.enrolled && (
            <>
              <a className="nav" href="#bookmarks">
                <span className="nav-label">
                  <Bookmark aria-hidden="true" />
                  Bookmarks
                </span>
                <small>02</small>
              </a>
              <a className="nav" href="#sessions">
                <span className="nav-label">
                  <PanelsTopLeft aria-hidden="true" />
                  Sessions
                </span>
                <small>03</small>
              </a>
              <a className="nav" href="#history">
                <span className="nav-label">
                  <History aria-hidden="true" />
                  History
                </span>
                <small>04</small>
              </a>
              <a className="nav" href="#devices">
                <span className="nav-label">
                  <ShieldCheck aria-hidden="true" />
                  Access
                </span>
                <small>05</small>
              </a>
            </>
          )}
        </nav>
        <div className="aside-footer">
          <span className="dot" /> Local first.
          <br />
          Yours to host.
        </div>
      </aside>
      <main className="workspace" id="overview">
        <header className="workspace-header">
          <span className="eyebrow">HELIUM SYNK / OVERVIEW</span>
          <Badge variant="outline" className="tag">
            DEVELOPMENT BUILD
          </Badge>
        </header>
        <div className="hero">
          <div className="hero-index" aria-hidden="true">
            <strong>PRIVATE CONNECTION</strong>YOUR DEVICES / YOUR RELAY
            <br />
            LOCAL FIRST, ALWAYS
          </div>
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
          <Alert variant="destructive" className="error">
            <AlertDescription>{error || status?.error}</AlertDescription>
          </Alert>
        )}
        {!status && !error && <p>Opening your local database…</p>}
        {status && <PairingPanel status={status} request={request} onStatus={setStatus} />}
        {status?.enrolled && <KeyPanel status={status} request={request} onStatus={setStatus} />}
        {status && !status.enrolled && !status.pairing_pending && (
          <Card className="panel">
            <div className="panel-heading">
              <span className="number">01</span>
              <div>
                <h2>First profile setup</h2>
                <p>Start your account with a credential file from the relay.</p>
              </div>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(enroll);
              }}
            >
              <Label htmlFor="credential">Device credential JSON</Label>
              <Textarea
                id="credential"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                rows={5}
                required
                spellCheck={false}
                placeholder="Paste the file created by synk-server issue-device"
              />
              <Label htmlFor="key">
                Shared recovery key{' '}
                <span className="muted">/ leave blank on your first device</span>
              </Label>
              <Input
                id="key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                placeholder="Use the same key on your other devices"
              />
              <p className="fine">
                The first device creates the encryption key. Use a pairing invitation for later
                profiles. This build unlocks automatically from your browser profile.
              </p>
              <Disclosure
                className="recovery-import"
                title="Restore from a private recovery bundle"
              >
                <p className="fine">
                  Issue a fresh installation credential first. Recovery restores content keys and
                  downloads the relay journal; it does not restore local-only edits.
                </p>
                <Label htmlFor="recovery-bundle">Private recovery bundle JSON</Label>
                <Textarea
                  id="recovery-bundle"
                  value={recoveryJson}
                  onChange={(e) => setRecoveryJson(e.target.value)}
                  rows={4}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="Paste the separately saved private recovery bundle"
                />
              </Disclosure>
              <Button type="submit" disabled={busy}>
                {busy ? 'Connecting…' : 'Connect device'} <ArrowUpRight aria-hidden="true" />
              </Button>
            </form>
          </Card>
        )}
        {status?.enrolled && (
          <div className="columns">
            <Card className="panel device">
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
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const r = await request({ type: 'sync' });
                      setStatus(r.status);
                    })
                  }
                >
                  {busy ? 'Working…' : 'Sync now'} <ArrowUpRight aria-hidden="true" />
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => void run(recovery)}>
                  Save recovery bundle
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await request({ type: 'export' });
                      downloadJson(result.replica, 'helium-synk-local-replica.json');
                    })
                  }
                >
                  Export local replica
                </Button>
              </div>
            </Card>
            <Card className="panel">
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
                <Label htmlFor="note">Test note</Label>
                <Input
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={2_000}
                  required
                  placeholder="Hello from my Mac Mini"
                />
                <Button type="submit" disabled={busy || !note.trim()}>
                  Queue encrypted note <ArrowUpRight aria-hidden="true" />
                </Button>
              </form>
            </Card>
          </div>
        )}
        {status?.enrolled && (
          <BookmarkPanel status={status} request={request} onStatus={setStatus} />
        )}
        {status?.enrolled && (
          <Card className="records">
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
                  <Badge variant="outline" className="record-state">
                    {record.sequence ? 'RECEIVED BY SERVER' : 'QUEUED LOCALLY'}
                  </Badge>
                </article>
              ))
            ) : (
              <div className="empty">
                Your first signal will appear here. Open a second profile to verify it arrives.
              </div>
            )}
          </Card>
        )}
        {status?.enrolled && (
          <>
            <SessionPanel status={status} request={request} onStatus={setStatus} />
            <HistoryPanel status={status} request={request} onStatus={setStatus} />
          </>
        )}
        <footer className="workspace-footer">
          <span>PRIVATE BY DESIGN</span>
          <p>Bookmarks, sessions and history begin after you enable their collection.</p>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
