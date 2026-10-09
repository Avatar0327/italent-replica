/**
 * R3-T07 PR-B 第 3 轮 R2-7（DEC-177 / DEC-198“使用用户”维度；第 2 轮 P2-2 / P2-4 的源范围判定）：指导人解析与任职日期
 * 推算 dueDate 判定源任职记录可见时，与任职记录接口同一谓词，要带上记录的创建人——操作人是员工当前任职记录的创建者、
 * 任职记录范围配置为“使用用户”时，直接读取该记录 200，按直线经理创建 IDP 也要成功，任职生效日推算的 dueDate 照常输出。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import {
  type Approvals,
  grantTenantBaseView,
  permissionWorldOf,
  planWorld,
  type PlanView,
  type PlanWorld,
} from './AC-IDP-plan-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const RECORD = MODULE_OBJECTS.employmentRecord.code;

/** 第一段开始即开启，第二段手动，第三段任职生效日当天自动开启（dueDate 由任职生效日推算）。 */
const stages = (a: Approvals) => [
  { name: '制定计划', category: 'plan', approvalType: 'idp_plan', approvalProcessId: a.plan, startMode: 'auto' },
  {
    name: '中期回顾',
    category: 'review',
    approvalType: 'idp_mid_review',
    approvalProcessId: a.mid,
    startMode: 'manual',
  },
  {
    name: '期末回顾',
    category: 'evaluation',
    approvalType: 'idp_final_review',
    approvalProcessId: a.final,
    startMode: 'auto',
    startTimeType: 'relative',
    referencePoint: 'employment_effective',
    startFrom: 'same_day',
  },
];

/** 操作人：IDP 全权 + 任职记录只按“使用用户”可见，并以直接调动新建员工当前任职记录（成为创建者）。 */
async function creatorOperator(w: PlanWorld) {
  const pw = await permissionWorldOf(w);
  const op = await idpOperator(pw, { orgId: w.dept });
  await grantTenantBaseView(pw, op.user.id, []);
  const policy = await pw.api.request(
    'PUT',
    `/api/tenant/permission/scope-policies/TenantBase/${RECORD}/page/${RECORD}.detail`,
    {
      ...pw.asAdmin,
      ifMatch: 0,
      body: { rules: [{ dimension: 'using_user' }] },
    },
  );
  expect(policy.status, await policy.clone().text()).toBe(200);
  // 操作人以直接调动为员工新建当前任职记录，成为该记录（业务）的创建者
  const employee = await w.ok<{ revision: number }>(
    await w.http(w.hrUser, 'GET', `/api/tenant/employment/employees/${w.employee.employeeId}`),
  );
  const moved = await w.ok<{ id: string }>(
    await w.http(op.user.id, 'POST', `/api/tenant/employment/employees/${w.employee.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-02-01',
        fields: { departmentId: w.dept, directManagerId: w.manager.employeeId },
      },
    }),
    201,
  );
  const recordIds = [moved.id];
  // 对照：直接读取任职记录可见（“使用用户”命中创建人）
  const real = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const direct = await real.request('GET', `/api/tenant/employment/records/${recordIds[0]}`, op.as);
  expect(direct.status, await direct.clone().text()).toBe(200);
  return op;
}

describe('R2-7：源任职记录按“使用用户”可见时照常带出', () => {
  it('操作人是任职记录创建者：按直线经理创建 IDP 成功，指导人为直线经理', async () => {
    const w = await planWorld(testDb().db, 'idp-uu-tutor');
    const op = await creatorOperator(w);
    const created = await op.request('POST', '/plans', {
      ifMatch: 0,
      body: {
        name: '使用用户计划',
        employeeId: w.employee.employeeId,
        templateId: w.template.id,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        tutorRole: 'direct_manager',
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(((await created.json()) as PlanView).tutorEmployeeId).toBe(w.manager.employeeId);
  });

  it('任职生效日推算的 dueDate：创建者按“使用用户”可见时输出', async () => {
    const w = await planWorld(testDb().db, 'idp-uu-due', { stages });
    const op = await creatorOperator(w);
    const plan = await w.startedPlan();
    const expected = (await w.readPlan(plan.id)).stages[2]!.dueDate;
    expect(expected).toBe('2026-02-01');
    const shown = await w.ok<PlanView>(await op.request('GET', `/plans/${plan.id}`));
    expect(shown.stages[2]).toMatchObject({ dueDate: expected });
  });
});
