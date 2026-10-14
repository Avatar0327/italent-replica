/**
 * 演示种子的进程内接口调用：走真实路由、真实授权器与命令台账（不注入“全部允许”、不直接写业务表）。
 * 随机密钥只存在于本次运行内存，签名身份头与 vite 开发代理同一方案。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Db, Tx } from '@italent/db';
import { createApp } from '../app.js';
import { createDevIdentityResolver, devIdentityHeaders } from '../identity.js';

export type Json = Record<string, unknown>;

export type Call = (
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: number,
  /** 指定命令 ID（Idempotency-Key）；缺省每次随机。调动场景用确定性的键，续跑时据此认领自己发起的单子。 */
  commandId?: string,
) => Promise<Json>;

/** 可回拨的时钟：已完成的调动按历史日期提交与审批，之后拨回当前时间（后端一切“现在”都取这个时钟）。 */
export class DemoClock {
  private fixed: Date | null = null;
  constructor(private readonly real: () => Date) {}
  now = (): Date => this.fixed ?? this.real();
  /** 拨到某个业务日的上午（租户时区 Asia/Shanghai 的 10:00），传 null 拨回真实时间。 */
  setDay(day: string | null): void {
    this.fixed = day === null ? null : new Date(`${day}T02:00:00.000Z`);
  }
}

interface Response {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** 受保护写入的复核：在写入请求的每个数据库事务开头执行，返回 false 即拒绝（整笔回滚）。 */
export type WriteCheck = (tx: Tx) => Promise<boolean>;
export type Guarded = <T>(check: WriteCheck, run: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;

export interface DemoClient {
  /** 按租户绑定的调用函数。写请求都带新的 Idempotency-Key，有 revision 的对象带 If-Match。 */
  forTenant(tenantId: string): Call;
  /**
   * 受保护写入（#309 第 5 轮）：run 期间，进程内应用开启的每个数据库事务都先执行 check，判定与写入因此落在同一事务、
   * 同一组行锁之内；check 一旦返回 false，本事务和之后的事务都抛错回滚，写入不可能落库，结果为 { ok: false }。
   */
  guarded: Guarded;
}

class GuardRejected extends Error {
  constructor() {
    super('演示种子：写入前复核未通过，单据已被用户接管');
  }
}

export function createDemoClient(db: Db, clock: () => Date, nodeEnv?: string): DemoClient {
  const secret = randomBytes(32).toString('hex');
  const identity = createDevIdentityResolver({ secret, nodeEnv });
  let active: { readonly check: WriteCheck; rejected: boolean } | null = null;
  const transaction: Db['transaction'] = (fn, config) =>
    db.transaction(async (tx) => {
      const slot = active;
      if (slot && (slot.rejected || !(await slot.check(tx)))) {
        slot.rejected = true;
        throw new GuardRejected();
      }
      return fn(tx);
    }, config);
  // 只替换 transaction，其余属性与方法原样转给真实连接
  const guardedDb = new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') return transaction;
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const app = createApp({ db: guardedDb, identity, clock });
  const forTenant =
    (tenantId: string): Call =>
    async (userId, method, path, body, ifMatch, commandId) => {
      const headers: Record<string, string> = { ...devIdentityHeaders(secret, userId), 'x-tenant-id': tenantId };
      if (method !== 'GET') headers['idempotency-key'] = commandId ?? randomUUID();
      if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const response: Response = await app.request(path, init);
      if (!response.ok)
        throw new Error(`演示种子调用失败：${method} ${path} → ${response.status} ${await response.text()}`);
      return (await response.json()) as Json;
    };
  const guarded: Guarded = async (check, run) => {
    if (active) throw new Error('演示种子：受保护写入不能嵌套');
    const slot = { check, rejected: false };
    active = slot;
    try {
      const value = await run();
      return slot.rejected ? { ok: false } : { ok: true, value };
    } catch (error) {
      if (slot.rejected) return { ok: false };
      throw error;
    } finally {
      active = null;
    }
  };
  return { forTenant, guarded };
}

/** 读完列表接口的全部分页（每页 200）。 */
export async function listAll(call: Call, userId: string, path: string): Promise<Json[]> {
  const items: Json[] = [];
  for (let page = 1; ; page += 1) {
    const joiner = path.includes('?') ? '&' : '?';
    const response = await call(userId, 'GET', `${path}${joiner}page=${page}&pageSize=200`);
    const rows = (response.items ?? []) as Json[];
    items.push(...rows);
    if (rows.length < 200) return items;
  }
}
