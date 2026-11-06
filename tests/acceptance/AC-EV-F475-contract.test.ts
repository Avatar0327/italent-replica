import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requireEvaluationReceipt } from '../../apps/web/src/evaluation/model.js';
import { FORMS, formOperator, formWorld, type FormView } from './AC-EV-form-support.js';
import { ok } from './AC-EV-support.js';

const testDb = useTestDb();
describe('AC-EV F-475 评价表前端回执适配真实 API', () => {
  it('真实授权下读取、名称更新及 409 重读回执符合页面契约', async () => {
    const world = await formWorld(testDb().db);
    const operator = await formOperator(world, { evOrgs: [world.orgA] });
    const form = await ok<FormView>(
      await operator.request('POST', FORMS, {
        ifMatch: 0,
        body: {
          name: '合成评价表',
          ownerOrgId: world.orgA,
          scoreMode: 'by_total',
          fullScore: 100,
          passScore: 60,
          items: [],
        },
      }),
      201,
    );
    expect(requireEvaluationReceipt(form, 0)).toMatchObject({ id: form.id, revision: 1 });
    const path = `${FORMS}/${form.id}`;
    const read = await ok<FormView>(await operator.request('GET', path));
    expect(read).toMatchObject({ name: form.name, ownerOrgId: world.orgA, items: [] });
    const updated = await ok<FormView>(
      await operator.request('PATCH', path, { ifMatch: 1, body: { name: '合成新名称' } }),
    );
    expect(requireEvaluationReceipt(updated, 1, form.id).revision).toBe(2);
    expect((await operator.request('PATCH', path, { ifMatch: 1, body: { name: form.name } })).status).toBe(409);
    const latest = await ok<FormView>(await operator.request('GET', path));
    const reverted = await ok<FormView>(
      await operator.request('PATCH', path, { ifMatch: latest.revision, body: { name: form.name } }),
    );
    expect(requireEvaluationReceipt(reverted, latest.revision, form.id)).toMatchObject({
      name: form.name,
      revision: 3,
    });
  });
});
