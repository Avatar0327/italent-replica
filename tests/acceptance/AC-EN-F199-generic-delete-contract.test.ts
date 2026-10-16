/**
 * F-199 通用删除清理待入职合同（后端；#369 / F-194 Sol high 第 1 轮 P3，DEC-521②）：
 * 通用 DELETE /businesses/:id 删掉待入职业务时，待入职合同行与专用 DELETE /pending-entries/:id 一样同事务清理并留审计
 * （employment.entry.contract_release，前值留快照，DEC-019）；没有合同的业务不多写审计；
 * 清理失败整笔回滚（业务头、合同行、审计、命令台账都不变）；同命令重放不重复清理、不重复写审计。
 * 测试时钟 2026-10-01；业务日期都是合成数据。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { addPending, businessRevision, entryRecords, entryWorld, type EntryWorld } from './AC-EN-BE2a-support.js';

const testDb = useTestDb();
const RELEASE = 'employment.entry.contract_release';
const TABLE = 'employment_pending_entry_contract';

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

async function contractRows(w: EntryWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ businessId: string; startDate: string }>(
      await tx.execute(sql`SELECT business_id AS "businessId", start_date::text AS "startDate"
        FROM employment_pending_entry_contract WHERE tenant_id=${w.session.tenant.id} ORDER BY business_id`),
    ),
  );
}

async function auditRows(w: EntryWorld, action: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{
      objectId: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>(
      await tx.execute(sql`SELECT object_id AS "objectId", before, after
        FROM audit_events WHERE tenant_id=${w.session.tenant.id} AND action=${action} ORDER BY occurred_at, id`),
    ),
  );
}

async function ledgerCount(w: EntryWorld, commandId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const [row] = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM command_ledger
        WHERE tenant_id=${w.session.tenant.id} AND command_id=${commandId}`),
    );
    return row?.n ?? 0;
  });
}

/** 通用删除入口（不是 /pending-entries/:id）；idempotencyKey 可固定以验证重放。 */
async function genericDelete(w: EntryWorld, businessId: string, key: string = randomUUID()) {
  return w.session.request('DELETE', `/businesses/${businessId}`, {
    ifMatch: await businessRevision(w, businessId),
    idempotencyKey: key,
  });
}

describe('F-199 通用删除待入职业务清理待入职合同', () => {
  it('添加待入职后走通用 DELETE：合同行清零，留一条清理审计（前值快照），其他待入职的合同不动', async () => {
    const w = await entryWorld(testDb().db, 'f199-generic');
    const target = await addPending(w, '2026-10-17', '通用删除员工');
    const other = await addPending(w, '2026-10-18', '保留合同员工');
    expect(await contractRows(w)).toHaveLength(2);

    const deleted = await genericDelete(w, target.recordId);
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    expect(await entryRecords(w, target.employee.id)).toEqual([]);
    expect(await contractRows(w)).toMatchObject([{ businessId: other.recordId, startDate: '2026-10-18' }]);
    const released = await auditRows(w, RELEASE);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      objectId: target.recordId,
      before: { contractStartDate: '2026-10-17', contractEndDate: null },
      after: null,
    });
  });

  it('审计与专用删除路径一致：同样的动作名、对象与前后值键', async () => {
    const w = await entryWorld(testDb().db, 'f199-same-audit');
    const viaGeneric = await addPending(w, '2026-10-17', '通用路径员工');
    const viaDedicated = await addPending(w, '2026-10-19', '专用路径员工');
    expect((await genericDelete(w, viaGeneric.recordId)).status).toBe(200);
    const dedicated = await w.session.request('DELETE', `/pending-entries/${viaDedicated.recordId}`, {
      ifMatch: await businessRevision(w, viaDedicated.recordId),
    });
    expect(dedicated.status, await dedicated.clone().text()).toBe(200);

    const rows = await auditRows(w, RELEASE);
    expect(rows.map((row) => row.objectId).sort()).toEqual([viaGeneric.recordId, viaDedicated.recordId].sort());
    const shape = (row: (typeof rows)[number]) => ({
      keys: Object.keys(row.before ?? {}).sort(),
      after: row.after,
    });
    expect(shape(rows[0]!)).toEqual(shape(rows[1]!));
    expect(await contractRows(w)).toEqual([]);
  });
});

