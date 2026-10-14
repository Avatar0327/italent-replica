/** R3-T04 B6b：复制默认值与历史表单引用保护；先在 B6a / B6a-2 旧实现上确认失败。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { formBody, flowBody, nodeBody } from './AC-TR-form-flow-support.js';
import { registerConfigReferenceGuard } from '../../apps/api/src/modules/talent-review/config-kit.js';
import { auditApi } from './AC-AUD-support.js';
import { TR_NOW } from './AC-TR-template-support.js';
import { indicatorModule, templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';

const testDb = useTestDb();

// DEC-436：真实对象 → 模板引用归 PR-C，本文件的模板引用挂点仅按契约验证。
describe('AC-TR-template-copy：复制与引用保护', () => {
  it('复制模块、字段及结果规则，清空流程与表单，复制件停用且版本从 1 开始', async () => {
    const w = await templateWorld(testDb().db, 'b6b-copy');
    const { flow } = await w.threeStepFlow();
    const rule = await w.scoreRule();
    const field = await w.field({ kind: 'number' });
    const form = await w.created<{ id: string }>('/forms', formBody([]));
    const source = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        enabled: true,
        modules: [indicatorModule(rule.id, { name: '业绩' }), { kind: 'info', name: '盘点信息', fieldIds: [field.id] }],
        steps: [{ nodeKey: 'self', showMatrix: true }],
        permissions: [{ nodeKey: 'self', moduleName: '业绩', weight: 100, scoreRequired: true }],
        stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }],
        resultRules: [{ targetFieldId: field.id, formula: '模块.业绩.得分', priority: 0 }],
      }),
    );
    const response = await w.trRequest('POST', `/templates/${source.id}/copy`, {
      ifMatch: source.revision,
      body: { name: '复制件' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const copy = (await response.json()) as TemplateView;
    expect(copy).toMatchObject({
      name: '复制件',
      flowId: null,
      enabled: false,
      currentVersionNo: 1,
      versionNo: 1,
      revision: 1,
      steps: [],
      permissions: [],
      stepForms: [],
      resultRules: [{ targetFieldId: field.id, formula: '模块.业绩.得分', priority: 0 }],
    });
    expect(copy.id).not.toBe(source.id);
    expect(copy.versions).toHaveLength(1);
    expect(copy.modules.map(({ id: _id, ...module }) => module)).toEqual(
      source.modules.map(({ id: _id, ...module }) => module),
    );
    for (const module of copy.modules) expect(source.modules.map((m) => m.id)).not.toContain(module.id);
    expect((await w.read(source.id)).body).toEqual(source);
  });

  it.each([false, true])('表单被模板引用时返回可读 409，含仅历史版本引用（历史=%s）', async (historical) => {
    const w = await templateWorld(testDb().db, `b6b-form-${historical}`);
    const { flow } = await w.threeStepFlow();
    const form = await w.created<{ id: string }>('/forms', formBody([]));
    const source = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }],
      }),
    );
    if (historical) expect((await w.patch(source, { stepForms: [] })).status).toBe(200);
    const before = (await w.read(source.id)).body;
    const formBefore = await (await w.trRequest('GET', `/forms/${form.id}`)).json();
    const response = await w.trRequest('DELETE', `/forms/${form.id}`, { ifMatch: 1 });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'FORM_IN_USE' } } });
    expect((await w.read(source.id)).body).toEqual(before);
    expect(await (await w.trRequest('GET', `/forms/${form.id}`)).json()).toEqual(formBefore);
  });
});

describe('AC-TR-template-copy：独立版本与生命周期', () => {
  it('逐项复制冻结快照与绑定；两边连续改名独立，原件删除后复制件仍可编辑，重选流程恢复默认', async () => {
    const w = await templateWorld(testDb().db, 'b6b-independent');
    const { flow } = await w.threeStepFlow();
    const rule = await w.gradeRule();
    const grade = await w.moduleGrade();
    const field = await w.field({ name: '来源', kind: 'number' });
    const target = await w.field({ kind: 'number' });
    const module = indicatorModule(rule.id, { name: '业绩', moduleGradeId: grade.id });
    const initial = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        enabled: true,
        downwardPublic: true,
        modules: [
          module,
          { kind: 'info', name: '信息', fieldIds: [field.id] },
          { kind: 'succession', name: '继任', allowOrg: true, allowPosition: false, allowTarget: true },
        ],
        permissions: [{ nodeKey: 'self', moduleName: '继任', successorAccess: 'edit', targetAccess: 'view' }],
        steps: [{ nodeKey: 'self', showMatrix: true }],
        resultRules: [
          {
            targetFieldId: target.id,
            formula: 'IF(模块.业绩.等级 = "高", 盘点对象.来源, 0)',
            formulaBindings: [field.id],
            priority: 7,
          },
        ],
      }),
    );
    const changed = await w.patch(initial, { permissions: [] });
    expect(changed.status).toBe(200);
    const source = (await changed.json()) as TemplateView;
    // 来源配置修改不能让复制件重新快照实时值。
    expect(
      (
        await w.trRequest('PATCH', `/score-rules/${rule.id}`, {
          ifMatch: 1,
          body: { levels: [{ name: '新等级', value: 9 }] },
        })
      ).status,
    ).toBe(200);
    const copyRequest = () =>
      w.trRequest('POST', `/templates/${source.id}/copy`, {
        ifMatch: source.revision,
        idempotencyKey: 'b6b-independent',
        body: { name: '独立复制件' },
      });
    const response = await copyRequest();
    expect(response.status, await response.clone().text()).toBe(201);
    const copy = (await response.json()) as TemplateView;
    expect(await (await copyRequest()).json()).toEqual(copy);
    expect(copy).toMatchObject({
      ownerOrgId: source.ownerOrgId,
      downwardPublic: true,
      enabled: false,
      currentVersionNo: 1,
      versionNo: 1,
      revision: 1,
      flowId: null,
      stepForms: [],
      steps: [],
      permissions: [],
    });
    expect(copy.resultRules).toEqual(source.resultRules);
    expect(copy.modules.map(({ id: _id, previousModuleId: _old, ...rest }) => rest)).toEqual(
      source.modules.map(({ id: _id, previousModuleId: _old, ...rest }) => rest),
    );
    expect(copy.modules.every((m) => m.previousModuleId === null)).toBe(true);
    expect((await w.patch(copy, { enabled: true })).status).toBe(400);
    expect((await w.read(copy.id)).body).toEqual(copy);
    const rename = async (t: TemplateView, name: string) => {
      const response = await w.patch(t, {
        modules: [
          { ...module, id: t.modules[0]!.id, name },
          { kind: 'info', id: t.modules[1]!.id, name: '信息', fieldIds: [field.id] },
          {
            kind: 'succession',
            id: t.modules[2]!.id,
            name: '继任',
            allowOrg: true,
            allowPosition: false,
            allowTarget: true,
          },
        ],
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as TemplateView;
    };
    const originalEdit = await rename(source, '原件新名');
    const copyEdit = await rename(copy, '复制新名');
    expect(copyEdit.resultRules).toMatchObject([
      { formula: 'IF(模块.复制新名.等级 = "高", 盘点对象.来源, 0)', formulaBindings: [field.id] },
    ]);
    expect((await w.read(source.id)).body).toEqual(originalEdit);
    expect((await w.read(copy.id, '?version=1')).body.modules).toEqual(copy.modules);
    expect((await w.trRequest('DELETE', `/templates/${source.id}`, { ifMatch: originalEdit.revision })).status).toBe(
      200,
    );
    const copyAgain = await rename(copyEdit, '复制再改名');
    const enabled = await w.patch(copyAgain, { flowId: flow.id, enabled: true });
    expect(enabled.status).toBe(200);
    const ready = (await enabled.json()) as TemplateView;
    expect(ready.steps.every((s) => s.showMatrix === false)).toBe(true);
    expect(
      ready.permissions
        .filter((p) => p.moduleName !== '继任')
        .every(
          (p) =>
            p.visible &&
            p.scoreEnabled &&
            p.commentEnabled &&
            !p.scoreRequired &&
            !p.commentRequired &&
            p.weight === null,
        ),
    ).toBe(true);
    expect(ready.permissions.filter((p) => p.moduleName === '继任')).toEqual(
      expect.arrayContaining([expect.objectContaining({ successorAccess: 'hidden', targetAccess: 'hidden' })]),
    );
    expect(
      ready.permissions
        .filter((p) => p.moduleName === '继任')
        .every((p) => p.successorAccess === 'hidden' && p.targetAccess === 'hidden'),
    ).toBe(true);
    const disabled = await w.patch(ready, { enabled: false });
    expect(disabled.status).toBe(200);
    const off = (await disabled.json()) as TemplateView;
    expect(off.currentVersionNo).toBe(ready.currentVersionNo);
    expect(off.enabled).toBe(false);
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const entries = await audit.dataChanges(w.as, { objectType: 'TalentReview.Template', limit: '50' });
    const deletion = entries.items.find((e) => e.objectId === source.id && e.operation === 'delete')!;
    expect((await audit.dataChange(w.as, deletion.id)).snapshot).toMatchObject({ name: source.name });
  });

  it('DEC-436：模板引用扩展点返回 TEMPLATE_IN_USE；解除替身后可删（不是实际项目 / 对象覆盖）', async () => {
    const w = await templateWorld(testDb().db, 'b6b-contract');
    const t = await w.template(templateBody(w.orgId));
    let referenced = true;
    registerConfigReferenceGuard('template', async (_tx, tenantId, id) =>
      referenced && tenantId === w.as.tenant && id === t.id ? 'CONTRACT_FIXTURE' : null,
    );
    const denied = await w.trRequest('DELETE', `/templates/${t.id}`, { ifMatch: t.revision });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { details: { reason: 'TEMPLATE_IN_USE' } } });
    expect((await w.read(t.id)).body).toEqual(t);
    referenced = false;
    expect((await w.trRequest('DELETE', `/templates/${t.id}`, { ifMatch: t.revision })).status).toBe(200);
    expect((await w.read(t.id)).status).toBe(404);
  });

  it.each([false, true])('全部模板配置引用拒删，历史=%s；删模板后配置可删', async (historical) => {
    const w = await templateWorld(testDb().db, `b6b-refs-${historical}`);
    const { flow, roles } = await w.threeStepFlow();
    const rule = await w.scoreRule();
    const grade = await w.moduleGrade();
    const field = await w.field();
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [
          indicatorModule(rule.id, { moduleGradeId: grade.id }),
          { kind: 'info', name: '信息', fieldIds: [field.id] },
        ],
      }),
    );
    // 从流程移走旧角色，证明拒删来自模板冻结角色，而非流程定义。
    const replacement = await w.role();
    expect(
      (
        await w.trRequest('PATCH', `/flows/${flow.id}`, {
          ifMatch: 1,
          body: flowBody([nodeBody([replacement.id], { nodeKey: 'replacement' })]),
        })
      ).status,
    ).toBe(200);
    if (historical) expect((await w.patch(t, { flowId: null, modules: [] })).status).toBe(200);
    const before = (await w.read(t.id)).body;
    const cases = [
      ['score-rules', rule.id, 1, 'SCORE_RULE_IN_USE'],
      ['module-grades', grade.id, 1, 'MODULE_GRADE_IN_USE'],
      ['fields', field.id, 1, 'FIELD_IN_USE'],
      ['roles', roles.self.id, 1, 'ROLE_IN_USE'],
      ['flows', flow.id, 2, 'FLOW_IN_USE'],
    ] as const;
    for (const [path, id, revision, reason] of cases) {
      const url = `/${path}/${id}`;
      const config = await (await w.trRequest('GET', url)).json();
      const response = await w.trRequest('DELETE', url, { ifMatch: revision });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({ error: { details: { reason } } });
      expect(await (await w.trRequest('GET', url)).json()).toEqual(config);
      expect((await w.read(t.id)).body).toEqual(before);
    }
    expect((await w.trRequest('DELETE', `/templates/${t.id}`, { ifMatch: before.revision })).status).toBe(200);
    for (const [path, id, revision] of cases)
      expect((await w.trRequest('DELETE', `/${path}/${id}`, { ifMatch: revision })).status).toBe(200);
  });
});

describe('AC-TR-template-copy：命令与新增引用边界', () => {
  it('旧 revision / 重名 / 同键异内容冲突；停用来源不可借复制新增引用', async () => {
    const w = await templateWorld(testDb().db, 'b6b-boundary');
    const rule = await w.scoreRule();
    const t = await w.template(templateBody(w.orgId, { modules: [indicatorModule(rule.id)] }));
    const copy = (name: string, revision = 1, key?: string) =>
      w.trRequest('POST', `/templates/${t.id}/copy`, {
        ifMatch: revision,
        ...(key ? { idempotencyKey: key } : {}),
        body: { name },
      });
    const before = (await w.read(t.id)).body;
    expect((await copy('过期', 0)).status).toBe(409);
    expect((await copy(t.name)).status).toBe(409);
    expect((await copy('首次', 1, 'copy-boundary')).status).toBe(201);
    expect((await copy('不同内容', 1, 'copy-boundary')).status).toBe(409);
    expect(
      (await w.trRequest('PATCH', `/score-rules/${rule.id}`, { ifMatch: 1, body: { enabled: false } })).status,
    ).toBe(200);
    const stopped = await copy('停用引用');
    expect(stopped.status, await stopped.clone().text()).toBe(400);
    expect(await stopped.json()).toMatchObject({ error: { details: { reason: 'MODULE_RULE_DISABLED' } } });
    expect((await w.read(t.id)).body).toEqual(before);
  });
});
