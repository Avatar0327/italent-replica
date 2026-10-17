/**
 * R2-T03 B2b / AC-DM-18（设计 §4 / §9 合并待办）：批量离职申请 POST exits/batch，≤ 100 人，每人一张离职申请并各自提交
 * （每人一条流程），整体成功或整体失败；任一人不满足 → 整批 409 EXIT_BATCH_REJECTED、逐条原因、无任何写入（B-25）。
 * 权限逐人：范围外 / 无按钮的人同样只作为逐条原因出现（B-64）。审批中心待办带 batchId，供前端按批次合并展示。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons, gateWorld, type GateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const LATER = '2026-10-20';

async function item(w: GateWorld, employeeId: string, exit: object = { exitTypeCode: 'voluntary' }) {
  return { employeeId, revision: (await w.session.getEmployee(employeeId)).revision, lastWorkDate: LATER, exit };
}

type Rejected = { items: { index: number; employeeId: string; code: string; reason?: string }[] };

describe('AC-DM-18 POST exits/batch', () => {
  it('全部满足：201 返回 batchId 与逐人业务；每人一张已提交的申请，扩展行同一 batch_id；待办带 batchId', async () => {
    const w = await gateWorld(database().db, 'batch-ok');
    const people = [(await w.hired('甲')).employee.id, (await w.hired('乙')).employee.id];
    const response = await w.session.request('POST', '/exits/batch', {
      body: { items: await Promise.all(people.map((id) => item(w, id))) },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { batchId: string; items: { id: string; status: string }[] };
    expect(body.items.map((business) => business.status)).toEqual(['in_review', 'in_review']);
    for (const business of body.items)
      expect(await w.exitRow(business.id)).toMatchObject({ batch_id: body.batchId, mode: 'application' });
    for (const id of people) expect((await w.stateOf(id)).instances).toHaveLength(1);
    const todos = await w.session.request('GET', '/../approval/todos');
    expect(todos.status).toBe(200);
    const { items } = (await todos.json()) as { items: { batchId: string | null }[] };
    expect(items.filter((todo) => todo.batchId === body.batchId)).toHaveLength(2);
  });

  it('B-25 含范围外 / 在途离职 / §8A 命中 / 无按钮者：整批 409 逐条原因，任何人都无写入', async () => {
    const w = await gateWorld(database().db, 'batch-reject');
    const ok = (await w.hired('正常')).employee.id;
    const inProgress = (await w.hired('在途离职')).employee.id;
    await w.createdLeave(inProgress, { kind: 'leave', mode: 'application', lastWorkDate: LATER, fields: {} });
    const overdue = (await w.hired('逾期调动')).employee.id;
    await w.synthetic(overdue, { kind: 'transfer', state: 'approved', effectiveDate: '2026-10-02' });
    const other = await w.otherUser();
    const outside = (await w.employeeAs(other.id, '范围外')).id;
    const everyone = [ok, inProgress, overdue, outside];
    const before = await Promise.all(everyone.map((id) => w.stateOf(id)));
    const hr = w.restricted(denyButtons(), w.session.user.id);
    const response = await hr('POST', '/exits/batch', {
      body: { items: await Promise.all(everyone.map((id) => item(w, id))) },
    });
    expect(await w.reason(response.clone())).toMatchObject({ status: 409, reason: 'EXIT_BATCH_REJECTED' });
    const { items } = ((await response.json()) as { error: { details: Rejected } }).error.details;
    expect(items.map(({ index, employeeId, code, reason }) => ({ index, employeeId, code, reason }))).toEqual([
      { index: 1, employeeId: inProgress, code: 'CONFLICT', reason: 'EXIT_IN_PROGRESS' },
      { index: 2, employeeId: overdue, code: 'CONFLICT', reason: 'EXIT_LATE_TRANSFER_PENDING' },
      { index: 3, employeeId: outside, code: 'NOT_FOUND', reason: undefined },
    ]);
    expect(await Promise.all(everyone.map((id) => w.stateOf(id)))).toEqual(before);
  });

  it('B-64 批量中缺按钮：整批 409，逐人 403；超过 100 人 400；空批 400', async () => {
    const w = await gateWorld(database().db, 'batch-perm');
    const id = (await w.hired()).employee.id;
    const before = await w.stateOf(id);
    const noApply = w.restricted(denyButtons('Employment.DimissionApproval'));
    const response = await noApply('POST', '/exits/batch', { body: { items: [await item(w, id)] } });
    expect(await w.reason(response.clone())).toMatchObject({ status: 409, reason: 'EXIT_BATCH_REJECTED' });
    expect(((await response.json()) as { error: { details: Rejected } }).error.details.items).toMatchObject([
      { index: 0, employeeId: id, code: 'FORBIDDEN' },
    ]);
    const many = Array.from({ length: 101 }, () => ({ employeeId: id, revision: 1, lastWorkDate: LATER }));
    expect((await w.session.request('POST', '/exits/batch', { body: { items: many } })).status).toBe(400);
    expect((await w.session.request('POST', '/exits/batch', { body: { items: [] } })).status).toBe(400);
    expect(await w.stateOf(id)).toEqual(before);
  });
});
