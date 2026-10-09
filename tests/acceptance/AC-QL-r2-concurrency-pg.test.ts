/**
 * R3-T02 PR-A 第 2 轮：真 PostgreSQL 强制交错（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）。
 * 测试侧另开一个事务先拿行锁并改状态，写请求必须真的等这把锁，提交后按新状态复核：
 * - P2-07 引用状态检查与写入之间加锁（锁序 标准 → 指标 → 等级明细）：标准明细导入（通用 / 停用）、标准新建的目标
 *   等级、指标等级描述 PUT、等级方案删明细（反向：明细刚被引用）；
 * - P3 并发唯一冲突一律 409（不是 500）：同类别建标准、同岗职务关联、等级方案改成同名。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type GradeSchemeView, qualificationWorld, type StandardView } from './AC-QL-support.js';

const testDb = useTestDb();
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

const reason = async (response: Response) =>
  ((await response.clone().json()) as { error?: { details?: { reason?: string; receipts?: { reason: string }[] } } })
    .error?.details;

async function gradeWorld(label: string) {
  const w = await qualificationWorld(testDb().db, label);
  const klass = await w.categoryClass();
  const type = await w.targetType();
  const level = await w.level(10);
  const scheme = await w.gradeScheme([
    { name: '甲', grade: 1, description: '甲' },
    { name: '乙', grade: 2, description: '乙' },
  ]);
  const gradeTarget = await w.target(type.id, { evalMode: 'grade', gradeSchemeId: scheme.id });
  return { w, klass, type, level, scheme, gradeTarget };
}

describe.runIf(realPostgres)('P2-07 引用状态检查与写入之间加锁（DEC-334① 锁序，真 PG 交错）', () => {
  it('标准明细导入：指标在导入等锁期间被改为通用 → 整批拒绝 TARGET_COMMON', async () => {
    const { w, klass, type, level } = await gradeWorld('ql-pg-import-common');
    const category = await w.category(klass.id);
    const target = await w.target(type.id);
    const standard = await w.standard({ categoryId: category.id, levelIds: [level.id], details: [] });
    const response = await interleave(
      testDb().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM ql_targets WHERE tenant_id = ${w.tenant.id} AND id = ${target.id} FOR UPDATE`,
        );
        await tx.execute(
          sql`UPDATE ql_targets SET is_common = true WHERE tenant_id = ${w.tenant.id} AND id = ${target.id}`,
        );
      },
      () =>
        w.request('POST', '/standards/import', {
          body: {
            standards: [{ categoryCode: category.code, revision: standard.revision }],
            rows: [{ categoryCode: category.code, levelCode: level.code, targetCode: target.code, content: '手工' }],
          },
        }),
    );
    expect(response.status, await response.clone().text()).toBe(400);
    expect((await reason(response))?.receipts?.map((r) => r.reason)).toEqual(['TARGET_COMMON']);
  });

  it('标准明细导入：指标在导入等锁期间被停用（新引用）→ 整批拒绝 TARGET_DISABLED', async () => {
    const { w, klass, type, level } = await gradeWorld('ql-pg-import-disabled');
    const category = await w.category(klass.id);
    const target = await w.target(type.id);
    const standard = await w.standard({ categoryId: category.id, levelIds: [level.id], details: [] });
    const response = await interleave(
      testDb().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM ql_targets WHERE tenant_id = ${w.tenant.id} AND id = ${target.id} FOR UPDATE`,
        );
        await tx.execute(
          sql`UPDATE ql_targets SET enabled = false WHERE tenant_id = ${w.tenant.id} AND id = ${target.id}`,
        );
      },
      () =>
        w.request('POST', '/standards/import', {
          body: {
            standards: [{ categoryCode: category.code, revision: standard.revision }],
            rows: [{ categoryCode: category.code, levelCode: level.code, targetCode: target.code, content: '手工' }],
          },
        }),
    );
    expect(response.status, await response.clone().text()).toBe(400);
    expect((await reason(response))?.receipts?.map((r) => r.reason)).toEqual(['TARGET_DISABLED']);
  });

  it('标准新建：目标等级在等锁期间被软删 → 400 TARGET_GRADE_INVALID，不留引用已删等级的标准', async () => {
    const { w, klass, level, scheme, gradeTarget } = await gradeWorld('ql-pg-standard-grade');
    const category = await w.category(klass.id);
    const detail = scheme.details[0]!;
    const response = await interleave(
      testDb().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(sql`SELECT 1 FROM ql_grade_details WHERE tenant_id = ${w.tenant.id} AND id = ${detail.id}
          FOR UPDATE`);
        await tx.execute(sql`UPDATE ql_grade_details SET deleted_at = now()
          WHERE tenant_id = ${w.tenant.id} AND id = ${detail.id}`);
      },
      () =>
        w.request('POST', '/standards', {
          ifMatch: 0,
          body: {
            categoryId: category.id,
            name: '标准',
            levelIds: [level.id],
            details: [
              {
                levelId: level.id,
                targetId: gradeTarget.id,
                abilities: [{ content: '达到甲级', targetGradeId: detail.id }],
              },
            ],
          },
        }),
    );
    expect(response.status, await response.clone().text()).toBe(400);
    expect((await reason(response))?.reason).toBe('TARGET_GRADE_INVALID');
    const list = await w.read<{ items: unknown[] }>(`/standards?categoryId=${category.id}`);
    expect(list.items).toEqual([]);
  });

  it('指标等级描述 PUT：等级明细在等锁期间被软删 → 404，不留手改行', async () => {
    const { w, scheme, gradeTarget } = await gradeWorld('ql-pg-grade-description');
    const detail = scheme.details[1]!;
    const response = await interleave(
      testDb().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(sql`SELECT 1 FROM ql_grade_details WHERE tenant_id = ${w.tenant.id} AND id = ${detail.id}
          FOR UPDATE`);
        await tx.execute(sql`UPDATE ql_grade_details SET deleted_at = now()
          WHERE tenant_id = ${w.tenant.id} AND id = ${detail.id}`);
      },
      () =>
        w.request('PUT', `/targets/${gradeTarget.id}/grade-descriptions/${detail.id}`, {
          ifMatch: gradeTarget.revision,
          body: { description: '手改' },
        }),
    );
    expect(response.status, await response.clone().text()).toBe(404);
    const manual = await withTenant(testDb().db, w.tenant.id, async (tx) =>
      rows(
        await tx.execute(sql`SELECT 1 FROM ql_target_grade_descriptions WHERE tenant_id = ${w.tenant.id}
        AND grade_detail_id = ${detail.id}`),
      ),
    );
    expect(manual).toEqual([]);
  });

  it('等级方案删明细：明细在等锁期间刚被能力标准引用 → 409 GRADE_DETAIL_IN_USE，明细不删', async () => {
    const { w, klass, level, scheme, gradeTarget } = await gradeWorld('ql-pg-scheme-in-use');
    const category = await w.category(klass.id);
    const standard = await w.standard({
      categoryId: category.id,
      levelIds: [level.id],
      details: [{ levelId: level.id, targetId: gradeTarget.id, abilities: [{ content: '无目标等级' }] }],
    });
    const cell = (await w.read<StandardView>(`/standards/${standard.id}`)).details[0]! as unknown as { id: string };
    const removed = scheme.details[1]!;
    const response = await interleave(
      testDb().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(sql`SELECT 1 FROM ql_grade_details WHERE tenant_id = ${w.tenant.id} AND id = ${removed.id}
          FOR SHARE`);
        await tx.execute(sql`INSERT INTO ql_ability_details (tenant_id, detail_id, content, target_grade_id,
          display_order, source) VALUES (${w.tenant.id}, ${cell.id}, '引用乙级', ${removed.id}, 1, 'manual')`);
      },
      () =>
        w.request('PATCH', `/grade-schemes/${scheme.id}`, {
          ifMatch: scheme.revision,
          body: { details: [{ id: scheme.details[0]!.id, name: '甲', grade: 1, description: '甲' }] },
        }),
    );
    expect(response.status, await response.clone().text()).toBe(409);
    expect((await reason(response))?.reason).toBe('GRADE_DETAIL_IN_USE');
    const after = await w.read<GradeSchemeView>(`/grade-schemes/${scheme.id}`);
    expect(after.details.map((detail) => detail.id)).toContain(removed.id);
  });
});

describe.runIf(realPostgres)('P3 并发唯一冲突一律 409（DEC-067，真 PG 交错）', () => {
  it('同一类别并发建标准：后到的 409 STANDARD_EXISTS / DUPLICATE，不是 500', async () => {
    const { w, klass, level } = await gradeWorld('ql-pg-standard-unique');
    const category = await w.category(klass.id);
    const response = await interleave(
      testDb().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(sql`INSERT INTO ql_standards (tenant_id, category_id, name, level_ids, owner_id, owner_org_id,
          created_by) VALUES (${w.tenant.id}, ${category.id}, '先到', ${`{${level.id}}`}::uuid[], ${w.user.id},
          ${w.orgId}, ${w.user.id})`);
      },
      () =>
        w.request('POST', '/standards', {
          ifMatch: 0,
          body: { categoryId: category.id, name: '后到', levelIds: [level.id], details: [] },
        }),
    );
    expect(response.status, await response.clone().text()).toBe(409);
  });

  it('同一岗职务并发关联到两个类别：后到的 409，不是 500', async () => {
    const { w, klass } = await gradeWorld('ql-pg-link-unique');
    const sequence = await w.sequence('并发序列');
    const first = await w.category(klass.id);
    const response = await interleave(
      testDb().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(sql`INSERT INTO ql_category_job_links (tenant_id, category_id, job_link_type, job_object_id)
          VALUES (${w.tenant.id}, ${first.id}, 'sequence', ${sequence})`);
      },
      () =>
        w.request('POST', '/categories', {
          ifMatch: 0,
          body: {
            code: `C${randomUUID().slice(0, 5)}`,
            name: '后到类别',
            classId: klass.id,
            jobLinkType: 'sequence',
            jobLinks: [sequence],
          },
        }),
    );
    expect(response.status, await response.clone().text()).toBe(409);
  });

  it('等级方案改成并发新建的同名：409，不是 500', async () => {
    const { w, scheme } = await gradeWorld('ql-pg-scheme-name');
    const name = `同名${randomUUID().slice(0, 5)}`;
    const response = await interleave(
      testDb().db,
      w.tenant.id,
      async (tx) => {
        await tx.execute(sql`INSERT INTO ql_grade_schemes (tenant_id, name, created_by)
          VALUES (${w.tenant.id}, ${name}, ${w.user.id})`);
      },
      () => w.request('PATCH', `/grade-schemes/${scheme.id}`, { ifMatch: scheme.revision, body: { name } }),
    );
    expect(response.status, await response.clone().text()).toBe(409);
  });
});
