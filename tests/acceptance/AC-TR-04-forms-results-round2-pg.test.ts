/** #245 P2-03 / P2-04：真 PostgreSQL 的字段 → 目录版本锁序及锁内公式复核。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import * as catalog from '../../apps/api/src/modules/talent-review/calc-rule-catalog.js';
import { bumpFieldCatalog } from '../../apps/api/src/modules/talent-review/field-catalog.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { formBody } from './AC-TR-form-flow-support.js';
import { indicatorModule, templateBody, templateWorld } from './AC-TR-template-support.js';

const testDb = useTestDb();
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TR-04 第 2 轮并发', () => {
  it.each(['form', 'module'])('P2-03：%s 字段不在公式中也先取锁；并发改名没有反向锁等待', async (outlet) => {
    const db = testDb().db;
    const w = await templateWorld(db, `r2-lock-${outlet}`);
    const target = await w.field({ kind: 'number' });
    const extra = await w.field({ name: '快照字段' });
    const { flow } = await w.threeStepFlow();
    const form = await w.created<{ id: string }>('/forms', formBody([{ fieldId: extra.id }]));
    const structure =
      outlet === 'form'
        ? { stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }] }
        : { modules: [{ kind: 'info', name: '信息', fieldIds: [extra.id] }] };
    const t = await w.template(templateBody(w.orgId, { flowId: flow.id, ...structure }));
    let pending: Promise<Response> | undefined;
    // 与字段改名入口相同：先独占字段 F，随后推进目录 V；保存方必须在 V 之前等待 F。
    const rename = await Promise.allSettled([
      withTenant(db, w.as.tenant, async (tx) => {
        await tx.execute(sql`SELECT id FROM talent_review_fields WHERE id = ${extra.id} FOR UPDATE`);
        pending = w.patch(t, { resultRules: [{ targetFieldId: target.id, formula: '1', priority: 0 }] });
        await waitForBlocked(db, 1);
        await tx.execute(sql`UPDATE talent_review_fields SET name = '新快照字段' WHERE id = ${extra.id}`);
        await bumpFieldCatalog(tx, w.as.tenant);
      }),
    ]);
    const response = await pending!;
    expect(rename[0]!.status, JSON.stringify(rename)).toBe('fulfilled');
    expect(response.status, await response.clone().text()).toBe(200);
    const current = (await w.read(t.id)).body;
    expect(current).toMatchObject({ revision: t.revision + 1, versionNo: 2 });
    expect(current.resultRules).toMatchObject([{ targetFieldId: target.id, formula: '1' }]);
    if (outlet === 'form') expect(current.stepForms).toEqual(t.stepForms);
    else expect(current.modules[0]!.fieldIds).toEqual([extra.id]);
  });

  it('P2-04：沿用结果时模块改名与字段改名交错，锁内完整回显超限拒绝且不写版本', async () => {
    const db = testDb().db;
    const w = await templateWorld(db, 'r2-carry-rename');
    const rule = await w.scoreRule();
    const source = await w.field({ name: '甲', kind: 'number' });
    const target = await w.field({ kind: 'number' });
    const base = 'Len("") + 模块.乙.得分 + 盘点对象.甲';
    const formula = base.replace('""', `"${'x'.repeat(3960 - base.length)}"`);
    expect(formula.length).toBe(3960);
    const t = await w.template(
      templateBody(w.orgId, {
        modules: [indicatorModule(rule.id, { name: '乙' })],
        resultRules: [{ targetFieldId: target.id, formula, formulaBindings: [source.id], priority: 0 }],
      }),
    );
    const readCatalog = catalog.loadFullCatalog;
    const loaded = barrier();
    const resume = barrier();
    const spy = vi.spyOn(catalog, 'loadFullCatalog').mockImplementationOnce(async (...args) => {
      const rows = await readCatalog(...args);
      loaded.resolve();
      await resume.promise;
      return rows;
    });
    const pending = w.patch(t, {
      modules: [indicatorModule(rule.id, { id: t.modules[0]!.id, name: '乙'.repeat(31) })],
    });
    let renamed: Response;
    try {
      await loaded.promise;
      renamed = await w.trRequest('PATCH', `/fields/${source.id}`, { ifMatch: 1, body: { name: '甲'.repeat(31) } });
    } finally {
      resume.resolve();
    }
    const response = await pending;
    spy.mockRestore();
    expect(renamed!.status, await renamed!.clone().text()).toBe(200);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'RESULT_MODULE_FORMULA_INVALID' } } });
    const current = (await w.read(t.id)).body;
    expect(current).toMatchObject({ revision: t.revision, versionNo: 1 });
    expect(current.modules).toEqual(t.modules);
    const results = current.resultRules as { formula: string }[];
    expect(results[0]!.formula.length).toBe(3990);
    expect((await w.read(t.id, '?version=1')).body.resultRules).toEqual(current.resultRules);
  });
});
