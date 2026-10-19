/**
 * AC-PT-07（结束申请四节点与结果，R2f1）/ PB-35～41（docs/08_设计/R2-T05_兼职设计.md §4.4 / §4.5 / §9，PT-4c）：
 * 结束兼职申请经内部服务建立并提交，审批走真实审批中心接口。覆盖 T-1～T-4 的拒绝形态、节点顺序（与新增 / 延长相反）、
 * 首节点无人提交即报错 / HRBP 无人转异常管理员、“同意时打开可编辑的业务表单”（审批编辑结束日后落地）、同一条记录截短不新增记录、
 * 原定结束日期不回写、落地复核失败作废、离职作废。日期框架：今天 2026-10-01，主职 2020-01-01 入职；目标兼职默认 09-01～10-31。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { grantFieldAccess, grantVisibleFields, permissionAdmin } from './AC-APV-support.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';

const database = useTestDb();
const world = (label: string, options: Parameters<typeof requestWorld>[2] = {}) =>
  requestWorld(database().db, `pt4c-end-${label}`, options);
const conflict = (reason: string) => ({ code: 'CONFLICT', reason });

const fingerprint = async (w: RequestWorld, id: string) => ({
  writes: await w.writes(),
  request: await w.load(id),
  logs: (await w.instance(id)).logs.map((log) => log.event),
});

/** 经公开读接口看员工的兼职页签（按租户今天派生任职状态与视图归属）。 */
async function listed(w: RequestWorld, recordId: string) {
  const page = await w.ok<{ items: { id: string; serviceStatus: string; partTimeView: string[] }[] }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${w.worker.employeeId}/part-times`),
  );
  return page.items.find((item) => item.id === recordId)!;
}

describe('PB-35 / PB-38：结束申请 → 四节点 → 同一条记录截短，任职结束', () => {
  it('节点顺序 兼职负责人 → 兼职HRBP → 主职负责人 → 主职HRBP（与新增 / 延长相反）；10-01～10-31 结束于过去日期：同一条记录、已结束视图、原定结束日期不变', async () => {
    const w = await world('happy');
    const record = await w.seedRecord({ startDate: '2026-09-01', endDate: '2026-10-31' });
    const created = await w.end(record, '2026-09-20', '合成结束备注');
    expect(created).toMatchObject({
      requestType: 'end',
      state: 'draft',
      recordId: record,
      departmentId: w.side,
      startDate: '2026-09-01',
      endDate: '2026-09-20',
      remark: '合成结束备注',
    });
    expect((await w.load(created.id)).version).toMatchObject({ originalEndDate: '2026-10-31', baseTermNo: 1 });
    await w.send(created.id, created.revision);
    expect(await w.instance(created.id)).toMatchObject({
      approvalType: 'part_time_end',
      title: '结束兼职申请',
      processCode: 'EndParttimeJobProcess',
    });
    expect((await listed(w, record)).serviceStatus).toBe('serving');
    await w.approveInOrder(created.id, w.order.end, 3);
    expect((await w.terms(record)).map((term) => term.end_date)).toEqual(['2026-10-31']);
    await w.approveInOrder(created.id, w.order.end.slice(3));

    expect((await w.states(created.id)).map((row) => row.state)).toEqual([
      'draft',
      'in_review',
      'approved',
      'effective',
    ]);
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: '2026-10-31', source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-09-20', source: 'end', source_id: created.id },
    ]);
    // 不新增记录；任职状态“任职结束”，进已结束视图
    expect((await w.partTimeRecords()).map((row) => row.id)).toEqual([record]);
    expect(await listed(w, record)).toMatchObject({
      serviceStatus: 'ended',
      partTimeView: expect.arrayContaining(['ended']),
    });
    // 审批详情：原定结束日期保持申请时的值，不被实际失效日覆盖
    expect((await w.load(created.id)).version).toMatchObject({ originalEndDate: '2026-10-31', endDate: '2026-09-20' });
    expect(await w.auditActions(record)).toContain('employment.part_time.ended');
    expect(await w.auditActions(created.id)).toContain('part_time.request.effective');
  });

  it('T-3 结束日在未来：按区间派生，不需要调度——记录仍“任职中”，审批通过即追加期限', async () => {
    const w = await world('future');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.end(record, '2026-10-15');
    await w.send(created.id, created.revision);
    await w.approveInOrder(created.id, w.order.end);
    expect((await w.terms(record)).at(-1)).toMatchObject({ end_date: '2026-10-15', source: 'end' });
    expect((await listed(w, record)).serviceStatus).toBe('serving');
  });

  it('当前无结束日的兼职可以结束（T-2 不限）', async () => {
    const w = await world('open-ended');
    const record = await w.seedRecord({ endDate: null });
    const created = await w.end(record, '2026-12-31');
    await w.send(created.id, created.revision);
    await w.approveInOrder(created.id, w.order.end);
    expect((await w.terms(record)).map((term) => term.end_date)).toEqual([null, '2026-12-31']);
  });
});

describe('PB-36 / PB-37：节点无审批人', () => {
  it('PB-36 兼职部门无负责人：提交即报错（首节点无审批人，DEC-054），申请仍是草稿、没有实例', async () => {
    const w = await world('no-head');
    await w.setOrgRoles(w.side, { head: null });
    const record = await w.seedRecord();
    const created = await w.end(record, '2026-09-20');
    expect(await w.rejected(() => w.send(created.id, created.revision))).toMatchObject({
      ...conflict('APPROVAL_FIRST_NODE_EMPTY'),
    });
    expect((await w.load(created.id)).state).toBe('draft');
  });

  it('PB-37 兼职 HRBP 无人：该节点转异常管理员（F-165③）', async () => {
    const w = await world('no-hrbp');
    await w.setOrgRoles(w.side, { hrbp: null });
    const record = await w.seedRecord();
    const created = await w.end(record, '2026-09-20');
    await w.send(created.id, created.revision);
    await w.decide(created.id, w.approvers.sHead, 'approve');
    expect(w.pending(await w.instance(created.id)).map((task) => task.assigneeUserId)).toEqual([w.exceptionAdmin]);
  });
});

describe('T-1 / T-2 / E-4 / E-5：创建时的拒绝（当次无任何写入）', () => {
  it('T-1 结束日早于开始日 → 400 PART_TIME_END_BEFORE_START；T-2 晚于当前结束日 → 409 PART_TIME_END_AFTER_CURRENT', async () => {
    const w = await world('rules-dates');
    const record = await w.seedRecord({ startDate: '2026-09-10', endDate: '2026-10-31' });
    const before = await w.writes();
    expect(await w.rejected(() => w.end(record, '2026-09-09'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'PART_TIME_END_BEFORE_START',
    });
    expect(await w.rejected(() => w.end(record, '2026-11-01'))).toMatchObject(conflict('PART_TIME_END_AFTER_CURRENT'));
    expect(await w.writes()).toEqual(before);
    // 等于开始日、等于当前结束日都允许（T-1 ≥、T-2 ≤）
    expect((await w.end(record, '2026-09-10')).state).toBe('draft');
  });

  it('T-4 / E-5 已结束的兼职不能再结束；E-4 有未办结的延长 / 结束申请（含审批中的延长，PB-41）不能再发结束申请', async () => {
    const w = await world('rules-state');
    const ended = await w.seedRecord({ endDate: '2026-09-15' });
    expect(await w.rejected(() => w.end(ended, '2026-09-10'))).toMatchObject(conflict('PART_TIME_ALREADY_ENDED'));
    const record = await w.seedRecord({ startDate: '2026-09-02' });
    const extend = await w.extend(record, '2026-12-31');
    await w.send(extend.id, extend.revision);
    const before = await w.writes();
    expect(await w.rejected(() => w.end(record, '2026-10-15'))).toMatchObject(
      conflict('PART_TIME_REQUEST_IN_PROGRESS'),
    );
    expect(await w.writes()).toEqual(before);
  });

  it('修改草稿：T-1 / T-2 当次拒绝不留版本；只能改结束日期与备注；合法改动追加版本', async () => {
    const w = await world('update');
    const record = await w.seedRecord({ startDate: '2026-09-10', endDate: '2026-10-31' });
    const created = await w.end(record, '2026-09-20');
    const before = await w.writes();
    expect(await w.rejected(() => w.update(created.id, created.revision, { endDate: '2026-09-01' }))).toMatchObject({
      reason: 'PART_TIME_END_BEFORE_START',
    });
    expect(await w.rejected(() => w.update(created.id, created.revision, { endDate: '2026-12-01' }))).toMatchObject(
      conflict('PART_TIME_END_AFTER_CURRENT'),
    );
    expect(await w.rejected(() => w.update(created.id, created.revision, { startDate: '2026-09-11' }))).toMatchObject({
      reason: 'PART_TIME_FIELD_NOT_EDITABLE',
    });
    expect(await w.writes()).toEqual(before);
    expect(await w.update(created.id, created.revision, { endDate: '2026-09-25', remark: '改后' })).toMatchObject({
      versionNo: 2,
      endDate: '2026-09-25',
      remark: '改后',
    });
  });
});

describe('PB-39 / A-14：审批编辑（同意时打开可编辑的业务表单，只开结束日期与备注）', () => {
  async function scene() {
    const w = await world('edit');
    const record = await w.seedRecord({ startDate: '2026-09-01', endDate: '2026-10-31' });
    const created = await w.end(record, '2026-09-20');
    await w.send(created.id, created.revision);
    const view = await w.instance(created.id);
    return { w, record, created, view, task: w.pending(view)[0]! };
  }

  it('PB-39 编辑结束日期后同意：落地按编辑后的日期，原定结束日期不变', async () => {
    const { w, record, created, view, task } = await scene();
    const ok = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields: { endDate: '2026-09-25', requestRemark: '审批人备注' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.load(created.id)).version).toMatchObject({
      versionNo: 2,
      endDate: '2026-09-25',
      remark: '审批人备注',
      originalEndDate: '2026-10-31',
    });
    await w.approveInOrder(created.id, w.order.end.slice(1));
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: '2026-10-31', source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-09-25', source: 'end', source_id: created.id },
    ]);
  });

  it('编辑并同意越界（T-1 / T-2）→ 整个同意动作失败：任务未关闭、节点未推进、版本 / 实例 / 日志不变', async () => {
    const { w, created, view, task } = await scene();
    const before = await fingerprint(w, created.id);
    const approve = (endDate: string) =>
      w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
        comment: '合成意见',
        fields: { endDate },
      });
    const early = await approve('2026-08-31');
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ error: { details: { reason: 'PART_TIME_END_BEFORE_START' } } });
    const late = await approve('2026-11-30');
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { reason: 'PART_TIME_END_AFTER_CURRENT' } },
    });
    expect(await fingerprint(w, created.id)).toEqual(before);
    const stuck = await w.instance(created.id);
    expect(stuck).toMatchObject({ status: 'running', currentNodeKey: view.currentNodeKey });
    expect(w.pending(stuck).map((item) => item.id)).toEqual([task.id]);
  });

  it('适配器第二层：节点另开放的字段也不接 → 400 PART_TIME_FIELD_NOT_EDITABLE；节点未开放 → 403 APPROVAL_FIELD_NOT_EDITABLE', async () => {
    const w = await world('edit-layers', { editMode: 'separate', extraEditable: ['departmentId'] });
    const record = await w.seedRecord();
    const created = await w.end(record, '2026-09-20');
    await w.send(created.id, created.revision);
    const view = await w.instance(created.id);
    const task = w.pending(view)[0]!;
    const edit = (fields: Record<string, unknown>) =>
      w.taskAction(task.assigneeUserId, task.id, 'edit', view.revision, { fields });
    const before = await w.writes();
    const unaccepted = await edit({ departmentId: w.primary });
    expect(unaccepted.status).toBe(400);
    expect(await unaccepted.json()).toMatchObject({ error: { details: { reason: 'PART_TIME_FIELD_NOT_EDITABLE' } } });
    const closed = await edit({ postId: w.primary });
    expect(closed.status).toBe(403);
    expect(await closed.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_FIELD_NOT_EDITABLE' } } });
    expect(await w.writes()).toEqual(before);
  });
});

describe('PB-40 / PB-42：落地复核与作废', () => {
  it('PB-40 提交后同一兼职被其他入口结束（直接写期限模拟）→ 末节点同意后作废 changed_since_submit，不落地', async () => {
    const w = await world('changed');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.end(record, '2026-09-20');
    await w.send(created.id, created.revision);
    await w.approveInOrder(created.id, w.order.end, 3);
    await w.run((tx) =>
      tx.execute(sql`INSERT INTO employment_part_time_terms(tenant_id, employee_id, record_id, term_no, end_date, source,
          command_id) VALUES (${w.tenant.id}, ${w.worker.employeeId}, ${record}, 2, '2026-09-10', 'transfer', 'pt-test-transfer')`),
    );
    await w.approveInOrder(created.id, w.order.end.slice(3));
    const view = await w.instance(created.id);
    expect(view.status).toBe('approved');
    expect((await w.states(created.id)).map((row) => [row.state, row.reason])).toEqual([
      ['draft', null],
      ['in_review', null],
      ['approved', null],
      ['voided', 'changed_since_submit'],
    ]);
    expect((await w.terms(record)).map((term) => term.source)).toEqual(['create', 'transfer']);
    expect(await w.notices(view.id)).toEqual([
      { recipient: w.hr.id, template: 'part_time_request_voided', kind: 'message' },
    ]);
  });

  it('PB-42 离职落地作废在途结束申请（exit），实例取消；撤销 / 撤回 / 删除沿用既有入口', async () => {
    const w = await world('exit');
    const record = await w.seedRecord({ endDate: '2026-12-31' });
    const created = await w.end(record, '2026-11-30');
    await w.send(created.id, created.revision);
    const view = await w.instance(created.id);
    await w.leave('2026-09-30');
    expect((await w.states(created.id)).at(-1)).toMatchObject({ state: 'voided', reason: 'exit' });
    expect((await w.detail(view.id)).status).toBe('cancelled');
    expect(await w.auditActions(created.id)).toContain('part_time.request.voided_by_exit');

    const other = await w.seedRecord({ startDate: '2026-09-02', endDate: '2026-12-31' });
    const draft = await w.end(other, '2026-11-30');
    const revoked = await w.revoke(draft.id, draft.revision);
    expect(revoked.state).toBe('voided');
    const again = await w.end(other, '2026-11-29');
    const removed = await w.remove(again.id, again.revision);
    expect(removed.state).toBe('deleted');
  });
});

describe('真实授权器下的正常审批（快照字段编码须是任职记录权限目录里的编码）', () => {
  const ALL = MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code);

  it('有全部字段查看权 → 同意 200 并落地；缺 endDate 查看权 → 403 APPROVAL_BLIND_REVIEW 并转异常管理员', async () => {
    const w = await world('real');
    const admin = await permissionAdmin(w);
    const act = (user: string, task: string, revision: number) =>
      admin.api.request('POST', `/api/tenant/approval/tasks/${task}/approve`, {
        ...w.as(user),
        ifMatch: revision,
        body: { comment: '意见' },
      });
    await grantFieldAccess(admin, w.approvers.sHead.userId, { view: ALL, edit: [] });
    await grantVisibleFields(
      admin,
      w.approvers.sHrbp.userId,
      ALL.filter((code) => code !== 'endDate'),
    );
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.end(record, '2026-09-20', '合成备注');
    await w.send(created.id, created.revision);
    let view = await w.instance(created.id);
    const first = await act(w.approvers.sHead.userId, w.pending(view)[0]!.id, view.revision);
    expect(first.status, await first.clone().text()).toBe(200);
    view = await w.instance(created.id);
    const blind = await act(w.approvers.sHrbp.userId, w.pending(view)[0]!.id, view.revision);
    expect(blind.status).toBe(403);
    expect(await blind.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_BLIND_REVIEW' } } });
    expect(w.pending(await w.instance(created.id)).map((task) => task.assigneeUserId)).toEqual([w.exceptionAdmin]);
  });
});
