import { randomUUID } from 'node:crypto';
import { sql, upsertSystemSetting, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { syncEmploymentHistory } from '../../apps/api/src/modules/personnel/employment-sync.js';
const database = useTestDb();
const switches = ['TransferSyncJobHistory', 'EntrySyncJobHistory', 'DismissSyncJobHistory'];
beforeAll(async () => {
  for (const key of switches)
    await upsertSystemSetting(
      database().db,
      { key, value: false, description: key, overridable: true, expectedVersion: 0 },
      { actorUserId: null, commandId: randomUUID() },
    );
});
async function fixture(enabled: string[]) {
  const db = database().db;
  const s = await personnelSession(db);
  for (const key of enabled)
    await withTenant(db, s.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO tenant_setting_overrides
    (tenant_id,key,value,active,revision,updated_by) VALUES(${s.tenant.id},${key},'true'::jsonb,true,1,${s.user.id})`),
    );
  const hire = await s.business(
    s.employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2026-01-01', fields: {} },
    1,
  );
  const history = async () => {
    const response = await s.request('GET', s.path('jobhistory'));
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: Record<string, unknown>[] }).items;
  };
  const ctx = {
    tenantId: s.tenant.id,
    userId: s.user.id,
    timezone: s.tenant.timezone,
    now: new Date('2026-10-01T01:00:00Z'),
    commandId: randomUUID(),
    expectedRevision: 0,
  };
  return { db, s, hire, history, ctx };
}
describe('AC-SUB-02 实际任职生效联动', () => {
  it('三个开关关闭不生成经历，调动打开才生成且带稳定任职 ID', async () => {
    const off = await fixture([]);
    await off.s.business(
      off.s.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-07-01', fields: {} },
      off.hire.employeeRevision,
    );
    expect(await off.history()).toEqual([]);
    const on = await fixture(['TransferSyncJobHistory']);
    const transfer = await on.s.business(
      on.s.employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-07-01',
        fields: {},
      },
      on.hire.employeeRevision,
    );
    expect(await on.history()).toMatchObject([
      {
        employmentRecordId: transfer.id,
        isThisCompany: true,
        startDate: '2026-07-01',
        sourceType: 'hr_direct',
      },
    ]);
    await withTenant(on.db, on.s.tenant.id, (tx) =>
      syncEmploymentHistory(tx, on.ctx, on.s.employee.id, transfer.id, 'transfer', '2026-07-01'),
    );
    expect(await on.history()).toHaveLength(1);
  });
  it('入职和调动经历的有效期随链更新，离职开关只封口已同步的有效工作区间', async () => {
    const f = await fixture(switches);
    expect(await f.history()).toHaveLength(1);
    const transfer = await f.s.business(
      f.s.employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-07-01',
        fields: {},
      },
      f.hire.employeeRevision,
    );
    const after = await f.history();
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.employmentRecordId === f.hire.id)).toMatchObject({ endDate: '2026-06-30' });
    await f.s.business(
      f.s.employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30', fields: {} },
      transfer.employeeRevision,
    );
    expect((await f.history()).find((r) => r.employmentRecordId === transfer.id)).toMatchObject({
      endDate: '2026-09-30',
      leaveDate: '2026-09-30',
    });
  });
  it('申请草稿、提交、提前审批均不生成，实际到期生效才同步', async () => {
    const f = await fixture(['TransferSyncJobHistory']);
    const draft = await f.s.business(
      f.s.employee.id,
      {
        kind: 'transfer',
        mode: 'application',
        effectiveDate: '2026-12-01',
        fields: {},
      },
      f.hire.employeeRevision,
    );
    expect(await f.history()).toEqual([]);
    const submitted = await runEmploymentTransition(
      f.db,
      { ...f.ctx, expectedRevision: draft.revision, commandId: randomUUID() },
      { id: draft.id, action: 'submit' },
    );
    const reviewed = await runEmploymentTransition(
      f.db,
      { ...f.ctx, expectedRevision: (submitted.body as { revision: number }).revision, commandId: randomUUID() },
      { id: draft.id, action: 'approve' },
    );
    expect(await f.history()).toEqual([]);
    const ctx = {
      ...f.ctx,
      now: new Date('2026-12-01T12:00:00Z'),
      commandId: randomUUID(),
      expectedRevision: (reviewed.body as { revision: number }).revision,
    };
    await runEmploymentTransition(f.db, ctx, { id: draft.id, action: 'activate' });
    await runEmploymentTransition(f.db, ctx, { id: draft.id, action: 'activate' });
    expect(await f.history()).toHaveLength(1);
  });
  it('任职编辑与删除维护同一履历链接，原版本与删除快照保留', async () => {
    const f = await fixture(['EntrySyncJobHistory']);
    const org = await f.s.org('变更后部门', { startDate: '2020-01-01' });
    const first = (await f.history())[0]!;
    const changed = await f.s.api.request('PATCH', `/api/tenant/employment/records/${f.hire.id}`, {
      ...f.s.as,
      ifMatch: f.hire.revision,
      body: { fields: { departmentId: org.id } },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const business = (await changed.json()) as { revision: number };
    expect(await f.history()).toMatchObject([{ id: first.id, department: '变更后部门', revision: 2 }]);
    const deleted = await f.s.api.request('DELETE', `/api/tenant/employment/businesses/${f.hire.id}`, {
      ...f.s.as,
      ifMatch: business.revision,
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await f.history()).toEqual([]);
    const history = await f.s.request('GET', `${f.s.path('jobhistory')}/${first.id}/history`);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      items: [
        { deleted: true, revision: 3 },
        { deleted: false, revision: 2 },
        { deleted: false, revision: 1 },
      ],
    });
    expect(await (await f.s.request('GET', `/employees/${f.s.employee.id}`)).json()).toMatchObject({
      firstEntryDate: null,
      latestEntryDate: null,
    });
  });
});
