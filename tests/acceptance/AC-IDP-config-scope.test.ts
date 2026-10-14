/**
 * R3-T07 PR-B 第 3 轮 R2-4（DEC-309；PR 描述入口清单 E9 / E10；K-23 向下公开）：HR 计划视图里来自流程 / 模板配置的
 * 内容，还要按所属流程 / 模板的数据范围（含向下公开）判断——
 * - 阶段名称、由开启规则（固定日期）得出的 dueDate、当前阶段名称：所属流程看不到就不出现（列表与详情）；
 * - 模块与节点按钮配置：所属模板看不到就不出现。
 * 对照：流程 / 模板移到查看人范围组织的上级并向下公开时照常出现。参与人分支按 DEC-296④ 固定字段集，不在本文件。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { type Approvals, permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

/** 第一段开始即开启，第二段固定日期自动开启（dueDate = fixedDate），第三段手动。 */
const stages = (a: Approvals) => [
  { name: '制定计划', category: 'plan', approvalType: 'idp_plan', approvalProcessId: a.plan, startMode: 'auto' },
  {
    name: '中期回顾',
    category: 'review',
    approvalType: 'idp_mid_review',
    approvalProcessId: a.mid,
    startMode: 'auto',
    startTimeType: 'fixed',
    fixedDate: '2026-06-01',
  },
  {
    name: '期末回顾',
    category: 'evaluation',
    approvalType: 'idp_final_review',
    approvalProcessId: a.final,
    startMode: 'manual',
  },
];

async function scene(label: string) {
  const w = await planWorld(testDb().db, label, { stages });
  const plan = await w.startedPlan();
  const op = await idpOperator(await permissionWorldOf(w), { orgId: w.dept });
  const read = async () => ({
    detail: await w.ok<PlanView>(await op.request('GET', `/plans/${plan.id}`)),
    listed: (await w.ok<{ items: PlanView[] }>(await op.request('GET', '/plans'))).items.find((p) => p.id === plan.id)!,
  });
  return { w, plan, op, read };
}

/** 把流程 / 模板挪到另一个组织（夹具直接改所属组织与向下公开）。 */
async function moveTo(
  w: PlanWorld,
  table: 'idp_processes' | 'idp_templates',
  id: string,
  orgId: string,
  down: boolean,
) {
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE ${sql.identifier(table)} SET org_id = ${orgId}::uuid, public_down = ${down}
      WHERE tenant_id = ${w.tenant.id} AND id = ${id}::uuid`),
  );
}

/** 组织的行政上级（当前版本）。 */
async function parentOf(w: PlanWorld, orgId: string): Promise<string> {
  const result = await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`SELECT l.parent_org_id AS parent FROM org_versions v
      JOIN org_hierarchy_links l ON l.tenant_id = v.tenant_id AND l.version_id = v.id AND l.dimension = 'admin'
      WHERE v.tenant_id = ${w.tenant.id} AND v.org_id = ${orgId}::uuid
      ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1`),
  );
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { parent: string }[];
  expect(rows[0]?.parent).toBeTruthy();
  return rows[0]!.parent;
}

describe('R2-4：HR 计划视图按所属流程 / 模板的范围呈现配置内容', () => {
  it('所属流程在范围外且不向下公开：阶段名称、固定日期 dueDate、当前阶段名称都不出现；向下公开时照常', async () => {
    const { w, op, read } = await scene('idp-cfg-process');
    const before = await read();
    expect(before.detail.stages[0]).toMatchObject({ name: '制定计划' });
    expect(before.detail.stages[1]).toMatchObject({ name: '中期回顾', dueDate: '2026-06-01' });
    expect(before.detail.currentStageName).toBe('制定计划');

    await moveTo(w, 'idp_processes', w.process.id, await w.org('范围外组织'), false);
    expect((await op.request('GET', `/processes/${w.process.id}`)).status).toBe(404);
    const hidden = await read();
    for (const [where, view] of Object.entries(hidden)) {
      for (const stage of view.stages) {
        expect(stage, where).not.toHaveProperty('name');
        expect(stage, where).not.toHaveProperty('dueDate');
      }
      expect(view.currentStageName ?? null, where).toBeNull();
      expect(JSON.stringify(view), where).not.toContain('制定计划');
      expect(JSON.stringify(view), where).not.toContain('2026-06-01');
    }
    expect(hidden.detail.modules?.length).toBeGreaterThan(0);

    // 对照：挪到范围组织的上级并向下公开 → 可见
    const parent = await parentOf(w, w.dept);
    await moveTo(w, 'idp_processes', w.process.id, parent, true);
    expect((await op.request('GET', `/processes/${w.process.id}`)).status).toBe(200);
    const restored = (await read()).detail;
    expect(restored.stages[1]).toMatchObject({ name: '中期回顾', dueDate: '2026-06-01' });
    expect(restored.currentStageName).toBe('制定计划');
  });

  it('所属模板在范围外且不向下公开：计划详情不带模块与节点按钮配置', async () => {
    const { w, op, read } = await scene('idp-cfg-template');
    expect((await read()).detail.modules?.length).toBeGreaterThan(0);
    await moveTo(w, 'idp_templates', w.template.id, await w.org('范围外组织'), false);
    expect((await op.request('GET', `/templates/${w.template.id}`)).status).toBe(404);
    const { detail } = await read();
    expect(detail).not.toHaveProperty('modules');
    expect(JSON.stringify(detail)).not.toContain('nodeSettings');
    expect(detail.stages[0]).toMatchObject({ name: '制定计划' });
  });
});
