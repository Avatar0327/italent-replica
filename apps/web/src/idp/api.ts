import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, newCommand, type ApiClient } from '../foundation/client.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { t } from './messages.js';
import type { Receipt } from './types.js';

export const IDP_API = '/api/tenant/idp';
const PAGE_SIZE = 200;
const MAX_PAGES = 20;

interface Envelope<T> {
  items: T[];
  hasDataPermission?: boolean;
}
/**
 * 列表接口不返回总数，按 200 条一页读完授权结果后在前端筛选分页；超过 4000 条报错，不截断成“部分结果”。
 * 失败直接抛出，不回退演示数据（DEC-494）。
 */
export async function loadAll<T>(api: ApiClient, path: string, signal: AbortSignal) {
  const items: T[] = [];
  let hasDataPermission = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const glue = path.includes('?') ? '&' : '?';
    const result = await api.request<Envelope<T>>(`${path}${glue}page=${page}&pageSize=${PAGE_SIZE}`, { signal });
    items.push(...result.items);
    hasDataPermission = result.hasDataPermission ?? true;
    if (result.items.length < PAGE_SIZE) return { items, hasDataPermission };
  }
  throw new ApiError(413, 'DEMO_LIST_LIMIT', 'conflict', t.loadLimit);
}

/** 身份或代次变化时丢弃上一次结果，避免切换演示身份后串数据。 */
export function useCollection<T>(path: string | undefined) {
  const api = useApiClient();
  const session = useSession();
  const [generation, setGeneration] = useState(0);
  const key = `${session.tenantId}/${session.identityKey}/${path}/${generation}`;
  const [state, setState] = useState<{ key: string; items?: T[]; scoped?: boolean; error?: unknown }>({ key: '' });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    loadAll<T>(api, path, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setState({ key, items: result.items, scoped: result.hasDataPermission });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, error });
      },
    );
    return () => controller.abort();
  }, [api, key, path]);
  const current = state.key === key;
  return {
    items: current ? state.items : undefined,
    hasDataPermission: current ? state.scoped : undefined,
    error: current ? state.error : undefined,
    loading: !!path && (!current || (!state.items && !state.error)),
    reload: useCallback(() => setGeneration((value) => value + 1), []),
  };
}

/**
 * 干预与状态动作：单条带对象 revision，批量带 revision 0（契约要求）；同一时刻只允许一次提交。
 * 结果未知或冲突时锁住，要求先刷新再显式重提，不自动盲重试（AGENTS.md §10 并发 / 幂等）。
 */
export function useAction(done: () => void) {
  const api = useApiClient();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [blocked, setBlocked] = useState(false);
  const run = async <T>(path: string, method: 'POST' | 'DELETE', body: unknown, revision: number) => {
    if (lock.current || blocked) return undefined;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.request<T>(path, { method, command: newCommand(body ?? {}, revision) });
      done();
      return result;
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiError && ['unknown', 'refresh', 'conflict'].includes(cause.kind)) setBlocked(true);
      return undefined;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const reset = () => {
    setError(undefined);
    setBlocked(false);
    done();
  };
  return {
    run,
    batch: (path: string, body: { items: { id: string; revision: number }[] } & Record<string, unknown>) =>
      run<{ receipts: Receipt[] }>(path, 'POST', body, 0),
    busy,
    error,
    blocked,
    reset,
  };
}

export const OBJECTS = {
  plan: 'IDP.Idp',
  template: 'IDP.IDPTemplate',
  process: 'IDP.IDPProcess',
} as const;
