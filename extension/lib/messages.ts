import type {
  Credentials,
  LocalRecord,
  BookmarkImport,
  RootSelection,
  NativeBookmark,
  SessionSnapshot,
  SessionRestoreSummary,
  RestoreSelection,
  SynkDatabase,
  HistorySetup,
  PairingBundle,
  pairingSummary,
  RecoveryBundle,
  LocalStoragePolicy,
  LocalStorageStatus,
} from '@helium-synk/core';

export type Request =
  | { type: 'status' }
  | { type: 'storage-set'; policy: LocalStoragePolicy }
  | { type: 'pairing-create' }
  | { type: 'pairing-start'; bundle: PairingBundle; name: string }
  | { type: 'pairing-retry' }
  | { type: 'pairing-discard' }
  | { type: 'keys-list' }
  | { type: 'keys-rotate'; revoke_ids: string[]; replace?: boolean }
  | { type: 'keys-retry' }
  | { type: 'history-enable'; days: number; exclusions: string[] }
  | { type: 'history-pause' }
  | { type: 'history-query'; query?: Parameters<SynkDatabase['queryHistory']>[0] }
  | { type: 'history-delete'; ids: string[] }
  | { type: 'history-clear'; source_id?: string }
  | { type: 'session-enable' }
  | { type: 'session-pause' }
  | { type: 'session-save' }
  | { type: 'session-list'; offset?: number }
  | { type: 'session-detail'; id: string }
  | { type: 'session-restore'; id: string; snapshot_id: string; selection: RestoreSelection }
  | { type: 'session-resume'; id: string }
  | { type: 'session-cancel'; id: string }
  | { type: 'enroll'; credentials: Credentials; recovery_key: string; recovery_bundle?: unknown }
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
  key_epoch?: number;
  rotation_pending?: {
    rotation_id: string;
    key_epoch: number;
    from_epoch: number;
    revoke_ids: string[];
  };
  pairing_pending?: ReturnType<typeof pairingSummary>;
  name?: string;
  endpoint?: string;
  connection: 'not-connected' | 'syncing' | 'online' | 'waiting';
  error?: string;
  last_synced?: string;
  pending: number;
  records: LocalRecord[];
  browser_version: string;
  storage: LocalStorageStatus;
  history: {
    enabled: boolean;
    phase: HistorySetup['phase'] | 'off';
    visits: number;
    pending: number;
    exclusions: string[];
    error?: string;
  };
  sessions: {
    enabled: boolean;
    snapshots: number;
    incomplete: number;
    error?: string;
    restores: SessionRestoreSummary[];
  };
  bookmarks: {
    phase: 'off' | 'preview' | 'active';
    nodes: number;
    conflicts: number;
    captured: number;
    error?: string;
    interrupted: { id: string; message: string }[];
  };
}
export type SessionListItem = Pick<
  SessionSnapshot,
  'id' | 'source_id' | 'source_name' | 'source_revision' | 'kind' | 'captured_at' | 'previous_of'
> & { windows: number; tabs: number; latest: boolean };
export interface KeySummary {
  key_epoch: number;
  device_id: string;
  devices: { device_id: string; name: string; revoked: boolean; ready: boolean }[];
}
export type Reply =
  | {
      ok: true;
      status?: Status;
      recovery?: RecoveryBundle;
      pairing?: PairingBundle;
      keys?: KeySummary;
      replica?: unknown;
      history_page?: Awaited<ReturnType<SynkDatabase['queryHistory']>>;
      history_sources?: { id: string; name: string }[];
      session_list?: SessionListItem[];
      session_more?: boolean;
      session_snapshot?: SessionSnapshot;
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
