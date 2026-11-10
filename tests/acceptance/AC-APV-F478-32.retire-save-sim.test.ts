/**
 * AC-APV-F478-32（F-478 S4，设计 §5.3 / §8 / §10）：退休业务出口的保存校验、仿真与「返聘后」来源误用。
 * - 保存：退休 HRBP 节点登记的业务出口组可保存；非退休类型 / 非登记节点 → business_exit_type；出口组残缺 →
 *   incomplete_exit_group；会签节点用业务出口 → countersign_business_exit（均 400 APPROVAL_ROUTE_INVALID）；
 * - 仿真：「是否同时返聘」取 true / false 走不同路径，缺该字段 → branch:'undetermined'，不猜路径；
 * - 来源：非退休类型选「返聘后直线经理 / 返聘后 HRBP」→ 422 APPROVAL_SOURCE_INVALID，原文精确。
 * 真实 HTTP + 真实库 + 合成数据。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, type NodeInput, type ProcessView } from './AC-APV-support.js';
import { cloneForPut, errorInfo, putDraft, withRoutesOn } from './AC-APV-F478-s2-support.js';
import { APV } from './AC-APV-F478-s4-support.js';
import { failureOf, node, saveSingleNode } from './AC-APV-F478-s3-support.js';

const testDb = useTestDb();
const GROUP = ['approve_no_rehire', 'approve_rehire'];

const linear = (exits: string[] | undefined, key = 'hr_interview'): NodeInput[] => [
  node('direct_head', { type: 'object_field', value: 'direct_manager' }),
  {
    ...node(key, { type: 'department', value: 'record_department_hrbp' }),
    ...(exits ? { exits } : {}),
  } as NodeInput,
  node('rehire_manager', { type: 'object_field', value: 'rehire_direct_manager' }),
];
const ROUTES = {
  hr_interview: [
    { exit: 'approve_no_rehire', branches: [{ kind: 'direct', target: 'END' }] },
    { exit: 'approve_rehire', branches: [{ kind: 'direct', target: 'rehire_manager' }] },
  ],
} as never;

describe('AC-APV-F478-32 保存：业务出口组校验', () => {
  it('退休 HRBP 节点的完整出口组 + 路由 → 200', async () => {
    const w = await approvalWorld(testDb().db, 'f478-32-valid');
    const created = await w.createProcess({
      approvalType: 'retirement',
      isFallback: true,
      conditions: { items: [] },
      nodes: linear(GROUP),
    });
    const response = await putDraft(
      w,
      created,
      cloneForPut(created.latestVersion, { nodes: withRoutesOn(created.latestVersion.nodes, ROUTES) }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it.each([
    ['非退休类型（离职）', 'leave', 'hr_interview', GROUP, 'business_exit_type'],
    ['退休但非登记节点', 'retirement', 'direct_head', GROUP, 'business_exit_type'],
    ['出口组残缺', 'retirement', 'hr_interview', ['approve_rehire'], 'incomplete_exit_group'],
  ] as const)('%s → 400 %s', async (_label, approvalType, key, exits, reason) => {
    const w = await approvalWorld(testDb().db, `f478-32-${reason}-${approvalType}-${key}`);
    const nodes: NodeInput[] = [
      { ...node(key, { type: 'department', value: 'record_department_hrbp' }), exits: [...exits] } as NodeInput,
      node('next', { type: 'object_field', value: 'direct_manager' }),
    ];
    const created = await w.createProcess({
      approvalType,
      isFallback: true,
      conditions: { items: [] },
      nodes: [nodes[1]!],
    });
    const body = cloneForPut(created.latestVersion, { nodes });
    expect(await errorInfo(await putDraft(w, created, body))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason,
      detailCode: 'APPROVAL_ROUTE_INVALID',
      nodeKey: key,
    });
  });

  it('会签节点用业务出口 → 400 countersign_business_exit', async () => {
    const w = await approvalWorld(testDb().db, 'f478-32-countersign');
    const a = await w.person('会签甲', await w.org('会签部门甲'));
    const b = await w.person('会签乙', await w.org('会签部门乙'));
    const created = await w.createProcess({
      approvalType: 'retirement',
      isFallback: true,
      conditions: { items: [] },
      nodes: [node('direct_head', { type: 'object_field', value: 'direct_manager' })],
    });
    const joint = {
      key: 'hr_interview',
      name: '会签',
      kind: 'countersign',
      approvers: [
        { type: 'specified', value: a.userId },
        { type: 'specified', value: b.userId },
      ],
      transitionRule: { type: 'any' },
      exits: GROUP,
    };
    const body = cloneForPut(created.latestVersion, { nodes: [...created.latestVersion.nodes, joint] });
    expect(await errorInfo(await putDraft(w, created, body))).toMatchObject({
      status: 400,
      reason: 'countersign_business_exit',
      nodeKey: 'hr_interview',
    });
  });
});

describe('AC-APV-F478-32 来源误用：返聘后审批人只能用于退休', () => {
  it.each([
    ['rehire_direct_manager', 'object_field'],
    ['rehire_department_hrbp', 'department'],
  ] as const)('非退休类型选 %s → 422，原文精确；退休类型可保存', async (value, type) => {
    const w = await approvalWorld(testDb().db, `f478-32-source-${value}`);
    for (const approvalType of ['leave', 'transfer', 'regularization']) {
      const failure = await failureOf(await saveSingleNode(w, approvalType, { type, value }, { avoidSelf: false }));
      expect(failure, approvalType).toMatchObject({
        status: 422,
        code: 'APPROVAL_SOURCE_INVALID',
        reason: 'APPROVAL_DEFINITION_INVALID',
      });
      expect(failure.violations).toContain('节点 one 的审批人“返聘后直线经理 / 返聘后 HRBP”只能用于退休审批');
    }
    const ok = await saveSingleNode(w, 'retirement', { type, value }, { avoidSelf: false });
    expect(ok.status, await ok.clone().text()).toBe(201);
  });

  it('设计器候选：退休类型有“返聘后直线经理”，其他类型没有', async () => {
    const w = await approvalWorld(testDb().db, 'f478-32-candidates');
    const names = async (approvalType: string) => {
      const response = await w.request(
        w.hr.id,
        'GET',
        `${APV}/designer/source-candidates?type=object_field&approvalType=${approvalType}&asOf=2026-10-01`,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return (await w.json<{ items: { id: string }[] }>(response)).items.map((item) => item.id);
    };
    expect(await names('retirement')).toContain('rehire_direct_manager');
    expect(await names('leave')).not.toContain('rehire_direct_manager');
  });
});

describe('AC-APV-F478-32 仿真：按是否同时返聘走不同路径', () => {
  async function published(label: string) {
    const w = await approvalWorld(testDb().db, label);
    const created = await w.createProcess({
      approvalType: 'retirement',
      isFallback: true,
      conditions: { items: [] },
      nodes: linear(GROUP),
    });
    const saved = await w.json<ProcessView>(
      await putDraft(
        w,
        created,
        cloneForPut(created.latestVersion, { nodes: withRoutesOn(created.latestVersion.nodes, ROUTES) }),
      ),
    );
    return { w, process: await w.publish(saved) };
  }
  const simulate = async (
    ctx: Awaited<ReturnType<typeof published>>,
    values: Record<string, string | null>,
  ): Promise<{ path: string[]; nodes: { key: string; branch?: string }[] }> =>
    ctx.w.json(
      await ctx.w.request(ctx.w.hr.id, 'POST', `${APV}/processes/${ctx.process.id}/simulate`, {
        body: { scope: 'published', data: { values: { processCode: 'RetireProcess', ...values } } },
      }),
    );

  it('reEmployed=true 经返聘后直线经理；false 在 HRBP 结束；缺该字段 → undetermined 并停止', async () => {
    const ctx = await published('f478-32-sim');
    expect((await simulate(ctx, { 'business.reEmployed': 'true' })).path).toEqual([
      'direct_head',
      'hr_interview',
      'rehire_manager',
    ]);
    expect((await simulate(ctx, { 'business.reEmployed': 'false' })).path).toEqual(['direct_head', 'hr_interview']);
    const missing = await simulate(ctx, {});
    expect(missing.path).toEqual(['direct_head', 'hr_interview']);
    expect(missing.nodes.find((n) => n.key === 'hr_interview')?.branch).toBe('undetermined');
  });
});

/**
 * 业务出口节点不配显式路由也是合法定义（设计 §1.4 默认后继）：仿真同样要读守卫事实，
 * 缺 business.reEmployed 时停在 HRBP，不得把四节点全推成 pass（审查 P2-1）。
 */
