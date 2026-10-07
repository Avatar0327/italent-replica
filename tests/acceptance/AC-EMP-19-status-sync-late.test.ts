/**
 * F-022 / AC-EMP-19：F-021 同步序列追加的记录快照 / 申请载荷版本、迟到执行（DEC-186 / 195）改期追加的版本，
 * 都继承上一版本的人员状态，不回落为默认值。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { insertEmploymentRow } from '../../apps/api/src/modules/employment/record-store.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { resultRows } from './AC-ORG-people-support.js';
import { scenario, worker } from './AC-JOB-sequence-support.js';
import { employmentSession } from './AC-EMP-support.js';

const testDb = useTestDb();

async function statuses(tenantId: string, employeeId: string) {
  return withTenant(testDb().db, tenantId, async (tx) =>
    resultRows<{ business: string; v: number; s: number; snapshot: boolean }>(
      await tx.execute(sql`SELECT business_id AS business, version_no AS v, employee_status AS s,
        is_record_snapshot AS snapshot FROM employment_payload_versions
        WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY business_id, version_no`),
    ),
  );
}

describe('AC-EMP-19 同步序列、迟到执行追加版本继承人员状态', () => {
  it('F-021 同步序列：当前 / 未来记录追加的快照保持试用', async () => {
    const { db } = testDb();
    const s = await scenario(db, 'posts');
    const tenantId = s.world.tenant.id;
    // 夹具：以显式状态流转把在职各条记录置为试用（状态端口由 R2-T02 接线，这里直接走公共追加入口）
    await withTenant(db, tenantId, async (tx) => {
      const latest = resultRows<Record<string, unknown>>(
        await tx.execute(sql`SELECT DISTINCT ON (business_id) * FROM employment_payload_versions
          WHERE tenant_id=${tenantId} AND employee_id=${s.employee.id}::uuid ORDER BY business_id, version_no DESC`),
      );
      for (const row of latest)
        await insertEmploymentRow(
          tx,
          'employment_payload_versions',
          {
            id: randomUUID(),
            tenantId,
            employeeId: s.employee.id,
            businessId: row.business_id,
            versionNo: Number(row.version_no) + 1,
            previousVersionId: row.id,
            commandId: 'probation-fixture',
            triggerBusinessId: row.business_id,
            isRecordSnapshot: true,
            kind: row.kind,
            mode: row.mode,
            effectiveDate: row.effective_date,
            formId: row.form_id,
            departmentId: row.department_id,
            postId: row.post_id,
            positionId: row.position_id,
            sequenceId: row.sequence_id,
            employType: row.employ_type,
          },
          { employeeStatus: 2, entryStatus: null },
        );
    });
    const response = await s.call(
      'PATCH',
      `posts/${s.target.id}`,
      { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true },
      1,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const before = (await statuses(tenantId, s.employee.id)).length;
    await worker(db, tenantId);
    const after = await statuses(tenantId, s.employee.id);
    expect(after.length).toBeGreaterThan(before);
    expect(after.filter((row) => row.v > 1).every((row) => row.s === 2)).toBe(true);
    const records = await s.world.employmentRecords(s.employee.id, '2026-10-05');
    expect(records.map((record) => record.fields.sequenceId)).toContain(s.nextSequence.id);
  });

  it('迟到执行：审批通过的调动晚于计划日落地，改期追加的版本与落地记录保持试用', async () => {
    const session = await employmentSession(testDb().db, 'emplate');
    const org = await session.org('迟到部门', { establishedOn: '2026-01-01' });
    const target = await session.org('迟到调入部门', { establishedOn: '2026-01-01' });
    const employee = await session.employee();
    const ctx = (expectedRevision: number, at = '2026-10-01T01:00:00Z'): EmploymentContext => ({
      tenantId: session.tenant.id,
      userId: session.user.id,
      timezone: session.tenant.timezone,
      now: new Date(at),
      commandId: randomUUID(),
      expectedRevision,
    });
    await withTenant(testDb().db, session.tenant.id, (tx) =>
      createEmploymentBusiness(
        tx,
        ctx(employee.revision),
        employee.id,
        { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: org.id } },
        { entry: { probation: true } },
      ),
    );
    const application = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-05', fields: { departmentId: target.id } },
      (await session.getEmployee(employee.id)).revision,
    );
    let revision = application.revision;
    for (const [action, at] of [
      ['submit', '2026-10-01T01:00:00Z'],
      ['approve', '2026-10-01T01:00:00Z'],
      ['activate', '2026-10-08T01:00:00Z'],
    ] as const) {
      revision = (
        await withTenant(testDb().db, session.tenant.id, (tx) =>
          transitionEmployment(tx, ctx(revision, at), { id: application.id, action }),
        )
      ).revision;
    }
    const records = (await session.records(employee.id, '2026-10-08')) as unknown as {
      kind: string;
      effectiveDate: string;
      employeeStatus: number;
    }[];
    expect(records.map((record) => [record.kind, record.effectiveDate, record.employeeStatus])).toEqual([
      ['hire', '2026-09-01', 2],
      ['transfer', '2026-10-08', 2],
    ]);
    const versions = (await statuses(session.tenant.id, employee.id)).filter((row) => row.business === application.id);
    expect(versions.length).toBeGreaterThan(1);
    expect(versions.every((row) => row.s === 2)).toBe(true);
  });
});
