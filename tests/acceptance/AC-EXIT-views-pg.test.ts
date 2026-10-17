/**
 * R2-T03 B5 真 PG：离职视图分页总数在并发生效时不越界（设计 §3.2、§18 B5）。读者翻页的同时，另一条连接把审批通过的离职
 * 逐条写成已生效（谓词边界上的单在两个视图间移动）。每次响应的 items 与 total 必须来自同一份快照：
 * 本页条数与 total 对得上，且“全部”视图的 total 恒等于总单数；全部写完后离职中 + 已完成 = 总数且互不重叠。
 * 本页条数必须恰为 min(页大小, max(0, total − 本页之前的条数))；总数和本页分两条语句取时，读者可能看到 items 与 total 对不上（先数后取，期间有单移入）。
 *PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { gateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TOTAL = 8;
const SIZE = 3;

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-views-pg 视图分页 vs 并发生效', () => {
  it('响应内 items 与 total 一致，翻页不越界；全部视图总数恒定', async () => {
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
    let writing = true;
    const violations: string[] = [];
    const read = async (view: string, page: number) => {
      const response = await w.session.request('GET', `/exits?view=${view}&pageSize=${SIZE}&page=${page}`);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { items: { id: string }[]; total: number };
      const expected = Math.min(SIZE, Math.max(0, body.total - (page - 1) * SIZE));
      if (body.items.length !== expected) violations.push(`${view} p${page} ${JSON.stringify(body)}`);
      if (body.total > TOTAL) violations.push(`${view} total ${body.total} > ${TOTAL}`);
      if (view === 'all' && body.total !== TOTAL) violations.push(`all total ${body.total}`);
      return body;
    };
    const writer = (async () => {
      for (const target of exits) await flip(target);
      writing = false;
    })();
    const readers = Array.from({ length: 3 }, async () => {
      do {
        for (const view of ['in_progress', 'completed', 'all']) for (const page of [1, 2, 3]) await read(view, page);
      } while (writing);
    });
    await Promise.all([writer, ...readers]);
    expect(violations).toEqual([]);
    const pending = await read('in_progress', 1);
    const done = [
      ...(await read('completed', 1)).items,
      ...(await read('completed', 2)).items,
      ...(await read('completed', 3)).items,
    ];
    expect(pending).toMatchObject({ items: [], total: 0 });
    expect(new Set(done.map((item) => item.id))).toEqual(new Set(exits.map((item) => item.id)));
  });
});
