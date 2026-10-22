import Dexie from 'dexie';
import { SynkDatabase } from './database';
import { keySnapshot } from './key-manager';
import { decryptPayload, generateRecoveryKey } from './crypto';
import {
  proveIdentity,
  generateWrappingIdentity,
  type PublicIdentity,
  type WrappingIdentity,
} from './key-crypto';
import { isContentErasure, erasureTargetHeader } from './content-erasure';
import { projectBookmarks, type BookmarkJournalOperation } from './bookmarks';
import { projectSessions, type SessionJournalOperation } from './sessions';
import { projectHistory, type HistoryJournalOperation } from './history';
import { historyErasureOperations, mergeHistoryOperations } from './history-erasure';
import type { Payload } from './payload';
import { sameHistoryHeader } from './history-purge';
import { HistoryPurger } from './history-purge';
import { envelopeDigest, validateEnvelope, type Envelope } from './protocol';

export interface RelayRecoveryEntry {
  envelope: Envelope;
  redacted?: { digest: string; certificate_operation_id: string };
}
/** Contains encrypted journal data and ONE existing credential, never client content keys. */
export interface RelayRecoveryBundle {
  format: 'helium-synk-relay-recovery';
  version: 1;
  recovery_id: string;
  account_id: string;
  previous_server_epoch: string;
  server_epoch: string;
  key_epoch: number;
  source: { device_id: string; name: string; token: string; identity: PublicIdentity };
  entries: RelayRecoveryEntry[];
  manifest_digest: string;
  purges: {
    certificate_operation_id: string;
    targets: { header: Omit<Envelope, 'nonce' | 'ciphertext'>; digest: string }[];
  }[];
}
export interface RelayRecoveryPending {
  id: 'relay-recovery';
  bundle: RelayRecoveryBundle;
  from_key_epoch: number;
  new_root: string;
  identity: WrappingIdentity;
  adopted?: boolean;
}
export interface RelayRecoveryReceipt {
  account_id: string;
  server_epoch: string;
  recovery_id: string;
  key_epoch: number;
  manifest_digest: string;
  source_id: string;
}
async function manifestDigest(
  entries: RelayRecoveryEntry[],
  purges: RelayRecoveryBundle['purges'],
): Promise<string> {
  const manifest = [];
  for (const entry of entries)
    manifest.push([
      entry.envelope.operation_id,
      entry.redacted?.digest ?? (await envelopeDigest(entry.envelope)),
      entry.redacted?.certificate_operation_id ?? null,
    ]);
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        manifest,
        purges.map((p) => [
          p.certificate_operation_id,
          p.targets.map((t) => {
            const h = t.header;
            return [
              h.protocol_version,
              h.operation_id,
              h.account_id,
              h.device_id,
              h.counter,
              h.domain,
              h.key_epoch,
              t.digest,
            ];
          }),
        ]),
      ]),
    ),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Authenticate peer content before it can enter a rebuild, including redaction proofs. */
