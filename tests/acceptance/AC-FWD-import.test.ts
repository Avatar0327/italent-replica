import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();

async function fixture(db: Db, label: string, future = true) {
  const session = await employmentSession(db, label);
  const employee = await session.employee();
  const org = await session.org('合成在职部门', { startDate: '2026-01-01' });
  const current = await session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: org.id, place: '原地点' } },
    employee.revision,
  );
  const later = await session.business(
    employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: future ? '2026-11-01' : '2026-09-20' },
    current.employeeRevision,
  );
  return { session, employee, current, later };
}

async function immutableSnapshot(db: Db, session: EmploymentSession, employeeId: string) {
  return withTenant(db, session.tenant.id, async (tx) => ({
    records: resultRows(
      await tx.execute(sql`SELECT * FROM employment_records
      WHERE tenant_id=${session.tenant.id} AND employee_id=${employeeId} ORDER BY id`),
    ),
    payloads: resultRows(
      await tx.execute(sql`SELECT * FROM employment_payload_versions
      WHERE tenant_id=${session.tenant.id} AND employee_id=${employeeId} ORDER BY business_id,version_no`),
    ),
    heads: resultRows(
      await tx.execute(sql`SELECT * FROM employment_business_objects
      WHERE tenant_id=${session.tenant.id} AND employee_id=${employeeId} ORDER BY id`),
    ),
    employee: resultRows(
      await tx.execute(sql`SELECT * FROM employment_employees
      WHERE tenant_id=${session.tenant.id} AND id=${employeeId}`),
    ),
  }));
}

async function commandRows(db: Db, session: EmploymentSession, commandId: string) {
  return withTenant(db, session.tenant.id, async (tx) => {
    const result: Record<string, unknown[]> = {};
    for (const table of ['audit_events', 'employment_outbox', 'command_ledger']) {
      result[table] = resultRows(
        await tx.execute(sql`SELECT * FROM ${sql.identifier(table)}
        WHERE tenant_id=${session.tenant.id} AND command_id=${commandId}`),
      );
    }
    return result;
  });
}

function createItem(effectiveDate: string, place: string) {
  return { operation: 'create', business: { kind: 'transfer', mode: 'direct', effectiveDate, fields: { place } } };
}

