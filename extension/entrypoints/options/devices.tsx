import React, { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Laptop, Plus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from '@/components/ui/item';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { KeySummary } from '@/lib/messages';
import { PageTitle } from '@/entrypoints/options/home';
import { PairingPanel } from '@/entrypoints/options/pairing';
import { request, useAction, useSynk } from '@/entrypoints/options/state';

export function DevicesPage() {
  const { onStatus } = useSynk();
  const { busy, error, run } = useAction();
  const [keys, setKeys] = useState<KeySummary>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let active = true;
    request({ type: 'keys-list' })
      .then((reply) => {
        if (active) setKeys(reply.keys);
      })
      .catch((cause) => {
        if (active)
          setLoadError(cause instanceof Error ? cause.message : 'Unable to load devices.');
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <PageTitle
        title="Your devices"
        description="Every connected browser profile has its own place here."
      />
      <div className="page-actions">
        <Button asChild>
          <Link to="/devices/add">
            <Plus aria-hidden="true" /> Add device
          </Link>
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const reply = await request({ type: 'keys-list' });
              setKeys(reply.keys);
              onStatus(reply.status);
              setLoadError('');
            })
          }
        >
          Refresh
        </Button>
      </div>
      {(error || loadError) && (
        <Alert variant="destructive">
          <AlertDescription>{error || loadError}</AlertDescription>
        </Alert>
      )}
      <Card className="py-0">
        <CardContent>
          <ul className="divide-y">
            {keys ? (
              keys.devices.map((device) => (
                <Item asChild key={device.device_id} className="px-0 py-5">
                  <li>
                    <ItemMedia>
                      <Laptop className="size-5 text-primary" aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="wrap-anywhere">{device.name}</ItemTitle>
                      <ItemDescription>
                        {device.device_id === keys.device_id
                          ? 'This device'
                          : device.revoked
                            ? 'Access removed'
                            : 'Access to your sync'}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Badge variant="outline">
                        {device.revoked
                          ? 'Removed'
                          : device.device_id === keys.device_id
                            ? 'You'
                            : 'Linked'}
                      </Badge>
                    </ItemActions>
                  </li>
                </Item>
              ))
            ) : (
              <li className="py-5">
                {loadError ? 'Retry to load your devices.' : 'Loading devices…'}
              </li>
            )}
          </ul>
        </CardContent>
      </Card>
      <Link to="/settings/security" className="text-link">
        Manage device access <ArrowRight aria-hidden="true" />
      </Link>
    </>
  );
}

export function AddDevicePage() {
  const { status, onStatus } = useSynk();
  if (!status) return null;
  return (
    <div className="setup-form-page">
      <Link to="/devices" className="text-link">
        <ArrowLeft aria-hidden="true" /> Devices
      </Link>
      <PairingPanel status={status} request={request} onStatus={onStatus} />
    </div>
  );
}
