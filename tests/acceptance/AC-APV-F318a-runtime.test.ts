/** DEC-686：真实派单与业务日取人；只使用合成员工。 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { effectiveHistory, type ApproverSource } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  limitApprovers,
  previousApproved,
  resolveSource,
} from '../../apps/api/src/modules/approval/source-resolver.js';
import type { TaskRow } from '../../apps/api/src/modules/approval/store.js';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';

const db = useTestDb();
const specified = (value: string): ApproverSource => ({ type: 'specified', value });
const previous: ApproverSource = { type: 'context_variable', value: 'previous_approved' };

describe('AC-APV-F318a 运行', () => {
  it('真实会签 101 名在职候选只派 100 份待办', async () => {
    const w = await approvalWorld(db().db, 'f318a-limit');
    const s = await transferScene(w);
    const people: string[] = [];
    for (let i = 0; i < 101; i++) people.push((await w.person(`合成审批人${i}`, s.from)).userId);
    await w.publishedProcess({
      nodes: [{ key: 'many', kind: 'countersign', approvers: people.map(specified), transitionRule: { type: 'all' } }],
    });
    const instance = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const pending = w.pending(instance);
    expect(pending).toHaveLength(100);
    expect(new Set(pending.map((task) => task.assigneeUserId)).size).toBe(100);
    expect(pending.every((task) => people.includes(task.assigneeUserId))).toBe(true);
  }, 120_000);
  it('会签两名实际同意者传给下一节点，多来源合并去重', async () => {
    const w = await approvalWorld(db().db, 'f318a-previous');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        {
          key: 'first',
          kind: 'countersign',
          approvers: [specified(s.outHead.userId), specified(s.inHead.userId)],
          actions: { transfer: true },
          transitionRule: { type: 'all' },
        },
        {
          key: 'second',
          kind: 'countersign',
          approvers: [previous, specified(s.inHead.userId)],
          transitionRule: { type: 'all' },
        },
      ],
    });
    const business = await w.application(s.subject.employeeId, { departmentId: s.to });
    let instance = await w.submit(business);
    for (const actor of [s.outHead.userId, s.inHead.userId]) {
      const task = w.pending(instance).find((t) => t.assigneeUserId === actor)!;
      instance = await w.json<InstanceView>(await w.taskAction(actor, task.id, 'approve', instance.revision));
    }
    expect(
      w
        .pending(instance)
        .map((t) => [t.nodeKey, t.assigneeUserId])
        .sort(),
    ).toEqual([s.outHead.userId, s.inHead.userId].map((id) => ['second', id]).sort());
    const rejecting = w.pending(instance)[0]!;
    instance = await w.json<InstanceView>(
      await w.taskAction(rejecting.assigneeUserId!, rejecting.id, 'reject', instance.revision),
    );
    expect(instance.status).toBe('returned');
    instance = await w.submit(await w.business(business.id));
    expect(w.pending(instance).every((task) => task.round === 2)).toBe(true);
    expect(w.pending(instance).every((task) => task.nodeKey === 'first')).toBe(true);
    const handingOver = w.pending(instance).find((task) => task.assigneeUserId === s.outHead.userId)!;
    instance = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, handingOver.id, 'transfer', instance.revision, {
        toUserId: s.inHrbp.userId,
      }),
    );
    for (const actor of [s.inHrbp.userId, s.inHead.userId]) {
      const task = w.pending(instance).find((t) => t.assigneeUserId === actor)!;
      instance = await w.json<InstanceView>(await w.taskAction(actor, task.id, 'approve', instance.revision));
    }
    expect(
      w
        .pending(instance)
        .map((t) => t.assigneeUserId)
        .sort(),
    ).toEqual([s.inHrbp.userId, s.inHead.userId].sort());
  });

  it('转交后上一节点只带实际接手同意者，不带被转交人', async () => {
    const w = await approvalWorld(db().db, 'f318a-transferred');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        { key: 'first', approver: specified(s.outHead.userId), actions: { transfer: true } },
        { key: 'second', kind: 'countersign', approvers: [previous], transitionRule: { type: 'all' } },
      ],
    });
    let instance = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    instance = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, w.pending(instance)[0]!.id, 'transfer', instance.revision, {
        toUserId: s.inHead.userId,
      }),
    );
    instance = await w.json<InstanceView>(
      await w.taskAction(s.inHead.userId, w.pending(instance)[0]!.id, 'approve', instance.revision),
    );
    expect(w.pending(instance).map((t) => [t.nodeKey, t.assigneeUserId])).toEqual([['second', s.inHead.userId]]);
  });

  it('业务日主职经理与今天最新主职经理不同，按指定业务日解析且租户隔离', async () => {
    const w = await approvalWorld(db().db, 'f318a-date');
    const s = await transferScene(w);
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
    );
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: {
          kind: 'org_adjustment',
          mode: 'direct',
          effectiveDate: '2026-09-01',
          fields: { directManagerId: s.inHead.employeeId },
        },
      }),
      201,
    );
    const context = {
      tenantId: w.tenant.id,
      asOf: '2026-10-01',
      businessDate: '2026-08-01',
      initiatorUserId: w.hr.id,
      subjectEmployeeId: s.subject.employeeId,
      latestDepartmentId: s.from,
      recordDepartmentId: s.to,
    };
    await withTenant(w.db, w.tenant.id, async (tx) => {
      expect(
        (await resolveSource(tx, context, { type: 'object_field', value: 'business_record_direct_manager' }))[0]!
          .userId,
      ).toBe(s.manager.userId);
      expect((await resolveSource(tx, context, { type: 'object_field', value: 'direct_manager' }))[0]!.userId).toBe(
        s.inHead.userId,
      );
      expect((await resolveSource(tx, context, { type: 'custom_variable', value: 'owner' }))[0]!.userId).toBe(w.hr.id);
      expect((await resolveSource(tx, context, specified(randomUUID())))[0]!.userId).toBeNull();
    });
    await w.publishedProcess({
      nodes: [{ key: 'business_manager', approver: { type: 'object_field', value: 'business_record_direct_manager' } }],
    });
    const request = await w.application(s.subject.employeeId, { departmentId: s.to }, { effectiveDate: '2026-08-01' });
    const instance = await w.submit(request);
    expect(w.pending(instance).map((task) => task.assigneeUserId)).toEqual([s.manager.userId]);
    const foreign = await approvalWorld(db().db, 'f318a-foreign');
    await withTenant(w.db, foreign.tenant.id, async (tx) => {
      const outside = { ...context, tenantId: foreign.tenant.id };
      expect((await resolveSource(tx, outside, specified(s.manager.userId)))[0]!.userId).toBeNull();
      expect(
        (await resolveSource(tx, outside, { type: 'object_field', value: 'business_record_direct_manager' }))[0]!
          .userId,
      ).toBeNull();
    });
  });

  it('上一节点只取本轮最后激活的实际同意者；转交、跳过及重提旧历史排除', () => {
    const row = (seq: number, patch: Partial<TaskRow> = {}): TaskRow => ({
      id: randomUUID(),
      seq,
      round: 2,
      nodeKey: 'first',
      activationId: 'new',
      origin: 'resolved',
      status: 'approved',
      assigneeUserId: `user-${seq}`,
      candidateUserId: null,
      mergedCandidateUserIds: [],
      isExceptionAdmin: false,
      adminSelfTransfer: false,
      parentTaskId: null,
      comment: null,
      actedAt: null,
      ...patch,
    });
    const tasks = [
      row(1, { round: 1 }),
      row(2, { activationId: 'old' }),
      row(3, { status: 'transferred' }),
      row(4, { origin: 'same_skip' }),
      row(5),
      row(6, { origin: 'transfer' }),
    ];
    expect(previousApproved(effectiveHistory(tasks, { round: 2, historyFromSeq: 2 }), 'first')).toEqual([
      'user-5',
      'user-6',
    ]);
    expect(previousApproved(effectiveHistory(tasks, { round: 3, historyFromSeq: 7 }), 'first')).toEqual([]);
  });

  it('超过 100 个账号先去重再抽样：种子可复现，结果不等于机械取前 100', () => {
    const items = Array.from({ length: 130 }, () => {
      const id = randomUUID();
      return [specified(id), { userId: id, personId: null }] as const;
    });
    const sampled = limitApprovers([...items, ...items], ([, c]) => c.userId, 'instance:round:node');
    expect(sampled).toHaveLength(100);
    expect(new Set(sampled.map(([, c]) => c.userId)).size).toBe(100);
    expect(sampled).toEqual(limitApprovers([...items, ...items], ([, c]) => c.userId, 'instance:round:node'));
    expect(sampled).not.toEqual(items.slice(0, 100));
    expect(sampled).not.toEqual(limitApprovers(items, ([, c]) => c.userId, 'different-instance'));
  });
});
