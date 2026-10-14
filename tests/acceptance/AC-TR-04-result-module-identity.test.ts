/** DEC-425：结果绑定随模块身份逐版本迁移；停用引用只由原席位 / 原结果项继续持有。 */
import { describe, expect, it } from 'vitest';
import {
  and,
  eq,
  withTenant,
  talentReviewTemplateResultModuleRefs as MR,
  talentReviewTemplateResultRules as R,
  talentReviewTemplateVersions as V,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { evaluateFormula, inMemorySubject } from '@italent/domain';
import { indicatorModule, templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';
import { formBody } from './AC-TR-form-flow-support.js';

const testDb = useTestDb();
const rulesOf = (t: TemplateView) => t.resultRules as { targetFieldId: string; formula: string; priority: number }[];

describe('AC-TR-04：结果公式模块身份（DEC-425）', () => {
  it('连续改名及未改名保存沿用模块 ID 映射；字符串不被改写，旧版本公式可计算', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-module-rename');
    const rule = await w.scoreRule();
    const target = await w.field({ kind: 'number' });
    let t = await w.template(
      templateBody(w.orgId, {
        modules: [indicatorModule(rule.id, { name: '业绩' })],
        resultRules: [
          {
            targetFieldId: target.id,
            formula: 'IF("模块.业绩.得分" = "模块.业绩.得分", 模块.业绩.得分 + 1, 0)',
            priority: 0,
          },
        ],
      }),
    );
    const first = t;
    for (const name of ['绩效', '最终成绩', '最终成绩']) {
      const before = t;
      const response = await w.patch(t, { modules: [indicatorModule(rule.id, { id: t.modules[0]!.id, name })] });
      expect(response.status, await response.clone().text()).toBe(200);
      t = (await response.json()) as TemplateView;
      expect(t.modules[0]!.previousModuleId).toBe(before.modules[0]!.id);
      const refs = await withTenant(testDb().db, w.as.tenant, (tx) =>
        tx
          .select({ moduleId: MR.moduleId })
          .from(MR)
          .innerJoin(R, and(eq(R.tenantId, MR.tenantId), eq(R.id, MR.ruleId)))
          .innerJoin(V, and(eq(V.tenantId, R.tenantId), eq(V.id, R.versionId)))
          .where(and(eq(V.tenantId, w.as.tenant), eq(V.templateId, t.id), eq(V.versionNo, t.currentVersionNo))),
      );
      expect(refs).toEqual([{ moduleId: t.modules[0]!.id }]);
      expect(rulesOf(t)[0]!.formula).toBe(`IF("模块.业绩.得分" = "模块.业绩.得分", 模块.${name}.得分 + 1, 0)`);
      expect(
        evaluateFormula(rulesOf(t)[0]!.formula, {
          subject: inMemorySubject('synthetic', { [`模块.${name}.得分`]: 41 }),
          calendar: { today: '2026-10-11', timeZone: 'Asia/Shanghai' },
        }),
      ).toMatchObject({ ok: true, value: { kind: 'number', value: 42 } });
    }
    expect((await w.read(t.id, '?version=1')).body.resultRules).toEqual(first.resultRules);
    const inherited = await w.patch(t, { permissions: [] });
    expect(inherited.status, await inherited.clone().text()).toBe(200);
    expect(((await inherited.json()) as TemplateView).resultRules).toEqual(t.resultRules);
  });

  it('删除后不带 ID 新建同名模块不能夺取旧绑定；显式清空结果后才可替换', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-module-replace');
    const rule = await w.scoreRule();
    const target = await w.field({ kind: 'number' });
    const modules = [indicatorModule(rule.id, { name: '业绩' })];
    const t = await w.template(
      templateBody(w.orgId, {
        modules,
        resultRules: [{ targetFieldId: target.id, formula: '模块.业绩.得分', priority: 0 }],
      }),
    );
    for (const patch of [{ modules }, { modules: [] }, { modules, resultRules: t.resultRules }]) {
      const response = await w.patch(t, patch);
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'RESULT_MODULE_DELETED' } } });
      expect((await w.read(t.id)).body).toEqual(t);
    }
    const replaced = await w.patch(t, { modules, resultRules: [] });
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    expect(await replaced.json()).toMatchObject({ modules: [{ previousModuleId: null }], resultRules: [] });
  });

  it('停用表单按步骤角色用途保留原快照；新增席位和其他结果项不能挪用停用引用', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-disabled-seat');
    const { flow } = await w.threeStepFlow();
    const source = await w.field({ name: '来源', kind: 'number' });
    const a = await w.field({ kind: 'number' });
    const b = await w.field({ kind: 'number' });
    const form = await w.created<{ id: string }>(
      '/forms',
      formBody([{ fieldId: source.id, access: 'view', required: false }]),
    );
    const stepForms = [{ nodeKey: 'self', purpose: 'info', formId: form.id }];
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        stepForms,
        resultRules: [{ targetFieldId: a.id, formula: '盘点对象.来源', formulaBindings: [source.id], priority: 0 }],
      }),
    );
    expect(
      (await w.trRequest('PATCH', `/forms/${form.id}`, { ifMatch: 1, body: { enabled: false, fields: [] } })).status,
    ).toBe(200);
    expect((await w.trRequest('PATCH', `/fields/${source.id}`, { ifMatch: 1, body: { enabled: false } })).status).toBe(
      200,
    );
    const moved = await w.patch(t, { stepForms: [...stepForms, { ...stepForms[0], nodeKey: 'calibrate' }] });
    expect(moved.status, await moved.clone().text()).toBe(400);
    expect(
      (
        await w.patch(t, {
          resultRules: [{ targetFieldId: b.id, formula: '盘点对象.来源', formulaBindings: [source.id], priority: 0 }],
        })
      ).status,
    ).toBe(400);
    const kept = await w.patch(t, { stepForms, resultRules: t.resultRules });
    expect(kept.status, await kept.clone().text()).toBe(200);
    expect(((await kept.json()) as TemplateView).stepForms).toEqual(t.stepForms);
  });
  it('DEC-387 / DEC-425：模块改名不能使已绑定公式读回超长而无法原样重提', async () => {
    const w = await templateWorld(testDb().db, 'b6a2-module-length');
    const rule = await w.scoreRule();
    const target = await w.field({ kind: 'number' });
    const formula = `Len("${'x'.repeat(3000)}") + ${Array(90).fill('模块.甲.得分').join(' + ')}`;
    const t = await w.template(
      templateBody(w.orgId, {
        modules: [indicatorModule(rule.id, { name: '甲' })],
        resultRules: [{ targetFieldId: target.id, formula, priority: 0 }],
      }),
    );
    const modules = [indicatorModule(rule.id, { id: t.modules[0]!.id, name: '长'.repeat(50) })];
    for (const patch of [{ modules }, { modules, resultRules: t.resultRules }]) {
      const response = await w.patch(t, patch);
      expect(response.status, await response.clone().text()).toBe(400);
      expect((await w.read(t.id)).body).toEqual(t);
    }
  });
});
