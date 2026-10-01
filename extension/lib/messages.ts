import type {
  Credentials,
  LocalRecord,
  BookmarkImport,
  RootSelection,
  NativeBookmark,
} from '@helium-synk/core';

export type Request =
  | { type: 'status' }
  | { type: 'enroll'; credentials: Credentials; recovery_key: string }
  | { type: 'queue'; note: string }
  | { type: 'sync' }
  | { type: 'recovery' }
  | { type: 'export' }
  | { type: 'bookmark-roots' }
  | { type: 'bookmark-preview'; roots?: RootSelection }
  | { type: 'bookmark-confirm'; id: string }
  | { type: 'bookmark-review'; id: string }
  | { type: 'bookmark-resolve'; id: string; native_id?: string };
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
  bookmarks: {
    phase: 'off' | 'preview' | 'active';
    nodes: number;
    conflicts: number;
    captured: number;
    error?: string;
    interrupted: { id: string; message: string }[];
  };
}
export interface RecoveryBundle {
  account_id: string;
  recovery_key: string;
  server_url: string;
}
export type Reply =
  | {
      ok: true;
      status?: Status;
      recovery?: RecoveryBundle;
      replica?: unknown;
      bookmark_preview?: BookmarkImport;
      bookmark_roots?: {
        id: string;
        title: string;
        role: 'bar' | 'other' | 'mobile';
        syncing: boolean;
      }[];
      bookmark_candidates?: NativeBookmark[];
    }
  | { ok: false; error: string };
