/** F-294：管理员日志与详情 / 历史共用 DEC-115 / DEC-656 的查看人隐藏口径。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
  type LogView,
} from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';
type AdminLog = LogView & { instanceId: string };

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function adminLogs(w: ApprovalWorld, userId: string, query = '') {
  return w.json<{ items: AdminLog[] }>(await w.request(userId, 'GET', `${BASE}/admin-logs${query}`));
}

async function expectHidden(w: ApprovalWorld, instanceId: string, userId: string) {
  expect(await w.detail(instanceId, userId)).toMatchObject({ recordsHidden: true, logs: [] });
  const history = await w.json(await w.request(userId, 'GET', `${BASE}/instances/${instanceId}/logs`));
  expect(history).toMatchObject({ recordsHidden: true, items: [] });
  // 整条日志消失：不只抹姓名，也不能留下操作人 ID、意见、节点、时间等字段。
  for (const query of ['', '?adminSelfTransfer=false', '?page=2&pageSize=1']) {
    const listed = await adminLogs(w, userId, query);
    expect(listed.items.filter((log) => log.instanceId === instanceId)).toEqual([]);
  }
}

describe('AC-APV-F294 管理员日志隐藏记录', () => {
  it('DEC-115 / DEC-656：隐藏节点参与人有 adminLogs 权限时整块隐藏；未隐藏节点和未参与管理员照常可见', async () => {
    const w = await approvalWorld(database().db, 'f294-viewers');
    const s = await transferScene(w);
    const admin = await w.member('合成独立管理员');
    await w.publishedProcess({
      nodes: [TRANSFER_NODES[0]!, { ...TRANSFER_NODES[2]!, hideRecords: true }, TRANSFER_NODES[1]!],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision, {
        comment: '合成审批意见 F294',
      }),
    );
    // 两个查看人都不受隐藏节点约束：一个参与未隐藏节点，一个从未参与。
    for (const viewer of [s.outHead.userId, admin]) {
      const detail = await w.detail(view.id, viewer);
      expect(detail.recordsHidden).toBe(false);
      const expected = expect.objectContaining({
        event: 'approve',
        actorUserId: s.outHead.userId,
        actorName: s.outHead.name,
        detail: { comment: '合成审批意见 F294' },
      });
      expect(detail.logs).toContainEqual(expected);
      const history = await w.json<{ items: LogView[] }>(
        await w.request(viewer, 'GET', `${BASE}/instances/${view.id}/logs`),
      );
      expect(history.items).toContainEqual(expected);
      expect((await adminLogs(w, viewer)).items).toContainEqual(expected);
    }
    await expectHidden(w, view.id, s.inHead.userId);
  });

  it('DEC-115：本人处理过隐藏节点后又参与未隐藏节点，管理员日志仍不返回本人或他人的记录', async () => {
    const w = await approvalWorld(database().db, 'f294-history');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        { ...TRANSFER_NODES[0]!, hideRecords: true },
        TRANSFER_NODES[2]!,
        { key: 'again', approver: { type: 'department', value: 'latest_record_department_head' } },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    for (const viewer of [s.outHead.userId, s.inHead.userId]) {
      view = await w.json(
        await w.taskAction(viewer, current(view).id, 'approve', view.revision, { comment: '合成本人历史意见' }),
      );
    }
    expect(current(view).nodeKey).toBe('again');
    await expectHidden(w, view.id, s.outHead.userId);
    expect((await adminLogs(w, s.inHead.userId)).items).toHaveLength(2);
  });

  it('DEC-115：开始节点隐藏只限制发起人；同页其他实例仍可见', async () => {
    const w = await approvalWorld(database().db, 'f294-initiator');
    const s = await transferScene(w);
    await w.publishedProcess({ priority: 100, hideRecordsFromInitiator: true, nodes: TRANSFER_NODES });
    let hidden = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    hidden = await w.json(await w.taskAction(s.outHead.userId, current(hidden).id, 'approve', hidden.revision));
    await expectHidden(w, hidden.id, w.hr.id);
    expect((await adminLogs(w, s.outHead.userId)).items).toHaveLength(1);

    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const other = await w.person('合成另一申请人', s.from);
    let visible = await w.submit(await w.application(other.employeeId, { departmentId: s.to }));
    visible = await w.json(await w.taskAction(s.outHead.userId, current(visible).id, 'approve', visible.revision));
    expect((await adminLogs(w, w.hr.id)).items).toEqual([
      expect.objectContaining({ instanceId: visible.id, actorName: s.outHead.name }),
    ]);
  });

  it('AC-APV-F294：无 adminLogs 权限仍为 403；有按钮但无数据范围时仍为空', async () => {
    const w = await approvalWorld(database().db, 'f294-denied');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    const real = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    const denied = await real.request('GET', `${BASE}/admin-logs`, w.as(s.outHead.userId));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { details: { reason: 'APPROVAL_ADMIN_REQUIRED' } },
    });
    const buttonOnly = tenantApi(w.db, {
      authorize: (request) => String(request.resource).endsWith('#adminLogs@list'),
      clock: w.clock,
    });
    const empty = await w.json<{ items: AdminLog[] }>(
      await buttonOnly.request('GET', `${BASE}/admin-logs`, w.as(s.outHead.userId)),
    );
    expect(empty.items).toEqual([]);
  });

  it('AC-APV-F294：另一租户管理员不能读到本租户日志或借本租户请求头越权', async () => {
    const w = await approvalWorld(database().db, 'f294-tenant-a');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect((await adminLogs(w, w.hr.id)).items).toHaveLength(1);
    const other = await approvalWorld(database().db, 'f294-tenant-b');
    expect((await adminLogs(other, other.hr.id)).items).toEqual([]);
    const denied = await other.api.request('GET', `${BASE}/admin-logs`, {
      user: other.hr.id,
      tenant: w.tenant.id,
    });
    expect(denied.status).toBe(403);
  });
});
