import { Disclosure } from '@/components/disclosure';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import React, { useState } from 'react';
import type { BookmarkImport, NativeBookmark, RootSelection } from '@helium-synk/core';
import type { Reply, Request, Status } from '@/lib/messages';
type Success = Reply & { ok: true };
export function downloadJson(value: unknown, name: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
export function BookmarkPanel({
  status,
  request,
  onStatus,
}: {
  status: Status;
  request: (message: Request) => Promise<Success>;
  onStatus: (status?: Status) => void;
}) {
  const [preview, setPreview] = useState<BookmarkImport>(),
    [roots, setRoots] = useState<Success['bookmark_roots']>(),
    [selection, setSelection] = useState<RootSelection>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false),
    [review, setReview] = useState<{ id: string; candidates: NativeBookmark[] }>();
  const phase = status.bookmarks.phase;
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Bookmark operation failed.');
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    const choices = await request({ type: 'bookmark-roots' });
    setRoots(choices.bookmark_roots);
    const result = await request({ type: 'bookmark-preview', roots: selection });
    setPreview(result.bookmark_preview);
    setSaved(false);
  }
  async function resolve(native_id?: string) {
    if (!review) return;
    const result = await request({ type: 'bookmark-resolve', id: review.id, native_id });
    onStatus(result.status);
    setReview(undefined);
  }
  return (
    <Card id="bookmarks" className="panel bookmarks-panel" aria-labelledby="bookmarks-heading">
      <CardHeader className="records-heading flex px-0 pt-0">
        <div>
          <CardTitle>
            <h1 id="bookmarks-heading">Bookmarks</h1>
          </CardTitle>
        </div>
        <Badge variant="outline" className="tag">
          {phase === 'active' ? 'SYNC ENABLED' : 'PREVIEW FIRST'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <p>Keep the same links and folders on your connected devices.</p>
        {(error || status.bookmarks.error) && (
          <Alert variant="destructive" className="error">
            <AlertDescription>{error || status.bookmarks.error}</AlertDescription>
          </Alert>
        )}
        {phase !== 'active' ? (
          <>
            <p>
              Preview the combined collection before enabling sync. Your existing bookmarks are
              preserved. Managed bookmarks are excluded.
            </p>
            {roots && (
              <div className="root-choices">
                {(['bar', 'other', 'mobile'] as const).map((role) => {
                  const choices = roots.filter((root) => root.role === role);
                  return choices.length > 1 ? (
                    <Field key={role}>
                      <FieldLabel htmlFor={`bookmark-root-${role}`}>
                        {role === 'bar'
                          ? 'Bookmarks bar'
                          : role === 'other'
                            ? 'Other bookmarks'
                            : 'Mobile bookmarks'}
                      </FieldLabel>
                      <NativeSelect
                        id={`bookmark-root-${role}`}
                        value={selection[role] ?? ''}
                        onChange={(event) => {
                          setSelection({ ...selection, [role]: event.target.value || undefined });
                          setPreview(undefined);
                          setSaved(false);
                        }}
                      >
                        <NativeSelectOption value="">
                          Choose automatically when unambiguous
                        </NativeSelectOption>
                        {choices.map((root) => (
                          <NativeSelectOption value={root.id} key={root.id}>
                            {root.title} · {root.syncing ? 'Browser account' : 'Local profile'} ·{' '}
                            {root.id}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                  ) : null;
                })}
              </div>
            )}
            <Button variant="outline" disabled={busy} onClick={() => void run(prepare)}>
              {busy ? 'Preparing…' : preview ? 'Refresh preview' : 'Preview bookmark merge'}
            </Button>
            {preview && (
              <div className="import-preview">
                <dl className="preview-counts">
                  <div>
                    <dt>Unique matches</dt>
                    <dd>{preview.matches}</dd>
                  </div>
                  <div>
                    <dt>Local entries to add</dt>
                    <dd>{preview.imports}</dd>
                  </div>
                  <div>
                    <dt>Existing shared entries</dt>
                    <dd>{preview.remote}</dd>
                  </div>
                  <div>
                    <dt>Restricted folders skipped</dt>
                    <dd>{preview.skipped}</dd>
                  </div>
                </dl>
                <Disclosure title={`Review local entries to add (${preview.imports})`}>
                  <ul className="import-list">
                    {preview.actions.slice(0, 150).map((action) =>
                      action.type === 'create' ? (
                        <li key={action.node_id}>
                          <strong>{action.title || 'Untitled'}</strong>
                          <span>{action.url ?? 'Folder'}</span>
                        </li>
                      ) : null,
                    )}
                  </ul>
                  {preview.imports > 150 && <p>The full list is included in your backup.</p>}
                </Disclosure>
                <p className="fine">
                  Save the recovery copy before merging. It includes this profile’s original tree
                  and the shared replica. If bookmarks change while you review, the merge pauses for
                  a fresh preview.
                </p>
                <div className="actions">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      downloadJson(preview.backup, 'helium-synk-bookmarks-before-merge.json');
                      setSaved(true);
                    }}
                  >
                    Save bookmark backup
                  </Button>
                  <Button
                    disabled={busy || !saved}
                    onClick={() =>
                      void run(async () => {
                        const result = await request({ type: 'bookmark-confirm', id: preview.id });
                        onStatus(result.status);
                        setPreview(undefined);
                      })
                    }
                  >
                    Enable bookmark sync <span aria-hidden="true">↗</span>
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <dl className="preview-counts">
              <div>
                <dt>Shared entries</dt>
                <dd>{status.bookmarks.nodes}</dd>
              </div>
              <div>
                <dt>Recovery conflicts</dt>
                <dd>{status.bookmarks.conflicts}</dd>
              </div>
              <div>
                <dt>Captured events to process</dt>
                <dd>{status.bookmarks.captured}</dd>
              </div>
            </dl>
            <Disclosure title="Recovery & technical details">
              <p>
                Sync keeps saved data and conflicting values locally. An interrupted addition may
                pause for review below.
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await request({ type: 'export' });
                    downloadJson(result.replica, 'helium-synk-local-replica.json');
                  })
                }
              >
                Save local data backup
              </Button>
            </Disclosure>
            {status.bookmarks.interrupted.map((effect) => (
              <div className="review-effect" key={effect.id}>
                <p>{effect.message}</p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await request({ type: 'bookmark-review', id: effect.id });
                      setReview({ id: effect.id, candidates: result.bookmark_candidates ?? [] });
                    })
                  }
                >
                  Review possible matches
                </Button>
              </div>
            ))}
            {review && (
              <div className="import-preview">
                <h3>Recover the interrupted addition</h3>
                <p>
                  Choose an existing bookmark to associate with the shared entry, or keep all
                  existing entries and create a separate copy.
                </p>
                {review.candidates.map((node) => (
                  <div className="review-effect" key={node.id}>
                    <strong>{node.title || 'Untitled'}</strong>
                    <p>{node.url ?? 'Folder'}</p>
                    <Button disabled={busy} onClick={() => void run(() => resolve(node.id))}>
                      Use this existing entry
                    </Button>
                  </div>
                ))}
                <Button variant="outline" disabled={busy} onClick={() => void run(() => resolve())}>
                  Keep existing entries and add a separate copy
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
