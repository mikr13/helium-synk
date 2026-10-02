import {
  projectHistory,
  eraseHistoryVisit,
  isErasedHistoryOperation,
  type ErasedHistoryOperation,
  type HistoryOperation,
  type HistoryJournalOperation,
} from './history';
import { canonicalUuid, observes, validateRevision, type Revision } from './revision';
import { validKeyEpoch, type Envelope } from './protocol';

export interface HistoryErasureTarget {
  receipt: ErasedHistoryOperation;
  digest: string;
  key_epoch: number;
}
/** Authenticated permanent selected deletion, with no original visit content. */
export interface HistoryErasure {
  kind: 'history-erasure';
  schema_version: 1;
  operation_id: string;
  revision: Revision;
  targets: HistoryErasureTarget[];
}
function onlyKeys(value: unknown, keys: string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Unexpected content in a history erasure certificate.');
}
/** The certificate is itself an authorized tombstone; no original clear needs copying. */
export function historyErasureProof(certificate: HistoryErasure): HistoryOperation {
  return {
    kind: 'history',
    schema_version: 1,
    operation_id: certificate.operation_id,
    revision: structuredClone(certificate.revision),
    action: {
      type: 'delete',
      visit_ids: [...new Set(certificate.targets.map((t) => t.receipt.action.visit.id))],
    },
  };
}
export function validateHistoryErasure(certificate: HistoryErasure): void {
  onlyKeys(certificate, ['kind', 'schema_version', 'operation_id', 'revision', 'targets']);
  if (
    certificate.kind !== 'history-erasure' ||
    certificate.schema_version !== 1 ||
    !canonicalUuid(certificate.operation_id) ||
    !Array.isArray(certificate.targets) ||
    !certificate.targets.length ||
    certificate.targets.length > 100
  )
    throw new Error('Invalid history erasure certificate.');
  onlyKeys(certificate.revision, ['author', 'counter', 'logical', 'context']);
  validateRevision(certificate.revision);
  const ids = new Set<string>();
  for (const target of certificate.targets) {
    onlyKeys(target, ['receipt', 'digest', 'key_epoch']);
    onlyKeys(target.receipt, ['kind', 'schema_version', 'operation_id', 'revision', 'action']);
    onlyKeys(target.receipt.revision, ['author', 'counter', 'logical', 'context']);
    onlyKeys(target.receipt.action, ['type', 'visit']);
    onlyKeys(target.receipt.action.visit, ['id', 'source_id', 'url_tag', 'generation']);
    if (
      target.receipt.action.type !== 'erased-visit' ||
      target.receipt.kind !== 'history' ||
      typeof target.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(target.digest) ||
      !validKeyEpoch(target.key_epoch) ||
      ids.has(target.receipt.operation_id) ||
      target.receipt.operation_id === certificate.operation_id
    )
      throw new Error('Invalid or duplicate history erasure target.');
    ids.add(target.receipt.operation_id);
    if (!observes(certificate.revision, target.receipt.revision))
      throw new Error('History erasure must observe its original author revision.');
  }
  // Also validates native identities/generations, <=80 unique selected IDs,
  // known causal clocks/counters, and deletion proof for every local receipt.
  projectHistory([...certificate.targets.map((t) => t.receipt), historyErasureProof(certificate)]);
}
export function historyErasureOperations(certificate: HistoryErasure): HistoryJournalOperation[] {
  validateHistoryErasure(certificate);
  return [
    ...certificate.targets.map((t) => structuredClone(t.receipt)),
    historyErasureProof(certificate),
  ];
}
function normalizedReceipt(receipt: ErasedHistoryOperation): ErasedHistoryOperation {
  const { author, counter, logical, context } = receipt.revision;
  const { id, source_id, url_tag, generation } = receipt.action.visit;
  const sorted = (clock: Record<string, number>) =>
    Object.fromEntries(Object.entries(clock).sort(([a], [b]) => a.localeCompare(b)));
  return {
    kind: 'history',
    schema_version: 1,
    operation_id: receipt.operation_id,
    revision: { author, counter, logical, context: sorted(context) },
    action: {
      type: 'erased-visit',
      visit: { id, source_id, url_tag, generation: sorted(generation) },
    },
  };
}
export function sameHistoryReceipt(a: ErasedHistoryOperation, b: ErasedHistoryOperation): boolean {
  return JSON.stringify(normalizedReceipt(a)) === JSON.stringify(normalizedReceipt(b));
}
/** Callers authenticate the certificate/digest first. Never choose conflicting metadata. */
export function mergeHistoryOperations(
  input: HistoryJournalOperation[],
): HistoryJournalOperation[] {
  const byId = new Map<string, HistoryJournalOperation>();
  for (const operation of input) {
    const next = isErasedHistoryOperation(operation) ? normalizedReceipt(operation) : operation;
    const old = byId.get(next.operation_id);
    if (old && JSON.stringify(old) !== JSON.stringify(next)) {
      const full =
        old.action.type === 'visit' ? old : next.action.type === 'visit' ? next : undefined;
      const erased = isErasedHistoryOperation(old)
        ? old
        : isErasedHistoryOperation(next)
          ? next
          : undefined;
      if (!full || !erased || !sameHistoryReceipt(eraseHistoryVisit(full), erased))
        throw new Error('Certified history receipt conflicts with the original operation.');
      byId.set(next.operation_id, erased);
    } else byId.set(next.operation_id, next);
  }
  return [...byId.values()];
}
export function historyErasureTargetHeader(
  certificate: Pick<Envelope, 'account_id'>,
  target: HistoryErasureTarget,
): Omit<Envelope, 'nonce' | 'ciphertext'> {
  return {
    protocol_version: 1,
    operation_id: target.receipt.operation_id,
    account_id: certificate.account_id,
    device_id: target.receipt.revision.author,
    counter: target.receipt.revision.counter,
    domain: 'history',
    key_epoch: target.key_epoch,
  };
}
