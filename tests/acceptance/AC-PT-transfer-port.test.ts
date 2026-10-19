/**
 * BE-7 PT-6 调动联动端口（docs/08_设计/R2-T05_兼职设计.md §4.7，PB-40 / PB-50 / PB-51）：端口直接调用的语义，
 * 与 AC-LNK-06-part-time（经调动全链路）互补。
 * - exists：属于该员工、非主职、进行中（开始日 ≤ 今天 ≤ 结束日或无结束日），操作人按 DEC-177 可见；其余一律 false；
 * - listOngoing：只列进行中的兼职，不可见的只计件数 hiddenCount；
 * - end：追加 end = 失效日 / 空区间 / 幂等不追加；source = transfer、source_id = 子项；同事务作废该记录上未办结的延长 / 结束申请。
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '@italent/api';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  transferPartTimePort,
  transferPartTimePortIsDefault,
} from '../../apps/api/src/modules/transfer/linkage/part-time.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { APV_TODAY } from './AC-APV-support.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { orgScope } from './support/revocable-rights.js';

const database = useTestDb();
const world = (label: string) => requestWorld(database().db, `pt6-port-${label}`);

/** 在持有员工行锁的租户事务里调用端口（调动联动执行时调用方已持有，§7.1）。 */
function exists(w: RequestWorld, ctx: EmploymentContext, employeeId: string, recordId: string) {
  return w.run((tx) => transferPartTimePort().exists(tx, ctx, { employeeId, recordId }));
}

async function end(w: RequestWorld, recordId: string, endDate: string, itemId = randomUUID()) {
  await w.run(async (tx) => {
    const ctx = w.context();
    await lockEmploymentEmployee(tx, ctx, w.worker.employeeId);
    await transferPartTimePort().end(tx, ctx, { employeeId: w.worker.employeeId, recordId, endDate, itemId });
  });
  return itemId;
}

describe('PT-6 装配：createApp 登记的是真实端口，不是缺省实现', () => {
  it('transferPartTimePortIsDefault 为 false', async () => {
    await world('wired');
    expect(transferPartTimePortIsDefault()).toBe(false);
  });
});

