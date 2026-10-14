/**
 * R3-T07 PR-B 第 4 轮 R3-1（DEC-318 K-35 补充；R2-3 / R2-4 的派生出口）：计划详情的关键信息按模板配置的区块与展示列
 * 生成。查看人看不到这份配置（模板模块对象没有查看权，或 `keyInfoSources` / `keyInfoBlocks` 任一字段隐藏）时，不能按
 * 隐藏的配置挑区块和列——否则返回的区块与列就是配置本身。此时计划响应不带 `keyInfo`（关键信息记录仍可经关键信息
 * 接口按其权限读取）。GET 详情、PATCH 之后的响应、同键重放与删除快照（共用 presentPlan）一致。
 * 三种状态（隐藏 sources、隐藏 blocks、撤销模板模块查看权）× 三个例子（career / strengths、career / intendedCity、
 * work_shift / orgId）。
 */
import { randomUUID } from 'node:crypto';
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator, type OperatorOptions } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';
import type { TemplateView } from './AC-IDP-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';
const span = { startDate: '2026-01-01', endDate: '2026-06-30' };

async function configure(w: PlanWorld, blocks: { block: string; fields: string[] }[]) {
  const current = await w.ok<TemplateView>(await w.http(w.hrUser, 'GET', `${IDP}/templates/${w.template.id}`));
  const draft = await w.ok<TemplateView>(
    await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/unpublish`, { ifMatch: current.revision }),
  );
  const saved = await w.ok<TemplateView>(
    await w.http(w.hrUser, 'PATCH', `${IDP}/templates/${w.template.id}/modules/${w.keyInfoModule.id}`, {
      ifMatch: draft.revision,
      body: { keyInfoBlocks: blocks },
    }),
  );
  await w.ok(await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/publish`, { ifMatch: saved.revision }));
}

async function seed(w: PlanWorld) {
  for (const [path, body] of [
    ['/work-shifts', { employeeId: w.employee.employeeId, orgId: w.dept }],
    ['/careers', { employeeId: w.employee.employeeId, strengths: '系统设计', intendedCity: '杭州' }],
  ] as const) {
    await w.ok(await w.http(w.hrUser, 'POST', `${IDP}${path}`, { ifMatch: 0, body: { ...body, ...span } }), 201);
  }
}

const ALL_BUT_MODULE = (Object.keys(IDP_OBJECTS) as (keyof typeof IDP_OBJECTS)[]).filter(
  (key) => key !== 'templateModule',
);
const STATES: [string, OperatorOptions][] = [
  ['隐藏 keyInfoSources', { hidden: { templateModule: ['keyInfoSources'] } }],
  ['隐藏 keyInfoBlocks', { hidden: { templateModule: ['keyInfoBlocks'] } }],
  ['没有模板模块查看权', { objects: ALL_BUT_MODULE }],
];
const EXAMPLES: [string, string, string][] = [
  ['career', 'careers', 'strengths'],
  ['career', 'careers', 'intendedCity'],
  ['work_shift', 'workShifts', 'orgId'],
];

describe('R3-1：看不到关键信息配置时，计划响应不按隐藏配置生成 keyInfo', () => {
  for (const [block, key, field] of EXAMPLES) {
    it(`${block} / ${field}：三种状态下详情、PATCH 响应、同键重放、删除快照都不带 keyInfo；看得到配置时照常`, async () => {
      const w = await planWorld(testDb().db, `idp-kch-${block}-${field}`);
      const pw = await permissionWorldOf(w);
      await seed(w);
      await configure(w, [{ block, fields: [field] }]);
      const plan = await w.startedPlan();

      const full = await idpOperator(pw, { orgId: w.dept });
      const control = await w.ok<PlanView>(await full.request('GET', `/plans/${plan.id}`));
      expect((control.keyInfo as Record<string, unknown[]>)[key]).toEqual([
        { id: expect.any(String), [field]: expect.anything() },
      ]);

      for (const [label, options] of STATES) {
        const op = await idpOperator(pw, { ...options, orgId: w.dept });
        const detail = await w.ok<PlanView>(await op.request('GET', `/plans/${plan.id}`));
        expect(detail, `${label} GET`).not.toHaveProperty('keyInfo');

        const current = await w.readPlan(plan.id);
        const command = `kch-${randomUUID()}`;
        const patch = () =>
          op.request('PATCH', `/plans/${plan.id}`, {
            ifMatch: current.revision,
            idempotencyKey: command,
            body: { name: `改名-${label}` },
          });
        expect(await w.ok<PlanView>(await patch()), `${label} PATCH`).not.toHaveProperty('keyInfo');
        expect(await w.ok<PlanView>(await patch()), `${label} 重放`).not.toHaveProperty('keyInfo');
      }

      // 删除快照（共用 presentPlan）：用最后一种状态的操作人删除
      const remover = await idpOperator(pw, { ...STATES[2]![1], orgId: w.dept });
      const latest = await w.readPlan(plan.id);
      const removed = await w.ok<PlanView>(
        await remover.request('DELETE', `/plans/${plan.id}`, { ifMatch: latest.revision }),
      );
      expect(removed, '删除快照').not.toHaveProperty('keyInfo');
    });
  }
});
