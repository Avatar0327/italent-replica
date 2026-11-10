/**
 * AC-DM-30-F493-21（F-493 S2，设计 §4.5 / §6.5）：导入专用开通函数、新表、RLS。
 * 应用角色（app_user）不能直接写 users；函数对新联系邮箱发虚拟登录名，对已被占用的邮箱建无登录名账号。
 */
import { sql, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  insertBatch,
  provisionImportAccount,
  readUsers,
  rowsOf,
  seedTenant,
  stateOf,
  userCount,
} from './AC-F493-s2-support.js';
import { createUser } from '@italent/db';
import { cmd } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const VIRTUAL = /^va-[0-9a-f]{32}@virtualaccount\.invalid$/;

describe('AC-DM-30-F493-21 应用角色不能直接写 users', () => {
  it('租户上下文直接 INSERT INTO users → 42501', async () => {
    const { db } = testDb();
    const a = await seedTenant(db, 'f21-ins');
    const state = await stateOf(() =>
      withTenant(db, a.tenantId, (tx) =>
        tx.execute(sql`INSERT INTO users (email, display_name) VALUES (${`x-${uniqueSuffix()}@example.com`}, '直插')`),
      ),
    );
    expect(state).toBe('42501');
  });
});

describe('AC-DM-30-F493-21 tenant_provision_import_account', () => {
  it('新联系邮箱：login_assigned = true；账号 disabled、虚拟登录名由账号 ID 推出、有平台审计且不含联系邮箱', async () => {
    const { db } = testDb();
    const a = await seedTenant(db, 'f21-new');
    const email = `syn.new-${uniqueSuffix()}@example.com`;
    const commandId = `f21-new-${uniqueSuffix()}`;
    const result = await provisionImportAccount(db, a.tenantId, a.userId, email, '合成新人', commandId);
    expect(result.login_assigned).toBe(true);

    const [account] = await readUsers(db, [result.account_id]);
    expect(account).toMatchObject({ display_name: '合成新人', status: 'disabled', revision: 1 });
    expect(account!.email).toMatch(VIRTUAL);
    expect(account!.email).toBe(`va-${result.account_id.replaceAll('-', '')}@virtualaccount.invalid`);
    expect(account!.email).not.toBe(email);

    const audits = await withPlatform(db, async (tx) =>
      rowsOf<{ actor_user_id: string; action: string; object_type: string; object_id: string; after: unknown }>(
        await tx.execute(sql`SELECT actor_user_id, action, object_type, object_id, after
          FROM platform_audit_events WHERE command_id = ${commandId}`),
      ),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: a.userId,
      action: 'user.create',
      object_type: 'user',
      object_id: result.account_id,
    });
    expect(audits[0]!.after).toMatchObject({ status: 'disabled', source: 'exit_import', loginAssigned: true });
    expect(JSON.stringify(audits[0]!.after)).not.toContain(email);
  });

  it('联系邮箱已是某账号登录名：login_assigned = false、新账号 email IS NULL，原账号状态与 revision 不变', async () => {
    const { db } = testDb();
    const a = await seedTenant(db, 'f21-taken');
    const email = `syn.taken-${uniqueSuffix()}@example.com`;
    const existing = await createUser(db, { email, displayName: '既有账号' }, cmd());
    const before = (await readUsers(db, [existing.id]))[0]!;

    const result = await provisionImportAccount(db, a.tenantId, a.userId, email, '合成重名邮箱');
    expect(result.login_assigned).toBe(false);
    expect(result.account_id).not.toBe(existing.id);
    const [created] = await readUsers(db, [result.account_id]);
    expect(created).toMatchObject({ email: null, status: 'disabled', display_name: '合成重名邮箱' });
    expect((await readUsers(db, [existing.id]))[0]).toEqual(before);

    const audit = await withPlatform(db, async (tx) =>
      rowsOf<{ after: Record<string, unknown> }>(
        await tx.execute(sql`SELECT after FROM platform_audit_events
          WHERE action = 'user.create' AND object_id = ${result.account_id}`),
      ),
    );
    expect(audit[0]!.after).toMatchObject({ loginAssigned: false, source: 'exit_import' });
  });

  it('未规范化的邮箱（大写 / 首尾空白）、空串、NULL 报 check_violation，不新增账号', async () => {
    const { db } = testDb();
    const a = await seedTenant(db, 'f21-bad');
    const before = await userCount(db);
    for (const bad of [`  Syn.Bad-${uniqueSuffix()}@Example.com`, ' ', '']) {
      const state = await stateOf(() => provisionImportAccount(db, a.tenantId, a.userId, bad));
      expect(state, JSON.stringify(bad)).toBe('23514');
    }
    const nullState = await stateOf(() =>
      withTenant(db, a.tenantId, (tx) =>
        tx.execute(
          sql`SELECT * FROM tenant_provision_import_account(NULL::text, '合成', ${a.userId}::uuid, 'f21-null')`,
        ),
      ),
    );
    expect(nullState).toBe('23514');
    expect(await userCount(db)).toBe(before);
  });

  it('姓名为空报 check_violation；无租户上下文（平台路径）无权调用 → 42501', async () => {
    const { db } = testDb();
    const a = await seedTenant(db, 'f21-ctx');
    const email = `syn.ctx-${uniqueSuffix()}@example.com`;
    expect(await stateOf(() => provisionImportAccount(db, a.tenantId, a.userId, email, '  '))).toBe('23514');
    const state = await stateOf(() =>
      withPlatform(db, (tx) =>
        tx.execute(
          sql`SELECT * FROM tenant_provision_import_account(${email}::text, '合成', ${a.userId}::uuid, 'f21-p')`,
        ),
      ),
    );
    expect(state).toBe('42501');
  });
});

