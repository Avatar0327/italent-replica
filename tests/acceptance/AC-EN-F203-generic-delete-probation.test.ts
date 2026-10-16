/**
 * F-203 通用删除清理待入职试用期行（后端；#373 / F-199 Sol high 第 1 轮 P3-1，DEC-521②）：
 * 通用 DELETE /businesses/:id 删掉待入职业务时，与专用 DELETE /pending-entries/:id 一样同事务清理
 * employment_pending_entry_probation 行（统一删除内核收口）；删除失败整笔回滚、行不被删；其他业务与其他租户的行不动。
 * 测试时钟 2026-10-01；业务日期都是合成数据。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  addHire,
  businessRevision,
  entryAction,
  entryRecords,
  entryWorld,
  hireBody,
  type EntryWorld,
} from './AC-EN-BE2a-support.js';

const testDb = useTestDb();
const TABLE = 'employment_pending_entry_probation';

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

/** 添加带试用期的待入职（pendingEntry + probation）。 */
async function addPendingWithProbation(w: EntryWorld, effectiveDate: string, name: string, probation = true) {
  const employee = await w.session.employee(name);
  const response = await addHire(
    w.session,
    employee,
    hireBody(w.org.id, effectiveDate, { pendingEntry: true, probation }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  const business = (await response.json()) as { record: { id: string } };
  return { employee, recordId: business.record.id };
}

async function probationRows(w: EntryWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ businessId: string; probation: boolean }>(
      await tx.execute(sql`SELECT business_id AS "businessId", probation
        FROM employment_pending_entry_probation WHERE tenant_id=${w.session.tenant.id} ORDER BY business_id`),
    ),
  );
}

async function genericDelete(w: EntryWorld, businessId: string, key: string = randomUUID()) {
  return w.session.request('DELETE', `/businesses/${businessId}`, {
    ifMatch: await businessRevision(w, businessId),
    idempotencyKey: key,
  });
}

describe('F-203 通用删除待入职业务清理试用期行', () => {
  it('带 probation:true 添加后走通用 DELETE：试用期行清零，其他待入职的行不动', async () => {
    const w = await entryWorld(testDb().db, 'f203-generic');
    const target = await addPendingWithProbation(w, '2026-10-17', '通用删除员工');
    const other = await addPendingWithProbation(w, '2026-10-18', '保留试用期员工', false);
    expect(await probationRows(w)).toHaveLength(2);

    const deleted = await genericDelete(w, target.recordId);
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    expect(await entryRecords(w, target.employee.id)).toEqual([]);
    expect(await probationRows(w)).toEqual([{ businessId: other.recordId, probation: false }]);
  });

  it('专用 DELETE /pending-entries/:id 行为不变：同样清零', async () => {
    const w = await entryWorld(testDb().db, 'f203-dedicated');
    const target = await addPendingWithProbation(w, '2026-10-17', '专用删除员工');
    const deleted = await w.session.request('DELETE', `/pending-entries/${target.recordId}`, {
      ifMatch: await businessRevision(w, target.recordId),
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await probationRows(w)).toEqual([]);
  });

  it('删除后同一员工再添加待入职、再办理入职不被拒；已删业务的办理入职 / 改期仍按“已删除”拒绝', async () => {
    const w = await entryWorld(testDb().db, 'f203-followup');
    const first = await addPendingWithProbation(w, '2026-10-17', '重新添加员工');
    expect((await genericDelete(w, first.recordId)).status).toBe(200);
    expect(await probationRows(w)).toEqual([]);

    for (const action of ['complete', 'postpone'] as const) {
      const body = action === 'complete' ? { probation: false } : { effectiveDate: '2026-10-25' };
      const rejected = await entryAction(w, first.recordId, action, body);
      expect(rejected.status, action).toBeGreaterThanOrEqual(400);
    }

    const again = await addHire(
      w.session,
      await w.session.getEmployee(first.employee.id),
      hireBody(w.org.id, '2026-10-20', { pendingEntry: true, probation: true }),
    );
    expect(again.status, await again.clone().text()).toBe(201);
    const { record } = (await again.json()) as { record: { id: string } };
    expect(await probationRows(w)).toEqual([{ businessId: record.id, probation: true }]);
    const done = await entryAction(w, record.id, 'complete', { probation: false });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await probationRows(w)).toEqual([]);
  });
});

describe('F-203 删除失败整笔回滚', () => {
  it('If-Match 不符被拒：业务与试用期行都不变', async () => {
    const w = await entryWorld(testDb().db, 'f203-ifmatch');
    const { recordId } = await addPendingWithProbation(w, '2026-10-17', '版本冲突员工');
    const revision = await businessRevision(w, recordId);
    const rejected = await w.session.request('DELETE', `/businesses/${recordId}`, {
      ifMatch: revision + 1,
      idempotencyKey: randomUUID(),
    });
    expect(rejected.status).toBe(409);
    expect(await businessRevision(w, recordId)).toBe(revision);
    expect(await probationRows(w)).toEqual([{ businessId: recordId, probation: true }]);
  });

  it('试用期行删除时抛错：业务头与试用期行都不变；故障排除后同命令可成功', async () => {
    const w = await entryWorld(testDb().db, 'f203-rollback');
    const { recordId, employee } = await addPendingWithProbation(w, '2026-10-17', '回滚员工');
    const revision = await businessRevision(w, recordId);
    const key = randomUUID();
    await w.db.execute(sql`CREATE FUNCTION f203_test_fail_clear() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic pending probation clear failure'; END $$`);
    await w.db.execute(
      sql.raw(`CREATE TRIGGER f203_test_fail_clear_trigger
      BEFORE DELETE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION f203_test_fail_clear()`),
    );
    try {
      const failed = await genericDelete(w, recordId, key);
      expect(failed.status).toBe(500);
      expect(await businessRevision(w, recordId)).toBe(revision);
      expect(await entryRecords(w, employee.id)).toHaveLength(1);
      expect(await probationRows(w)).toEqual([{ businessId: recordId, probation: true }]);
    } finally {
      await w.db.execute(sql.raw(`DROP TRIGGER f203_test_fail_clear_trigger ON ${TABLE}`));
      await w.db.execute(sql`DROP FUNCTION f203_test_fail_clear()`);
    }
    const retried = await genericDelete(w, recordId, key);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await probationRows(w)).toEqual([]);
  });
});

describe('F-203 跨租户隔离', () => {
  it('租户 A 通用删除不动租户 B 的试用期行', async () => {
    const a = await entryWorld(testDb().db, 'f203-tenant-a');
    const b = await entryWorld(testDb().db, 'f203-tenant-b');
    const inA = await addPendingWithProbation(a, '2026-10-17', 'A 租户员工');
    const inB = await addPendingWithProbation(b, '2026-10-17', 'B 租户员工');
    expect((await genericDelete(a, inA.recordId)).status).toBe(200);
    expect(await probationRows(a)).toEqual([]);
    expect(await probationRows(b)).toEqual([{ businessId: inB.recordId, probation: true }]);
  });
});
