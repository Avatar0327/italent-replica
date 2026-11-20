import type { Values } from './values.js';

/**
 * F-110：未确认命令（处理中、结果未知）的恢复记录。存 sessionStorage：本标签页内跨抽屉、跨路由、整页刷新都还在，
 * 关闭标签页即清空。只存对账必需的命令 ID、版本、目标对象、恢复槽与命令上下文，不存请求体（字段原文）；
 * 所以刷新后的记录只能查询结果，不能原样重发（store replay 拒绝 restored）。
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
  load(): PendingRecord[];
  /** 写不进去时抛错：内核据此不发出命令，免得刷新后丢锁。 */
  save(record: PendingRecord): void;
  remove(key: string, commandId: string): void;
}

const validRecord = (value: unknown) => {
  const record = value as Partial<PendingRecord> | null;
  return (
    typeof record?.key === 'string' &&
    typeof record.commandId === 'string' &&
    Array.isArray(record.slots) &&
    record.slots.every((slot) => typeof slot === 'string')
  );
};

export function sessionRecovery(name: string): CommandRecovery {
  const storageKey = `italent.commands.pending:${name}`;
  // 记录损坏时抛错：读不出哪些命令未确认，就不能放行新命令（save 失败 → 不发出）。
  const read = (): PendingRecord[] => {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(validRecord)) throw new Error('invalid pending commands');
    return parsed as PendingRecord[];
  };
  const write = (records: PendingRecord[]) => {
    if (records.length) sessionStorage.setItem(storageKey, JSON.stringify(records));
    else sessionStorage.removeItem(storageKey);
  };
  return {
    load() {
      try {
        return read();
      } catch {
        return [];
      }
    },
    save(record) {
      write([...read().filter((item) => item.key !== record.key), record]);
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
  };
}
