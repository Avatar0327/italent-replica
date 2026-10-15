/**
 * F-164（DEC-518 / DEC-523；docs/09_派发/后续任务.md F-164）：发展计划查看权限照原站。
 * - 打开：看得到计划（HR 范围内 / 参与人）后，模板除基本信息外没有别的模块 → 403 IDP_PLAN_NO_VISIBLE_MODULE；
 *   本人、指导人、HR、在办审批人一律适用；看不到的仍 404（不泄露计划是否存在）。只在打开详情时判定，
 *   HR 新建 / 开始这类写入照常返回计划。
 * - 员工「个人发展计划」：本人只见进行中、已结束（已终止的不列）；指导人一支不变。
 * - 指导人「我辅导的发展计划」tutor-plans：只列本人任指导人的进行中计划。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import {
  errorOf,
  IDP,
  otherTutor,
  permissionWorldOf,
  planWorld,
  type PlanView,
  type PlanWorld,
  type Receipt,
} from './AC-IDP-plan-support.js';
import type { TemplateView } from './AC-IDP-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

type Summary = PlanView & { readonly tutorEmployeeId?: string | null };

/** 同一流程下另建一份只有基本信息模块的模板并发布（模板新建时自带基本信息模块）。 */
async function basicOnlyTemplate(w: PlanWorld) {
  const created = await w.ok<TemplateView>(
    await w.http(w.hrUser, 'POST', `${IDP}/templates`, {
      ifMatch: 0,
      body: { name: `只有基本信息${uniqueSuffix()}`, orgId: w.dept, processId: w.process.id },
    }),
    201,
  );
  expect(created.modules.map((m) => m.moduleType)).toEqual(['basic']);
  await w.ok(
    await w.http(w.hrUser, 'POST', `${IDP}/templates/${created.id}/publish`, { ifMatch: created.revision }),
  );
  return created.id;
}

const items = (plan: PlanView) => [{ id: plan.id, revision: plan.revision }];

