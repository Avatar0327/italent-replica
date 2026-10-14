/**
 * 调动场景的进度记录：每个场景首次到达目标状态后记“已完成”，判定为用户接管后记“已接管”（DEC-477），之后每次启动都不再
 * 推进或回退它——否则用户在演示里处理了种子单，重启（pnpm demo 会先跑种子）又会被种子改动。
 * 文件放在 `.demo/` 下，按租户 ID 区分：演示库 reset 后租户 ID 变化，旧记录自然失效。
 * 没有记录（文件缺失、损坏或不提供）时，调动阶段同样先做接管判定（transfers.nextSeedAction），只是每次都重新判定。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Promised<T> = Promise<T> | T;

export interface SeedProgress {
  completedTransfers(tenantId: string): Promised<ReadonlySet<string>>;
  markTransferCompleted(tenantId: string, scenarioId: string): Promised<void>;
  takenOverTransfers(tenantId: string): Promised<ReadonlySet<string>>;
  markTransferTakenOver(tenantId: string, scenarioId: string): Promised<void>;
}

type Field = 'transfers' | 'takenOver';
type Entry = Record<Field, string[]>;
const FIELDS: readonly Field[] = ['transfers', 'takenOver'];

export function memoryProgress(): SeedProgress {
  const store = new Map<string, Entry>();
  const list = (tenantId: string, field: Field) => new Set(store.get(tenantId)?.[field] ?? []);
  const add = (tenantId: string, field: Field, id: string) => {
    const entry = store.get(tenantId) ?? { transfers: [], takenOver: [] };
    store.set(tenantId, { ...entry, [field]: [...new Set([...entry[field], id])] });
  };
  return {
    completedTransfers: (tenantId) => list(tenantId, 'transfers'),
    markTransferCompleted: (tenantId, id) => add(tenantId, 'transfers', id),
    takenOverTransfers: (tenantId) => list(tenantId, 'takenOver'),
    markTransferTakenOver: (tenantId, id) => add(tenantId, 'takenOver', id),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : [];

/** 只保留结构正确的内容：租户条目是对象，两张清单各自是字符串数组；其余一律当作缺失。 */
function validShape(parsed: unknown): Record<string, Entry> {
  if (!isRecord(parsed)) return {};
  const result: Record<string, Entry> = {};
  for (const [tenantId, entry] of Object.entries(parsed)) {
    if (isRecord(entry))
      result[tenantId] = { transfers: stringList(entry.transfers), takenOver: stringList(entry.takenOver) };
  }
  return result;
}

export function fileProgress(path: string): SeedProgress {
  const read = (): Record<string, Entry> => {
    if (!existsSync(path)) return {};
    try {
      return validShape(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      // 记录损坏等同缺失：每次重新做接管判定
      return {};
    }
  };
  const list = (tenantId: string, field: Field) => new Set(read()[tenantId]?.[field] ?? []);
  const add = (tenantId: string, field: Field, id: string) => {
    const all = read();
    const entry = all[tenantId] ?? { transfers: [], takenOver: [] };
    const next = Object.fromEntries(
      FIELDS.map((name) => [name, [...new Set([...entry[name], ...(name === field ? [id] : [])])].sort()]),
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...all, [tenantId]: next }, null, 2)}\n`);
  };
  return {
    completedTransfers: (tenantId) => list(tenantId, 'transfers'),
    markTransferCompleted: (tenantId, id) => add(tenantId, 'transfers', id),
    takenOverTransfers: (tenantId) => list(tenantId, 'takenOver'),
    markTransferTakenOver: (tenantId, id) => add(tenantId, 'takenOver', id),
  };
}
