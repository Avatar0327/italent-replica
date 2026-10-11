/** #245 P2-R2-01：三个真实请求构造表单 → 字段 → 目录版本的交错，保留冻结快照。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { FORM } from '../../apps/api/src/modules/talent-review/form-service.js';
import * as versions from '../../apps/api/src/modules/talent-review/field-catalog.js';
import { formBody } from './AC-TR-form-flow-support.js';
import { indicatorModule, templateBody, templateWorld } from './AC-TR-template-support.js';
import { calcBody, calcItem } from './AC-TR-calc-rule-support.js';
import { settledOrBlocked, waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** 只暂停真实业务的取锁边界；读写、目录推进、审计和命令台账仍由 HTTP 入口完成。 */
function pauseForm() {
  const entered = barrier();
  const resume = barrier();
  const load = FORM.load!;
  const spy = vi.spyOn(FORM, 'load').mockImplementationOnce(async (...args) => {
    const row = await load(...args);
    entered.resolve();
    await resume.promise;
    return row;
  });
  return { entered, resume, spy };
}

function pauseRename() {
  const entered = barrier();
  const resume = barrier();
  const lock = versions.lockFieldCatalog;
  const spy = vi.spyOn(versions, 'lockFieldCatalog').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await resume.promise;
    return lock(...args);
  });
  return { entered, resume, spy };
}

async function expectOk(request: Promise<Response> | Response, status = 200) {
  const response = await request;
  expect(response.status, await response.clone().text()).toBe(status);
  return response;
}

const purposes = ['info', 'calibrate_edit', 'successor_edit', 'target_edit'] as const;
const operations = ['permissions', 'steps', 'modules', 'flow'] as const;
const cases = purposes.flatMap((purpose) =>
  operations.flatMap((operation) =>
    ['沿用表单', '显式表单'].flatMap((forms) =>
      ['沿用结果', '显式结果'].map((results) => ({ purpose, operation, forms, results })),
    ),
  ),
);

