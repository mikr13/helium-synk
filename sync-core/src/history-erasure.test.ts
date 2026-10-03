import { describe, expect, it } from 'vite-plus/test';
import {
  decryptPayload,
  encryptPayload,
  generateRecoveryKey,
  deriveHistoryIndexKey,
  historyUrlTag,
} from './crypto';
import { envelopeDigest } from './protocol';
import {
  eraseHistoryVisit,
  historyVisitId,
  projectHistory,
  type HistoryOperation,
} from './history';
import {
  historyErasureOperations,
  historyErasureTargetHeader,
  mergeHistoryOperations,
  validateHistoryErasure,
  type HistoryErasure,
} from './history-erasure';

async function fixture() {
  const account = crypto.randomUUID(),
    source = crypto.randomUUID(),
    remover = crypto.randomUUID();
  const root = generateRecoveryKey(),
    index = await deriveHistoryIndexKey(root, account);
  const incarnation = crypto.randomUUID(),
    url = 'https://private.example/deleted';
  const visit: HistoryOperation = {
    kind: 'history',
    schema_version: 1,
    operation_id: crypto.randomUUID(),
    revision: { author: source, counter: 1, logical: 1, context: {} },
    action: {
      type: 'visit',
      visit: {
        id: historyVisitId(source, incarnation, 'original', 1234.25),
        source_id: source,
        source_name: 'Source name to erase',
        incarnation,
        native_id: 'original',
        visited_at: 1234.25,
        url,
        title: 'Private title to erase',
        transition: 'typed',
        referring_native_id: 'reference',
        url_tag: await historyUrlTag(index, url),
        generation: {},
      },
    },
  };
  const originalHeader = {
    protocol_version: 1 as const,
    account_id: account,
    operation_id: visit.operation_id,
    device_id: source,
    counter: 1,
    domain: 'history' as const,
    key_epoch: 1,
  };
  const original = await encryptPayload(root, originalHeader, visit, index);
  const certificate: HistoryErasure = {
    kind: 'history-erasure',
    schema_version: 1,
    operation_id: crypto.randomUUID(),
    revision: { author: remover, counter: 1, logical: 2, context: { [source]: 1 } },
    targets: [
      { receipt: eraseHistoryVisit(visit), digest: await envelopeDigest(original), key_epoch: 1 },
    ],
  };
  const header = {
    protocol_version: 1 as const,
    account_id: account,
    operation_id: certificate.operation_id,
    device_id: remover,
    counter: 1,
    domain: 'history-erasure' as const,
    key_epoch: 1,
  };
  return { root, index, visit, original, originalHeader, certificate, header, url };
}