describe('AC-FWD-08/10 导入批次的提交前revision与原子传播', () => {
  it('当前A先传播到未来B后，批次中B仍接受提交前revision并保留A刚传播的字段', async () => {
    const { db } = testDb();
    const { session, employee, current, later } = await fixture(db, 'fwd-import-original-revisions');
    const commandId = randomUUID();
    const response = await session.request('POST', `/employees/${employee.id}/import`, {
      ifMatch: later.employeeRevision,
      idempotencyKey: commandId,
      body: {
        items: [
          {
            operation: 'edit',
            id: current.id,
            revision: current.revision,
            patch: { fields: { place: '批次同步地点' } },
          },
          {
            operation: 'edit',
            id: later.id,
            revision: later.revision,
            patch: { fields: { remarks: '未来记录独立备注' } },
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    expect((await session.record(current.id)).fields.place).toBe('批次同步地点');
    expect((await session.record(later.id)).fields).toMatchObject({
      place: '批次同步地点',
      remarks: '未来记录独立备注',
    });
    const saved = await session.request('GET', `/businesses/${later.id}`);
    expect(await saved.json()).toMatchObject({ revision: later.revision + 2 });
    const audits = (await commandRows(db, session, commandId)).audit_events;
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object_id: later.id,
          before: expect.objectContaining({ place: '原地点' }),
          after: expect.objectContaining({ place: '批次同步地点' }),
        }),
        expect.objectContaining({
          object_id: later.id,
          after: expect.objectContaining({ remarks: '未来记录独立备注' }),
        }),
      ]),
    );
  });

  it('批次中外部已改过的B必须在A产生任何写入前返回409，整个批次不落库', async () => {
    const { db } = testDb();
    const { session, employee, current, later } = await fixture(db, 'fwd-import-stale-preflight');
    const externalEdit = await session.request('PATCH', `/records/${later.id}`, {
      ifMatch: later.revision,
      body: { fields: { remarks: '外部先修改' } },
    });
    expect(externalEdit.status).toBe(200);
    const original = await immutableSnapshot(db, session, employee.id);
    const commandId = randomUUID();
    await db.execute(sql`CREATE FUNCTION fwd_import_detect_early_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'batch revisions must be checked before its first payload write'; END $$`);
    await db.execute(sql`CREATE TRIGGER fwd_import_detect_early_write_trigger
      BEFORE INSERT ON employment_payload_versions FOR EACH ROW
      WHEN (NEW.business_id=${sql.raw(`'${current.id}'::uuid`)})
      EXECUTE FUNCTION fwd_import_detect_early_write()`);
    try {
      const response = await session.request('POST', `/employees/${employee.id}/import`, {
        ifMatch: (await session.getEmployee(employee.id)).revision,
        idempotencyKey: commandId,
        body: {
          items: [
            {
              operation: 'edit',
              id: current.id,
              revision: current.revision,
              patch: { fields: { place: '不应先执行' } },
            },
            {
              operation: 'edit',
              id: later.id,
              revision: later.revision,
              patch: { fields: { remarks: '过期客户端输入' } },
            },
          ],
        },
      });
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('REVISION_CONFLICT');
      expect(await immutableSnapshot(db, session, employee.id)).toEqual(original);
      expect(await commandRows(db, session, commandId)).toEqual({
        audit_events: [],
        employment_outbox: [],
        command_ledger: [],
      });
    } finally {
      await db.execute(sql`DROP TRIGGER fwd_import_detect_early_write_trigger ON employment_payload_versions`);
      await db.execute(sql`DROP FUNCTION fwd_import_detect_early_write()`);
    }
  });

  it('一个命令里的两条新业务可连续传播同一后续记录，每次版本都有独立审计与outbox', async () => {
    const { db } = testDb();
    const { session, employee, later } = await fixture(db, 'fwd-import-repeated-target', false);
    const commandId = randomUUID();
    const response = await session.request('POST', `/employees/${employee.id}/import`, {
      ifMatch: later.employeeRevision,
      idempotencyKey: commandId,
      body: { items: [createItem('2026-09-10', '第一次同步'), createItem('2026-09-15', '第二次同步')] },
    });
    expect(response.status).toBe(200);
    expect((await session.record(later.id)).fields.place).toBe('第二次同步');
    const { versions, audits, events } = await withTenant(db, session.tenant.id, async (tx) => ({
      versions: resultRows<Record<string, unknown>>(
        await tx.execute(sql`SELECT id,previous_version_id,trigger_business_id,place FROM employment_payload_versions
          WHERE tenant_id=${session.tenant.id} AND business_id=${later.id} AND command_id=${commandId}
          ORDER BY version_no`),
      ),
      audits: resultRows(
        await tx.execute(sql`SELECT before,after FROM audit_events
        WHERE tenant_id=${session.tenant.id} AND object_id=${later.id} AND command_id=${commandId}`),
      ),
      events: resultRows<{ event_type: string; payload_version_id: string; payload: unknown }>(
        await tx.execute(sql`SELECT event_type,payload_version_id,payload FROM employment_outbox
        WHERE tenant_id=${session.tenant.id} AND object_id=${later.id} AND command_id=${commandId}`),
      ),
    }));
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.place)).toEqual(['第一次同步', '第二次同步']);
    expect(versions[1]!.previous_version_id).toBe(versions[0]!.id);
    expect(new Set(versions.map((version) => version.trigger_business_id)).size).toBe(2);
    expect(audits).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.event_type)).toEqual(['employment.forward-update', 'employment.forward-update']);
    expect(new Set(events.map((event) => event.payload_version_id)).size).toBe(2);
    for (const [before, after] of [
      ['原地点', '第一次同步'],
      ['第一次同步', '第二次同步'],
    ]) {
      const values = {
        before: expect.objectContaining({ place: before }),
        after: expect.objectContaining({ place: after }),
      };
      expect(audits).toContainEqual(expect.objectContaining(values));
      expect(events).toContainEqual(expect.objectContaining({ payload: expect.objectContaining(values) }));
    }
  });

  it('中途引用校验失败会回滚此前已插入业务及向后更新，修正后原命令可重试', async () => {
    const { db } = testDb();
    const { session, employee, later } = await fixture(db, 'fwd-import-rollback', false);
    const original = await immutableSnapshot(db, session, employee.id);
    const commandId = randomUUID();
    const first = createItem('2026-09-10', '首行暂存地点');
    const second = createItem('2026-09-15', '次行有效地点');
    const options = {
      ifMatch: later.employeeRevision,
      idempotencyKey: commandId,
      body: {
        items: [first, { ...second, business: { ...second.business, fields: { departmentId: randomUUID() } } }],
      },
    };
    const rejected = await session.request('POST', `/employees/${employee.id}/import`, options);
    expect(rejected.status).toBe(400);
    expect(await errorCode(rejected)).toBe('VALIDATION_FAILED');
    expect(await immutableSnapshot(db, session, employee.id)).toEqual(original);
    expect(await commandRows(db, session, commandId)).toEqual({
      audit_events: [],
      employment_outbox: [],
      command_ledger: [],
    });
    const retried = await session.request('POST', `/employees/${employee.id}/import`, {
      ...options,
      body: { items: [first, second] },
    });
    expect(retried.status).toBe(200);
    expect((await session.record(later.id)).fields.place).toBe('次行有效地点');
    expect(await session.records(employee.id)).toHaveLength(4);
  });
});
