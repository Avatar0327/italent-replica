/**
 * R2-T03 B2a / AC-DM-22 / 25：离职写入口公共门禁（设计 §4A / §8 / §8B / §9.1）。
 * 通用任职入口（POST employees/:id/businesses、PATCH、submit / withdraw / DELETE / retry）对 kind=leave 经同一门禁：
 * 按钮 + 功能权 + 范围 + 前置条件，不以 Employment.Create / Edit / Delete 代替 Dimission* 四个按钮；
 * 失败一律无业务写入（前后 stateOf 逐项相等）。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons, gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const LATER = '2026-10-20';

async function world(label: string) {
  const w = await gateWorld(database().db, label);
  const { employee } = await w.hired();
  return { w, employee };
}

describe('AC-DM-22 离职申请经门禁创建（B-26 / B-30 补充）', () => {
  it('创建草稿并写扩展行：发起人、周期、转交时机快照分开记录，审计 exit.request.create', async () => {
    const { w, employee } = await world('gate-create');
    const created = await w.createdLeave(employee.id, leaveBody(LATER, 'application', { reasonCode: 'personal' }));
    expect(created.status).toBe('draft');
    const row = await w.exitRow(created.id);
    expect(row).toMatchObject({
      mode: 'application',
      initiator: 'hr',
      initiator_user_id: w.session.user.id,
      employee_id: employee.id,
      reason_code: 'personal',
      duty_transfer_timing: 'business_effective',
      pre_release_date: null,
      pending_transfer_ack: null,
    });
    const [cycle] = await w.sqlRows<{ id: string }>(sql`SELECT id FROM employment_cycles
      WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employee.id}::uuid ORDER BY entry_date DESC LIMIT 1`);
    expect(row!.staff_id).toBe(cycle!.id);
    const [audit] = await w.sqlRows<{ after: Record<string, unknown> }>(sql`SELECT after FROM audit_events
      WHERE tenant_id=${w.session.tenant.id} AND action='exit.request.create' AND object_id=${created.id}`);
    expect(audit?.after).toMatchObject({
      initiation: 'hr',
      initiatorUserId: w.session.user.id,
      employeeId: employee.id,
    });
  });

  it('B-26 同员工已有未办结离职：409 EXIT_IN_PROGRESS 且无写入；删除草稿后可再发起', async () => {
    const { w, employee } = await world('gate-in-progress');
    const first = await w.createdLeave(employee.id, leaveBody(LATER));
    const before = await w.stateOf(employee.id);
    for (const mode of ['application', 'direct'] as const) {
      const rejected = await w.createLeave(employee.id, leaveBody(LATER, mode));
      expect(await w.reason(rejected)).toMatchObject({ status: 409, reason: 'EXIT_IN_PROGRESS' });
    }
    expect(await w.stateOf(employee.id)).toEqual(before);
    const removed = await w.session.request('DELETE', `/businesses/${first.id}`, {
      ifMatch: first.revision,
      body: { reason: '删除草稿' },
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.createLeave(employee.id, leaveBody(LATER))).status).toBe(201);
  });

  it('字典与日期校验：未知离职原因 400；最后工作日早于当前周期入职日 400；均无写入', async () => {
    const { w, employee } = await world('gate-validate');
    const before = await w.stateOf(employee.id);
    const unknown = await w.createLeave(employee.id, leaveBody(LATER, 'application', { reasonCode: 'nope' }));
    expect(await w.reason(unknown)).toMatchObject({ status: 400, reason: 'EXIT_DICTIONARY_UNKNOWN' });
    const stranger = await w.createLeave(
      employee.id,
      leaveBody(LATER, 'application', { handoverEmployeeId: '00000000-0000-4000-8000-000000000001' }),
    );
    expect(await w.reason(stranger)).toMatchObject({ status: 400, reason: 'EXIT_HANDOVER_EMPLOYEE_INVALID' });
    const early = await w.createLeave(employee.id, leaveBody('2026-08-31'));
    expect(await w.reason(early)).toMatchObject({ status: 400, reason: 'EXIT_LAST_WORK_DATE_BEFORE_ENTRY' });
    expect(await w.stateOf(employee.id)).toEqual(before);
  });
});

describe('交接人校验（DEC-177 可见性：按员工对象的真实创建者与当前范围判断）', () => {
  it('范围内的合法交接人可用；未知与范围外统一 400 EXIT_HANDOVER_EMPLOYEE_INVALID，错误体一致不暴露存在性', async () => {
    const { w, employee } = await world('gate-handover');
    const handover = (await w.hired('范围内交接人')).employee;
    const other = await w.otherUser();
    const outside = await w.employeeAs(other.id, '范围外交接人');
    const hr = w.restricted(denyButtons(), w.session.user.id);
    const visible = await hr('GET', `/employees/${handover.id}`);
    expect(visible.status).toBe(200);
    const bodyOf = async (handoverEmployeeId: string) =>
      w.reason(await w.createLeave(employee.id, leaveBody(LATER, 'application', { handoverEmployeeId }), hr));
    const unknown = await bodyOf('00000000-0000-4000-8000-000000000001');
    const hidden = await bodyOf(outside.id);
    expect(unknown).toMatchObject({ status: 400, reason: 'EXIT_HANDOVER_EMPLOYEE_INVALID' });
    expect(hidden).toEqual(unknown);
    const ok = await w.createLeave(
      employee.id,
      leaveBody(LATER, 'application', { handoverEmployeeId: handover.id }),
      hr,
    );
    expect(ok.status, await ok.clone().text()).toBe(201);
  });
});

describe('B-46 / B-47 按钮与功能权：Dimission* 四个按钮，Employment.Create / Edit / Delete 不能代替', () => {
  it('B-46 创建：直接离职需 Dimission、申请需 DimissionApproval；无则 403 且无写入', async () => {
    const { w, employee } = await world('gate-create-buttons');
    const before = await w.stateOf(employee.id);
    const noDirect = w.restricted(denyButtons('Employment.Dimission'));
    const noApply = w.restricted(denyButtons('Employment.DimissionApproval'));
    const noneAtAll = w.restricted(denyButtons('Employment.Dimission', 'Employment.DimissionApproval'));
    expect((await w.createLeave(employee.id, leaveBody(LATER, 'direct'), noDirect)).status).toBe(403);
    expect((await w.createLeave(employee.id, leaveBody(LATER), noApply)).status).toBe(403);
    for (const mode of ['direct', 'application'] as const)
      expect((await w.createLeave(employee.id, leaveBody(LATER, mode), noneAtAll)).status).toBe(403);
    expect(await w.stateOf(employee.id)).toEqual(before);
    expect((await w.createLeave(employee.id, leaveBody(LATER, 'direct'), noApply)).status).toBe(201);
  });

  it('B-47 PATCH / submit / withdraw / DELETE / retry 各需对应按钮，通用 Edit 等不够；403 无写入', async () => {
    const { w, employee } = await world('gate-op-buttons');
    const draft = await w.createdLeave(employee.id, leaveBody(LATER));
    const approved = await w.createdLeave((await w.hired('第二人')).employee.id, leaveBody(LATER, 'direct'));
    const before = await w.stateOf(employee.id);
    const call = (
      api: ReturnType<typeof w.restricted>,
      method: string,
      id: string,
      rev: number,
      path = '',
      body?: object,
    ) => api(method, `/businesses/${id}${path}`, { ifMatch: rev, ...(body ? { body } : {}) });
    const edit = w.restricted(denyButtons('Employment.DimissionEdit'));
    const apply = w.restricted(denyButtons('Employment.DimissionApproval'));
    const cancel = w.restricted(denyButtons('Employment.DimissionCancel'));
    const dimission = w.restricted(denyButtons('Employment.Dimission'));
    const retry = w.restricted(denyButtons('Employment.RetryActivation'));
    expect((await call(edit, 'PATCH', draft.id, draft.revision, '', { fields: { place: '新地点' } })).status).toBe(403);
    expect((await call(apply, 'POST', draft.id, draft.revision, '/submit', {})).status).toBe(403);
    expect((await call(apply, 'POST', draft.id, draft.revision, '/withdraw', {})).status).toBe(403);
    expect((await call(cancel, 'DELETE', draft.id, draft.revision)).status).toBe(403);
    for (const api of [dimission, retry])
      expect((await call(api, 'POST', approved.id, approved.revision, '/activation/retry', {})).status).toBe(403);
    expect(await w.stateOf(employee.id)).toEqual(before);
  });
});

describe('B-47a / B-18 / B-53 在途调动确认令牌（§8）：通用入口与专用入口同一确认', () => {
  it('创建缺令牌 409 EXIT_PENDING_TRANSFER_ACK_REQUIRED（给出可见项、hiddenCount、新令牌）；错令牌同；带正确令牌 201', async () => {
    const { w, employee } = await world('gate-token');
    const transfer = await w.apply(employee.id, '2026-10-25', { departmentId: w.to.id });
    const before = await w.stateOf(employee.id);
    const missing = await w.reason(await w.createLeave(employee.id, leaveBody(LATER)));
    expect(missing).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED', hiddenCount: 0 });
    expect(missing.items).toEqual([{ businessId: transfer.id, effectiveDate: '2026-10-25' }]);
    const wrong = await w.reason(
      await w.createLeave(employee.id, leaveBody(LATER, 'application', { pendingTransferAck: 'bogus' })),
    );
    expect(wrong).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
    expect(await w.stateOf(employee.id)).toEqual(before);
    const body = leaveBody(LATER, 'application', { pendingTransferAck: missing.ackToken });
    const created = await w.createdLeave(employee.id, body);
    expect((await w.exitRow(created.id))!.pending_transfer_ack).toMatchObject({ ids: [transfer.id] });
  });

  it('B-18 保存后、提交前新增在途调动：提交 409 要求重新确认，带新令牌后提交成功', async () => {
    const { w, employee } = await world('gate-resubmit');
    const draft = await w.createdLeave(employee.id, leaveBody(LATER));
    const transfer = await w.apply(employee.id, '2026-10-25', { departmentId: w.to.id });
    const submit = (body: object) =>
      w.session.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body });
    const required = await w.reason(await submit({}));
    expect(required).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
    expect(required.items).toEqual([{ businessId: transfer.id, effectiveDate: '2026-10-25' }]);
    const ok = await submit({ pendingTransferAck: required.ackToken });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'in_review' });
  });

  it('B-53 看不到的调动：409 只给 hiddenCount 与令牌、不返回其 ID；带令牌可创建', async () => {
    const { w, employee } = await world('gate-hidden');
    const other = await w.otherUser();
    const transfer = await w.applyAs(other.id, employee.id, '2026-10-25', { departmentId: w.to.id });
    const hr = w.restricted(denyButtons(), w.session.user.id);
    const response = await w.createLeave(employee.id, leaveBody(LATER), hr);
    const text = await response.clone().text();
    expect(text).not.toContain(transfer.id);
    expect(await w.reason(response)).toMatchObject({
      status: 409,
      reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED',
      hiddenCount: 1,
      items: [],
    });
    const { ackToken } = await w.reason(await w.createLeave(employee.id, leaveBody(LATER), hr));
    const ok = await w.createLeave(employee.id, leaveBody(LATER, 'application', { pendingTransferAck: ackToken }), hr);
    expect(ok.status, await ok.clone().text()).toBe(201);
  });
});

describe('AC-DM-25 B-55～B-55c 转正在途拦截（§8B）', () => {
  const regularization = (w: Awaited<ReturnType<typeof world>>['w'], id: string, date: string) =>
    w.synthetic(id, { kind: 'intern_regularization', state: 'in_review', effectiveDate: date });

  it('B-55 计划生效日 ≤ 最后工作日的审批中实习转正：创建 409 EXIT_REGULARIZATION_IN_FLIGHT，给出该项；B-55a 晚于最后工作日放行', async () => {
    const { w, employee } = await world('gate-reg');
    const blocker = await regularization(w, employee.id, '2026-10-18');
    const before = await w.stateOf(employee.id);
    const rejected = await w.reason(await w.createLeave(employee.id, leaveBody(LATER)));
    expect(rejected).toMatchObject({ status: 409, reason: 'EXIT_REGULARIZATION_IN_FLIGHT', hiddenCount: 0 });
    expect(rejected.items).toEqual([{ businessId: blocker, effectiveDate: '2026-10-18' }]);
    expect(await w.stateOf(employee.id)).toEqual(before);
    const later = await world('gate-reg-later');
    await regularization(later.w, later.employee.id, '2026-10-25');
    expect((await later.w.createLeave(later.employee.id, leaveBody(LATER))).status).toBe(201);
  });

  it('B-55b 范围外的转正在途只计件数；B-55c 提交时同样拦截', async () => {
    const { w, employee } = await world('gate-reg-hidden');
    const hr = w.restricted(denyButtons(), w.session.user.id);
    const draft = await w.createdLeave(employee.id, leaveBody(LATER));
    const blocker = await regularization(w, employee.id, '2026-10-18');
    const submit = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(await w.reason(submit)).toMatchObject({ status: 409, reason: 'EXIT_REGULARIZATION_IN_FLIGHT' });
    const hiddenSubmit = await hr('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {} });
    const hidden = await w.reason(hiddenSubmit);
    expect(hidden).toMatchObject({ reason: 'EXIT_REGULARIZATION_IN_FLIGHT', hiddenCount: 1, items: [] });
    expect(JSON.stringify(hidden)).not.toContain(blocker);
  });
});
