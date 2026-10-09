/**
 * F-063 合同合并待办批量回执保留确定失败的机器码（PR #145 第 1 轮审查存量 P3；docs/08_设计/F-048_PR-2_路由声明.md #30）：
 * - 确定失败的逐条回执带 reason（如 APPROVAL_SELF_REVIEW）与 details.recusal（self / subjects），与单条办理的错误一致；
 * - 成功条目不受影响；普通冲突（REVISION_CONFLICT）只带错误码；
 * - 结果未知 / 存储不可写仍只给 reason（客户端按原命令 ID 回查，PR #75 第二轮 P2-8）；
 * - recusal 只给有权办理该任务的人（F-048 设计 §4.2）：非当前审批人在授权检查处就被拒绝，拿不到 reason / recusal。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { CommandFailureError } from '../../apps/api/src/audit/failures.js';
import { AppError } from '../../apps/api/src/errors.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';
import { receiptError } from '../../apps/api/src/modules/contracts/todos.js';
import { approvalContractWorld } from './AC-CT-approval-support.js';
import { dropFrozen, insertFrozen } from './support/f048.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();
type World = Awaited<ReturnType<typeof approvalContractWorld>>;
interface Receipt {
  id: string;
  status: number;
  error?: { code: string; message: string; reason?: string; recusal?: string };
}

/** 每份合同一种类型（同员工同类型只允许一份有效合同），逐一发起续签申请，返回对应的待办。 */
async function applications(w: World, count: number) {
  const types = [w.type.id, w.otherType.id];
  while (types.length < count) {
    const response = await w.request('POST', '/master-data/types', {
      ifMatch: 0,
      body: { code: randomUUID(), name: `合同类型${types.length}` },
    });
    types.push(((await response.json()) as { id: string }).id);
  }
  const sources = [];
  for (const typeId of types.slice(0, count)) sources.push(await w.create({ typeId }));
  const response = await w.request('POST', '/batch', {
    ifMatch: 0,
    body: {
      items: sources.map((c) => ({
        revision: c.revision,
        command: {
          operation: 'renew',
          mode: 'application',
          employeeId: w.employee.id,
          targetId: c.id,
          fields: { effectiveDate: '2026-10-01', endDate: '2027-09-30' },
        },
      })),
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const tasks = await w.pending();
  expect(tasks).toHaveLength(count);
  return tasks;
}

async function assigneeOf(w: World, taskId: string) {
  const [row] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ assignee_user_id: string }>(
      await tx.execute(sql`SELECT assignee_user_id::text FROM approval_tasks WHERE id=${taskId}::uuid`),
    ),
  );
  return row!.assignee_user_id;
}

async function batch(w: World, user: string, items: { id: string; revision: number }[]) {
  const response = await w.api.request('POST', '/api/tenant/contracts/todos/batch', {
    tenant: w.session.tenant.id,
    user,
    ifMatch: 0,
    body: { action: 'approve', items },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Receipt[] }).items;
}

describe('F-063 合同批量回执：确定失败保留具体机器码', () => {
  it('同一批里混有自审回避 / 多主体回避 / 普通冲突 / 成功：回执逐条正确', async () => {
    const w = await approvalContractWorld(testDb().db, 'f063mixed');
    const [self, ok, conflict, subjects] = await applications(w, 4);
    const approver = await assigneeOf(w, ok!.id);
    // 多主体回避：办理人账号在冻结的 U(S) 中（异常数据，防御；同 AC-CT-approval-actions T9d）。
    await insertFrozen(w.db, w.session.tenant.id, subjects!.instanceId, approver);
    // 自审回避：存量实例（无冻结行）按实时绑定回退，把员工的账号绑定换成办理人（办理人即异动本人） → 节点级 avoidSelf 命中 self。
    await dropFrozen(w.db, w.session.tenant.id, self!.instanceId);
    await w.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.session.tenant.id}, true)`);
      await tx.execute(sql`UPDATE permission_user_person_links SET user_id=${approver}::uuid
        WHERE tenant_id=${w.session.tenant.id} AND employee_id=${w.employee.id}::uuid`);
    });

    const receipts = await batch(w, approver, [
      { id: self!.id, revision: self!.revision },
      { id: ok!.id, revision: ok!.revision },
      { id: conflict!.id, revision: conflict!.revision + 7 },
      { id: subjects!.id, revision: subjects!.revision },
    ]);

    expect(receipts.map((r) => [r.id, r.status])).toEqual([
      [self!.id, 409],
      [ok!.id, 200],
      [conflict!.id, 409],
      [subjects!.id, 409],
    ]);
    expect(receipts[0]!.error).toMatchObject({ code: 'CONFLICT', reason: 'APPROVAL_SELF_REVIEW', recusal: 'self' });
    expect(receipts[1]!.error).toBeUndefined();
    expect(receipts[2]!.error).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(receipts[2]!.error).not.toHaveProperty('recusal');
    expect(receipts[3]!.error).toMatchObject({ code: 'CONFLICT', reason: 'APPROVAL_SELF_REVIEW', recusal: 'subjects' });
    // 失败条目任务不动，成功条目已办理。
    expect((await w.pending()).map((t) => t.id).sort()).toEqual([self!.id, conflict!.id, subjects!.id].sort());
  });

  it('非当前审批人（即使在冻结主体中）拿不到 reason / recusal，只得到授权拒绝', async () => {
    const w = await approvalContractWorld(testDb().db, 'f063noright');
    const [task] = await applications(w, 1);
    const outsider = await createUser(
      w.db,
      { email: `outsider-${randomUUID()}@example.com`, displayName: '无关成员' },
      cmd(),
    );
    await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: outsider.id, expectedRevision: 0 }, cmd());
    await insertFrozen(w.db, w.session.tenant.id, task!.instanceId, outsider.id);

    const [receipt] = await batch(w, outsider.id, [{ id: task!.id, revision: task!.revision }]);

    expect(receipt!.status).toBe(403);
    expect(receipt!.error).toEqual({ code: 'FORBIDDEN', message: expect.any(String) });
  });
});

describe('F-063 receiptError 口径', () => {
  it('结果未知 / 存储不可写仍只带 reason，不带 recusal 与命令细节', () => {
    const unknown = new CommandFailureError({ outcome: 'unknown', errorCode: 'UNKNOWN', reason: null }, 'cmd-1');
    expect(receiptError(unknown, true)).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.any(String),
      reason: 'RESULT_UNKNOWN',
    });
    const storage = new CommandFailureError(
      { outcome: 'storage_unwritable', errorCode: '53100', reason: null },
      'cmd-2',
    );
    expect(receiptError(storage, true)).toMatchObject({ code: 'SERVICE_UNAVAILABLE', reason: 'STORAGE_UNWRITABLE' });
  });

  it('授权检查之前的失败不带 recusal，即使 details 里有', () => {
    const early = new AppError('CONFLICT', '回避', { reason: 'APPROVAL_SELF_REVIEW', recusal: 'subjects' });
    expect(receiptError(early, false)).toEqual({ code: 'CONFLICT', message: '回避', reason: 'APPROVAL_SELF_REVIEW' });
    expect(receiptError(early, true)).toMatchObject({ recusal: 'subjects' });
  });
});
