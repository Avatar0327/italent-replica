/**
 * R3-T04 PR-B6a 第 1 轮审查修复（PR #244；AC-TR-04-template / AC-TR-15-freeze 的延伸）：
 * - P2-01 换流程后旧版本仍引用旧流程：流程删除守卫覆盖所有版本（含清空流程后的旧版本），库里版本表另有 (tenant_id, flow_id) 复合外键
 *   ON DELETE RESTRICT 兜底；
 * - P2-02 改模块类型后不留不适用的设置：指标 ↔ 继任改类型时清理旧席位设置，最终结构整体校验；继任模块显式提交
 *   scoreRequired / commentRequired 为 true 一律 400；已存下的结构原样再保存必须成功；
 * - P3 信息 / 继任模块携带人才标准设置、指标 / 信息模块携带继任开关，统一 400 MODULE_KIND_MISMATCH，不静默丢弃。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  indicatorModule,
  reasonOf,
  templateBody,
  templateWorld,
  TEMPLATES,
  type TemplateView,
} from './AC-TR-template-support.js';

const testDb = useTestDb();

async function fixture(label: string) {
  const w = await templateWorld(testDb().db, label);
  const flow = await w.threeStepFlow();
  const rule = await w.scoreRule();
  return { w, ...flow, rule };
}
type World = Awaited<ReturnType<typeof fixture>>['w'];

const deleteConfig = async (w: World, path: string) => {
  const read = (await (await w.trRequest('GET', path)).json()) as { revision: number };
  const response = await w.trRequest('DELETE', path, { ifMatch: read.revision });
  return [response.status, response.status === 409 ? await reasonOf(response) : null] as const;
};

describe('AC-TR-04-template P2-01 旧版本引用的流程不能删', () => {
  it('版本 1 用流程 A、版本 2 换成流程 B：删 A 409 FLOW_IN_USE；清空流程后 A、B 仍都不能删；删模板后才能删', async () => {
    const { w, flow } = await fixture('tpl-r2-flow');
    const other = await w.threeStepFlow();
    const t = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    const v2 = (await (await w.patch(t, { flowId: other.flow.id })).json()) as TemplateView;
    expect(v2).toMatchObject({ flowId: other.flow.id, currentVersionNo: 2 });
    expect(await deleteConfig(w, `/flows/${flow.id}`)).toEqual([409, 'FLOW_IN_USE']);
    expect(await deleteConfig(w, `/flows/${other.flow.id}`)).toEqual([409, 'FLOW_IN_USE']);
    // 停用状态下清空流程：头部不再引用，但版本 1 / 2 仍引用
    const cleared = (await (await w.patch(v2, { flowId: null })).json()) as TemplateView;
    expect(cleared).toMatchObject({ flowId: null, currentVersionNo: 3, steps: [] });
    expect(await deleteConfig(w, `/flows/${flow.id}`)).toEqual([409, 'FLOW_IN_USE']);
    expect(await deleteConfig(w, `/flows/${other.flow.id}`)).toEqual([409, 'FLOW_IN_USE']);
    expect((await w.read(t.id, '?version=1')).body.steps).toHaveLength(3);
    const gone = await w.trRequest('DELETE', `${TEMPLATES}/${t.id}`, { ifMatch: cleared.revision });
    expect(gone.status, await gone.clone().text()).toBe(200);
    expect((await deleteConfig(w, `/flows/${flow.id}`))[0]).toBe(200);
    expect((await deleteConfig(w, `/flows/${other.flow.id}`))[0]).toBe(200);
  });
});

describe('AC-TR-04-template P2-01 同类出口：旧版本引用的规则 / 模块等级 / 字段 / 角色也不能删', () => {
  it('版本 2 去掉模块后，版本 1 引用的评价规则、模块等级、字段仍 409；流程换掉后版本 1 的节点角色仍 409 ROLE_IN_USE', async () => {
    const { w, flow, roles, rule } = await fixture('tpl-r2-refs');
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
    const other = await w.threeStepFlow();
    const v2 = (await (await w.patch(t, { flowId: other.flow.id, modules: [] })).json()) as TemplateView;
    expect(v2).toMatchObject({ currentVersionNo: 2, modules: [] });
    expect(await deleteConfig(w, `/score-rules/${rule.id}`)).toEqual([409, 'SCORE_RULE_IN_USE']);
    expect(await deleteConfig(w, `/module-grades/${grade.id}`)).toEqual([409, 'MODULE_GRADE_IN_USE']);
    expect(await deleteConfig(w, `/fields/${field.id}`)).toEqual([409, 'FIELD_IN_USE']);
    expect(await deleteConfig(w, `/roles/${roles.self.id}`)).toEqual([409, 'ROLE_IN_USE']);
  });
});

const succession = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'succession', name, ...extra });
const permissionsOf = (view: TemplateView, moduleName: string) =>
  view.permissions.filter((row) => row.moduleName === moduleName);

describe('AC-TR-04-template P2-02 改模块类型不留不适用的设置', () => {
  it('指标 → 继任：评分 / 必填 / 权重清掉，继任访问档取缺省；已存下的权限行原样再保存成功', async () => {
    const { w, flow, rule } = await fixture('tpl-r2-to-succession');
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [indicatorModule(rule.id, { name: '业绩' })],
        permissions: [{ nodeKey: 'self', moduleName: '业绩', scoreRequired: true, commentRequired: true, weight: 100 }],
      }),
    );
    expect(permissionsOf(t, '业绩')[0]).toMatchObject({ scoreRequired: true, weight: 100 });
    const response = await w.patch(t, { modules: [succession('业绩')] });
    expect(response.status, await response.clone().text()).toBe(200);
    const changed = (await response.json()) as TemplateView;
    for (const row of permissionsOf(changed, '业绩')) {
      expect(row, row.nodeKey).toMatchObject({
        scoreEnabled: false,
        scoreRequired: false,
        commentEnabled: false,
        commentRequired: false,
        weight: null,
        successorAccess: 'hidden',
        targetAccess: 'hidden',
      });
    }
    expect(changed.configErrors).toEqual([]);
    // 读回的权限行原样再保存：不得被自己的校验拒绝
    const again = await w.patch(changed, { permissions: changed.permissions });
    expect(again.status, await again.clone().text()).toBe(200);
  });

  it('继任 → 指标：继任访问档清掉，指标设置取缺省；已存下的权限行原样再保存成功', async () => {
    const { w, flow, rule } = await fixture('tpl-r2-to-indicator');
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [succession('继任')],
        permissions: [{ nodeKey: 'self', moduleName: '继任', successorAccess: 'edit', targetAccess: 'view' }],
      }),
    );
    const response = await w.patch(t, { modules: [indicatorModule(rule.id, { name: '继任' })] });
    expect(response.status, await response.clone().text()).toBe(200);
    const changed = (await response.json()) as TemplateView;
    for (const row of permissionsOf(changed, '继任')) {
      expect(row, row.nodeKey).toMatchObject({
        visible: true,
        scoreEnabled: true,
        commentEnabled: true,
        weight: null,
        successorAccess: null,
        targetAccess: null,
      });
    }
    const again = await w.patch(changed, { permissions: changed.permissions });
    expect(again.status, await again.clone().text()).toBe(200);
  });

  it('继任模块显式提交 scoreRequired / commentRequired = true → 400 PERMISSION_KIND_MISMATCH，数据不变', async () => {
    const { w, flow } = await fixture('tpl-r2-succession-required');
    const t = await w.template(templateBody(w.orgId, { flowId: flow.id, modules: [succession('继任')] }));
    for (const flag of ['scoreRequired', 'commentRequired']) {
      const response = await w.patch(t, { permissions: [{ nodeKey: 'self', moduleName: '继任', [flag]: true }] });
      expect([response.status, await reasonOf(response)], flag).toEqual([400, 'PERMISSION_KIND_MISMATCH']);
    }
    expect((await w.read(t.id)).body).toEqual(t);
  });
});

describe('AC-TR-04-template P3 模块携带不适用的设置一律拒绝', () => {
  it('信息 / 继任模块带人才标准设置、指标 / 信息模块带继任开关 → 400 MODULE_KIND_MISMATCH，数据不变', async () => {
    const { w, flow, rule } = await fixture('tpl-r2-mismatch');
    const t = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    const cases: Record<string, unknown>[] = [
      { kind: 'info', name: '信息', criterionMode: 'by_job' },
      { kind: 'info', name: '信息', dimensionTypes: ['ability'] },
      succession('继任', { criterionMode: 'designated' }),
      succession('继任', { dimensionTypes: ['potential'] }),
      indicatorModule(rule.id, { name: '业绩', allowOrg: true }),
      { kind: 'info', name: '信息', allowTarget: false },
    ];
    for (const module of cases) {
      const response = await w.patch(t, { modules: [module] });
      expect([response.status, await reasonOf(response)], JSON.stringify(module)).toEqual([
        400,
        'MODULE_KIND_MISMATCH',
      ]);
    }
    expect((await w.read(t.id)).body).toEqual(t);
  });
});
