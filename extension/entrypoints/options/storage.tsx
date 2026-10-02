import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Disclosure } from '@/components/disclosure';
import type { Reply, Request, Status } from '@/lib/messages';
import { HistoryRetentionControls } from './history-retention';
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
      <div className="panel-heading">
        <span className="number">06</span>
        <div>
          <h2>Local storage</h2>
          <p>Saved work stays on this profile while your relay is offline.</p>
        </div>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
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
          {storage.journal_records.toLocaleString()} / {storage.policy.max_journal.toLocaleString()}
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
          <Label htmlFor="storage-limit">Local storage limit (MiB)</Label>
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
          <Label htmlFor="pending-limit">Pending-work limit</Label>
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
          <p className="fine">
            At the limit, new collection pauses. Sync retries and deletion continue. Increasing a
            limit does not create free disk space.
          </p>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save limits'}
          </Button>
        </form>
      </Disclosure>
      <HistoryRetentionControls status={status} request={request} onStatus={onStatus} />
    </Card>
  );
}
