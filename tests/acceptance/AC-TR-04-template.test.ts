/**
 * R3-T04 PR-B6a 盘点模板结构与版本（设计 §2.3、§7；TR-R11～R19；AC-TR-04；D-02 / D-03）：
 * - 新建 / 编辑：名称租户唯一；所属组织、向下公开、流程、启停；启用须已选流程；每次结构保存生成新版本，只改头部字段不生成；
 * - 步骤在版本内冻结流程节点副本（含角色 resolver），只有 show_matrix 是模板自己的设置；
 * - 模块：指标评估（来源、算分方式、评价规则）/ 盘点信息（展示字段）/ 继任信息；名称版本内唯一；按指标数目须等级类规则 + 按指标数目的模块等级；
 * - 步骤 × 角色 × 模块权限：缺省行由服务端物化，会签按角色、单人不带角色；继任两项三档；
 * - configErrors：权重之和 ≠ 100 → WEIGHT_SUM_NOT_100（允许保存、不拦截）；
 * - 引用保护：人才标准 CRITERION_NOT_REFERENCEABLE + 被模板引用拒删；流程 / 角色 / 评价规则 / 模块等级 / 字段被模板引用拒删。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import {
  indicatorModule,
  reasonOf,
  templateBody,
  templateWorld,
  TEMPLATES,
  TR_NOW,
  type TemplateView,
} from './AC-TR-template-support.js';

const testDb = useTestDb();

async function fixture(label: string) {
  const w = await templateWorld(testDb().db, label);
  const flow = await w.threeStepFlow();
  const rule = await w.scoreRule();
  return { w, ...flow, rule };
}

describe('盘点模板 · 新建与步骤冻结（TR-R11、R17、R18）', () => {
  it('新建：版本 1；步骤冻结自流程节点（含角色 resolver）；缺省停用；不选流程不能启用', async () => {
    const { w, flow, roles } = await fixture('tpl-create');
    const created = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    expect(created).toMatchObject({
      ownerOrgId: w.orgId,
      downwardPublic: false,
      flowId: flow.id,
      enabled: false,
      currentVersionNo: 1,
      versionNo: 1,
      accessLevel: 'manage',
      modules: [],
      permissions: [],
      configErrors: [],
    });
    expect(created.steps.map((s) => [s.nodeKey, s.kind, s.stepType, s.mode, s.showMatrix])).toEqual([
      ['self', 'single', 'evaluate', 'single', false],
      ['peers', 'countersign', 'evaluate', 'single', false],
      ['calibrate', 'single', 'calibrate', 'batch', false],
    ]);
    expect(created.steps[1]!.roles.map((r) => r.roleId).sort()).toEqual([roles.peerA.id, roles.peerB.id].sort());
    expect(created.steps[0]!.roles).toEqual([{ roleId: roles.self.id, resolver: 'direct_manager' }]);
    const noFlow = await w.trRequest('POST', TEMPLATES, {
      ifMatch: 0,
      body: templateBody(w.orgId, { enabled: true }),
    });
    expect([noFlow.status, await reasonOf(noFlow)]).toEqual([400, 'TEMPLATE_FLOW_REQUIRED']);
    const ok = await w.template(templateBody(w.orgId, { flowId: flow.id, enabled: true }));
    expect(ok.enabled).toBe(true);
  });

  it('名称租户唯一 409；所属组织不存在 404；流程不存在 404；列表带头部与 accessLevel', async () => {
    const { w, flow } = await fixture('tpl-dup');
    const first = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    const dup = await w.trRequest('POST', TEMPLATES, {
      ifMatch: 0,
      body: templateBody(w.orgId, { name: first.name }),
    });
    expect([dup.status, await reasonOf(dup)]).toEqual([409, 'TEMPLATE_DUPLICATE']);
    const ghost = '00000000-0000-4000-8000-000000000001';
    for (const extra of [{ ownerOrgId: ghost }, { flowId: ghost }]) {
      const response = await w.trRequest('POST', TEMPLATES, { ifMatch: 0, body: templateBody(w.orgId, extra) });
      expect(response.status, JSON.stringify(extra)).toBe(404);
    }
    const list = (await (await w.trRequest('GET', `${TEMPLATES}?pageSize=100`)).json()) as {
      items: { id: string; accessLevel: string }[];
    };
    expect(list.items.find((item) => item.id === first.id)).toMatchObject({ accessLevel: 'manage' });
  });

  it('流程换了：新版本重新冻结节点副本，按节点 key 保留 show_matrix；流程之后修改不影响已冻结的版本', async () => {
    const { w, flow, roles } = await fixture('tpl-reflow');
    const a = await w.template(
      templateBody(w.orgId, { flowId: flow.id, steps: [{ nodeKey: 'self', showMatrix: true }] }),
    );
    expect(a.steps.find((s) => s.nodeKey === 'self')!.showMatrix).toBe(true);
    // 流程之后改名 / 加节点：模板当前版本不变
    const flowRead = (await (await w.trRequest('GET', `/flows/${flow.id}`)).json()) as {
      revision: number;
      nodes: { id: string; nodeKey: string; name: string; roleIds: string[]; [key: string]: unknown }[];
    };
    const patched = await w.trRequest('PATCH', `/flows/${flow.id}`, {
      ifMatch: flowRead.revision,
      body: { nodes: flowRead.nodes.map((n) => (n.nodeKey === 'self' ? { ...n, name: '本人改名' } : n)) },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await w.read(a.id)).body.steps.find((s) => s.nodeKey === 'self')!.name).toBe('本人自评');
    // 换一个只有一个节点的流程
    const other = await w.created<{ id: string }>('/flows', {
      name: `单节点流程${Date.now()}`,
      nodes: [
        {
          nodeKey: 'self',
          name: '自评',
          kind: 'single',
          stepType: 'evaluate',
          mode: 'single',
          roleIds: [roles.self.id],
        },
      ],
    });
    const b = (await (await w.patch(a, { flowId: other.id })).json()) as TemplateView;
    expect(b).toMatchObject({ flowId: other.id, currentVersionNo: 2, versionNo: 2 });
    expect(b.steps.map((s) => [s.nodeKey, s.showMatrix])).toEqual([['self', true]]);
    expect((await w.read(a.id, '?version=1')).body.steps).toHaveLength(3);
  });
});

describe('盘点模板 · 模块与默认权限（TR-R13～R16、R18）', () => {
  it('指标模块：评价规则头部与等级整份快照；缺省权限行物化（单人一行、会签按角色一行）；校准步骤同样', async () => {
    const { w, flow, roles } = await fixture('tpl-module');
    const rule = await w.gradeRule();
    const t = await w.template(
      templateBody(w.orgId, { flowId: flow.id, modules: [indicatorModule(rule.id, { name: '业绩' })] }),
    );
    const module = t.modules[0]!;
    expect(module).toMatchObject({
      kind: 'indicator',
      name: '业绩',
      source: 'qualification',
      scoring: 'weighted_sum',
      scoreRuleId: rule.id,
      ruleSnapshot: { kind: 'grade', allowUnable: false },
    });
    expect(module.ruleSnapshot!.levels.map((l) => l.name)).toEqual(['高', '中', '低']);
    expect(t.permissions.map((p) => [p.nodeKey, p.roleId, p.moduleName, p.visible, p.scoreEnabled, p.weight])).toEqual(
      [
        ['self', null, '业绩', true, true, null],
        ['peers', roles.peerA.id, '业绩', true, true, null],
        ['peers', roles.peerB.id, '业绩', true, true, null],
        ['calibrate', null, '业绩', true, true, null],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) as never,
    );
  });

  it('configErrors：权重之和 ≠ 100 → WEIGHT_SUM_NOT_100 且允许保存；调到 100 清除（D-03）', async () => {
    const { w, flow, rule } = await fixture('tpl-weight');
    const t = await w.template(
      templateBody(w.orgId, { flowId: flow.id, modules: [indicatorModule(rule.id, { name: '业绩' })] }),
    );
    expect(t.configErrors).toEqual([{ moduleName: '业绩', code: 'WEIGHT_SUM_NOT_100', sum: 0 }]);
    const row = (nodeKey: string, weight: number, roleId?: string) => ({
      nodeKey,
      moduleName: '业绩',
      weight,
      ...(roleId ? { roleId } : {}),
    });
    const peers = t.steps.find((s) => s.nodeKey === 'peers')!.roles.map((r) => r.roleId);
    const over = (await (
      await w.patch(t, {
        permissions: [row('self', 60), row('peers', 30, peers[0]), row('peers', 20, peers[1])],
      })
    ).json()) as TemplateView;
    expect(over.configErrors).toEqual([{ moduleName: '业绩', code: 'WEIGHT_SUM_NOT_100', sum: 110 }]);
    const fixed = (await (
      await w.patch(over, {
        permissions: [
          row('self', 60),
          row('peers', 20, peers[0]),
          row('peers', 20, peers[1]),
          { nodeKey: 'calibrate', moduleName: '业绩', scoreEnabled: false },
        ],
      })
    ).json()) as TemplateView;
    expect(fixed.configErrors).toEqual([]);
    expect(fixed.currentVersionNo).toBe(3);
  });

  it('继任模块两项三档、盘点信息模块展示字段；信息模块没有步骤权限行', async () => {
    const { w, flow, rule } = await fixture('tpl-kinds');
    const field = await w.field();
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [
          indicatorModule(rule.id, { name: '业绩' }),
          { kind: 'info', name: '盘点信息', fieldIds: [field.id] },
          { kind: 'succession', name: '继任', allowOrg: true, allowPosition: false, allowTarget: true },
        ],
        permissions: [{ nodeKey: 'self', moduleName: '继任', successorAccess: 'edit', targetAccess: 'view' }],
      }),
    );
    expect(t.modules.map((m) => [m.kind, m.name])).toEqual([
      ['indicator', '业绩'],
      ['info', '盘点信息'],
      ['succession', '继任'],
    ]);
    expect(t.modules[1]!.fieldIds).toEqual([field.id]);
    const succession = t.permissions.filter((p) => p.moduleName === '继任');
    expect(succession.find((p) => p.nodeKey === 'self')).toMatchObject({
      successorAccess: 'edit',
      targetAccess: 'view',
    });
    expect(succession.find((p) => p.nodeKey === 'calibrate')).toMatchObject({
      successorAccess: 'hidden',
      targetAccess: 'hidden',
    });
    expect(t.permissions.some((p) => p.moduleName === '盘点信息')).toBe(false);
  });
});

describe('盘点模板 · 保存校验（先拒后读，数据不变）', () => {
  it('模块 / 权限 / 引用不合法分别 400 / 404，且模板与版本都不变', async () => {
    const { w, flow, rule } = await fixture('tpl-invalid');
    const t = await w.template(
      templateBody(w.orgId, { flowId: flow.id, modules: [indicatorModule(rule.id, { name: '业绩' })] }),
    );
    const ghost = '00000000-0000-4000-8000-000000000002';
    const numeric = await w.scoreRule();
    const grade = await w.moduleGrade();
    const cases: [number, string | null, Record<string, unknown>][] = [
      [
        400,
        'MODULE_NAME_DUPLICATE',
        { modules: [indicatorModule(rule.id, { name: '业绩' }), { kind: 'info', name: '业绩', fieldIds: [] }] },
      ],
      [400, 'MODULE_SOURCE_REQUIRED', { modules: [indicatorModule(rule.id, { source: null })] }],
      [
        400,
        'MODULE_BY_COUNT_RULE',
        { modules: [indicatorModule(numeric.id, { scoring: 'by_count', moduleGradeId: grade.id })] },
      ],
      [404, null, { modules: [indicatorModule(ghost)] }],
      [404, null, { modules: [{ kind: 'info', name: '信息', fieldIds: [ghost] }] }],
      [400, 'PERMISSION_STEP_UNKNOWN', { permissions: [{ nodeKey: 'nope', moduleName: '业绩' }] }],
      [400, 'PERMISSION_ROLE_INVALID', { permissions: [{ nodeKey: 'peers', moduleName: '业绩' }] }],
      [400, 'PERMISSION_MODULE_UNKNOWN', { permissions: [{ nodeKey: 'self', moduleName: '无' }] }],
      [
        400,
        'PERMISSION_REQUIRED_NEEDS_ENABLED',
        { permissions: [{ nodeKey: 'self', moduleName: '业绩', scoreRequired: true, scoreEnabled: false }] },
      ],
    ];
    for (const [status, reason, body] of cases) {
      const key = `tpl-bad-${Math.random()}`;
      const response = await w.patch(t, body, key);
      expect([response.status, reason ? await reasonOf(response.clone()) : null], JSON.stringify(body)).toEqual([
        status,
        reason,
      ]);
      expect((await w.read(t.id)).body).toEqual(await (await w.trRequest('GET', `${TEMPLATES}/${t.id}`)).json());
    }
    expect((await w.read(t.id)).body.currentVersionNo).toBe(1);
    expect((await w.read(t.id)).body.revision).toBe(t.revision);
  });

  it('按指标数目：等级类规则 + 按指标数目的模块等级可建；缺模块等级 400', async () => {
    const { w, flow } = await fixture('tpl-bycount');
    const grade = await w.gradeRule();
    const byCount = await w.moduleGrade({
      items: [
        { name: '高', value: 'H', minCount: 10 },
        { name: '中', value: 'M', minCount: 5 },
      ],
    });
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [{ ...indicatorModule(grade.id, { name: '数量' }), scoring: 'by_count', moduleGradeId: byCount.id }],
      }),
    );
    expect(t.modules[0]).toMatchObject({ scoring: 'by_count', moduleGradeId: byCount.id });
    expect(t.modules[0]!.gradeSnapshot!.items.map((i) => i.name)).toEqual(['高', '中']);
    const missing = await w.patch(t, {
      modules: [{ ...indicatorModule(grade.id, { name: '数量' }), scoring: 'by_count' }],
    });
    expect([missing.status, await reasonOf(missing)]).toEqual([400, 'MODULE_BY_COUNT_GRADE']);
  });
});

describe('盘点模板 · 版本（TR-R12、D-02）', () => {
  it('结构保存生成新版本，头部字段修改不生成；旧版本可读且不变；revision 冲突 409；幂等重放返回原结果', async () => {
    const { w, flow, rule } = await fixture('tpl-versions');
    const v1 = await w.template(
      templateBody(w.orgId, { flowId: flow.id, modules: [indicatorModule(rule.id, { name: '业绩' })] }),
    );
    const renamed = (await (await w.patch(v1, { name: `${v1.name}改`, downwardPublic: true })).json()) as TemplateView;
    expect([renamed.currentVersionNo, renamed.versionNo, renamed.revision]).toEqual([1, 1, 2]);
    const key = 'tpl-structure-key';
    const body = { modules: [indicatorModule(rule.id, { name: '业绩二' })] };
    const v2response = await w.patch(renamed, body, key);
    const v2 = (await v2response.json()) as TemplateView;
    expect([v2.currentVersionNo, v2.modules.map((m) => m.name), v2.versions.map((v) => v.versionNo)]).toEqual([
      2,
      ['业绩二'],
      [1, 2],
    ]);
    const replay = await w.patch(renamed, body, key);
    expect(await replay.json()).toEqual(v2);
    expect((await w.read(v1.id)).body.currentVersionNo).toBe(2);
    expect((await w.read(v1.id, '?version=1')).body.modules.map((m) => m.name)).toEqual(['业绩']);
    const stale = await w.patch(renamed, { name: '又改' });
    expect(stale.status).toBe(409);
    const missingVersion = await w.trRequest('GET', `${TEMPLATES}/${v1.id}?version=9`);
    expect(missingVersion.status).toBe(404);
  });

  it('创建 / 修改 / 删除各写一条审计；删除带快照；删除后详情 404', async () => {
    const { w, flow, rule } = await fixture('tpl-audit');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const t = await w.template(
      templateBody(w.orgId, { flowId: flow.id, modules: [indicatorModule(rule.id, { name: '业绩' })] }),
    );
    const patched = (await (
      await w.patch(t, { modules: [indicatorModule(rule.id, { name: '业绩二' })] })
    ).json()) as TemplateView;
    const deleted = await w.trRequest('DELETE', `${TEMPLATES}/${t.id}`, { ifMatch: patched.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect((await w.read(t.id)).status).toBe(404);
    const { items } = await audit.dataChanges(w.as, { objectType: 'TalentReview.Template', limit: '50' });
    expect(items.map((entry) => entry.operation).sort()).toEqual(['create', 'delete', 'update']);
    const removed = await audit.dataChange(w.as, items.find((entry) => entry.operation === 'delete')!.id);
    expect(removed.snapshot).toMatchObject({ id: t.id, name: t.name });
    expect((removed.snapshot as TemplateView).modules.map((m) => m.name)).toEqual(['业绩二']);
  });
});

describe('盘点模板 · 引用保护（设计 §5.1；TR-R12、R20）', () => {
  it('流程 / 角色 / 评价规则 / 模块等级 / 字段被模板引用不能删（409 *_IN_USE），模板删除后可删', async () => {
    const { w, flow, roles, rule } = await fixture('tpl-refs');
    const grade = await w.moduleGrade();
    const field = await w.field();
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [
          indicatorModule(rule.id, { name: '业绩', moduleGradeId: grade.id }),
          { kind: 'info', name: '信息', fieldIds: [field.id] },
        ],
      }),
    );
    const del = async (path: string) => {
      const read = (await (await w.trRequest('GET', path)).json()) as { revision: number };
      const response = await w.trRequest('DELETE', path, { ifMatch: read.revision });
      return [response.status, response.status === 409 ? await reasonOf(response) : null];
    };
    expect(await del(`/flows/${flow.id}`)).toEqual([409, 'FLOW_IN_USE']);
    expect(await del(`/score-rules/${rule.id}`)).toEqual([409, 'SCORE_RULE_IN_USE']);
    expect(await del(`/module-grades/${grade.id}`)).toEqual([409, 'MODULE_GRADE_IN_USE']);
    expect(await del(`/fields/${field.id}`)).toEqual([409, 'FIELD_IN_USE']);
    expect(await del(`/roles/${roles.self.id}`)).toEqual([409, 'ROLE_IN_USE']);
    const gone = await w.trRequest('DELETE', `${TEMPLATES}/${t.id}`, { ifMatch: t.revision });
    expect(gone.status).toBe(200);
    expect((await del(`/score-rules/${rule.id}`))[0]).toBe(200);
  });

  it('人才标准：指定标准须存在且启用，否则 400 CRITERION_NOT_REFERENCEABLE；被模板引用的标准不能删（409 CRITERION_REFERENCED）', async () => {
    const { w, flow, rule } = await fixture('tpl-criterion');
    const library = await w.library('ability');
    const dimension = await w.dimension(library.id);
    const category = await w.category();
    const criterion = await w.criterion(category.id, [{ dimensionId: dimension.id, displayOrder: 1 }]);
    const module = (criterionId: string) =>
      indicatorModule(rule.id, {
        name: '能力',
        source: 'talent_standard',
        criterionMode: 'designated',
        criterionId,
        dimensionTypes: ['ability'],
      });
    const post = (criterionId: string) =>
      w.trRequest('POST', TEMPLATES, {
        ifMatch: 0,
        body: templateBody(w.orgId, { flowId: flow.id, modules: [module(criterionId)] }),
      });
    const missing = await post('00000000-0000-4000-8000-000000000003');
    expect([missing.status, await reasonOf(missing)]).toEqual([400, 'CRITERION_NOT_REFERENCEABLE']);
    const ok = await post(criterion.id);
    expect(ok.status, await ok.clone().text()).toBe(201);
    expect(((await ok.json()) as TemplateView).modules[0]).toMatchObject({
      criterionMode: 'designated',
      criterionId: criterion.id,
      dimensionTypes: ['ability'],
    });
    const del = await w.request('DELETE', `/criteria/${criterion.id}`, { ifMatch: criterion.revision });
    expect(del.status).toBe(409);
    expect(await reasonOf(del)).toBe('CRITERION_REFERENCED');
    const disabled = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: criterion.revision,
      body: { enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const stopped = await post(criterion.id);
    expect([stopped.status, await reasonOf(stopped)]).toEqual([400, 'CRITERION_NOT_REFERENCEABLE']);
    const byJob = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [indicatorModule(rule.id, { name: '职务标准', source: 'talent_standard', criterionMode: 'by_job' })],
      }),
    );
    expect(byJob.modules[0]).toMatchObject({ criterionMode: 'by_job', criterionId: null });
  });
});
