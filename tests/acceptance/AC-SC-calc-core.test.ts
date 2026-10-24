/** DEC-427 / 设计 §1.5、§4.6：同一契约在 PGlite 与真 PG 执行；HTTP 入口归 B3b。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  calcKey,
  CalcBlocked,
  CalcObjectFailure,
  defineCalcKinds,
  type CalcInput,
  type CalcContext,
  type CalcObject,
} from '../../apps/api/src/modules/succession/calc-contract.js';
import { enqueueCalcRun, changeCalcRun, runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import {
  deliverCalcNotification,
  pendingCalcNotifications,
  settleCalcNotification,
} from '../../apps/api/src/modules/succession/calc-notifications.js';
import { seedTenantWithMember } from './support/tenant-api.js';
import { rowsOf } from './support/f048.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';

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
const create = (input: CalcInput = request()) => tx((t) => enqueueCalcRun(t, input, now));
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
  it('重复午夜：两个 00:30 均可登记，默认 4 小时槽及跨日以最早午夜为准', async () => {
    const input: CalcInput = {
      ...request(0),
      trigger: 'schedule',
      timezone: 'America/Havana',
      businessDate: '2026-11-01',
      intervalHours: 1,
    };
    const first = await create({ ...input, now: new Date('2026-11-01T04:30:00Z') });
    const second = await create({ ...input, now: new Date('2026-11-01T05:30:00Z') });
    expect(first).not.toBe(second);
    expect((await read(first)).idempotency_key).toBe(`org_stats:schedule:${input.tenantId}:2026-11-01:1h:0`);
    expect((await read(second)).idempotency_key).toBe(`org_stats:schedule:${input.tenantId}:2026-11-01:1h:1`);
    const before = await create({ ...input, intervalHours: 4, now: new Date('2026-11-01T07:59:59.999Z') });
    const boundary = await create({ ...input, intervalHours: 4, now: new Date('2026-11-01T08:00:00Z') });
    expect((await read(before)).idempotency_key).toContain(':4h:0');
    expect((await read(boundary)).idempotency_key).toContain(':4h:1');
    const next = await create({ ...input, businessDate: '2026-11-02', now: new Date('2026-11-02T05:00:00Z') });
    expect((await read(next)).idempotency_key).toContain(':2026-11-02:1h:0');
  });

  it.each([
    ['America/Havana', '2026-11-01', '2026-11-01T04:00Z', '2026-11-02T05:00Z'],
    ['America/Havana', '2026-03-08', '2026-03-08T05:00Z', '2026-03-09T04:00Z'],
    ['America/Santiago', '2026-09-06', '2026-09-06T04:00Z', '2026-09-07T03:00Z'],
    ['America/Chicago', '2026-11-01', '2026-11-01T05:00Z', '2026-11-02T06:00Z'],
    ['Asia/Shanghai', '2026-11-01', '2026-10-31T16:00Z', '2026-11-01T16:00Z'],
    ['UTC', '2026-11-01', '2026-11-01T00:00Z', '2026-11-02T00:00Z'],
  ])('%s %s：1～24 小时间隔的全部槽边界、缺失/重复午夜与跨日', async (timezone, businessDate, start, end) => {
    const input: CalcInput = { ...request(0), trigger: 'schedule', timezone, businessDate };
    const epoch = Date.parse(start);
    const nextDay = Date.parse(end);
    const key = (instant: number, h: number, date = businessDate) =>
      calcKey({
        ...input,
        businessDate: date,
        now: new Date(instant),
        intervalHours: h,
      });
    const nextDate = new Date(Date.parse(`${businessDate}T00:00Z`) + 86400000).toISOString().slice(0, 10);
    for (let h = 1; h <= 24; h++) {
      const prefix = `org_stats:schedule:${input.tenantId}:${businessDate}:${h}h:`;
      expect(key(epoch, h)).toBe(`${prefix}0`);
      for (let slot = 1; epoch + slot * h * 3600000 < nextDay; slot++) {
        const boundary = epoch + slot * h * 3600000;
        expect(key(boundary - 1, h)).toBe(`${prefix}${slot - 1}`);
        expect(key(boundary, h)).toBe(`${prefix}${slot}`);
        expect(key(boundary + 1, h)).toBe(`${prefix}${slot}`);
      }
      expect(key(nextDay - 1, h)).toBe(`${prefix}${Math.floor((nextDay - epoch - 1) / (h * 3600000))}`);
      expect(key(nextDay, h, nextDate)).toBe(`org_stats:schedule:${input.tenantId}:${nextDate}:${h}h:0`);
    }
    const id = await create({ ...input, now: new Date(epoch), intervalHours: 4 });
    expect((await read(id)).idempotency_key).toContain(`:${businessDate}:4h:0`);
  });

  it('class handler 的原型方法及 private this 上下文通过登记后实际写入对象', async () => {
    class Handler {
      readonly kind = 'org_stats' as const;
      readonly objectType = 'org' as const;
      #principal = member.user.id;
      #calls = 0;
      async authorizePage() {
        return this.#principal;
      }
      async execute({ tx: t, run }: CalcContext, object: CalcObject) {
        this.#calls++;
        await t.execute(sql`INSERT INTO sc_calc_effects VALUES
          (${run.tenantId}::uuid, ${run.id}::uuid, ${object.objectId}::uuid)`);
        return 'written' as const;
      }
      get calls() {
        return this.#calls;
      }
    }
    const instance = new Handler();
    const id = await create();
    expect(await page(id, defineCalcKinds([instance]))).toBe('succeeded');
    expect(await effects(id)).toBe(1);
    expect(instance.calls).toBe(1);
  });

  it('整页准备只调用一次且在对象保存点之前，登记保留 class preparePage 的 private this', async () => {
    class Handler {
      readonly kind = 'org_stats' as const;
      readonly objectType = 'org' as const;
      #prepared = 0;
      #calls = 0;
      async authorizePage() {
        return member.user.id;
      }
      async preparePage(_ctx: CalcContext, selected: readonly CalcObject[]) {
        this.#prepared++;
        expect(selected).toHaveLength(2);
      }
      async execute({ tx: t, run }: CalcContext, object: CalcObject) {
        expect(this.#prepared).toBe(1);
        this.#calls++;
        await t.execute(sql`INSERT INTO sc_calc_effects VALUES
          (${run.tenantId}::uuid,${run.id}::uuid,${object.objectId}::uuid)`);
        return 'written' as const;
      }
      get calls() {
        return this.#calls;
      }
    }
    const instance = new Handler();
    const id = await create(request(2));
    expect(await page(id, defineCalcKinds([instance]))).toBe('succeeded');
    expect(instance.calls).toBe(2);
    expect(await effects(id)).toBe(2);
  });

  it('夏令时回拨的两个 01:30，按租户午夜起算的实际分钟进入不同小时槽', async () => {
    const input = {
      ...request(0),
      trigger: 'schedule' as const,
      timezone: 'America/Chicago',
      businessDate: '2026-11-01',
      intervalHours: 1,
    };
    const first = await create({ ...input, now: new Date('2026-11-01T06:30:00Z') });
    const second = await create({ ...input, now: new Date('2026-11-01T07:30:00Z') });
    expect(first).not.toBe(second);
    expect((await read(first)).idempotency_key).toBe(`org_stats:schedule:${input.tenantId}:2026-11-01:1h:1`);
    expect((await read(second)).idempotency_key).toBe(`org_stats:schedule:${input.tenantId}:2026-11-01:1h:2`);
  });
  it('五类键、租户本地日期、统计槽与改回旧间隔去重', async () => {
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
    expect(calcKey({ ...scheduled, businessDate: '2026-10-12', now: new Date('2026-10-12T06:00Z') })).not.toBe(
      calcKey(scheduled),
    );
    expect(calcKey({ ...base, trigger: 'preferences_change', preferencesRevision: 2 })).toBe(
      `org_stats:preferences:${base.requestedBy}:2`,
    );
    expect(calcKey({ ...base, kind: 'org_health', trigger: 'review_sync', batchId: base.commandId })).toBe(
      `org_health:sync:${base.commandId}`,
    );
    expect(() => calcKey({ ...scheduled, intervalHours: 0 })).toThrow();
    await expect(create({ ...scheduled, businessDate: '2026-10-12' })).rejects.toThrow(
      '定时业务日期必须与租户槽日期相同',
    );
    const initial = await create(scheduled);
    expect(await create({ ...scheduled, intervalHours: 2 })).not.toBe(initial);
    expect(await create({ ...scheduled, objects: objects(2) })).toBe(initial);
    expect(await page(initial)).toBe('succeeded');
    expect(await effects(initial)).toBe(1);
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
    const before = await read(id);
    await expect(
      tx((t) => changeCalcRun(t, member.tenant.id, id, 1, 'abort', randomUUID(), now)),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await read(id)).toEqual(before);
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
        if (object.objectId === conflict!.objectId) throw new CalcObjectFailure('REVISION_CONFLICT', true);
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
    const aborted = await read(id);
    await expect(change(id, 'retry')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'RUN_NOT_RETRYABLE' },
    });
    expect(await read(id)).toEqual(aborted);
  });

  it('主体无有效成员时 blocked；恢复重验主体；已提交页在下一页失败后仍保留', async () => {
    const id = await create(request(201));
    expect(await page(id, kinds({ authorizePage: async () => randomUUID() }))).toBe('blocked');
    expect(await read(id)).toMatchObject({ block_reason: 'PRINCIPAL_UNAVAILABLE' });
    expect(await effects(id)).toBe(0);
    await change(id, 'retry');
    expect(await page(id)).toBe('running');
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
    expect(await effects(id)).toBe(200);
    await change(id, 'retry');
    expect(await page(id)).toBe('succeeded');
    expect(await effects(id)).toBe(201);
  });

  it('通知 unknown 不盲重发；停用或撤销接收人不登记；对象与通知约束由数据库兜底', async () => {
    const id = await create();
    expect(await page(id)).toBe('succeeded');
    const [notice] = rowsOf<{ id: string }>(
      await tx((t) => t.execute(sql`SELECT id FROM succession_notifications WHERE run_id=${id}::uuid`)),
    );
    let sends = 0;
    const send = async () => {
      sends++;
      throw new Error('模拟结果未知');
    };
    await deliverCalcNotification(db(), member.tenant.id, notice!.id, send, now);
    await deliverCalcNotification(db(), member.tenant.id, notice!.id, send, now);
    expect(sends).toBe(1);
    const [state] = rowsOf<{ state: string; attempt_no: number }>(
      await tx((t) =>
        t.execute(sql`SELECT state,attempt_no FROM succession_notifications WHERE id=${notice!.id}::uuid`),
      ),
    );
    expect(state).toEqual({ state: 'unknown', attempt_no: 1 });
    expect((await tx((t) => pendingCalcNotifications(t, member.tenant.id))).map((n) => n.id)).not.toContain(notice!.id);
    await tx((t) => settleCalcNotification(t, member.tenant.id, notice!.id, 0, 'failed', now));
    expect((await tx((t) => pendingCalcNotifications(t, member.tenant.id))).map((n) => n.id)).not.toContain(notice!.id);
    await tx((t) => settleCalcNotification(t, member.tenant.id, notice!.id, 1, 'failed', now));
    expect((await tx((t) => pendingCalcNotifications(t, member.tenant.id))).map((n) => n.id)).toContain(notice!.id);
    for (const column of ['user', 'member']) {
      const recipient = await seedTenantWithMember(db(), `calc-inactive-${column}`);
      await tx((t) =>
        t.execute(sql`INSERT INTO tenant_memberships (tenant_id,user_id,status)
          VALUES (${member.tenant.id}::uuid,${recipient.user.id}::uuid,'active')`),
      );
      if (column === 'user')
        await db().execute(sql`UPDATE users SET status='disabled' WHERE id=${recipient.user.id}::uuid`);
      else
        await tx((t) =>
          t.execute(sql`UPDATE tenant_memberships SET status='revoked' WHERE user_id=${recipient.user.id}::uuid`),
        );
      const inactive = await create({ ...request(), requestedBy: recipient.user.id });
      expect(await page(inactive)).toBe('succeeded');
      expect(
        rowsOf(await tx((t) => t.execute(sql`SELECT id FROM succession_notifications WHERE run_id=${inactive}::uuid`))),
      ).toEqual([]);
    }
    await expect(
      tx((t) =>
        t.execute(sql`INSERT INTO succession_notifications
      (tenant_id,run_id,batch_id,recipient_user_id,kind,command_id)
      VALUES (${member.tenant.id}::uuid,${id}::uuid,${randomUUID()}::uuid,${member.user.id}::uuid,'calc_done','bad')`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('已提交但连接回报失败：按 revision 回查确认，不改 blocked、不重复对象/通知/审计', async () => {
    const id = await create();
    let unknown = true;
    const actual = db();
    const transaction: Db['transaction'] = async (callback, config) => {
      const result = await actual.transaction(callback, config);
      if (unknown) {
        unknown = false;
        throw new Error('提交已完成，回包丢失');
      }
      return result;
    };
    const wrapped = new Proxy(actual, {
      get(target, key, receiver) {
        return key === 'transaction' ? transaction : Reflect.get(target, key, receiver);
      },
    });
    expect(await runCalcPage(wrapped, member.tenant.id, id, kinds(), now)).toBe('succeeded');
    expect(await page(id)).toBe('succeeded');
    expect(await effects(id)).toBe(1);
    const audit = rowsOf<{ n: number }>(
      await tx((t) => t.execute(sql`SELECT count(*)::int n FROM audit_events WHERE object_id=${id}`)),
    );
    expect(audit[0]!.n).toBe(2);
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    'AC-SC-calc-pg 并发同键建 run 只冻结一次，异内容败者不覆盖',
    async () => {
      const input = request(2);
      const ids = await Promise.all([create(input), create(input)]);
      expect(ids[0]).toBe(ids[1]);
      const results = await Promise.allSettled([create(input), create({ ...input, objects: objects(1) })]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect(await page(ids[0]!)).toBe('succeeded');
      expect(await effects(ids[0]!)).toBe(2);
    },
  );

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
      await withRelease(release, async (cleanup) => {
        [first, second].forEach(cleanup.track);
        await waitForBlocked(db(), 1);
      });
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
      await withRelease(release, async (cleanup) => {
        [first, abort].forEach(cleanup.track);
        await waitForBlocked(db(), 1);
      });
      await Promise.all([first, abort]);
      expect(await page(id)).toBe('aborted');
      expect(await effects(id)).toBe(200);
    },
  );
});
