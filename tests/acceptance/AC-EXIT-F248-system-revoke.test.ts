/**
 * F-248（DEC-633）：离职生效收口在途考核，终态与日志对齐原站（F234A 取证）——
 * - 审批实例走“系统撤销”入口：状态 cancelled（界面“已终止”）、待办清空；日志只有一条 system_revoke（界面“撤销”），
 *   操作人为空（= 系统，不论是 HR 直接生效还是审批末节点触发）、理由“离职业务终止在途审批流程”，不再叠加 cancel 日志；
 * - 考核记录状态值仍是 cancelled（不迁移、不回写存量）；只有离职收口作废的记录带只读派生字段 terminatedByExit=true，
 *   发起人撤回等其他 cancelled 记录为 false（前端据此显示“已终止”或原名“已作废”）；
 * - 终止后只剩查看入口：审批详情无任何写动作，考核记录与审批动作都被拒。
 * 全部经公开入口：直接保存（计划生效日已到）与审批最后节点两条生效路径。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { assessmentExitWorld, type AssessmentExitWorld } from './AC-EXIT-F229-support.js';
import { revokeBySystem } from '../../apps/api/src/modules/approval/actions.js';
import { ADAPTERS } from '../../apps/api/src/modules/approval/adapters.js';
import { reasonOf as plainReason } from './AC-PB-BE15b1-support.js';

const database = useTestDb();
const world = (label: string) => assessmentExitWorld(database().db, label);
/** 夹具时钟 10-01；最后工作日 10-02 → 计划生效日 10-03。 */
const DAY = '2026-10-03T01:00:00Z';
/** 原站文案（F234A），测试里写字面量：常量写错要能被抓到。 */
const REASON = '离职业务终止在途审批流程';
const EMPLOYMENT = '/api/tenant/employment';

type Kind = 'probation' | 'regularization';
type Path = 'direct' | 'approval';

async function inFlight(x: AssessmentExitWorld, name: string, type: Kind) {
  const person = await x.probationer(name);
  const assessmentId = await x.launch(type, person);
  return { person, assessmentId, instance: (await x.instanceRows(assessmentId))[0]! };
}

/** 离职经哪条路径生效：HR 直接保存（保存事务内生效）/ 审批最后节点同意。 */
async function takeEffect(x: AssessmentExitWorld, employeeId: string, path: Path) {
  if (path === 'direct') {
    x.setNow(DAY);
    const leave = await x.confirmedLeave(employeeId, 'direct');
    expect(leave.status).toBe('effective');
    return leave;
  }
  const draft = await x.confirmedLeave(employeeId, 'application', { exitTypeCode: 'voluntary' });
  expect((await x.submitCall(draft)).status).toBe(200);
  x.setNow(DAY);
  const view = await x.instanceOf(draft.id);
  const task = x.pending(view)[0]!;
  const done = await x.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {});
  expect(done.status, await done.clone().text()).toBe(200);
  expect(await x.leaveStatus(draft.id)).toBe('effective');
  return draft;
}

const WRITE_ACTIONS = ['approve', 'disagree', 'reject', 'urge', 'withdraw', 'edit', 'transfer', 'resubmit', 'delete'];