describe('AC-DM-30-F493-21 新表：租户隔离与约束', () => {
  it('B 租户上下文读 A 的 exit_import_batches / exit_import_rows 得到 0 行，也写不进 A 的租户', async () => {
    const { db } = testDb();
    const a = await seedTenant(db, 'f21-rls-a');
    const b = await seedTenant(db, 'f21-rls-b');
    const batchId = await insertBatch(db, a.tenantId, a.userId);
    await withTenant(db, a.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO exit_import_rows (tenant_id, batch_id, row_no, name, email, status)
        VALUES (${a.tenantId}, ${batchId}, 2, '合成甲', 'syn.a@example.com', 'pending')`),
    );
    const count = (tenantId: string, table: 'exit_import_batches' | 'exit_import_rows') =>
      withTenant(
        db,
        tenantId,
        async (tx) =>
          rowsOf<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`))[0]!.n,
      );
    expect(await count(a.tenantId, 'exit_import_batches')).toBe(1);
    expect(await count(a.tenantId, 'exit_import_rows')).toBe(1);
    expect(await count(b.tenantId, 'exit_import_batches')).toBe(0);
    expect(await count(b.tenantId, 'exit_import_rows')).toBe(0);

    const crossWrite = await stateOf(() =>
      withTenant(db, b.tenantId, (tx) =>
        tx.execute(sql`INSERT INTO exit_import_batches (tenant_id, command_id, submitted_by, file_name, status, total)
          VALUES (${a.tenantId}, 'x', ${a.userId}, 'x.xlsx', 'queued', 1)`),
      ),
    );
    expect(crossWrite).toBe('42501');
  });

  it('批次检查约束：总行数 1..1000、error_row_count ≤ total、error_count ≥ error_row_count、expires_at 只在终态', async () => {
    const { db } = testDb();
    const a = await seedTenant(db, 'f21-chk');
    // 先插一个合法批次，再用一条 UPDATE 同时改多列（约束按行整体判定，不能逐列改）
    const bad = async (over: { total?: number; status?: string } & Record<string, unknown>) => {
      const { total, status, ...rest } = over;
      return stateOf(async () => {
        const id = await insertBatch(db, a.tenantId, a.userId, { total: total ?? 3, status: status ?? 'queued' });
        const sets = Object.entries(rest).map(([key, value]) => sql`${sql.raw(key)} = ${value as never}`);
        if (sets.length === 0) return;
        await withTenant(db, a.tenantId, (tx) =>
          tx.execute(sql`UPDATE exit_import_batches SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`),
        );
      });
    };
    expect(await bad({ total: 0 })).toBe('23514');
    expect(await bad({ total: 1001 })).toBe('23514');
    expect(await bad({ total: 1000 })).toBeUndefined();
    expect(await bad({ error_row_count: 4, error_count: 9 })).toBe('23514'); // 4 > total 3
    expect(await bad({ error_row_count: 2, error_count: 1 })).toBe('23514'); // 条数 < 行数
    expect(await bad({ error_row_count: 2, error_count: 5 })).toBeUndefined(); // 一行多条错误
    expect(await bad({ status: 'bogus' })).toBe('23514');
    expect(await bad({ expires_at: '2026-12-01T00:00:00Z' })).toBe('23514'); // queued 不应有 expires_at
  });

  it('提交人必须是本租户成员；批次表有「本人列表」索引 (tenant_id, submitted_by, created_at DESC, id DESC)', async () => {
    const { db } = testDb();
    const a = await seedTenant(db, 'f21-fk');
    const b = await seedTenant(db, 'f21-fk-b');
    expect(await stateOf(() => insertBatch(db, a.tenantId, b.userId))).toBe('23503');
    const indexes = await withTenant(db, a.tenantId, async (tx) =>
      rowsOf<{ indexdef: string }>(
        await tx.execute(sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'exit_import_batches'`),
      ),
    );
    expect(
      indexes.some((i) => /\(tenant_id, submitted_by, created_at DESC, id DESC\)/.test(i.indexdef)),
      indexes.map((i) => i.indexdef).join('\n'),
    ).toBe(true);
  });
});
