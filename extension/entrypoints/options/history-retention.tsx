import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';
import { Disclosure } from '@/components/disclosure';
import type { Reply, Request, Status } from '@/lib/messages';

export function HistoryRetentionControls({
  status,
  request,
  onStatus,
}: {
  status: Status;
  request: (request: Request) => Promise<Reply & { ok: true }>;
  onStatus: (status: Status) => void;
}) {
  const policy = status.history.retention?.policy;
  const [enabled, setEnabled] = useState(policy?.enabled ?? false);
  const [days, setDays] = useState(String(policy?.days ?? 90));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setEnabled(policy?.enabled ?? false);
    setDays(String(policy?.days ?? 90));
  }, [policy?.enabled, policy?.days]);
  return (
    <Disclosure
      title={`History retention · ${policy?.enabled ? `${policy.days} days` : 'off'}`}
      className="mt-4"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError('');
          try {
            const reply = await request({
              type: 'history-retention-set',
              policy: { enabled, days: Number(days) },
            });
            if (reply.status) onStatus(reply.status);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to save history retention.');
          } finally {
            setSaving(false);
          }
        }}
      >
        <FieldGroup>
          <Field orientation="horizontal">
            <Checkbox
              id="history-expiry"
              checked={enabled}
              onCheckedChange={(value) => setEnabled(value === true)}
            />
            <FieldLabel htmlFor="history-expiry">
              Automatically expire this profile’s synced history
            </FieldLabel>
          </Field>
          <Field>
            <FieldLabel htmlFor="history-retention-days">Keep visits for (days)</FieldLabel>
            <Input
              id="history-retention-days"
              type="number"
              min={1}
              max={3650}
              step={1}
              required
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </Field>
          <p className="fine">
            Expiry permanently removes old synced visits across connected profiles. Pending uploads
            stay until acknowledged. Browser history and existing exports/backups can retain copies.
          </p>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button className="w-fit max-w-full" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save history retention'}
          </Button>
        </FieldGroup>
      </form>
    </Disclosure>
  );
}
