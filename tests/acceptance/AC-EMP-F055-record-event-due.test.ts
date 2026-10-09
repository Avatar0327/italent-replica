/**
 * F-055（R3-T02 拆分方案 §10.3）：任职事件生效日门禁谓词。
 * - recordEventDueSql（严格到期）：record.create 事件要求记录仍在时间轴上且 start_date ≤ 租户当天；
 * - recordEventReadySql（队列取数）：严格到期 或 记录已消失（已删除 / 已撤销）；
 * - transfer/completion.ts 改用严格谓词，行为不变（回归）。
 */
import { sql, withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { recordEventDueSql, recordEventReadySql } from '../../apps/api/src/modules/employment/record-events.js';
import { appendOrgAdjustment } from '../../apps/api/src/modules/employment/org-adjustment.js';
import { completionCandidates } from '../../apps/api/src/modules/transfer/completion.js';
import { f055World, rowsOf, RECORD_CREATE } from './AC-EMP-F055-support.js';

const database = useTestDb();

const only = async (map: Map<string, boolean>) => {
  expect(map.size).toBe(1);
  return [...map.values()][0];
};

describe('F-055 recordEventDueSql：生效日前为假、当天为真', () => {
  it('直接保存未来生效的调动：写出时就有事件，但生效日前一天为假、当天为真', async () => {
    const w = await f055World(database().db, 'f055-due-transfer');
    const id = await w.transfer('2026-10-05');
    expect(await w.events(id)).toHaveLength(1);
    expect(await only(await w.gate('due', '2026-10-04', id))).toBe(false);
    expect(await only(await w.gate('due', '2026-10-05', id))).toBe(true);
    expect(await only(await w.gate('due', '2026-10-06', id))).toBe(true);
  });

  it('直接保存未来生效的离职：生效日 = 最后工作日次日', async () => {
    const w = await f055World(database().db, 'f055-due-leave');
    const id = await w.leave('2026-10-09');
    expect(await w.events(id)).toHaveLength(1);
    expect(await only(await w.gate('due', '2026-10-09', id))).toBe(false);
    expect(await only(await w.gate('due', '2026-10-10', id))).toBe(true);
  });

  it('当天与过去生效：事件写出时立即为真', async () => {
    const w = await f055World(database().db, 'f055-due-now');
    const today = await w.transfer('2026-10-01');
    expect(await only(await w.gate('due', '2026-10-01', today))).toBe(true);
    const past = await w.hired('过去生效员工');
    const earlier = await w.transfer('2026-09-20', past.employee.id);
    expect(await only(await w.gate('due', '2026-10-01', earlier))).toBe(true);
  });

  it('非 employment.record.create 事件恒真', async () => {
    const w = await f055World(database().db, 'f055-due-other-events');
    const id = await w.transfer('2026-10-20');
    const other = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ eventType: string; due: boolean; ready: boolean }>(
        await tx.execute(sql`SELECT e.event_type AS "eventType",
            (${recordEventDueSql('e', '2026-10-02')}) AS due,
            (${recordEventReadySql('e', '2026-10-02')}) AS ready
          FROM employment_outbox e
          WHERE e.tenant_id=${w.tenantId} AND e.object_id=${id}::uuid AND e.event_type <> ${RECORD_CREATE}`),
      ),
    );
    expect(other.length).toBeGreaterThan(0);
    for (const row of other) expect(row).toMatchObject({ due: true, ready: true });
    expect(await only(await w.gate('due', '2026-10-02', id))).toBe(false);
  });

  it('审批单：通过而未到生效日不写事件；激活任务到期落地后写出且立即为真', async () => {
    const w = await f055World(database().db, 'f055-due-approval');
    const application = await w.apply(w.subject.employee.id, '2026-10-20', { departmentId: w.to.id });
    const approved = await w.approve(application, '2026-10-01T02:00:00Z');
    expect(approved.status).toBe('approved');
    expect(await w.events(application.id)).toHaveLength(0);
    await w.runScheduler('2026-10-19T01:00:00Z');
    expect(await w.events(application.id)).toHaveLength(0);
    await w.runScheduler('2026-10-20T01:00:00Z');
    const [event] = await w.events(application.id);
    expect(event).toBeDefined();
    expect(await only(await w.gate('due', '2026-10-20', application.id))).toBe(true);
  });

  it('组织调整记录同样按生效日', async () => {
    const w = await f055World(database().db, 'f055-due-org-adjustment');
    await withTenant(w.db, w.tenantId, (tx) =>
      appendOrgAdjustment(tx, w.context('2026-10-01T02:00:00Z'), w.subject.employee.id, '2026-10-20', w.to.id),
    );
    const adjustments = (await w.events()).filter((event) => event.employeeId === w.subject.employee.id);
    const adjustment = adjustments.at(-1)!;
    expect(await only(await w.gate('due', '2026-10-19', adjustment.objectId))).toBe(false);
    expect(await only(await w.gate('due', '2026-10-20', adjustment.objectId))).toBe(true);
  });

  it('调动改期（生效日不可原地改，改期 = 删除后以新日期重存）：旧事件对应记录消失，新事件按新日期判断', async () => {
    const w = await f055World(database().db, 'f055-due-reschedule');
    const old = await w.transfer('2026-10-20');
    const moved = await w.reschedule(old, '2026-10-25');
    expect(moved).not.toBe(old);
    expect(await only(await w.gate('due', '2026-10-30', old))).toBe(false);
    expect(await only(await w.gate('ready', '2026-10-02', old))).toBe(true);
    expect(await only(await w.gate('due', '2026-10-24', moved))).toBe(false);
    expect(await only(await w.gate('due', '2026-10-25', moved))).toBe(true);
  });
});

