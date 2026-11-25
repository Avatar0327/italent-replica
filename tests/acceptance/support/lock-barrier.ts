/**
 * 锁屏障验收共用（F-560 抽出，F-565 复用）：真 PG 下“另一事务持锁 → 请求排到锁上 → 收回授权 → 放锁”的时序夹具、
 * 全行快照（零写入比对）与“撤权拒绝 / 对照成功”两条用例的生成器。屏障只在真 PG（TEST_DATABASE_URL）下有意义。
 */
import { CONTRACT_OBJECT } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { waitForLockWaiters } from '../AC-TRF-F181a-support.js';
import { EMPTY_SCOPE } from '../../../apps/api/src/modules/permission/scope-types.js';
import type { revocable } from './revocable-rights.js';
import { uniqueSuffix } from './unique.js';

/** 屏障夹具只用到的世界切面：连接与租户（LinkageWorld / GateWorld 都满足）。 */
export interface BarrierWorld {
  readonly db: Db;
  readonly session: { readonly tenant: { readonly id: string } };
}
export const pg = Boolean(process.env.TEST_DATABASE_URL);
export type Db = Parameters<typeof withTenant>[0];
export const rows = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows);

/**
 * 另开一个事务持有员工行（或业务头）直到 release，模拟“另一名经办人正在改这名员工 / 这张单”。
 * level = 'no-key'：只持 FOR NO KEY UPDATE（与任职写入口同强度），不挡外键子行插入的 KEY SHARE（F-565 ④）。
 */
export function holdRow(
  db: Db,
  tenantId: string,
  table: 'employees' | 'heads',
  id: string,
  level: 'update' | 'no-key' = 'update',
) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => (locked = resolve));
  const from = table === 'employees' ? sql`employment_employees` : sql`employment_business_objects`;
  const done = withTenant(db, tenantId, async (tx) => {
    const strength = level === 'update' ? sql`FOR UPDATE` : sql`FOR NO KEY UPDATE`;
    await tx.execute(sql`SELECT id FROM ${from} WHERE tenant_id=${tenantId} AND id=${id}::uuid ${strength}`);
    locked();
    await released;
  });
  return {
    ready: Promise.race([ready, done]),
    release: async () => {
      release();
      await done;
    },
  };
}

/** 等到有请求卡在业务头（employment_business_objects）的行锁上；`stop` 为真（请求已经返回）就不再等。 */
export async function waitForHeadWaiter(db: Db, stop: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (stop()) return;
    const found = rows(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%employment_business_objects%'`),
    ) as { n: number }[];
    if (found[0]!.n >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('没有请求卡在业务头行锁上');
}

const BASE_TABLES = [
  'employment_employees',
  'employment_business_objects',
  'employment_payload_versions',
  'employment_state_events',
  'employment_records',
  'employment_activation_attempts',
  'employment_outbox',
  'transfer_requests',
  'transfer_linkage_versions',
  'transfer_linkage_runs',
  'transfer_linkage_items',
  'transfer_draft_slots',
  'audit_events',
  'command_ledger',
];

/** 全行快照：同时捕获新增与原地改写，“零写入”拿它比。`extra` 追加离职等本单关心的表。 */
export async function state(w: BarrierWorld, extra: readonly string[] = []) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result: Record<string, unknown> = {};
    for (const table of [...BASE_TABLES, ...extra]) {
      const found = await tx.execute(sql`SELECT to_jsonb(t) AS value FROM ${sql.identifier(table)} t
        WHERE tenant_id=${w.session.tenant.id} ORDER BY to_jsonb(t)::text`);
      result[table] = rows(found);
    }
    return result;
  });
}

export interface Scenario {
  readonly w: BarrierWorld;
  readonly rights: ReturnType<typeof revocable>['rights'];
  /** 被另一事务持有的行：员工行或业务头。 */
  readonly hold: { readonly table: 'employees' | 'heads'; readonly id: string; readonly level?: 'update' | 'no-key' };
  readonly send: () => Promise<Response>;
  /** 零写入快照额外要比的表（离职扩展表等）。 */
  readonly extraTables?: readonly string[];
}

export type Revoke = (rights: Scenario['rights']) => void;
/** 收回整份数据范围（事务内解析到空范围）。 */
export const emptyRange: Revoke = (rights) => {
  rights.scope = undefined;
  rights.emptyScope = true;
};
/** 只收回合同对象的范围，任职等其他对象的范围不动。 */
export const emptyContractRange: Revoke = (rights) => {
  rights.objectScopes = { [CONTRACT_OBJECT]: EMPTY_SCOPE };
};

/**
 * 屏障：持锁 → 发请求 → 等它排到锁上 → （revoke 时）收回范围 → 放锁。
 * `waited` 为假说明请求没有排到锁上就已返回（夹具没走到窗口），断言里单独判，避免用例空过。
 */
export async function race(s: Scenario, revoke: Revoke | false) {
  const held = holdRow(s.w.db, s.w.session.tenant.id, s.hold.table, s.hold.id, s.hold.level);
  await held.ready;
  let done = false;
  const response = s.send();
  void response.finally(() => (done = true));
  if (s.hold.table === 'employees') await waitForLockWaiters(s.w.db, 1, () => done);
  else await waitForHeadWaiter(s.w.db, () => done);
  const waited = !done;
  if (revoke) revoke(s.rights);
  await held.release();
  return { waited, response: await response };
}

export const refused = (status: number) => [403, 404].includes(status);

/** 一个入口的两条用例：等锁期间收回范围 → 拒绝且零写入；对照：没收回 → 等完锁后照常成功。 */
export function entryCases(
  prefix: string,
  name: string,
  build: (label: string) => Promise<Scenario>,
  success: number | readonly number[],
) {
  const accepted = Array.isArray(success) ? success : [success];
  describe.runIf(pg)(name, () => {
    it('等锁期间数据范围被收回：放锁后按收回后的授权拒绝，零写入', async () => {
      const s = await build(`${prefix}-${uniqueSuffix()}`);
      const before = await state(s.w, s.extraTables);
      const r = await race(s, emptyRange);
      expect(r.waited, '请求没有排到锁上，屏障没有生效').toBe(true);
      const text = await r.response.clone().text();
      expect(refused(r.response.status), `等锁期间撤权后应 403 / 404，实际 ${r.response.status}：${text}`).toBe(true);
      expect(await state(s.w, s.extraTables)).toEqual(before);
    });

    it('对照：范围没被收回：等完锁后照常成功（修前合法路径仍成功）', async () => {
      const s = await build(`${prefix}-${uniqueSuffix()}-ok`);
      const before = await state(s.w, s.extraTables);
      const r = await race(s, false);
      expect(r.waited, '请求没有排到锁上，屏障没有生效').toBe(true);
      expect(accepted, await r.response.clone().text()).toContain(r.response.status);
      expect(await state(s.w, s.extraTables)).not.toEqual(before);
    });
  });
}
