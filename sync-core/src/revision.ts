import { isUuid, validCounter } from './protocol';

export type VectorClock = Record<string, number>;
export interface Revision {
  author: string;
  counter: number;
  logical: number;
  context: VectorClock;
}
export interface Versioned<T> {
  operation_id: string;
  revision: Revision;
  value: T;
}
export function canonicalUuid(value: unknown): value is string {
  return isUuid(value) && value === value.toLowerCase();
}
export function validateRevision(value: Revision): void {
  if (
    !value ||
    !canonicalUuid(value.author) ||
    !validCounter(value.counter) ||
    !validCounter(value.logical) ||
    value.logical < value.counter ||
    !value.context ||
    typeof value.context !== 'object' ||
    Array.isArray(value.context) ||
    Object.keys(value.context).length > 256
  )
    throw new Error('Invalid logical revision.');
  for (const [author, counter] of Object.entries(value.context)) {
    if (
      !canonicalUuid(author) ||
      !Number.isSafeInteger(counter) ||
      counter < 0 ||
      (author === value.author && counter >= value.counter)
    )
      throw new Error('Invalid causal context.');
  }
}
export function observes(later: Revision, earlier: Revision): boolean {
  return later.author === earlier.author
    ? later.counter > earlier.counter
    : (later.context[earlier.author] ?? 0) >= earlier.counter;
}
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function compareVersions<T>(a: Versioned<T>, b: Versioned<T>): number {
  return (
    a.revision.logical - b.revision.logical ||
    compareText(a.revision.author, b.revision.author) ||
    a.revision.counter - b.revision.counter ||
    compareText(a.operation_id, b.operation_id)
  );
}
/** Keep concurrent values; only a causally subsequent edit discards the older candidate. */
export function addVersion<T>(frontier: Versioned<T>[], next: Versioned<T>): Versioned<T>[] {
  if (
    frontier.some(
      (old) => old.operation_id === next.operation_id || observes(old.revision, next.revision),
    )
  )
    return frontier;
  return [...frontier.filter((old) => !observes(next.revision, old.revision)), next].sort(
    compareVersions,
  );
}
export function winner<T>(frontier: Versioned<T>[]): Versioned<T> {
  if (!frontier.length) throw new Error('Missing field revision.');
  return frontier[frontier.length - 1]!;
}
/** Validate known causal references without requiring all referenced records to arrive first. */
export function validateRevisionSet(
  operations: { operation_id: string; revision: Revision }[],
): void {
  const byAuthor = new Map<string, { counter: number; logical: number; operation_id: string }[]>();
  for (const op of operations) {
    validateRevision(op.revision);
    const author = byAuthor.get(op.revision.author) ?? [];
    author.push({
      counter: op.revision.counter,
      logical: op.revision.logical,
      operation_id: op.operation_id,
    });
    byAuthor.set(op.revision.author, author);
  }
  for (const entries of byAuthor.values()) {
    entries.sort((a, b) => a.counter - b.counter);
    for (let index = 1; index < entries.length; index++) {
      if (
        entries[index]!.counter === entries[index - 1]!.counter ||
        entries[index]!.logical <= entries[index - 1]!.logical
      )
        throw new Error('Reused author counter or non-monotonic logical revision.');
    }
  }
  for (const op of operations) {
    for (const [author, counter] of Object.entries(op.revision.context)) {
      const entries = byAuthor.get(author);
      if (!entries) continue;
      let low = 0,
        high = entries.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (entries[middle]!.counter <= counter) low = middle + 1;
        else high = middle;
      }
      if (low && entries[low - 1]!.logical >= op.revision.logical)
        throw new Error('Logical revision does not follow its causal context.');
    }
  }
}
