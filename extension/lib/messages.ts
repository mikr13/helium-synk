import type { Credentials, LocalRecord } from '@helium-synk/core';

export type Request =
  | { type: 'status' }
  | { type: 'enroll'; credentials: Credentials; recovery_key: string }
  | { type: 'queue'; note: string }
  | { type: 'sync' }
  | { type: 'recovery' };
export interface Status {
  enrolled: boolean;
  name?: string;
  endpoint?: string;
  connection: 'not-connected' | 'syncing' | 'online' | 'waiting';
  error?: string;
  last_synced?: string;
  pending: number;
  records: LocalRecord[];
  browser_version: string;
}
export interface RecoveryBundle {
  account_id: string;
  recovery_key: string;
  server_url: string;
}
export type Reply =
  { ok: true; status?: Status; recovery?: RecoveryBundle } | { ok: false; error: string };
