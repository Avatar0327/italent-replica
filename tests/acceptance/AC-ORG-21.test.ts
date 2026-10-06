/** AC-ORG-21 / DEC-196：组织停用合计已落地任职与最新状态仍在途的调入申请。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { activationWorld, seedLegacyOrgDeactivation, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const message = (count: number) => `当前组织或下级组织中存在待入职或在职员工任职记录${count}条，不能被停用`;

async function world(label: string, cascade = false) {
  const w = await activationWorld(testDb().db, `org21-${label}`);
  const child = cascade ? await w.session.org('级联下级', { parents: { admin: { parentId: w.to.id } } }) : w.to;
  const target = cascade ? await w.session.org('级联孙级', { parents: { admin: { parentId: child.id } } }) : w.to;
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-02T01:00:00Z') });
  const orgRequest = (method: string, path: string, body?: Record<string, unknown>) =>
    api.request(method, `/api/tenant/org/organizations${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ...(body ? { ifMatch: w.to.revision, body } : {}),
    });
  const disable = (date = '2026-10-03') => orgRequest('PATCH', `/${w.to.id}`, { enabled: false, effectiveDate: date });
  async function pending(approved = false, departmentId = target.id) {
    const { employee } = await w.hired();
    const application = await w.apply(employee.id, '2026-10-05', { departmentId });
    return approved ? w.approve(application, '2026-10-02T01:00:00Z') : application;
  }
  async function assertEnabled(enabled: boolean) {
    const response = await orgRequest('GET', '?asOf=2026-10-10&includeDisabled=true');
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: { id: string; enabled: boolean; revision: number }[] };
    for (const id of new Set([w.to.id, child.id, target.id])) {
      expect(items.find((item) => item.id === id)).toMatchObject({ enabled, revision: enabled ? 1 : 2 });
    }
  }
  return { ...w, target, disable, pending, orgRequest, assertEnabled };
}

async function expectBlocked(response: Response, count: number) {
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: 'CONFLICT', message: message(count), details: { reason: 'ORG_SUBTREE_NOT_EMPTY' } },
  });
}

async function reject(w: ActivationWorld, id: string) {
  return runEmploymentTransition(
    w.db,
    {
      tenantId: w.session.tenant.id,
      userId: w.session.user.id,
      timezone: w.session.tenant.timezone,
      now: new Date('2026-10-02T01:00:00Z'),
      commandId: randomUUID(),
      expectedRevision: (await w.business(id)).revision,
    },
    { id, action: 'reject' },
  );
}

describe.each([false, true])('AC-ORG-21 在途调入阻止停用（级联：%s）', (cascade) => {
  it.each([false, true])('审批通过未生效=%s：拒绝且整支 revision / 状态不变', async (approved) => {
    const w = await world(`blocked-${cascade}-${approved}`, cascade);
    const application = await w.pending(approved);
    await expectBlocked(await w.disable(), 1);
    await w.assertEnabled(true);
    expect(await w.business(application.id)).toMatchObject({
      status: approved ? 'approved' : 'in_review',
      record: null,
      revision: application.revision,
    });
  });

  it.each(['withdraw', 'reject', 'revoke', 'delete'] as const)('%s 后不计入，可停用整支', async (action) => {
    const w = await world(`excluded-${cascade}-${action}`, cascade);
    const application = await w.pending(action === 'delete');
    // 历史里仍有 in_review / approved：必须只取最新事件。
    if (action === 'reject') expect((await reject(w, application.id)).status).toBe(200);
    else {
      const response = await w.session.request(
        action === 'delete' ? 'DELETE' : 'POST',
        `/businesses/${application.id}${action === 'delete' ? '' : `/${action}`}`,
        { ifMatch: application.revision, body: {} },
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const response = await w.disable();
    expect(response.status, await response.clone().text()).toBe(200);
    await w.assertEnabled(false);
  });

  it('没有在途调入（仅草稿）可停用，其他部门的在途申请不影响', async () => {
    const w = await world(`empty-${cascade}`, cascade);
    const { employee, hire } = await w.hired();
    await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-05', fields: { departmentId: w.target.id } },
      hire.employeeRevision,
    );
    await w.pending(false, w.from.id);
    const response = await w.disable();
    expect(response.status, await response.clone().text()).toBe(200);
    await w.assertEnabled(false);
  });
});

it('AC-ORG-21 N 合计整支已落地 + 审批中 + 已批未生效；已生效申请只计一次', async () => {
  const w = await world('total', true);
  await w.pending(false, w.to.id);
  await w.pending(true);
  const effective = await w.pending(true);
  // 到期审批/生效会保留历史 approved 事件，但最终只计任职投影。
  expect(await w.runScheduler('2026-10-05T01:15:00Z')).toMatchObject({
    activated: expect.arrayContaining([effective.id]),
  });
  await w.pending(true);
  await expectBlocked(await w.disable(), 4);
  await w.assertEnabled(true);
});

it('AC-ORG-21 申请计划日早于停用日也计入；缩短失效日期同样拦截', async () => {
  const w = await world('date');
  await w.pending(true);
  await expectBlocked(await w.disable('2026-10-10'), 1);
  await expectBlocked(
    await w.orgRequest('PATCH', `/${w.to.id}`, { stopDate: '2026-10-09', effectiveDate: '2026-10-03' }),
    1,
  );
  await w.assertEnabled(true);
});

it('AC-ORG-21 同一员工多条在途调入按申请条数计，不按员工去重', async () => {
  const w = await world('same-employee');
  const { employee } = await w.hired();
  await w.approve(await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }), '2026-10-02T01:00:00Z');
  await w.apply(employee.id, '2026-10-06', { departmentId: w.to.id });
  await expectBlocked(await w.disable(), 2);
});

it('AC-ORG-21 以最新载荷目标部门计数，旧目标与载荷历史不重复计入', async () => {
  const w = await world('payload');
  const application = await w.pending();
  const withdrawn = await w.session.request('POST', `/businesses/${application.id}/withdraw`, {
    ifMatch: application.revision,
    body: {},
  });
  expect(withdrawn.status).toBe(200);
  const edited = await w.session.request('PATCH', `/businesses/${application.id}`, {
    ifMatch: (await w.business(application.id)).revision,
    body: { fields: { departmentId: w.from.id } },
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const submitted = await w.session.request('POST', `/businesses/${application.id}/submit`, {
    ifMatch: (await w.business(application.id)).revision,
    body: {},
  });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  expect((await w.disable()).status).toBe(200);
});

it('AC-ORG-21 跨租户隔离：另一租户同名组织的在途不拦截、不混入计数、不能跨租户停用', async () => {
  const a = await world('tenant-a');
  const b = await world('tenant-b');
  await b.pending();
  await b.pending(true);
  expect((await a.orgRequest('PATCH', `/${b.to.id}`, { enabled: false, effectiveDate: '2026-10-03' })).status).toBe(
    404,
  );
  expect((await a.disable()).status).toBe(200);
  await expectBlocked(await b.disable(), 2);
  await b.assertEnabled(true);
});

// PR #82 P2：HTTP 标识的大小写不能改变范围判断、子树遍历或占用计数。
describe.each([false, true])('AC-ORG-21 UUID 等价形式（级联：%s）', (cascade) => {
  it.each(['upper', 'mixed'])('%s UUID 停用仍拒绝在途调入', async (style) => {
    const w = await world(`uuid-${cascade}-${style}`, cascade);
    await w.pending();
    const id =
      style === 'upper'
        ? w.to.id.toUpperCase()
        : w.to.id.replace(/[a-f]/g, (c, i: number) => (i % 2 ? c : c.toUpperCase()));
    await expectBlocked(await w.orgRequest('PATCH', `/${id}`, { enabled: false, effectiveDate: '2026-10-03' }), 1);
    await w.assertEnabled(true);
  });
});

it('AC-ORG-21 草稿保存后部门已停用：提交复查并拒绝，不产生审批实例或状态事件', async () => {
  const w = await world('draft-disabled');
  const { employee, hire } = await w.hired();
  const draft = await w.session.business(
    employee.id,
    {
      kind: 'transfer',
      mode: 'application',
      effectiveDate: '2026-10-05',
      fields: { departmentId: w.to.id },
    },
    hire.employeeRevision,
  );
  expect((await w.disable()).status).toBe(200);
  const response = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
    ifMatch: draft.revision,
    body: {},
  });
  expect(response.status, await response.clone().text()).toBe(400);
  expect(await response.json()).toMatchObject({ error: { details: { reason: 'EMPLOYMENT_DEPARTMENT_DISABLED' } } });
  expect(await w.business(draft.id)).toMatchObject({ status: 'draft', revision: draft.revision, record: null });
  const persisted = await withTenant(w.db, w.session.tenant.id, (tx) =>
    tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM approval_instances WHERE tenant_id=${w.session.tenant.id}
        AND business_id=${draft.id}::uuid) AS instances,
      (SELECT count(*)::int FROM employment_state_events WHERE tenant_id=${w.session.tenant.id}
        AND business_id=${draft.id}::uuid) AS events
  `),
  );
  const rows = Array.isArray(persisted) ? persisted : (persisted as { rows: unknown[] }).rows;
  expect(rows).toEqual([{ instances: 0, events: 1 }]);
});

it('AC-ORG-21 历史遗留停用排期：未来申请审批通过前复查部门，拒绝并保留审批中', async () => {
  const w = await world('approve-disabled');
  const application = await w.pending();
  await seedLegacyOrgDeactivation(w, '2026-10-03');
  const response = runEmploymentTransition(
    w.db,
    {
      tenantId: w.session.tenant.id,
      userId: w.session.user.id,
      timezone: w.session.tenant.timezone,
      now: new Date('2026-10-02T01:00:00Z'),
      commandId: randomUUID(),
      expectedRevision: application.revision,
    },
    { id: application.id, action: 'approve' },
  );
  await expect(response).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
    details: { reason: 'EMPLOYMENT_DEPARTMENT_DISABLED' },
  });
  expect(await w.business(application.id)).toMatchObject({
    status: 'in_review',
    revision: application.revision,
    record: null,
  });
});
