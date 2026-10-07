/**
 * AC-EST-33（DEC-258）：调出申请回退（撤回 / 驳回 / 不同意 / 作废 / 删除）使原部门超编时一律只弹确认、不拦截，
 * 严格与非严格控编同口径；审批中心的撤回、驳回、不同意入口透传 `confirmed`。携编回退维持原口径与 DEC-181 非负护栏。
 * 每个入口 × 严格 / 非严格 × 确认 / 未确认，断言状态码与原因码，并前后比对单据、员工 revision、占用、审计与 outbox。
 */
import { randomBytes } from 'node:crypto';
import { createUser, grantMembership } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import type { InstanceView } from './AC-APV-support.js';
import { configure, warning } from './AC-EST-20-support.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const NOW = '2026-10-01T01:00:00Z';
const CONFIRMED_AUDIT = 'employment.establishment.exceeded-confirmed';
type World = Awaited<ReturnType<typeof carriedWorld>>;
type Action = 'withdraw' | 'reject' | 'disapprove';
const BUSINESS_STATE = { withdraw: 'draft', reject: 'rejected', disapprove: 'disapproved' } as const;
const INSTANCE_STATE = { withdraw: 'withdrawn', reject: 'returned', disapprove: 'disapproved' } as const;

/** 审批中心按请求人身份访问；夹具兜底流程只有「同意」出口，这里另发布一条带「不同意」出口的调动流程。 */
function approvalCenter(w: World) {
  const api = tenantApi(w.db, { clock: () => new Date(NOW) });
  const as = (user: string) => ({ user, tenant: w.session.tenant.id });
  const hr = w.session.user.id;
  async function publishDisagreeProcess() {
    const suffix = randomBytes(3).toString('hex');
    const admin = await createUser(
      w.db,
      { email: `reversal-${suffix}@example.com`, displayName: '回退验收异常管理员' },
      cmd(),
    );
    await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: admin.id, expectedRevision: 0 }, cmd());
    const created = await api.request('POST', '/api/tenant/approval/processes', {
      ...as(hr),
      ifMatch: 0,
      body: {
        code: `REVERSAL_${suffix}`,
        approvalType: 'transfer',
        name: '回退确认验收流程',
        exceptionAdminUserId: admin.id,
        conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
        nodes: [{ key: 'owner', approver: 'owner', exits: ['approve', 'disagree'] }],
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const process = (await created.json()) as { id: string; revision: number };
    const published = await api.request('POST', `/api/tenant/approval/processes/${process.id}/publish`, {
      ...as(hr),
      ifMatch: process.revision,
    });
    expect(published.status, await published.clone().text()).toBe(200);
  }
  async function instanceOf(businessId: string): Promise<InstanceView> {
    const list = await api.request(
      'GET',
      `/api/tenant/approval/instances?role=initiated&businessId=${businessId}`,
      as(hr),
    );
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as { items: { id: string }[] };
    expect(items).toHaveLength(1);
    const detail = await api.request('GET', `/api/tenant/approval/instances/${items[0]!.id}`, as(hr));
    expect(detail.status).toBe(200);
    return (await detail.json()) as InstanceView;
  }
  /** 撤回由发起人发出；驳回 / 不同意由当前待办人发出，确认参数随请求体透传。 */
  async function act(businessId: string, action: Action, confirmed?: boolean) {
    const instance = await instanceOf(businessId);
    const body = { ...(confirmed === undefined ? {} : { confirmed }) };
    if (action === 'withdraw')
      return api.request('POST', `/api/tenant/approval/instances/${instance.id}/withdraw`, {
        ...as(hr),
        ifMatch: instance.revision,
        body,
      });
    const task = instance.tasks.find((item) => item.status === 'pending');
    expect(task, JSON.stringify(instance.tasks)).toBeDefined();
    const path = action === 'reject' ? 'reject' : 'disagree';
    return api.request('POST', `/api/tenant/approval/tasks/${task!.id}/${path}`, {
      ...as(task!.assigneeUserId),
      ifMatch: instance.revision,
      body: { comment: null, ...body },
    });
  }
  return { publishDisagreeProcess, instanceOf, act };
}

async function snapshot(w: World, id: string, employeeId: string, occupantId: string) {
  const center = approvalCenter(w);
  return {
    business: await w.business(id),
    employee: await w.session.getEmployee(employeeId),
    records: await w.session.records(employeeId, '2026-10-05'),
    occupant: await w.session.records(occupantId, '2026-10-05'),
    capacities: await w.capacities(),
    history: await w.history(),
    audit: (await w.auditEvents(id)).map((event) => event.action),
    outbox: await w.outboxEvents(id),
    instance: (await center.instanceOf(id)).status,
  };
}

/** 普通调出申请：甲在容量 1 的部门，提交调出申请后乙调入；回退申请会把甲恢复到原部门而超编。 */
async function plainWorld(strict: boolean) {
  const w = await carriedWorld(database().db, 'reversal-plain');
  await configure(w, strict);
  const center = approvalCenter(w);
  await center.publishDisagreeProcess();
  const a = await w.hired('甲');
  const b = await w.hired('乙');
  expect((await w.save(a, { withEstablishment: false, effectiveDate: '2026-10-01' })).status).toBe(201);
  const outgoing = await w.save(a, {
    withEstablishment: false,
    mode: 'application',
    submit: true,
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  expect(outgoing.status, await outgoing.clone().text()).toBe(201);
  const application = (await outgoing.json()) as { id: string; revision: number };
  const incoming = await w.save(b, { withEstablishment: false });
  expect(incoming.status, await incoming.clone().text()).toBe(201);
  return { ...w, a, b, application, center };
}

/** 携编调出申请（同 AC-EST-30 draftWorld）：携编额度已被普通调入占用，回退会使调入方超编。 */
async function carriedDraftWorld(strict: boolean) {
  const w = await carriedWorld(database().db, 'reversal-carried');
  await configure(w, strict, 0);
  const center = approvalCenter(w);
  await center.publishDisagreeProcess();
  const settings = await tenantApi(w.db).request('PUT', '/api/tenant/establishment/settings', {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: 0,
    body: { transferIn: 'approved', transferOut: 'submitted', effectiveDate: '2026-10-01' },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  const a = await w.hired('携编甲');
  const b = await w.hired('普通乙');
  const saved = await w.save(a, { mode: 'application', submit: true, effectiveDate: '2026-10-20' });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const application = (await saved.json()) as { id: string; revision: number };
  expect((await w.save(b, { withEstablishment: false })).status).toBe(201);
  return { ...w, a, b, application, center };
}

for (const strict of [false, true])
  for (const action of ['withdraw', 'reject', 'disapprove'] as const)
    it(`AC-EST-33 审批中心 ${action} 普通调出申请：严格 / 非严格都只确认不拦截 strict=${strict}`, async () => {
      const w = await plainWorld(strict);
      const before = await snapshot(w, w.application.id, w.a.employee.id, w.b.employee.id);
      expect(before.instance).toBe('running');
      // 未确认：严格与非严格一律 409 CONFIRMATION_REQUIRED，整单回滚（DEC-258）。
      await warning(await w.center.act(w.application.id, action), false);
      expect(await snapshot(w, w.application.id, w.a.employee.id, w.b.employee.id)).toEqual(before);
      const confirmed = await w.center.act(w.application.id, action, true);
      expect(confirmed.status, await confirmed.clone().text()).toBe(200);
      const after = await snapshot(w, w.application.id, w.a.employee.id, w.b.employee.id);
      expect(after.business.status).toBe(BUSINESS_STATE[action]);
      expect(after.instance).toBe(INSTANCE_STATE[action]);
      expect(after.business.revision).toBeGreaterThan(before.business.revision);
      expect(after.occupant).toEqual(before.occupant);
      // 确认后同事务记超编警告审计与 outbox。
      expect(after.audit.filter((item) => item === CONFIRMED_AUDIT)).toHaveLength(1);
      expect(after.outbox.map((item) => item.eventType)).toContain(CONFIRMED_AUDIT);
      const audit = (await w.auditEvents(w.application.id)).find((event) => event.action === CONFIRMED_AUDIT);
      expect(audit?.after).toMatchObject({ reason: 'ESTABLISHMENT_EXCEEDED', action, strictControl: strict });
    });

for (const strict of [false, true])
  for (const action of ['withdraw', 'reject', 'disapprove'] as const)
    it(`AC-EST-33 审批中心 ${action} 携编申请：透传确认，严格仍拒绝 strict=${strict}`, async () => {
      const w = await carriedDraftWorld(strict);
      const before = await snapshot(w, w.application.id, w.a.employee.id, w.b.employee.id);
      await warning(await w.center.act(w.application.id, action), strict);
      expect(await snapshot(w, w.application.id, w.a.employee.id, w.b.employee.id)).toEqual(before);
      const confirmed = await w.center.act(w.application.id, action, true);
      if (strict) {
        await warning(confirmed, true);
        expect(await snapshot(w, w.application.id, w.a.employee.id, w.b.employee.id)).toEqual(before);
        return;
      }
      expect(confirmed.status, await confirmed.clone().text()).toBe(200);
      const after = await snapshot(w, w.application.id, w.a.employee.id, w.b.employee.id);
      expect(after.business.status).toBe(BUSINESS_STATE[action]);
      expect(after.instance).toBe(INSTANCE_STATE[action]);
      expect(after.capacities[1]?.localCapacity).toBe(0);
      expect(after.history).toHaveLength(4);
      expect(after.occupant).toEqual(before.occupant);
    });

it('AC-EST-33 携编回退维持 DEC-181 非负护栏：确认也不能把容量回退成负数', async () => {
  const w = await carriedDraftWorld(false);
  // 携编后 HR 又把调入方额度改回 0：回退 −1 会出现负数，确认不能绕过该护栏。
  await configure(w, false, 0);
  const before = await snapshot(w, w.application.id, w.a.employee.id, w.b.employee.id);
  const response = await w.center.act(w.application.id, 'withdraw', true);
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { details: { reason: 'ESTABLISHMENT_CAPACITY_INSUFFICIENT' } },
  });
  expect(await snapshot(w, w.application.id, w.a.employee.id, w.b.employee.id)).toEqual(before);
});

it('AC-EST-33 审批中心同意不受确认参数影响：严格拒绝、非严格服务端豁免', async () => {
  const w = await carriedWorld(database().db, 'reversal-approve');
  await configure(w, false);
  const center = approvalCenter(w);
  const a = await w.hired('甲');
  const b = await w.hired('乙');
  expect((await w.save(a, { withEstablishment: false })).status).toBe(201);
  const outgoing = await w.save(b, {
    withEstablishment: false,
    mode: 'application',
    submit: true,
    confirmed: true,
  });
  expect(outgoing.status, await outgoing.clone().text()).toBe(201);
  const business = (await outgoing.json()) as { id: string };
  const instance = await center.instanceOf(business.id);
  const task = instance.tasks.find((item) => item.status === 'pending')!;
  const approved = await tenantApi(w.db, { clock: () => new Date(NOW) }).request(
    'POST',
    `/api/tenant/approval/tasks/${task.id}/approve`,
    { user: task.assigneeUserId, tenant: w.session.tenant.id, ifMatch: instance.revision, body: { comment: null } },
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect((await w.business(business.id)).status).toBe('approved');
  expect((await w.auditEvents(business.id)).map((event) => event.action)).not.toContain(CONFIRMED_AUDIT);
});
