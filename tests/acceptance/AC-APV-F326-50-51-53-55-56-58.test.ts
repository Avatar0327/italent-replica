import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { systemRetiredVariables } from '../../apps/api/src/modules/approval/auto-variable-lifecycle.js';
import type * as Context from '../../apps/api/src/modules/approval/context.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import type { InstanceView, ProcessView } from './AC-APV-support.js';
import {
  act,
  baseline,
  deleteReturned,
  discard,
  DISCARDED,
  employmentWithdraw,
  enabled,
  instanceState,
  instanceTrigger,
  node,
  publishTrigger,
  replacement,
  retired,
  SAVED,
  systemRetirement,
  terminalNodes,
  withdraw,
} from './AC-APV-F326-50-lifecycle-support.js';
import {
  APPROVAL,
  instanceRow,
  personnelChange,
  references,
  rejected,
  variable,
  variableCommand,
} from './AC-APV-F326-S4-support.js';
import {
  autoAt,
  counter,
  create,
  dispatch,
  draftOk,
  newVersion,
  placeholder,
  publicVar,
  publishWith,
  s4World,
  specified,
  varRow,
  type S4World,
} from './AC-APV-F326-S7a-support.js';

const database = useTestDb();
const world = (label: string) => s4World(database().db, label);
const failAudit = vi.hoisted(() => ({ id: '' }));
vi.mock('../../apps/api/src/modules/approval/context.js', async (original) => {
  const actual = await original<typeof Context>();
  return {
    ...actual,
    auditApproval: async (...args: Parameters<typeof actual.auditApproval>) => {
      await actual.auditApproval(...args);
      if (args[2].objectId === failAudit.id && args[2].action === 'approval.public_variable.auto_disable')
        throw new Error('合成故障：提交前停用审计写入后回滚');
    },
  };
});

const resubmit = (w: S4World, i: InstanceView) => w.instanceAction(w.subject.userId, i.id, 'resubmit', i.revision);
const personnelRequest = async (w: S4World, id: string) =>
  w.json(await w.request(w.subject.userId, 'GET', `/api/tenant/personnel/change-requests/${id}`));

async function assertCommand(w: S4World, id: string, commandId: string) {
  const stored = await withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ command_id: string }>(
      await tx.execute(sql`SELECT command_id FROM audit_events
      WHERE tenant_id=${w.tenant.id} AND object_id=${id} AND action='approval.public_variable.auto_disable'`),
    ),
  );
  expect(stored).toEqual([{ command_id: commandId }]);
}

describe('AC-APV-F326-50 最后一单结束后停用', () => {
  it.each(['approved', 'disapproved', 'cancelled'] as const)(
    '%s 提交内停用、修订加一且系统审计关联结束命令',
    async (status) => {
      const w = await world(`last-${status}`);
      const { a, x } = await baseline(w);
      let { instance } = await dispatch(w);
      await w.publish(await replacement(w, a));
      await enabled(w, x);
      if (status === 'approved') instance = await w.json<InstanceView>(await act(w, instance, 'approve'));
      if (status === 'cancelled') instance = await w.json<InstanceView>(await act(w, instance, 'reject'));
      const command = randomUUID();
      const response =
        status === 'cancelled'
          ? await deleteReturned(w, instance, command)
          : await act(w, instance, status === 'approved' ? 'approve' : 'disagree', command);
      expect([200, 204], await response.clone().text()).toContain(response.status);
      expect((await instanceRow(w, instance.id)).status).toBe(status);
      await systemRetirement(w, x, a, instanceTrigger(instance.id, status));
      await assertCommand(w, x.id, command);
      expect((await variableCommand(w, await varRow(w, x.id), 'enable')).status).toBe(200);
    },
  );

  it('提交前停用审计写入后抛错，业务、实例、变量及审计一起回滚', async () => {
    const w = await world('last-rollback');
    const { a, x } = await baseline(w);
    const { instance } = await dispatch(w);
    await w.publish(await replacement(w, a));
    const ready = await w.json<InstanceView>(await act(w, instance, 'approve'));
    const before = await w.business(ready.businessId);
    failAudit.id = x.id;
    try {
      expect((await act(w, ready, 'approve')).status, '提交前发生存储错误时整个结束命令应失败').toBe(503);
    } finally {
      failAudit.id = '';
    }
    expect(await w.business(ready.businessId)).toEqual(before);
    expect(await w.detail(ready.id)).toEqual(ready);
    await enabled(w, x);
  });
});

