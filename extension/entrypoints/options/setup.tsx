import React, { useState } from 'react';
import { Link, Navigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, FileKey2, Laptop, Server } from 'lucide-react';
import { generateRecoveryKey, parseCredentials } from '@helium-synk/core';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemGroup,
} from '@/components/ui/item';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Disclosure } from '@/components/disclosure';
import { JsonFile } from '@/entrypoints/options/file-import';
import { PairingPanel } from '@/entrypoints/options/pairing';
import { CollectionChoices } from '@/entrypoints/options/home';
import { grantEndpoint } from '@/lib/endpoint-permission';
import { request, useAction, useSynk } from '@/entrypoints/options/state';

export function SetupWelcome() {
  const { status } = useSynk();
  if (status?.enrolled) return <Navigate to="/" replace />;
  if (status?.pairing_pending) return <Navigate to="/setup/join" replace />;
  return (
    <div className="setup-page">
      <p className="eyebrow">WELCOME TO HELIUM SYNK</p>
      <h1>
        Your browser.
        <br />
        <span>Across your devices.</span>
      </h1>
      <p className="page-description">Bring your bookmarks, tabs and history together privately.</p>
      <ItemGroup className="setup-choices">
        <Item asChild variant="outline" className="primary-choice p-4 sm:p-6">
          <Link to="/setup/join">
            <ItemMedia>
              <Laptop className="size-6 text-primary" aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="text-base sm:text-lg">Connect another device</ItemTitle>
              <ItemDescription>Already using Synk? Join with an invitation.</ItemDescription>
            </ItemContent>
            <ItemActions>
              <ArrowRight className="size-4 text-primary" aria-hidden="true" />
            </ItemActions>
          </Link>
        </Item>
        <Item asChild variant="outline" className="bg-card p-4 sm:p-6">
          <Link to="/setup/first">
            <ItemMedia>
              <Server className="size-6 text-primary" aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="text-base sm:text-lg">Set up my first device</ItemTitle>
              <ItemDescription>Start with a connection file from your sync server.</ItemDescription>
            </ItemContent>
            <ItemActions>
              <ArrowRight className="size-4 text-primary" aria-hidden="true" />
            </ItemActions>
          </Link>
        </Item>
      </ItemGroup>
      <Link to="/setup/recover" className="text-link">
        <FileKey2 aria-hidden="true" /> Restore from a recovery file
      </Link>
    </div>
  );
}

export function SetupJoin() {
  const { status, onStatus } = useSynk();
  if (status?.enrolled) return <Navigate to="/setup/collections" replace />;
  if (!status) return null;
  return (
    <div className="setup-form-page">
      <Link to="/setup" className="text-link">
        <ArrowLeft aria-hidden="true" /> Setup
      </Link>
      <PairingPanel status={status} request={request} onStatus={onStatus} />
    </div>
  );
}

export function SetupFirst({ recovery = false }: { recovery?: boolean }) {
  const { status, onStatus } = useSynk();
  const { busy, error, run } = useAction();
  const [credential, setCredential] = useState('');
  const [bundle, setBundle] = useState('');
  if (status?.enrolled) return <Navigate to="/setup/collections" replace />;
  if (status?.pairing_pending) return <Navigate to="/setup/join" replace />;
  return (
    <div className="setup-form-page">
      <Link to="/setup" className="text-link">
        <ArrowLeft aria-hidden="true" /> Setup
      </Link>
      <Card className="panel">
        <CardHeader className="px-0">
          <p className="eyebrow">CONNECT THIS DEVICE</p>
          <CardTitle>
            <h1>{recovery ? 'Restore your sync.' : 'Start your private sync.'}</h1>
          </CardTitle>
          <CardDescription>
            {recovery
              ? 'Use a new connection file and your saved recovery file.'
              : 'Choose the connection file provided by the person running your sync server.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 px-0">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const credentials = parseCredentials(JSON.parse(credential));
                const recoveryBundle: unknown = recovery ? JSON.parse(bundle) : undefined;
                await grantEndpoint(credentials.server_url);
                const reply = await request({
                  type: 'enroll',
                  credentials,
                  recovery_key: generateRecoveryKey(),
                  ...(recovery ? { recovery_bundle: recoveryBundle } : {}),
                });
                onStatus(reply.status);
                setCredential('');
                setBundle('');
              });
            }}
          >
            <FieldGroup>
              <JsonFile
                id="credential"
                label={recovery ? 'New connection file' : 'Connection file'}
                value={credential}
                onChange={setCredential}
              />
              {recovery && (
                <JsonFile
                  id="recovery-bundle"
                  label="Recovery file"
                  value={bundle}
                  onChange={setBundle}
                />
              )}
              <Button
                className="w-fit max-w-full"
                type="submit"
                disabled={busy || !credential.trim() || (recovery && !bundle.trim())}
              >
                {busy ? 'Connecting…' : recovery ? 'Restore and connect' : 'Connect this device'}
                <ArrowRight aria-hidden="true" />
              </Button>
            </FieldGroup>
          </form>
          <Disclosure title={recovery ? 'What does recovery restore?' : 'I run the sync server'}>
            {recovery ? (
              <p>
                Recovery restores your encryption keys and downloads saved data from the server. It
                cannot restore edits that never reached the server. Use a fresh connection file for
                this browser profile.
              </p>
            ) : (
              <>
                <p>
                  On the server, issue the first connection file and transfer it privately to this
                  device.
                </p>
                <pre className="setup-command">
                  synk-server --database /path/to/relay.sqlite issue-device --name "My laptop"
                  --server-url https://YOUR-MINI.YOUR-TAILNET.ts.net --output connection.json
                </pre>
                <p>
                  After connecting, use Devices → Add device for every other browser profile. Each
                  needs its own invitation.
                </p>
              </>
            )}
          </Disclosure>
        </CardContent>
      </Card>
    </div>
  );
}

export function SetupCollections() {
  return (
    <>
      <div className="page-title">
        <p className="eyebrow">DEVICE SET UP</p>
        <h1>Choose what to sync.</h1>
        <p>Each collection starts only when you enable it.</p>
      </div>
      <CollectionChoices />
      <Link to="/" className="text-link">
        Go to Home <ArrowRight aria-hidden="true" />
      </Link>
    </>
  );
}
