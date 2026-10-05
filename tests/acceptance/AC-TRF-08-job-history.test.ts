/**
 * AC-TRF-08（R1-T11）：删除任职后员工当前信息回滚。开启“同步履历”时，被删记录的履历作废，
 * 前一条任职履历的结束日随时间轴恢复（与删除同一事务）。
 */
import { randomUUID } from 'node:crypto';
import { sql, upsertSystemSetting, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';

const database = useTestDb();
const SWITCHES = ['TransferSyncJobHistory', 'EntrySyncJobHistory'];

beforeAll(async () => {
  for (const key of SWITCHES)
    await upsertSystemSetting(
      database().db,
      { key, value: false, description: key, overridable: true, expectedVersion: 0 },
      { actorUserId: null, commandId: randomUUID() },
    );
});

describe('AC-TRF-08 删除任职后履历随时间轴回滚', () => {
  it.each([
    ['最新一条', false],
    ['中间一条', true],
  ] as const)('删除%s调动：被删履历作废，前一条履历结束日恢复', async (_label, withLater) => {
    const db = database().db;
    const s = await personnelSession(db, withLater ? 'trf08-history-mid' : 'trf08-history');
    for (const key of SWITCHES)
      await withTenant(db, s.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO tenant_setting_overrides (tenant_id,key,value,active,revision,updated_by)
          VALUES (${s.tenant.id},${key},'true'::jsonb,true,1,${s.user.id})`),
      );
    const from = await s.org('履历调出部门', { establishedOn: '2026-01-01' });
    const to = await s.org('履历调入部门', { establishedOn: '2026-01-01' });
    const hire = await s.business(
      s.employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-01-01', fields: { departmentId: from.id } },
      1,
    );
    const transfer = await s.business(
      s.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-07-01', fields: { departmentId: to.id } },
      hire.employeeRevision,
    );
    const later = withLater
      ? await s.business(
          s.employee.id,
          { kind: 'transfer', mode: 'direct', effectiveDate: '2026-08-01', fields: { departmentId: from.id } },
          transfer.employeeRevision,
        )
      : null;
    const history = async () => {
      const response = await s.request('GET', s.path('jobhistory'));
      expect(response.status).toBe(200);
      return ((await response.json()) as { items: Record<string, unknown>[] }).items
        .map((item) => ({ recordId: item.employmentRecordId, startDate: item.startDate, endDate: item.endDate }))
        .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    };
    expect((await history()).find((item) => item.recordId === hire.id)).toMatchObject({ endDate: '2026-06-30' });

    const current = await s.request('GET', `/employees/${s.employee.id}`);
    expect(current.status).toBe(200);
    const business = await s.api.request('GET', `/api/tenant/employment/businesses/${transfer.id}`, s.as);
    const { revision } = (await business.json()) as { revision: number };
    const deleted = await s.api.request('DELETE', `/api/tenant/employment/businesses/${transfer.id}`, {
      ...s.as,
      ifMatch: revision,
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await history()).toEqual([
      { recordId: hire.id, startDate: '2026-01-01', endDate: withLater ? '2026-07-31' : null },
      ...(later ? [{ recordId: later.id, startDate: '2026-08-01', endDate: null }] : []),
    ]);
  });
});
