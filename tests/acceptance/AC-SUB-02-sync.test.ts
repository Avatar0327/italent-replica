import { randomUUID } from 'node:crypto';
import { upsertSystemSetting } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';
const database = useTestDb();

it('AC-SUB-02 调动实际生效后按开关生成本单位经历，带稳定任职 ID', async () => {
  const db = database().db;
  const s = await personnelSession(db);
  await upsertSystemSetting(
    db,
    { key: 'TransferSyncJobHistory', value: true, description: '调动同步', overridable: true, expectedVersion: 0 },
    { actorUserId: null, commandId: randomUUID() },
  );
  const hire = await s.business(
    s.employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-01-01',
      fields: {},
    },
    s.employee.revision,
  );
  const transfer = await s.business(
    s.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-07-01',
      fields: {},
    },
    hire.employeeRevision,
  );
  const response = await s.request('GET', s.path('jobhistory'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    items: [
      {
        employmentRecordId: transfer.id,
        isThisCompany: true,
        startDate: '2026-07-01',
        sourceType: 'hr_direct',
      },
    ],
  });
});
