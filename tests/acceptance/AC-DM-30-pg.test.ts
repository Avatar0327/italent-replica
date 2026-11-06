/**
 * AC-DM-30-11：导入与 POST /employees 同工号并发（设计 §6 步骤 0 的按工号 advisory lock）。
 * 只在真 PostgreSQL 分片运行（F-043 套路）：PGlite 单连接串行执行，造不出真并发，跳过并保留 PG 分片覆盖。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { importWorld } from './AC-DM-30-support.js';

const database = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-DM-30-11 导入 vs 建档同工号并发', () => {
  it.each([1, 2, 3])('第 %i 轮：恰好一方成功，另一方得到业务码（不是 500），工号只有一个人员', async (round) => {
    const x = await importWorld(database().db, `11-${round}`);
    const d = await x.dept('并发部门');
    const row = x.row(1, d.code, { employeeNo: 'H1100' });
    const [imported, created] = await Promise.all([
      x.importRows([row]),
      x.session.request('POST', '/employees', { ifMatch: 0, body: { name: '合成甲', code: 'H1100' } }),
    ]);
    const statuses = [imported.status, created.status];
    expect(
      statuses.every((status) => status < 500),
      String(statuses),
    ).toBe(true);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    const loser = imported.status === 201 ? created : imported;
    expect([400, 409]).toContain(loser.status);
    expect(JSON.stringify(await loser.json())).toMatch(/EMPLOYEE_NO_EXISTS|CONFLICT|EXISTS/);
    expect(
      await x.q(x.sql`SELECT 1 FROM employment_employees WHERE tenant_id=${x.tenantId} AND code='H1100'`),
    ).toHaveLength(1);
    // 导入先到时人员三步齐全；建档先到时导入整批零写入（不留半截人员）
    const person = (await x.employeeByNo('H1100'))!;
    expect(await x.businessesOf(person.id)).toHaveLength(imported.status === 201 ? 2 : 0);
  });
});
