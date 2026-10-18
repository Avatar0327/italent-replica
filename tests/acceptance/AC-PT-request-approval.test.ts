/**
 * AC-PT-08（新增节点）/ AC-PT-09（作废）/ AC-PT-13（申请侧）兼职新增申请的审批适配（docs/08_设计/R2-T05_兼职设计.md §4.4 / §4.5 / §4.6，
 * §9 PB-32 / 38 / 42 / 43 / 44 / 63 / 82 / 83；PT-4a）：申请经内部服务建立并提交，审批走真实审批中心接口。
 * 同意落地、复核失败作废（审批结论保留）、驳回 / 不同意 / 撤回回写、审批编辑拒绝形态、离职作废全部在途申请、停用计数、P-47 范围谓词。
 * 日期框架：今天 2026-10-01，主职 2020-01-01 入职。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, mayMergeSeat } from '../../apps/api/src/modules/approval/adapters.js';
import { instanceScopeSql } from '../../apps/api/src/modules/approval/access.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { permissionAdmin, grantVisibleFields } from './AC-APV-support.js';
import { insertPartTimeRecord, insertPartTimeRequest } from './AC-PT-support.js';
import { requestWorld } from './AC-PT-request-support.js';

const database = useTestDb();

describe('PB-32 / PB-38：新增申请 → 四节点 → 通过', () => {
  it('节点顺序 主职HRBP → 主职负责人 → 兼职HRBP → 兼职负责人；通过前不生成记录，通过后落地（开始日在未来）', async () => {
    const w = await requestWorld(database().db, 'happy');
    const created = await w.create({ startDate: '2026-11-01', endDate: '2026-12-31' });
    const submitted = await w.send(created.id, 1);
    expect(submitted.state).toBe('in_review');
    let view = await w.instance(created.id);
    expect(view).toMatchObject({
      approvalType: 'part_time_add',
      title: '兼职申请',
      processCode: 'AddParttimeJobProcess',
    });
    const { pHrbp, pHead, sHrbp, sHead } = w.approvers;
    for (const [index, actor] of [pHrbp, pHead, sHrbp, sHead].entries()) {
      expect(
        w.pending(view).map((task) => task.assigneeUserId),
        `第 ${index + 1} 个节点`,
      ).toEqual([actor.userId]);
      // 通过前不生成兼职记录
      expect(await w.partTimeRecords()).toEqual([]);
      await w.decide(created.id, actor, 'approve');
      view = await w.instance(created.id);
    }
    expect(view.status).toBe('approved');
    const landed = await w.load(created.id);
    expect(landed.state).toBe('effective');
    const states = await w.states(created.id);
    expect(states.map((row) => row.state)).toEqual(['draft', 'in_review', 'approved', 'effective']);
    const [record] = await w.partTimeRecords();
    expect(record).toMatchObject({ start_date: '2026-11-01', service_type: 'part_time', department_id: w.side });
    expect(states.at(-1)!.record_id).toBe(record!.id);
    expect(await w.terms(record!.id)).toEqual([
      { term_no: 1, end_date: '2026-12-31', source: 'create', source_id: created.id },
    ]);
    expect(await w.auditActions(created.id)).toEqual(
      expect.arrayContaining([
        'part_time.request.create',
        'part_time.request.submit',
        'part_time.request.approved',
        'part_time.request.effective',
      ]),
    );
    expect(await w.auditActions(record!.id)).toContain('employment.part_time.create');
  });

  it('PB-43 自审回避：兼职人员本人就是兼职部门负责人时，该节点不落到本人', async () => {
    const w = await requestWorld(database().db, 'avoid-self');
    await w.setOrgRoles(w.side, { head: w.worker.employeeId });
    const created = await w.create({ endDate: '2026-12-31' });
    await w.send(created.id, 1);
    for (const actor of [w.approvers.pHrbp, w.approvers.pHead, w.approvers.sHrbp])
      await w.decide(created.id, actor, 'approve');
    const pending = w.pending(await w.instance(created.id));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.assigneeUserId).not.toBe(w.worker.userId);
  });

  it('PB-44 标题与表单不含个人数据；变更字段无查看权的审批人被盲审拦住并转异常管理员（DEC-057 / 058）', async () => {
    const db = database().db;
    const w = await requestWorld(db, 'blind');
    const world = await permissionAdmin(w);
    await grantVisibleFields(world, w.approvers.pHrbp.userId, ['id', 'departmentId']);
    const created = await w.create({ endDate: '2026-12-31', remark: '合成备注' });
    await w.send(created.id, 1);
    const view = await w.instance(created.id);
    expect(view.title).not.toContain('兼职员工');
    expect(JSON.stringify(view.form)).not.toContain('兼职员工');
    const task = w.pending(view)[0]!;
    const blocked = await world.api.request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ...w.as(w.approvers.pHrbp.userId),
      ifMatch: view.revision,
      body: { comment: '意见' },
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_BLIND_REVIEW' } } });
    const moved = await w.instance(created.id);
    expect(w.pending(moved).map((item) => item.assigneeUserId)).toEqual([w.exceptionAdmin]);
  });
});

describe('审批结论回写', () => {
  it('驳回 → rejected，修改后重提沿用原实例；不同意 → disapproved 办结不可重提；审批侧撤回 → 草稿', async () => {
    const w = await requestWorld(database().db, 'settle', { disagree: true });
    const a = await w.create({ endDate: '2026-12-31' });
    const submitted = await w.send(a.id, 1);
    await w.decide(a.id, w.approvers.pHrbp, 'reject');
    const rejected = await w.load(a.id);
    expect(rejected.state).toBe('rejected');
    const first = await w.instance(a.id);
    expect(first.status).toBe('returned');
    const edited = await w.update(a.id, rejected.revision, { endDate: '2026-11-30' });
    expect(edited).toMatchObject({ state: 'rejected', versionNo: 2 });
    const again = await w.send(a.id, edited.revision);
    expect(again.state).toBe('in_review');
    expect((await w.instance(a.id)).id).toBe(first.id);
    expect(submitted.revision).toBeLessThan(again.revision);

    const b = await w.create({ startDate: '2026-09-02', endDate: '2026-12-31' });
    await w.send(b.id, 1);
    await w.decide(b.id, w.approvers.pHrbp, 'disagree');
    expect((await w.load(b.id)).state).toBe('disapproved');
    const closed = await w.load(b.id);
    expect(await w.rejected(() => w.send(b.id, closed.revision))).toMatchObject({
      reason: 'PART_TIME_REQUEST_STATE_INVALID',
    });
    expect(await w.partTimeRecords()).toEqual([]);

    const c = await w.create({ startDate: '2026-09-03', endDate: '2026-12-31' });
    await w.send(c.id, 1);
    const view = await w.instance(c.id);
    const response = await w.instanceAction(w.hr.id, view.id, 'withdraw', view.revision);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await w.load(c.id)).state).toBe('draft');
  });

  it('落地复核失败（审批期间员工新增了一条外派，D-5）：申请作废 landing_rejected，审批结论保留，通知发起人，不落地', async () => {
    const w = await requestWorld(database().db, 'landing');
    const created = await w.create({ serviceType: 'secondment', endDate: '2026-12-31' });
    await w.send(created.id, 1);
    for (const actor of [w.approvers.pHrbp, w.approvers.pHead, w.approvers.sHrbp])
      await w.decide(created.id, actor, 'approve');
    await w.run((tx) =>
      insertPartTimeRecord(tx, {
        tenantId: w.tenant.id,
        employeeId: w.worker.employeeId,
        departmentId: w.side,
        serviceType: 'secondment',
        startDate: '2026-09-01',
        endDate: null,
      }),
    );
    await w.decide(created.id, w.approvers.sHead, 'approve');
    const view = await w.instance(created.id);
    expect(view.status).toBe('approved');
    expect((await w.states(created.id)).map((row) => [row.state, row.reason])).toEqual([
      ['draft', null],
      ['in_review', null],
      ['approved', null],
      ['voided', 'landing_rejected'],
    ]);
    expect(await w.partTimeRecords()).toHaveLength(1);
    expect(await w.notices(view.id)).toEqual([
      { recipient: w.hr.id, template: 'part_time_request_voided', kind: 'message' },
    ]);
    expect(await w.auditActions(created.id)).toContain('part_time.request.voided');
  });
});

describe('PB-63 / PB-82 / PB-83：审批编辑越过最后工作日（L = 09-15 已生效）当次拒绝', () => {
  async function scene(editMode: 'separate' | 'with_approve') {
    const w = await requestWorld(database().db, `edit-${editMode}`, { editMode });
    await w.leave('2026-09-15');
    const created = await w.create({ endDate: '2026-09-15' });
    await w.send(created.id, 1);
    const view = await w.instance(created.id);
    return { w, created, view };
  }
  const fingerprint = async (w: Awaited<ReturnType<typeof scene>>['w'], id: string) => ({
    writes: await w.writes(),
    request: await w.load(id),
    logs: (await w.instance(id)).logs.map((log) => log.event),
  });

  it('PB-82 独立编辑：结束日改 09-20 → 409 PART_TIME_BEYOND_EXIT，版本 / 任务 / 实例 / 日志都不变；改 09-10 成功追加版本', async () => {
    const { w, created, view } = await scene('separate');
    const task = w.pending(view)[0]!;
    const before = await fingerprint(w, created.id);
    const denied = await w.taskAction(task.assigneeUserId, task.id, 'edit', view.revision, {
      fields: { endDate: '2026-09-20' },
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { reason: 'PART_TIME_BEYOND_EXIT', lastWorkDate: '2026-09-15' } },
    });
    expect(await fingerprint(w, created.id)).toEqual(before);
    const after = await w.instance(created.id);
    expect(after.revision).toBe(view.revision);
    expect(w.pending(after).map((item) => item.id)).toEqual([task.id]);
    expect(after.logs.some((log) => log.event === 'edit')).toBe(false);

    const ok = await w.taskAction(task.assigneeUserId, task.id, 'edit', view.revision, {
      fields: { endDate: '2026-09-10' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.load(created.id)).version).toMatchObject({ versionNo: 2, endDate: '2026-09-10' });
  });

  it('PB-83 编辑并同意：结束日改为空 → 整个同意失败：任务未关闭、节点未推进、版本不变、不落地', async () => {
    const { w, created, view } = await scene('with_approve');
    const task = w.pending(view)[0]!;
    const before = await fingerprint(w, created.id);
    const denied = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields: { endDate: null },
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { details: { reason: 'PART_TIME_BEYOND_EXIT' } } });
    expect(await fingerprint(w, created.id)).toEqual(before);
    const after = await w.instance(created.id);
    expect(after).toMatchObject({ status: 'running', currentNodeKey: view.currentNodeKey });
    expect(w.pending(after).map((item) => item.id)).toEqual([task.id]);
    expect(await w.partTimeRecords()).toEqual([]);
  });

  it('审批编辑带了适配器不接的字段 / 改开始日 → 400，版本不变', async () => {
    const { w, created, view } = await scene('separate');
    const task = w.pending(view)[0]!;
    const before = await w.writes();
    for (const fields of [{ startDate: '2026-09-02' }, { gender: 'male' }]) {
      const denied = await w.taskAction(task.assigneeUserId, task.id, 'edit', view.revision, { fields });
      expect([400, 403]).toContain(denied.status);
    }
    expect(await w.writes()).toEqual(before);
    expect((await w.load(created.id)).version.versionNo).toBe(1);
  });
});

describe('PB-42：离职落地作废全部在途兼职申请（AC-PT-09 作废）', () => {
  it('草稿 / 审批中 / 驳回都 voided（exit），实例取消、待办消失，发起人与本人收到消息；草稿只写 outbox', async () => {
    const w = await requestWorld(database().db, 'exit-void');
    const draft = await w.create({ startDate: '2026-09-01' });
    const reviewing = await w.create({ startDate: '2026-09-02' });
    const returned = await w.create({ startDate: '2026-09-03' });
    await w.send(reviewing.id, 1);
    await w.send(returned.id, 1);
    await w.decide(returned.id, w.approvers.pHrbp, 'reject');
    const reviewingView = await w.instance(reviewing.id);
    const returnedView = await w.instance(returned.id);
    await w.leave('2026-09-15');
    for (const request of [draft, reviewing, returned]) {
      expect((await w.states(request.id)).at(-1), request.id).toMatchObject({ state: 'voided', reason: 'exit' });
      expect(await w.auditActions(request.id)).toContain('part_time.request.voided_by_exit');
    }
    for (const view of [reviewingView, returnedView]) {
      const closed = await w.detail(view.id);
      expect(closed.status).toBe('cancelled');
      expect(w.pending(closed)).toEqual([]);
      const messages = await w.notices(view.id);
      expect(messages.map((row) => row.template)).toEqual([
        'part_time_request_voided_by_exit',
        'part_time_request_voided_by_exit',
      ]);
      expect(new Set(messages.map((row) => row.recipient))).toEqual(new Set([w.hr.id, w.worker.userId]));
    }
    // 审批人待办里没有这些单
    const todos = await w.todos(w.approvers.pHrbp.userId);
    expect(todos.items.filter((item) => item.instanceId === reviewingView.id)).toEqual([]);
    // 草稿没有实例：只留 outbox 事件，不发站内消息
    const queued = await w.run(async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM employment_outbox
          WHERE tenant_id=${w.tenant.id} AND event_type='part_time.request.voided_by_exit'
            AND object_id=${draft.id}::uuid`),
      ),
    );
    expect(queued[0]!.n).toBe(1);
  });
});

describe('P-14：组织停用计入在途新增兼职申请（无日期过滤）', () => {
  it('审批中 → 409 ORG_SUBTREE_NOT_EMPTY（计 1 条）；撤回成草稿后停用成功', async () => {
    const w = await requestWorld(database().db, 'deactivate');
    // 专用兼职部门：没有负责人 / HRBP 版本，组织写入按普通组织停用
    const lone = await w.org('停用兼职部门');
    const created = await w.create({ departmentId: lone, startDate: '2027-01-01', endDate: '2027-03-31' });
    const submitted = await w.send(created.id, 1);
    const disable = async () => {
      const org = await w.json<{ revision: number }>(
        await w.request(w.hr.id, 'GET', `/api/tenant/org/organizations/${lone}`),
      );
      return w.request(w.hr.id, 'PATCH', `/api/tenant/org/organizations/${lone}`, {
        ifMatch: org.revision,
        body: { enabled: false, effectiveDate: '2026-10-01' },
      });
    };
    const refused = await disable();
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      error: { details: { reason: string; organizations: { orgId: string; employeeCount: number }[] } };
    };
    expect(body.error.details.reason).toBe('ORG_SUBTREE_NOT_EMPTY');
    expect(body.error.details.organizations).toEqual([expect.objectContaining({ orgId: lone, employeeCount: 1 })]);
    await w.withdraw(created.id, submitted.revision);
    const ok = await disable();
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});

describe('适配器契约与 P-47', () => {
  it('part_time 适配器是真适配器：登记完整、resubmit 拒绝、lockMany 存在，mayMergeSeat 由 adapters 导出', async () => {
    const adapter = ADAPTERS.part_time;
    expect(typeof adapter.lockMany).toBe('function');
    expect(typeof mayMergeSeat).toBe('function');
    expect(() => adapter.resubmit({} as never, {} as never, 'x', {})).toThrowError(
      expect.objectContaining({ code: 'CONFLICT', details: { reason: 'APPROVAL_RESUBMIT_VIA_BUSINESS' } }),
    );
  });

  it('延长 / 结束申请的审批回调 PT-4a 前一律 409 PART_TIME_REQUEST_TYPE_NOT_AVAILABLE', async () => {
    const w = await requestWorld(database().db, 'types');
    const record = await w.run((tx) =>
      insertPartTimeRecord(tx, {
        tenantId: w.tenant.id,
        employeeId: w.worker.employeeId,
        departmentId: w.side,
        endDate: '2026-12-31',
      }),
    );
    const extend = await w.run((tx) =>
      insertPartTimeRequest(tx, {
        tenantId: w.tenant.id,
        employeeId: w.worker.employeeId,
        initiatorUserId: w.hr.id,
        departmentId: w.side,
        requestType: 'extend',
        recordId: record,
      }),
    );
    for (const call of [
      () => w.run((tx) => ADAPTERS.part_time.snapshot(tx, w.context(), extend)),
      () => w.run((tx) => ADAPTERS.part_time.approved(tx, w.context(), extend)),
      () => w.run((tx) => ADAPTERS.part_time.edit(tx, w.context(), extend, { endDate: '2027-01-31' })),
    ])
      await expect(call()).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'PART_TIME_REQUEST_TYPE_NOT_AVAILABLE' },
      });
  });

  it('P-47：“使用用户”维度对兼职申请取发起人，其他用户不命中', async () => {
    const w = await requestWorld(database().db, 'scope');
    const created = await w.create({ endDate: '2026-12-31' });
    await w.send(created.id, 1);
    const hits = (creatorId: string) =>
      withTenant(w.db, w.tenant.id, async (tx) =>
        rowsOf<{ id: string }>(
          await tx.execute(sql`SELECT i.id FROM approval_instances i
            WHERE i.tenant_id=${w.tenant.id} AND i.business_id=${created.id}::uuid
              AND ${instanceScopeSql({ tenantId: w.tenant.id } as never, {
                ...EMPTY_SCOPE,
                terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId }],
              })}`),
        ),
      );
    expect(await hits(w.hr.id)).toHaveLength(1);
    expect(await hits(w.worker.userId)).toHaveLength(0);
  });
});
