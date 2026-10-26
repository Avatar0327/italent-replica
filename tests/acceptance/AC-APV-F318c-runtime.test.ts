/** DEC-691：真实 HTTP 派单、主职排除兼职、最终合席与 F-316 空人出口。 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { relationWorld, source, job, resolved, orgVersion } from './AC-APV-F318c-support.js';
import { world, definition, publish, reach } from './AC-EXIT-F316-support.js';

const database = useTestDb();
describe('AC-APV-F318c 引擎接线', () => {
  it('单人解析多人明确 422；会签去重；仿真仅用虚拟关系', async () => {
    const w = await relationWorld(database().db, 'c-single');
    const org = source('department', w.root, ':descendants');
    const process = await w.publishedProcess({ nodes: [{ key: 'one', approver: org }] });
    const business = await w.application(w.subject.employeeId, { departmentId: w.staff });
    const response = await w.submitRaw(business);
    expect(response.status).toBe(422);
    expect((await response.json()).error.message).toContain('会签');
    const virtual = await w.json<{ nodes: { approverUserId: string }[] }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/simulate`, {
        body: {
          scope: 'published',
          data: {
            values: { processCode: 'TransferProcessNew' },
            sourceRelations: { [`department:${org.value}`]: [w.near.userId] },
          },
        },
      }),
    );
    expect(JSON.stringify(virtual)).toContain(w.near.userId);
    expect(JSON.stringify(virtual)).not.toContain(w.head.userId);
  });
  it('职位、普通职务、相对职务均不取有效兼职；真正主职派单可用', async () => {
    const w = await relationWorld(database().db, 'c-primary');
    const post = await job(w, 'posts');
    const position = await job(w, 'positions', { orgId: w.child, postId: post.id });
    const main = await w.person('合成主职任岗', w.child, { postId: post.id, positionId: position.id });
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${w.head.employeeId}/part-times`, {
        body: {
          partTimeType: 'part_time',
          startDate: '2026-09-01',
          fields: { departmentId: w.child, postId: post.id, positionId: position.id },
        },
      }),
      201,
    );
    for (const value of [source('position', position.id), source('job', post.id), source('job', post.id, ':relative')])
      expect(await resolved(w, value)).toEqual([main.userId]);
    await w.publishedProcess({ nodes: [{ key: 'main', approver: source('position', position.id) }] });
    const instance = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    expect(w.pending(instance).map((t) => t.assigneeUserId)).toEqual([main.userId]);
  });
  it('101 名职务主职任职者和重复指定人员，真实派单合并去重后只取 100', async () => {
    const w = await relationWorld(database().db, 'c-hundred');
    const post = await job(w, 'posts');
    const users: string[] = [];
    for (let i = 0; i < 101; i++) users.push((await w.person(`合成任岗${i}`, w.staff, { postId: post.id })).userId);
    await w.publishedProcess({
      nodes: [
        {
          key: 'all',
          kind: 'countersign',
          approvers: [source('job', post.id), source('specified', users[0]!)],
          transitionRule: { type: 'all' },
        },
      ],
    });
    const instance = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    const ids = w.pending(instance).map((t) => t.assigneeUserId);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect(ids.every((id) => users.includes(id!))).toBe(true);
    expect(w.pending(await w.detail(instance.id)).map((t) => t.assigneeUserId)).toEqual(ids);
  }, 120_000);
  it('空人指定策略可独立配置组织来源，复用同一解析出口', async () => {
    const x = await world(database().db, 'c-empty-relation');
    const org = await x.session.org('合成空人候选组织', { establishedOn: '2025-01-01' });
    await orgVersion({ db: x.db, tenant: { id: x.tenantId } }, org.id, { personInChargeId: x.hrbp.employeeId });
    const input = definition(x, {
      work_handover: {
        approvers: [source('department', x.tenantId)],
        emptyApproverPolicy: 'specified',
        fallbackUserIds: [],
      },
    });
    input.nodes = input.nodes.map((node) =>
      node.key === 'work_handover' ? { ...node, emptyApproverSources: [source('department', org.id)] } : node,
    );
    await publish(x, input);
    const run = await reach(x, 'work_handover', false);
    expect(await x.pendingTasks(run.instanceId)).toEqual([
      expect.objectContaining({ nodeKey: 'work_handover', userId: x.hrbp.userId }),
    ]);
  });
  for (const policy of ['stop', 'auto_approve', 'specified', 'exception_admin'] as const) {
    it(`新组织来源为空仍进入 F-316 ${policy}，指定人员单独保存`, async () => {
      const x = await world(database().db, `c-empty-${policy}`);
      const key = policy === 'exception_admin' ? 'other_handover' : 'work_handover';
      await publish(
        x,
        definition(x, {
          [key]: {
            approvers: [source('department', x.tenantId)],
            emptyApproverPolicy: policy,
            fallbackUserIds: policy === 'specified' ? [x.hrbp.userId] : [],
          },
        }),
      );
      const run = await reach(x, key, false);
      if (policy === 'stop') {
        expect(run.request.state).toBe('not_launched');
        return;
      }
      const tasks = await x.pendingTasks(run.instanceId);
      if (policy === 'auto_approve') expect(tasks[0]?.nodeKey).toBe('other_handover');
      else
        expect(tasks).toEqual([
          expect.objectContaining({
            nodeKey: key,
            userId: policy === 'specified' ? x.hrbp.userId : x.exceptionAdmin.id,
          }),
        ]);
    });
  }
});
