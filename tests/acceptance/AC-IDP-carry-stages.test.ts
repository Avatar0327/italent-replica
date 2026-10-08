/**
 * R3-T07 PR-B 第 2 轮 P2-4：带出值清单补漏（DEC-309；PR 描述入口清单 E2 / E9 / E10）。
 * - E2 补：通用目标的 displayOrder 看不到时不带入新目标（取缺省 0）；
 * - E9：计划列表 / 详情里的阶段名称来自子流程 name，看不到时阶段不带 name、当前阶段名为空（“努力提升中”不是带出值）；
 * - E10：阶段 dueDate 由子流程开启规则（含 fixedDate，与 ruleText 同一组源字段）、计划起止、任职生效日推算，任一源看不到
 *   就不输出 dueDate；任职生效日另须员工任职记录在操作人任职记录范围内。
 * 参与人分支按 DEC-296④ 固定字段集（不受 IDP 字段权限约束），不在本文件。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import {
  type Approvals,
  grantTenantBaseView,
  permissionWorldOf,
  planWorld,
  type PlanView,
} from './AC-IDP-plan-support.js';

const testDb = useTestDb();

/** 一段固定日期自动开启 + 一段手动 + 一段任职生效日后 0 天自动开启。 */
const stages = (a: Approvals) => [
  {
    name: '制定计划',
    category: 'plan',
    approvalType: 'idp_plan',
    approvalProcessId: a.plan,
    startMode: 'auto',
    startTimeType: 'fixed',
    fixedDate: '2026-02-15',
  },
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

interface ListPage {
  items: PlanView[];
}

describe('P2-4：带出值清单补漏', () => {
  it('E2 补：通用目标 displayOrder 看不到时不带入（新目标取 0），看得到照带', async () => {
    const w = await planWorld(testDb().db, 'idp-e2-order');
    const pw = await permissionWorldOf(w);
    await w.commonGoal('排序值目标', { displayOrder: 73 });
    await w.publish();
    const body = {
      name: '计划',
      employeeId: w.employee.employeeId,
      templateId: w.template.id,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      tutorRole: 'other',
      tutorEmployeeId: w.manager.employeeId,
    };
    const hidden = await idpOperator(pw, { orgId: w.dept, hidden: { commonGoal: ['displayOrder'] } });
    const plan = await w.ok<PlanView>(await hidden.request('POST', '/plans', { ifMatch: 0, body }), 201);
    const stored = (await w.readPlan(plan.id)).goals!.find((g) => g.name === '排序值目标')!;
    expect((stored as unknown as { displayOrder: number }).displayOrder).toBe(0);
    const full = await idpOperator(pw, { orgId: w.dept });
    const other = await w.ok<PlanView>(await full.request('POST', '/plans', { ifMatch: 0, body }), 201);
    const carried = (await w.readPlan(other.id)).goals!.find((g) => g.name === '排序值目标')!;
    expect((carried as unknown as { displayOrder: number }).displayOrder).toBe(73);
  });

  it('E9 / E10：子流程 name / fixedDate 看不到 → 列表与详情不出现阶段名称与固定日期得出的 dueDate', async () => {
    const w = await planWorld(testDb().db, 'idp-e9', { stages });
    const pw = await permissionWorldOf(w);
    const plan = await w.startedPlan();
    const hr = await idpOperator(pw, { orgId: w.dept, hidden: { subProcess: ['name', 'fixedDate'] } });
    const detail = await hr.request('GET', `/plans/${plan.id}`);
    const list = await hr.request('GET', '/plans');
    for (const [label, response] of [
      ['detail', detail],
      ['list', list],
    ] as const) {
      const text = await response.text();
      expect(response.status, `${label} ${text}`).toBe(200);
      expect(text, label).not.toContain('制定计划');
      expect(text, label).not.toContain('期末回顾');
      expect(text, label).not.toContain('2026-02-15');
      const view = label === 'detail' ? (JSON.parse(text) as PlanView) : (JSON.parse(text) as ListPage).items[0]!;
      expect(view.currentStageName, label).toBeNull();
      for (const stage of view.stages) {
        expect(stage, label).not.toHaveProperty('name');
        expect(stage, label).not.toHaveProperty('dueDate');
      }
    }
    // 对照：全部可见时照常输出
    const full = await idpOperator(pw, { orgId: w.dept });
    const shown = (await (await full.request('GET', `/plans/${plan.id}`)).json()) as PlanView;
    expect(shown.stages[0]).toMatchObject({ name: '制定计划', dueDate: '2026-02-15' });
  });

  it('E10：任职生效日参照 → 没有任职记录查看权或记录在范围外时不输出该阶段 dueDate；范围内输出', async () => {
    const w = await planWorld(testDb().db, 'idp-e10', { stages });
    const pw = await permissionWorldOf(w);
    const plan = await w.startedPlan();
    const finalOf = (view: PlanView) => view.stages.find((s) => s.seq === 3)!;
    const allowAll = await w.readPlan(plan.id);
    expect(finalOf(allowAll).dueDate).toBe('2020-01-01');

    const noEmployment = await idpOperator(pw, { orgId: w.dept });
    const outOfScope = await idpOperator(pw, { orgId: w.dept });
    await grantTenantBaseView(pw, outOfScope.user.id, []);
    for (const op of [noEmployment, outOfScope]) {
      const view = (await (await op.request('GET', `/plans/${plan.id}`)).json()) as PlanView;
      expect(finalOf(view)).not.toHaveProperty('dueDate');
      expect(view.stages[0]).toMatchObject({ dueDate: '2026-02-15' });
    }
    const inScope = await idpOperator(pw, { orgId: w.dept });
    await grantTenantBaseView(pw, inScope.user.id, [w.dept]);
    const view = (await (await inScope.request('GET', `/plans/${plan.id}`)).json()) as PlanView;
    expect(finalOf(view).dueDate).toBe('2020-01-01');
  });
});
