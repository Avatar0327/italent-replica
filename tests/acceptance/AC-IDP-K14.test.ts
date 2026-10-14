/**
 * K-14 / DEC-307 员工从胜任力库选目标（PR 描述入口清单 E4 / E5）：
 * - 候选只列本计划已确定来源（模板模块的胜任力来源）下的**已启用**指标，只返回名称 / 定义 / 类别（另带选择用的 ID）；
 * - 授权 = 当前节点执行人 + 该节点 RowAddIdpGoal（DEC-296④），不要求 TalentCenter 范围；非执行人 403、无关员工 404；
 * - 选中后回填（引用回填）同样只带这三项快照，不带指标的其他字段。
 * R3-T01 未合并：指标经 IDP 端口取得（K-13），这里登记一个合成提供方。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { errorOf, planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

const INDICATORS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: '系统思考',
    definition: '从整体把握问题',
    category: '通用能力',
    enabled: true,
    ownerOrgId: 'secret-org',
    weight: 30,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: '已停用指标',
    definition: '不应出现',
    category: '通用能力',
    enabled: false,
    ownerOrgId: 'secret-org',
    weight: 10,
  },
];

let calls: { source: string; employeeId: string }[] = [];
let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  calls = [];
});

async function provide() {
  // 动态导入：端口随实现提交
  const { registerIdpCompetencyProvider } = await import('../../apps/api/src/modules/idp/competency.js');
  unregister = registerIdpCompetencyProvider(async (_tx: unknown, query: { source: string; employeeId: string }) => {
    calls.push({ source: query.source, employeeId: query.employeeId });
    return INDICATORS;
  });
}

describe('K-14 胜任力库候选与回填（DEC-307）', () => {
  it('当前节点执行人且有 RowAddIdpGoal：只列已启用指标，只回 id / 名称 / 定义 / 类别', async () => {
    await provide();
    const w = await planWorld(testDb().db, 'idp-k14');
    const plan = await w.startedPlan();
    const path = `/api/tenant/idp/plans/${plan.id}/competency-candidates?moduleId=${w.goalModule.id}`;
    const body = await w.ok<{ items: Record<string, unknown>[] }>(await w.http(w.employee.userId, 'GET', path));
    expect(body.items).toEqual([
      { id: INDICATORS[0]!.id, name: '系统思考', definition: '从整体把握问题', category: '通用能力' },
    ]);
    // 取数按模板模块配置的来源（当前职位）与计划员工
    expect(calls).toEqual([{ source: 'current_position', employeeId: w.employee.employeeId }]);
  });

  it('非执行人 403（指导人在员工节点、持 IDP 身份的 HR），无关员工 404', async () => {
    await provide();
    const w = await planWorld(testDb().db, 'idp-k14-deny');
    const plan = await w.startedPlan();
    const path = `/api/tenant/idp/plans/${plan.id}/competency-candidates?moduleId=${w.goalModule.id}`;
    for (const user of [w.manager.userId, w.hrUser]) {
      expect(await errorOf(await w.http(user, 'GET', path))).toMatchObject({
        status: 403,
        reason: 'IDP_NODE_BUTTON_DENIED',
      });
    }
    // 真实授权器下无关员工没有 IDP 身份、也不是参与人
    expect((await w.realHttp(w.outsider.userId, 'GET', path)).status).toBe(404);
    // 指导人节点只有 RowEditIdpGoal，没有 RowAddIdpGoal
    await w.submit(plan, 1, w.employee.userId);
    expect((await w.http(w.manager.userId, 'GET', path)).status).toBe(403);
  });

  it('选中指标建目标：回填名称 / 定义 / 类别快照；停用指标与来源外的指标 409', async () => {
    await provide();
    const w = await planWorld(testDb().db, 'idp-k14-fill');
    const plan = await w.startedPlan();
    const view = await w.addGoal(plan, w.employee.userId, { name: undefined, indicatorId: INDICATORS[0]!.id });
    const goal = view.goals!.find((g) => g.indicatorId === INDICATORS[0]!.id)!;
    expect(goal).toMatchObject({
      name: '系统思考',
      sourceType: 'library',
      indicatorName: '系统思考',
      indicatorDefinition: '从整体把握问题',
      indicatorCategory: '通用能力',
    });
    expect(JSON.stringify(view)).not.toContain('secret-org');
    for (const indicatorId of [INDICATORS[1]!.id, '33333333-3333-4333-8333-333333333333']) {
      const response = await w.execute(w.employee.userId, 'POST', `/plans/${plan.id}/goals`, {
        moduleId: w.goalModule.id,
        indicatorId,
      });
      expect(await errorOf(response)).toMatchObject({ status: 409, reason: 'IDP_INDICATOR_UNAVAILABLE' });
    }
  });

  it('未登记提供方（R3-T01 未合并）：候选为空', async () => {
    const w = await planWorld(testDb().db, 'idp-k14-empty');
    const plan = await w.startedPlan();
    const body = await w.ok<{ items: unknown[] }>(
      await w.http(
        w.employee.userId,
        'GET',
        `/api/tenant/idp/plans/${plan.id}/competency-candidates?moduleId=${w.goalModule.id}`,
      ),
    );
    expect(body.items).toEqual([]);
  });
});