describe('F-199 不带待入职合同的业务走通用删除不变', () => {
  it('存量待入职（合同行不存在）与已入职业务：通用删除成功，不写清理审计', async () => {
    const w = await entryWorld(testDb().db, 'f199-nocontract');
    const legacy = await addPending(w, '2026-10-17', '存量待入职员工');
    // 存量待入职没有合同行（DEC-402 不回填）
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM employment_pending_entry_contract WHERE business_id=${legacy.recordId}::uuid`),
    );
    expect(await contractRows(w)).toEqual([]);
    const legacyDeleted = await genericDelete(w, legacy.recordId);
    expect(legacyDeleted.status, await legacyDeleted.clone().text()).toBe(200);

    const hired = await addPending(w, '2026-09-01', '已入职员工');
    const done = await w.session.request('POST', `/pending-entries/${hired.recordId}/complete`, {
      ifMatch: await businessRevision(w, hired.recordId),
      body: { probation: false },
    });
    expect(done.status, await done.clone().text()).toBe(200);
    // 办理入职本身会按 complete 清理合同并留审计；通用删除不得在此之上再多写
    const releasedOnComplete = await auditRows(w, RELEASE);
    expect(releasedOnComplete.map((row) => row.objectId)).toEqual([hired.recordId]);
    const hiredDeleted = await genericDelete(w, hired.recordId);
    expect(hiredDeleted.status, await hiredDeleted.clone().text()).toBe(200);

    expect(await auditRows(w, RELEASE)).toEqual(releasedOnComplete);
    expect(await auditRows(w, 'employment.business.delete')).toHaveLength(2);
  });
});

describe('F-199 清理失败整笔回滚', () => {
  it('合同行删除时抛错：业务头、合同行、审计、命令台账都不变；故障排除后同命令可成功', async () => {
    const w = await entryWorld(testDb().db, 'f199-rollback');
    const { recordId, employee } = await addPending(w, '2026-10-17', '回滚员工');
    const revision = await businessRevision(w, recordId);
    const key = randomUUID();
    const deleteAudits = await auditRows(w, 'employment.business.delete');
    await w.db.execute(sql`CREATE FUNCTION f199_test_fail_release() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic pending contract release failure'; END $$`);
    await w.db.execute(
      sql.raw(`CREATE TRIGGER f199_test_fail_release_trigger
      BEFORE DELETE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION f199_test_fail_release()`),
    );
    try {
      const failed = await genericDelete(w, recordId, key);
      expect(failed.status).toBe(500);
      expect(await businessRevision(w, recordId)).toBe(revision);
      expect(await entryRecords(w, employee.id)).toHaveLength(1);
      expect(await contractRows(w)).toMatchObject([{ businessId: recordId, startDate: '2026-10-17' }]);
      expect(await auditRows(w, RELEASE)).toEqual([]);
      expect(await auditRows(w, 'employment.business.delete')).toEqual(deleteAudits);
      expect(await ledgerCount(w, key)).toBe(0);
    } finally {
      await w.db.execute(sql.raw(`DROP TRIGGER f199_test_fail_release_trigger ON ${TABLE}`));
      await w.db.execute(sql`DROP FUNCTION f199_test_fail_release()`);
    }
    const retried = await genericDelete(w, recordId, key);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await contractRows(w)).toEqual([]);
    expect(await auditRows(w, RELEASE)).toHaveLength(1);
  });
});

describe('F-199 同命令重放', () => {
  it('同命令 ID 同内容重放：返回原结果，不重复清理、不重复写审计', async () => {
    const w = await entryWorld(testDb().db, 'f199-replay');
    const target = await addPending(w, '2026-10-17', '重放员工');
    const key = randomUUID();
    const revision = await businessRevision(w, target.recordId);
    const send = () =>
      w.session.request('DELETE', `/businesses/${target.recordId}`, { ifMatch: revision, idempotencyKey: key });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    const replay = await send();
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(await contractRows(w)).toEqual([]);
    expect(await auditRows(w, RELEASE)).toHaveLength(1);
    expect(await auditRows(w, 'employment.business.delete')).toHaveLength(1);
    expect(await ledgerCount(w, key)).toBe(1);
  });
});
