/**
 * F-457 / F-461（B3b，BE-11b 审查转出，同源）：执行器分页与失败计次的三处口径。
 * ① §7.7“连续 5 次”：可恢复错误计次在某页成功提交（'pending'）后清零，12 页中各有 5 页出一次瞬时错误不得记 EXECUTION_ERROR。
 * ② §7.5 T2 取页之后才取员工锁：取页与加锁之间新入职者在加锁后复查页内集合，不漏选（游标已越过的新入职者尤其如此）。
 * ③ 运行器记入内存的“已完成组结果 = 1”必须以库内值为准：组以 EMPLOYMENT_PARTIAL（2）收尾时，依赖它的后续组按依赖失败。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { GroupExecutor } from '../../apps/api/src/modules/org-adjustment/execution-groups.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { runOrgAdjustmentTenant } from '../../apps/api/src/modules/org-adjustment/execution-runner.js';
import { scheduleOrgAdjustmentExecution } from '../../apps/api/src/modules/org-adjustment/schedule.js';
import { type ExecWorld, execWorld } from './AC-OA-exec-support.js';
import { ALL } from './AC-OA-head-support.js';
import { rename } from './AC-OA-items-support.js';
import { orgPeopleWorld, resultRows, TODAY } from './AC-ORG-people-support.js';
import { itemResults, seedAdjustment, seedItem } from './support/org-adjustment-execution.js';

const testDb = useTestDb();

describe('F-457 ① 瞬时错误计次在页提交后清零（§7.7 连续 5 次）', () => {
  it('12 页中 5 页各出一次瞬时错误：不记 EXECUTION_ERROR；同一页连续 5 次才记', async () => {
    const w = await execWorld(testDb().db, 'oaf457-retry');
    const x = await w.org('ZZ_分页组织', w.a);
    const adjustment = await w.approved([w.a], [rename(x, { name: 'ZZ_分页改名' })]);
    const [lead] = [...(await w.outcomes(adjustment.id)).values()];
    const PAGES = 12;
    const flakyPages = new Set([1, 3, 5, 7, 9]);
    const failedOnce = new Set<number>();
    // 假的分页执行器：employment_done 即“已完成页数”；flakyPages 里的页第一次执行抛可恢复错误（事务回滚），再来则成功。
    const executor: GroupExecutor = async (tx, { group }) => {
      const done = resultRows<{ n: number }>(
        await tx.execute(sql`SELECT employment_done AS n FROM org_adjustment_org_items
          WHERE tenant_id=${w.tenant.id} AND id=${group.lead.id}::uuid`),
      )[0]!.n;
      if (done >= PAGES) return 'done';
      if (flakyPages.has(done) && !failedOnce.has(done)) {
        failedOnce.add(done);
        throw new Error('数据库连接中断');
      }
      await tx.execute(sql`UPDATE org_adjustment_org_items SET employment_done=employment_done+1, exec_phase=1
        WHERE tenant_id=${w.tenant.id} AND id=${group.lead.id}::uuid`);
      return 'pending';
    };

    let completed = false;
    for (let tick = 0; tick < 30 && !completed; tick++) {
      if (tick) w.advance();
      completed = (await w.run({ executors: { 2: executor } })).completed?.includes(adjustment.id) ?? false;
    }

    expect(completed).toBe(true);
    expect(failedOnce.size).toBe(5);
    expect((await w.outcomes(adjustment.id)).get(lead!.id)).toMatchObject({
      execution_result: 1,
      execution_reason: null,
      employment_done: PAGES,
    });
  });
});

/** 夹在取页与加锁之间的“新入职”：员工此前已建档但没有任何任职；在执行器同一事务里走正式入职写入口落地（生效日早于调整生效日）。 */
async function hireInTx(tx: Tx, w: ExecWorld, employeeId: string, departmentId: string) {
  // 正常路径下执行中的组织带暂停、入职会被拒（§7.6）；本用例验证的是暂停之外的纵深防御，故夹具先撤掉暂停行。
  await tx.execute(sql`DELETE FROM org_adjustment_pauses WHERE tenant_id=${w.tenant.id}`);
  const ctx = {
    tenantId: w.tenant.id,
    userId: w.hr.id,
    timezone: w.tenant.timezone,
    now: w.clock(),
    commandId: randomUUID(),
    expectedRevision: 1,
    scope: ALL,
  };
  const body = {
    kind: 'hire',
    mode: 'direct',
    effectiveDate: '2020-01-01',
    fields: { employType: 'internal', departmentId },
  };
  await createEmploymentBusiness(tx, ctx, employeeId, body as never);
}

