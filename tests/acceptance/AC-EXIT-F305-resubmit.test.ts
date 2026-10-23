/** AC-DM-07 / F-305：DEC-663、DEC-674，HR 在同一交接单重新提交，失败不留下半套审批。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, STANDARD_GRANT_CODES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  discardProcess,
  loadProcess,
  newVersion,
  publishProcess,
  replaceDraft,
} from '../../apps/api/src/modules/approval/definitions.js';
import { handoverWorld, TODAY, type HandoverWorld } from './AC-EXIT-handover-support.js';
import { deniesObjectUpdate, isButton, revocable } from './support/revocable-rights.js';

const database = useTestDb();
const BUTTON = 'Employment.HandoverReSubmit';
const pathOf = (id: string) => `/exit-handover-requests/${id}/resubmit`;
type Cause = 'NO_HANDLER' | 'APPROVAL_PROCESS_NOT_MATCHED' | 'NO_INITIATOR_ACCOUNT';
const CAUSES: readonly Cause[] = ['NO_HANDLER', 'APPROVAL_PROCESS_NOT_MATCHED', 'NO_INITIATOR_ACCOUNT'];

async function world(label: string, process = true) {
  const x = await handoverWorld(database().db, `f305-${label}`);
  await x.addSettingItems();
  if (process) await x.publishHandoverProcess();
  else {
    // 通用任职夹具预置了兜底流程；本场景须明确撤掉所有交接流程，不能只省略四节点流程的发布。
    const processes = await x.sqlRows<{ id: string; revision: number }>(sql`SELECT id, revision
      FROM approval_processes WHERE tenant_id=${x.tenantId} AND approval_type='exit_handover' AND status='active'`);
    await withTenant(x.db, x.tenantId, async (tx) => {
      for (const current of processes)
        await discardProcess(
          tx,
          {
            tenantId: x.tenantId,
            userId: x.processAdmin.id,
            timezone: 'Asia/Shanghai',
            now: new Date(`${TODAY}T01:00:00Z`),
            commandId: randomUUID(),
            expectedRevision: current.revision,
          },
          current.id,
        );
    });
  }
  return x;
}
async function rowOf(x: HandoverWorld, exitId: string) {
  return (
    await x.sqlRows<{ id: string; revision: number; state: string; notLaunchedReason: string | null }>(sql`
    SELECT id, revision, state, not_launched_reason AS "notLaunchedReason" FROM exit_handover_requests
    WHERE tenant_id=${x.tenantId} AND exit_request_id=${exitId}::uuid`)
  )[0]!;
}
async function unlaunched(cause: Cause) {
  const x = await world(cause, cause !== 'APPROVAL_PROCESS_NOT_MATCHED');
  if (cause === 'NO_INITIATOR_ACCOUNT') await x.unbindAccount(x.employee.id);
  const { approved } = await x.approvedApplication(x.employee.id, {
    exit: cause === 'NO_HANDLER' ? { handoverEmployeeId: undefined } : {},
  });
  const row = await rowOf(x, approved.id);
  expect(row, '三种成因都必须持久化未发起记录').toMatchObject({ state: 'not_launched', notLaunchedReason: cause });
  expect(await x.handoverInstanceCount()).toBe(0);
  return { x, exitId: approved.id, row };
}
async function repairFallback(x: HandoverWorld) {
  const [process] = await x.sqlRows<{ id: string }>(sql`SELECT id FROM approval_processes
    WHERE tenant_id=${x.tenantId} AND code='AAA_EXIT_HANDOVER'`);
  await withTenant(x.db, x.tenantId, async (tx) => {
    const ctx = {
      tenantId: x.tenantId,
      userId: x.processAdmin.id,
      timezone: 'Asia/Shanghai',
      now: new Date(`${TODAY}T03:00:00Z`),
      commandId: randomUUID(),
      expectedRevision: 0,
    };
    const current = await loadProcess(tx, x.tenantId, process!.id);
    const draft = await newVersion(tx, { ...ctx, expectedRevision: current.revision }, current.id);
    const changed = await replaceDraft(tx, { ...ctx, expectedRevision: draft.revision }, current.id, {
      ...draft.latestVersion,
      nodes: draft.latestVersion.nodes.map((node) =>
        node.key === 'work_handover' ? { ...node, fallbackUserIds: [x.workOwner.userId] } : node,
      ),
    });
    await publishProcess(tx, { ...ctx, expectedRevision: changed.revision }, current.id);
  });
}
async function repair(x: HandoverWorld, cause: Cause) {
  if (cause === 'NO_HANDLER') await repairFallback(x);
  if (cause === 'APPROVAL_PROCESS_NOT_MATCHED') await x.publishHandoverProcess();
  if (cause === 'NO_INITIATOR_ACCOUNT') await x.applicantAccount(x.employee.id);
}
const options = (revision: number) => ({ ifMatch: revision, idempotencyKey: randomUUID(), body: {} });
async function success(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { requestId: string; status: string; revision: number; approvalInstanceId: string };
}
async function snapshot(x: HandoverWorld) {
  return x.sqlRows(sql`SELECT
    (SELECT jsonb_agg(r ORDER BY r.id) FROM exit_handover_requests r WHERE tenant_id=${x.tenantId}) AS requests,
    (SELECT jsonb_agg(i ORDER BY i.id) FROM exit_handover_request_items i WHERE tenant_id=${x.tenantId}) AS items,
    (SELECT jsonb_agg(a ORDER BY a.id) FROM approval_instances a WHERE tenant_id=${x.tenantId}) AS instances,
    (SELECT jsonb_agg(t ORDER BY t.id) FROM approval_tasks t WHERE tenant_id=${x.tenantId}) AS tasks,
    (SELECT count(*) FROM command_ledger WHERE tenant_id=${x.tenantId}) AS commands,
    (SELECT count(*) FROM audit_events WHERE tenant_id=${x.tenantId} AND action='exit_handover.resubmit') AS audits`);
}

describe('AC-DM-07 / F-305 同单重新提交', () => {
  it('DEC-674 独立详情按钮，默认授予任职模块人事身份', () => {
    expect(MODULE_OBJECTS.employmentRecord.buttons).toContainEqual({
      code: BUTTON,
      name: '重新提交交接',
      level: 'detail',
      requires: 'update',
    });
    for (const profile of ['standard_org_system_admin', 'standard_hr_admin', 'standard_hr_specialist'])
      expect(STANDARD_GRANT_CODES).toContain(`${profile}/TenantBase.EmploymentRecord/button:${BUTTON}@detail`);
    expect(STANDARD_GRANT_CODES.some((code) => code.startsWith('standard_employee/') && code.includes(BUTTON))).toBe(
      false,
    );
  });

  it.each(CAUSES)('DEC-663/674 %s 修复后同单发起，重放只产生一个实例与一条审计', async (cause) => {
    const { x, exitId, row } = await unlaunched(cause);
    await repair(x, cause);
    const init = options(row.revision);
    const receipt = await success(await x.session.request('POST', pathOf(row.id), init));
    expect(receipt).toMatchObject({ requestId: row.id, status: 'in_progress', revision: row.revision + 1 });
    expect(await rowOf(x, exitId)).toMatchObject({ id: row.id, state: 'in_progress', notLaunchedReason: null });
    expect(await x.pendingTasks(receipt.approvalInstanceId)).toEqual([
      expect.objectContaining({ nodeKey: 'work_handover', userId: x.workOwner.userId }),
    ]);
    expect(await x.itemRows(row.id)).toHaveLength(3);
    const before = await snapshot(x);
    expect(await success(await x.session.request('POST', pathOf(row.id), init))).toEqual(receipt);
    expect(await snapshot(x)).toEqual(before);
    const audits = await x.sqlRows<{ actor: string; after: unknown }>(sql`SELECT actor_user_id AS actor, after
      FROM audit_events WHERE tenant_id=${x.tenantId} AND object_id=${row.id} AND action='exit_handover.resubmit'`);
    expect(audits).toEqual([
      expect.objectContaining({
        actor: x.session.user.id,
        after: expect.objectContaining({ approvalInstanceId: receipt.approvalInstanceId }),
      }),
    ]);
  });

  it.each(CAUSES)('DEC-674 %s 配置仍缺，返回同原因 409 且所有业务写入回滚', async (cause) => {
    const { x, row } = await unlaunched(cause);
    const before = await snapshot(x);
    const response = await x.session.request('POST', pathOf(row.id), options(row.revision));
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: cause } } });
    expect(await snapshot(x)).toEqual(before);
  });

  it('DEC-674 已终止重提使用新实例，旧实例、任务、日志原样保留且不能再审批', async () => {
    const x = await world('terminated');
    const { exitId, request, instanceId } = await x.launched();
    const oldTask = (await x.pendingNode(instanceId))!;
    expect((await x.decide(instanceId, 'disagree')).status).toBe(200);
    const old = () =>
      x.sqlRows(sql`SELECT
      (SELECT to_jsonb(a) FROM approval_instances a WHERE tenant_id=${x.tenantId} AND id=${instanceId}::uuid) AS instance,
      (SELECT jsonb_agg(t ORDER BY id) FROM approval_tasks t
        WHERE tenant_id=${x.tenantId} AND instance_id=${instanceId}::uuid) AS tasks,
      (SELECT jsonb_agg(l ORDER BY id) FROM approval_instance_logs l
        WHERE tenant_id=${x.tenantId} AND instance_id=${instanceId}::uuid) AS logs`);
    const before = await old();
    const row = await rowOf(x, exitId);
    const receipt = await success(await x.session.request('POST', pathOf(request.id), options(row.revision)));
    expect(receipt.requestId).toBe(request.id);
    expect(receipt.approvalInstanceId).not.toBe(instanceId);
    expect(await x.requestRows(exitId)).toHaveLength(1);
    expect(await x.handoverInstanceCount()).toBe(2);
    expect(await old()).toEqual(before);
    const stale = await x.api.request('POST', `/api/tenant/approval/tasks/${oldTask.taskId}/approve`, {
      ...x.tenantAs(oldTask.userId),
      ifMatch: oldTask.revision,
      body: {},
    });
    expect(stale.status).toBe(409);
    expect(await old()).toEqual(before);
    await x.approveAll(receipt.approvalInstanceId);
    expect((await rowOf(x, exitId)).state).toBe('completed');
  });

  it.each(['in_progress', 'completed'] as const)('DEC-674 %s 新命令拒绝，原因码明确', async (state) => {
    const x = await world(state);
    const { exitId, request, instanceId } = await x.launched();
    if (state === 'completed') await x.approveAll(instanceId);
    const before = await snapshot(x);
    const response = await x.session.request('POST', pathOf(request.id), options((await rowOf(x, exitId)).revision));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: 'EXIT_HANDOVER_NOT_RESUBMITTABLE', state } },
    });
    expect(await snapshot(x)).toEqual(before);
  });

  it('DEC-674 离职已撤销不能重新发起交接；旧 revision 拒绝', async () => {
    const { x, exitId, row } = await unlaunched('NO_HANDLER');
    await repairFallback(x);
    const stale = await x.session.request('POST', pathOf(row.id), options(row.revision + 1));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    await x.cancelExit(exitId);
    const cancelled = await x.session.request('POST', pathOf(row.id), options((await rowOf(x, exitId)).revision));
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: { details: { reason: 'EXIT_HANDOVER_EXIT_CANCELLED' } } });
  });

  it('DEC-674 入口无按钮 403、范围外与不存在同一个 404，不能借用编辑离职按钮', async () => {
    const { x, row } = await unlaunched('NO_HANDLER');
    const noButton = x.restricted((request) => !isButton(BUTTON)(request));
    expect((await noButton('POST', pathOf(row.id), options(row.revision))).status).toBe(403);
    const outside = x.restricted(() => true, randomUUID());
    const hidden = await outside('POST', pathOf(row.id), options(row.revision));
    const missing = await outside('POST', pathOf(randomUUID()), options(row.revision));
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it.each(['button', 'object', 'scope'] as const)(
    'DEC-674 命令内撤销 %s，首次与重放均拒绝且不写业务',
    async (right) => {
      const { x, row } = await unlaunched('NO_HANDLER');
      await repairFallback(x);
      const { rights, authorize } = revocable();
      const request = x.asUser(x.session.user.id, authorize);
      const init = options(row.revision);
      const revoke = () => {
        rights.deny = right === 'button' ? isButton(BUTTON) : right === 'object' ? deniesObjectUpdate : undefined;
        rights.emptyScope = right === 'scope';
      };
      revoke();
      const before = await snapshot(x);
      expect((await request('POST', pathOf(row.id), init)).status).toBe(right === 'scope' ? 404 : 403);
      expect(await snapshot(x)).toEqual(before);
      rights.deny = undefined;
      rights.emptyScope = false;
      await success(await request('POST', pathOf(row.id), init));
      const after = await snapshot(x);
      revoke();
      expect((await request('POST', pathOf(row.id), init)).status).toBe(right === 'scope' ? 404 : 403);
      expect(await snapshot(x)).toEqual(after);
    },
  );
});
