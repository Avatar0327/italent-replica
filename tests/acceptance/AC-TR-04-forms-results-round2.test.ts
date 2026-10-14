/** #245 第 2 轮：最终冻结表单统一校验（P2-01 / P2-02，DEC-425）。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowBody, formBody, nodeBody } from './AC-TR-form-flow-support.js';
import { templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';

const testDb = useTestDb();
describe('AC-TR-04 / AC-TR-15：第 2 轮冻结配置', () => {
  it.each([
    ['info', 'info', 'succession_edit'],
    ['calibrate_edit', 'calibrate_edit', 'info'],
    ['successor_edit', 'succession_edit', 'info'],
    ['target_edit', 'succession_edit', 'info'],
  ])('P2-01：%s 原席位重提沿用冻结配置，新席位仍按实时类型校验', async (purpose, kind, changedKind) => {
    const w = await templateWorld(testDb().db, `r2-${purpose}`);
    const { flow, roles } = await w.threeStepFlow();
    const field = await w.field();
    const form = await w.created<{ id: string }>('/forms', formBody([{ fieldId: field.id }], { kind }));
    const selection = { nodeKey: 'calibrate', purpose, formId: form.id };
    const original = await w.template(templateBody(w.orgId, { flowId: flow.id, stepForms: [selection] }));
    const changed = await w.trRequest('PATCH', `/forms/${form.id}`, {
      ifMatch: 1,
      body: { kind: changedKind, fields: [] },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    let current = original;
    for (const patch of [{ permissions: [] }, { stepForms: [selection] }]) {
      const saved = await w.patch(current, patch);
      expect(saved.status, await saved.clone().text()).toBe(200);
      current = (await saved.json()) as TemplateView;
      expect(current.stepForms).toEqual(original.stepForms);
    }
    const newFlow = await w.created<{ id: string }>(
      '/flows',
      flowBody([nodeBody([roles.self.id], { nodeKey: 'new', stepType: 'calibrate', mode: 'batch' })]),
    );
    const rejected = await w.patch(current, {
      flowId: newFlow.id,
      stepForms: [{ ...selection, nodeKey: 'new' }],
    });
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { details: { reason: 'STEP_FORM_KIND_MISMATCH' } } });
    expect((await w.read(current.id)).body).toEqual(current);
    expect((await w.read(current.id, '?version=1')).body.stepForms).toEqual(original.stepForms);
  });

  it('P2-02：同 key 校准改评价仅清理不适用用途，旧版保留，新版可原样重提', async () => {
    const w = await templateWorld(testDb().db, 'r2-flow-purpose');
    const { flow, roles } = await w.threeStepFlow();
    const info = await w.created<{ id: string }>('/forms', formBody([]));
    const edit = await w.created<{ id: string }>('/forms', formBody([], { kind: 'calibrate_edit' }));
    const kept = { nodeKey: 'calibrate', purpose: 'info', formId: info.id };
    const removed = { nodeKey: 'calibrate', purpose: 'calibrate_edit', formId: edit.id };
    const t = await w.template(templateBody(w.orgId, { flowId: flow.id, stepForms: [kept, removed] }));
    const replacement = await w.created<{ id: string }>(
      '/flows',
      flowBody([nodeBody([roles.calibrator.id], { nodeKey: 'calibrate' })]),
    );
    const invalid = await w.patch(t, { flowId: replacement.id, stepForms: [kept, removed] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { details: { reason: 'STEP_FORM_PURPOSE_INVALID' } } });
    expect((await w.read(t.id)).body).toEqual(t);
    const saved = await w.patch(t, { flowId: replacement.id });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const current = (await saved.json()) as TemplateView;
    expect(current.stepForms).toEqual([{ ...kept, roleId: null, formSnapshot: [] }]);
    expect((await w.read(t.id, '?version=1')).body.stepForms).toEqual(t.stepForms);
    const resubmit = await w.patch(current, { stepForms: [kept] });
    expect(resubmit.status, await resubmit.clone().text()).toBe(200);
    expect(((await resubmit.json()) as TemplateView).stepForms).toEqual(current.stepForms);
  });
});
