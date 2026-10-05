import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, withLoginEmail } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-support.js';

const testDb = useTestDb();

describe('DEC-019 任职字段审计与 outbox 原子提交', () => {
  it('补录审计的变更前取插入点前一条，事件与命令关联且同键重放不重复发送', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'emp-audit-before');
    const employee = await session.employee();
    const department = await session.org('合成审计部门', { establishedOn: '2026-01-01' });
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: department.id, place: '插入点前地点' },
      },
      employee.revision,
    );
    const later = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        fields: { place: '后续地点' },
      },
      hire.employeeRevision,
    );
    const commandId = randomUUID();
    const options = {
      ifMatch: later.employeeRevision,
      idempotencyKey: commandId,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-10', fields: { place: '补录地点' } },
    };
    expect((await session.request('POST', `/employees/${employee.id}/businesses`, options)).status).toBe(201);
    const snapshots = () =>
      withTenant(db, session.tenant.id, async (tx) => ({
        audits: resultRows(
          await tx.execute(sql`
        SELECT actor_user_id,before,after FROM audit_events
        WHERE command_id=${commandId} AND action='employment.record.create' LIMIT 1
      `),
        ),
        events: resultRows(
          await tx.execute(sql`
        SELECT id,event_type,payload FROM employment_outbox WHERE command_id=${commandId} ORDER BY id LIMIT 10
      `),
        ),
      }));
    const original = await snapshots();
    expect(original.audits).toEqual([
      expect.objectContaining({
        actor_user_id: session.user.id,
        before: expect.objectContaining({ place: '插入点前地点' }),
        after: expect.objectContaining({ place: '补录地点' }),
      }),
    ]);
    expect(original.events).toContainEqual(
      expect.objectContaining({
        event_type: 'employment.record.create',
        payload: expect.objectContaining({
          before: expect.objectContaining({ place: '插入点前地点' }),
          after: expect.objectContaining({ place: '补录地点' }),
        }),
      }),
    );
    expect((await session.request('POST', `/employees/${employee.id}/businesses`, options)).status).toBe(201);
    expect(await snapshots()).toEqual(original);
  });

  it.each(['audit_events', 'employment_outbox'] as const)(
    '%s 写入失败则任职、版本号和命令台账全部回滚',
    async (table) => {
      const { db } = testDb();
      const session = await employmentSession(db, `emp-rollback-${table}`);
      const employee = await session.employee();
      const commandId = randomUUID();
      const options = {
        ifMatch: employee.revision,
        idempotencyKey: commandId,
        body: withLoginEmail(employee.id, { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01' }),
      };
      await db.execute(sql`CREATE FUNCTION emp_test_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic event storage unavailable'; END $$`);
      await db.execute(sql`CREATE TRIGGER emp_test_fail_event_trigger
      BEFORE INSERT ON ${sql.identifier(table)} FOR EACH ROW EXECUTE FUNCTION emp_test_fail_event()`);
      try {
        const failed = await session.request('POST', `/employees/${employee.id}/businesses`, options);
        expect(failed.status).toBe(500);
        expect(await session.records(employee.id)).toEqual([]);
        expect((await session.getEmployee(employee.id)).revision).toBe(employee.revision);
        await withTenant(db, session.tenant.id, async (tx) => {
          for (const name of ['employment_business_objects', 'employment_cycles', 'employment_payload_versions']) {
            expect(resultRows(await tx.execute(sql`SELECT id FROM ${sql.identifier(name)} LIMIT 1`))).toEqual([]);
          }
          for (const name of ['audit_events', 'employment_outbox', 'command_ledger']) {
            expect(
              resultRows(
                await tx.execute(sql`
            SELECT command_id FROM ${sql.identifier(name)} WHERE command_id=${commandId} LIMIT 1
          `),
              ),
            ).toEqual([]);
          }
        });
      } finally {
        await db.execute(sql`DROP TRIGGER emp_test_fail_event_trigger ON ${sql.identifier(table)}`);
        await db.execute(sql`DROP FUNCTION emp_test_fail_event()`);
      }
      expect((await session.request('POST', `/employees/${employee.id}/businesses`, options)).status).toBe(201);
      expect(await session.records(employee.id)).toHaveLength(1);
    },
  );
});
