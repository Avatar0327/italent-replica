/**
 * AC-OA-06（排期 / 暂停部分）、AC-OA-12（执行状态迁移，经内部入口）、AC-OA-23（执行完成站内消息通知申请人）。
 * R2-T08 §7.1：数据量 > 5000 次日 03:00（租户时区）执行，否则当天；§7.6 执行期间相关部门调动 / 入职 409；§7.8 收尾通知。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runOrgAdjustmentTenant } from '../../apps/api/src/modules/org-adjustment/execution-runner.js';
import { pickAdjustment } from '../../apps/api/src/modules/org-adjustment/runner-lease.js';
import { scheduleOrgAdjustmentExecution } from '../../apps/api/src/modules/org-adjustment/schedule.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { orgPeopleWorld, resultRows, TODAY } from './AC-ORG-people-support.js';
import {
  adjustmentState,
  fakeExecutors,
  seedAdjustment,
  seedApprovalInstance,
  seedItem,
} from './support/org-adjustment-execution.js';

const testDb = useTestDb();

async function scheduleWorld(label: string) {
  const db = testDb().db;
  const w = await orgPeopleWorld(db, label);
  const tenant = { id: w.tenant.id, timezone: w.tenant.timezone };
  const schedule = (adjustmentId: string, now: Date) =>
    withTenant(db, tenant.id, (tx) =>
      scheduleOrgAdjustmentExecution(
        tx,
        { tenantId: tenant.id, userId: w.user.id, timezone: tenant.timezone, now, commandId: randomUUID() },
        adjustmentId,
      ),
    );
  const adjustment = (subjectOrgId: string) =>
    seedAdjustment(db, tenant.id, { createdBy: w.user.id, subjectOrgId, effectiveDate: TODAY });
  const picked = async (now: Date) =>
    (await withTenant(db, tenant.id, (tx) => pickAdjustment(tx, tenant.id, tenant.timezone, now)))?.adjustment_id;
  return { w, db, tenant, schedule, adjustment, picked };
}

describe('AC-OA-06 排期与执行期间暂停', () => {
  it('数据量 6000 → 次日 03:00（租户时区）才可领取；少量数据当天可领取', async () => {
    const world = await scheduleWorld('oa06-volume');
    expect(world.tenant.timezone).toBe('Asia/Shanghai');
    const org = await world.w.org('大批量组织');
    const big = await world.adjustment(org.id);
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO org_adjustment_org_items(tenant_id, id, adjustment_id, seq, adjust_type, parent_org_id, name)
        SELECT ${world.tenant.id}, gen_random_uuid(), ${big.id}, g, 1, ${org.id}, '批量新增' || g
        FROM generate_series(1, 6000) AS g`),
    );
    const lateEvening = new Date(`${TODAY}T15:30:00.000Z`); // 上海 23:30
    expect(await world.schedule(big.id, lateEvening)).toEqual({
      runOnDate: '2026-10-02',
      runFromHour: 3,
      dataVolume: 6000,
    });
    expect(await adjustmentState(world.db, world.tenant.id, big.id)).toMatchObject({
      data_volume: 6000,
      state: 'pending',
      run_on_date: '2026-10-02',
      run_from_hour: 3,
    });
    expect(await world.picked(new Date('2026-10-01T18:59:00.000Z')), '上海次日 02:59 尚未到点').toBeUndefined();
    expect(await world.picked(new Date('2026-10-01T19:00:00.000Z')), '上海次日 03:00').toBe(big.id);

    const small = await world.adjustment(org.id);
    await seedItem(world.db, world.tenant.id, small.id, { seq: 1, target_org_id: org.id });
    expect(await world.schedule(small.id, lateEvening)).toEqual({ runOnDate: TODAY, runFromHour: 0, dataVolume: 1 });
  });

  it('执行期间：相关部门入职 / 调入 409；执行完成后照常', async () => {
    const world = await scheduleWorld('oa06-pause');
    const { w } = world;
    const d = await w.org('部门D');
    const b = await w.org('部门B');
    const e2 = await w.hire('员工二', { departmentId: b.id });
    const adjustment = await world.adjustment(d.id);
    await seedItem(world.db, world.tenant.id, adjustment.id, { seq: 1, target_org_id: d.id });
    const now = new Date(`${TODAY}T02:00:00.000Z`);
    await world.schedule(adjustment.id, now);
    const hireInto = async (departmentId: string) => {
      const newcomer = await w.employee('新人');
      return w.request('POST', `/employees/${newcomer.id}/businesses`, {
        ifMatch: newcomer.revision,
        body: withLoginEmail(newcomer.id, {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: TODAY,
          fields: { employType: 'internal', departmentId },
        }),
      });
    };
    const transferIn = async () =>
      w.request('POST', `/employees/${e2.id}/businesses`, {
        ifMatch: (await w.getEmployee(e2.id)).revision,
        body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-03', fields: { departmentId: d.id } },
      });
    const during: string[] = [];
    const outcome = async (response: Response) =>
      `${response.status}:${((await response.json()) as { error?: { details?: { reason?: string } } }).error?.details?.reason}`;
    const { executors } = fakeExecutors();
    const afterGroup = async () => {
      during.push(await outcome(await hireInto(d.id)), await outcome(await transferIn()));
    };
    const result = await runOrgAdjustmentTenant(world.db, world.tenant, () => now, {
      holderToken: 'process-a',
      executors,
      hooks: { afterGroup },
    });
    expect(result.completed).toEqual([adjustment.id]);
    expect(during).toEqual(['409:ORG_ADJUSTMENT_EXECUTING', '409:ORG_ADJUSTMENT_EXECUTING']);
    await w.hire('执行后新人', { departmentId: d.id }); // 内部断言 201
    expect((await transferIn()).status).toBe(201);
  });
});

describe('AC-OA-12 / 23 执行状态迁移与完成通知', () => {
  it('审批通过 + 未执行 → 执行中 → 已执行；排期不改 revision，重复排期与未通过单据拒绝；完成后站内消息通知申请人', async () => {
    const world = await scheduleWorld('oa12-23');
    const org = await world.w.org('状态组织');
    const adjustment = await world.adjustment(org.id);
    await seedItem(world.db, world.tenant.id, adjustment.id, { seq: 1, target_org_id: org.id });
    await seedApprovalInstance(world.db, world.tenant.id, adjustment.id, world.w.user.id);
    const state = () => adjustmentState(world.db, world.tenant.id, adjustment.id);
    const initial = await state();
    expect(initial).toMatchObject({ execution_status: 1, state: null });
    const now = new Date(`${TODAY}T02:00:00.000Z`);
    await world.schedule(adjustment.id, now);
    expect(await state()).toMatchObject({ execution_status: 1, state: 'pending', revision: initial.revision });
    await expect(world.schedule(adjustment.id, now)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ORG_ADJUSTMENT_NOT_SCHEDULABLE' },
    });
    const pendingApproval = await world.adjustment(org.id);
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx.execute(sql`UPDATE org_adjustments SET approval_status=1, approved_at=NULL WHERE id=${pendingApproval.id}`),
    );
    await expect(world.schedule(pendingApproval.id, now)).rejects.toMatchObject({ code: 'CONFLICT' });

    const during: unknown[] = [];
    const { executors } = fakeExecutors();
    await runOrgAdjustmentTenant(world.db, world.tenant, () => now, {
      holderToken: 'process-a',
      executors,
      hooks: { afterGroup: async () => void during.push(await state()) },
    });
    expect(during).toEqual([
      expect.objectContaining({ execution_status: 3, state: 'running', revision: initial.revision + 1 }),
    ]);
    const done = await state();
    expect(done).toMatchObject({ execution_status: 2, state: 'done', revision: initial.revision + 2 });
    expect(done.executed_at).not.toBeNull();

    const notices = await withTenant(world.db, world.tenant.id, async (tx) =>
      resultRows<{ recipient_user_id: string; kind: string; channel: string }>(
        await tx.execute(sql`SELECT n.recipient_user_id, n.kind, n.channel FROM approval_notifications n
          JOIN approval_instances i ON i.tenant_id=n.tenant_id AND i.id=n.instance_id
          WHERE n.tenant_id=${world.tenant.id} AND i.business_id=${adjustment.id}
            AND n.template_code='OrgAdjustmentExecuted'`),
      ),
    );
    expect(notices).toEqual([{ recipient_user_id: world.w.user.id, kind: 'message', channel: 'inbox' }]);
  });
});
