import { m0DemoValidity, platformMeta, withTenant } from '@italent/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { pgErrorCode } from './pg-error.js';
import { useTestDb } from './vitest.js';

const testDb = useTestDb();
const tenantId = '00000000-0000-4000-8000-000000000001';
const subjectId = '00000000-0000-4000-8000-0000000000a1';

describe('测试库：全新库 + 迁移 + PG 16 基线特性', () => {
  it('迁移已执行，可读写 platform_meta', async () => {
    const { db } = testDb();
    await db.insert(platformMeta).values({ key: 'schema', value: 'm0' });
    const rows = await db.select().from(platformMeta).where(eq(platformMeta.key, 'schema'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('m0');
  });

  it('btree_gist 扩展已启用', async () => {
    const { db } = testDb();
    const result = await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(JSON.stringify(result)).toContain('btree_gist');
  });

  it('同租户同对象的有效期首尾相接可以插入', async () => {
    // m0_demo_validity 带 tenant_id，已纳入 RLS（迁移 0003），须在租户上下文中写入
    await withTenant(testDb().db, tenantId, (tx) =>
      tx.insert(m0DemoValidity).values([
        { tenantId, subjectId, validDuring: '[2026-01-01,2026-07-01)' },
        { tenantId, subjectId, validDuring: '[2026-07-01,)' },
      ]),
    );
  });

  it('同租户同对象的有效期重叠被排除约束拒绝（23P01）', async () => {
    const insert = withTenant(testDb().db, tenantId, (tx) =>
      tx.insert(m0DemoValidity).values({ tenantId, subjectId, validDuring: '[2026-03-01,2026-04-01)' }),
    );
    const error = await insert.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(pgErrorCode(error)).toBe('23P01');
  });

  it('不同租户的相同对象与区间互不影响', async () => {
    const otherTenant = '00000000-0000-4000-8000-000000000002';
    await withTenant(testDb().db, otherTenant, (tx) =>
      tx.insert(m0DemoValidity).values({ tenantId: otherTenant, subjectId, validDuring: '[2026-03-01,)' }),
    );
  });
});
