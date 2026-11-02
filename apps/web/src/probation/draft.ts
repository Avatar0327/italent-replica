import { useEffect, useState } from 'react';
import { ApiError } from '../foundation/client.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Values } from '../foundation/forms/values.js';
import { useApiClient } from '../foundation/Session.js';
import type { ApplicationDraft } from '../intern/commands.js';
import { m } from './messages.js';
import { businesses, recoveredDraft, regularizationDraftPath, temporaryOf, type Temporary } from './model.js';

/** 单据已删除 / 不可见：按没有草稿单继续。 */
const gone = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 403);

export interface Recovery {
  /** 暂存 revision（没有时 0）：再暂存的 If-Match。 */
  revision: number;
  /** 上次暂存的内容（DEC-709）；没有草稿单时才带出。 */
  temporary?: Temporary;
  /** 本周期停在草稿的转正申请（撤回单 / 第二步失败的单）：同单修改重提（DEC-103）。 */
  draft?: ApplicationDraft & { names: Values };
}

/**
 * 打开“转正申请”时读服务端（F-347，取代原本机存储里的草稿指针）：GET /employees/:id/regularization-draft 给出暂存与
 * 草稿单 ID，有草稿单再回读单据；换浏览器 / 换设备都一样，本机存储不可用也不影响。
 * 读取失败（非 404 / 403）不当作没有草稿——否则会另建第二张，交用户重试。
 */
export function useRegularizationRecovery(employeeId: string, enabled: boolean) {
  const api = useApiClient();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ attempt: number; recovery?: Recovery; error?: unknown }>();
  useEffect(() => {
    let live = true;
    const find = async (): Promise<Recovery | undefined> => {
      if (!enabled) return undefined;
      const view = await api.request<Values>(regularizationDraftPath(employeeId));
      if (view.employeeId !== employeeId || !Number.isSafeInteger(view.revision)) throw new Error(m.invalidReceipt);
      const id = typeof view.applicationId === 'string' ? view.applicationId : undefined;
      const latest = id
        ? await api.request<Values>(slotKey(businesses, id)).catch((error: unknown) => {
            if (gone(error)) return undefined;
            throw error;
          })
        : undefined;
      const draft = id && latest ? recoveredDraft(latest, employeeId, id) : undefined;
      return { revision: Number(view.revision), temporary: draft ? undefined : temporaryOf(view.temporary), draft };
    };
    find().then(
      (recovery) => live && setState({ attempt, recovery }),
      (error: unknown) => live && setState({ attempt, error }),
    );
    return () => {
      live = false;
    };
  }, [api, employeeId, enabled, attempt]);
  const current = state?.attempt === attempt ? state : undefined;
  return {
    done: !!current && !current.error,
    recovery: current?.recovery,
    error: current?.error,
    retry: () => setAttempt((n) => n + 1),
  };
}
