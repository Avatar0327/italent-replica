/**
 * R3-T07 PR-B 第 3 轮 R2-2（K-34 / DEC-216 / DEC-197）：目标的删除快照保留完整的任务与目标回顾（存储不裁剪），但审计
 * 输出时父集合字段（IdpGoal.tasks / reviews）之外还要按子对象查看权与子字段联合裁剪：没有任务 / 目标回顾查看权时
 * 不出现，隐藏的子字段不出现。列表的 content / changes、详情的 content / changes / before / snapshot 都裁剪。
 * 覆盖“删除目标 / 删除计划”ד无子对象查看权 / 隐藏子字段”四种组合。
 */
import { randomUUID } from 'node:crypto';
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { idpOperator, type OperatorOptions } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, PLAN_NOW, type PlanWorld } from './AC-IDP-plan-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';

const testDb = useTestDb();
const GOAL = IDP_OBJECTS.goal.code;
const SECRETS = { taskName: '级联任务', taskDescription: '任务说明保密', outcome: '级联回顾成果保密' };

/** 开始的计划：一个目标带一条任务与一条目标回顾。 */
async function filledPlan(w: PlanWorld) {
  let plan = await w.startedPlan();
  plan = await w.addGoal(plan, w.employee.userId, { name: '级联目标' });
  const goal = plan.goals!.find((g) => g.name === '级联目标')!;
  await w.ok(
    await w.execute(w.employee.userId, 'POST', `/plans/${plan.id}/goals/${goal.id}/tasks`, {
      name: SECRETS.taskName,
      description: SECRETS.taskDescription,
    }),
    201,
  );
  await w.ok(
    await w.execute(w.employee.userId, 'PUT', `/plans/${plan.id}/goals/${goal.id}/review`, {
      progress: 30,
      outcome: SECRETS.outcome,
    }),
  );
  return { plan: await w.readPlan(plan.id), goalId: goal.id };
}

const ALL_BUT_CHILDREN = (Object.keys(IDP_OBJECTS) as (keyof typeof IDP_OBJECTS)[]).filter(
  (key) => key !== 'task' && key !== 'goalReview',
);
const NO_CHILD_VIEW: OperatorOptions = { objects: ALL_BUT_CHILDREN };
const HIDDEN_CHILD_FIELDS: OperatorOptions = { hidden: { task: ['description'], goalReview: ['outcome'] } };

async function goalDeleteLog(label: string, removal: 'goal' | 'plan', options: OperatorOptions) {
  const w = await planWorld(testDb().db, label);
  const pw = await permissionWorldOf(w);
  const { plan, goalId } = await filledPlan(w);
  if (removal === 'goal') {
    await w.ok(await w.execute(w.employee.userId, 'DELETE', `/plans/${plan.id}/goals/${goalId}`));
  } else {
    await w.ok(await w.http(w.hrUser, 'DELETE', `/api/tenant/idp/plans/${plan.id}`, { ifMatch: plan.revision }));
  }
  const audit = auditApi(w.db, PLAN_NOW, { authorize: undefined });
  const viewer = await memberWithAdminRole(pw, 'audit_admin', `idp-cas-${randomUUID().slice(0, 4)}`);
  const op = await idpOperator(pw, { ...options, orgId: w.dept, user: viewer.user });
  const list = await audit.dataChanges(op.as, { objectType: GOAL, limit: '50' });
  const item = list.items.find((i) => i.objectId === goalId && i.operation === 'delete');
  expect(item, JSON.stringify(list.items)).toBeTruthy();
  const detail = await audit.dataChange(op.as, item!.id);
  return { item: item!, detail };
}

describe('R2-2：目标删除审计按子对象权限裁剪嵌套的任务与目标回顾', () => {
  for (const removal of ['goal', 'plan'] as const) {
    it(`删除${removal === 'goal' ? '目标' : '计划'}，无任务 / 目标回顾查看权：嵌套内容不出现`, async () => {
      const { item, detail } = await goalDeleteLog(`idp-cas-nv-${removal}`, removal, NO_CHILD_VIEW);
      for (const leaked of Object.values(SECRETS)) {
        expect(JSON.stringify(item), leaked).not.toContain(leaked);
        expect(JSON.stringify(detail), leaked).not.toContain(leaked);
      }
      expect(detail.snapshot).not.toHaveProperty('tasks');
      expect(detail.snapshot).not.toHaveProperty('reviews');
      expect(detail.snapshot).toMatchObject({ name: '级联目标' });
    });

    it(`删除${removal === 'goal' ? '目标' : '计划'}，隐藏任务说明与回顾成果：只留可见子字段`, async () => {
      const { item, detail } = await goalDeleteLog(`idp-cas-hf-${removal}`, removal, HIDDEN_CHILD_FIELDS);
      for (const leaked of [SECRETS.taskDescription, SECRETS.outcome]) {
        expect(JSON.stringify(item), leaked).not.toContain(leaked);
        expect(JSON.stringify(detail), leaked).not.toContain(leaked);
      }
      expect(JSON.stringify(item)).toContain(SECRETS.taskName);
      const snapshot = detail.snapshot as { tasks: Record<string, unknown>[]; reviews: Record<string, unknown>[] };
      expect(snapshot.tasks).toEqual([expect.objectContaining({ name: SECRETS.taskName })]);
      expect(snapshot.tasks[0]).not.toHaveProperty('description');
      expect(snapshot.reviews).toEqual([expect.objectContaining({ progress: 30 })]);
      expect(snapshot.reviews[0]).not.toHaveProperty('outcome');
    });
  }
});
