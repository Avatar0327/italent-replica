import { sql, withTenant } from '@italent/db';
import type { ApproverSource } from '@italent/domain';
import { expect } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import type { InstanceView, NodeInput, ProcessView } from './AC-APV-support.js';
import { APPROVAL, type S4World } from './AC-APV-F326-S4-support.js';
import {
  audits,
  autoAt,
  create,
  draftOk,
  manager,
  newVersion,
  specified,
  varRow,
  type AutoRow,
} from './AC-APV-F326-S7a-support.js';

export const OLD = '旧版本在途单清零自动停用';
export const DISCARDED = '作废流程在途单清零自动停用';
export const SAVED = '不再被引用';
export const instanceTrigger = (id: string, status: string) => ({ kind: 'instance', instanceId: id, status });
export const publishTrigger = (v: ProcessView) => ({ kind: 'publish', newVersionId: v.latestVersion.id });
export const node = (key: string, approver: ApproverSource = manager, over: Partial<NodeInput> = {}): NodeInput => ({
  key,
  name: `合成节点${key}`,
  approver,
  ...over,
});

export async function baseline(w: S4World, approvalType = 'transfer', nodes?: NodeInput[]) {
  const a = await w.publish(
    await create(
      w,
      nodes ?? [
        node('n1', specified(w.head.userId), { exits: ['approve', 'disagree'] }),
        node('n2', specified(w.near.userId)),
      ],
      { approvalType },
    ),
  );
  const x = await autoAt(w, a.id, 'n2');
  return { a, x };
}

export async function replacement(
  w: S4World,
  a: ProcessView,
  nodes = [node('n1', specified(w.head.userId)), node('n2')],
) {
  return draftOk(w, await newVersion(w, a), nodes);
}

export async function retired(w: S4World, x: AutoRow) {
  return (await audits(w, x.id)).filter((row) => row.action === 'approval.public_variable.auto_disable');
}

export async function enabled(w: S4World, x: AutoRow) {
  expect((await varRow(w, x.id)).status, '仍有生命周期引用的变量应保持启用').toBe('enabled');
  expect(await retired(w, x)).toHaveLength(0);
}

export async function systemRetirement(
  w: S4World,
  x: AutoRow,
  a: ProcessView,
  trigger: Record<string, unknown>,
  reason = OLD,
  previousRevision = x.revision,
) {
  expect(await varRow(w, x.id), '最后一个生命周期引用消失后变量应在本次提交中停用').toMatchObject({
    status: 'disabled',
    revision: previousRevision + 1,
    updated_by: x.updated_by,
  });
  const trail = await retired(w, x);
  expect(trail).toHaveLength(1);
  expect(trail[0]).toMatchObject({
    action: 'approval.public_variable.auto_disable',
    actor: null,
    before: { status: 'enabled' },
    after: {
      status: 'disabled',
      reason,
      processId: a.id,
      versionId: a.latestVersion.id,
      versionNo: a.latestVersion.versionNo,
      trigger,
    },
  });
  expect(trail[0]!.before).toEqual({ status: 'enabled' });
  return trail[0]!;
}

export function discard(w: S4World, a: ProcessView) {
  return w.request(w.hr.id, 'POST', `${APPROVAL}/processes/${a.id}/discard`, { ifMatch: a.revision, body: {} });
}

export const act = (
  w: S4World,
  instance: InstanceView,
  action: 'approve' | 'reject' | 'disagree',
  idempotencyKey?: string,
) => {
  const [task] = w.pending(instance);
  expect(task, '合成实例应有可办理待办').toBeDefined();
  return w.request(task!.assigneeUserId!, 'POST', `${APPROVAL}/tasks/${task!.id}/${action}`, {
    ifMatch: instance.revision,
    body: {},
    idempotencyKey,
  });
};

export const withdraw = (w: S4World, i: InstanceView) =>
  w.instanceAction(w.subject.userId, i.id, 'withdraw', i.revision);

export async function employmentWithdraw(w: S4World, i: InstanceView) {
  const business = await w.business(i.businessId);
  return w.request(w.hr.id, 'POST', `/api/tenant/employment/businesses/${i.businessId}/withdraw`, {
    ifMatch: business.revision,
    body: {},
  });
}

export async function deleteReturned(w: S4World, i: InstanceView, idempotencyKey?: string) {
  const business = await w.business(i.businessId);
  return w.request(w.hr.id, 'DELETE', `/api/tenant/employment/businesses/${i.businessId}`, {
    ifMatch: business.revision,
    body: {},
    idempotencyKey,
  });
}

export function instanceState(w: S4World, id: string) {
  return withTenant(
    w.db,
    w.tenant.id,
    async (tx) =>
      rowsOf<{ status: string; round: number; revision: number; version_id: string }>(
        await tx.execute(sql`SELECT status, round, revision, version_id::text
        FROM approval_instances WHERE tenant_id=${w.tenant.id} AND id=${id}::uuid`),
      )[0]!,
  );
}

export function terminalNodes(w: S4World): NodeInput[] {
  // 复用 F-048 主体回避夹具：两笔申请的冻结主体均含同一审批人。
  const actions = { avoidSelf: false, avoidSubjects: true };
  return [node('n2', specified(w.head.userId), { actions })];
}

export async function personnelSubmitter(w: S4World) {
  await w.json(
    await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
      ifMatch: 0,
      body: { value: { education: ['school'] } },
    }),
  );
  return async ({ employeeId, userId }: { employeeId: string; userId: string }) => {
    const record = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/personnel/employees/${employeeId}/subsets/education`, {
        ifMatch: 0,
        body: { school: '合成甲校', educationLevel: '本科' },
      }),
      201,
    );
    const request = await w.json<{ id: string }>(
      await w.request(userId, 'POST', '/api/tenant/personnel/change-requests', {
        ifMatch: 0,
        body: {
          employeeId,
          subset: 'education',
          recordId: record.id,
          targetRevision: record.revision,
          values: { school: '合成乙校' },
        },
      }),
      201,
    );
    return w.instanceOf(request.id, userId);
  };
}
