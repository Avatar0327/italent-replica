/** DEC-427 / 设计 §1.5、§4.6：同一契约在 PGlite 与真 PG 执行；HTTP 入口归 B3b。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  calcKey,
  CalcBlocked,
  CalcObjectFailure,
  defineCalcKinds,
} from '../../apps/api/src/modules/succession/calc-contract.js';
import { enqueueCalcRun, changeCalcRun, runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { deliverCalcNotification } from '../../apps/api/src/modules/succession/calc-notifications.js';
import { seedTenantWithMember } from './support/tenant-api.js';
import { rowsOf } from './support/f048.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const now = new Date('2026-10-11T08:00:00Z');
let member: Awaited<ReturnType<typeof seedTenantWithMember>>;
const db = () => testDb().db;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db(), member.tenant.id, fn);
const objects = (count: number) =>
  Array.from({ length: count }, () => ({ objectType: 'org' as const, objectId: randomUUID() }));
const request = (count = 1) => ({
  tenantId: member.tenant.id,
  kind: 'org_stats' as const,
  trigger: 'manual' as const,
  businessDate: '2026-10-11',
  commandId: randomUUID(),
  requestedBy: member.user.id,
  objects: objects(count),
});
const read = async (id: string) =>
  rowsOf<Record<string, unknown>>(
    await tx((t) =>
      t.execute(sql`
  SELECT * FROM succession_calc_runs WHERE id=${id}::uuid`),
    ),
  )[0]!;
const effects = async (id: string) =>
  rowsOf<{ n: number }>(
    await tx((t) =>
      t.execute(sql`
  SELECT count(*)::int n FROM sc_calc_effects WHERE run_id=${id}::uuid`),
    ),
  )[0]!.n;
const create = (input = request()) => tx((t) => enqueueCalcRun(t, input, now));
const change = async (id: string, action: 'retry' | 'abort') => {
  const row = await read(id);
  return tx((t) => changeCalcRun(t, member.tenant.id, id, Number(row.revision), action, randomUUID(), now));
};
type Hooks = Partial<Parameters<typeof defineCalcKinds>[0][number]>;
const kinds = (hooks: Hooks = {}) =>
  defineCalcKinds([
    {
      kind: 'org_stats',
      objectType: 'org',
      authorizePage: async () => member.user.id,
      execute: async ({ tx: t, run }, object) => {
        await t.execute(
          sql`INSERT INTO sc_calc_effects VALUES (${run.tenantId}::uuid, ${run.id}::uuid, ${object.objectId}::uuid)`,
        );
        return 'written';
      },
      ...hooks,
    },
  ]);
const page = (id: string, handlers = kinds()) => runCalcPage(db(), member.tenant.id, id, handlers, now);

beforeAll(async () => {
  member = await seedTenantWithMember(db(), 'calc-core');
  await db().execute(sql`CREATE TABLE sc_calc_effects (tenant_id uuid NOT NULL, run_id uuid, object_id uuid,
    PRIMARY KEY(tenant_id,run_id,object_id))`);
  await db().execute(sql`SELECT enable_tenant_isolation('sc_calc_effects')`);
  await db().execute(sql`GRANT SELECT,INSERT ON sc_calc_effects TO app_user`);
});

describe('AC-SC-calc-core run 契约', () => {
  it('五类键、租户本地日期、统计槽与改回旧间隔去重', () => {
    const base = request();
    expect(calcKey(base)).toBe(`org_stats:manual:${base.commandId}`);
    const scheduled = {
      ...base,
      trigger: 'schedule' as const,
      timezone: 'America/Chicago',
      now: new Date('2026-10-12T03:00Z'),
      intervalHours: 4,
    };
    expect(calcKey(scheduled)).toBe(`org_stats:schedule:${base.tenantId}:2026-10-11:4h:5`);
    expect(calcKey({ ...scheduled, kind: 'exit_sweep' })).toBe(`exit_sweep:schedule:${base.tenantId}:2026-10-11`);
    expect(calcKey({ ...scheduled, now: new Date('2026-10-12T06:00Z') })).not.toBe(calcKey(scheduled));
    expect(calcKey({ ...base, trigger: 'preferences_change', preferencesRevision: 2 })).toBe(
      `org_stats:preferences:${base.requestedBy}:2`,
    );
    expect(calcKey({ ...base, kind: 'org_health', trigger: 'review_sync', batchId: base.commandId })).toBe(
      `org_health:sync:${base.commandId}`,
    );
    expect(() => calcKey({ ...scheduled, intervalHours: 0 })).toThrow();
    expect(() => defineCalcKinds([{ ...kinds()[0]! }, { ...kinds()[0]! }])).toThrow();
  });

  it('冻结集合、同键同内容复用；同键异内容拒绝且不改原集合；租户隔离', async () => {
    const input = request(2);
    const id = await create(input);
    expect(await create({ ...input, objects: [...input.objects].reverse() })).toBe(id);
    await expect(create({ ...input, objects: objects(3) })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await read(id)).toMatchObject({ status: 'pending', attempt_no: 1 });
    const other = await seedTenantWithMember(db(), 'calc-other');
    expect(
      rowsOf(
        await withTenant(db(), other.tenant.id, (t) =>
          t.execute(sql`SELECT id FROM succession_calc_runs WHERE id=${id}::uuid`),
        ),
      ),
    ).toEqual([]);
    await expect(
      withTenant(db(), other.tenant.id, (t) => changeCalcRun(t, other.tenant.id, id, 1, 'abort', randomUUID(), now)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('201 个对象分为 200 + 1；跨页持续 running；终结通知一次，重复 worker 不重写', async () => {
    const id = await create(request(201));
    expect(await page(id)).toBe('running');
    expect(await effects(id)).toBe(200);
    expect(await page(id)).toBe('succeeded');
    expect(await effects(id)).toBe(201);
    expect(await page(id)).toBe('succeeded');
    const notices = rowsOf<{ id: string; state: string }>(
      await tx((t) => t.execute(sql`SELECT id,state FROM succession_notifications WHERE run_id=${id}::uuid`)),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.state).toBe('pending');
    let delivered = 0;
    const send = async () => {
      delivered++;
      return 'sent' as const;
    };
    await deliverCalcNotification(db(), member.tenant.id, notices[0]!.id, send, now);
    await deliverCalcNotification(db(), member.tenant.id, notices[0]!.id, send, now);
    expect(delivered).toBe(1);
  });

  it('对象保存点回滚副作用；partial 只恢复可重试对象，revision_conflict 永久保留', async () => {
    const input = request(3);
    const id = await create(input);
    const [retry, conflict] = input.objects;
    const handlers = kinds({
      execute: async (ctx, object) => {
        await kinds()[0]!.execute(ctx, object);
        if (object.objectId === retry!.objectId) throw new CalcObjectFailure('PRINCIPAL_SCOPE_MISSING', true);
        if (object.objectId === conflict!.objectId) throw new CalcObjectFailure('REVISION_CONFLICT', false);
        return 'written';
      },
    });
    expect(await page(id, handlers)).toBe('partial');
    expect(await effects(id)).toBe(1);
    const key = (await read(id)).idempotency_key;
    await change(id, 'retry');
    expect(await read(id)).toMatchObject({ status: 'pending', attempt_no: 2, idempotency_key: key });
    expect(await page(id)).toBe('partial');
    expect(await effects(id)).toBe(2);
    const failures = rowsOf<{ code: string }>(
      await tx((t) => t.execute(sql`SELECT code FROM succession_calc_run_failures WHERE run_id=${id}::uuid`)),
    );
    expect(failures).toEqual([{ code: 'REVISION_CONFLICT' }]);
    await expect(change(id, 'retry')).rejects.toMatchObject({ details: { reason: 'RUN_NOT_RETRYABLE' } });
  });

  it('页级基础设施错误回滚整页；blocked 恢复原集合；主体/缓存失效不跳过', async () => {
    const id = await create(request(3));
    let n = 0;
    expect(
      await page(
        id,
        kinds({
          execute: async (ctx, object) => {
            await kinds()[0]!.execute(ctx, object);
            if (++n === 2) throw new Error('模拟基础设施错误，不得持久化此文案');
            return 'written';
          },
        }),
      ),
    ).toBe('blocked');
    expect(await effects(id)).toBe(0);
    expect(await read(id)).toMatchObject({ block_reason: 'STORAGE_UNAVAILABLE' });
    await change(id, 'retry');
    expect(
      await page(
        id,
        kinds({
          authorizePage: async () => {
            throw new CalcBlocked('RULE_CACHE_STALE');
          },
        }),
      ),
    ).toBe('blocked');
    expect(await effects(id)).toBe(0);
    await change(id, 'retry');
    expect(await page(id)).toBe('succeeded');
    expect(await effects(id)).toBe(3);
  });

  it('kind 缺失 fail-closed；空集合成功；手动值和未变化都算成功；aborted 拒绝恢复', async () => {
    const absent = await create();
    expect(await page(absent, [])).toBe('blocked');
    expect(await effects(absent)).toBe(0);
    const empty = await create(request(0));
    expect(await page(empty)).toBe('succeeded');
    for (const outcome of ['manual_kept', 'unchanged'] as const) {
      const id = await create();
      expect(await page(id, kinds({ execute: async () => outcome }))).toBe('succeeded');
      expect(await effects(id)).toBe(0);
    }
    const id = await create();
    await change(id, 'abort');
    expect(await page(id)).toBe('aborted');
    expect(await effects(id)).toBe(0);
    await expect(change(id, 'retry')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'RUN_NOT_RETRYABLE' },
    });
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    'AC-SC-calc-pg 双 worker 在 run 行锁交错；第二个从下一页继续',
    async () => {
      const id = await create(request(201));
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const first = page(
        id,
        kinds({
          authorizePage: async () => {
            enter();
            await gate;
            return member.user.id;
          },
        }),
      );
      await entered;
      const second = page(id);
      try {
        await waitForBlocked(db(), 1);
      } finally {
        release();
      }
      expect(await Promise.all([first, second])).toEqual(['running', 'succeeded']);
      expect(await effects(id)).toBe(201);
    },
  );

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    'AC-SC-calc-pg 终止等待执行页提交；不会覆盖已提交页且后续页不执行',
    async () => {
      const id = await create(request(201));
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const first = page(
        id,
        kinds({
          authorizePage: async () => {
            enter();
            await gate;
            return member.user.id;
          },
        }),
      );
      await entered;
      const abort = tx(async (t) => {
        const row = rowsOf<{ revision: number }>(
          await t.execute(sql`SELECT revision FROM succession_calc_runs WHERE id=${id}::uuid FOR UPDATE`),
        )[0]!;
        return changeCalcRun(t, member.tenant.id, id, row.revision, 'abort', randomUUID(), now);
      });
      try {
        await waitForBlocked(db(), 1);
      } finally {
        release();
      }
      await Promise.all([first, abort]);
      expect(await page(id)).toBe('aborted');
      expect(await effects(id)).toBe(200);
    },
  );
});
