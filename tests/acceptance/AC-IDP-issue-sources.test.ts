/**
 * R3-T07 PR-B 第 3 轮 R2-5（DEC-309 入口清单 E11；K-46）：统一下发任务在做可区分的校验、写入与回执之前，先检查实际用到
 * 的源字段的查看权——模板模块对象与 taskEnabled、通用目标所属模块 moduleId、目标 commonGoalId、计划 templateId；
 * 看不到时与“通用目标不存在”同一个 404（开关开或关不可区分，不返回 goalId），并记入重放检查：首次成功后撤掉其中
 * 任一字段，同键重放 403。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator, type OperatorOptions } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const task = { name: '统一下发的任务', description: '说明', endDate: '2026-06-30' };

function issueWith(op: Awaited<ReturnType<typeof idpOperator>>, commonGoalId: string, plan: PlanView, key?: string) {
  return op.request('POST', '/plans/tasks/issue', {
    ifMatch: 0,
    body: { commonGoalId, plans: [{ id: plan.id, revision: plan.revision }], task },
    ...(key ? { idempotencyKey: key } : {}),
  });
}

async function goalIdOf(w: PlanWorld, plan: PlanView) {
  return (await w.readPlan(plan.id)).goals!.find((g) => g.commonGoalId === w.firstCommonGoal.id)!.id;
}

const CASES: [string, OperatorOptions][] = [
  ['隐藏模板模块 taskEnabled', { hidden: { templateModule: ['taskEnabled'] } }],
  ['没有模板模块查看权', { objects: ['plan', 'task', 'template', 'commonGoal', 'goal'] }],
  ['隐藏通用目标 moduleId', { hidden: { commonGoal: ['moduleId'] } }],
  ['隐藏目标 commonGoalId', { hidden: { goal: ['commonGoalId'] } }],
  ['隐藏计划 templateId', { hidden: { plan: ['templateId'] } }],
];

describe('R2-5：统一下发先查实际用到的源字段', () => {
  for (const [label, options] of CASES) {
    it(`${label}：与“通用目标不存在”同一个 404，不建任务、不回 goalId`, async () => {
      const w = await planWorld(testDb().db, `idp-iss-${randomUUID().slice(0, 6)}`);
      const plan = await w.createPlan();
      const op = await idpOperator(await permissionWorldOf(w), { ...options, orgId: w.dept });
      const hidden = await issueWith(op, w.firstCommonGoal.id, plan);
      const missing = await issueWith(op, randomUUID(), plan);
      const text = await hidden.text();
      expect(hidden.status, text).toBe(404);
      expect(text).toBe(await missing.text());
      expect(text).not.toContain(await goalIdOf(w, plan));
      expect((await w.readPlan(plan.id)).goals!.flatMap((g) => g.tasks)).toEqual([]);
    });
  }

  it('首次成功后撤掉 taskEnabled / commonGoalId / templateId 的查看权：同键重放 403', async () => {
    for (const [key, field] of [
      ['templateModule', 'taskEnabled'],
      ['goal', 'commonGoalId'],
      ['plan', 'templateId'],
    ] as const) {
      const w = await planWorld(testDb().db, `idp-iss-replay-${key}`);
      const plan = await w.createPlan();
      const op = await idpOperator(await permissionWorldOf(w), { orgId: w.dept });
      const command = `issue-replay-${randomUUID()}`;
      const first = await issueWith(op, w.firstCommonGoal.id, plan, command);
      expect(first.status, await first.clone().text()).toBe(201);
      await op.hideFields(key, [field]);
      const replay = await issueWith(op, w.firstCommonGoal.id, plan, command);
      expect(replay.status, `${key}.${field}: ${await replay.clone().text()}`).toBe(403);
    }
  });
});
