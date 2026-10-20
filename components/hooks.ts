import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { BroadcastMessage } from '@/lib/messages';

/** Current time, refreshed every `intervalMs` (or frozen when null). */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Subscribes to broadcast messages from other extension contexts. */
export function useRuntimeMessage(handler: (msg: BroadcastMessage) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (msg: unknown) => {
      if (msg && typeof msg === 'object' && 'type' in msg) ref.current(msg as BroadcastMessage);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);
}

/** Microphone permission of the extension origin, kept up to date. */
export function useMicPermission(): PermissionState | 'unknown' {
  const [state, setState] = useState<PermissionState | 'unknown'>('unknown');
  useEffect(() => {
    let status: PermissionStatus | undefined;
    const update = () => status && setState(status.state);
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((s) => {
        status = s;
        update();
        s.addEventListener('change', update);
      })
      .catch(() => setState('unknown'));
    return () => status?.removeEventListener('change', update);
  }, []);
  return state;
}
