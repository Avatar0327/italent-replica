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
   * 发送前登记（第 3 轮：跨标签页互斥）：在锁内读占用、检查、写入，已有别的命令占着同一条目或同一恢复槽时
   * 以 RecoveryConflict 拒绝、不写入；锁被别的标签页一直占着时以 RecoveryLockBusy、浏览器不支持 Web Locks 时以
   * RecoveryLocksUnsupported 拒绝（DEC-954 / DEC-955）；写不进去时以其他错误拒绝。内核都不发出命令。
   */
  save(record: PendingRecord): Promise<void>;
  /** 删本命令的记录，同样在锁内读改写；失败不抛（结果已在内存落定）。 */
  remove(key: string, commandId: string): Promise<void>;
  /** 别的标签页改了记录（storage 事件）时回调；返回取消订阅。 */
  watch?(listener: () => void): () => void;
  /** 生成命令 ID 之前的前置拒绝（DEC-955）：返回错误即本次不登记、不发出（F-110 第 2 轮 P2-1）。 */
  precheck?(): Error | undefined;
}
/** 别的命令占着同一条目或同一恢复槽：本次命令不发出。 */
export class RecoveryConflict extends Error {}
/** DEC-954：等锁超时，锁被别的标签页一直占着（例如那页卡在登记中）：本次命令不发出。 */
export class RecoveryLockBusy extends Error {}
/** DEC-955：浏览器没有 Web Locks（http 非安全上下文或老浏览器），拿不到确定占用：本次命令不发出，不降级。 */
export class RecoveryLocksUnsupported extends Error {}
/**
 * DEC-955 前置检查：浏览器没有 Web Locks 时返回拒绝原因。http 非安全上下文同时没有 crypto.randomUUID，
 * 须在生成命令 ID 之前判定，专门提示才出得来；不登记恢复记录的写入入口（如清除调动暂存）也用它拦截。
 */
export const webLocksRefusal = () =>
  globalThis.navigator?.locks ? undefined : new RecoveryLocksUnsupported('web locks unsupported');
/**
 * 等锁上限。锁内只读写一次 localStorage，正常持锁是毫秒级；同时登记的别页、本页排队中的删除都在这段时间内放开，
 * 超过它才判为“锁被他页占用”（DEC-954），短暂互斥照常排队（F110-20）。
 */
export const LOCK_WAIT_MS = 3000;
export interface SharedRecoveryOptions {
  /**
   * DEC-955 只禁调动 / 审批写入：其余业务（组织调整）传 false，浏览器不支持 Web Locks 时退回无锁的读—查—写，
   * 仍能拦住同页与已落盘的别页命令，只是两页同一刻登记的竞争窗口不再互斥。默认 true。
   */
  requireLocks?: boolean;
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
const occupies = (item: PendingRecord, record: PendingRecord) =>
  item.commandId !== record.commandId &&
  (item.key === record.key || item.slots.some((slot) => record.slots.includes(slot)));

export function sharedRecovery(name: string, options: SharedRecoveryOptions = {}): CommandRecovery {
  const requireLocks = options.requireLocks ?? true;
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
  /**
   * 第 3 轮 P2：同一存储数组的读—查—写（登记与删除）都放进同名的 Web Locks 独占锁：同源各标签页按请求先后串行，
   * 不会两页都读到空记录后各自写入并发出。锁按存储键整份加（记录是一个数组，按条目 / 槽分锁仍会互相覆盖）；
   * 条目键与槽已含租户与身份，存储键按业务分开。浏览器不支持时拿不到确定占用，调动 / 审批一律拒绝登记（不发出，
   * DEC-955），不退回无锁读写。wait 只给登记用：删除不发命令，排队等锁即可。
   */
  const exclusive = async <T>(run: () => T, wait?: number): Promise<T> => {
    const locks = globalThis.navigator?.locks;
    if (!locks) {
      if (!requireLocks) return run();
      throw new RecoveryLocksUnsupported('web locks unsupported');
    }
    if (wait === undefined) return locks.request(storageKey, { mode: 'exclusive' }, run);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), wait);
    const granted = () => {
      clearTimeout(timer);
      return run();
    };
    try {
      return await locks.request(storageKey, { mode: 'exclusive', signal: abort.signal }, granted);
    } catch (error) {
      // 授予前定时器已清，abort 只会发生在等锁期间：此时回调没跑过，记录未写。
      if (abort.signal.aborted) throw new RecoveryLockBusy('cross-tab lock held elsewhere');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    precheck: () => (requireLocks ? webLocksRefusal() : undefined),
    load() {
      try {
        return read();
      } catch {
        return undefined;
      }
    },
    save(record) {
      return exclusive(() => {
        const records = read();
        if (records.some((item) => occupies(item, record))) throw new RecoveryConflict('command pending elsewhere');
        write([...records.filter((item) => item.key !== record.key), record]);
      }, LOCK_WAIT_MS);
    },
    async remove(key, commandId) {
      try {
        // 只删本命令的记录：同条目后来的命令、别页刚登记的命令都不受影响。
        await exclusive(() => {
          const records = read();
          const kept = records.filter((item) => item.key !== key || item.commandId !== commandId);
          if (kept.length !== records.length) write(kept);
        });
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
