/**
 * AC-OA-29（R2-T08 §7.2～§7.4、§7.6A、§7.7、§7.8）：执行器经内部入口运行，明细执行器为假执行器。
 * 双进程同租户只有一个执行；组后 / 收尾前崩溃由接管者续跑，不重复、不永久暂停；被接管的旧持有者迟到提交被 fencing 拒绝；
 * 失败分类（业务失败 / 依赖失败 / 可恢复失败满 5 次 / 无执行器 / 范围扩大 / 主体层复核不通过）与暂存行过滤。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/errors.js';
import type { ExecutionGroup } from '../../apps/api/src/modules/org-adjustment/execution-groups.js';
import {
  runOrgAdjustmentSlot,
  runOrgAdjustmentTenant,
  type RunnerOptions,
} from '../../apps/api/src/modules/org-adjustment/execution-runner.js';
import {
  claimOrgAdjustmentRunner,
  fenced,
  FencingLost,
  RUNNER_LEASE_MS,
} from '../../apps/api/src/modules/org-adjustment/runner-lease.js';
import { scheduleOrgAdjustmentExecution } from '../../apps/api/src/modules/org-adjustment/schedule.js';
import { orgPeopleWorld, resultRows, TODAY } from './AC-ORG-people-support.js';
import {
  adjustmentState,
  executionAudits,
  fakeExecutors,
  itemResults,
  seedAdjustment,
  seedItem,
  tableRows,
} from './support/org-adjustment-execution.js';

const testDb = useTestDb();
const crash = new Error('模拟进程崩溃');

async function runnerWorld(label: string) {
  const db = testDb().db;
  const w = await orgPeopleWorld(db, label);
  let now = new Date(`${TODAY}T02:00:00.000Z`);
  const clock = () => now;
  const advance = (ms = RUNNER_LEASE_MS + 60_000) => (now = new Date(now.getTime() + ms));
  const tenant = { id: w.tenant.id, timezone: w.tenant.timezone };
  const run = (holderToken: string, options: RunnerOptions = {}) =>
    runOrgAdjustmentTenant(db, tenant, clock, { holderToken, ...options });
  const schedule = (adjustmentId: string) =>
    withTenant(db, tenant.id, (tx) =>
      scheduleOrgAdjustmentExecution(
        tx,
        { tenantId: tenant.id, userId: w.user.id, timezone: tenant.timezone, now, commandId: randomUUID() },
        adjustmentId,
      ),
    );
  /** 已排期的单：每个目标组织一条“变更”明细（无任职联动），返回单与各组 ID。 */
  async function scheduledAdjustment(targets: readonly string[], approvedAt?: string) {
    const adjustment = await seedAdjustment(db, tenant.id, {
      createdBy: w.user.id,
      subjectOrgId: targets[0]!,
      effectiveDate: TODAY,
      approvedAt,
    });
    const groups: string[] = [];
    for (const [index, targetOrgId] of targets.entries())
      groups.push(await seedItem(db, tenant.id, adjustment.id, { seq: index + 1, target_org_id: targetOrgId }));
    await schedule(adjustment.id);
    return { adjustment, groups };
  }
  const state = (id: string) => adjustmentState(db, tenant.id, id);
  const pauses = (id: string) => tableRows<{ org_id: string }>(db, tenant.id, 'org_adjustment_pauses', id);
  return { w, db, tenant, clock, advance, run, schedule, scheduledAdjustment, state, pauses };
}

const countOf = (actions: readonly string[], action: string) => actions.filter((a) => a === action).length;