describe('exists（校验层，DEC-177）', () => {
  it('只认该员工名下进行中的兼职；不存在 / 主职 / 他人 / 未开始 / 已结束一律 false', async () => {
    const w = await world('exists');
    const ctx = w.context();
    const ongoing = await w.seedRecord({ endDate: null });
    const endsToday = await w.seedRecord({ endDate: APV_TODAY });
    const future = await w.seedRecord({ startDate: '2026-10-02', endDate: null });
    const ended = await w.seedRecord({ endDate: '2026-09-30' });
    const empty = await w.seedRecord({ startDate: '2026-09-20', endDate: '2026-09-19' });
    const employeeId = w.worker.employeeId;
    expect(await exists(w, ctx, employeeId, ongoing)).toBe(true);
    expect(await exists(w, ctx, employeeId, endsToday)).toBe(true);
    for (const recordId of [future, ended, empty, randomUUID()])
      expect(await exists(w, ctx, employeeId, recordId), recordId).toBe(false);
    expect(await exists(w, ctx, w.approvers.sHead.employeeId, ongoing)).toBe(false);
    const [primary] = await w.run(async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT id FROM employment_records WHERE tenant_id=${w.tenant.id}
          AND employee_id=${employeeId}::uuid AND service_type='primary' LIMIT 1`),
      ),
    );
    expect(await exists(w, ctx, employeeId, primary!.id)).toBe(false);
  });

  it('操作人看不到该兼职（兼职部门与员工主职部门都不在范围内）→ false，与不存在同样的结果', async () => {
    const w = await world('exists-scope');
    const record = await w.seedRecord({ endDate: null });
    const employeeId = w.worker.employeeId;
    const scoped = (...orgIds: string[]): EmploymentContext => ({
      ...w.context(),
      scope: orgScope(w.tenant.id, APV_TODAY, ...orgIds),
    });
    expect(await exists(w, scoped(w.side), employeeId, record)).toBe(true);
    expect(await exists(w, scoped(w.primary), employeeId, record)).toBe(true);
    expect(await exists(w, scoped(w.staff), employeeId, record)).toBe(false);
  });
});

describe('PB-50 listOngoing（调动表单“兼职调整”区）', () => {
  it('只列进行中的兼职（未来开始 / 已结束 / 空区间不列）；不可见的只计件数', async () => {
    const w = await world('list');
    const ongoing = await w.seedRecord({ startDate: '2026-09-05', endDate: '2026-12-31' });
    const open = await w.seedRecord({ startDate: '2026-09-10', endDate: null });
    await w.seedRecord({ startDate: '2026-10-02', endDate: null });
    await w.seedRecord({ endDate: '2026-09-30' });
    await w.seedRecord({ startDate: '2026-09-20', endDate: '2026-09-19' });
    const hidden = await w.seedRecord({ startDate: '2026-09-15', endDate: null, departmentId: w.staff });
    const list = (ctx: EmploymentContext) =>
      w.run((tx) => transferPartTimePort().listOngoing!(tx, ctx, w.worker.employeeId, APV_TODAY));

    const all = await list(w.context());
    expect(all.hiddenCount).toBe(0);
    expect(all.items.map((item) => item.id)).toEqual([ongoing, hidden, open]);
    expect(all.items[0]).toEqual({
      id: ongoing,
      serviceType: 'part_time',
      departmentId: w.side,
      positionId: null,
      startDate: '2026-09-05',
      endDate: '2026-12-31',
    });

    // 范围 = 兼职部门：员工主职部门不在范围内，只剩兼职部门是 side 的两条可见；部门是 staff 的那条只计件数
    const scoped = await list({ ...w.context(), scope: orgScope(w.tenant.id, APV_TODAY, w.side) });
    expect(scoped.items.map((item) => item.id)).toEqual([ongoing, open]);
    expect(scoped.hiddenCount).toBe(1);
    const none = await list({ ...w.context(), scope: orgScope(w.tenant.id, APV_TODAY, randomUUID()) });
    expect(none).toEqual({ items: [], hiddenCount: 3 });
  });
});

describe('end（联动执行，PB-51 幂等 / PB-40 作废在途申请）', () => {
  it('追加 end = 失效日，source = transfer、source_id = 子项；同一子项重复调用不再追加', async () => {
    const w = await world('end');
    const record = await w.seedRecord({ endDate: null });
    const itemId = await end(w, record, '2026-10-12');
    await end(w, record, '2026-10-12', itemId);
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: null, source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-10-12', source: 'transfer', source_id: itemId },
    ]);
    expect(await w.auditActions(record)).toEqual(['employment.part_time.ended_by_transfer']);
  });

  it('S4 当前结束日不晚于失效日 → 不追加、不审计；S5 开始日晚于失效日 → 空区间（开始日 − 1）', async () => {
    const w = await world('end-edge');
    const closed = await w.seedRecord({ endDate: '2026-10-05' });
    await end(w, closed, '2026-10-05');
    await end(w, closed, '2026-10-12');
    expect(await w.terms(closed)).toHaveLength(1);
    expect(await w.auditActions(closed)).toEqual([]);

    const late = await w.seedRecord({ startDate: '2026-09-25', endDate: null });
    const itemId = await end(w, late, '2026-09-19');
    expect(await w.terms(late)).toEqual([
      { term_no: 1, end_date: null, source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-09-24', source: 'transfer', source_id: itemId },
    ]);
  });

  it('业务拒绝：记录不存在 / 不属于该员工 → NOT_FOUND（子项失败，可重试），无写入', async () => {
    const w = await world('end-missing');
    const before = await w.writes();
    for (const recordId of [randomUUID()]) {
      const error = await w.rejected(() => end(w, recordId, '2026-10-12'));
      expect(error).toMatchObject({ code: 'NOT_FOUND', reason: 'PART_TIME_RECORD_NOT_FOUND' });
    }
    expect(await w.writes()).toEqual(before);
    await expect(end(w, randomUUID(), '2026-10-12')).rejects.toBeInstanceOf(AppError);
  });

  it('PB-40：审批中的结束申请被联动结束作废（reason = transfer），实例取消，审计与站内消息；其他兼职与新增申请不受影响', async () => {
    const w = await world('end-void');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const other = await w.seedRecord({ startDate: '2026-09-02', endDate: '2026-10-31' });
    const ending = await w.end(record, '2026-09-20');
    await w.send(ending.id, ending.revision);
    const instance = await w.instance(ending.id);
    const unrelated = await w.end(other, '2026-09-20');
    await w.send(unrelated.id, unrelated.revision);
    const add = await w.create({});

    await end(w, record, '2026-10-12');

    expect((await w.states(ending.id)).at(-1)).toMatchObject({ state: 'voided', reason: 'transfer' });
    expect((await w.detail(instance.id)).status).toBe('cancelled');
    expect(await w.auditActions(ending.id)).toContain('part_time.request.voided_by_transfer');
    expect(await w.notices(instance.id)).toEqual([
      { recipient: w.hr.id, template: 'part_time_request_voided', kind: 'message' },
    ]);
    expect((await w.states(unrelated.id)).at(-1)).toMatchObject({ state: 'in_review' });
    expect((await w.states(add.id)).at(-1)).toMatchObject({ state: 'draft' });
    expect((await w.terms(record)).map((term) => [term.end_date, term.source])).toEqual([
      ['2026-10-31', 'create'],
      ['2026-10-12', 'transfer'],
    ]);
  });

  it('联动结束没有追加期限（已更早结束）时，同一记录上未办结的延长申请同样作废（不让它把已结束的兼职再延长）', async () => {
    const w = await world('end-void-noop');
    const record = await w.seedRecord({ endDate: '2026-10-05' });
    const extension = await w.extend(record, '2026-12-31');
    await end(w, record, '2026-10-12');
    expect((await w.states(extension.id)).at(-1)).toMatchObject({ state: 'voided', reason: 'transfer' });
    expect(await w.terms(record)).toHaveLength(1);
  });
});
