/** Coalesce the entire capture/network/application pass, not only its HTTP coordinator. */
export function syncRunner(work: (force: boolean) => Promise<void>) {
  let running: Promise<void> | undefined;
  let requested = false;
  let forced = false;
  return (force = false): Promise<void> => {
    requested = true;
    forced ||= force;
    if (running) return running;
    running = Promise.resolve()
      .then(async () => {
        // One follow-up catches edits during the first pass. Later durable work is picked up
        // by the next event/alarm, so our own notifications cannot keep a worker spinning.
        for (let pass = 0; pass < 2; pass++) {
          const forcePass = forced;
          forced = false;
          requested = false;
          await work(forcePass);
          if (!requested) break;
        }
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
}
