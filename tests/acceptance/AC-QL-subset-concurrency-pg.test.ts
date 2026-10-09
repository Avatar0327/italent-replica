/**
 * R3-T02 C1-1 真 PostgreSQL 强制交错（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行；拆分方案第 13 节）：
 * 子集写入引用类别 / 级别时（assertQualificationRefs，被引用行 FOR SHARE）与配置侧停用 / 删除串行：
 * - 停用在途：新增子集必须等锁，提交后按新状态复核 → 400 REFERENCE_DISABLED，不留行；
 * - 删除在途：新增子集等锁，提交后类别已不存在 → 404，不留行；
 * - 反向：子集写入在途（已锁定并写入引用）时删除类别必须等锁，提交后看到引用 → 409 CATEGORY_IN_USE（不是外键 500）。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { QL_BASE } from './AC-QL-support.js';
import { subsetScene } from './AC-QL-subset-support.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForLock(db: Db, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('写请求未等待真实数据库锁');
    const waiting = rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%ql\\_%'`),
    );
    if (waiting[0]!.n > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('未观测到写请求的真实锁等待');
}

/** 测试侧事务先执行 `hold`（拿锁并改状态），写请求必须等锁；提交后返回写请求的响应。 */
async function interleave(
  db: Db,
  tenantId: string,
  hold: (tx: Tx) => Promise<void>,
  write: () => Promise<Response>,
): Promise<Response> {
  const held = signal();
  const release = signal();
  const holder = withTenant(db, tenantId, async (tx) => {
    await hold(tx);
    held.resolve();
    await release.promise;
  });
  await held.promise;
  let finished = false;
  const pending = write().then((response) => {
    finished = true;
    return response;
  });
  try {
    await waitForLock(db, () => finished);
  } finally {
    release.resolve();
    await holder;
  }
  return pending;
}

const reasonOf = async (response: Response) =>
  ((await response.clone().json()) as { error?: { details?: { reason?: string } } }).error?.details?.reason;

describe.runIf(realPostgres)('AC-QL-subset 真 PG：子集引用与配置停用 / 删除串行（assertQualificationRefs）', () => {
  it('类别在新增等锁期间被停用 → 400 REFERENCE_DISABLED，不留行', async () => {
    const { w, add, rows: subsetRows, catalog } = await subsetScene(database, 'qs-pg-disable');
    const response = await interleave(
      database().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM ql_categories WHERE tenant_id = ${w.tenant.id} AND id = ${catalog.category.id} FOR UPDATE`,
        );
        await tx.execute(
          sql`UPDATE ql_categories SET enabled = false
            WHERE tenant_id = ${w.tenant.id} AND id = ${catalog.category.id}`,
        );
      },
      () => add(),
    );
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await reasonOf(response)).toBe('REFERENCE_DISABLED');
    expect(await subsetRows()).toEqual([]);
  });

  it('类别在新增等锁期间被删除 → 404，不留行', async () => {
    const { w, add, rows: subsetRows, catalog } = await subsetScene(database, 'qs-pg-delete');
    const response = await interleave(
      database().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(
          sql`DELETE FROM ql_categories WHERE tenant_id = ${w.tenant.id} AND id = ${catalog.otherCategory.id}`,
        );
      },
      () => add({ categoryId: catalog.otherCategory.id }),
    );
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await subsetRows()).toEqual([]);
  });

  it('子集写入在途（已锁定并写入引用）时删除类别必须等锁 → 提交后 409 CATEGORY_IN_USE，不是外键 500', async () => {
    const { w, s, catalog } = await subsetScene(database, 'qs-pg-delete-reverse');
    const response = await interleave(
      database().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM ql_categories WHERE tenant_id = ${w.tenant.id} AND id = ${catalog.category.id} FOR SHARE`,
        );
        await tx.execute(sql`INSERT INTO personnel_qualification
          (tenant_id, employee_id, category_id, level_id, start_date, source_type, created_by, command_id)
          VALUES (${w.tenant.id}, ${s.subject.employeeId}, ${catalog.category.id}, ${catalog.level.id},
            '2026-01-01', 'hr_direct', ${w.hr.id}, ${randomUUID()})`);
      },
      () =>
        w.request(w.hr.id, 'DELETE', `${QL_BASE}/categories/${catalog.category.id}`, {
          ifMatch: catalog.category.revision,
        }),
    );
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await reasonOf(response)).toBe('CATEGORY_IN_USE');
  });
});
