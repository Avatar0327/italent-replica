/**
 * 调动场景的“初始化已完成”记录：每个场景首次到达目标状态后记一笔，之后每次启动都不再推进或回退它——
 * 否则用户在演示里重提 / 处理了种子单，重启（pnpm demo 会先跑种子）又会被种子改回预设状态。
 * 文件放在 `.demo/` 下，按租户 ID 区分：演示库 reset 后租户 ID 变化，旧记录自然失效。
 * 没有记录（文件缺失或不提供）时，调动阶段按业务单自身的状态推断是否已完成，同样只往前、不回退（transfers.ts）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SeedProgress {
  completedTransfers(tenantId: string): Promise<ReadonlySet<string>> | ReadonlySet<string>;
  markTransferCompleted(tenantId: string, scenarioId: string): Promise<void> | void;
}

export function memoryProgress(): SeedProgress {
  const store = new Map<string, Set<string>>();
  return {
    completedTransfers: (tenantId) => store.get(tenantId) ?? new Set(),
    markTransferCompleted: (tenantId, id) => {
      store.set(tenantId, (store.get(tenantId) ?? new Set()).add(id));
    },
  };
}

type FileShape = Record<string, { transfers: string[] }>;

export function fileProgress(path: string): SeedProgress {
  const read = (): FileShape => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as FileShape;
    } catch {
      // 记录损坏等同缺失：退回按业务单状态推断
      return {};
    }
  };
  return {
    completedTransfers: (tenantId) => new Set(read()[tenantId]?.transfers ?? []),
    markTransferCompleted: (tenantId, id) => {
      const all = read();
      const done = new Set(all[tenantId]?.transfers ?? []);
      done.add(id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ ...all, [tenantId]: { transfers: [...done].sort() } }, null, 2)}\n`);
    },
  };
}
