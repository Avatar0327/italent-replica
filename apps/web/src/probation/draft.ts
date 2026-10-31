import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../foundation/client.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Values } from '../foundation/forms/values.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import type { ApplicationDraft } from '../intern/commands.js';
import { businesses, recoveredDraft } from './model.js';

const Memory = createContext<Map<string, string> | undefined>(undefined);
/** 页面根部：本机存储写不进时的草稿指针后备，同样只存单据 ID；刷新或离开本页即失效。 */
export function DraftPointers({ children }: { children: ReactNode }) {
  const [memory] = useState(() => new Map<string, string>());
  return createElement(Memory.Provider, { value: memory }, children);
}

/**
 * 转正申请草稿的指针（P2-4，DEC-103 同单重提）：服务端没有“员工未提交的转正草稿”读投影，草稿也不进试用详情与视图行
 * （probation.ts cycleRegularization），前端只按 租户 × 身份 × 员工 记下草稿单 ID，内容一律以服务端单据为准。
 * 存储写不进（配额、隐私模式、浏览器策略）时改记在页面内存：同页关闭重开仍找回同一张单，不另建第二张；
 * 内存指针比存储里可能残留的旧指针新，读取时优先。
 */
export function useDraftPointer(employeeId: string) {
  const { tenantId, identityKey } = useSession();
  const memory = useContext(Memory)!;
  const key = `italent.probation.draft:${JSON.stringify([tenantId, identityKey, employeeId])}`;
  return useMemo(
    () => ({
      get(): string | undefined {
        if (memory.has(key)) return memory.get(key);
        try {
          return localStorage.getItem(key) ?? undefined;
        } catch {
          return undefined;
        }
      },
      put(id: string) {
        try {
          localStorage.setItem(key, id);
          memory.delete(key);
        } catch {
          memory.set(key, id);
        }
      },
      /** 只清指向这张单的指针：别处已换成新草稿时不误删。 */
      clear(id: string) {
        if (memory.get(key) === id) memory.delete(key);
        try {
          if (localStorage.getItem(key) === id) localStorage.removeItem(key);
        } catch {
          // 存储不可读写：内存指针已清，存储里本来也没有
        }
      },
      /** 指针只在页面内存里：刷新或离开本页后找不回，须提示用户。 */
      volatile: () => memory.has(key),
    }),
    [key, memory],
  );
}

/** 单据已删除 / 不可见：指针作废，按没有草稿继续。 */
const gone = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 403);

/**
 * 打开“转正申请”时按指针回读单据：仍是这名员工的转正申请草稿就沿用（只读、同单提交），否则清掉指针；
 * 读取失败（非 404 / 403）不当作没有草稿——否则会另建第二张，交用户重试。
 */
export function useRecoveredDraft(employeeId: string, enabled: boolean) {
  const api = useApiClient();
  const pointer = useDraftPointer(employeeId);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ attempt: number; draft?: ApplicationDraft; error?: unknown }>();
  useEffect(() => {
    let live = true;
    const find = async () => {
      const id = enabled ? pointer.get() : undefined;
      if (!id) return undefined;
      const latest = await api.request<Values>(slotKey(businesses, id)).catch((error: unknown) => {
        if (gone(error)) return undefined;
        throw error;
      });
      const draft = latest && recoveredDraft(latest, employeeId, id);
      if (!draft) pointer.clear(id);
      return draft;
    };
    find().then(
      (draft) => live && setState({ attempt, draft }),
      (error: unknown) => live && setState({ attempt, error }),
    );
    return () => {
      live = false;
    };
  }, [api, pointer, employeeId, enabled, attempt]);
  const current = state?.attempt === attempt ? state : undefined;
  return {
    done: !!current && !current.error,
    draft: current?.draft,
    error: current?.error,
    retry: () => setAttempt((n) => n + 1),
  };
}
