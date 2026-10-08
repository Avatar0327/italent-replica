/**
 * R3-T07 PR-B 第 2 轮 P2-5：提示、校验与下发回执不泄露隐藏引用。
 * - 发布提示 warnings：查看人看不到模板 processId、流程或子流程的审批流程字段时，不返回提示（子流程 ID 与其审批流程
 *   废弃状态；模块节点配置里的子流程 ID 按模块对象权限照常返回）；
 *   首次与同键重放同一出口；
 * - 统一下发任务（DEC-309 入口清单 E11）：先校验操作人对模板、通用目标、目标的查看权再做校验——看不到时“不存在 / 模板
 *   不一致 / 目标缺失”都是同一个 404，回执不含隐藏目标的 goalId；看得到时照常下发（对照）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, type PlanView } from './AC-IDP-plan-support.js';
import type { TemplateView } from './AC-IDP-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

describe('P2-5：发布提示按查看人裁剪', () => {
  it('看不到 processId / 流程 / 子流程：发布与重放都不返回废弃提示；全部可见时返回（对照）', async () => {
    const w = await planWorld(testDb().db, 'idp-warn-trim');
    const pw = await permissionWorldOf(w);
    const approval = await w.ok<{ revision: number }>(
      await w.http(w.hrUser, 'GET', `/api/tenant/approval/processes/${w.approvals.plan}`),
    );
    await w.ok(
      await w.http(w.hrUser, 'POST', `/api/tenant/approval/processes/${w.approvals.plan}/discard`, {
        ifMatch: approval.revision,
      }),
    );
    const unpublish = async () =>
      w.ok<TemplateView>(
        await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/unpublish`, {
          ifMatch: (await w.ok<TemplateView>(await w.http(w.hrUser, 'GET', `${IDP}/templates/${w.template.id}`)))
            .revision,
        }),
      );
    const hiddenRef = await idpOperator(pw, { orgId: w.dept, hidden: { template: ['processId'] } });
    const noProcess = await idpOperator(pw, {
      orgId: w.dept,
      objects: ['template', 'templateModule', 'commonGoal'],
    });
    for (const op of [hiddenRef, noProcess]) {
      const draft = await unpublish();
      const options = { ifMatch: draft.revision, idempotencyKey: `warn-${randomUUID()}` };
      for (const round of ['first', 'replay']) {
        const response = await op.request('POST', `/templates/${w.template.id}/publish`, options);
        const text = await response.text();
        expect(response.status, `${round} ${text}`).toBe(200);
        expect(JSON.parse(text), round).not.toHaveProperty('warnings');
        expect(text, round).not.toContain('IDP_APPROVAL_PROCESS_DISCARDED');
      }
    }
    const full = await idpOperator(pw, { orgId: w.dept });
    const draft = await unpublish();
    const shown = await w.ok<{ warnings?: unknown[] }>(
      await full.request('POST', `/templates/${w.template.id}/publish`, { ifMatch: draft.revision }),
    );
    expect(shown.warnings).toEqual([{ code: 'IDP_APPROVAL_PROCESS_DISCARDED', subProcessId: w.stageId(1) }]);
  });
});

describe('P2-5：统一下发先判查看权', () => {
  const task = { name: '统一下发的任务', description: '说明', endDate: '2026-06-30' };

  it('看不到模板 / 通用目标 / 目标：存在、不存在、目标缺失一律同一个 404，不创建任务、不回 goalId', async () => {
    const w = await planWorld(testDb().db, 'idp-issue-hidden');
    const pw = await permissionWorldOf(w);
    const withGoal = await w.createPlan();
    const op = await idpOperator(pw, { orgId: w.dept, objects: ['plan', 'task'] });
    // 看不到通用目标的 HR 新建的计划不带入通用目标 → “目标缺失”
    const creator = await idpOperator(pw, { orgId: w.dept, objects: ['plan', 'template', 'templateModule', 'goal'] });
    const noGoal = await w.ok<PlanView>(
      await creator.request('POST', '/plans', {
        ifMatch: 0,
        body: {
          name: '无通用目标的计划',
          employeeId: w.outsider.employeeId,
          templateId: w.template.id,
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          tutorRole: 'other',
          tutorEmployeeId: w.manager.employeeId,
        },
      }),
      201,
    );
    const issue = (commonGoalId: string, plan: { id: string; revision: number }) =>
      op.request('POST', '/plans/tasks/issue', {
        ifMatch: 0,
        body: { commonGoalId, plans: [{ id: plan.id, revision: plan.revision }], task },
      });
    const bodies: string[] = [];
    for (const [commonGoalId, plan] of [
      [w.firstCommonGoal.id, withGoal],
      [randomUUID(), withGoal],
      [w.firstCommonGoal.id, noGoal],
    ] as const) {
      const response = await issue(commonGoalId, plan);
      const text = await response.text();
      expect(response.status, text).toBe(404);
      bodies.push(text);
    }
    expect(new Set(bodies).size).toBe(1);
    const goal = (await w.readPlan(withGoal.id)).goals!.find((g) => g.commonGoalId === w.firstCommonGoal.id)!;
    for (const text of bodies) expect(text).not.toContain(goal.id);
    expect(goal.tasks).toEqual([]);

    // 对照：看得到时照常下发，回执含目标 id
    const full = await idpOperator(pw, { orgId: w.dept });
    const current = await w.readPlan(withGoal.id);
    const ok = await w.ok<{ created: { goalId: string }[] }>(
      await full.request('POST', '/plans/tasks/issue', {
        ifMatch: 0,
        body: { commonGoalId: w.firstCommonGoal.id, plans: [{ id: current.id, revision: current.revision }], task },
      }),
      201,
    );
    expect(ok.created.map((c) => c.goalId)).toEqual([goal.id]);
  });
});