describe('AC-APV-F478-32 仿真：无显式路由的业务出口节点仍按守卫推演', () => {
  type Sim = { path: string[]; nodes: { key: string; branch?: string; exit?: string }[] };
  async function publishedWithoutRoutes(label: string, routes: 'omitted' | 'empty') {
    const w = await approvalWorld(testDb().db, label);
    const created = await w.createProcess({
      approvalType: 'retirement',
      isFallback: true,
      conditions: { items: [] },
      nodes: linear(GROUP),
    });
    const nodes =
      routes === 'empty'
        ? withRoutesOn(created.latestVersion.nodes, { hr_interview: [] } as never)
        : created.latestVersion.nodes;
    const response = await putDraft(w, created, cloneForPut(created.latestVersion, { nodes }));
    expect(response.status, await response.clone().text()).toBe(200);
    return { w, process: await w.publish(await w.json<ProcessView>(response)) };
  }
  const simulate = async (ctx: Awaited<ReturnType<typeof publishedWithoutRoutes>>, values: Record<string, string>) =>
    ctx.w.json<Sim>(
      await ctx.w.request(ctx.w.hr.id, 'POST', `${APV}/processes/${ctx.process.id}/simulate`, {
        body: { scope: 'published', data: { values: { processCode: 'RetireProcess', ...values } } },
      }),
    );

  it.each(['omitted', 'empty'] as const)('routes %s：缺 reEmployed 停在 HRBP，不得推完整条路径', async (routes) => {
    const ctx = await publishedWithoutRoutes(`f478-32-noroute-missing-${routes}`, routes);
    const result = await simulate(ctx, {});
    expect(result.path).toEqual(['direct_head', 'hr_interview']);
    expect(result.nodes.find((n) => n.key === 'hr_interview')?.branch).toBe('undetermined');
    expect(result.nodes.find((n) => n.key === 'rehire_manager')).not.toHaveProperty('exit');
  });

  it.each(['omitted', 'empty'] as const)('routes %s：给定 true / false 返回对应出口', async (routes) => {
    const ctx = await publishedWithoutRoutes(`f478-32-noroute-given-${routes}`, routes);
    const hrbp = async (value: string) =>
      (await simulate(ctx, { 'business.reEmployed': value })).nodes.find((n) => n.key === 'hr_interview');
    expect(await hrbp('true')).toMatchObject({ exit: 'approve_rehire' });
    expect(await hrbp('false')).toMatchObject({ exit: 'approve_no_rehire' });
    expect(await hrbp('true')).not.toHaveProperty('branch', 'undetermined');
  });
});
