/**
 * AC-DM-30-F493-27 ①（F-493 S1）：员工工号可空。
 * 空工号的员工可以建多人（NULL 在唯一索引里互不相等）；全空白工号仍被 CHECK 拒绝；
 * 非空工号大小写不同仍冲突；公开建档入口仍必须带非空工号。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { nullCodeEmployee } from './AC-F493-s1-support.js';

const database = useTestDb();

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

describe('AC-DM-30-F493-27 ① 员工工号可空', () => {
  it('createEmployee(code: null) 连建两人都成功，库里的工号为 NULL', async () => {
    const { db } = database();
    const w = await employmentSession(db, 'f493s1-27-null');
    const first = await nullCodeEmployee(db, w, '空工号甲');
    const second = await nullCodeEmployee(db, w, '空工号乙');
    expect(first.code).toBeNull();
    expect(second.code).toBeNull();
    expect(first.id).not.toBe(second.id);
    const stored = await withTenant(db, w.tenant.id, async (tx) =>
      rowsOf<{ id: string; code: string | null }>(
        await tx.execute(sql`SELECT id, code FROM employment_employees WHERE tenant_id=${w.tenant.id}
          AND id IN (${first.id}::uuid, ${second.id}::uuid)`),
      ),
    );
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.code === null)).toBe(true);
  });

  it('全空白工号被 CHECK 拒绝（直接写库），经公开入口也被拒绝', async () => {
    const { db } = database();
    const w = await employmentSession(db, 'f493s1-27-blank');
    const rejected = await withTenant(db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO employment_employees(id, tenant_id, code, name)
        VALUES (${randomUUID()}::uuid, ${w.tenant.id}, '   ', '空白工号')`),
    ).then(
      () => null,
      (error: { cause?: { message?: string; constraint_name?: string } }) => error.cause ?? {},
    );
    // 约束名在驱动错误的 cause 上；外层只有“Failed query”
    expect(rejected?.constraint_name).toBe('employment_employees_code_nonempty');
    const response = await w.request('POST', '/employees', { ifMatch: 0, body: { name: '空白', code: '   ' } });
    expect(response.status).toBe(400);
  });

  it('非空工号仅大小写不同仍冲突（lower(code) 唯一索引保留）', async () => {
    const { db } = database();
    const w = await employmentSession(db, 'f493s1-27-case');
    await w.employee('大小写甲', 'Case-01');
    const response = await w.request('POST', '/employees', { ifMatch: 0, body: { name: '大小写乙', code: 'cASE-01' } });
    expect(response.status).toBe(409);
  });

  it('公开建档入口 POST /employees 不带工号或工号为 null 仍是 400', async () => {
    const { db } = database();
    const w = await employmentSession(db, 'f493s1-27-api');
    const missing = await w.request('POST', '/employees', { ifMatch: 0, body: { name: '缺工号' } });
    expect(missing.status).toBe(400);
    const explicitNull = await w.request('POST', '/employees', { ifMatch: 0, body: { name: '空工号', code: null } });
    expect(explicitNull.status).toBe(400);
  });
});
