/** F-308 / AC-TRF-28：实习列表与撤回写入口使用同一审批发起人资格。 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { internWorld, type InternWorld } from './AC-IN-BE6a-support.js';
import { restricted } from './AC-PT-http-support.js';
import { rowsOf } from '../../apps/api/src/modules/employment/read-model.js';
import { orgScope } from './support/revocable-rights.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';

const testDb = useTestDb();
const TODAY = '2026-10-01';
type Row = { id: string; employeeId: string; revision: number; state: string; availableActions: string[] };

function sender(w: InternWorld, userId: string) {
  const api = tenantApi(w.db, {
    authorize: restricted({ scope: orgScope(w.session.tenant.id, TODAY, w.org.id) }),
    clock: () => new Date(`${TODAY}T01:00:00Z`),
  });
  return (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/employment${path}`, {
      user: userId,
      tenant: w.session.tenant.id,
      ...options,
    });
}
type Send = ReturnType<typeof sender>;

async function otherHr(w: InternWorld) {
  const user = await createUser(w.db, { email: `f308-${randomUUID()}@example.com`, displayName: '合成 HR B' }, cmd());
  await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: user.id, expectedRevision: 0 }, cmd());
  return sender(w, user.id);
}

async function rowOf(send: Send, businessId: string) {
  const response = await send('GET', '/interns?view=converting');
  expect(response.status, await response.clone().text()).toBe(200);
  const { items } = (await response.json()) as { items: Row[] };
  const row = items.find((item) => item.id === businessId);
  expect(row, '同范围 HR 必须能看到申请行').toBeDefined();
  return row!;
}

async function snapshot(w: InternWorld, businessId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT id, status, revision, initiator_user_id, current_node_key
      FROM approval_instances WHERE tenant_id=${w.session.tenant.id}
        AND business_type='employment' AND business_id=${businessId}::uuid`);
    return rowsOf(result);
  });
}

it('AC-IN-F308：A 是原发起人，列表下发 withdraw，撤回回到草稿且同键重放成功', async () => {
  const w = await internWorld(testDb().db, 'f308-owner');
  const person = await w.hire('F308原发起人', 'intern');
  const businessId = await w.applyRegularization(person.employee.id);
  const send = sender(w, w.session.user.id);
  const row = await rowOf(send, businessId);
  expect(row.availableActions).toContain('withdraw');
  const options = { ifMatch: row.revision, idempotencyKey: randomUUID() };
  const withdrawn = await send('POST', `/businesses/${businessId}/withdraw`, options);
  expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
  expect(await withdrawn.json()).toMatchObject({ id: businessId, status: 'draft' });
  expect(await snapshot(w, businessId)).toMatchObject([{ status: 'withdrawn' }]);
  const replay = await send('POST', `/businesses/${businessId}/withdraw`, options);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toMatchObject({ id: businessId, status: 'draft' });
});

it('AC-IN-F308：B 是同范围 HR、非发起人，写入仍 403 APPROVAL_NOT_INITIATOR，读口不下发 withdraw', async () => {
  const w = await internWorld(testDb().db, 'f308-other');
  const person = await w.hire('F308非发起人', 'intern');
  const businessId = await w.applyRegularization(person.employee.id);
  const send = await otherHr(w);
  const row = await rowOf(send, businessId);
  const before = await snapshot(w, businessId);
  const denied = await send('POST', `/businesses/${businessId}/withdraw`, { ifMatch: row.revision });
  expect(denied.status, await denied.clone().text()).toBe(403);
  expect(await denied.json()).toMatchObject({
    error: { code: 'FORBIDDEN', details: { reason: 'APPROVAL_NOT_INITIATOR' } },
  });
  expect(await snapshot(w, businessId)).toEqual(before);
  const after = await rowOf(send, businessId);
  expect(after).toMatchObject({ revision: row.revision, state: 'in_review' });
  expect(after.availableActions).toEqual(['regularize', 'terminate', 'revoke']);
});

it('AC-IN-F308：审批发起人与建单人不同时，以实际提交产生的审批实例为准', async () => {
  const w = await internWorld(testDb().db, 'f308-submitter');
  const person = await w.hire('F308代建单', 'intern');
  const draft = await w.session.business(
    person.employee.id,
    { kind: 'intern_regularization', mode: 'application', effectiveDate: '2026-10-20', fields: {} },
    await w.revision(person.employee.id),
  );
  const creator = sender(w, w.session.user.id);
  const initiator = await otherHr(w);
  const submitted = await initiator('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  expect.soft((await rowOf(creator, draft.id)).availableActions).not.toContain('withdraw');
  const row = await rowOf(initiator, draft.id);
  expect(row.availableActions).toContain('withdraw');
  const withdrawn = await initiator('POST', `/businesses/${draft.id}/withdraw`, { ifMatch: row.revision });
  expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
  expect(await withdrawn.json()).toMatchObject({ status: 'draft' });
});
