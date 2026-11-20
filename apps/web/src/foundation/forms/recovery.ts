import type { Values } from './values.js';

/**
 * F-110：未确认命令（处理中、结果未知）的恢复记录。存 localStorage，同源的各标签页共用（第 2 轮 P2-2）：
 * 跨抽屉、跨路由、整页刷新、另开标签页都看得到同一条未确认命令；条目键与恢复槽已含租户与身份，不同用户互不影响。
 * 只存对账必需的命令 ID、版本、目标对象、恢复槽与命令上下文，不存请求体（字段原文）；
 * 所以刷新前或别的标签页的记录只能查询结果，不能原样重发（store replay 拒绝 restored）。
 */
export interface PendingRecord {
  /** 内核条目键（已按会话隔离）。 */
  key: string;
  /** 钉在本条目上的恢复槽（批量、带版本的冲突恢复条目与槽不同名）。 */
  slots: string[];
  commandId: string;
  revision?: number;
  businessId?: string;
  context?: Values;
  deletion?: boolean;
}
export interface CommandRecovery {
  /** 读不出（存储不可用、记录损坏）时返回 undefined：内核不据此接管或放开任何条目。 */
  load(): PendingRecord[] | undefined;
  /**
   * 发送前登记：写入前再读一次，已有别的命令占着同一条目或同一恢复槽（别的标签页抢先发出）时抛 RecoveryConflict、
   * 不写入；写不进去时抛错。两种情况内核都不发出命令。
   */
  save(record: PendingRecord): void;
  remove(key: string, commandId: string): void;
  /** 别的标签页改了记录（storage 事件）时回调；返回取消订阅。 */
  watch?(listener: () => void): () => void;
}
/** 别的命令占着同一条目或同一恢复槽：本次命令不发出。 */
export class RecoveryConflict extends Error {}

const validRecord = (value: unknown) => {
  const record = value as Partial<PendingRecord> | null;
  return (
    typeof record?.key === 'string' &&
    typeof record.commandId === 'string' &&
    Array.isArray(record.slots) &&
    record.slots.every((slot) => typeof slot === 'string')
  );
};
const occupies = (item: PendingRecord, record: PendingRecord) =>
  item.commandId !== record.commandId &&
  (item.key === record.key || item.slots.some((slot) => record.slots.includes(slot)));

export function sharedRecovery(name: string): CommandRecovery {
  const storageKey = `italent.commands.pending:${name}`;
  // 记录损坏时抛错：读不出哪些命令未确认，就不能放行新命令（save 失败 → 不发出）。
  const read = (): PendingRecord[] => {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(validRecord)) throw new Error('invalid pending commands');
    return parsed as PendingRecord[];
  };
  const write = (records: PendingRecord[]) => {
    if (records.length) localStorage.setItem(storageKey, JSON.stringify(records));
    else localStorage.removeItem(storageKey);
  };
  return {
    load() {
      try {
        return read();
      } catch {
        return undefined;
      }
    },
    save(record) {
      const records = read();
      if (records.some((item) => occupies(item, record))) throw new RecoveryConflict('command pending elsewhere');
      write([...records.filter((item) => item.key !== record.key), record]);
    },
    remove(key, commandId) {
      try {
        // 只删本命令的记录：同条目后来的命令不受迟到结果影响。
        const records = read();
        const kept = records.filter((item) => item.key !== key || item.commandId !== commandId);
        if (kept.length !== records.length) write(kept);
      } catch {
        // 存储损坏或不可用：内存里的结果已落定；损坏的存储保持原样，下次保存仍会拒绝发出。
      }
    },
    watch(listener) {
      if (typeof window === 'undefined') return () => {};
      // key 为 null 是别页清空了整个存储。
      const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey || event.key === null) listener();
      };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    },
  };
}
