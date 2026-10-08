/**
 * R3-T07 PR-B 第 3 轮 R2-1（DEC-113 / DEC-318 K-39）：IDP 审批的重提除“原发起人 = 计划所有者”外，按首次提交复核所有者
 * 当前的 IDP 数据范围、计划对象编辑权与编辑按钮（与撤回同一口径），在命令事务内再复核一次；同键重放也走同样的检查。
 * 三类 IDP 审批（制定计划 / 中期回顾 / 期末回顾）共用这一入口，逐类覆盖。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { errorOf, planWorld, type PlanView, type PlanWorld, type Receipt } from './AC-IDP-plan-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const APV = '/api/tenant/approval';

const TUTOR = { avoidSelf: false, reject: true, rejectToPrevious: true, jump: true };

/** 撤空 IDP 范围（无权限提供者时范围按 data.scope.all 解析，缺省空）。 */
const withoutIdpScope: Authorizer = (request) =>
  !(request.action === 'data.scope.all' && String(request.resource ?? '').startsWith('IDP.'));
/** 撤掉计划对象的编辑权（查看保留）。 */
const withoutPlanWrite: Authorizer = (request) =>
  !(request.action === 'object.update' && request.resource === 'IDP.Idp');
/** 撤掉计划对象的按钮。 */
const withoutPlanButtons: Authorizer = (request) =>
  !(request.action === 'object.button' && String(request.resource ?? '').startsWith('IDP.Idp#'));

function narrowedApi(w: PlanWorld, authorize: Authorizer) {
  const api = tenantApi(w.db, { authorize, clock: w.clock });
  return (user: string, method: string, path: string, options: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, path, { ...options, ...w.as(user) });
}

async function world(label: string, revoke = false) {
  return planWorld(testDb().db, label, {
    nodes: {
      idp_employee: { actions: { revoke } },
      idp_tutor: { actions: { ...TUTOR, revoke } },
    },
  });
}

/** 推进到第 seq 阶段的员工节点（阶段 2 手动开启，阶段 3 由调度在前一阶段结束 7 天后开启）。 */
async function atStage(w: PlanWorld, seq: number): Promise<PlanView> {
  let plan = await w.startedPlan();
  if (seq >= 2) {
    await w.submit(plan, 1, w.employee.userId);
    plan = await w.submit(plan, 1, w.manager.userId);
    const opened = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', {
        items: [{ id: plan.id, revision: plan.revision }],
        runningMode: 'skipRunning',
      }),
    );
    expect(opened.receipts).toEqual([expect.objectContaining({ outcome: 'opened' })]);
    plan = await w.readPlan(plan.id);
  }
  if (seq >= 3) {
    await w.submit(plan, 2, w.employee.userId);
    plan = await w.submit(plan, 2, w.manager.userId);
    const ended = plan.stages[1]!.endedOn!;
    const day = new Date(`${ended}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() + 7);
    // 上海时区凌晨 2 点 = 前一天 18:00 UTC
    day.setUTCHours(-6);
    await w.runScheduler(day.toISOString());
    plan = await w.readPlan(plan.id);
  }
  expect(plan.stages[seq - 1]!.status, JSON.stringify(plan.stages)).toBe('running');
  return plan;
}

/** 员工提交、指导人驳回（到发起人）：实例退回。 */
async function returnedAt(w: PlanWorld, seq: number) {
  let plan = await atStage(w, seq);
  plan = await w.submit(plan, seq, w.employee.userId);
  const { instance, task } = await w.pendingTask(plan, seq, w.manager.userId);
  await w.ok(
    await w.http(w.manager.userId, 'POST', `${APV}/tasks/${task.id}/reject`, {
      ifMatch: instance.revision,
      body: { comment: '重做' },
    }),
  );
  const returned = await w.instanceOf(plan, seq);
  expect(returned.status).toBe('returned');
  return { plan, returned };
}

describe('R2-1：IDP 重提复核所有者当前权限', () => {
  for (const [seq, type] of [
    [1, 'idp_plan'],
    [2, 'idp_mid_review'],
    [3, 'idp_final_review'],
  ] as const) {
    it(`${type}：驳回后撤空所有者 IDP 范围，重提 403、实例仍退回；范围恢复后重提成功`, async () => {
      const w = await world(`idp-resubmit-scope-${seq}`);
      const { plan, returned } = await returnedAt(w, seq);
      const narrowed = narrowedApi(w, withoutIdpScope);
      expect((await narrowed(w.hrUser, 'GET', `/api/tenant/idp/plans/${plan.id}`)).status).toBe(404);
      const denied = await narrowed(w.hrUser, 'POST', `${APV}/instances/${returned.id}/resubmit`, {
        ifMatch: returned.revision,
      });
      expect(await errorOf(denied)).toMatchObject({ status: 403, reason: 'APPROVAL_SCOPE_DENIED' });
      const after = await w.instanceOf(plan, seq);
      expect(after).toMatchObject({ status: 'returned', revision: returned.revision });
      expect(after.tasks.filter((t) => t.status === 'pending')).toEqual([]);

      const again = await w.http(w.hrUser, 'POST', `${APV}/instances/${returned.id}/resubmit`, {
        ifMatch: returned.revision,
      });
      expect(again.status, await again.clone().text()).toBe(200);
    });
  }

  it('撤回后撤掉计划编辑权或编辑按钮：重提 403，实例仍是已撤回', async () => {
    const w = await world('idp-resubmit-write', true);
    const plan = await w.startedPlan();
    const instance = await w.instanceOf(plan, 1);
    await w.ok(
      await w.http(w.hrUser, 'POST', `${APV}/instances/${instance.id}/withdraw`, { ifMatch: instance.revision }),
    );
    const withdrawn = await w.instanceOf(plan, 1);
    expect(withdrawn.status).toBe('withdrawn');
    for (const authorize of [withoutPlanWrite, withoutPlanButtons]) {
      const denied = await narrowedApi(w, authorize)(w.hrUser, 'POST', `${APV}/instances/${withdrawn.id}/resubmit`, {
        ifMatch: withdrawn.revision,
      });
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect(await w.instanceOf(plan, 1)).toMatchObject({ status: 'withdrawn', revision: withdrawn.revision });
    }
  });

  it('同键重放也复核：首次重提成功后撤空范围，同一命令 ID 重放 403', async () => {
    const w = await world('idp-resubmit-replay');
    const { returned } = await returnedAt(w, 1);
    const key = 'idp-resubmit-replay-key';
    const first = await w.http(w.hrUser, 'POST', `${APV}/instances/${returned.id}/resubmit`, {
      ifMatch: returned.revision,
      idempotencyKey: key,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    const replay = await narrowedApi(w, withoutIdpScope)(w.hrUser, 'POST', `${APV}/instances/${returned.id}/resubmit`, {
      ifMatch: returned.revision,
      idempotencyKey: key,
    });
    expect(await errorOf(replay)).toMatchObject({ status: 403, reason: 'APPROVAL_SCOPE_DENIED' });
  });
});
