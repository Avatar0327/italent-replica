/** C2-1b：业务走真实任职入口，评定由底座 SQL 夹具创建（C2-2 尚未提供申报入口）。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrationsFolder, sql, withTenant, type Db, type Tx } from '@italent/db';
import { expect } from 'vitest';
import { activityWorld, activityFixtures } from './AC-EV-activity-support.js';
import { EV_NOW } from './AC-EV-support.js';
import { rowsOf } from './AC-EMP-F055-support.js';
export { rowsOf };

export async function evaluationLeaveWorld(db: Db) {
  const w = await activityWorld(db);
  const f = await activityFixtures(w);
  const activity = await w.adminActivity(f.body());
  const tenantId = w.tenant.id;
  const ctx = (at = '2026-10-21T08:00:00Z') => ({
    tenantId,
    userId: w.asAdmin.user,
    timezone: 'Asia/Shanghai',
    now: new Date(at),
    commandId: randomUUID(),
    expectedRevision: 0,
  });
  async function business(employeeId: string, body: Record<string, unknown>) {
    const response = await w.setup.request('GET', `/api/tenant/employment/employees/${employeeId}`, w.asAdmin);
    const employee = (await response.json()) as { revision: number };
    const saved = await w.setup.request('POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
      ...w.asAdmin,
      ifMatch: employee.revision,
      body,
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    return (await saved.json()) as { id: string; revision: number };
  }
  const leave = (lastWorkDate = '2026-10-20', employeeId = f.mgrA.id, kind = 'leave') =>
    business(employeeId, { kind, mode: 'direct', lastWorkDate });
  async function remove(record: { id: string; revision: number }) {
    const res = await w.setup.request('DELETE', `/api/tenant/employment/businesses/${record.id}`, {
      ...w.asAdmin,
      ifMatch: record.revision,
    });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  async function cycle(employeeId = f.mgrA.id) {
    return withTenant(
      db,
      tenantId,
      async (tx) =>
        rowsOf<{ id: string }>(
          await tx.execute(sql`
      SELECT id FROM employment_cycles WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
      ORDER BY entry_date DESC LIMIT 1`),
        )[0]!.id,
    );
  }
  async function seed(values: Record<string, unknown> = {}, employeeId = f.mgrA.id, cycleId?: string) {
    const id = randomUUID();
    const staffId = cycleId ?? (await cycle(employeeId));
    await withTenant(db, tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO ev_staff_evaluations
        (id, tenant_id, activity_id, employee_id, cycle_id, source, initiator_user_id,
          apply_category_id, apply_level_id, created_by)
        VALUES (${id}, ${tenantId}, ${activity.id}, ${employeeId}, ${staffId}, 'self',
          ${w.asAdmin.user}, ${f.cat1.id}, ${f.lv1.id}, ${w.asAdmin.user})`);
      if (Object.keys(values).length)
        await tx.execute(sql`UPDATE ev_staff_evaluations SET
        ${sql.join(
          Object.entries(values).map(([key, value]) => sql`${sql.identifier(key)}=${value}`),
          sql`, `,
        )}
        WHERE tenant_id=${tenantId} AND id=${id}::uuid`);
    });
    return id;
  }
  const read = (id: string) =>
    withTenant(
      db,
      tenantId,
      async (tx) =>
        rowsOf<Record<string, unknown>>(
          await tx.execute(sql`SELECT * FROM ev_staff_evaluations WHERE tenant_id=${tenantId} AND id=${id}::uuid`),
        )[0]!,
    );
  const queue = (id: string) =>
    withTenant(db, tenantId, async (tx) =>
      rowsOf<{ state: string; reason: string | null; attempts: number }>(
        await tx.execute(sql`SELECT state, reason, attempts FROM ev_sync_queue
      WHERE tenant_id=${tenantId} AND handler='evaluation_leave' AND record_id=${id}::uuid`),
      ),
    );
  return { ...w, f, db, tenantId, activity, ctx, business, leave, remove, cycle, seed, read, queue, now: EV_NOW };
}

export function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function waitForLock(db: Db, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('第二个事务未等待数据库锁');
    const [waiting] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (waiting!.n > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('未观测到真实锁等待');
}
export async function lockEvaluation(tx: Tx, tenantId: string, id: string) {
  await tx.execute(sql`SELECT id FROM ev_staff_evaluations WHERE tenant_id=${tenantId} AND id=${id}::uuid FOR UPDATE`);
}

export const LEAVE_MIGRATION = '_evaluation_leave';
export async function replayLeaveMigration(db: Db | Tx) {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const tag = journal.entries.find((entry) => entry.tag.endsWith(LEAVE_MIGRATION))!.tag;
  const source = readFileSync(join(migrationsFolder, `${tag}.sql`), 'utf8');
  await db.transaction(async (tx) => {
    for (const statement of source.split('--> statement-breakpoint')) {
      if (statement.trim()) await tx.execute(sql.raw(statement));
    }
  });
}