describe('F-461 ② T2 取页到加锁之间新入职者不漏选', () => {
  it('游标已越过的新入职者：加锁后复查页内集合，该员工同样被追加任职', async () => {
    const w = await execWorld(testDb().db, 'oaf457-gap');
    const x = await w.org('ZZ_缝隙组织', w.a);
    // 页内最后一个 ID 之前的新入职者会被游标越过：id 小的一位取页后才入职进来，id 大的一位一开始就在页内。
    const [lo, hi] = [(await w.employee('ZZ_甲')).id, (await w.employee('ZZ_乙')).id].sort() as [string, string];
    await w.hire(hi, { departmentId: x });
    const late = lo;
    const adjustment = await w.approved(
      [w.a, w.b],
      [rename(x, { name: undefined, parent: { orgId: w.b }, addEmployment: true })],
    );
    let moved = false;
    const scopeOf = async (tx: Tx, q: { objectCode: string }) => {
      if (!moved && q.objectCode === 'TenantBase.EmploymentRecord') {
        moved = true;
        await hireInTx(tx, w, late, x);
      }
      return w.scopeOf(tx, q);
    };

    await w.run({ scopeOf });

    expect(moved, '夹在取页与加锁之间的变化已发生').toBe(true);
    const added = async (id: string) => (await w.records(id)).filter((r) => r.kind === 'org_adjustment');
    expect(await added(hi), '页内原有员工').toHaveLength(1);
    expect(await added(late), '游标越过的新入职者').toHaveLength(1);
    const [row] = [...(await w.outcomes(adjustment.id)).values()];
    expect(row).toMatchObject({ execution_result: 1, employment_done: 2 });
  });
});

describe('F-461 ③ 已完成组的结果以库内值为准', () => {
  it('组以 EMPLOYMENT_PARTIAL（2）收尾后，依赖它的后续组按依赖失败、不执行', async () => {
    const db = testDb().db;
    const w = await orgPeopleWorld(db, 'oaf461-partial');
    const now = new Date(`${TODAY}T02:00:00.000Z`);
    const tenant = { id: w.tenant.id, timezone: w.tenant.timezone };
    const [o1, o2] = [await w.org('ZZ_部分联动'), await w.org('ZZ_待停用')];
    const adjustment = await seedAdjustment(db, tenant.id, {
      createdBy: w.user.id,
      subjectOrgId: o1.id,
      effectiveDate: TODAY,
    });
    const partial = await seedItem(db, tenant.id, adjustment.id, { seq: 1, target_org_id: o1.id });
    // 同单内先“变更”后“停用”（§7.2 排序）：停用行的承接组织指向变更行，属跨组依赖。
    const dependent = await seedItem(db, tenant.id, adjustment.id, {
      seq: 2,
      adjust_type: 3,
      target_org_id: o2.id,
      transfer_to_item_id: partial,
    });
    await withTenant(db, tenant.id, (tx) =>
      scheduleOrgAdjustmentExecution(
        tx,
        { tenantId: tenant.id, userId: w.user.id, timezone: tenant.timezone, now, commandId: randomUUID() },
        adjustment.id,
      ),
    );
    const calls: string[] = [];
    // 与真实 T3 一致：执行器先把本行写成 EMPLOYMENT_PARTIAL（2）再返回 'done'（§7.5），运行器只补 exec_phase。
    const partialExecutor: GroupExecutor = async (tx, { group }) => {
      calls.push(group.id);
      if (group.id !== partial) return 'done';
      await tx.execute(sql`UPDATE org_adjustment_org_items SET execution_result=2,
          execution_reason='EMPLOYMENT_PARTIAL', execution_message='组织已调整，1 名员工任职追加失败'
        WHERE tenant_id=${tenant.id} AND id=${partial}::uuid`);
      return 'done';
    };

    await runOrgAdjustmentTenant(db, tenant, () => now, {
      holderToken: `p-${randomUUID()}`,
      executors: { 2: partialExecutor, 3: partialExecutor },
    });

    expect(calls, '依赖方不得执行').toEqual([partial]);
    const results = await itemResults(db, tenant.id, adjustment.id);
    expect(results.get(partial)).toMatchObject({ execution_result: 2, execution_reason: 'EMPLOYMENT_PARTIAL' });
    expect(results.get(dependent)).toMatchObject({ execution_result: 2, execution_reason: 'DEPENDENCY_FAILED' });
  });
});
