import { useTestDb } from '@italent/testkit';
import { sql, withTenant } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();
async function fixture(label: string) {
  const w = await activationWorld(database().db, label);
  const manager = await w.hired('调动主管');
  const subordinate = await w.hired('新增下属');
  async function roles() {
    return withTenant(w.db, w.session.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT person_in_charge_id AS head, shop_owner_id AS shop
        FROM org_versions WHERE tenant_id=${w.session.tenant.id} AND org_id=${w.to.id}
        ORDER BY version_no DESC LIMIT 1`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0];
    });
  }
  async function subordinateRecord() {
    return (await w.business(subordinate.hire.id)).fields.directManagerId;
  }
  const fields = {
    departmentId: w.to.id,
    isDepartmentHead: true,
    isStoreManager: true,
    addedSubordinateIds: [subordinate.employee.id],
  };
  return { ...w, manager, subordinate, roles, subordinateRecord, fields };
}

describe('AC-TRF-13 / 14 / 15 / 26 生效联动', () => {
  it.each(['direct', 'application'] as const)(
    '%s 未来调动不提前联动，到期同事务执行且重复调度不重复写',
    async (mode) => {
      const w = await fixture(`link-${mode}`);
      const business =
        mode === 'application'
          ? await w.apply(w.manager.employee.id, '2026-10-10', w.fields)
          : await w.session.business(
              w.manager.employee.id,
              {
                kind: 'transfer',
                mode,
                effectiveDate: '2026-10-10',
                fields: w.fields,
              },
              w.manager.hire.employeeRevision,
            );
      if (mode === 'application') await w.approve(business, '2026-10-01T01:00:00Z');
      expect(await w.roles()).toEqual({ head: null, shop: null });
      expect(await w.subordinateRecord()).toBeNull();
      expect((await w.runScheduler('2026-10-09T01:00:00Z')).errors).toEqual([]);
      expect(await w.roles()).toEqual({ head: null, shop: null });
      const run = await w.runScheduler('2026-10-10T01:00:00Z');
      expect(run.errors).toEqual([]);
      expect(run.failed).toEqual([]);
      if (mode === 'direct') expect((await w.business(business.id)).revision).toBeGreaterThan(business.revision);
      expect(await w.roles()).toEqual({ head: w.manager.employee.id, shop: w.manager.employee.id });
      expect(await w.subordinateRecord()).toBe(w.manager.employee.id);
      const before = await w.outboxEvents(business.id);
      expect(before.some((e) => e.eventType === 'employment.transfer.linked')).toBe(true);
      await w.runScheduler('2026-10-10T02:00:00Z');
      expect(await w.outboxEvents(business.id)).toEqual(before);
      const records = await w.session.records(w.subordinate.employee.id);
      expect(records).toHaveLength(1);
    },
  );

  it('新增下属不存在时整单回滚，组织角色与任职记录均不留下部分写入', async () => {
    const w = await fixture('link-rollback');
    const response = await w.session.request('POST', `/employees/${w.manager.employee.id}/businesses`, {
      ifMatch: w.manager.hire.employeeRevision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { ...w.fields, addedSubordinateIds: ['00000000-0000-4000-8000-000000000001'] },
      },
    });
    expect(response.status).toBe(400);
    expect(await w.roles()).toEqual({ head: null, shop: null });
    expect(await w.session.records(w.manager.employee.id)).toHaveLength(1);
  });
});

describe('AC-TRF-31 联动失败与恢复', () => {
  it('循环汇报导致联动失败时组织版本与下属快照一起回滚；修正任职后重试成功', async () => {
    const w = await fixture('link-cycle-retry');
    const transfer = await w.session.business(
      w.manager.employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-10',
        fields: { ...w.fields, directManagerId: w.subordinate.employee.id },
      },
      w.manager.hire.employeeRevision,
    );
    const result = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(result.errors).toEqual([]);
    expect(result.failed).toEqual([transfer.id]);
    expect(await w.roles()).toEqual({ head: null, shop: null });
    expect(await w.subordinateRecord()).toBeNull();
    expect((await w.todos()).map((t) => t.id)).toContain(transfer.id);
    w.session.setNow('2026-10-10T02:00:00Z');
    const current = await w.business(transfer.id);
    const edited = await w.session.request('PATCH', `/records/${transfer.id}`, {
      ifMatch: current.revision,
      body: { fields: { directManagerId: null } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const retried = await w.retry(transfer, '2026-10-10T03:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await w.roles()).toEqual({ head: w.manager.employee.id, shop: w.manager.employee.id });
    expect(await w.subordinateRecord()).toBe(w.manager.employee.id);
    expect(await w.todos()).toEqual([]);
  });

  it('跨租户人员、自选本人都拒绝；不按原始 UUID 探测不同错误原因', async () => {
    const w = await fixture('link-tenant');
    const other = await fixture('link-other-tenant');
    for (const id of [w.manager.employee.id, other.subordinate.employee.id]) {
      const response = await w.session.request('POST', `/employees/${w.manager.employee.id}/businesses`, {
        ifMatch: w.manager.hire.employeeRevision,
        body: {
          kind: 'transfer',
          mode: 'direct',
          effectiveDate: '2026-10-01',
          fields: { ...w.fields, addedSubordinateIds: [id] },
        },
      });
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' } } });
    }
  });
});

it('AC-TRF-26 / W-013 后续任职的负责人标志只在调动生效时补写', async () => {
  const w = await fixture('link-future-head');
  const future = await w.session.business(
    w.manager.employee.id,
    {
      kind: 'regularization',
      mode: 'direct',
      effectiveDate: '2026-10-15',
    },
    w.manager.hire.employeeRevision,
  );
  const transfer = await w.session.business(
    w.manager.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-10',
      fields: w.fields,
    },
    future.employeeRevision,
  );
  expect((await w.business(future.id)).fields.isDepartmentHead).toBeNull();
  const run = await w.runScheduler('2026-10-10T01:00:00Z');
  expect(run.errors).toEqual([]);
  expect(run.failed).toEqual([]);
  expect((await w.business(future.id)).fields.isDepartmentHead).toBe(true);
  expect((await w.outboxEvents(transfer.id)).filter((e) => e.eventType === 'employment.transfer.linked')).toHaveLength(
    1,
  );
});

it('未来任职编辑新增联动字段后到期执行；编辑也拒绝跨租户下属', async () => {
  const w = await fixture('link-edit-future');
  const other = await fixture('link-edit-foreign');
  const transfer = await w.session.business(
    w.manager.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-10',
      fields: { departmentId: w.to.id },
    },
    w.manager.hire.employeeRevision,
  );
  const rejected = await w.session.request('PATCH', `/records/${transfer.id}`, {
    ifMatch: transfer.revision,
    body: { fields: { addedSubordinateIds: [other.subordinate.employee.id] } },
  });
  expect(rejected.status).toBe(400);
  const edited = await w.session.request('PATCH', `/records/${transfer.id}`, {
    ifMatch: transfer.revision,
    body: { fields: w.fields },
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const saved = (await edited.json()) as { revision: number };
  const unchanged = await w.session.request('PATCH', `/records/${transfer.id}`, {
    ifMatch: saved.revision,
    body: { fields: w.fields },
  });
  expect(unchanged.status).toBe(200);
  expect(await unchanged.json()).toMatchObject({ revision: saved.revision });
  expect(await w.roles()).toEqual({ head: null, shop: null });
  const run = await w.runScheduler('2026-10-10T01:00:00Z');
  expect(run.errors).toEqual([]);
  expect(run.failed).toEqual([]);
  expect(await w.roles()).toEqual({ head: w.manager.employee.id, shop: w.manager.employee.id });
  expect(await w.subordinateRecord()).toBe(w.manager.employee.id);
});
