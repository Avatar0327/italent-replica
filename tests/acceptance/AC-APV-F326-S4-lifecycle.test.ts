/**
 * F-326 S4：AC-APV-F326-13（运行时读最新值，已派任务不动）与 AC-APV-F326-18（在途旧版本全链路）。
 * 实例经真实 HTTP 推进（提交 / 驳回 / 撤回 / 重提 / 审批），不直接改库伪造状态。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  counter,
  dropRoleColumn,
  instanceRow,
  matrix,
  matrixSource,
  matrixStatus,
  personnelChange,
  readMatrix,
  references,
  rejected,
  republish,
  s4World,
  variable,
  varSource,
  type S4World,
} from './AC-APV-F326-S4-support.js';
import type { InstanceView } from './AC-APV-support.js';

const database = useTestDb();

describe('AC-APV-F326-13 运行时读最新值', () => {
  it('变量改值后，之后激活的节点取新值；已派任务不被改动', async () => {
    const w = await s4World(database().db, 'live');
    const far = await w.person('合成丙', w.staff);
    const v = await variable(w);
    const source = varSource('public_variable', v.id);
    await w.publishedProcess({ nodes: [counter([source], { key: 'a' }), counter([source], { key: 'b' })] });

    const instance = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    const first = w.pending(instance);
    expect(first.map((task) => task.assigneeUserId)).toEqual([w.near.userId]);

    const edited = await w.request(w.hr.id, 'PATCH', `/api/tenant/approval/variables/${v.id}`, {
      ifMatch: v.revision,
      body: { defaultValue: far.userId },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    // 已派任务仍在原人名下
    const unchanged = await w.detail(instance.id);
    expect(w.pending(unchanged).map((task) => task.assigneeUserId)).toEqual([w.near.userId]);

    const done = await w.taskAction(w.near.userId, first[0]!.id, 'approve', unchanged.revision, {});
    expect(done.status, await done.clone().text()).toBe(200);
    const next = w.pending(await w.detail(instance.id));
    expect(next.map((task) => [task.nodeKey, task.assigneeUserId])).toEqual([['b', far.userId]]);
  });
});

type Status = 'running' | 'returned' | 'withdrawn';

/** 个人信息变更 v1：n1 指定人 → n2 矩阵角色列 R（空人转异常管理员）；发布 v2 不再引用 R。 */
async function scenario(w: S4World, status: Status) {
  const m = await matrix(w, { rows: [{ cond: [], role: [w.head.userId] }] });
  const nodes = [
    counter([{ type: 'specified', value: w.near.userId }], { key: 'n1' }),
    counter([matrixSource(m, m.roleId)], { key: 'n2', noAssignee: 'exception_admin' }),
  ];
  const process = await w.publishedProcess({
    approvalType: 'personnel_change',
    isFallback: true,
    conditions: { items: [] },
    nodes,
  });
  const change = await personnelChange(w);
  const { instance } = await change.submit();
  const v1 = (await instanceRow(w, instance.id)).version_id;

  if (status === 'returned') {
    const task = w.pending(instance)[0]!;
    const rejectedTask = await w.taskAction(w.near.userId, task.id, 'reject', instance.revision, {
      comment: '合成驳回',
    });
    expect(rejectedTask.status, await rejectedTask.clone().text()).toBe(200);
  }
  if (status === 'withdrawn') {
    const response = await w.instanceAction(w.subject.userId, instance.id, 'withdraw', instance.revision);
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const current = await w.detail(instance.id, w.subject.userId);
  expect(current.status).toBe(status);

  await republish(w, process, [
    counter([{ type: 'specified', value: w.near.userId }], { key: 'n1' }),
    counter([{ type: 'specified', value: w.head.userId }], { key: 'n2' }),
  ]);
  return { m, instance: current, v1 };
}

/** 让实例回到第 1 节点待办：returned / withdrawn 先重新提交，实例仍绑定 v1。 */
async function backToFirstNode(w: S4World, instance: InstanceView, v1: string): Promise<InstanceView> {
  let view = instance;
  if (view.status !== 'running') {
    const response = await w.instanceAction(w.subject.userId, view.id, 'resubmit', view.revision, {});
    expect(response.status, await response.clone().text()).toBe(200);
    view = await w.detail(view.id, w.subject.userId);
  }
  expect(view.status).toBe('running');
  expect((await instanceRow(w, view.id)).version_id).toBe(v1);
  return view;
}

async function approveFirstNode(w: S4World, view: InstanceView): Promise<InstanceView> {
  const task = w.pending(view).find((item) => item.nodeKey === 'n1')!;
  const response = await w.taskAction(w.near.userId, task.id, 'approve', view.revision, {});
  expect(response.status, await response.clone().text()).toBe(200);
  return w.detail(view.id, w.subject.userId);
}

describe.each<Status>(['running', 'returned', 'withdrawn'])('AC-APV-F326-18 在途旧版本（%s）', (status) => {
  it('查看引用标在途旧版本；停用清单含 v1；删角色列 409', async () => {
    const w = await s4World(database().db, `inflight-${status}`);
    const { m } = await scenario(w, status);
    const shown = await references(w, 'matrices', m.id);
    expect(shown.total).toBe(1);
    expect(shown.items[0]).toMatchObject({
      versionKind: 'in_flight',
      versionNo: 1,
      nodeKey: 'n2',
      position: 'approver',
      columnId: m.roleId,
      instanceCount: 1,
    });
    await rejected(await matrixStatus(w, m, 'disable'), 409, 'APPROVAL_REFERENCES_CHANGED');
    const dropped = await dropRoleColumn(w, m);
    expect(dropped.status).toBe(409);
    expect(JSON.stringify(await dropped.json())).toContain('APPROVAL_MATRIX_COLUMN_REFERENCED');
    expect((await readMatrix(w, m.id)).columns.map((column) => column.kind).sort()).toEqual(['condition', 'role']);
  });

  it('甲（不停用）：推进 v1，第 2 节点派给 R 的当前人员；实例结束后可删 R', async () => {
    const w = await s4World(database().db, `branch-a-${status}`);
    const { m, instance, v1 } = await scenario(w, status);
    // R 的当前人员在推进前变更：派单读最新值（AC-13）
    const replacement = await w.person('合成角色新人', w.staff);
    const row = (await readMatrix(w, m.id)).rows[0]!;
    const update = await w.request(w.hr.id, 'PUT', `/api/tenant/approval/matrices/${m.id}/structure`, {
      body: {
        revision: m.revision,
        columns: m.columns.map((column) => ({
          id: column.id,
          key: column.kind === 'role' ? 'r' : 'c',
          kind: column.kind,
          dimension: column.kind === 'role' ? null : 'department',
          includeChildren: false,
          name: column.kind,
          allowMultiple: column.kind === 'role',
        })),
        rows: [{ id: row.id, cells: { c: [], r: [replacement.userId] } }],
      },
    });
    expect(update.status, await update.clone().text()).toBe(200);

    const first = await backToFirstNode(w, instance, v1);
    const second = await approveFirstNode(w, first);
    expect(w.pending(second).map((task) => [task.nodeKey, task.assigneeUserId])).toEqual([['n2', replacement.userId]]);
    const last = w.pending(second)[0]!;
    const approved = await w.taskAction(replacement.userId, last.id, 'approve', second.revision, {});
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect((await w.detail(instance.id, w.subject.userId)).status).toBe('approved');

    expect((await references(w, 'matrices', m.id)).items).toEqual([]);
    const dropped = await dropRoleColumn(w, await readMatrix(w, m.id));
    expect(dropped.status, await dropped.clone().text()).toBe(200);
  });

  it('乙（停用）：按影响清单的引用数确认停用后，第 2 节点转异常管理员', async () => {
    const w = await s4World(database().db, `branch-b-${status}`);
    const { m, instance, v1 } = await scenario(w, status);
    const { total } = await references(w, 'matrices', m.id);
    const stopped = await matrixStatus(w, m, 'disable', { acknowledgedReferenceCount: total });
    expect(stopped.status, await stopped.clone().text()).toBe(200);

    const first = await backToFirstNode(w, instance, v1);
    const second = await approveFirstNode(w, first);
    const tasks = w.pending(second);
    expect(tasks.map((task) => [task.nodeKey, task.assigneeUserId, task.isExceptionAdmin])).toEqual([
      ['n2', w.exceptionAdmin, true],
    ]);
    expect(tasks.map((task) => task.assigneeUserId)).not.toContain(w.head.userId);
    expect(
      second.logs.filter((log) => log.event === 'no_assignee_exception_admin' && log.nodeKey === 'n2'),
    ).toHaveLength(1);
  });
});
