/**
 * R2-T03 B5 真 PG：离职视图分页总数在并发生效时不越界（设计 §3.2、§18 B5；#409 第 2 轮 P2-3 确定性交错）。
 * 交错由查询边界控制，不靠撞时机：读者每个请求的第一条“列表候选集”语句（FROM exit_requests x）执行完之后、同一请求的下一条语句
 * 开始之前，由测试在另一条连接上提交“把一条审批通过的离职写成已生效”。单语句物化候选集的实现里，列表请求只有这一条语句，
 * 写入落在响应数据之后，items 与 total 必然对得上；把实现改成“先单独取 total、再读页面”的两条语句，写入必然落在两次读取
 * 之间——已完成视图 total 0 却读到 1 条，离职中视图 total 与页内条数对不上——稳定判红（审查方的变异：返回旧 total）。
 * 本页条数必须恰为 min(页大小, max(0, total − 本页之前的条数))。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '@italent/db';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { gateWorld } from './AC-EXIT-gate-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TOTAL = 6;
const SIZE = 3;

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

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-views-pg 视图分页 vs 并发生效', () => {
  it('每个列表请求的第一条语句之后恰有一单提交生效：items 与 total 仍然一致，全部视图总数恒定', async () => {
    const db = database().db;
    const w = await gateWorld(db, 'views-pg');
    const t = w.session.tenant.id;
    const exits: { id: string; employeeId: string }[] = [];
    for (let index = 0; index < TOTAL; index += 1) {
      const { employee } = await w.hired(`并发员工${index}`);
      const { revision } = await w.session.getEmployee(employee.id);
      const response = await w.session.request('POST', `/exits/employees/${employee.id}`, {
        ifMatch: revision,
        body: { mode: 'direct', lastWorkDate: `2026-10-${String(20 + index)}` },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      exits.push({ id: ((await response.json()) as { id: string }).id, employeeId: employee.id });
    }
    // 在另一条连接（原始 db）上提交：写入对读者事务之后的语句立即可见
    const flip = ({ id, employeeId }: (typeof exits)[number]) =>
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
    // 每个读请求只在第一条列表语句之后提交一次（后面的语句，若有，读到的就是写入之后的状态）
    let armed = false;
    const api = tenantApi(
      interposed(db, async (statement) => {
        if (!armed || !statement.includes('FROM exit_requests x') || flipped >= TOTAL) return;
        armed = false;
        await flip(exits[flipped++]!);
      }),
      { clock: () => new Date('2026-10-06T01:00:00.000Z') },
    );
    const violations: string[] = [];
    const read = async (view: string) => {
      const before = flipped;
      armed = true;
      const response = await api.request('GET', `/api/tenant/employment/exits?view=${view}&pageSize=${SIZE}`, {
        user: w.session.user.id,
        tenant: t,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { items: { id: string }[]; total: number };
      expect(flipped, `${view}：读取期间应恰好提交一次生效`).toBe(Math.min(TOTAL, before + 1));
      if (body.items.length !== Math.min(SIZE, body.total)) violations.push(`${view} ${JSON.stringify(body)}`);
      if (view === 'all' && body.total !== TOTAL) violations.push(`all total ${body.total}`);
      return body;
    };
    for (let round = 0; round < 4; round += 1) for (const view of ['completed', 'in_progress', 'all']) await read(view);
    expect(flipped).toBe(TOTAL);
    expect(violations).toEqual([]);
    const done = await read('completed');
    expect(done.total).toBe(TOTAL);
    expect((await read('in_progress')).total).toBe(0);
  });
});
