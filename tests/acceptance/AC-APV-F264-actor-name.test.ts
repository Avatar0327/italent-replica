/**
 * F-264（DEC-654 批 2、DEC-656）：审批日志下发操作人姓名 actorName，紧挨 actorUserId。
 * - actorUserId 为空（系统动作）→ actorName 为 null；非空 → 账号显示名（tenant_member_accounts，与审计 operatorNames 同源）；
 *   查不到 → 与审计相同的兜底“非本租户用户”；
 * - 三处出口同形状：详情 logs、历史分页 /logs items、管理员日志 /admin-logs items；
 * - 能看到这条日志才能看到姓名：记录被隐藏（DEC-115）时 logs 与历史分页 items 为空，姓名不经任何路径漏出；
 * - 同一响应多条日志批量只查一次名字。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';
import { assessmentWorld } from './AC-PB-BE15b1-support.js';
import { revokeBySystem } from '../../apps/api/src/modules/approval/actions.js';
import { appendLog, loadInstance, withActorNames } from '../../apps/api/src/modules/approval/store.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';
const FALLBACK = '非本租户用户';

type Named = { event: string; actorUserId: string | null; actorName?: string | null };

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

const approvals = (logs: readonly Named[]) => logs.filter((log) => log.event === 'approve');

describe('F-264 审批日志操作人姓名', () => {
  it('同意日志带审批人显示名；详情、历史分页、管理员日志三处同形状', async () => {
    const w = await approvalWorld(database().db, 'f264-approve');
    const s = await transferScene(w);
    const admin = (await w.person('流程管理员', s.from)).userId;
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));

    const detail = await w.detail(view.id);
    expect(approvals(detail.logs)).toEqual([
      expect.objectContaining({ actorUserId: s.outHead.userId, actorName: s.outHead.name }),
    ]);
    const start = detail.logs.find((log) => log.event === 'start')!;
    expect(start).toMatchObject({ actorUserId: w.hr.id, actorName: expect.any(String) });

    const history = await w.json<{ items: Named[] }>(
      await w.request(w.hr.id, 'GET', `${BASE}/instances/${view.id}/logs`),
    );
    expect(approvals(history.items)).toEqual([
      expect.objectContaining({ actorUserId: s.outHead.userId, actorName: s.outHead.name }),
    ]);

    const listed = await w.json<{ items: (Named & { instanceId: string })[] }>(
      await w.request(admin, 'GET', `${BASE}/admin-logs`),
    );
    const mine = listed.items.filter((log) => log.instanceId === view.id && log.event === 'approve');
    expect(mine).toEqual([expect.objectContaining({ actorUserId: s.outHead.userId, actorName: s.outHead.name })]);
  });

  it('驳回日志带审批人显示名', async () => {
    const w = await approvalWorld(database().db, 'f264-reject');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'reject', view.revision, { comment: '合成驳回' }),
    );
    const rejected = view.logs.filter((log) => log.event === 'reject');
    expect(rejected).toEqual([expect.objectContaining({ actorUserId: s.outHead.userId, actorName: s.outHead.name })]);
  });

  it('记录被隐藏（DEC-115）时 logs 与历史分页 items 为空，响应里不含任何操作人姓名', async () => {
    const w = await approvalWorld(database().db, 'f264-hidden');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [TRANSFER_NODES[0]!, { ...TRANSFER_NODES[2]!, hideRecords: true }, TRANSFER_NODES[1]!],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    const hidden = await w.detail(view.id, s.inHead.userId);
    expect(hidden).toMatchObject({ recordsHidden: true, logs: [] });
    const history = await w.request(s.inHead.userId, 'GET', `${BASE}/instances/${view.id}/logs`);
    const body = (await history.json()) as { items: unknown[]; recordsHidden: boolean };
    expect(body).toMatchObject({ items: [], recordsHidden: true });
    for (const text of [JSON.stringify(hidden), JSON.stringify(body)]) {
      expect(text).not.toContain(s.outHead.name);
      expect(text).not.toContain('actorName');
    }
  });

  it('操作人账号查不到时给审计同款兜底文案，不报错', async () => {
    const w = await approvalWorld(database().db, 'f264-missing');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    const ghost = randomUUID();
    // 日志只增不改：用写入口追加一条操作人不属于本租户的日志
    await withTenant(w.db, w.tenant.id, async (tx) =>
      appendLog(
        tx,
        {
          tenantId: w.tenant.id,
          userId: w.hr.id,
          timezone: 'Asia/Shanghai',
          now: w.clock(),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        await loadInstance(tx, w.tenant.id, view.id),
        { event: 'approve', actorUserId: ghost },
      ),
    );
    const after = await w.detail(view.id);
    expect(approvals(after.logs).find((log) => log.actorUserId === ghost)).toMatchObject({ actorName: FALLBACK });
  });

  it('同一响应的多条日志只批量查一次名字；系统动作不查也不带名', async () => {
    const w = await approvalWorld(database().db, 'f264-batch');
    const s = await transferScene(w);
    const logs = [s.outHead.userId, s.inHead.userId, s.outHead.userId, null].map((actorUserId) => ({
      event: 'approve',
      actorUserId,
    }));
    await withTenant(w.db, w.tenant.id, async (tx) => {
      let queries = 0;
      const counting = new Proxy(tx, {
        get: (target, key, receiver) =>
          key === 'execute'
            ? (...args: Parameters<typeof tx.execute>) => {
                queries += 1;
                return target.execute(...args);
              }
            : Reflect.get(target, key, receiver),
      });
      const named = await withActorNames(counting, logs);
      expect(queries).toBe(1);
      expect(named.map((log) => log.actorName)).toEqual([s.outHead.name, s.inHead.name, s.outHead.name, null]);
      queries = 0;
      expect(await withActorNames(counting, [{ event: 'approve', actorUserId: null }])).toEqual([
        { event: 'approve', actorUserId: null, actorName: null },
      ]);
      expect(queries).toBe(0);
    });
  });
});

describe('F-264 考核类审批日志', () => {
  it('试用 / 转正考核走审批流：详情日志带审批人姓名；系统撤销日志操作人与姓名都为空', async () => {
    const x = await assessmentWorld(database().db, 'f264');
    const person = await x.probationer('考核员工');
    const assessmentId = await x.launch('probation', person);
    const before = await x.instance(assessmentId);
    expect(before.logs[0]).toMatchObject({ actorUserId: x.hr.id, actorName: expect.any(String) });
    const task = x.pending(before)[0]!;
    const approver = (
      await x.json<InstanceView>(
        await x.taskAction(task.assigneeUserId, task.id, 'approve', before.revision, { comment: '合成意见' }),
      )
    ).logs.find((log) => log.event === 'approve')!;
    expect(approver.actorName).toEqual(expect.any(String));
    expect(approver.actorName).not.toBe(FALLBACK);

    const other = await x.launch('regularization', await x.probationer('转正员工'));
    const instanceId = (await x.instance(other)).id;
    await withTenant(x.db, x.tenant.id, (tx) =>
      revokeBySystem(
        tx,
        {
          tenantId: x.tenant.id,
          userId: x.hr.id,
          timezone: 'Asia/Shanghai',
          now: x.clock(),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        instanceId,
        '合成撤销理由',
      ),
    );
    const revoked = (await x.instance(other)).logs.at(-1)!;
    expect(revoked).toMatchObject({ event: 'system_revoke', actorUserId: null, actorName: null });
  });
});
