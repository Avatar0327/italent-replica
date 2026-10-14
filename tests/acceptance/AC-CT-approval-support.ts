import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql, withTenant, type Db } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { contractWorld } from './AC-CT-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';

/** @param options.omitAvoidSelf 节点不带自审回避开关（模拟手工新建、不传开关的流程，缺省关闭，DEC-329④） */
export async function approvalContractWorld(db: Db, label: string, options: { omitAvoidSelf?: boolean } = {}) {
  const w = await contractWorld(db, label);
  const approver = await createUser(
    w.db,
    { email: `review-${randomUUID()}@example.com`, displayName: '合成审批人' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: approver.id, expectedRevision: 0 }, cmd());
  await withTenant(w.db, w.session.tenant.id, async (tx) => {
    for (const preset of PRESET_PROCESSES.filter((p) => p.approvalType.startsWith('contract_'))) {
      const ctx = {
        tenantId: w.session.tenant.id,
        userId: w.session.user.id,
        timezone: 'Asia/Shanghai',
        now: new Date('2026-10-01T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: 0,
      };
      const { avoidSelf: _avoidSelf, ...withoutAvoidSelf } = preset.definition.nodes[0]!.actions;
      const created = await createProcess(
        tx,
        ctx,
        { code: preset.code, approvalType: preset.approvalType },
        {
          ...preset.definition,
          exceptionAdminUserId: approver.id,
          nodes: [
            {
              ...preset.definition.nodes[0]!,
              ...(options.omitAvoidSelf ? { actions: withoutAvoidSelf } : {}),
              kind: 'single',
              approver: 'owner',
              exits: ['approve', 'disagree'],
            },
          ],
        },
      );
      await publishProcess(tx, { ...ctx, expectedRevision: created.revision }, created.id);
    }
  });
  async function pending() {
    return withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf<{ id: string; instanceId: string; revision: number }>(
        await tx.execute(sql`SELECT t.id,t.instance_id AS "instanceId",i.revision FROM approval_tasks t
        JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
        WHERE t.status='pending' ORDER BY t.id`),
      ),
    );
  }
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const act = (action: string, items: { id: string; revision: number }[], user = approver.id) =>
    api.request('POST', '/api/tenant/contracts/todos/batch', {
      tenant: w.session.tenant.id,
      user,
      ifMatch: 0,
      body: { action, items: items.map(({ id, revision }) => ({ id, revision })) },
    });
  return { ...w, pending, act, api };
}
