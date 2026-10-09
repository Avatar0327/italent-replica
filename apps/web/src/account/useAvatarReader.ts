import { useCallback, useEffect, useRef, useState } from 'react';
import { AVATAR_PATH, avatarRequest, type AvatarView } from './avatar-api.js';
import { accountText as text } from './messages.js';

export function useAvatarReader(tenantId: string) {
  const [view, setView] = useState<AvatarView | null>(null);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState('');
  const live = useRef(true);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    const token = ++sequence.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setView(null);
    setReading(true);
    setError('');
    try {
      const next = await avatarRequest<AvatarView>(tenantId, AVATAR_PATH, { signal: controller.signal });
      if (!live.current || token !== sequence.current) return null;
      setView(next);
      return next;
    } catch (cause) {
      if (live.current && token === sequence.current) setError(cause instanceof Error ? cause.message : text.failed);
      return null;
    } finally {
      if (live.current && token === sequence.current) setReading(false);
    }
  }, [tenantId]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      sequence.current += 1;
      abort.current?.abort();
    };
  }, [load]);
  return { view, setView, reading, error, load };
}

export type AvatarReader = ReturnType<typeof useAvatarReader>;
