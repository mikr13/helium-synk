import React, { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Download } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import {
  ItemGroup,
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from '@/components/ui/item';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyDescription } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Disclosure } from '@/components/disclosure';
import { StoragePanel } from '@/entrypoints/options/storage';
import { KeyPanel } from '@/entrypoints/options/keys';
import { downloadJson } from '@/entrypoints/options/bookmarks';
import { PageTitle } from '@/entrypoints/options/home';
import { request, useAction, useSynk } from '@/entrypoints/options/state';

export function SettingsPage() {
  const { status, onStatus } = useSynk();
  if (!status) return null;
  return (
    <>
      <PageTitle title="Settings" description="Storage, retention and recovery for this profile." />
      <StoragePanel status={status} request={request} onStatus={onStatus} />
      <ItemGroup className="divide-y border bg-card">
        {[
          {
            to: '/settings/recovery',
            title: 'Recovery & backups',
            description: 'Save your keys and local data.',
          },
          {
            to: '/settings/security',
            title: 'Device access',
            description: 'Remove a device and rotate encryption keys.',
          },
          {
            to: '/settings/diagnostics',
            title: 'Diagnostics',
            description: 'Connection details and test messages.',
          },
        ].map(({ to, title, description }) => (
          <div role="listitem" key={to}>
            <Item asChild className="p-5">
              <Link to={to}>
                <ItemContent>
                  <ItemTitle>{title}</ItemTitle>
                  <ItemDescription>{description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ArrowRight className="size-4 text-primary" aria-hidden="true" />
                </ItemActions>
              </Link>
            </Item>
          </div>
        ))}
      </ItemGroup>
    </>
  );
}

export function RecoveryPage() {
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState('');
  return (
    <>
      <PageTitle
        title="Recovery & backups"
        description="Keep a private copy in case a device is lost."
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {saved && (
        <Alert className="notice" role="status">
          <AlertDescription>{saved}</AlertDescription>
        </Alert>
      )}
      <Card className="panel">
        <CardHeader className="px-0">
          <CardTitle>
            <h2>Recovery file</h2>
          </CardTitle>
          <CardDescription>
            Your encryption keys. Needed to connect a new profile when no connected device remains.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-0">
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const reply = await request({ type: 'recovery' });
                if (!reply.recovery) throw new Error('No recovery file was returned.');
                downloadJson(reply.recovery, 'helium-synk-recovery.json');
                setSaved(
                  'Recovery file saved. Store it somewhere private, separate from your server backups.',
                );
              })
            }
          >
            <Download aria-hidden="true" />
            Save recovery file
          </Button>
          <p className="fine">
            This file contains private keys. Synk unlocks automatically using keys stored in your
            browser profile.
          </p>
        </CardContent>
      </Card>
      <Card className="panel">
        <CardHeader className="px-0">
          <CardTitle>
            <h2>Local data backup</h2>
          </CardTitle>
          <CardDescription>
            Includes this profile’s saved data and changes waiting to sync.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-0">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const reply = await request({ type: 'export' });
                downloadJson(reply.replica, 'helium-synk-local-replica.json');
                setSaved('Local data backup saved. Keep it private.');
              })
            }
          >
            <Download aria-hidden="true" />
            Save local data backup
          </Button>
          <Disclosure title="Recovery limits">
            <p>
              Synced deletions reach every device. Recovery files restore keys and server data, not
              unsent changes. Local data exports preserve those changes for recovery work; automatic
              import of a complete replica is not available yet.
            </p>
          </Disclosure>
        </CardContent>
      </Card>
    </>
  );
}

export function SecurityPage() {
  const { status, onStatus } = useSynk();
  if (!status) return null;
  return (
    <>
      <PageTitle
        title="Device access"
        description="Review and remove a device’s access to future synced data."
      />
      <KeyPanel status={status} request={request} onStatus={onStatus} />
    </>
  );
}

export function DiagnosticsPage() {
  const { status, onStatus } = useSynk();
  const { busy, error, run } = useAction();
  const [note, setNote] = useState('');
  if (!status) return null;
  return (
    <>
      <PageTitle title="Diagnostics" description="Check the connection between your devices." />
      <Card className="panel">
        <CardHeader className="px-0">
          <CardTitle>
            <h2>Connection details</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 px-0">
          <dl className="space-y-4">
            <div>
              <dt className="mt-0">Server</dt>
              <dd className="endpoint">{status.endpoint}</dd>
            </div>
            <div>
              <dt className="mt-0">Browser version</dt>
              <dd>{status.browser_version}</dd>
            </div>
            <div>
              <dt className="mt-0">Changes waiting to sync</dt>
              <dd>{status.pending}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card className="panel">
        <CardHeader className="px-0">
          <CardTitle>
            <h2>Send a test message</h2>
          </CardTitle>
          <CardDescription>
            Look for the same message in Diagnostics on your other device.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-0">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const reply = await request({ type: 'queue', note });
                onStatus(reply.status);
                setNote('');
              });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="note">Test message</FieldLabel>
                <Input
                  id="note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={2_000}
                  required
                  placeholder="Hello from my laptop"
                />
              </Field>
              <Button className="w-fit max-w-full" disabled={busy || !note.trim()}>
                {busy ? 'Sending…' : 'Send test message'}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <Card className="panel records">
        <CardHeader className="px-0">
          <CardTitle>
            <h2>Test messages</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 px-0">
          {status.records.length ? (
            status.records.map((record) => (
              <article key={record.operation_id}>
                <div>
                  <h3>{record.payload.note}</h3>
                  <p>
                    {record.envelope.device_id.slice(0, 8)} ·{' '}
                    {new Date(record.payload.created_at).toLocaleString()}
                  </p>
                </div>
                <Badge variant="outline" className="record-state">
                  {record.sequence ? 'Synced' : 'Waiting to send'}
                </Badge>
              </article>
            ))
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyDescription>No test messages yet.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </>
  );
}
