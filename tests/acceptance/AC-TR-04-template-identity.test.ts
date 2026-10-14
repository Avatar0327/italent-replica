/**
 * R3-T04 PR-B6a 第 2 轮（PR #244，DEC-425）：
 * ① 模块改名保留身份——结构保存的输入可带上一版本（当前版本）的模块 ID：带了就是同一模块，只改名不丢权限行（权重 / 必填 / 访问档）、
 *    规则与模块等级快照；新版本的模块记录 previousModuleId（旧模块 ID → 新模块 ID 的映射，读详情 / 历史版本可查）。不带 ID 的同名模块是
 *    新模块（不继承权限行与快照）；带不存在 / 不属于上一版本 / 重复的 ID 一律 400；
 * ② 停用引用的“原样保留”按模块判断（与 #229 流程节点 × 角色同口径）——只有原模块继续持有的停用评价规则 / 模块等级 / 字段 / 人才标准可以
 *    保留；挪到新模块或其他模块算新引用，必须启用，否则 400 *_DISABLED。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { indicatorModule, reasonOf, templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';

const testDb = useTestDb();

async function fixture(label: string) {
  const w = await templateWorld(testDb().db, label);
  const flow = await w.threeStepFlow();
  return { w, ...flow };
}
type World = Awaited<ReturnType<typeof fixture>>['w'];
const previousOf = (view: TemplateView, name: string) =>
  (view.modules.find((m) => m.name === name) as { previousModuleId?: string | null } | undefined)?.previousModuleId;

describe('AC-TR-04-template DEC-425① 模块改名保留身份', () => {
  it('带上一版本模块 ID 改名：权限行（权重 / 必填）与规则快照保留，previousModuleId 记映射；历史版本可查', async () => {
    const { w, flow } = await fixture('tpl-id-rename');
    const rule = await w.scoreRule({ minScore: 1, maxScore: 5 });
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [indicatorModule(rule.id, { name: '业绩' })],
        permissions: [{ nodeKey: 'self', moduleName: '业绩', weight: 100, scoreRequired: true }],
      }),
    );
    expect(previousOf(t, '业绩')).toBeNull();
    const old = t.modules[0]!;
    // 规则之后改了上下限：只改名的新版本仍沿用原模块的快照
    const ruleRead = (await (await w.trRequest('GET', `/score-rules/${rule.id}`)).json()) as { revision: number };
    await w.trRequest('PATCH', `/score-rules/${rule.id}`, { ifMatch: ruleRead.revision, body: { maxScore: 10 } });
    const response = await w.patch(t, {
      modules: [{ id: old.id, ...indicatorModule(rule.id, { name: '绩效' }) }],
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const v2 = (await response.json()) as TemplateView;
    const renamed = v2.modules[0]!;
    expect(renamed).toMatchObject({ name: '绩效', ruleSnapshot: { min: 1, max: 5 } });
    expect(renamed.id).not.toBe(old.id);
    expect(previousOf(v2, '绩效')).toBe(old.id);
    expect(v2.permissions.find((p) => p.nodeKey === 'self')).toMatchObject({
      moduleName: '绩效',
      weight: 100,
      scoreRequired: true,
    });
    expect(v2.configErrors).toEqual([]);
    // 映射随历史版本读回；旧版本不变
    expect(previousOf((await w.read(t.id, '?version=2')).body, '绩效')).toBe(old.id);
    expect((await w.read(t.id, '?version=1')).body.modules[0]).toMatchObject({ id: old.id, name: '业绩' });
    // 只改权限（模块沿用）：身份链继续，previousModuleId 指向上一版本的模块
    const v3 = (await (await w.patch(v2, { permissions: v2.permissions })).json()) as TemplateView;
    expect(previousOf(v3, '绩效')).toBe(renamed.id);
  });

  it('不带 ID 的同名模块是新模块：不继承权限行与快照，previousModuleId 为空', async () => {
    const { w, flow } = await fixture('tpl-id-new');
    const rule = await w.scoreRule({ minScore: 1, maxScore: 5 });
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [indicatorModule(rule.id, { name: '业绩' })],
        permissions: [{ nodeKey: 'self', moduleName: '业绩', weight: 100 }],
      }),
    );
    const ruleRead = (await (await w.trRequest('GET', `/score-rules/${rule.id}`)).json()) as { revision: number };
    await w.trRequest('PATCH', `/score-rules/${rule.id}`, { ifMatch: ruleRead.revision, body: { maxScore: 10 } });
    const v2 = (await (
      await w.patch(t, { modules: [indicatorModule(rule.id, { name: '业绩' })] })
    ).json()) as TemplateView;
    expect(previousOf(v2, '业绩')).toBeNull();
    expect(v2.modules[0]).toMatchObject({ ruleSnapshot: { min: 1, max: 10 } });
    expect(v2.permissions.find((p) => p.nodeKey === 'self')).toMatchObject({ weight: null });
  });

  it('带不存在 / 不属于上一版本 / 其他模板 / 重复的模块 ID，或新建时带 ID → 400，数据不变', async () => {
    const { w, flow } = await fixture('tpl-id-invalid');
    const rule = await w.scoreRule();
    const t = await w.template(
      templateBody(w.orgId, { flowId: flow.id, modules: [indicatorModule(rule.id, { name: '业绩' })] }),
    );
    const v1Id = t.modules[0]!.id;
    const v2 = (await (
      await w.patch(t, { modules: [{ id: v1Id, ...indicatorModule(rule.id, { name: '业绩' }) }] })
    ).json()) as TemplateView;
    const other = await w.template(
      templateBody(w.orgId, { flowId: flow.id, modules: [indicatorModule(rule.id, { name: '业绩' })] }),
    );
    const bad = async (world: World, view: TemplateView, id: string, ids?: string[]) => {
      const modules = (ids ?? [id]).map((one, index) => ({
        id: one,
        ...indicatorModule(rule.id, { name: `模块${index}` }),
      }));
      const response = await world.patch(view, { modules });
      expect([response.status, await reasonOf(response)], id).toEqual([
        400,
        ids ? 'MODULE_ID_DUPLICATE' : 'MODULE_ID_UNKNOWN',
      ]);
    };
    await bad(w, v2, '00000000-0000-4000-8000-0000000000bb');
    await bad(w, v2, v1Id); // 上一版本是 v2，v1 的模块 ID 不属于它
    await bad(w, v2, other.modules[0]!.id); // 其他模板的模块
    await bad(w, v2, v2.modules[0]!.id, [v2.modules[0]!.id, v2.modules[0]!.id]);
    const create = await w.trRequest('POST', '/templates', {
      ifMatch: 0,
      body: templateBody(w.orgId, { modules: [{ id: v1Id, ...indicatorModule(rule.id, { name: '甲' }) }] }),
    });
    expect([create.status, await reasonOf(create)]).toEqual([400, 'MODULE_ID_UNKNOWN']);
    expect((await w.read(t.id)).body).toEqual(v2);
  });
});

describe('AC-TR-04-template DEC-425② 停用引用的原样保留按模块判断', () => {
  const disable = async (w: World, path: string) => {
    const read = (await (await w.trRequest('GET', path)).json()) as { revision: number };
    const response = await w.trRequest('PATCH', path, { ifMatch: read.revision, body: { enabled: false } });
    expect(response.status, await response.clone().text()).toBe(200);
  };

  it('评价规则 / 模块等级：原模块继续持有可保存（含改名）；挪到另一模块或不带 ID 的新模块 → 400 *_DISABLED', async () => {
    const { w, flow } = await fixture('tpl-held-rule');
    const ruleA = await w.scoreRule();
    const ruleB = await w.scoreRule();
    const grade = await w.moduleGrade();
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [
          indicatorModule(ruleA.id, { name: '甲', moduleGradeId: grade.id }),
          indicatorModule(ruleB.id, { name: '乙' }),
        ],
      }),
    );
    await disable(w, `/score-rules/${ruleA.id}`);
    await disable(w, `/module-grades/${grade.id}`);
    const [jia, yi] = t.modules;
    const keep = { id: jia!.id, ...indicatorModule(ruleA.id, { name: '甲改', moduleGradeId: grade.id }) };
    const other = { id: yi!.id, ...indicatorModule(ruleB.id, { name: '乙' }) };
    const kept = await w.patch(t, { modules: [keep, other] });
    expect(kept.status, await kept.clone().text()).toBe(200);
    const current = (await kept.json()) as TemplateView;
    const [curJia, curYi] = current.modules;
    const keepNow = { id: curJia!.id, ...indicatorModule(ruleA.id, { name: '甲改', moduleGradeId: grade.id }) };
    const cases: [string, Record<string, unknown>[]][] = [
      ['MODULE_RULE_DISABLED', [keepNow, { id: curYi!.id, ...indicatorModule(ruleA.id, { name: '乙' }) }]],
      ['MODULE_RULE_DISABLED', [keepNow, indicatorModule(ruleA.id, { name: '丙' })]],
      [
        'MODULE_GRADE_DISABLED',
        [keepNow, { id: curYi!.id, ...indicatorModule(ruleB.id, { name: '乙', moduleGradeId: grade.id }) }],
      ],
    ];
    for (const [reason, modules] of cases) {
      const response = await w.patch(current, { modules });
      expect([response.status, await reasonOf(response)], reason).toEqual([400, reason]);
    }
    expect((await w.read(t.id)).body).toEqual(current);
  });

  it('盘点字段：原信息模块继续持有可保存；挪到另一信息模块 → 400 MODULE_FIELD_DISABLED', async () => {
    const { w, flow } = await fixture('tpl-held-field');
    const field = await w.field();
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [
          { kind: 'info', name: '信息甲', fieldIds: [field.id] },
          { kind: 'info', name: '信息乙', fieldIds: [] },
        ],
      }),
    );
    await disable(w, `/fields/${field.id}`);
    const [jia, yi] = t.modules;
    const keep = { id: jia!.id, kind: 'info', name: '信息甲改', fieldIds: [field.id] };
    const kept = await w.patch(t, { modules: [keep, { id: yi!.id, kind: 'info', name: '信息乙', fieldIds: [] }] });
    expect(kept.status, await kept.clone().text()).toBe(200);
    const current = (await kept.json()) as TemplateView;
    const [curJia, curYi] = current.modules;
    const moved = await w.patch(current, {
      modules: [
        { id: curJia!.id, kind: 'info', name: '信息甲改', fieldIds: [] },
        { id: curYi!.id, kind: 'info', name: '信息乙', fieldIds: [field.id] },
      ],
    });
    expect([moved.status, await reasonOf(moved)]).toEqual([400, 'MODULE_FIELD_DISABLED']);
    expect((await w.read(t.id)).body).toEqual(current);
  });

  it('人才标准：原模块继续持有停用的标准可保存；换到另一模块或不带 ID 的新模块 → 400 CRITERION_NOT_REFERENCEABLE', async () => {
    const { w, flow } = await fixture('tpl-held-criterion');
    const rule = await w.scoreRule();
    const library = await w.library('ability');
    const dimension = await w.dimension(library.id);
    const category = await w.category();
    const criterion = await w.criterion(category.id, [{ dimensionId: dimension.id, displayOrder: 1 }]);
    const standard = (name: string, extra: Record<string, unknown> = {}) =>
      indicatorModule(rule.id, {
        name,
        source: 'talent_standard',
        criterionMode: 'designated',
        criterionId: criterion.id,
        dimensionTypes: ['ability'],
        ...extra,
      });
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [standard('能力'), indicatorModule(rule.id, { name: '业绩' })],
      }),
    );
    const stopped = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: criterion.revision,
      body: { enabled: false },
    });
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    const [ability, performance] = t.modules;
    const kept = await w.patch(t, {
      modules: [
        standard('能力改', { id: ability!.id }),
        { id: performance!.id, ...indicatorModule(rule.id, { name: '业绩' }) },
      ],
    });
    expect(kept.status, await kept.clone().text()).toBe(200);
    const current = (await kept.json()) as TemplateView;
    const [curAbility, curPerformance] = current.modules;
    for (const modules of [
      [standard('能力改', { id: curAbility!.id }), standard('业绩', { id: curPerformance!.id })],
      [standard('能力改', { id: curAbility!.id }), standard('新增')],
    ]) {
      const response = await w.patch(current, { modules });
      expect([response.status, await reasonOf(response)]).toEqual([400, 'CRITERION_NOT_REFERENCEABLE']);
    }
    expect((await w.read(t.id)).body).toEqual(current);
  });
});
