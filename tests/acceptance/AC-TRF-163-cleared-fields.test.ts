/** DEC-163：落地时记录场景留空字段，交给 PR-B 消费；不在 PR-A 创建补全待办。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import type { EmploymentBusiness } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const formId = 'TenantBase.TransferMultiFormView';
const cleared = ['preset:positionId', 'preset:directManagerId', 'preset:dottedManagerId'];

async function fixture(label: string) {
  const w = await activationWorld(database().db, label);
  const manager = await w.hired('合成原经理');
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  async function job(path: string, body: Record<string, unknown>) {
    const response = await api.request('POST', `/api/tenant/job/${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: 0,
      body: { name: '合成原任职引用', code: randomUUID(), startDate: '2026-01-01', ...body },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }
  const post = await job('posts', {});
  const position = await job('positions', { postId: post.id, orgId: w.from.id });
  const employee = await w.session.employee('合成待补全员工');
  const hire = await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: {
        departmentId: w.from.id,
        positionId: position.id,
        postId: post.id,
        directManagerId: manager.employee.id,
        dottedManagerId: manager.employee.id,
      },
    },
    employee.revision,
  );
  return { ...w, employee, hire, post, manager, api };
}

async function recordEvents(w: ActivationWorld, businessId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result = await tx.execute(sql`
      SELECT employee_id AS "employeeId", payload, state FROM employment_outbox
      WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid
        AND event_type='employment.record.create'
    `);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      employeeId: string;
      payload: { after: { clearedFieldCodes: string[]; effectiveDate: string } };
      state: string;
    }[];
  });
}

type World = Awaited<ReturnType<typeof fixture>>;
async function create(w: World, mode: string, effectiveDate: string, fields: Record<string, unknown> = {}) {
  const employee = await w.session.getEmployee(w.employee.id);
  const response = await w.session.request('POST', `/transfers/employees/${w.employee.id}`, {
    ifMatch: employee.revision,
    body: {
      initiator: 'hr',
      transferTypeCode: 'cross_department',
      formId,
      mode,
      effectiveDate,
      fields: { departmentId: w.to.id, ...fields },
      submit: mode === 'application',
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as EmploymentBusiness;
}

async function assertCleared(w: World, business: EmploymentBusiness) {
  const record = await w.session.record(business.id, business.effectiveDate);
  expect(record.fields).toMatchObject({
    departmentId: w.to.id,
    positionId: null,
    directManagerId: null,
    dottedManagerId: null,
    postId: w.post.id,
  });
  const events = await recordEvents(w, business.id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    employeeId: w.employee.id,
    state: 'pending',
    payload: { after: { effectiveDate: business.effectiveDate, clearedFieldCodes: cleared } },
  });
  expect(await w.todos()).toEqual([]);
}

describe('DEC-163 / AC-TRF：场景留空字段随实际落地事件交给 PR-B', () => {
  it.each(['direct', 'approval-now', 'approval-scheduled'])(
    '%s：仅填部门，前驱职位和经理不继承；生效只发布一次留空列表',
    async (path) => {
      const w = await fixture(`trf163-event-${path}`);
      const date = path === 'approval-scheduled' ? '2026-10-05' : '2026-10-01';
      const business = await create(w, path === 'direct' ? 'direct' : 'application', date);
      if (path !== 'direct') {
        expect(await recordEvents(w, business.id)).toEqual([]);
        await w.approve(business, '2026-10-01T02:00:00Z');
      }
      if (path === 'approval-scheduled') {
        expect(await recordEvents(w, business.id)).toEqual([]);
        expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({ activated: [business.id] });
      }
      await assertCleared(w, business);
      await w.runScheduler('2026-10-05T03:00:00Z');
      expect(await recordEvents(w, business.id)).toHaveLength(1);
    },
  );

  it('未来直接调动沿现有版本链落地，事件保留开始日，PR-B可按生效日消费', async () => {
    const w = await fixture('trf163-future-direct');
    const business = await create(w, 'direct', '2026-10-05');
    await assertCleared(w, business);
    expect((await w.session.records(w.employee.id)).find((row) => row.isCurrent)?.id).toBe(w.hire.id);
  });

  it('DEC-161生效失败不发布留空结果；修复排期后重试成功才发布一次', async () => {
    const w = await fixture('trf163-retry');
    const business = await create(w, 'application', '2026-10-05');
    await w.approve(business, '2026-10-01T02:00:00Z');
    async function enabled(value: boolean, revision: number) {
      const response = await w.api.request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: revision,
        body: { enabled: value, effectiveDate: '2026-10-10' },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { revision: number }).revision;
    }
    const disabledRevision = await enabled(false, w.to.revision);
    expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({ failed: [business.id] });
    expect(await recordEvents(w, business.id)).toEqual([]);
    expect((await w.business(business.id)).record).toBeNull();
    await enabled(true, disabledRevision);
    const retry = await w.retry(business, '2026-10-05T02:00:00Z');
    expect(retry.status, await retry.clone().text()).toBe(200);
    await assertCleared(w, business);
  });

  it('已填写或自动带出的非空值不记留空；非调动业务不添加调动元数据', async () => {
    const w = await fixture('trf163-no-cleared');
    const business = await create(w, 'direct', '2026-10-01', {
      departmentId: w.from.id,
      positionId: w.hire.record!.fields.positionId,
      directManagerId: w.manager.employee.id,
      dottedManagerId: w.manager.employee.id,
    });
    expect((await recordEvents(w, business.id))[0]!.payload.after.clearedFieldCodes).toEqual([]);
    expect((await recordEvents(w, w.hire.id))[0]!.payload.after).not.toHaveProperty('clearedFieldCodes');
  });
});
