/** 真 PG：按锁等待构造交错，验证来源表单快照与公式第二遍绑定（DEC-387、AC-TR-15）。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { waitForBlocked } from './support/pg-interleave.js';
import { templateBody, templateWorld } from './AC-TR-template-support.js';
import { formBody } from './AC-TR-form-flow-support.js';

const testDb = useTestDb();
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('B6a-2 PostgreSQL 锁交错', () => {
  it('DEC-387：公式第一遍后来源改名：第二遍拒绝旧绑定，模板与版本不变', async () => {
    const db = testDb().db;
    const w = await templateWorld(db, 'b6a2-pg-bind');
    const source = await w.field({ name: '原名', kind: 'number' });
    const target = await w.field({ kind: 'number' });
    const t = await w.template(templateBody(w.orgId));
    let pending: Promise<Response> | undefined;
    await withTenant(db, w.as.tenant, async (tx) => {
      await tx.execute(sql`SELECT id FROM talent_review_fields WHERE id = ${source.id} FOR UPDATE`);
      pending = w.patch(t, {
        resultRules: [
          { targetFieldId: target.id, formula: '盘点对象.原名 + 1', formulaBindings: [source.id], priority: 0 },
        ],
      });
      await waitForBlocked(db, 1);
      await tx.execute(sql`UPDATE talent_review_fields SET name = '新名' WHERE id = ${source.id}`);
      await tx.execute(sql`UPDATE talent_review_field_catalog_versions SET version = version + 1`);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(409);
    const current = (await w.read(t.id)).body;
    expect(current).toMatchObject({ revision: t.revision, versionNo: 1, resultRules: [] });
  });

  it('AC-TR-15：源表单修改持锁：模板选用等待提交，快照完整取到提交后的三档配置', async () => {
    const db = testDb().db;
    const w = await templateWorld(db, 'b6a2-pg-form');
    const { flow } = await w.threeStepFlow();
    const field = await w.field();
    const form = await w.created<{ id: string }>('/forms', formBody([{ fieldId: field.id, access: 'edit' }]));
    const t = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    let pending: Promise<Response> | undefined;
    await withTenant(db, w.as.tenant, async (tx) => {
      await tx.execute(sql`SELECT id FROM talent_review_forms WHERE id = ${form.id} FOR UPDATE`);
      pending = w.patch(t, { stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }] });
      await waitForBlocked(db, 1);
      await tx.execute(sql`UPDATE talent_review_form_fields SET access = 'view' WHERE form_id = ${form.id}`);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      stepForms: [
        {
          formSnapshot: [{ fieldId: field.id, access: 'view', required: false }],
        },
      ],
    });
  });
});
