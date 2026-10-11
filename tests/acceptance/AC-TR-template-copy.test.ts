/** R3-T04 B6b：复制默认值与历史表单引用保护；先在 B6a / B6a-2 旧实现上确认失败。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { formBody } from './AC-TR-form-flow-support.js';
import { indicatorModule, templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';

const testDb = useTestDb();

// TODO(需取证 #261)：真实项目 / 对象引用及九宫格 / 计算规则的守卫归属，待总编排确认后补对应验收。
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