async function validateRecoveryEntries(
  entries: RelayRecoveryEntry[],
  roots: Record<number, string>,
  account: string,
  historyKey?: string,
) {
  const byId = new Map(entries.map((entry) => [entry.envelope.operation_id, entry]));
  const payloads = new Map<
    string,
    Payload | BookmarkJournalOperation | SessionJournalOperation | HistoryJournalOperation
  >();
  const counters = new Set<string>();
  for (const entry of entries) {
    validateEnvelope(entry.envelope);
    const e = entry.envelope,
      key = `${e.device_id}/${e.counter}`;
    if (e.account_id !== account || counters.has(key))
      throw new Error('Recovery author counters or account conflict.');
    counters.add(key);
    if (!entry.redacted) {
      if (!roots[e.key_epoch])
        throw new Error(
          'This profile lacks a historical key needed by a peer. Use the most current surviving profile.',
        );
      payloads.set(e.operation_id, await decryptPayload(roots[e.key_epoch]!, e, historyKey));
    }
  }
  for (const entry of entries)
    if (entry.redacted) {
      const proof = byId.get(entry.redacted.certificate_operation_id);
      const payload = payloads.get(entry.redacted.certificate_operation_id);
      if (!proof || !payload || !isContentErasure(payload))
        throw new Error('Recovery is missing an authenticated compaction proof.');
      const target = payload.targets.find(
        (t) => t.receipt.operation_id === entry.envelope.operation_id,
      );
      if (
        !target ||
        target.digest !== entry.redacted.digest ||
        !sameHistoryHeader(entry.envelope, erasureTargetHeader(proof.envelope, target)) ||
        entry.envelope.nonce ||
        entry.envelope.ciphertext
      )
        throw new Error('Recovery compaction receipt differs from its encrypted proof.');
      payloads.set(entry.envelope.operation_id, target.receipt);
    }
  const all = [...payloads.values()];
  projectBookmarks(all.filter((p): p is BookmarkJournalOperation => p.kind === 'bookmark'));
  projectSessions(all.filter((p): p is SessionJournalOperation => p.kind === 'session'));
  projectHistory(
    mergeHistoryOperations(
      all.flatMap((p) =>
        p.kind === 'history'
          ? [p]
          : p.kind === 'history-erasure'
            ? historyErasureOperations(p)
            : [],
      ),
    ),
  );
  return all.filter(isContentErasure);
}
/** Prepare while offline. A repeated export is exactly the same saved recovery proposal. */
export async function exportRelayRecovery(
  db: SynkDatabase,
  peers: unknown[] = [],
): Promise<RelayRecoveryBundle> {
  if (await db.rotationPending.count())
    throw new Error('Finish or review the saved key rotation before relay recovery.');
  if (await db.quarantine.count())
    throw new Error(
      'Resolve quarantined records before rebuilding the relay. Export local data for review.',
    );
  const purger = new HistoryPurger(db);
  for (let pass = 0; pass < 100; pass++) {
    await db.flushDrafts();
    if (!(await purger.prepare()) && !(await db.drafts.count())) break;
    if (pass === 99) throw new Error('More local recovery preparation remains. Retry export.');
  }
  const snapshot = await keySnapshot(db);
  const { local } = snapshot;
  if (!local.server_epoch || (local.key_epoch ?? 1) >= 255)
    throw new Error('A known server epoch and an available future key epoch are required.');
  const server_epoch = crypto.randomUUID(),
    new_root = generateRecoveryKey(),
    key_epoch = (local.key_epoch ?? 1) + 1;
  const identity = snapshot.secrets.identity ?? (await generateWrappingIdentity());
  const proof = await proveIdentity(new_root, local.credentials.account_id, server_epoch, {
    device_id: local.credentials.device_id,
    public_key: identity.public_key,
    proof_epoch: key_epoch,
  });
  return db.transaction(
    'rw',
    [
      db.state,
      db.keySecrets,
      db.rotationPending,
      db.relayRecoveryPending,
      db.records,
      db.operations,
      db.drafts,
      db.historyPurgePending,
      db.pairingPending,
      db.quarantine,
    ],
    async () => {
      const latest = await keySnapshot(db);
      if (
        latest.local.server_epoch !== local.server_epoch ||
        latest.local.key_epoch !== local.key_epoch ||
        (await db.rotationPending.count()) ||
        (await db.pairingPending.count()) ||
        (await db.quarantine.count()) ||
        (await db.drafts.count())
      )
        throw new Error('Local keys or recovery preparation changed. Retry export.');
      const prior = await db.relayRecoveryPending.get('relay-recovery');
      const entries = new Map<string, RelayRecoveryEntry>();
      for (const record of [...(await db.records.toArray()), ...(await db.operations.toArray())]) {
        const redacted = 'redacted' in record ? record.redacted : undefined;
        entries.set(record.operation_id, {
          envelope: record.envelope,
          ...(redacted ? { redacted } : {}),
        });
      }
      // Finish saved erasure intents in the reconstruction, never reintroduce their ciphertext.
      for (const intent of await db.historyPurgePending.toArray())
        for (const target of intent.request.targets) {
          entries.set(target.header.operation_id, {
            envelope: { ...target.header, nonce: '', ciphertext: '' },
            redacted: { digest: target.digest, certificate_operation_id: intent.operation_id },
          });
        }
      if (prior && !prior.adopted) {
        for (const entry of prior.bundle.entries) {
          const current = entries.get(entry.envelope.operation_id);
          if (!current || (entry.redacted && !current.redacted))
            entries.set(entry.envelope.operation_id, entry);
        }
      }
      for (const raw of peers) {
        const peer = raw as RelayRecoveryBundle;
        if (
          !peer ||
          peer.format !== 'helium-synk-relay-recovery' ||
          peer.version !== 1 ||
          peer.account_id !== local.credentials.account_id ||
          peer.previous_server_epoch !== local.server_epoch ||
          !Array.isArray(peer.entries) ||
          peer.entries.length > 1_000_000 ||
          (await Dexie.waitFor(manifestDigest(peer.entries, peer.purges))) !== peer.manifest_digest
        )
          throw new Error(
            'A peer recovery file has a different account/epoch or invalid manifest. Local state was retained.',
          );
        for (const entry of peer.entries) {
          const old = entries.get(entry.envelope.operation_id);
          if (old) {
            const a = old.redacted?.digest ?? (await Dexie.waitFor(envelopeDigest(old.envelope)));
            const b =
              entry.redacted?.digest ?? (await Dexie.waitFor(envelopeDigest(entry.envelope)));
            if (a !== b || !sameHistoryHeader(old.envelope, entry.envelope))
              throw new Error('Peer recovery files disagree about an operation identity.');
            if (old.redacted || !entry.redacted) continue;
          }
          entries.set(entry.envelope.operation_id, entry);
        }
      }
      if (
        [...entries.values()].some(
          (r) =>
            r.envelope.device_id === local.credentials.device_id &&
            r.envelope.counter >= latest.local.next_counter,
        )
      )
        throw new Error(
          'This profile’s author counter is behind surviving data. Use the original most current installation for recovery.',
        );
      const certificates = await Dexie.waitFor(
        validateRecoveryEntries(
          [...entries.values()],
          latest.secrets.roots,
          local.credentials.account_id,
          local.history_index_key,
        ),
      );
      const ordered = [...entries.values()].sort((a, b) =>
        a.envelope.operation_id.localeCompare(b.envelope.operation_id),
      );
      const purges = certificates
        .sort((a, b) => a.operation_id.localeCompare(b.operation_id))
        .map((certificate) => ({
          certificate_operation_id: certificate.operation_id,
          targets: certificate.targets
            .map((target) => ({
              header: erasureTargetHeader(entries.get(certificate.operation_id)!.envelope, target),
              digest: target.digest,
            }))
            .sort((a, b) => a.header.operation_id.localeCompare(b.header.operation_id)),
        }));
      const manifest_digest = await Dexie.waitFor(manifestDigest(ordered, purges));
      if (
        prior &&
        !prior.adopted &&
        prior.bundle.manifest_digest === manifest_digest &&
        prior.from_key_epoch === (local.key_epoch ?? 1) &&
        prior.bundle.previous_server_epoch === local.server_epoch &&
        !peers.length
      )
        return prior.bundle;
      const bundle: RelayRecoveryBundle = {
        format: 'helium-synk-relay-recovery',
        version: 1,
        recovery_id: crypto.randomUUID(),
        account_id: local.credentials.account_id,
        previous_server_epoch: local.server_epoch!,
        server_epoch,
        key_epoch,
        source: {
          device_id: local.credentials.device_id,
          name: local.credentials.name,
          token: local.credentials.token,
          identity: proof,
        },
        entries: ordered,
        purges,
        manifest_digest,
      };
      await db.relayRecoveryPending.put({
        id: 'relay-recovery',
        bundle,
        new_root,
        identity,
        from_key_epoch: local.key_epoch ?? 1,
      });
      return bundle;
    },
  );
}
/** Explicit adoption only; a mismatched relay never resets client cursors or author counters. */
export async function adoptRelayRecovery(
  db: SynkDatabase,
  receipt?: RelayRecoveryReceipt,
): Promise<void> {
  const pending = await db.relayRecoveryPending.get('relay-recovery');
  if (!pending) throw new Error('Prepare a relay rebuild file on this profile first.');
  const { bundle } = pending;
  const { local } = await keySnapshot(db);
  if (!receipt) {
    const response = await fetch(`${local.credentials.server_url}/v1/recovery/state`, {
      headers: { Authorization: `Bearer ${local.credentials.token}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error('The relay has not accepted this recovery file. Local state was retained.');
    receipt = (await response.json()) as RelayRecoveryReceipt;
  }
  if (
    !receipt ||
    receipt.account_id !== bundle.account_id ||
    receipt.server_epoch !== bundle.server_epoch ||
    receipt.recovery_id !== bundle.recovery_id ||
    receipt.key_epoch !== bundle.key_epoch ||
    receipt.manifest_digest !== bundle.manifest_digest ||
    receipt.source_id !== bundle.source.device_id
  )
    throw new Error(
      'Relay rebuild proof does not match this profile’s saved proposal. Local state was retained.',
    );
  if (pending.adopted) return;
  await db.transaction(
    'rw',
    [
      db.state,
      db.keySecrets,
      db.relayRecoveryPending,
      db.rotationPending,
      db.records,
      db.operations,
      db.drafts,
      db.historyPurgePending,
      db.outbox,
      db.quarantine,
    ],
    async () => {
      const current = await keySnapshot(db),
        saved = await db.relayRecoveryPending.get('relay-recovery');
      if (
        saved?.bundle.recovery_id !== bundle.recovery_id ||
        current.local.server_epoch !== bundle.previous_server_epoch ||
        (current.local.key_epoch ?? 1) !== pending.from_key_epoch ||
        (await db.rotationPending.count())
      )
        throw new Error(
          'Local keys changed after recovery preparation. Preserve the proposal and review recovery.',
        );
      const included = new Map(bundle.entries.map((r) => [r.envelope.operation_id, r]));
      if (await db.quarantine.count())
        throw new Error('Resolve quarantined records before recovery adoption.');
      for (const record of [...(await db.records.toArray()), ...(await db.operations.toArray())]) {
        const old = included.get(record.operation_id);
        if (
          !old &&
          !(record.envelope.device_id === bundle.source.device_id && record.sequence === undefined)
        )
          throw new Error(
            'New acknowledged data arrived after this rebuild file was saved. Export a new rebuild file and rebuild into another new database.',
          );
        if (old) {
          const redacted = 'redacted' in record ? record.redacted : undefined;
          const digest = redacted?.digest ?? (await Dexie.waitFor(envelopeDigest(record.envelope)));
          const expected =
            old.redacted?.digest ?? (await Dexie.waitFor(envelopeDigest(old.envelope)));
          if (
            digest !== expected ||
            !sameHistoryHeader(record.envelope, old.envelope) ||
            (redacted && !old.redacted)
          )
            throw new Error(
              'Local data changed after rebuild preparation. Export a new rebuild file before recovery.',
            );
        }
      }
      await db.keySecrets.put({
        ...current.secrets,
        server_epoch: bundle.server_epoch,
        roots: { ...current.secrets.roots, [bundle.key_epoch]: pending.new_root },
        identity: pending.identity,
        public_identity: bundle.source.identity,
      });
      await db.state.update('local', {
        server_epoch: bundle.server_epoch,
        key_epoch: bundle.key_epoch,
        recovery_key: pending.new_root,
        cursor: 0,
        acknowledged_cursor: 0,
        last_synced: undefined,
      });
      await db.records.toCollection().modify((r) => {
        delete r.sequence;
      });
      await db.operations.toCollection().modify((r) => {
        delete r.sequence;
      });
      await db.drafts.toCollection().modify((d) => {
        if (d.erasure_epoch) d.erasure_epoch = bundle.server_epoch;
      });
      await db.historyPurgePending.toCollection().modify((p) => {
        p.request.expected_epoch = bundle.server_epoch;
      });
      await db.relayRecoveryPending.put({
        ...pending,
        bundle: { ...bundle, entries: [], purges: [] },
        adopted: true,
      });
    },
  );
}
