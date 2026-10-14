/**
 * F-078 新旧版本混跑（#195 第 1 轮 P2-01）：规范化 UUID 只能改锁键里的 UUID 文本，不能换哈希算法。
 * 新旧进程并存时，租户 UUID 全小写的输入必须得到**同一把锁**——旧进程用改造前的锁 SQL 持锁，新实现的写请求必须排在它后面，
 * 否则两边读到同一个最大顺序号，第二笔撞唯一约束、被翻译成 409“编码重复”。真 PostgreSQL（PGlite 单连接无法并发）。
 *
 * 逐类核对结论（新旧键一致 = 全小写 / 已规范输入下 hash 算法与键文本都与改造前相同）：
 * qualification 改造前 hashtext('ql_levels:' || 租户)，其余九类均为 hashtextextended，键文本拼接格式不变。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { qualificationWorld } from './AC-QL-support.js';
import { hold, waitForAdvisoryWaiter } from './support/lock-case.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

describe.runIf(realPostgres)('混跑：旧锁 SQL × 新实现（真 PG）', () => {
  it('qualification 新建级别缺省顺序号：旧进程持旧锁并占用 max+1，新请求等待后分配下一个，201 + 201', async () => {
    const w = await qualificationWorld(testDb().db, 'f078-mixed-level');
    const first = await w.level(10);
    expect(first.displayOrder).toBe(10);
    const tenant = w.tenant.id;
    expect(tenant).toBe(tenant.toLowerCase());

    const outcome = await withTenant(testDb().db, tenant, async (oldProcess) => {
      // 旧进程：改造前的锁（hashtext，租户文本原样），读最大顺序号后写入下一个，尚未提交
      await hold(oldProcess, `ql_levels:${tenant}`, 'hashtext');
      const [max] = rowsOf<{ max: number }>(
        await oldProcess.execute(sql`SELECT max(display_order) AS max FROM ql_levels WHERE tenant_id = ${tenant}`),
      );
      await oldProcess.execute(sql`INSERT INTO ql_levels (tenant_id, code, name, display_order, owner_id,
        owner_org_id, created_by) VALUES (${tenant}, 'OLD1', '旧进程级别', ${max!.max + 1}, ${w.as.user},
        ${w.orgId}, ${w.as.user})`);
      const pending = w.request('POST', '/levels', { ifMatch: 0, body: { code: 'NEW1', name: '新进程级别' } });
      await waitForAdvisoryWaiter(testDb().db);
      return { pending, oldOrder: max!.max + 1 };
    });
    const response = await outcome.pending;
    expect(response.status, await response.clone().text()).toBe(201);
    expect(((await response.json()) as { displayOrder: number }).displayOrder).toBe(outcome.oldOrder + 1);
  });
});
