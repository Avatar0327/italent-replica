/** F-028 / DEC-230：直接上级取流程主体最新生效主职任职，复用 DEC-054/058/068/098。 */
import { getUser, setUserStatus, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { approvalWorld, transferScene, type ApprovalWorld, type ProcessView } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';
const DIRECT = { key: 'manager', name: '直接上级', approver: 'direct_manager' } as const;

async function directBusiness(w: ApprovalWorld, employeeId: string, body: object) {
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
  );
  return w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { mode: 'direct', ...body },
    }),
    201,
  );
}

async function effects(w: ApprovalWorld) {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT
      (SELECT count(*) FROM approval_instances)::int AS instances,
      (SELECT count(*) FROM approval_tasks)::int AS tasks,
      (SELECT count(*) FROM approval_outbox)::int AS outbox,
      (SELECT count(*) FROM approval_notifications)::int AS notifications`),
    ),
  );
}

describe('AC-APV-38 最新生效主职直线经理，与部门负责人并存', () => {
  it('保存发布后真实提交取主体当前经理，不取发起人、部门负责人、本次申请或未来任职的经理', async () => {
    const w = await approvalWorld(database().db, 'dm-current');
    const s = await transferScene(w);
    const fresh = await w.person('当前经理', s.from);
    await directBusiness(w, s.subject.employeeId, {
      kind: 'org_adjustment',
      effectiveDate: '2026-09-01',
      fields: { directManagerId: fresh.employeeId },
    });
    await directBusiness(w, s.subject.employeeId, {
      kind: 'org_adjustment',
      effectiveDate: '2026-12-01',
      fields: { directManagerId: s.inHead.employeeId },
    });
    const process = await w.publishedProcess({
      nodes: [DIRECT, { key: 'head', approver: 'latest_record_department_head' }],
    });
    expect(process.currentVersion?.nodes[0]).toMatchObject(DIRECT);
    const draft = await w.application(s.subject.employeeId.toUpperCase(), {
      departmentId: s.to.toUpperCase(),
      directManagerId: s.inHead.employeeId.toUpperCase(),
    });
    let view = await w.submit(draft);
    expect(view.processId).toBe(process.id);
    expect(w.pending(view)).toEqual([expect.objectContaining({ assigneeUserId: fresh.userId, origin: 'resolved' })]);
    view = await w.json(
      await w.taskAction(fresh.userId.toUpperCase(), w.pending(view)[0]!.id, 'approve', view.revision),
    );
    expect(w.pending(view)[0]).toMatchObject({ assigneeUserId: s.outHead.userId, nodeKey: 'head' });
  });
});

describe('AC-APV-39 不可用经理按空处理', () => {
  it.each(['missing', 'departed', 'disabled'] as const)(
    '%s：首节点报错且无实例；中间节点转异常管理员',
    async (reason) => {
      const w = await approvalWorld(database().db, `dm-${reason}`);
      const s = await transferScene(w);
      const subject = reason === 'missing' ? await w.person('无经理员工', s.from) : s.subject;
      if (reason === 'departed') {
        await directBusiness(w, s.manager.employeeId, { kind: 'leave', lastWorkDate: '2026-09-01', fields: {} });
      }
      if (reason === 'disabled') {
        const user = await getUser(w.db, s.manager.userId);
        await setUserStatus(w.db, s.manager.userId, 'disabled', user!.revision, cmd());
      }
      await w.publishedProcess({ nodes: [DIRECT], priority: 0 });
      const draft = await w.application(subject.employeeId, { departmentId: s.to });
      const before = await effects(w);
      const failed = await w.submitRaw(draft);
      expect(failed.status).toBe(409);
      expect(await failed.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_FIRST_NODE_EMPTY' } } });
      expect(await effects(w)).toEqual(before);
      expect(await w.business(draft.id)).toMatchObject({ status: 'draft', revision: draft.revision });
      await w.publishedProcess({
        priority: -1,
        nodes: [{ key: 'head', approver: 'latest_record_department_head' }, DIRECT],
      });
      let view = await w.submit(draft);
      view = await w.json(await w.taskAction(s.outHead.userId, w.pending(view)[0]!.id, 'approve', view.revision));
      expect(w.pending(view)[0]).toMatchObject({
        nodeKey: 'manager',
        assigneeUserId: w.exceptionAdmin,
        origin: 'exception_admin',
        isExceptionAdmin: true,
      });
    },
  );
});

describe('AC-APV-40 直接上级自审回避', () => {
  it.each([true, false])('经理即发起人：有上级=%s，跳过不计同意并转上级或异常管理员', async (hasBoss) => {
    const w = await approvalWorld(database().db, `dm-self-${hasBoss}`);
    const org = await w.org('合成部门');
    const boss = await w.person('上级经理', org);
    const manager = await w.person('发起经理', org, { directManagerId: hasBoss ? boss.employeeId : null });
    const subject = await w.person('异动员工', org, { directManagerId: manager.employeeId });
    await w.publishedProcess({ nodes: [{ ...DIRECT, sameAssigneeSkip: true }] });
    const view = await w.submit(
      await w.application(subject.employeeId, {}, { actor: manager.userId.toUpperCase() }),
      manager.userId.toUpperCase(),
    );
    expect(w.pending(view)[0]).toMatchObject({
      assigneeUserId: hasBoss ? boss.userId : w.exceptionAdmin,
      origin: hasBoss ? 'self_skip_manager' : 'exception_admin',
    });
    expect(view.tasks).toContainEqual(
      expect.objectContaining({
        assigneeUserId: manager.userId,
        status: 'skipped',
        origin: 'self_skip',
      }),
    );
    expect(view.logs).toContainEqual(
      expect.objectContaining({
        event: 'self_skip',
        detail: expect.objectContaining({ countedAsApprove: false }),
      }),
    );
  });
});

describe('AC-APV-41 流程匹配、虚拟仿真、UUID 规范化与租户隔离', () => {
  it('两种仿真支持新表达式、空值、自审与会签，不读取真实关系或产生副作用', async () => {
    const w = await approvalWorld(database().db, 'dm-sim');
    const manager = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const boss = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const process = await w.publishedProcess({ nodes: [DIRECT] });
    const otherType = await w.publishedProcess({
      approvalType: 'leave',
      priority: -5,
      isFallback: true,
      conditions: { items: [] },
      nodes: [DIRECT],
    });
    const before = await effects(w);
    const data = {
      values: { processCode: 'TransferProcessNew' },
      relations: { direct_manager: manager.toUpperCase() },
    };
    const simulate = async (extra: object) =>
      w.json<{ startable: boolean; nodes: Record<string, unknown>[] }>(
        await w.request(w.hr.id, 'POST', `${BASE}/processes/${process.id.toUpperCase()}/simulate`, {
          body: { data: { ...data, ...extra } },
        }),
      );
    expect(await simulate({})).toMatchObject({
      startable: true,
      nodes: [{ approverUserId: manager, resolution: 'resolved' }],
    });
    expect(await simulate({ relations: {} })).toMatchObject({
      startable: false,
      nodes: [{ resolution: 'first_node_empty' }],
    });
    for (const selfField of ['initiatorUserId', 'subjectUserId']) {
      expect(
        await simulate({ [selfField]: manager, managers: { [manager.toUpperCase()]: boss.toUpperCase() } }),
      ).toMatchObject({ nodes: [{ approverUserId: boss, resolution: 'self_skip_manager' }] });
    }
    const match = await w.json(
      await w.request(w.hr.id, 'POST', `${BASE}/simulate`, {
        body: { approvalType: 'transfer', data },
      }),
    );
    expect(match).toMatchObject({
      replica: { processId: process.id },
      originalSite: { processId: otherType.id },
      replicaStartable: true,
    });
    const joint = await w.publishedProcess({
      priority: 5,
      nodes: [
        {
          key: 'joint',
          kind: 'countersign',
          approvers: ['direct_manager', 'record_department_head'],
        },
      ],
    });
    const jointResult = await w.json(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${joint.id}/simulate`, {
        body: { data: { ...data, relations: { ...data.relations, record_department_head: boss } } },
      }),
    );
    expect(jointResult).toMatchObject({
      startable: true,
      nodes: [
        {
          approvers: [
            { expression: 'direct_manager', approverUserId: manager },
            { expression: 'record_department_head', approverUserId: boss },
          ],
        },
      ],
    });
    expect(await effects(w)).toEqual(before);
  });

  it('另租户不能读取/仿真流程或提交主体员工；各租户独立解析经理', async () => {
    const a = await approvalWorld(database().db, 'dm-tenant-a');
    const b = await approvalWorld(database().db, 'dm-tenant-b');
    const sa = await transferScene(a);
    const sb = await transferScene(b);
    const pa = await a.publishedProcess({ code: 'SharedCode', nodes: [DIRECT] });
    const pb = await b.publishedProcess({ code: 'SharedCode', nodes: [DIRECT] });
    for (const [method, path, body] of [
      ['GET', `${BASE}/processes/${pa.id}`, undefined],
      ['POST', `${BASE}/processes/${pa.id}/simulate`, { data: { values: {} } }],
      ['GET', `/api/tenant/employment/employees/${sa.subject.employeeId}`, undefined],
    ] as const) {
      expect((await b.request(b.hr.id, method, path, { body })).status).toBe(404);
    }
    const da = await a.application(sa.subject.employeeId, { departmentId: sa.to });
    expect((await b.submitRaw(da)).status).toBe(404);
    const va = await a.submit(da);
    const vb = await b.submit(await b.application(sb.subject.employeeId, { departmentId: sb.to }));
    expect(va.processId).toBe(pa.id);
    expect(vb.processId).toBe(pb.id);
    expect(a.pending(va)[0]!.assigneeUserId).toBe(sa.manager.userId);
    expect(b.pending(vb)[0]!.assigneeUserId).toBe(sb.manager.userId);
    expect((await b.request(sa.manager.userId, 'GET', `${BASE}/todos`)).status).toBe(403);
  });
});

