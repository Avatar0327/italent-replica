/** F-316 / DEC-678：两个交接节点的空审批人策略；默认沿用 DEC-663 / DEC-674。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { api, definition, inputOf, KEYS, POLICIES, publish, reach, view, world } from './AC-EXIT-F316-support.js';

const database = useTestDb();

describe('AC-EXIT-F316 两节点 × 三选项 × 有人 / 无人', () => {
  for (const key of KEYS) {
    for (const policy of POLICIES[key]) {
      it.each([true, false])(`DEC-678 ${key} / ${policy} / 主取人=%s`, async (primary) => {
        const x = await world(database().db, `${key}-${policy}-${primary}`, key !== 'other_handover' || primary);
        const fallback = [x.workOwner.userId, x.hrbp.userId];
        await publish(x, definition(x, { [key]: { emptyApproverPolicy: policy, fallbackUserIds: fallback } }));
        const run = await reach(x, key, primary);
        if (!primary && policy === 'stop') {
          expect(run.request).toMatchObject({ state: 'not_launched', instanceId: null });
          expect(await x.handoverInstanceCount()).toBe(0);
          expect((await x.statusOf(run.exitId)).status).toBe('not_launched');
          expect((await x.business(run.exitId)).status).toBe('approved');
          return;
        }
        expect(run.request.state).toBe('in_progress');
        const pending = await x.pendingTasks(run.instanceId);
        if (primary) {
          expect(pending).toEqual([
            expect.objectContaining({
              nodeKey: key,
              userId: key === 'work_handover' ? x.workOwner.userId : x.hrAdmin.id,
            }),
          ]);
        } else if (policy === 'specified') {
          expect(pending.map((task) => task.userId).sort()).toEqual([...fallback].sort());
          expect(pending.every((task) => task.nodeKey === key && !task.isExceptionAdmin)).toBe(true);
        } else if (policy === 'exception_admin') {
          expect(pending).toEqual([
            expect.objectContaining({ nodeKey: key, userId: x.exceptionAdmin.id, isExceptionAdmin: true }),
          ]);
        } else {
          expect(pending).toEqual([
            expect.objectContaining({ nodeKey: key === 'work_handover' ? 'other_handover' : 'employee_confirm' }),
          ]);
          const tasks = await x.sqlRows(sql`SELECT id, assignee_user_id, status, origin FROM approval_tasks
            WHERE tenant_id=${x.tenantId} AND instance_id=${run.instanceId}::uuid AND node_key=${key}`);
          expect(tasks).toEqual([
            expect.objectContaining({ assignee_user_id: null, status: 'approved', origin: 'no_assignee_approve' }),
          ]);
          const logs = await x.sqlRows(sql`SELECT actor_user_id, event, detail FROM approval_instance_logs
            WHERE tenant_id=${x.tenantId} AND instance_id=${run.instanceId}::uuid AND node_key=${key}
              AND event='auto_approve'`);
          expect(logs).toEqual([
            expect.objectContaining({ actor_user_id: null, detail: expect.objectContaining({ handler: '系统' }) }),
          ]);
          const audits = await x.sqlRows(sql`SELECT actor_user_id, after FROM audit_events
            WHERE tenant_id=${x.tenantId} AND object_id=${tasks[0]!.id} AND action='approval.task.create'`);
          expect(audits).toEqual([
            expect.objectContaining({ actor_user_id: null, after: expect.objectContaining({ status: 'approved' }) }),
          ]);
        }
      });
    }
  }
});

describe('AC-EXIT-F316 默认与指定人员退回', () => {
  for (const key of KEYS) {
    it.each([false, true])(`DEC-663 ${key} 未配置新字段，兜底有人=%s，行为保持`, async (hasFallback) => {
      const x = await world(database().db, `default-${key}-${hasFallback}`, false);
      await publish(x, definition(x, { [key]: { fallbackUserIds: hasFallback ? [x.hrbp.userId] : [] } }));
      const run = await reach(x, key, false);
      if (key === 'work_handover' && !hasFallback) {
        expect(run.request).toMatchObject({ state: 'not_launched', instanceId: null });
      } else {
        expect(await x.pendingTasks(run.instanceId)).toEqual([
          expect.objectContaining({ nodeKey: key, userId: hasFallback ? x.hrbp.userId : x.exceptionAdmin.id }),
        ]);
      }
    });

    it.each(['empty', 'unavailable'])(`DEC-678 ${key} 指定名单 %s，退回节点默认`, async (kind) => {
      const x = await world(database().db, `specified-${key}-${kind}`, false);
      await publish(
        x,
        definition(x, {
          [key]: { emptyApproverPolicy: 'specified', fallbackUserIds: kind === 'empty' ? [] : [x.hrbp.userId] },
        }),
      );
      if (kind === 'unavailable') {
        await withTenant(x.db, x.tenantId, (tx) =>
          tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
          WHERE tenant_id=${x.tenantId} AND user_id=${x.hrbp.userId}::uuid`),
        );
      }
      const run = await reach(x, key, false);
      if (key === 'work_handover') {
        expect(run.request).toMatchObject({ state: 'not_launched', instanceId: null });
      } else {
        expect(await x.pendingTasks(run.instanceId)).toEqual([
          expect.objectContaining({ nodeKey: key, userId: x.exceptionAdmin.id, isExceptionAdmin: true }),
        ]);
      }
    });
  }

  it('DEC-674 停住后改为自动同意，HR 同单重新提交；同键重放不重复自动同意或发消息', async () => {
    const x = await world(database().db, 'resubmit', false);
    const process = await publish(x, definition(x, { work_handover: { emptyApproverPolicy: 'stop' } }));
    const run = await reach(x, 'work_handover', false);
    expect(run.request.state).toBe('not_launched');
    const draft = await view(await api(x, 'POST', `/${process.id}/versions`, process.revision, {}), 201);
    const input = inputOf(draft.latestVersion);
    const saved = await view(
      await api(x, 'PUT', `/${process.id}/draft`, draft.revision, {
        ...input,
        nodes: input.nodes.map((node) =>
          KEYS.includes(node.key as (typeof KEYS)[number])
            ? {
                ...node,
                emptyApproverPolicy: 'auto_approve',
                messageRules: [
                  { trigger: 'approve', channels: ['inbox'], template: 'F316_APPROVED', recipient: 'owner' },
                ],
              }
            : node,
        ),
      }),
    );
    await view(await api(x, 'POST', `/${process.id}/publish`, saved.revision, {}));
    const row = (
      await x.sqlRows<{ revision: number }>(sql`SELECT revision FROM exit_handover_requests
      WHERE tenant_id=${x.tenantId} AND id=${run.request.id}::uuid`)
    )[0]!;
    const options = { ifMatch: row.revision, body: {}, idempotencyKey: randomUUID() };
    const path = `/exit-handover-requests/${run.request.id}/resubmit`;
    const response = await x.session.request('POST', path, options);
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = (await response.json()) as { approvalInstanceId: string };
    expect(await (await x.session.request('POST', path, options)).json()).toEqual(receipt);
    expect((await x.requestRows(run.exitId)).map((request) => request.id)).toEqual([run.request.id]);
    expect((await x.pendingNode(receipt.approvalInstanceId))?.nodeKey).toBe('employee_confirm');
    expect(
      await x.sqlRows(sql`SELECT id FROM approval_tasks WHERE tenant_id=${x.tenantId}
      AND instance_id=${receipt.approvalInstanceId}::uuid AND origin='no_assignee_approve'`),
    ).toHaveLength(2);
    expect(
      await x.sqlRows(sql`SELECT id FROM approval_notifications WHERE tenant_id=${x.tenantId}
      AND instance_id=${receipt.approvalInstanceId}::uuid AND template_code='F316_APPROVED'`),
    ).toHaveLength(2);
    for (let step = 0; step < 2; step++) {
      const result = await x.decide(receipt.approvalInstanceId);
      expect(result.status, await result.clone().text()).toBe(200);
    }
    expect((await x.statusOf(run.exitId)).status).toBe('completed');
  });
});