describe('F-055 租户时区跨日边界（DEC-056）', () => {
  it('UTC 比租户本地日期早一天：上海 10-05 00:30 已到期，UTC 日期仍是 10-04', async () => {
    const w = await f055World(database().db, 'f055-tz-shanghai', { timezone: 'Asia/Shanghai' });
    const id = await w.transfer('2026-10-05');
    const instant = new Date('2026-10-04T16:30:00Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-10-04');
    const local = tenantLocalDate(instant, 'Asia/Shanghai');
    expect(local).toBe('2026-10-05');
    expect(await only(await w.gate('due', local, id))).toBe(true);
    const before = tenantLocalDate(new Date('2026-10-04T15:30:00Z'), 'Asia/Shanghai');
    expect(before).toBe('2026-10-04');
    expect(await only(await w.gate('due', before, id))).toBe(false);
  });

  it('UTC 比租户本地日期晚一天：洛杉矶 10-04 20:00，UTC 已是 10-05 但本地未到期', async () => {
    const w = await f055World(database().db, 'f055-tz-la', { timezone: 'America/Los_Angeles' });
    const id = await w.transfer('2026-10-05');
    const instant = new Date('2026-10-05T03:00:00Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-10-05');
    const local = tenantLocalDate(instant, 'America/Los_Angeles');
    expect(local).toBe('2026-10-04');
    expect(await only(await w.gate('due', local, id))).toBe(false);
    const next = tenantLocalDate(new Date('2026-10-05T07:30:00Z'), 'America/Los_Angeles');
    expect(next).toBe('2026-10-05');
    expect(await only(await w.gate('due', next, id))).toBe(true);
  });
});

describe('F-055 recordEventReadySql：到期或记录已消失', () => {
  it('生效日前删除的记录：当天之前即为真；仍在时间轴上且未到期为假；严格谓词对已删除记录始终为假', async () => {
    const w = await f055World(database().db, 'f055-ready');
    const kept = await w.transfer('2026-10-20');
    const other = await w.hired('将被删除的员工');
    const removed = await w.transfer('2026-10-20', other.employee.id);
    await w.remove(removed);
    expect(await only(await w.gate('ready', '2026-10-02', kept))).toBe(false);
    expect(await only(await w.gate('ready', '2026-10-02', removed))).toBe(true);
    expect(await only(await w.gate('ready', '2026-10-20', kept))).toBe(true);
    for (const day of ['2026-10-02', '2026-10-20', '2026-12-31'])
      expect(await only(await w.gate('due', day, removed))).toBe(false);
  });
});

describe('F-055 回归：transfer/completion.ts 行为不变（严格谓词）', () => {
  async function completionIds(w: Awaited<ReturnType<typeof f055World>>, at: string) {
    w.session.setNow(at);
    const response = await w.session.request('GET', '/completion-todos');
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
  }

  /** 经调动入口保存并清空直线经理（DEC-163：到期后产生“待补全”待办）。 */
  async function clearingTransfer(w: Awaited<ReturnType<typeof f055World>>, employeeId: string, date: string) {
    const employee = await w.session.getEmployee(employeeId);
    const saved = await w.session.request('POST', `/transfers/employees/${employeeId}`, {
      ifMatch: employee.revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: date,
        fields: { departmentId: w.to.id, directManagerId: null },
      },
    });
    expect(saved.status).toBe(201);
    return ((await saved.json()) as { id: string }).id;
  }

  it('未来记录到期前不产生待办，到期后产生；生效日前删除的记录永不产生待办', async () => {
    const w = await f055World(database().db, 'f055-completion-regression');
    const future = await clearingTransfer(w, w.subject.employee.id, '2026-10-05');
    const other = await w.hired('被删除补全员工');
    const removed = await clearingTransfer(w, other.employee.id, '2026-10-05');
    await w.remove(removed);

    await w.runScheduler('2026-10-04T01:00:00Z');
    expect(await completionIds(w, '2026-10-04T01:00:00Z')).toEqual([]);
    await w.runScheduler('2026-10-05T01:00:00Z');
    const due = await completionIds(w, '2026-10-05T01:00:00Z');

    expect(due).toContain(future);
    expect(due).not.toContain(removed);
    await w.runScheduler('2026-10-20T01:00:00Z');
    expect(await completionIds(w, '2026-10-20T01:00:00Z')).not.toContain(removed);

    const candidates = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ employeeId: string }>(await tx.execute(completionCandidates(w.context('2026-10-20T01:00:00Z')))),
    );
    expect(candidates.map((row) => row.employeeId)).not.toContain(other.employee.id);
  });
});