describe('F-248 离职生效收口在途考核：系统撤销', () => {
  const cases: [Kind, Path][] = [
    ['probation', 'direct'],
    ['probation', 'approval'],
    ['regularization', 'direct'],
    ['regularization', 'approval'],
  ];
  it.each(cases)('%s × %s：实例已终止、日志一条系统撤销、考核带离职终止标记，之后只剩查看', async (type, path) => {
    const x = await world(`f248-${type}-${path}`);
    const { person, assessmentId, instance } = await inFlight(x, '系统撤销员工', type);
    expect(await x.pendingTaskCount(assessmentId)).toBe(1);
    const initiatorView = await x.instance(assessmentId);
    const task = x.pending(initiatorView)[0]!;
    await takeEffect(x, person.employeeId, path);

    // 审批实例：cancelled、待办清空；日志只有一条 system_revoke，操作人为空、理由为原站文案，不叠加 cancel
    expect(await x.instanceRows(assessmentId)).toEqual([{ id: instance.id, status: 'cancelled' }]);
    expect(await x.pendingTaskCount(assessmentId)).toBe(0);
    const view = await x.instance(assessmentId);
    expect(view.status).toBe('cancelled');
    expect(view.currentNodeKey).toBeNull();
    expect(view.logs.map((log) => log.event)).not.toContain('cancel');
    expect(view.logs.filter((log) => log.event === 'system_revoke')).toHaveLength(1);
    const last = view.logs.at(-1)!;
    expect(last).toMatchObject({ event: 'system_revoke', actorUserId: null, detail: { comment: REASON } });

    // 考核记录：状态值仍是 cancelled，详情与列表都带 terminatedByExit=true
    const detail = await x.get(assessmentId);
    expect(detail).toMatchObject({ status: 'cancelled', terminatedByExit: true });
    const list = await x.json<{ items: { id: string; status: string; terminatedByExit: boolean }[] }>(
      await x.request(x.hr.id, 'GET', `${EMPLOYMENT}/probation-assessments?employeeId=${person.employeeId}`),
    );
    expect(list.items).toEqual([
      expect.objectContaining({ id: assessmentId, status: 'cancelled', terminatedByExit: true }),
    ]);

    // 只剩查看入口：详情无写动作；考核不能改；审批动作都被拒
    expect(view.actions.filter((action) => WRITE_ACTIONS.includes(action))).toEqual([]);
    const edited = await plainReason(await x.patchRaw(assessmentId, detail.revision, { assessmentName: '改名' }));
    expect(edited).toMatchObject({ status: 409, reason: 'ASSESSMENT_NOT_EDITABLE' });
    const approve = await x.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {});
    expect(approve.status).toBeGreaterThanOrEqual(400);
    for (const action of ['withdraw', 'urge'] as const) {
      const response = await x.instanceAction(initiatorView.initiatorUserId, instance.id, action, view.revision);
      expect(response.status, action).toBeGreaterThanOrEqual(400);
    }
  });

  it('审批中心回写“撤回”而作废的考核不带离职终止标记；同员工其余在途考核被离职终止后带标记', async () => {
    const x = await world('f248-mixed');
    const person = await x.probationer('混合员工');
    const other = await x.launch('probation', person);
    // 预置节点关闭发起人撤回（PB-R15），其他方式结束实例时由适配器回写“已作废”：直接走适配器回调
    await withTenant(x.db, x.tenantId, (tx) =>
      ADAPTERS.probation_assessment.withdrawn(
        tx,
        {
          tenantId: x.tenantId,
          userId: x.hr.id,
          timezone: x.timezone,
          now: x.clock(),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        other,
      ),
    );
    expect(await x.get(other)).toMatchObject({ status: 'cancelled', terminatedByExit: false });
    const running = await x.launch('regularization', person);

    await takeEffect(x, person.employeeId, 'direct');
    expect(await x.get(running)).toMatchObject({ status: 'cancelled', terminatedByExit: true });
    expect(await x.get(other)).toMatchObject({ status: 'cancelled', terminatedByExit: false });
    expect(await x.audits(other, 'employment.assessment.voided_by_exit')).toEqual([]);
  });

  describe('revokeBySystem 终态幂等', () => {
    /** 实例当前状态 + 全部写足迹：日志、审计、outbox、revision。 */
    const footprint = async (x: AssessmentExitWorld, instanceId: string) => ({
      instance: (
        await x.rows<{ status: string; revision: number }>(sql`SELECT status, revision::int AS revision
          FROM approval_instances WHERE tenant_id=${x.tenantId} AND id=${instanceId}::uuid`)
      )[0],
      logs: (
        await x.rows<{ event: string }>(sql`SELECT event FROM approval_instance_logs
          WHERE tenant_id=${x.tenantId} AND instance_id=${instanceId}::uuid ORDER BY seq`)
      ).map((row) => row.event),
      audits: Number(
        (
          await x.rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_events
            WHERE tenant_id=${x.tenantId} AND object_id=${instanceId}`)
        )[0]!.n,
      ),
      outbox: Number(
        (
          await x.rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM approval_outbox
            WHERE tenant_id=${x.tenantId} AND object_id=${instanceId}`)
        )[0]!.n,
      ),
    });
    /** 再次调用系统撤销入口（新命令 ID，防止命令台账 / outbox 唯一键掩盖重复写）。 */
    const revokeAgain = (x: AssessmentExitWorld, instanceId: string) =>
      withTenant(x.db, x.tenantId, (tx) =>
        revokeBySystem(
          tx,
          {
            tenantId: x.tenantId,
            userId: x.hr.id,
            timezone: x.timezone,
            now: x.clock(),
            commandId: randomUUID(),
            expectedRevision: 0,
          },
          instanceId,
          REASON,
        ),
      );

    it('已被系统撤销的实例再调一次：日志、审计、outbox、revision 都不增加', async () => {
      const x = await world('f248-idem-cancelled');
      const { person, assessmentId, instance } = await inFlight(x, '幂等员工', 'regularization');
      await takeEffect(x, person.employeeId, 'direct');
      const before = await footprint(x, instance.id);
      expect(before.instance?.status).toBe('cancelled');
      expect(before.logs.filter((event) => event === 'system_revoke')).toHaveLength(1);
      await revokeAgain(x, instance.id);
      expect(await footprint(x, instance.id)).toEqual(before);
      expect((await x.get(assessmentId)).status).toBe('cancelled');
    });

    it('已通过 / 不通过的实例不被改写：状态保持，什么都不写', async () => {
      const x = await world('f248-idem-finished');
      const passed = await x.probationer('已通过员工');
      const approvedId = await x.launch('probation', passed);
      await x.complete(approvedId, passed);
      const refused = await x.probationer('不通过员工');
      const refusedId = await x.launch('regularization', refused);
      await x.decide(refusedId, refused, 'approve', { selfEvaluation: '自评' });
      await x.decide(refusedId, x.manager, 'disagree');
      for (const [assessmentId, status] of [
        [approvedId, 'approved'],
        [refusedId, 'disapproved'],
      ] as const) {
        const id = (await x.instanceRows(assessmentId))[0]!.id;
        const before = await footprint(x, id);
        expect(before.instance?.status).toBe(status);
        await revokeAgain(x, id);
        expect(await footprint(x, id)).toEqual(before);
        expect((await x.get(assessmentId)).status).toBe(status);
      }
    });
  });
});
