/** AC-EV-F091 / DEC-413：活动引用与评价表停用，真 PostgreSQL 两种行锁顺序。 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../apps/api/src/errors.js';
import { registerInUse } from '../../apps/api/src/modules/evaluation/usage.js';
import type * as FormService from '../../apps/api/src/modules/evaluation/form-service.js';
import { formOperator, FORMS, formWorld, type FormView, type FormWorld } from './AC-EV-form-support.js';
import { errorOf, ok } from './AC-EV-support.js';
import { withRelease } from './support/pg-interleave.js';

const race = vi.hoisted(() => ({
  active: false,
  entered: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
}));
vi.mock('../../apps/api/src/modules/evaluation/form-service.js', async (importOriginal) => {
  const original = await importOriginal<typeof FormService>();
  return {
    ...original,
    updateForm: async (...args: Parameters<typeof original.updateForm>) => {
      const result = await original.updateForm(...args);
      if (race.active && args[3].enabled === false) {
        race.entered?.();
        await race.gate; // UPDATE 与审计已写，命令事务尚未提交，真实排他锁仍持有。
      }
      return result;
    },
  };
});

function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const rows = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows);
async function expectLockWait(db: Db) {
  for (let tries = 0; tries < 200; tries++) {
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%ev_forms%'`);
    if (rows<{ n: number }>(result)[0]!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('未观察到真实 PostgreSQL 行锁等待');
}

const testDb = useTestDb();
describe.skipIf(!process.env['TEST_DATABASE_URL'])('AC-EV-F091-reference-pg 活动引用 × 停用', () => {
  let w: FormWorld;
  let op: Awaited<ReturnType<typeof formOperator>>;
  beforeAll(async () => {
    w = await formWorld(testDb().db);
    op = await formOperator(w, { evOrgs: [w.orgA] });
    // 活动表在 B5：夹具只实现已约定的“活动环节引用”契约，不伪造产品活动入口。
    await testDb().db.execute(sql`CREATE TABLE ev_f091_activity_refs (
      tenant_id uuid NOT NULL, form_id uuid NOT NULL,
      FOREIGN KEY (tenant_id, form_id) REFERENCES ev_forms(tenant_id, id))`);
    await testDb().db.execute(sql`ALTER TABLE ev_f091_activity_refs ENABLE ROW LEVEL SECURITY`);
    await testDb().db.execute(sql`ALTER TABLE ev_f091_activity_refs FORCE ROW LEVEL SECURITY`);
    await testDb().db.execute(sql`CREATE POLICY tenant_isolation ON ev_f091_activity_refs
      USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
    await testDb().db.execute(sql`GRANT SELECT, INSERT ON ev_f091_activity_refs TO app_user, app_platform`);
    registerInUse(
      'evaluationForm',
      {
        sql: (ctx, id) => sql`SELECT 1 FROM ev_f091_activity_refs
        WHERE tenant_id = ${ctx.tenantId}::uuid AND form_id = ${id}::uuid`,
        message: '已在活动中使用此评价表，无法停用',
        reason: 'EVALUATION_FORM_IN_USE',
      },
      'disable',
    );
  });
  const form = () =>
    w.adminForm({
      name: '并发引用评价表',
      ownerOrgId: w.orgA,
      scoreMode: 'by_indicator',
      fullScore: 100,
      passScore: 60,
      totalRule: 'average',
      items: [],
    });
  const disable = (f: FormView) =>
    op.request('PATCH', `${FORMS}/${f.id}`, {
      ifMatch: f.revision,
      body: { enabled: false },
    });
  const read = (f: FormView) => op.request('GET', `${FORMS}/${f.id}`).then((r) => ok<FormView>(r));
  const countRefs = async (f: FormView) =>
    withTenant(
      testDb().db,
      w.tenant.id,
      async (tx) =>
        rows<{ n: number }>(
          await tx.execute(sql`SELECT count(*)::int AS n FROM ev_f091_activity_refs
      WHERE tenant_id = ${w.tenant.id}::uuid AND form_id = ${f.id}::uuid`),
        )[0]!.n,
    );
  const addReference = (f: FormView, ready?: () => void, gate?: Promise<void>) =>
    withTenant(testDb().db, w.tenant.id, async (tx) => {
      // B4 / B5 的引用协议：被引用方 FOR SHARE 后读启用状态，与停用的 FOR UPDATE 串行。
      const current = rows<{ enabled: boolean }>(
        await tx.execute(sql`SELECT enabled FROM ev_forms
        WHERE tenant_id = ${w.tenant.id}::uuid AND id = ${f.id}::uuid FOR SHARE`),
      )[0]!;
      if (!current.enabled)
        throw new AppError('VALIDATION_FAILED', '评价表已停用，不能引用', {
          reason: 'REFERENCE_DISABLED',
        });
      await tx.execute(sql`INSERT INTO ev_f091_activity_refs VALUES (${w.tenant.id}, ${f.id})`);
      ready?.();
      await gate;
    });

  it('AC-EV-F091-PG-01 活动引用先持共享锁：停用真实等待后 409，表仍启用且引用完整', async () => {
    const f = await form();
    const ready = latch();
    const gate = latch();
    const reference = addReference(f, ready.open, gate.promise);
    await ready.promise;
    const disabling = disable(f);
    await withRelease(
      () => gate.open(),
      async (cleanup) => {
        [reference, disabling].forEach(cleanup.track);
        await expectLockWait(testDb().db);
      },
    );
    await reference;
    const response = await disabling;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await errorOf(response)).toMatchObject({ reason: 'EVALUATION_FORM_IN_USE' });
    expect(await read(f)).toEqual(f);
    expect(await countRefs(f)).toBe(1);
  });

  it('AC-EV-F091-PG-02 停用先持排他锁：新增引用真实等待后被拒，不产生停用表的新引用', async () => {
    const f = await form();
    const ready = latch();
    const gate = latch();
    race.active = true;
    race.entered = ready.open;
    race.gate = gate.promise;
    const disabling = disable(f);
    await ready.promise;
    const reference = addReference(f).then(
      () => null,
      (error: unknown) => error,
    );
    await withRelease(
      () => {
        gate.open();
        race.active = false;
      },
      async (cleanup) => {
        [disabling, reference].forEach(cleanup.track);
        await expectLockWait(testDb().db);
      },
    );
    const response = await disabling;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await reference).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'REFERENCE_DISABLED' } });
    expect(await read(f)).toMatchObject({ enabled: false, revision: f.revision + 1 });
    expect(await countRefs(f)).toBe(0);
  });
});
