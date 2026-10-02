import { ReviewDialog } from '@/components/review-dialog';
import { AlertDialogCancel } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel, FieldGroup, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import React, { useState } from 'react';
import { parsePairingBundle } from '@helium-synk/core';
import type { Reply, Request, Status } from '@/lib/messages';
import { grantEndpoint } from '@/lib/endpoint-permission';
import { downloadJson } from '@/entrypoints/options/bookmarks';
import { JsonFile } from '@/entrypoints/options/file-import';
import { Disclosure } from '@/components/disclosure';
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
    <Card className="panel pairing" id="pairing">
      <CardHeader className="panel-heading flex px-0 pt-0">
        <span className="number">↔</span>
        <div className="min-w-0 space-y-2">
          <CardTitle>
            <h1>
              {status.enrolled
                ? 'Add a device'
                : pending
                  ? 'Finish connecting'
                  : 'Connect to your devices'}
            </h1>
          </CardTitle>
          <CardDescription className="leading-6">
            {pending
              ? 'Retry your saved connection attempt.'
              : status.enrolled
                ? 'Create an invitation, then open it on your other device.'
                : 'On a connected device, open Devices → Add device and save an invitation.'}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        {error && (
          <Alert variant="destructive" className="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {status.enrolled ? (
          <>
            <ol className="pairing-steps">
              <li>
                <span>1</span>Save an invitation below.
              </li>
              <li>
                <span>2</span>Transfer it privately to your other device.
              </li>
              <li>
                <span>3</span>Open Synk there and choose Connect another device.
              </li>
            </ol>
            <p className="fine">
              For one device, valid for 15 minutes. Contains private keys; remove the transfer copy
              after connecting.
            </p>
            <Button
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
              {busy ? 'Creating invitation…' : 'Save invitation file'}
              <span aria-hidden="true">↗</span>
            </Button>
            {expires && (
              <p className="fine" role="status">
                Invitation saved. Open it on the other device before{' '}
                {new Date(expires * 1000).toLocaleString()}.
              </p>
            )}
          </>
        ) : pending ? (
          <>
            <p>
              Finish connecting <strong>{pending.name}</strong>.
            </p>
            <p className="endpoint">{pending.endpoint}</p>
            <p className="fine">
              Your connection attempt is saved. Retry when your sync server is available.
            </p>
            <div className="actions">
              <Button
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
                <span aria-hidden="true">↗</span>
              </Button>
            </div>
            <Disclosure title="Start over instead">
              <p>Retry first if the connection was interrupted.</p>
              <Button variant="outline" disabled={busy} onClick={() => setDiscard(true)}>
                Discard setup attempt
              </Button>
            </Disclosure>
            <ReviewDialog
              open={discard}
              onOpenChange={(open) => {
                if (!busy) setDiscard(open);
              }}
              title="Discard connection attempt"
              description="The relay may already have registered this installation. Review the saved attempt before removing its local setup secrets."
            >
              {error && (
                <Alert variant="destructive" className="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <p>
                This removes the saved setup secrets. The relay may already have registered this
                profile; revoke that installation from the relay if you discard it.
              </p>
              <p className="fine">
                Installation: <code>{pending.device_id}</code>
              </p>
              <div className="actions">
                <AlertDialogCancel disabled={busy} onClick={() => setDiscard(false)}>
                  Keep and retry
                </AlertDialogCancel>
                <Button
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
                </Button>
              </div>
            </ReviewDialog>
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
            <FieldGroup>
              <JsonFile
                id="pairing-bundle"
                label="Invitation file"
                value={json}
                onChange={setJson}
              />
              <Field>
                <FieldLabel htmlFor="pairing-name">Name this device</FieldLabel>
                <Input
                  id="pairing-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={100}
                  autoComplete="off"
                  aria-describedby="pairing-name-help"
                  placeholder="My laptop"
                />
                <FieldDescription id="pairing-name-help">
                  Choose a name you’ll recognize on your other devices.
                </FieldDescription>
              </Field>
              <Button className="w-fit max-w-full" disabled={busy || !name.trim() || !json.trim()}>
                {busy ? 'Connecting…' : 'Connect this device'}
                <span aria-hidden="true">↗</span>
              </Button>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
