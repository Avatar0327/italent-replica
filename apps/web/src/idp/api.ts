import { useCallback, useEffect, useState } from 'react';
import { ApiError, type ApiClient } from '../foundation/client.js';
import type { Values } from '../foundation/forms/store.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { rereadReceipt } from './access.js';
import { t } from './messages.js';

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

type Method = 'POST' | 'PATCH' | 'DELETE';
/**
 * 干预、状态动作、复制与任务写入统一走 F-123 页面级提交内核（DEC-464/473/475）：
 * 命令状态按“租户 × 身份 × 资源”存在页面根部，弹窗关闭再打开仍是同一条命令；
 * 处理中 / 结果未知 / 冲突时锁住且不发新请求，不自动盲重试（AGENTS.md §10 并发 / 幂等）。
 * 只有已明确拒绝或已完成的命令才清掉，开始下一条新命令。
 * `businessId` 是原单 ID：有它才能“回查原单”；单条写入的回执必须是同一条记录。
 * 返回 undefined 表示未完成（被锁、被拒绝或结果未知），状态与命令 ID 由 CommandNotice 展示。
 */
export function useCommand(
  resource: string,
  businessId?: string,
  read?: (id: string) => Promise<{ id?: unknown; revision?: unknown }>,
) {
  const api = useApiClient();
  const command = useCommandForm(resource);
  const run = async <T>(path: string, method: Method, body: Values, revision: number, idOf?: (result: T) => string) => {
    if (command.locked) return undefined;
    if (command.status === 'rejected' || command.status === 'done') command.clear();
    let response: T | undefined;
    const result = await command.submit({
      values: body,
      baseline: {},
      editableFields: Object.keys(body),
      revision,
      businessId,
      send: async (request) => {
        response = await api.request<T>(path, { method, command: request });
        const id = idOf ? idOf(response) : (response as { id?: unknown } | undefined)?.id;
        return { id: typeof id === 'string' ? id : (businessId ?? '') };
      },
    });
    // 删除等写入可能没有响应体，用 { response } 表示“已完成”，与“未完成”区分开
    return result.status === 'done' ? { response } : undefined;
  };
  const reload =
    read && businessId
      ? () =>
          command.reread(async (id) => {
            // 统一校验重读回执：缺 revision 时抛 RereadError，冲突锁不解开（access.ts 三）
            const key = id ?? businessId;
            return { ...rereadReceipt(await read(key), key), values: {} };
          })
      : undefined;
  return { ...command, run, reload };
}
export type Command = ReturnType<typeof useCommand>;

/** 批量命令没有单一原单，回执里的逐条结果才是结论；命令台账仍按命令 ID 去重。 */
export const BATCH = () => 'batch';

export const OBJECTS = {
  plan: 'IDP.Idp',
  template: 'IDP.IDPTemplate',
  process: 'IDP.IDPProcess',
  subProcess: 'IDP.SubProcess',
} as const;
