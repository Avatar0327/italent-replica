/** F-480 / DEC-797 返工：转正新开 staffId，实习段已同步的任职经历要在转正日前一天封口，删除转正后恢复。 */
import { randomUUID } from 'node:crypto';
import { sql, upsertSystemSetting, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, expect, it } from 'vitest';
import { internWorld } from './AC-EMP-F480-support.js';

const db = useTestDb();
const SYNC = 'EntrySyncJobHistory';

beforeAll(async () => {
  await upsertSystemSetting(
    db().db,
    { key: SYNC, value: false, description: SYNC, overridable: true, expectedVersion: 0 },
    { actorUserId: null, commandId: randomUUID() },
  );
});

type History = { recordId: string; startDate: string; endDate: string | null; revision: number; deleted: boolean };

async function world(label: string) {
  const w = await internWorld(db().db, label);
  const { tenant, user } = w.s;
  await withTenant(db().db, tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO tenant_setting_overrides
      (tenant_id,key,value,active,revision,updated_by) VALUES(${tenant.id},${SYNC},'true'::jsonb,true,1,${user.id})`),
  );
  const rows = async (employeeId: string): Promise<History[]> =>
    withTenant(db().db, tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT employment_record_id AS "recordId", start_date::text AS "startDate",
        end_date::text AS "endDate", revision, deleted FROM personnel_job_history
        WHERE tenant_id=${tenant.id} AND employee_id=${employeeId}::uuid ORDER BY start_date,revision`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as History[];
    });
  const audits = async (historyId: string): Promise<number> =>
    withTenant(db().db, tenant.id, async (tx) => {
      const result = await tx.execute(
        sql`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=${tenant.id} AND object_id=${historyId}`,
      );
      return Number(((Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { n: number }[])[0]!.n);
    });
  const historyId = async (recordId: string): Promise<string> =>
    withTenant(db().db, tenant.id, async (tx) => {
      const result = await tx.execute(
        sql`SELECT id FROM personnel_job_history
          WHERE tenant_id=${tenant.id} AND employment_record_id=${recordId}::uuid`,
      );
      return ((Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { id: string }[])[0]!.id;
    });
  return { ...w, rows, audits, historyId };
}

it('AC-EMP-F480-10：开启入职经历同步 → 实习入职 → 转正：实习段经历在转正日前一天封口，转正后的任职另有经历', async () => {
  const w = await world('hist-seal');
  const { e, hire } = await w.intern('2025-01-01');
  expect(await w.rows(e.id)).toMatchObject([{ recordId: hire.id, startDate: '2025-01-01', endDate: null }]);
  const reg = await w.regularize(e.id, { date: '2026-10-01' });
  const history = await w.rows(e.id);
  const intern = history.filter((row) => row.recordId === hire.id);
  expect(intern.at(-1)).toMatchObject({ startDate: '2025-01-01', endDate: '2026-09-30', deleted: false });
  expect(intern.at(-1)!.revision).toBe(2);
  expect(history.filter((row) => row.recordId === reg.id).at(-1)).toMatchObject({
    startDate: '2026-10-01',
    endDate: null,
  });
  expect(await w.audits(await w.historyId(hire.id))).toBe(2); // 新建 + 封口各一条
});

it('AC-EMP-F480-11：删除转正后，实习段经历恢复为开放，转正段经历被删除；版本与审计各多一条', async () => {
  const w = await world('hist-restore');
  const { e, hire } = await w.intern('2025-01-01');
  const reg = await w.regularize(e.id, { date: '2026-10-01' });
  const removed = await w.remove(reg);
  expect(removed.status, await removed.clone().text()).toBe(200);
  const history = await w.rows(e.id);
  expect(history.filter((row) => row.recordId === hire.id).at(-1)).toMatchObject({
    startDate: '2025-01-01',
    endDate: null,
    deleted: false,
    revision: 3,
  });
  expect(history.filter((row) => row.recordId === reg.id).at(-1)).toMatchObject({ deleted: true });
  expect(await w.audits(await w.historyId(hire.id))).toBe(3);
});
