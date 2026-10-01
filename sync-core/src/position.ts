/** Exact rational positions avoid clock-dependent ordering and floating-point exhaustion. */
export type Position = string;
const MAX_POSITION_LENGTH = 1_024;
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}
function fraction(numerator: bigint, denominator: bigint): Position {
  const divisor = gcd(numerator, denominator);
  const value = `${numerator / divisor}/${denominator / divisor}`;
  if (value.length > MAX_POSITION_LENGTH)
    throw new Error('Position is too long; reorder this folder before inserting.');
  return value;
}
export function parsePosition(value: Position): [bigint, bigint] {
  if (
    typeof value !== 'string' ||
    value.length > MAX_POSITION_LENGTH ||
    !/^-?(0|[1-9]\d*)\/[1-9]\d*$/.test(value)
  )
    throw new Error('Invalid bookmark position.');
  const parts = value.split('/');
  const numerator = BigInt(parts[0]!);
  const denominator = BigInt(parts[1]!);
  if (fraction(numerator, denominator) !== value)
    throw new Error('Non-canonical bookmark position.');
  return [numerator, denominator];
}
export function comparePositions(a: Position, b: Position): number {
  const [an, ad] = parsePosition(a),
    [bn, bd] = parsePosition(b);
  const result = an * bd - bn * ad;
  return result < 0n ? -1 : result > 0n ? 1 : 0;
}
export function positionBetween(left?: Position, right?: Position): Position {
  if (left === undefined && right === undefined) return '0/1';
  if (left === undefined) {
    const [n, d] = parsePosition(right!);
    return fraction(n - d, d);
  }
  if (right === undefined) {
    const [n, d] = parsePosition(left);
    return fraction(n + d, d);
  }
  const [ln, ld] = parsePosition(left),
    [rn, rd] = parsePosition(right);
  if (ln * rd >= rn * ld) throw new Error('Position bounds must be increasing.');
  // The mediant is strictly inside the interval and grows more slowly than repeated midpoints.
  return fraction(ln + rn, ld + rd);
}
export function balancedPositions(
  ids: readonly string[],
): { node_id: string; position: Position }[] {
  if (new Set(ids).size !== ids.length)
    throw new Error('Cannot order duplicate bookmark identities.');
  return ids.map((node_id, index) => ({ node_id, position: `${index + 1}/1` }));
}