describe('authenticated content-free history erasure certificates', () => {
  it('encrypts/decrypts a permanent deletion that bootstraps before the old visit or clear', async () => {
    const f = await fixture();
    const envelope = await encryptPayload(f.root, f.header, f.certificate, f.index);
    expect(await decryptPayload(f.root, envelope, f.index)).toEqual(f.certificate);
    const operations = historyErasureOperations(f.certificate);
    const projected = projectHistory(operations);
    expect(projected.visits).toEqual({});
    const receipt = f.certificate.targets[0]!.receipt;
    expect(projected.deleted[receipt.action.visit.id]).toEqual([f.certificate.operation_id]);
    expect(historyErasureTargetHeader(envelope, f.certificate.targets[0]!)).toEqual(
      f.originalHeader,
    );
    const json = JSON.stringify(f.certificate);
    expect(json).not.toContain(f.url);
    expect(json).not.toContain('Private title to erase');
    expect(json).not.toContain('Source name to erase');
    expect(json).not.toContain('reference');
    expect(json).not.toContain(f.original.ciphertext);
    for (const input of [
      [...operations, f.visit],
      [f.visit, ...operations],
    ])
      expect(projectHistory(mergeHistoryOperations(input)).visits).toEqual({});
  });
  it('rejects unauthenticated headers, ciphertext and unavailable roots', async () => {
    const f = await fixture(),
      envelope = await encryptPayload(f.root, f.header, f.certificate);
    await expect(decryptPayload(generateRecoveryKey(), envelope)).rejects.toThrow();
    await expect(decryptPayload(f.root, { ...envelope, counter: 2 })).rejects.toThrow();
    await expect(
      decryptPayload(f.root, { ...envelope, account_id: crypto.randomUUID() }),
    ).rejects.toThrow();
    await expect(decryptPayload(f.root, { ...envelope, domain: 'history' })).rejects.toThrow();
    await expect(
      decryptPayload(f.root, {
        ...envelope,
        ciphertext: envelope.ciphertext.slice(0, -4) + 'AAAA',
      }),
    ).rejects.toThrow();
    await expect(
      encryptPayload(f.root, { ...f.header, device_id: crypto.randomUUID() }, f.certificate),
    ).rejects.toThrow('author/revision');
  });
  it('forbids original content and extra fields at every certificate/receipt layer', async () => {
    const f = await fixture();
    for (const add of [
      (c: HistoryErasure) => Object.assign(c, { url: f.url }),
      (c: HistoryErasure) => Object.assign(c.targets[0]!, { ciphertext: f.original.ciphertext }),
      (c: HistoryErasure) => Object.assign(c.targets[0]!.receipt, { title: 'secret' }),
      (c: HistoryErasure) => Object.assign(c.targets[0]!.receipt.revision, { title: 'secret' }),
      (c: HistoryErasure) => Object.assign(c.targets[0]!.receipt.action, { url: f.url }),
      (c: HistoryErasure) => Object.assign(c.targets[0]!.receipt.action.visit, { url: f.url }),
      (c: HistoryErasure) =>
        Object.assign(c.targets[0]!.receipt.action.visit, { source_name: 'secret' }),
    ]) {
      const changed = structuredClone(f.certificate);
      add(changed);
      await expect(encryptPayload(f.root, f.header, changed)).rejects.toThrow('Unexpected content');
    }
    const changed = structuredClone(f.certificate);
    Object.assign(changed.targets[0]!.receipt, f.visit);
    expect(() => validateHistoryErasure(changed)).toThrow();
  });
  it('rejects stale causal claims, logical/counter conflicts, bad digests and future target epochs', async () => {
    const f = await fixture();
    for (const change of [
      (c: HistoryErasure) => {
        c.revision.context = {};
      },
      (c: HistoryErasure) => {
        c.revision.logical = 1;
      },
      (c: HistoryErasure) => {
        c.targets.push(structuredClone(c.targets[0]!));
      },
      (c: HistoryErasure) => {
        c.targets[0]!.digest = 'not-a-digest';
      },
      (c: HistoryErasure) => {
        c.targets[0]!.receipt.action.visit.source_id = crypto.randomUUID();
      },
      (c: HistoryErasure) => {
        c.targets[0]!.receipt.revision.counter = 2;
      },
    ]) {
      const changed = structuredClone(f.certificate);
      change(changed);
      expect(() => validateHistoryErasure(changed)).toThrow();
    }
    const changed = structuredClone(f.certificate);
    changed.targets[0]!.key_epoch = 2;
    await expect(encryptPayload(f.root, f.header, changed)).rejects.toThrow('newer content epoch');
  });
  it('bounds unique deleted identities and rejects conflicting original receipt metadata', async () => {
    const f = await fixture();
    const changed = structuredClone(f.certificate);
    for (let counter = 2; counter <= 81; counter++) {
      const target = structuredClone(changed.targets[0]!);
      target.receipt.operation_id = crypto.randomUUID();
      target.receipt.revision.counter = counter;
      target.receipt.revision.logical = counter;
      target.receipt.action.visit.id = historyVisitId(
        target.receipt.revision.author,
        crypto.randomUUID(),
        String(counter),
        counter,
      );
      changed.targets.push(target);
    }
    changed.revision.logical = 82;
    changed.revision.context[f.visit.revision.author] = 81;
    expect(() => validateHistoryErasure(changed)).toThrow('selected history deletion');
    const receipt = structuredClone(f.certificate.targets[0]!.receipt);
    receipt.action.visit.url_tag = 'b'.repeat(64);
    expect(() => mergeHistoryOperations([f.visit, receipt])).toThrow('conflicts');
  });
});