describe('AC-APV-F326-51 发布替换无在途版本', () => {
  it('发布 v2 立刻停用 v1 的变量且审计标明新版本', async () => {
    const w = await world('empty-publish');
    const { a, x } = await baseline(w);
    const v2 = await replacement(w, a);
    await w.publish(v2);
    await systemRetirement(w, x, a, publishTrigger(v2));
  });

  it('① 发布检查拒绝未选人草稿，当前版本和变量保持原状', async () => {
    const w = await world('empty-check');
    const { a, x } = await baseline(w);
    const v2 = await replacement(w, a, [node('new', placeholder)]);
    await rejected(await publishWith(w, v2), 400, 'APPROVAL_SPECIFIED_APPROVER_REQUIRED');
    await enabled(w, x);
  });

  it('② 交接重发复用旧变量，无在途也保持启用', async () => {
    const w = await world('empty-handover');
    const { a, x } = await baseline(w);
    const successor = await w.member('合成接任人');
    await w.json(
      await w.request(w.hr.id, 'POST', `${APPROVAL}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      }),
    );
    const updated = await w.json<ProcessView>(await w.request(w.hr.id, 'GET', `${APPROVAL}/processes/${a.id}`));
    expect(updated.currentVersion!.versionNo).toBe(2);
    await enabled(w, x);
  });

  it('③ 发起后自动通过，当前发布版本引用的变量继续启用', async () => {
    const w = await world('empty-auto-launch');
    const { x } = await baseline(w, 'transfer', terminalNodes(w));
    const business = await w.application(w.head.employeeId, { departmentId: w.child });
    await w.json(await w.submitRaw(business));
    expect((await w.instanceOf(business.id)).status).toBe('approved');
    await enabled(w, x);
  });
});

describe('AC-APV-F326-53 跨版本与跨流程引用', () => {
  it.each(['current', 'other-current', 'other-draft'] as const)('%s 保留引用，草稿移除后走保存收尾', async (use) => {
    const w = await world(`retain-${use}`);
    const { a, x } = await baseline(w);
    const b =
      use === 'current'
        ? null
        : await create(w, [node('b', publicVar(x.id))], {
            approvalType: 'personnel_change',
          });
    if (use === 'other-current') await w.publish(b!);
    await w.publish(use === 'current' ? await newVersion(w, a) : await replacement(w, a));
    await enabled(w, x);
    if (use === 'other-draft') {
      await draftOk(w, b!, [node('b')]);
      expect((await varRow(w, x.id)).status).toBe('disabled');
      expect(await retired(w, x)).toMatchObject([{ actor: w.hr.id, after: { reason: SAVED } }]);
    }
  });

  it('④ 更早版本的 returned 实例仍占用变量，作废后审计追溯到实际清零的版本', async () => {
    const w = await world('retain-returned');
    const { a, x } = await baseline(w);
    const { instance } = await dispatch(w);
    const returned = await w.json<InstanceView>(await act(w, instance, 'reject'));
    const v2 = await w.publish(await newVersion(w, a));
    await w.publish(await replacement(w, v2));
    await enabled(w, x);
    await w.json(await deleteReturned(w, returned));
    await systemRetirement(w, x, a, instanceTrigger(instance.id, 'cancelled'));
  });

  it('⑤ 节点引用的人工公共变量保留原状态、修订和修改信息', async () => {
    const w = await world('manual');
    const m = await variable(w);
    const { a, x } = await baseline(w, 'transfer', [
      node('n1', publicVar(m.id)),
      counter([specified(w.near.userId)], { key: 'n2' }),
    ]);
    const prior = await varRow(w, m.id);
    const v2 = await replacement(w, a);
    await w.publish(v2);
    expect(await varRow(w, m.id)).toEqual(prior);
    await systemRetirement(w, x, a, publishTrigger(v2));
  });

  it.each(['withdrawn', 'discarded'] as const)('⑥⑦ 另一流程只有 %s 引用，不阻止 A 的生命周期停用', async (state) => {
    const w = await world(`ignore-${state}`);
    const { a, x } = await baseline(w);
    const b = await w.publish(await create(w, [node('b', publicVar(x.id))], { approvalType: 'personnel_change' }));
    if (state === 'withdrawn') {
      const { instance } = await (await personnelChange(w)).submit();
      await w.publish(await replacement(w, b));
      await w.json(await withdraw(w, instance));
      expect((await references(w, 'variables', x.id)).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ processId: b.id, versionKind: 'in_flight', instanceCount: 1 }),
        ]),
      );
    } else {
      await w.json(await discard(w, b));
    }
    await enabled(w, x);
    const v2 = await replacement(w, a);
    await w.publish(v2);
    await systemRetirement(w, x, a, publishTrigger(v2));
  });
});

describe('AC-APV-F326-55 撤回与两个真实 HTTP 重提入口', () => {
  it.each(['personnel_change', 'transfer'] as const)('①② %s 系统停用后原实例重提被拒并回滚', async (type) => {
    const w = await world(`resume-${type}`);
    const personnel = type === 'personnel_change';
    const { a, x } = await baseline(w, type);
    const { instance } = personnel ? await (await personnelChange(w)).submit() : await dispatch(w);
    await w.publish(await replacement(w, a));
    await enabled(w, x);
    await w.json(await (personnel ? withdraw(w, instance) : employmentWithdraw(w, instance)));
    await systemRetirement(w, x, a, instanceTrigger(instance.id, 'withdrawn'));
    const load = () => (personnel ? personnelRequest(w, instance.businessId) : w.business(instance.businessId));
    const beforeBusiness = await load();
    const beforeInstance = await instanceState(w, instance.id);
    const actor = personnel ? w.subject.userId : w.hr.id;
    const beforeDetail = await w.detail(instance.id, actor);
    expect(beforeInstance.status).toBe('withdrawn');
    const response = personnel
      ? await resubmit(w, beforeDetail)
      : await w.submitRaw(await w.business(instance.businessId));
    expect(await rejected(response, 409, 'APPROVAL_PROCESS_UPDATED_RESTART')).toMatchObject({
      code: 'CONFLICT',
      message: '流程已更新，请重新发起',
    });
    expect(await instanceState(w, instance.id)).toEqual(beforeInstance);
    expect(await load()).toEqual(beforeBusiness);
    expect((await w.detail(instance.id, actor)).logs).toEqual(beforeDetail.logs);
  });

  it('③ 管理员手工停用后依 DEC-103 放行，节点按空人策略通过', async () => {
    const w = await world('manual-disable-resume');
    const { a, x } = await baseline(w, 'personnel_change');
    const { instance } = await (await personnelChange(w)).submit();
    await w.publish(await replacement(w, a));
    const { total } = await references(w, 'variables', x.id);
    await w.json(await variableCommand(w, x, 'disable', { acknowledgedReferenceCount: total }));
    const withdrawn = await w.json<InstanceView>(await withdraw(w, instance));
    const restarted = await w.json<InstanceView>(await resubmit(w, withdrawn));
    expect((await instanceState(w, restarted.id)).version_id).toBe(a.latestVersion.id);
    const routed = await w.json<InstanceView>(await act(w, restarted, 'approve'));
    expect(w.pending(routed)).toMatchObject([{ assigneeUserId: w.exceptionAdmin, nodeKey: 'n2' }]);
    expect((await w.json<InstanceView>(await act(w, routed, 'approve'))).status).toBe('approved');
    expect(await retired(w, x)).toEqual([]);
  });
});

describe('AC-APV-F326-56 流程作废', () => {
  it.each(['current', 'draft'] as const)('① 无在途的 %s 同事务停用，支持未选人占位', async (type) => {
    const w = await world(`discard-${type}`);
    const a = type === 'current' ? (await baseline(w)).a : await create(w, [node('n2', placeholder)]);
    const x = await autoAt(w, a.id, 'n2');
    await w.json(await discard(w, a));
    await systemRetirement(w, x, a, { kind: 'discard' }, DISCARDED);
  });

  it('① 作废同时检查会签审批人和空审批人候选两列', async () => {
    const w = await world('discard-countersign');
    const a = await create(
      w,
      [
        counter([specified(w.near.userId)], { key: 'other_handover', emptyApproverPolicy: 'exception_admin' }),
        counter([node('n').approver!], {
          key: 'work_handover',
          emptyApproverPolicy: 'specified',
          emptyApproverSources: [specified(w.head.userId)],
        }),
      ],
      { approvalType: 'exit_handover' },
    );
    const variables = [await autoAt(w, a.id, 'other_handover'), await autoAt(w, a.id, 'work_handover')];
    await w.json(await discard(w, a));
    for (const x of variables) await systemRetirement(w, x, a, { kind: 'discard' }, DISCARDED);
  });

  it('② 作废时仍有在途，最后一单通过才停用，原因归作废流程', async () => {
    const w = await world('discard-pending');
    const { a, x } = await baseline(w);
    const { instance } = await dispatch(w);
    await w.json(await discard(w, a));
    await enabled(w, x);
    const next = await w.json<InstanceView>(await act(w, instance, 'approve'));
    const ended = await w.json<InstanceView>(await act(w, next, 'approve'));
    expect(ended.status).toBe('approved');
    await systemRetirement(w, x, a, instanceTrigger(ended.id, 'approved'), DISCARDED);
  });

  it('③ 跨流程当前版本引用保留，④ 作废草稿不会应用待生效人员', async () => {
    const w = await world('discard-pending-value');
    const { a, x } = await baseline(w);
    await w.publish(await create(w, [node('b', publicVar(x.id))], { approvalType: 'personnel_change' }));
    const v2 = await replacement(w, a, [node('n1'), node('n2', specified(w.head.userId))]);
    await w.json(await discard(w, v2));
    await enabled(w, x);
    expect(await varRow(w, x.id)).toEqual(x);
  });
});

describe('AC-APV-F326-58 保存收尾与系统停用区分', () => {
  it.each([false, true])('①③ 重新启用后按 §6.1 保存收尾，撤回引用=%s', async (hasWithdrawn) => {
    const w = await world(`save-close-${hasWithdrawn}`);
    const { a, x } = await baseline(w, 'personnel_change');
    const i = hasWithdrawn ? (await (await personnelChange(w)).submit()).instance : null;
    const draft = await replacement(w, a);
    const v2 = await w.publish(draft);
    const withdrawn = i ? await w.json<InstanceView>(await withdraw(w, i)) : null;
    await systemRetirement(w, x, a, i ? instanceTrigger(i.id, 'withdrawn') : publishTrigger(draft));
    await w.json(await variableCommand(w, await varRow(w, x.id), 'enable'));
    await replacement(w, v2);
    const trail = await retired(w, x);
    if (withdrawn) {
      expect((await varRow(w, x.id)).status).toBe('enabled');
      expect(trail).toHaveLength(1);
      const restarted = await w.json<InstanceView>(await resubmit(w, withdrawn));
      const next = await w.json<InstanceView>(await act(w, restarted, 'approve'));
      expect((await instanceState(w, next.id)).version_id).toBe(a.latestVersion.id);
      expect(w.pending(next).map((task) => task.assigneeUserId)).toEqual([w.near.userId]);
    } else {
      expect(await varRow(w, x.id)).toMatchObject({ status: 'disabled', updated_by: w.hr.id });
      expect(trail).toHaveLength(2);
      expect(trail[1]).toMatchObject({ actor: w.hr.id, after: { reason: SAVED } });
      const system = await withTenant(w.db, w.tenant.id, (tx) =>
        systemRetiredVariables(
          tx,
          {
            tenantId: w.tenant.id,
            userId: w.hr.id,
            now: w.clock(),
            timezone: 'Asia/Shanghai',
            commandId: randomUUID(),
            expectedRevision: 0,
          },
          a.latestVersion.id,
          [x.id],
        ),
      );
      expect(system).toEqual([]);
    }
  });
});
