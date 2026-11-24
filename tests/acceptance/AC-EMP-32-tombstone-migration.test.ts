/**
 * F-036 S5 第 6 轮（DEC-991 方案 B，DEC-913 升级用例）：迁移 0230 给删除墓碑加可空列 timeline_start_date。
 * 升级前已有的墓碑不回填（DEC-402），保持为空；升级后删除仍在时间轴上的已生效业务，记下它在轴上的生效日。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { EMP_TODAY, employmentSession } from './AC-EMP-support.js';

const database = useTestDb({ migrateBefore: '_f036_tombstone_timeline_start' });
const rows = <T>(v: unknown) => (Array.isArray(v) ? v : (v as { rows: T[] }).rows) as T[];

it('AC-EMP-32-migration：新列为可空 date；升级前的墓碑为空，升级后删除记下删除前的时间轴生效日', async () => {
  const db = database().db;
  const s = await employmentSession(db, `emp32-tombstone-migration`);
  const from = await s.org('合成调出部门', { establishedOn: '2025-01-01' });
  const to = await s.org('合成调入部门', { establishedOn: '2025-01-01' });
  const employee = await s.employee('迁移员工');
  await s.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: from.id } },
    employee.revision,
  );
  /** 当天生效的直接调动，随即被 HR 删除（删除前在时间轴上、已到期）。 */
  const transferredThenDeleted = async (departmentId: string) => {
    const current = await s.getEmployee(employee.id);
    const transfer = await s.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: EMP_TODAY, fields: { departmentId } },
      current.revision,
    );
    expect(transfer.status).toBe('effective');
    const deleted = await s.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: transfer.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    return transfer.id;
  };
  const before = await transferredThenDeleted(to.id);

  await database().migrate();

  const [column] = rows<{ data_type: string; is_nullable: string }>(
    await db.execute(sql`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'employment_record_tombstones'
        AND column_name = 'timeline_start_date'`),
  );
  expect(column).toEqual({ data_type: 'date', is_nullable: 'YES' });
  const after = await transferredThenDeleted(to.id);
  const tombstones = await withTenant(db, s.tenant.id, async (tx) =>
    rows<{ record_id: string; timeline_start_date: string | null }>(
      await tx.execute(sql`SELECT record_id::text, timeline_start_date::text FROM employment_record_tombstones
        WHERE tenant_id = ${s.tenant.id}::uuid`),
    ),
  );
  // 两次删除共用同一时钟，created_at 相同，按记录比对，不靠行序
  expect(Object.fromEntries(tombstones.map((row) => [row.record_id, row.timeline_start_date]))).toEqual({
    [before]: null,
    [after]: EMP_TODAY,
  });
});
