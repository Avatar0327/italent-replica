import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, type EmploymentBusiness, type EmploymentSession } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const changedFields = { place: '追溯后地点', employmentType: '追溯后类别' };

async function fixture(db: Db, label: string) {
  const session = await employmentSession(db, label);
  const employee = await session.employee();
  const org = await session.org('合成在职部门', { startDate: '2026-01-01' });
  const hire = await session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: org.id, place: '原地点', employmentType: '原类别' },
    },
    employee.revision,
  );
  const later = await session.business(
    employee.id,
    { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-20' },
    hire.employeeRevision,
  );
  return { session, employee, hire, later };
}

async function snapshots(db: Db, session: EmploymentSession, employeeId: string) {
  return withTenant(db, session.tenant.id, async (tx) => ({
    records: resultRows<Record<string, unknown>>(
      await tx.execute(sql`SELECT * FROM employment_records
        WHERE tenant_id=${session.tenant.id} AND employee_id=${employeeId} ORDER BY id`),
    ),
    payloads: resultRows<Record<string, unknown>>(
      await tx.execute(sql`SELECT * FROM employment_payload_versions
        WHERE tenant_id=${session.tenant.id} AND employee_id=${employeeId} ORDER BY business_id,version_no`),
    ),
  }));
}

function backfill() {
  return { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-10', fields: changedFields };
}

describe('AC-FWD-01/02 DEC-019 版本追加、幂等与事务边界', () => {
  it('传播只追加目标payload，保留旧快照，最新读模型与字段审计关联触发命令', async () => {
    const { db } = testDb();
    const { session, employee, later } = await fixture(db, 'fwd-version-audit');
    const original = await snapshots(db, session, employee.id);
    const oldPayload = original.payloads.filter((row) => row.business_id === later.id).at(-1)!;
    const commandId = randomUUID();
    const response = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: later.employeeRevision,
      idempotencyKey: commandId,
      body: backfill(),
    });
    expect(response.status).toBe(201);
    const source = (await response.json()) as EmploymentBusiness;
    expect((await session.record(later.id)).fields).toMatchObject(changedFields);
    const after = await snapshots(db, session, employee.id);
    for (const originalRow of original.records) expect(after.records).toContainEqual(originalRow);
    for (const originalRow of original.payloads) expect(after.payloads).toContainEqual(originalRow);
    const versions = after.payloads.filter((row) => row.business_id === later.id);
    expect(versions).toHaveLength(original.payloads.filter((row) => row.business_id === later.id).length + 1);
    expect(versions.at(-1)).toMatchObject({
      previous_version_id: oldPayload.id,
      version_no: Number(oldPayload.version_no) + 1,
      command_id: commandId,
      trigger_business_id: source.id,
      is_record_snapshot: true,
      place: changedFields.place,
      employment_type: changedFields.employmentType,
    });
    const audited = await withTenant(db, session.tenant.id, async (tx) =>
      resultRows(
        await tx.execute(sql`SELECT actor_user_id,before,after FROM audit_events
          WHERE tenant_id=${session.tenant.id} AND command_id=${commandId} AND object_id=${later.id}`),
      ),
    );
    expect(audited).toContainEqual(
      expect.objectContaining({
        actor_user_id: session.user.id,
        before: expect.objectContaining({ place: '原地点', employmentType: '原类别' }),
        after: expect.objectContaining(changedFields),
      }),
    );
  });

  it('同命令重放不追加第二份目标版本，异内容复用和过期revision返回409', async () => {
    const { db } = testDb();
    const { session, employee, later } = await fixture(db, 'fwd-replay-revision');
    const options = { ifMatch: later.employeeRevision, idempotencyKey: randomUUID(), body: backfill() };
    const first = await session.request('POST', `/employees/${employee.id}/businesses`, options);
    expect(first.status).toBe(201);
    const saved = (await first.json()) as EmploymentBusiness;
    expect((await session.record(later.id)).fields).toMatchObject(changedFields);
    const firstRows = await snapshots(db, session, employee.id);
    const replay = await session.request('POST', `/employees/${employee.id}/businesses`, options);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(saved);
    expect(await snapshots(db, session, employee.id)).toEqual(firstRows);
    expect((await session.getEmployee(employee.id)).revision).toBe(saved.employeeRevision);
    const conflict = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ...options,
      body: { ...backfill(), fields: { place: '另一地点' } },
    });
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    const staleEmployee = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: later.employeeRevision,
      body: { ...backfill(), effectiveDate: '2026-09-12' },
    });
    expect(staleEmployee.status).toBe(409);
    expect(await errorCode(staleEmployee)).toBe('REVISION_CONFLICT');
    const staleTarget = await session.request('PATCH', `/businesses/${later.id}`, {
      ifMatch: later.revision,
      body: { fields: { place: '过期覆盖' } },
    });
    expect(staleTarget.status).toBe(409);
    expect(await errorCode(staleTarget)).toBe('REVISION_CONFLICT');
    expect(await snapshots(db, session, employee.id)).toEqual(firstRows);
  });

  it('目标字段审计写入失败回滚源记录、所有传播版本、revision、outbox及命令台账', async () => {
    const { db } = testDb();
    const { session, employee, later } = await fixture(db, 'fwd-audit-rollback');
    const before = await snapshots(db, session, employee.id);
    const commandId = randomUUID();
    const options = { ifMatch: later.employeeRevision, idempotencyKey: commandId, body: backfill() };
    await db.execute(sql`CREATE FUNCTION fwd_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic forward audit storage failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER fwd_test_fail_audit_trigger BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.object_id=${sql.raw(`'${later.id}'`)}) EXECUTE FUNCTION fwd_test_fail_audit()`);
    try {
      const response = await session.request('POST', `/employees/${employee.id}/businesses`, options);
      expect(response.status).toBe(500);
      expect(await snapshots(db, session, employee.id)).toEqual(before);
      expect((await session.getEmployee(employee.id)).revision).toBe(later.employeeRevision);
      const unchangedTarget = await session.request('GET', `/businesses/${later.id}`);
      expect(await unchangedTarget.json()).toMatchObject({ revision: later.revision });
      await withTenant(db, session.tenant.id, async (tx) => {
        for (const table of ['audit_events', 'employment_outbox', 'command_ledger']) {
          expect(
            resultRows(
              await tx.execute(sql`SELECT command_id FROM ${sql.identifier(table)}
              WHERE tenant_id=${session.tenant.id} AND command_id=${commandId}`),
            ),
          ).toEqual([]);
        }
      });
    } finally {
      await db.execute(sql`DROP TRIGGER fwd_test_fail_audit_trigger ON audit_events`);
      await db.execute(sql`DROP FUNCTION fwd_test_fail_audit()`);
    }
    expect((await session.request('POST', `/employees/${employee.id}/businesses`, options)).status).toBe(201);
    expect((await session.record(later.id)).fields).toMatchObject(changedFields);
  });

  it('预览列出待改记录字段且不写入任职、payload、员工revision或命令台账', async () => {
    const { db } = testDb();
    const { session, employee, later } = await fixture(db, 'fwd-preview-readonly');
    const before = await snapshots(db, session, employee.id);
    const commandId = randomUUID();
    const response = await session.request('POST', `/employees/${employee.id}/forward-update-preview`, {
      ifMatch: later.employeeRevision,
      idempotencyKey: commandId,
      body: backfill(),
    });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as { changes: unknown[] };
    expect(preview.changes.length).toBeGreaterThan(0);
    expect(JSON.stringify(preview.changes)).toContain(later.id);
    expect(JSON.stringify(preview.changes)).toContain('place');
    expect(JSON.stringify(preview.changes)).toContain(changedFields.place);
    expect(await snapshots(db, session, employee.id)).toEqual(before);
    expect((await session.getEmployee(employee.id)).revision).toBe(later.employeeRevision);
    const commands = await withTenant(db, session.tenant.id, async (tx) =>
      resultRows(
        await tx.execute(sql`SELECT command_id FROM command_ledger
        WHERE tenant_id=${session.tenant.id} AND command_id=${commandId}`),
      ),
    );
    expect(commands).toEqual([]);
  });

  it('申请制预览明确按生效日计算且提示生效时可能变化', async () => {
    const { db } = testDb();
    const { session, employee } = await fixture(db, 'fwd-preview-application-date');
    const response = await session.request('POST', `/employees/${employee.id}/forward-update-preview`, {
      body: { ...backfill(), mode: 'application' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ notice: '结果以生效时为准' });
  });
});