async function formFixture(label: string, purpose: (typeof purposes)[number]) {
  const w = await templateWorld(testDb().db, label);
  const field = await w.field({ name: '冻结字段', kind: 'number' });
  const x = await w.field({ name: '新增字段', kind: 'number' });
  const target = await w.field({ kind: 'number' });
  const { flow } = await w.threeStepFlow();
  const nextFlow = await w.threeStepFlow();
  const rule = await w.scoreRule();
  const kind = {
    info: 'info',
    calibrate_edit: 'calibrate_edit',
    successor_edit: 'succession_edit',
    target_edit: 'succession_edit',
  }[purpose];
  const form = await w.created<{ id: string }>('/forms', formBody([{ fieldId: field.id }], { kind }));
  const nodeKey = purpose === 'calibrate_edit' ? 'calibrate' : 'self';
  const stepForms = [{ nodeKey, purpose, formId: form.id }];
  const resultRules = [{ targetFieldId: target.id, formula: '1', priority: 0 }];
  const t = await w.template(
    templateBody(w.orgId, {
      flowId: flow.id,
      modules: [indicatorModule(rule.id, { name: '指标' })],
      stepForms,
      resultRules,
    }),
  );
  const patches = {
    permissions: { permissions: [{ nodeKey: 'self', moduleName: '指标', weight: 100 }] },
    steps: { steps: [{ nodeKey: 'self', showMatrix: true }] },
    modules: { modules: [indicatorModule(rule.id, { id: t.modules[0]!.id, name: '新指标' })] },
    flow: { flowId: nextFlow.flow.id },
  };
  return { w, field, x, form, t, patches, stepForms, resultRules };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TR-04 第 3 轮全局锁序', () => {
  it.each(cases)('三方 $purpose / $operation / $forms / $results：三个请求成功，冻结快照不变', async (scenario) => {
    const { w, field, x, form, t, patches, stepForms, resultRules } = await formFixture(
      `r3-three-${scenario.purpose}`,
      scenario.purpose,
    );
    const b = pauseForm();
    const edit = w.trRequest('PATCH', `/forms/${form.id}`, {
      ifMatch: 1,
      body: {
        fields: [
          { fieldId: field.id, access: 'view' },
          { fieldId: x.id, access: 'edit' },
        ],
      },
    });
    await b.entered.promise;
    const c = pauseRename();
    const rename = w.trRequest('PATCH', `/fields/${x.id}`, { ifMatch: 1, body: { name: '新增字段改名' } });
    let save: Promise<Response> | undefined;
    try {
      await c.entered.promise;
      save = w.patch(t, {
        ...patches[scenario.operation],
        ...(scenario.forms === '显式表单' ? { stepForms } : {}),
        ...(scenario.results === '显式结果' ? { resultRules } : {}),
      });
      // A 已等待来源表单；B 继续后等待 X。C 在正确锁序下能取得 V 并完成，随后 B、A 依次完成。
      await waitForBlocked(testDb().db, 1);
      b.resume.resolve();
      await waitForBlocked(testDb().db, 2);
      c.resume.resolve();
      await Promise.all([expectOk(save), expectOk(edit), expectOk(rename)]);
    } finally {
      b.resume.resolve();
      c.resume.resolve();
      await Promise.allSettled([edit, rename, ...(save ? [save] : [])]);
      b.spy.mockRestore();
      c.spy.mockRestore();
    }
    const current = (await w.read(t.id)).body;
    expect(current).toMatchObject({ revision: t.revision + 1, versionNo: 2 });
    expect(current.stepForms).toEqual(t.stepForms);
    expect(current.resultRules).toEqual(t.resultRules);
    expect((await w.read(t.id, '?version=1')).body.stepForms).toEqual(t.stepForms);
    expect(await (await w.trRequest('GET', `/forms/${form.id}`)).json()).toMatchObject({
      revision: 2,
      fields: [
        { fieldId: field.id, access: 'view' },
        { fieldId: x.id, access: 'edit' },
      ],
    });
    expect(await (await w.trRequest('GET', `/fields/${x.id}`)).json()).toMatchObject({
      name: '新增字段改名',
      revision: 2,
    });
  });

  it.each(['form', 'module'].flatMap((outlet) => [false, true].map((explicit) => ({ outlet, explicit }))))(
    '第 1 轮 P2-03：$outlet 外键字段 × 真实改名，显式结果=$explicit，无反向等待',
    async ({ outlet, explicit }) => {
      const w = await templateWorld(testDb().db, `r3-field-${outlet}`);
      const x = await w.field({ name: '非公式字段' });
      const target = await w.field({ kind: 'number' });
      const { flow } = await w.threeStepFlow();
      const form = await w.created<{ id: string }>('/forms', formBody([{ fieldId: x.id }]));
      const resultRules = [{ targetFieldId: target.id, formula: '1', priority: 0 }];
      const structure =
        outlet === 'form'
          ? { stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }] }
          : { modules: [{ kind: 'info', name: '信息', fieldIds: [x.id] }] };
      const t = await w.template(templateBody(w.orgId, { flowId: flow.id, ...structure, resultRules }));
      const c = pauseRename();
      const rename = w.trRequest('PATCH', `/fields/${x.id}`, { ifMatch: 1, body: { name: '非公式字段新名' } });
      let save: Promise<Response> | undefined;
      try {
        await c.entered.promise;
        save = w.patch(t, { steps: [{ nodeKey: 'self', showMatrix: true }], ...(explicit ? { resultRules } : {}) });
        await waitForBlocked(testDb().db, 1);
        c.resume.resolve();
        await Promise.all([expectOk(save), expectOk(rename)]);
      } finally {
        c.resume.resolve();
        await Promise.allSettled([rename, ...(save ? [save] : [])]);
        c.spy.mockRestore();
      }
      const current = (await w.read(t.id)).body;
      expect(current.stepForms).toEqual(t.stepForms);
      expect(current.modules[0]?.fieldIds).toEqual(t.modules[0]?.fieldIds);
      expect(current.resultRules).toEqual(t.resultRules);
    },
  );

  it.each(['template', 'form'])('%s × 计算规则：共享同一字段，规则持 F 时另一写入完成', async (writer) => {
    const { w, field, form, t } = await formFixture(`r3-calc-${writer}`, 'info');
    const target = await w.field({ kind: 'number' });
    const entered = barrier();
    const resume = barrier();
    const lock = versions.shareLockFieldCatalog;
    const spy = vi.spyOn(versions, 'shareLockFieldCatalog').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return lock(...args);
    });
    const calc = w.trRequest('POST', '/calc-rules', {
      ifMatch: 0,
      body: calcBody([
        calcItem({ ...target, name: '计算目标' }, '盘点对象.冻结字段 + 1', { formulaBindings: [field.id] }),
      ]),
    });
    let save: Promise<Response> | undefined;
    try {
      await entered.promise;
      save =
        writer === 'template'
          ? w.patch(t, { steps: [{ nodeKey: 'self', showMatrix: true }] })
          : w.trRequest('PATCH', `/forms/${form.id}`, {
              ifMatch: 1,
              body: { fields: [{ fieldId: field.id, access: 'view' }] },
            });
      expect(await settledOrBlocked(testDb().db, save, 1)).toBe('settled');
      await expectOk(save);
      resume.resolve();
      const result = await expectOk(calc, 201);
      expect(await result.json()).toMatchObject({ items: [{ formulaBindings: [field.id] }] });
      expect((await w.read(t.id)).body.stepForms).toEqual(t.stepForms);
    } finally {
      resume.resolve();
      await Promise.allSettled([calc, ...(save ? [save] : [])]);
      spy.mockRestore();
    }
  });

  it.each(['form', 'calc'])('%s × 字段改名：字段独占锁先到，两请求按 F → V 成功', async (writer) => {
    const { w, field, form } = await formFixture(`r3-rename-${writer}`, 'info');
    const c = pauseRename();
    const rename = w.trRequest('PATCH', `/fields/${field.id}`, { ifMatch: 1, body: { name: '冻结字段新名' } });
    let save: Promise<Response> | undefined;
    try {
      await c.entered.promise;
      save =
        writer === 'form'
          ? w.trRequest('PATCH', `/forms/${form.id}`, {
              ifMatch: 1,
              body: { fields: [{ fieldId: field.id, access: 'view' }] },
            })
          : w.trRequest('POST', '/calc-rules', {
              ifMatch: 0,
              body: calcBody([calcItem({ ...field, name: '冻结字段' }, '1')]),
            });
      await waitForBlocked(testDb().db, 1);
      c.resume.resolve();
      await Promise.all([expectOk(rename), expectOk(save, writer === 'form' ? 200 : 201)]);
      expect(await (await w.trRequest('GET', `/fields/${field.id}`)).json()).toMatchObject({
        name: '冻结字段新名',
        revision: 2,
      });
    } finally {
      c.resume.resolve();
      await Promise.allSettled([rename, ...(save ? [save] : [])]);
      c.spy.mockRestore();
    }
  });
});
