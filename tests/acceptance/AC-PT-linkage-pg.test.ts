/**
 * BE-7 PT-7 真 PostgreSQL 交错（docs/08_设计/R2-T05_兼职设计.md §4.8 / §7.1，org/locks.ts 全局锁序）。PGlite 单连接无法并发，
 * 只在设了 TEST_DATABASE_URL 时运行：
 * - 联动执行（持员工闭包 + 组织锁）vs 组织停用：停用在组织锁上等待，放行后统计到兼职 → 409，负责人已设，不成环；
 * - 联动执行（持下属员工行锁）vs 下属离职：离职在员工行上等待，放行后照常落地，两方都成功、不死锁；
 * - 两个定时生效实例同时扫到同一到期联动：恰一次执行（员工行 SKIP LOCKED + 已执行标记），组织只多一个版本。
 */
import { withTenant, type Db, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentActivations } from '@italent/api';
import { createPartTime } from '../../apps/api/src/modules/employment/part-time/service.js';
import { LINKED, linkageWorld, type LinkageWorld } from './AC-PT-linkage-support.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { cmd } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 在租户事务里执行 work，停在提交之前直到 release；返回提交结果（成功 undefined，失败为错误）。 */
function holdThen(db: Db, tenantId: string, work: (tx: Tx) => Promise<unknown>) {
  const held = signal();
  const release = signal();
  const done = withTenant(db, tenantId, async (tx) => {
    await work(tx);
    held.resolve();
    await release.promise;
  }).then(
    () => undefined,
    (error: unknown) => {
      held.resolve();
      return error;
    },
  );
  return { held: held.promise, release: release.resolve, done };
}

const create = (w: LinkageWorld, tx: Tx, patch: Parameters<LinkageWorld['create']>[0]) =>
  createPartTime(tx, w.context(), {
    employeeId: w.employeeId,
    serviceType: 'part_time',
    startDate: '2026-09-01',
    departmentId: w.partTimeOrg.id,
    ...patch,
  });

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-PT-linkage-pg 兼职联动真 PG 交错', () => {
  it('联动执行先提交 → 组织停用在组织锁后统计到兼职，409；负责人已设，两事务不成环', async () => {
    const w = await linkageWorld(database().db, 'pg-org');
    const org = await w.org(`联动并发部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    const writer = holdThen(w.db, w.tenantId, (tx) => create(w, tx, { departmentId: org.id, isDepartmentHead: true }));
    await writer.held;
    const disable = w.disableOrg(org, '2026-10-02');
    await waitForBlocked(w.db, 1);
    writer.release();
    expect(await writer.done).toBeUndefined();
    const response = await disable;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ORG_SUBTREE_NOT_EMPTY' } } });
    expect(await w.headOf(org.id)).toBe(w.employeeId);
  });

  it('联动执行持下属员工行锁 → 下属离职等待，放行后落地；两方都成功，下属经理已改、负责人已设', async () => {
    const w = await linkageWorld(database().db, 'pg-leave');
    const sub = await w.subordinate();
    const writer = holdThen(w.db, w.tenantId, (tx) =>
      create(w, tx, { isDepartmentHead: true, addedSubordinateIds: [sub] }),
    );
    await writer.held;
    const revision = (await w.getEmployee(sub)).revision;
    const leave = w.business(sub, { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' }, revision);
    await waitForBlocked(w.db, 1);
    writer.release();
    expect(await writer.done).toBeUndefined();
    expect(await leave).toMatchObject({ kind: 'leave' });
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
  });

  it('两个实例同时扫到同一到期联动：恰一次执行，组织只多一个版本', async () => {
    const w = await linkageWorld(database().db, 'pg-sweep');
    const sub = await w.subordinate();
    const record = await w.create({ startDate: '2026-10-10', isDepartmentHead: true, addedSubordinateIds: [sub] });
    const versions = await w.orgVersions(w.partTimeOrg.id);
    const clock = () => new Date('2026-10-10T01:00:00.000Z');
    const runs = await Promise.all(
      [1, 2].map(() => runEmploymentActivations(w.db, cmd(), { tenantId: w.tenantId }, { clock })),
    );
    for (const run of runs) expect(run.runs[0]!.errors).toEqual([]);
    expect(await w.events(record.id)).toMatchObject({ [LINKED]: 1 });
    expect(await w.orgVersions(w.partTimeOrg.id)).toBe(versions + 1);
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    expect((await w.managerOf(sub, '2026-10-10')).directManagerId).toBe(w.employeeId);
  });
});
