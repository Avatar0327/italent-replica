import { randomUUID } from 'node:crypto';
import { sql, upsertSystemSetting, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EmploymentBusiness } from './AC-EMP-support.js';
import { personnelSession } from './AC-SUB-support.js';

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

describe('AC-SUB-02 DEC-108 同日多条任职的工作履历同步', () => {
  it('同日 5 条调动后逐条编辑都成功，每条任职恰有一条履历，同日被覆盖的履历在生效日前一天封口', async () => {
    const db = database().db;
    const s = await personnelSession(db, 'sub02-same-day');
    for (const key of ['EntrySyncJobHistory', 'TransferSyncJobHistory'])
      await withTenant(db, s.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO tenant_setting_overrides (tenant_id,key,value,active,revision,updated_by)
        VALUES(${s.tenant.id},${key},'true'::jsonb,true,1,${s.user.id})`),
      );
    const hire = await s.business(
      s.employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-01-01', fields: {} },
      1,
    );
    const transfers: EmploymentBusiness[] = [];
    let revision = hire.employeeRevision;
    for (let index = 0; index < 5; index += 1) {
      const transfer = await s.business(
        s.employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate: '2026-07-01', fields: { remarks: `同日第${index + 1}条` } },
        revision,
      );
      transfers.push(transfer);
      revision = transfer.employeeRevision;
    }
    for (const transfer of transfers) {
      const current = await s.api.request('GET', `/api/tenant/employment/businesses/${transfer.id}`, s.as);
      expect(current.status).toBe(200);
      const edited = await s.api.request('PATCH', `/api/tenant/employment/records/${transfer.id}`, {
        ...s.as,
        ifMatch: ((await current.json()) as EmploymentBusiness).revision,
        body: { fields: { remarks: `编辑${transfer.id}` } },
      });
      expect(edited.status, await edited.clone().text()).toBe(200);
    }
    const response = await s.request('GET', s.path('jobhistory'));
    expect(response.status).toBe(200);
    const rows = ((await response.json()) as { items: Record<string, unknown>[] }).items;
    const byRecord = new Map(rows.map((row) => [row.employmentRecordId, row]));
    expect(rows).toHaveLength(6);
    expect(byRecord.size).toBe(6);
    expect(byRecord.get(hire.id)).toMatchObject({ startDate: '2026-01-01', endDate: '2026-06-30' });
    for (const transfer of transfers.slice(0, -1)) {
      expect(byRecord.get(transfer.id)).toMatchObject({ startDate: '2026-07-01', endDate: '2026-06-30' });
    }
    expect(byRecord.get(transfers.at(-1)!.id)).toMatchObject({ startDate: '2026-07-01', endDate: null });
  });
});
