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
} from '@helium-synk/core';

export type Request =
  | { type: 'status' }
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
export interface RecoveryBundle {
  account_id: string;
  recovery_key: string;
  history_index_key: string;
  server_url: string;
}
export type Reply =
  | {
      ok: true;
      status?: Status;
      recovery?: RecoveryBundle;
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
