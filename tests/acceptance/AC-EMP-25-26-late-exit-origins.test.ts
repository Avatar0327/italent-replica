import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';

const database = useTestDb();

it('AC-EMP-25/26 #12：真实离职顺延登记独立业务日期，两列逐版保持基线', async () => {
  const x = await downstreamWorld(database().db, 'f036s3-late-exit-origins', '2026-10-18');
  const leave = await x.atDay('2026-10-06', () => x.submittedLeave('2026-10-15'));
  expect(await x.stateOfBusiness(leave.id)).toBe('in_review');
  await x.approveInReview(leave.id);
  expect(await x.stateOfBusiness(leave.id)).toBe('effective');

  const tenantId = x.session.tenant.id;
  const versions = await x.sqlRows<{
    version: number;
    effectiveDate: string;
    lastWorkDate: string;
    explicitFieldCodes: string[];
    deferredFieldCodes: string[];
  }>(sql`
    SELECT version_no AS version, effective_date::text AS "effectiveDate", last_work_date::text AS "lastWorkDate",
      explicit_field_codes AS "explicitFieldCodes", deferred_field_codes AS "deferredFieldCodes"
    FROM employment_payload_versions WHERE tenant_id = ${tenantId} AND business_id = ${leave.id}
    ORDER BY version_no`);
  expect(versions).toEqual([
    {
      version: 1,
      effectiveDate: '2026-10-16',
      lastWorkDate: '2026-10-15',
      explicitFieldCodes: [],
      deferredFieldCodes: [],
    },
    {
      version: 2,
      effectiveDate: '2026-10-18',
      lastWorkDate: '2026-10-17',
      explicitFieldCodes: [],
      deferredFieldCodes: [],
    },
  ]);

  const origins = await x.sqlRows<{
    version: number;
    field: string;
    kind: string;
    value: unknown;
    reason: string | null;
  }>(sql`
    SELECT p.version_no AS version, o.field_code AS field, o.origin_kind AS kind, o.value, o.reason
    FROM employment_field_origins o JOIN employment_payload_versions p
      ON p.tenant_id=o.tenant_id AND p.id=o.payload_version_id
    WHERE o.tenant_id=${tenantId} AND o.business_id=${leave.id} AND o.field_code='preset:lastWorkDate'
    ORDER BY o.seq`);
  expect(origins, '#12 顺延版写入系统最后工作日来源').toEqual([
    { version: 1, field: 'preset:lastWorkDate', kind: 'hr-input', value: '2026-10-15', reason: null },
    { version: 2, field: 'preset:lastWorkDate', kind: 'system-input', value: '2026-10-17', reason: 'late-execution' },
  ]);
});
