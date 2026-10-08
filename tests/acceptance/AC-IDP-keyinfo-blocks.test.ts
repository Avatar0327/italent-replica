/**
 * DEC-318 K-35 补充（取证 8db4dc6d）：关键信息模块由若干区块组成，每个区块展示哪些字段在模板里配置，不是固定列。
 * - 模板关键信息模块配置 keyInfoBlocks：[{ block, fields }]；fields 从该区块的可选字段里选（🟡 可选字段按现有数据字段
 *   推断），不给即取缺省展示字段；可选字段以外 400；
 * - 计划详情只返回模板配置的区块，每条记录只含配置的展示字段（另带 id），再按查看人的字段权限与数据范围裁剪；
 * - 被引用的模板改区块设置，对已生成的计划实时生效（原站页面提示）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';
import type { TemplateView } from './AC-IDP-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';
const span = { startDate: '2026-01-01', endDate: '2026-06-30' };

type Blocks = { block: string; fields?: string[] }[];

async function setBlocks(w: PlanWorld, blocks: Blocks) {
  const current = await w.ok<TemplateView>(await w.http(w.hrUser, 'GET', `${IDP}/templates/${w.template.id}`));
  const draft = await w.ok<TemplateView>(
    await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/unpublish`, { ifMatch: current.revision }),
  );
  const response = await w.http(w.hrUser, 'PATCH', `${IDP}/templates/${w.template.id}/modules/${w.keyInfoModule.id}`, {
    ifMatch: draft.revision,
    body: { keyInfoBlocks: blocks },
  });
  if (response.status === 200) {
    const saved = (await response.clone().json()) as TemplateView;
    await w.ok(
      await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/publish`, { ifMatch: saved.revision }),
    );
  }
  return response;
}

async function seed(w: PlanWorld) {
  for (const [path, body] of [
    ['/work-shifts', { employeeId: w.employee.employeeId, orgId: w.dept, mentorEmployeeId: w.manager.employeeId }],
    ['/tutorships', { tutorEmployeeId: w.manager.employeeId, tuteeEmployeeId: w.employee.employeeId, remark: '备注' }],
    ['/careers', { employeeId: w.employee.employeeId, strengths: '系统设计', intendedCity: '杭州' }],
  ] as const) {
    await w.ok(await w.http(w.hrUser, 'POST', `${IDP}${path}`, { ifMatch: 0, body: { ...body, ...span } }), 201);
  }
}

describe('关键信息：区块 + 可配置展示字段', () => {
  it('模板配置区块与字段；不给字段取缺省；可选字段以外 400', async () => {
    const w = await planWorld(testDb().db, 'idp-kib-config');
    const bad = await setBlocks(w, [{ block: 'work_shift', fields: ['strengths'] }]);
    expect(bad.status).toBe(400);
    const ok = await setBlocks(w, [{ block: 'work_shift', fields: ['orgId', 'postId'] }, { block: 'tutorship' }]);
    expect(ok.status, await ok.clone().text()).toBe(200);
    const module = ((await ok.json()) as TemplateView).modules.find((m) => m.id === w.keyInfoModule.id)!;
    expect(module).toMatchObject({
      keyInfoSources: ['work_shift', 'tutorship'],
      keyInfoBlocks: [
        { block: 'work_shift', fields: ['orgId', 'postId'] },
        { block: 'tutorship', fields: ['tutorEmployeeId', 'startDate', 'endDate'] },
      ],
    });
  });

  it('计划详情按配置的区块与字段返回，并照常按字段权限裁剪；改设置实时生效', async () => {
    const w = await planWorld(testDb().db, 'idp-kib-plan');
    const pw = await permissionWorldOf(w);
    await seed(w);
    const plan = await w.startedPlan();
    await setBlocks(w, [{ block: 'work_shift', fields: ['orgId', 'mentorEmployeeId'] }, { block: 'tutorship' }]);
    const view = await w.readPlan(plan.id);
    expect(view.keyInfo).not.toHaveProperty('careers');
    expect(Object.keys(view.keyInfo!.workShifts![0]!).sort()).toEqual(['id', 'mentorEmployeeId', 'orgId']);
    expect(Object.keys(view.keyInfo!.tutorships![0]!).sort()).toEqual([
      'endDate',
      'id',
      'startDate',
      'tutorEmployeeId',
    ]);
    const hr = await idpOperator(pw, { orgId: w.dept, hidden: { workShift: ['mentorEmployeeId'] } });
    const trimmed = await w.ok<PlanView>(await hr.request('GET', `/plans/${plan.id}`));
    expect(Object.keys(trimmed.keyInfo!.workShifts![0]!).sort()).toEqual(['id', 'orgId']);

    // 改设置：职业发展区块加进来，只展示优势项
    await setBlocks(w, [{ block: 'career', fields: ['strengths'] }]);
    const changed = await w.readPlan(plan.id);
    expect(changed.keyInfo).not.toHaveProperty('workShifts');
    expect(changed.keyInfo!.careers).toEqual([{ id: expect.any(String), strengths: '系统设计' }]);
  });
});
