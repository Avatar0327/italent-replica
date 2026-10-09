/**
 * AC-SC-01（R3-T05 A1，设计 §1.1）：继任记录表与目标锁表的库级约束——类型与目标二选一、区间合法、区间排他
 * （含历史，软删除不占）、同租户外键、准备度 RESTRICT、租户隔离、软删除清准备度引用、source_batch_id 先建列不建外键（D1 补）。
 * 约束违反只断言 PostgreSQL 错误码（23514 检查 / 23P01 排他 / 23503 外键（RESTRICT 在 PGlite 为 23001）/ 23505 唯一），不依赖文案。
 */
import { pgErrorCode, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { resultRows } from './AC-ORG-people-support.js';
import { OPEN_END, type ReadinessSeed, type SuccessionWorld, successionWorld } from './AC-SC-support.js';

const testDb = useTestDb();

describe('AC-SC-01 继任记录表约束（设计 §1.1）', () => {
  let w: SuccessionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  let level: ReadinessSeed;

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-schema');
    std = await w.standard();
    level = await w.readiness('储备中');
  });

  const failure = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      return pgErrorCode(error);
    }
    return undefined;
  };

  it('缺省值：结束日 9999-12-31、后备类型 principal、来源 manual、revision 1', async () => {
    const id = await w.insertRecord({ type: 'org', targetId: std.orgA.id, successorId: std.successor1.id });
    const [row] = await w.asTenant(async (tx) =>
      resultRows<Record<string, unknown>>(
        await tx.execute(sql`SELECT end_date::text AS end_date, backup_type, source_kind, revision, deleted_at,
          end_source, source_batch_id FROM succession_records WHERE id = ${id}::uuid`),
      ),
    );
    expect(row).toMatchObject({
      end_date: OPEN_END,
      backup_type: 'principal',
      source_kind: 'manual',
      revision: 1,
      deleted_at: null,
      end_source: null,
      source_batch_id: null,
    });
  });

  it('类型与目标二选一：组织继任不能带职位目标，职位继任不能缺目标', async () => {
    const insert = (type: string, org: string | null, position: string | null) => () =>
      w.asTenant((tx) =>
        tx.execute(sql`INSERT INTO succession_records (tenant_id, succession_type, target_org_id, target_position_id,
          successor_employee_id, start_date, created_by, updated_by)
          VALUES (${w.tenant.id}::uuid, ${type}, ${org}::uuid, ${position}::uuid, ${std.successor2.id}::uuid,
            '2026-09-01', ${w.user.id}::uuid, ${w.user.id}::uuid)`),
      );
    expect(await failure(insert('org', std.orgA.id, std.keyPosition.id))).toBe('23514');
    expect(await failure(insert('org', null, null))).toBe('23514');
    expect(await failure(insert('position', null, null))).toBe('23514');
    expect(await failure(insert('position', std.orgA.id, std.keyPosition.id))).toBe('23514');
    expect(await failure(insert('other', std.orgA.id, null))).toBe('23514');
  });

  it('开始日不晚于结束日，允许零长度 [d, d)；后备类型与来源枚举受检查', async () => {
    expect(
      await failure(() =>
        w.insertRecord({
          type: 'org',
          targetId: std.orgB.id,
          successorId: std.successor1.id,
          startDate: '2026-09-10',
          endDate: '2026-09-09',
        }),
      ),
    ).toBe('23514');
    await w.insertRecord({
      type: 'org',
      targetId: std.orgB.id,
      successorId: std.successor1.id,
      startDate: '2026-09-10',
      endDate: '2026-09-10',
    });
    expect(
      await failure(() =>
        w.insertRecord({
          type: 'org',
          targetId: std.orgB.id,
          successorId: std.successor2.id,
          backupType: 'x' as never,
        }),
      ),
    ).toBe('23514');
    expect(
      await failure(() =>
        w.insertRecord({
          type: 'org',
          targetId: std.orgB.id,
          successorId: std.successor2.id,
          sourceKind: 'import' as never,
        }),
      ),
    ).toBe('23514');
  });

  it('区间排他（DEC-305②）：同目标同继任者任何两条未删除记录的 [开始, 结束) 不得重叠，含历史', async () => {
    const base = { type: 'position' as const, targetId: std.keyPosition.id, successorId: std.successor1.id };
    await w.insertRecord({ ...base, startDate: '2026-01-01', endDate: '2026-03-01' });
    // 首尾相接不算重叠
    await w.insertRecord({ ...base, startDate: '2026-03-01', endDate: '2026-05-01' });
    // 与历史交叉 → 排他冲突
    expect(await failure(() => w.insertRecord({ ...base, startDate: '2026-02-01', endDate: '2026-04-01' }))).toBe(
      '23P01',
    );
    // 与当前生效区间重叠
    await w.insertRecord({ ...base, startDate: '2026-06-01' });
    expect(await failure(() => w.insertRecord({ ...base, startDate: '2026-07-01' }))).toBe('23P01');
    // 另一继任者 / 另一目标互不影响
    await w.insertRecord({ ...base, successorId: std.successor2.id, startDate: '2026-01-01' });
    await w.insertRecord({
      ...base,
      targetId: (await w.position(std.orgA.id, '另一岗位')).id,
      startDate: '2026-01-01',
    });
    // 软删除的记录不占区间
    await w.insertRecord({ ...base, startDate: '2026-01-15', endDate: '2026-02-15', deleted: true });
  });

  it('外键与准备度 RESTRICT：继任者 / 组织 / 职位必须存在；被引用的准备度不能物理删除', async () => {
    const orphan = (column: 'successor' | 'org' | 'position') => () =>
      w.insertRecord({
        type: column === 'position' ? 'position' : 'org',
        targetId: column === 'org' || column === 'position' ? '00000000-0000-4000-8000-000000000001' : std.orgA.id,
        successorId: column === 'successor' ? '00000000-0000-4000-8000-000000000002' : std.successor2.id,
        startDate: '2025-01-01',
        endDate: '2025-02-01',
      });
    expect(await failure(orphan('successor'))).toBe('23503');
    expect(await failure(orphan('org'))).toBe('23503');
    expect(await failure(orphan('position'))).toBe('23503');
    await w.insertRecord({
      type: 'org',
      targetId: std.orgA.id,
      successorId: std.successor2.id,
      readinessId: level.id,
      startDate: '2025-01-01',
      endDate: '2025-02-01',
    });
    // RESTRICT 的错误码因引擎而异：真 PostgreSQL 报 23503，PGlite 报 23001（restrict_violation），都是外键拒绝
    expect(['23001', '23503']).toContain(
      await failure(() =>
        w.asTenant((tx) => tx.execute(sql`DELETE FROM talent_readiness_levels WHERE id = ${level.id}::uuid`)),
      ),
    );
  });

  it('软删除同事务清掉准备度引用（删除数据不占用准备度，快照留在审计）', async () => {
    const kept = await w.readiness('软删除用');
    const id = await w.insertRecord({
      type: 'org',
      targetId: std.orgB.id,
      successorId: std.successor2.id,
      readinessId: kept.id,
      startDate: '2025-03-01',
      endDate: '2025-04-01',
    });
    await w.asTenant((tx) => tx.execute(sql`UPDATE succession_records SET deleted_at = now() WHERE id = ${id}::uuid`));
    const [row] = await w.asTenant(async (tx) =>
      resultRows<{ readiness_id: string | null }>(
        await tx.execute(sql`SELECT readiness_id FROM succession_records WHERE id = ${id}::uuid`),
      ),
    );
    expect(row!.readiness_id).toBeNull();
    await w.asTenant((tx) => tx.execute(sql`DELETE FROM talent_readiness_levels WHERE id = ${kept.id}::uuid`));
  });

  it('租户隔离：别的租户读不到记录与目标锁；source_batch_id 先建列、没有外键（D1 补）', async () => {
    const other = await successionWorld(testDb().db, 'sc-schema-other');
    const visible = await withTenant(testDb().db, other.tenant.id, async (tx) =>
      resultRows<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM succession_records`)),
    );
    expect(visible[0]!.n).toBe(0);
    await w.asTenant((tx) =>
      tx.execute(sql`INSERT INTO succession_target_locks (tenant_id, target_kind, target_id)
        VALUES (${w.tenant.id}::uuid, 'org', ${std.orgA.id}::uuid) ON CONFLICT DO NOTHING`),
    );
    expect(
      await failure(() =>
        w.asTenant((tx) =>
          tx.execute(sql`INSERT INTO succession_target_locks (tenant_id, target_kind, target_id)
            VALUES (${w.tenant.id}::uuid, 'org', ${std.orgA.id}::uuid)`),
        ),
      ),
    ).toBe('23505');
    const locks = await withTenant(testDb().db, other.tenant.id, async (tx) =>
      resultRows<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM succession_target_locks`)),
    );
    expect(locks[0]!.n).toBe(0);
    const id = await w.insertRecord({
      type: 'org',
      targetId: std.orgB.id,
      successorId: std.successor1.id,
      startDate: '2024-01-01',
      endDate: '2024-02-01',
    });
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE succession_records SET source_batch_id = gen_random_uuid() WHERE id = ${id}::uuid`),
    );
    const foreignKeys = await w.asTenant(async (tx) =>
      resultRows<{ conname: string }>(
        await tx.execute(sql`SELECT c.conname FROM pg_constraint c WHERE c.contype = 'f'
          AND c.conrelid = 'succession_records'::regclass`),
      ),
    );
    expect(foreignKeys.map((row) => row.conname).filter((name) => name.includes('batch'))).toEqual([]);
  });
});
