import { ReviewDialog } from '@/components/review-dialog';
import { AlertDialogCancel } from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel, FieldContent, FieldDescription } from '@/components/ui/field';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import React, { useEffect, useState } from 'react';
import type { Reply, Request, Status, KeySummary } from '@/lib/messages';
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
      setReview(false);
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
    <Card className="panel key-panel" id="devices">
      <CardHeader className="panel-heading flex px-0 pt-0">
        <span className="number">◇</span>
        <div className="min-w-0 space-y-2">
          <CardTitle>
            <h2>Installation access</h2>
          </CardTitle>
          <CardDescription className="leading-6">
            Remove an installation and create new encryption keys for your remaining profiles.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <p className="fine">
          Content-key generation {status.key_epoch ?? 1}. Old keys and downloaded data remain known
          to removed installations. After rotation, save an updated recovery file.
        </p>
        {error && (
          <Alert variant="destructive" className="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {done && (
          <Alert role="status" className="key-complete">
            <AlertDescription>
              Access updated. Your profiles now use content-key generation {done}. Save a new
              recovery file in Settings → Recovery & backups.
            </AlertDescription>
          </Alert>
        )}
        {pending && (
          <div className="pairing-review">
            <strong>A rotation is saved</strong>
            <p className="fine">
              Retry keeps the same keys and request. The relay may already have committed it even if
              its reply was lost.
            </p>
            <div className="actions">
              <Button
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
                <span aria-hidden="true">↗</span>
              </Button>
              <Button
                variant="outline"
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
              </Button>
            </div>
          </div>
        )}
        <ul className="key-devices">
          {keys?.devices.map((d) => (
            <li key={d.device_id}>
              <Field orientation="horizontal">
                <Checkbox
                  id={`remove-${d.device_id}`}
                  disabled={busy || d.revoked || d.device_id === keys.device_id}
                  checked={selected.includes(d.device_id)}
                  onCheckedChange={(checked) => {
                    setSelected(
                      checked === true
                        ? [...selected, d.device_id]
                        : selected.filter((id) => id !== d.device_id),
                    );
                    setReview(false);
                    setDone(undefined);
                  }}
                />
                <FieldContent>
                  <FieldLabel htmlFor={`remove-${d.device_id}`}>
                    <strong>{d.name}</strong>
                  </FieldLabel>
                  <FieldDescription>
                    {d.device_id === keys.device_id
                      ? 'This profile'
                      : d.revoked
                        ? 'Access removed'
                        : d.ready
                          ? 'Ready for key rotation'
                          : 'Needs to sync with an upgraded client'}
                  </FieldDescription>
                </FieldContent>
              </Field>
            </li>
          ))}
        </ul>
        {!keys && !error && <p className="fine">Loading installations…</p>}
        <div className="actions">
          <Button variant="outline" disabled={busy} onClick={() => void run(load)}>
            Refresh installations
          </Button>
          <Button
            disabled={busy || !keys || (!selected.length && !pending)}
            onClick={() => setReview(true)}
          >
            Review removal<span aria-hidden="true">↗</span>
          </Button>
        </div>
        <ReviewDialog
          open={review}
          onOpenChange={(open) => {
            if (!busy) setReview(open);
          }}
          title="Review installation removal"
          description="Review who will keep access before rotating your account keys."
        >
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
            <Alert variant="destructive" className="error">
              <AlertDescription>
                Sync or select these installations for removal first:{' '}
                {retainedUnready.map((d) => d.name).join(', ')}.
              </AlertDescription>
            </Alert>
          )}
          <div className="actions">
            <AlertDialogCancel disabled={busy} onClick={() => setReview(false)}>
              Keep access
            </AlertDialogCancel>
            <Button
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
              <span aria-hidden="true">↗</span>
            </Button>
          </div>
        </ReviewDialog>
      </CardContent>
    </Card>
  );
}