describe('AC-OA-29 执行权与崩溃恢复', () => {
  it('双进程同租户同时领取：只有一个执行，每组只执行一次', async () => {
    const world = await runnerWorld('oa29-dual');
    const o1 = await world.w.org('组织一');
    const o2 = await world.w.org('组织二');
    const { adjustment, groups } = await world.scheduledAdjustment([o1.id, o2.id]);
    const a = fakeExecutors();
    const b = fakeExecutors();
    const results = await Promise.all([
      world.run('process-a', { executors: a.executors }),
      world.run('process-b', { executors: b.executors }),
    ]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect([...a.calls, ...b.calls]).toEqual(groups);
    expect((await world.state(adjustment.id)).execution_status).toBe(2);
    const actions = (await executionAudits(world.db, world.tenant.id, adjustment.id)).map((row) => row.action);
    expect(countOf(actions, 'org-adjustment.execution.started')).toBe(1);
    expect(countOf(actions, 'org-adjustment.execution.completed')).toBe(1);
  });

  it('组后崩溃、收尾前崩溃：租约过期后接管续跑，已完成组不重做，收尾补齐并解除暂停', async () => {
    const world = await runnerWorld('oa29-crash');
    const o1 = await world.w.org('组织一');
    const o2 = await world.w.org('组织二');
    const { adjustment, groups } = await world.scheduledAdjustment([o1.id, o2.id]);
    const first = fakeExecutors();
    const crashAfterFirst = (group: ExecutionGroup) => {
      if (group.id === groups[0]) throw crash;
    };
    await expect(
      world.run('process-a', { executors: first.executors, hooks: { afterGroup: crashAfterFirst } }),
    ).rejects.toBe(crash);
    expect(first.calls).toEqual([groups[0]]);
    expect((await world.state(adjustment.id)).execution_status, '执行中').toBe(3);
    expect((await world.pauses(adjustment.id)).map((p) => p.org_id).sort()).toEqual([o1.id, o2.id].sort());
    expect(await world.run('process-b'), '租约未过期：其他进程领不到').toEqual({ claimed: false, completed: [] });

    world.advance();
    const second = fakeExecutors();
    const crashBeforeFinalize = () => {
      throw crash;
    };
    await expect(
      world.run('process-b', { executors: second.executors, hooks: { beforeFinalize: crashBeforeFinalize } }),
    ).rejects.toBe(crash);
    expect(second.calls, '组一已提交，不重做').toEqual([groups[1]]);
    expect(await world.pauses(adjustment.id), '收尾前崩溃：暂停仍在').toHaveLength(2);

    world.advance();
    const third = fakeExecutors();
    expect(await world.run('process-c', { executors: third.executors })).toEqual({
      claimed: true,
      completed: [adjustment.id],
    });
    expect(third.calls).toEqual([]);
    expect(await world.pauses(adjustment.id), '接管后补收尾、暂停解除').toEqual([]);
    expect(await world.state(adjustment.id)).toMatchObject({
      execution_status: 2,
      state: 'done',
      success_count: 2,
      failure_count: 0,
      execution_note: '成功执行2个调整，失败0个调整',
    });
    const audits = await executionAudits(world.db, world.tenant.id, adjustment.id);
    const actions = audits.map((row) => row.action);
    expect(countOf(actions, 'org-adjustment.execution.takeover')).toBe(2);
    expect(countOf(actions, 'org-adjustment.execution.group.succeeded')).toBe(2);
    expect(countOf(actions, 'org-adjustment.execution.completed')).toBe(1);
    const system = audits.filter((row) => row.action !== 'org-adjustment.execution.scheduled');
    expect(
      system.every((row) => row.actor_user_id === null && row.after.trigger === `org-adjustment:${adjustment.id}`),
    ).toBe(true);
  });

  it('被接管的旧持有者迟到提交被 fencing 拒绝，新持有者续跑', async () => {
    const world = await runnerWorld('oa29-fencing');
    const o1 = await world.w.org('组织一');
    const o2 = await world.w.org('组织二');
    const { adjustment, groups } = await world.scheduledAdjustment([o1.id, o2.id]);
    const a = fakeExecutors();
    const takeOver = async () => {
      world.advance();
      expect(await claimOrgAdjustmentRunner(world.db, world.tenant.id, 'process-b', world.clock)).not.toBeNull();
    };
    expect(await world.run('process-a', { executors: a.executors, hooks: { afterGroup: takeOver } })).toEqual({
      claimed: true,
      completed: [],
      stopped: 'fencing',
    });
    expect(a.calls).toEqual([groups[0]]);
    const audits = await executionAudits(world.db, world.tenant.id, adjustment.id);
    const started = audits.find((row) => row.action === 'org-adjustment.execution.started')!;
    const oldLease = {
      tenantId: world.tenant.id,
      token: 'process-a',
      fencingNo: started.after.fencingNo as number,
      leaseMs: RUNNER_LEASE_MS,
      clock: world.clock,
    };
    const late = fenced(world.db, oldLease, (tx) =>
      tx.execute(sql`UPDATE org_adjustments SET subject='迟到写入' WHERE id=${adjustment.id}`),
    );
    await expect(late).rejects.toBeInstanceOf(FencingLost);
    const [head] = await withTenant(world.db, world.tenant.id, async (tx) =>
      resultRows<{ subject: string }>(
        await tx.execute(sql`SELECT subject FROM org_adjustments
        WHERE tenant_id=${world.tenant.id} AND id=${adjustment.id}`),
      ),
    );
    expect(head!.subject).toBe('合成调整');

    const b = fakeExecutors();
    expect((await world.run('process-b', { executors: b.executors })).completed).toEqual([adjustment.id]);
    expect([...a.calls, ...b.calls], '不乱序、不重复').toEqual(groups);
    expect(await world.pauses(adjustment.id)).toEqual([]);
  });
});

describe('AC-OA-29 失败分类与暂存过滤', () => {
  it('业务失败 / 依赖失败 / 可恢复失败满 5 次 / 无执行器；暂存行及其连带行不执行、不计数', async () => {
    const world = await runnerWorld('oa29-failures');
    const [o1, o2, o3, o4] = [
      await world.w.org('瞬时故障组织'),
      await world.w.org('新增上级'),
      await world.w.org('待停用'),
      await world.w.org('正常变更'),
    ];
    const staged = await world.w.org('暂存停用');
    const stagedChild = await world.w.org('暂存连带', staged.id);
    const { db, tenant } = world;
    const adjustment = await seedAdjustment(db, tenant.id, {
      createdBy: world.w.user.id,
      subjectOrgId: o1.id,
      effectiveDate: TODAY,
    });
    const item = (over: Record<string, unknown>) => seedItem(db, tenant.id, adjustment.id, over);
    const flaky = await item({ seq: 1, target_org_id: o1.id });
    const created = await item({ seq: 2, adjust_type: 1, parent_org_id: o2.id, name: '重名新组织' });
    const dependent = await item({ seq: 3, adjust_type: 1, parent_item_id: created, name: '其下级' });
    const deactivate = await item({ seq: 4, adjust_type: 3, target_org_id: o3.id });
    const ok = await item({ seq: 5, target_org_id: o4.id });
    const stagedRow = await item({ seq: 6, adjust_type: 3, target_org_id: staged.id, is_staged: true });
    const cascaded = await item({
      seq: 7,
      adjust_type: 3,
      target_org_id: stagedChild.id,
      cascaded_from_item_id: stagedRow,
    });
    await world.schedule(adjustment.id);
    const scope = await tableRows<{ org_id: string }>(db, tenant.id, 'org_adjustment_scope_orgs', adjustment.id);
    expect(scope.map((row) => row.org_id)).not.toContain(staged.id);
    expect(scope.map((row) => row.org_id)).not.toContain(stagedChild.id);

    const { calls, executors } = fakeExecutors((group) => {
      if (group.id === flaky) throw new Error('数据库连接中断');
      if (group.id === created) throw new AppError('VALIDATION_FAILED', '组织名称重复', { reason: 'NAME_DUPLICATED' });
    });
    const { 1: create, 2: change } = executors;
    for (let attempt = 1; attempt < 5; attempt++)
      expect(await world.run('process-a', { executors: { 1: create, 2: change } }), `第 ${attempt} 次`).toEqual({
        claimed: true,
        completed: [],
        stopped: 'retry',
      });
    expect((await world.run('process-a', { executors: { 1: create, 2: change } })).completed).toEqual([adjustment.id]);
    expect(calls.filter((id) => id === flaky)).toHaveLength(5);
    expect(
      calls.filter((id) => id === created),
      '业务失败不重试',
    ).toHaveLength(1);
    expect(calls).not.toContain(dependent);

    const results = await itemResults(db, tenant.id, adjustment.id);
    const reasonOf = (id: string) => [results.get(id)!.execution_result, results.get(id)!.execution_reason];
    expect(reasonOf(created)).toEqual([2, 'NAME_DUPLICATED']);
    expect(reasonOf(dependent)).toEqual([2, 'DEPENDENCY_FAILED']);
    expect(reasonOf(flaky)).toEqual([2, 'EXECUTION_ERROR']);
    expect(reasonOf(deactivate)).toEqual([2, 'EXECUTOR_NOT_AVAILABLE']);
    expect(reasonOf(ok)).toEqual([1, null]);
    for (const id of [stagedRow, cascaded])
      expect(results.get(id)).toMatchObject({ execution_result: null, exec_phase: 0 });
    const attempts = await tableRows<{ attempts: number }>(
      db,
      tenant.id,
      'org_adjustment_group_attempts',
      adjustment.id,
    );
    expect(attempts.map((row) => row.attempts)).toEqual([5]);
    expect(await world.state(adjustment.id)).toMatchObject({
      execution_status: 2,
      success_count: 1,
      failure_count: 4,
      execution_note: '成功执行1个调整，失败4个调整',
    });
    expect(await world.pauses(adjustment.id), '不永久暂停').toEqual([]);
  });

  it('执行开始复核：审批后范围扩大的组记 SCOPE_CHANGED、不暂停；主体层复核不通过记 APPLICANT_OUT_OF_SCOPE', async () => {
    const world = await runnerWorld('oa29-recheck');
    const target = await world.w.org('停用目标');
    await world.w.org('原有下级', target.id);
    const other = await world.w.org('其他变更');
    const denied = await world.w.org('无权组织');
    const { db, tenant } = world;
    const adjustment = await seedAdjustment(db, tenant.id, {
      createdBy: world.w.user.id,
      subjectOrgId: target.id,
      effectiveDate: TODAY,
    });
    const widened = await seedItem(db, tenant.id, adjustment.id, { seq: 1, adjust_type: 3, target_org_id: target.id });
    const kept = await seedItem(db, tenant.id, adjustment.id, { seq: 2, target_org_id: other.id });
    await world.schedule(adjustment.id);
    const outOfScope = await world.scheduledAdjustment([denied.id], '2026-09-30T01:00:00.000Z');
    await world.w.org('审批后新增下级', target.id);

    const { calls, executors } = fakeExecutors();
    const subjectCheck: RunnerOptions['subjectCheck'] = async (_tx, head) => head.id !== outOfScope.adjustment.id;
    const result = await world.run('process-a', { executors, subjectCheck });
    expect(result.completed).toEqual([adjustment.id, outOfScope.adjustment.id]);
    expect(calls).toEqual([kept]);
    const results = await itemResults(db, tenant.id, adjustment.id);
    expect(results.get(widened)).toMatchObject({ execution_result: 2, execution_reason: 'SCOPE_CHANGED' });
    expect(results.get(kept)).toMatchObject({ execution_result: 1 });
    const started = (await executionAudits(db, tenant.id, adjustment.id)).find((row) =>
      row.action.endsWith('.started'),
    );
    expect(started!.after.pausedOrgIds, '范围扩大的组不纳入暂停').toEqual([other.id]);
    const denials = await itemResults(db, tenant.id, outOfScope.adjustment.id);
    expect([...denials.values()].map((row) => row.execution_reason)).toEqual(['APPLICANT_OUT_OF_SCOPE']);
  });
});

describe('AC-OA-29 定时槽入口', () => {
  it('没有未完成执行队列的租户不领执行权；有到期单时同一槽内执行完成', async () => {
    const world = await runnerWorld('oa29-slot');
    const { db, tenant } = world;
    const runners = () =>
      withTenant(db, tenant.id, async (tx) =>
        resultRows<{ fencing_no: string }>(
          await tx.execute(sql`SELECT fencing_no::text FROM org_adjustment_tenant_runners
            WHERE tenant_id=${tenant.id}`),
        ),
      );
    const errors: unknown[] = [];
    const { calls, executors } = fakeExecutors();
    const slot = () =>
      runOrgAdjustmentSlot(db, world.clock, (error) => errors.push(error), { holderToken: 'process-a', executors });
    await slot();
    expect(await runners(), '无待执行单时不写执行权行').toEqual([]);

    const target = await world.w.org('定时槽组织');
    const { adjustment, groups } = await world.scheduledAdjustment([target.id]);
    await slot();
    expect(errors).toEqual([]);
    expect(calls).toEqual(expect.arrayContaining(groups));
    expect(await world.state(adjustment.id)).toMatchObject({ execution_status: 2, state: 'done' });
  });
});
