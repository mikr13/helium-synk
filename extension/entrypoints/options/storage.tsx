import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';
import { Disclosure } from '@/components/disclosure';
import type { Reply, Request, Status } from '@/lib/messages';
import { HistoryRetentionControls } from './history-retention';
import { SessionRetentionControls } from './session-retention';
const MiB = 1024 * 1024;
export function StoragePanel({
  status,
  request,
  onStatus,
}: {
  status: Status;
  request: (request: Request) => Promise<Reply & { ok: true }>;
  onStatus: (status: Status) => void;
}) {
  const storage = status.storage;
  const [bytes, setBytes] = useState(String((storage?.policy.max_bytes ?? 512 * MiB) / MiB));
  const [pending, setPending] = useState(String(storage?.policy.max_pending ?? 100_000));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (storage) {
      setBytes(String(storage.policy.max_bytes / MiB));
      setPending(String(storage.policy.max_pending));
    }
  }, [storage?.policy.max_bytes, storage?.policy.max_pending]);
  if (!storage) return null;
  return (
    <Card id="storage" className="panel">
      <CardHeader className="panel-heading flex px-0 pt-0">
        <span className="number">06</span>
        <div className="min-w-0 space-y-2">
          <CardTitle>
            <h2>Local storage</h2>
          </CardTitle>
          <CardDescription className="leading-6">
            Saved work stays on this profile while your relay is offline.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <dl className="storage-metrics grid grid-cols-1 items-center gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-y-3">
          <dt>Browser storage estimate</dt>
          <dd>
            {storage.estimated_bytes === undefined
              ? 'Unavailable'
              : `${(storage.estimated_bytes / MiB).toFixed(1)} MiB`}{' '}
            / {Math.round(storage.policy.max_bytes / MiB)} MiB
          </dd>
          <dt>Pending operations and capture tasks</dt>
          <dd>
            {storage.pending.toLocaleString()} / {storage.policy.max_pending.toLocaleString()}
          </dd>
          <dt>Journal records</dt>
          <dd>
            {storage.journal_records.toLocaleString()} /{' '}
            {storage.policy.max_journal.toLocaleString()}
          </dd>
        </dl>
        {storage.warning && (
          <Alert className="notice mt-4" role="status">
            <AlertDescription>{storage.warning}</AlertDescription>
          </Alert>
        )}
        <Disclosure title="Storage limits" className="mt-4">
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setSaving(true);
              setError('');
              try {
                const reply = await request({
                  type: 'storage-set',
                  policy: {
                    ...storage.policy,
                    max_bytes: Number(bytes) * MiB,
                    max_pending: Number(pending),
                  },
                });
                if (reply.status) onStatus(reply.status);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Unable to save storage limits.');
              } finally {
                setSaving(false);
              }
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="storage-limit">Local storage limit (MiB)</FieldLabel>
                <Input
                  id="storage-limit"
                  type="number"
                  min={16}
                  max={8192}
                  step={1}
                  required
                  value={bytes}
                  onChange={(e) => setBytes(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="pending-limit">Pending-work limit</FieldLabel>
                <Input
                  id="pending-limit"
                  type="number"
                  min={100}
                  max={1_000_000}
                  step={1}
                  required
                  value={pending}
                  onChange={(e) => setPending(e.target.value)}
                />
              </Field>
              <p className="fine">
                At the limit, new collection pauses. Sync retries and deletion continue. Increasing
                a limit does not create free disk space.
              </p>
              {error && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button className="w-fit max-w-full" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save limits'}
              </Button>
            </FieldGroup>
          </form>
        </Disclosure>
        <HistoryRetentionControls status={status} request={request} onStatus={onStatus} />
        <SessionRetentionControls status={status} request={request} onStatus={onStatus} />
      </CardContent>
    </Card>
  );
}
