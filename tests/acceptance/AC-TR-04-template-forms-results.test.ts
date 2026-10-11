/**
 * R3-T04 B6a-2：步骤表单与结果公式的版本入口验收（设计 §2.3、§4.3、§7）。
 * 当前为先行红测；stepForms / resultRules 是沿用模板结构保存入口的拟议载荷，接线范围待总编排确认。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { formBody } from './AC-TR-form-flow-support.js';
import { indicatorModule, templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';

const testDb = useTestDb();

describe('AC-TR-04 / AC-TR-15：模板步骤表单与结果公式', () => {
  it('步骤选用表单生成新版本；源表单变更不改写版本快照，旧版本仍无选用', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-form');
    const { flow } = await w.threeStepFlow();
    const field = await w.field();
    const form = await w.created<{ id: string; revision: number }>(
      '/forms',
      formBody([{ fieldId: field.id, access: 'edit', required: true }]),
    );
    const initial = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    const response = await w.patch(initial, {
      stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }],
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as TemplateView;
    expect(saved.currentVersionNo).toBe(2);
    expect(saved.stepForms).toMatchObject([
      {
        nodeKey: 'self',
        purpose: 'info',
        formId: form.id,
        formSnapshot: [{ fieldId: field.id, access: 'edit', required: true }],
      },
    ]);
    const sourceChanged = await w.trRequest('PATCH', `/forms/${form.id}`, {
      ifMatch: form.revision,
      body: { fields: [{ fieldId: field.id, access: 'view', required: false }] },
    });
    expect(sourceChanged.status, await sourceChanged.clone().text()).toBe(200);
    expect((await w.read(initial.id)).body.stepForms).toEqual(saved.stepForms);
    expect((await w.read(initial.id, '?version=1')).body.stepForms).toEqual([]);
  });

  it('结果公式目标按 ID 保存；模块文本与数字比较编辑期放行（DEC-391 / DEC-416⑥）', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-result');
    const { flow } = await w.threeStepFlow();
    const rule = await w.gradeRule();
    const target = await w.field({ kind: 'number' });
    const initial = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [indicatorModule(rule.id, { name: '业绩' })],
      }),
    );
    const resultRules = [{ targetFieldId: target.id, formula: 'IF(模块.业绩.等级 > 1, 1, 0)', priority: 0 }];
    const response = await w.patch(initial, { resultRules });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as TemplateView;
    expect(saved.currentVersionNo).toBe(2);
    expect(saved.resultRules).toMatchObject(resultRules);
    expect((await w.read(initial.id, '?version=1')).body.resultRules).toEqual([]);
    const removed = await w.trRequest('DELETE', `/fields/${target.id}`, { ifMatch: 1 });
    expect(removed.status, await removed.clone().text()).toBe(409);
    expect((await w.read(initial.id)).body.resultRules).toEqual(saved.resultRules);
  });
});
