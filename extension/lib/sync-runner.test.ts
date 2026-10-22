import { describe, expect, it, vi } from 'vite-plus/test';
import { syncRunner } from './sync-runner';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('background sync scheduling', () => {
  it('coalesces startup/event bursts across capture, transport and application', async () => {
    const entered = gate(),
      blocked = gate();
    let active = 0,
      peak = 0;
    const work = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      entered.release();
      await blocked.promise;
      active--;
    });
    const sync = syncRunner(work);
    const first = sync();
    await entered.promise;
    for (let event = 0; event < 1000; event++) expect(sync()).toBe(first);
    blocked.release();
    await first;
    expect(peak).toBe(1);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('preserves a forced retry requested during an ordinary pass', async () => {
    const entered = gate(),
      blocked = gate();
    const work = vi.fn(async () => {
      entered.release();
      await blocked.promise;
    });
    const sync = syncRunner(work);
    const first = sync();
    await entered.promise;
    void sync(true);
    void sync(false);
    blocked.release();
    await first;
    expect(work.mock.calls).toEqual([[false], [true]]);
  });

  it('yields after one follow-up even if each pass generates another notification', async () => {
    const work = vi.fn(async () => {
      void sync();
    });
    const sync = syncRunner(work);
    await sync();
    expect(work).toHaveBeenCalledTimes(2);
    await sync();
    expect(work).toHaveBeenCalledTimes(4);
  });

  it('allows a later retry after a failed pass', async () => {
    const work = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined);
    const sync = syncRunner(work);
    await expect(sync()).rejects.toThrow('Offline');
    await sync(true);
    expect(work.mock.calls).toEqual([[false], [true]]);
  });
});
