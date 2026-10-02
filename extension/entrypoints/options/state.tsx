import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Reply, Request, Status } from '@/lib/messages';

export async function request(message: Request): Promise<Reply & { ok: true }> {
  const response = (await browser.runtime.sendMessage(message)) as Reply;
  if (!response?.ok)
    throw new Error(
      response && !response.ok ? response.error : 'The background worker did not respond.',
    );
  return response;
}

const Context = createContext<{
  status?: Status;
  error: string;
  onStatus: (status?: Status) => void;
  refresh: () => Promise<void>;
} | null>(null);

export function SynkProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const revision = useRef(0);
  const active = useRef(true);
  const refreshing = useRef(false);
  function onStatus(next?: Status) {
    if (!next || !active.current) return;
    revision.current += 1;
    setStatus(next);
    setError('');
  }
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    const before = revision.current;
    try {
      const reply = await request({ type: 'status' });
      if (active.current && before === revision.current) onStatus(reply.status);
    } catch (cause) {
      if (active.current && before === revision.current)
        setError(cause instanceof Error ? cause.message : 'Unable to open this profile.');
    } finally {
      refreshing.current = false;
    }
  }
  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <Context.Provider value={{ status, error, onStatus, refresh }}>{children}</Context.Provider>
  );
}

export function useSynk() {
  const context = useContext(Context);
  if (!context) throw new Error('Sync pages must use SynkProvider.');
  return context;
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