describe('AC-APV-42 出厂离职预置与已发布自定义流程', () => {
  it('新装离职使用直接上级；重复安装不改自定义已发布流程', async () => {
    const w = await approvalWorld(database().db, 'dm-preset');
    const custom = await w.publishedProcess({
      approvalType: 'leave',
      isFallback: true,
      conditions: { items: [] },
      nodes: [{ key: 'direct_head', name: '租户自定义', approver: 'latest_record_department_head' }],
    });
    const install = async () =>
      w.json<{ items: ProcessView[] }>(await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 0 }));
    const installed = await install();
    const leave = installed.items.find((p) => p.presetKey === 'standard_leave')!;
    expect(leave.latestVersion.nodes[0]).toMatchObject({ name: '直接上级', approver: 'direct_manager' });
    const configured = await w.json<ProcessView>(
      await w.request(w.hr.id, 'PUT', `${BASE}/processes/${leave.id}/draft`, {
        ifMatch: leave.revision,
        body: {
          name: leave.latestVersion.name,
          exceptionAdminUserId: w.exceptionAdmin,
          conditions: leave.latestVersion.conditions,
          nodes: leave.latestVersion.nodes,
        },
      }),
    );
    await w.publish(configured);
    await install();
    expect(await w.json(await w.request(w.hr.id, 'GET', `${BASE}/processes/${custom.id}`))).toEqual(custom);
    const s = await transferScene(w);
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
        ifMatch: 2,
        body: { kind: 'leave', mode: 'application', lastWorkDate: '2026-10-01', fields: {} },
      }),
      201,
    );
    const view = await w.submit(draft);
    expect(view.processId).toBe(leave.id);
    expect(w.pending(view)[0]).toMatchObject({ nodeName: '直接上级', assigneeUserId: s.manager.userId });
  });
});