describe('F-164 打开判定：模板除基本信息外没有模块', () => {
  it('本人、指导人、范围内 HR、在办审批人打开 403 IDP_PLAN_NO_VISIBLE_MODULE；看不到的仍 404', async () => {
    const w = await planWorld(testDb().db, 'idp-f164-open');
    const pw = await permissionWorldOf(w);
    const templateId = await basicOnlyTemplate(w);
    // HR 新建、开始照常返回计划（判定只在打开详情时做）
    const plan = await w.startedPlan({ templateId });
    expect(plan).toMatchObject({ status: 'running', currentStageName: '制定计划' });
    const open = (user: string) => w.realHttp(user, 'GET', `${IDP}/plans/${plan.id}`);

    for (const user of [w.employee.userId, w.manager.userId]) {
      expect(await errorOf(await open(user))).toEqual({
        status: 403,
        code: 'FORBIDDEN',
        reason: 'IDP_PLAN_NO_VISIBLE_MODULE',
      });
    }
    const inside = await idpOperator(pw, { orgId: w.dept });
    expect(await errorOf(await inside.request('GET', `/plans/${plan.id}`))).toMatchObject({
      status: 403,
      reason: 'IDP_PLAN_NO_VISIBLE_MODULE',
    });

    // 看不到的仍 404：无关员工、范围外 HR
    expect((await open(w.outsider.userId)).status).toBe(404);
    const outside = await idpOperator(pw, { orgId: await w.org('范围外部门') });
    expect((await outside.request('GET', `/plans/${plan.id}`)).status).toBe(404);

    // 在办审批人：指导人无账号时第二个节点转异常管理员
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM permission_user_person_links WHERE employee_id=${w.manager.employeeId}::uuid`),
    );
    // 计划详情此时 HR 也打不开，按待办直接办理（不经 submit 回读）
    await w.ok(await w.submitRaw(plan, 1, w.employee.userId));
    expect(await errorOf(await open(w.exceptionAdmin))).toMatchObject({
      status: 403,
      reason: 'IDP_PLAN_NO_VISIBLE_MODULE',
    });
  });

  it('模板含基本信息以外的模块照常打开；同一员工两份计划互不影响', async () => {
    const w = await planWorld(testDb().db, 'idp-f164-visible');
    const basic = await w.startedPlan({ templateId: await basicOnlyTemplate(w), name: '只有基本信息' });
    const full = await w.startedPlan({ name: '完整模板' });
    const view = await w.ok<PlanView>(await w.realHttp(w.employee.userId, 'GET', `${IDP}/plans/${full.id}`));
    expect(view).toMatchObject({ id: full.id, status: 'running' });
    expect((await w.realHttp(w.employee.userId, 'GET', `${IDP}/plans/${basic.id}`)).status).toBe(403);
    // 列表照常列出（原站列表可见，打开才提示无权限）
    const mine = await w.ok<{ items: Summary[] }>(await w.realHttp(w.employee.userId, 'GET', `${IDP}/my-plans`));
    expect(mine.items.map((p) => p.name).sort()).toEqual(['只有基本信息', '完整模板']);
  });
});

describe('F-164 员工「个人发展计划」：本人只见进行中与已结束', () => {
  it('已终止的本人计划不列；已结束的列出；指导人一支不变', async () => {
    const w = await planWorld(testDb().db, 'idp-f164-mine');
    const running = await w.startedPlan({ name: '进行中' });
    const stopped = await w.startedPlan({ name: '已终止' });
    const done = await w.startedPlan({ name: '已结束' });
    const terminated = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('terminate', { items: items(stopped), reason: '人员离岗' }),
    );
    expect(terminated.receipts[0]).toMatchObject({ status: 200, outcome: 'terminated' });
    // 两次“开启下个阶段 · 结束当前阶段”到期末回顾，员工、指导人提交后计划结束
    let plan = done;
    for (let i = 0; i < 2; i += 1) {
      await w.ok(await w.intervene('start-next', { items: items(plan), runningMode: 'endRunning' }));
      plan = await w.readPlan(plan.id);
    }
    await w.submit(plan, 3, w.employee.userId);
    plan = await w.submit(plan, 3, w.manager.userId);
    expect(plan.status).toBe('ended');

    const mine = await w.ok<{ items: Summary[] }>(await w.realHttp(w.employee.userId, 'GET', `${IDP}/my-plans`));
    expect(mine.items.map((p) => `${p.name}:${p.status}`).sort()).toEqual(['已结束:ended', '进行中:running'].sort());
    // 员工直接带 id 打开已终止的本人计划不另拦
    expect((await w.realHttp(w.employee.userId, 'GET', `${IDP}/plans/${stopped.id}`)).status).toBe(200);
    // 指导人一支：非未开始都列（含已终止）
    const tutored = await w.ok<{ items: Summary[] }>(await w.realHttp(w.manager.userId, 'GET', `${IDP}/my-plans`));
    expect(tutored.items.map((p) => p.id).sort()).toEqual([running.id, stopped.id, done.id].sort());
  });
});

describe('F-164 指导人「我辅导的发展计划」', () => {
  it('只列本人任指导人的进行中计划；未开始、已终止、他人指导的不列；无辅导对象为空', async () => {
    const w = await planWorld(testDb().db, 'idp-f164-tutor');
    await w.createPlan({ name: '未开始' });
    const running = await w.startedPlan({ name: '进行中' });
    const stopped = await w.startedPlan({ name: '已终止' });
    await w.ok(await w.intervene('terminate', { items: items(stopped), reason: '人员离岗' }));
    const other = await w.start(await w.createPlan({ name: '辅导丙', ...otherTutor(w) }, w.hrUser, w.outsider));
    await w.startedPlan({ name: '他人指导', tutorRole: 'other', tutorEmployeeId: w.outsider.employeeId });

    const list = await w.ok<{ items: Summary[] }>(await w.realHttp(w.manager.userId, 'GET', `${IDP}/tutor-plans`));
    const byId = new Map(list.items.map((p) => [p.id, p]));
    expect([...byId.keys()].sort()).toEqual([running.id, other.id].sort());
    // 指导人就是本人：返回指导人供列表显示；不返回指导人角色与流程
    expect(byId.get(running.id)).toMatchObject({
      name: '进行中',
      status: 'running',
      employeeId: w.employee.employeeId,
      tutorEmployeeId: w.manager.employeeId,
      currentStageName: '制定计划',
    });
    expect(byId.get(other.id)).toMatchObject({ employeeId: w.outsider.employeeId, status: 'running' });
    expect(byId.get(running.id)).not.toHaveProperty('tutorRole');
    expect(byId.get(running.id)).not.toHaveProperty('processId');

    const none = await w.ok<{ items: Summary[] }>(await w.realHttp(w.employee.userId, 'GET', `${IDP}/tutor-plans`));
    expect(none.items).toEqual([]);
  });
});
