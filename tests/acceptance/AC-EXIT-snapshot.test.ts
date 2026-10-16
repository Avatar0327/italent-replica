/**
 * F-196（#362 第 1 轮 P3-5 / #374 第 1 轮 P2-1）：B-80 / B-86 前后快照夹具 stateSnapshot 的自检。
 * 成功命令台账（command_ledger，response_status < 400）要按“响应落在本员工的审批实例上”进快照：
 * 审批动作的成功回执是 { instanceId }（approval/actions.ts ok()），不是 { id }。
 * 本员工命中；其他员工、其他租户、失败回执都不进本员工的快照；既有行被删除时 addedRows 判红。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { addedRows, expectChanges, gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();

type World = Awaited<ReturnType<typeof gateWorld>>;

/** 员工发起并提交一张离职申请，返回其审批实例 ID。 */
async function submittedInstance(w: World, employeeId: string) {
  const draft = await w.createdLeave(employeeId, leaveBody('2026-10-20'));
  const sent = await w.session.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {} });
  expect(sent.status, await sent.clone().text()).toBe(200);
  const [instance] = (await w.stateOf(employeeId)).instances as { id: string }[];
  expect(instance).toBeDefined();
  return instance!.id;
}

/** 直接往指定租户写一条台账行（审批动作的回执结构）。 */
async function ledgerRow(w: World, body: object, status = 200) {
  const commandId = `snapshot-${randomUUID()}`;
  await withTenant(w.db, w.session.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO command_ledger(tenant_id, command_id, request_hash, response_status, response_body)
      VALUES (${w.session.tenant.id}, ${commandId}, 'snapshot', ${status}, ${JSON.stringify(body)}::jsonb)`),
  );
  return commandId;
}

async function scene(label: string) {
  const w = await gateWorld(database().db, label);
  const mine = (await w.hired('本员工')).employee;
  const other = (await w.hired('其他员工')).employee;
  return {
    w,
    mine,
    other,
    mineInstance: await submittedInstance(w, mine.id),
    otherInstance: await submittedInstance(w, other.id),
  };
}

describe('F-196 / AC-DM-32 B-80 / AC-DM-33 B-86 stateSnapshot 成功命令台账按审批实例归属', () => {
  it('本员工审批实例的 { instanceId } 成功回执进快照，且只进本员工的快照', async () => {
    const { w, mine, other, mineInstance } = await scene('snapshot-hit');
    const [mineBefore, otherBefore] = [await w.stateOf(mine.id), await w.stateOf(other.id)];
    const commandId = await ledgerRow(w, { instanceId: mineInstance });
    const after = await w.stateOf(mine.id);
    expect(addedRows(mineBefore.ledger, after.ledger)).toMatchObject([{ command_id: commandId, response_status: 200 }]);
    expect(() => expectChanges(mineBefore, after, {})).toThrow();
    expect(await w.stateOf(other.id)).toEqual(otherBefore);
  });

  it('其他员工审批实例的回执不进本员工的快照', async () => {
    const { w, mine, other, otherInstance } = await scene('snapshot-other-employee');
    const before = await w.stateOf(mine.id);
    const commandId = await ledgerRow(w, { instanceId: otherInstance });
    expect(await w.stateOf(mine.id)).toEqual(before);
    expect((await w.stateOf(other.id)).ledger.map((row) => row.command_id)).toContain(commandId);
  });

  it('其他租户的同 ID 回执不进本租户的快照；失败回执（≥ 400）也不进', async () => {
    const { w, mine, mineInstance } = await scene('snapshot-other-tenant');
    const foreign = await gateWorld(database().db, 'snapshot-foreign');
    // 基线先读，再插入外租户成功回执（响应体的 id / instanceId / employeeId 都指向本员工）和本租户失败回执
    const before = await w.stateOf(mine.id);
    const foreignKey = `foreign-probe-${randomUUID()}`;
    await withTenant(foreign.db, foreign.session.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO command_ledger(tenant_id, command_id, request_hash, response_status, response_body)
        VALUES (${foreign.session.tenant.id}, ${foreignKey}, 'snapshot', 200,
          ${JSON.stringify({ instanceId: mineInstance, id: mineInstance, employeeId: mine.id })}::jsonb)`),
    );
    const failedKey = await ledgerRow(w, { instanceId: mineInstance }, 409);
    const after = await w.stateOf(mine.id);
    expect(after).toEqual(before);
    // 明确断言两个键都不在快照里：整份相等本身挡不住“基线里就已读进来”的情形
    const keys = after.ledger.map((row) => row.command_id);
    expect(keys).not.toContain(foreignKey);
    expect(keys).not.toContain(failedKey);
    // 正向对照：同一个员工 ID 在外租户自己的快照里能读到这条回执（确认插入没有落空，过滤确实是靠租户隔离挡住的）
    expect((await foreign.stateOf(mine.id)).ledger.map((row) => row.command_id)).toContain(foreignKey);
  });

  it('addedRows：只追加的行集里既有行被删除或改动即判红', () => {
    const rows = [
      { command_id: 'a', response_status: 200 },
      { command_id: 'b', response_status: 200 },
    ];
    expect(addedRows(rows, [...rows, { command_id: 'c', response_status: 200 }])).toEqual([
      { command_id: 'c', response_status: 200 },
    ]);
    expect(() => addedRows(rows, [rows[0]!])).toThrow();
    expect(() => addedRows(rows, [rows[0]!, { command_id: 'b', response_status: 201 }])).toThrow();
  });
});
