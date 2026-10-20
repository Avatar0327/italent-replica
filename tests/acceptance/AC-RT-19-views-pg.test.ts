/**
 * R2-T04 BE-5d1 / AC-RT-19-views-pg（设计 §13.3 ⑥）：退休单视图分页统计 vs 并发退休生效，总数与页内行不越界
 * （同 AC-EXIT-views-pg）。交错由查询边界控制：读者每个请求的第一条“列表候选集”语句（FROM exit_requests x）执行完之后、
 * 同一请求的下一条语句开始之前，由测试在另一条连接上提交“把一条审批通过的退休写成已生效”。单语句物化候选集的实现里，
 * 列表请求只有这一条语句，写入落在响应数据之后，items 与 total 必然对得上。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '@italent/db';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retirementWorld } from './AC-RT-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TOTAL = 6;
const SIZE = 3;
const ASOF = '2030-01-01';

/** 取 drizzle SQL 对象里的静态文本（参数不进文本），用来认出“列表候选集”语句。 */
function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  const chunk = node as { queryChunks?: unknown[]; value?: unknown };
  if (chunk.queryChunks) return textOf(chunk.queryChunks);
  return Array.isArray(chunk.value) ? chunk.value.join('') : '';
}

/** 包一层连接：事务内每条 execute 返回之前先让出结果，之后（下一条语句之前）执行 after(语句文本)。 */
function interposed(db: Db, after: (statement: string) => Promise<void>): Db {
  const wrapTx = (tx: Tx): Tx =>
    new Proxy(tx, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property !== 'execute') return value.bind(target);
        return async (statement: unknown) => {
          const result = await value.call(target, statement);
          await after(textOf(statement));
          return result;
        };
      },
    });
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property !== 'transaction') return value.bind(target);
      return (run: (tx: Tx) => Promise<unknown>, ...rest: unknown[]) =>
        value.call(target, (tx: Tx) => run(wrapTx(tx)), ...rest);
    },
  });
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-19-views-pg 退休视图分页 vs 并发生效', () => {
  it('每个列表请求的第一条语句之后恰有一单提交生效：items 与 total 仍一致，全部视图总数恒定', async () => {
    const db = database().db;
    const x = await retirementWorld(db, 'rt19-views-pg', '2026-10-06');
    const t = x.session.tenant.id;
    const bills: { id: string; employeeId: string }[] = [];
    for (let index = 0; index < TOTAL; index += 1) {
      const { employee } = await x.hired(`并发员工${index}`);
      const created = await x.directRetire(`2026-10-${String(20 + index)}`, undefined, employee.id);
      bills.push({ id: created.id, employeeId: employee.id });
    }
    const flip = ({ id, employeeId }: (typeof bills)[number]) =>
      withTenant(db, t, (tx) =>
        tx.execute(sql`INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,
            state,event_no,command_id)
          SELECT p.tenant_id,p.employee_id,p.business_id,p.id,'effective',
            (SELECT max(e.event_no)+1 FROM employment_state_events e
              WHERE e.tenant_id=p.tenant_id AND e.business_id=p.business_id),${`flip-${randomUUID()}`}
          FROM employment_payload_versions p WHERE p.tenant_id=${t} AND p.business_id=${id}::uuid
            AND p.employee_id=${employeeId}::uuid ORDER BY p.version_no DESC LIMIT 1`),
      );
    let flipped = 0;
    let armed = false;
    const api = tenantApi(
      interposed(db, async (statement) => {
        if (!armed || !statement.includes('FROM exit_requests x') || flipped >= TOTAL) return;
        armed = false;
        await flip(bills[flipped++]!);
      }),
      { clock: () => new Date('2026-10-06T01:00:00.000Z') },
    );
    const violations: string[] = [];
    const read = async (view: string) => {
      const before = flipped;
      armed = true;
      const response = await api.request(
        'GET',
        `/api/tenant/employment/retirements?view=${view}&asOf=${ASOF}&pageSize=${SIZE}`,
        { user: x.session.user.id, tenant: t },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { items: { id: string }[]; total: number };
      expect(flipped, `${view}：读取期间应恰好提交一次生效`).toBe(Math.min(TOTAL, before + 1));
      if (body.items.length !== Math.min(SIZE, body.total)) violations.push(`${view} ${JSON.stringify(body)}`);
      if (view === 'all' && body.total !== TOTAL) violations.push(`all total ${body.total}`);
      return body;
    };
    for (let round = 0; round < 4; round += 1) for (const view of ['completed', 'processing', 'all']) await read(view);
    expect(flipped).toBe(TOTAL);
    expect(violations).toEqual([]);
    expect((await read('completed')).total).toBe(TOTAL);
    expect((await read('processing')).total).toBe(0);
  });
});
