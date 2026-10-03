import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Disclosure } from '@/components/disclosure';
import type { Reply, Request, Status } from '@/lib/messages';

const MiB = 1024 * 1024;
export function SessionRetentionControls({
  status,
  request,
  onStatus,
}: {
  status: Status;
  request: (request: Request) => Promise<Reply & { ok: true }>;
  onStatus: (status: Status) => void;
}) {
  const policy = status.sessions.retention?.policy;
  const [enabled, setEnabled] = useState(policy?.enabled ?? false);
  const [days, setDays] = useState(String(policy?.days ?? 30));
  const [count, setCount] = useState(String(policy?.max_archives ?? 100));
  const [size, setSize] = useState(String((policy?.max_bytes ?? 50 * MiB) / MiB));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setEnabled(policy?.enabled ?? false);
    setDays(String(policy?.days ?? 30));
    setCount(String(policy?.max_archives ?? 100));
    setSize(String((policy?.max_bytes ?? 50 * MiB) / MiB));
  }, [policy?.enabled, policy?.days, policy?.max_archives, policy?.max_bytes]);
  return (
    <Disclosure
      title={`Session archive retention · ${policy?.enabled ? 'on' : 'off'}`}
      className="mt-4"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError('');
          try {
            const reply = await request({
              type: 'session-retention-set',
              policy: {
                enabled,
                days: Number(days),
                max_archives: Number(count),
                max_bytes: Number(size) * MiB,
              },
            });
            if (reply.status) onStatus(reply.status);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to save session retention.');
          } finally {
            setSaving(false);
          }
        }}
      >
        <FieldGroup>
          <Field orientation="horizontal">
            <Checkbox
              id="session-expiry"
              checked={enabled}
              onCheckedChange={(value) => setEnabled(value === true)}
            />
            <FieldLabel htmlFor="session-expiry">
              Automatically expire this profile’s session archives
            </FieldLabel>
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="session-retention-days">Keep for (days)</FieldLabel>
              <Input
                id="session-retention-days"
                type="number"
                min={1}
                max={3650}
                step={1}
                required
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="session-retention-count">Maximum archives</FieldLabel>
              <Input
                id="session-retention-count"
                type="number"
                min={1}
                max={10000}
                step={1}
                required
                value={count}
                onChange={(event) => setCount(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="session-retention-size">Content limit (MiB)</FieldLabel>
              <Input
                id="session-retention-size"
                type="number"
                min={1}
                max={1024}
                step={1}
                required
                value={size}
                onChange={(event) => setSize(event.target.value)}
              />
            </Field>
          </div>
          <p className="fine">
            Oldest closed, saved and superseded sessions expire first. Your latest current session,
            pending uploads and active restorations stay protected, so limits can be exceeded
            temporarily. Expired archives cannot be restored through Synk. Existing browser tabs
            stay open.
          </p>
          <Alert>
            <AlertDescription>
              Update every connected profile before enabling expiry. This removes archived content
              from Synk’s saved collections; encrypted relay copies and existing exports/backups
              remain. The content limit is not a disk-space limit. Turning expiry off cannot restore
              expired archives.
            </AlertDescription>
          </Alert>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-fit max-w-full" disabled={saving}>
            {saving ? 'Saving…' : 'Save session retention'}
          </Button>
        </FieldGroup>
      </form>
    </Disclosure>
  );
}
