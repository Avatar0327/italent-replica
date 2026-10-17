/**
 * R2-T03 B2b / AC-DM-22（HTTP 入口）：离职专用路由 preview / 新建 / submit / withdraw（设计 §4 / §4A / §9.1）。
 * 权限链固定为 功能操作权 → 按钮权 → 范围 → 字段权 → §4A 前置条件；专用入口只认 Dimission* 按钮，不要求 Employment.Create
 * / Submit / Withdraw。B-64：有按钮无功能权 403；撤权后同键重放 403；B-64f 非原发起人不能代重提；B-64g 原发起人撤权后不能
 * 重提。B-30：停用的字典项不能再选，已保存单原样保留。每个拒绝都读前后状态逐项相等；新入口同样遵守 §18.1 关口
 * （直接离职 L 已过只存 approved，时间轴 / 合同 / 调动申请 / 审批实例不变）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons, gateWorld, type GateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const LATER = '2026-10-20';
type Api = GateWorld['session']['request'];

async function world(label: string) {
  const w = await gateWorld(database().db, label);
  const { employee } = await w.hired();
  return { w, employee };
}

const exitBody = (lastWorkDate: string, mode: 'application' | 'direct' = 'application', exit?: object) => ({
  mode,
  lastWorkDate,
  ...(exit ? { exit } : {}),
});

async function create(w: GateWorld, employeeId: string, body: object, api: Api = w.session.request) {
  const { revision } = await w.session.getEmployee(employeeId);
  return api('POST', `/exits/employees/${employeeId}`, { ifMatch: revision, body });
}

const preview = (w: GateWorld, employeeId: string, lastWorkDate: string, api: Api = w.session.request) =>
  api('POST', `/exits/employees/${employeeId}/preview`, { body: { lastWorkDate } });

/** 有按钮、没有对象功能操作权（object.create / update）。 */
const denyOperation =
  (operation: string): Authorizer =>
  (request) =>
    request.action !== operation;

describe('AC-DM-22 POST exits/employees/:id/preview', () => {
  it('列出在途调动确认清单与令牌、将被作废的申请、转正在途阻断；只读不写；带回令牌即可创建', async () => {
    const { w, employee } = await world('routes-preview');
    const transfer = await w.apply(employee.id, '2026-10-25', { departmentId: w.to.id });
    const blocker = await w.synthetic(employee.id, {
      kind: 'intern_regularization',
      state: 'in_review',
      effectiveDate: '2026-10-18',
    });
    const before = await w.stateOf(employee.id);
    const response = await preview(w, employee.id, LATER);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      effectiveDate: string;
      ack: { ackToken: string; items: unknown[]; hiddenCount: number };
      blockers: { reason: string; items: { businessId: string }[] }[];
      warnings: { reason: string; items: { businessId: string }[] }[];
    };
    expect(body.effectiveDate).toBe('2026-10-21');
    expect(body.ack).toMatchObject({
      items: [{ businessId: transfer.id, effectiveDate: '2026-10-25' }],
      hiddenCount: 0,
    });
    expect(body.blockers).toEqual([
      {
        reason: 'EXIT_REGULARIZATION_IN_FLIGHT',
        items: [{ businessId: blocker, effectiveDate: '2026-10-18' }],
        hiddenCount: 0,
      },
    ]);
    const voided = body.warnings.find((warning) => warning.reason === 'EXIT_APPLICATIONS_TO_VOID');
    expect(voided?.items.map((item) => item.businessId).sort()).toEqual([blocker, transfer.id].sort());
    expect(await w.stateOf(employee.id)).toEqual(before);
    const later = await world('routes-preview-ack');
    const pending = await later.w.apply(later.employee.id, '2026-10-25', { departmentId: later.w.to.id });
    const { ack } = (await (await preview(later.w, later.employee.id, LATER)).json()) as typeof body;
    const created = await create(
      later.w,
      later.employee.id,
      exitBody(LATER, 'application', { pendingTransferAck: ack.ackToken }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    expect((await later.w.exitRow(((await created.json()) as { id: string }).id))!.pending_transfer_ack).toMatchObject({
      ids: [pending.id],
    });
  });

  it('看不到的调动只计 hiddenCount；Dimission / DimissionApproval 任一即可预览，两者都无 403；范围外 404', async () => {
    const { w, employee } = await world('routes-preview-perm');
    const other = await w.otherUser();
    const transfer = await w.applyAs(other.id, employee.id, '2026-10-25', { departmentId: w.to.id });
    const hr = w.restricted(denyButtons(), w.session.user.id);
    const hidden = await preview(w, employee.id, LATER, hr);
    expect(hidden.status).toBe(200);
    expect(await hidden.clone().text()).not.toContain(transfer.id);
    expect(((await hidden.json()) as { ack: unknown }).ack).toMatchObject({ items: [], hiddenCount: 1 });
    const one = w.restricted(denyButtons('Employment.Dimission'));
    expect((await preview(w, employee.id, LATER, one)).status).toBe(200);
    const none = w.restricted(denyButtons('Employment.Dimission', 'Employment.DimissionApproval'));
    expect((await preview(w, employee.id, LATER, none)).status).toBe(403);
    const outsider = await w.employeeAs(other.id, '范围外员工');
    expect((await preview(w, outsider.id, LATER, hr)).status).toBe(404);
  });
});

describe('AC-DM-22 POST exits/employees/:id（专用新建入口）', () => {
  it('直接离职 L 已过：201 approved，不落地（§18.1 ③）；申请 201 draft；不要求 Employment.Create', async () => {
    const { w, employee } = await world('routes-create');
    const before = await w.stateOf(employee.id);
    const noCreate = w.restricted(denyButtons('Employment.Create'));
    const direct = await create(w, employee.id, exitBody('2026-10-01', 'direct'), noCreate);
    expect(direct.status, await direct.clone().text()).toBe(201);
    const business = (await direct.json()) as { id: string; status: string };
    expect(business.status).toBe('approved');
    const after = await w.stateOf(employee.id);
    const untouched = (state: typeof before) => [state.timeline, state.contracts, state.instances, state.attempts];
    expect(untouched(after)).toEqual(untouched(before));
    expect(await w.exitRow(business.id)).toMatchObject({ mode: 'direct', initiator: 'hr' });
    const second = (await w.hired('申请员工')).employee;
    const draft = await create(w, second.id, exitBody(LATER, 'application', { reasonCode: 'personal' }), noCreate);
    expect(draft.status, await draft.clone().text()).toBe(201);
    expect(await draft.json()).toMatchObject({ status: 'draft', effectiveDate: '2026-10-21' });
  });

  it('按钮缺失 / 有按钮无功能权 403；dutyTransfer 400；kind 不是离职 400；均无写入', async () => {
    const { w, employee } = await world('routes-create-deny');
    const before = await w.stateOf(employee.id);
    const noDirect = w.restricted(denyButtons('Employment.Dimission'));
    expect((await create(w, employee.id, exitBody(LATER, 'direct'), noDirect)).status).toBe(403);
    const noOperation = w.restricted(denyOperation('object.create'));
    expect((await create(w, employee.id, exitBody(LATER), noOperation)).status).toBe(403);
    const duty = await create(w, employee.id, exitBody(LATER, 'application', { dutyTransfer: {} }));
    expect(await w.reason(duty)).toMatchObject({ status: 400, reason: 'EXIT_DUTY_TRANSFER_NOT_AVAILABLE' });
    expect((await create(w, employee.id, { ...exitBody(LATER), kind: 'transfer' })).status).toBe(400);
    expect(await w.stateOf(employee.id)).toEqual(before);
  });

  it('B-64 撤权后同键重放：403，不返回缓存的 201', async () => {
    const { w, employee } = await world('routes-replay');
    const key = randomUUID();
    const { revision } = await w.session.getEmployee(employee.id);
    const send = (api: Api) =>
      api('POST', `/exits/employees/${employee.id}`, { ifMatch: revision, body: exitBody(LATER), idempotencyKey: key });
    expect((await send(w.session.request)).status).toBe(201);
    const after = await w.stateOf(employee.id);
    const replay = await send(w.restricted(denyButtons('Employment.DimissionApproval')));
    expect(replay.status).toBe(403);
    expect(await w.stateOf(employee.id)).toEqual(after);
  });

  it('B-30 停用的离职去向不能再选（400 EXIT_DICTIONARY_DISABLED）；已保存单保留该编码，改其他字段照常', async () => {
    const { w, employee } = await world('routes-disabled');
    const saved = await create(w, employee.id, exitBody(LATER, 'application', { whereaboutsCode: 'startup' }));
    const draft = (await saved.json()) as { id: string; revision: number };
    const list = await w.session.request('GET', '/exits/dictionaries/whereabouts');
    const entry = ((await list.json()) as { items: { id: string; code: string; revision: number }[] }).items.find(
      (item) => item.code === 'startup',
    )!;
    const disabled = await w.session.request('PUT', `/exits/dictionaries/whereabouts/${entry.id}`, {
      ifMatch: entry.revision,
      body: { enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const second = (await w.hired('第二人')).employee;
    const before = await w.stateOf(second.id);
    const rejected = await create(w, second.id, exitBody(LATER, 'application', { whereaboutsCode: 'startup' }));
    expect(await w.reason(rejected)).toMatchObject({ status: 400, reason: 'EXIT_DICTIONARY_DISABLED' });
    expect(await w.stateOf(second.id)).toEqual(before);
    const edited = await w.session.request('PATCH', `/exits/${draft.id}`, {
      ifMatch: draft.revision,
      body: { exitTypeCode: 'voluntary' },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await w.exitRow(draft.id)).toMatchObject({ whereabouts_code: 'startup', exit_type_code: 'voluntary' });
  });
});

describe('AC-DM-22 POST exits/:id/submit | withdraw', () => {
  async function drafted(label: string) {
    const { w, employee } = await world(label);
    const response = await create(w, employee.id, exitBody(LATER, 'application', { exitTypeCode: 'voluntary' }));
    expect(response.status).toBe(201);
    return { w, employee, draft: (await response.json()) as { id: string; revision: number } };
  }

  it('提交进入审批、撤回回草稿；只要 DimissionApproval，不要求 Employment.Submit / Withdraw；缺 DimissionApproval 403', async () => {
    const { w, employee, draft } = await drafted('routes-submit');
    const generic = w.restricted(denyButtons('Employment.Submit', 'Employment.Withdraw'));
    const none = w.restricted(denyButtons('Employment.DimissionApproval'));
    const before = await w.stateOf(employee.id);
    expect((await none('POST', `/exits/${draft.id}/submit`, { ifMatch: draft.revision, body: {} })).status).toBe(403);
    expect(await w.stateOf(employee.id)).toEqual(before);
    const sent = await generic('POST', `/exits/${draft.id}/submit`, { ifMatch: draft.revision, body: {} });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const submitted = (await sent.json()) as { status: string; revision: number };
    expect(submitted.status).toBe('in_review');
    expect((await w.stateOf(employee.id)).instances).toHaveLength(1);
    const back = await generic('POST', `/exits/${draft.id}/withdraw`, { ifMatch: submitted.revision });
    expect(back.status, await back.clone().text()).toBe(200);
    expect(await back.json()).toMatchObject({ status: 'draft' });
  });

  it('B-64f 权限齐全的 HR B 不能代重提 A 撤回的单；B-64g A 撤权（按钮 / 范围）后不能重提；状态与发起人不变', async () => {
    const { w, employee, draft } = await drafted('routes-initiator');
    const sent = await w.session.request('POST', `/exits/${draft.id}/submit`, { ifMatch: draft.revision, body: {} });
    const withdrawn = await w.session.request('POST', `/exits/${draft.id}/withdraw`, {
      ifMatch: ((await sent.json()) as { revision: number }).revision,
    });
    const current = (await withdrawn.json()) as { revision: number; status: string };
    expect(current.status).toBe('draft');
    const before = await w.stateOf(employee.id);
    const other = await w.otherUser();
    const hrB = w.asUser(other.id);
    const resubmit = (api: Api) => api('POST', `/exits/${draft.id}/submit`, { ifMatch: current.revision, body: {} });
    expect(await w.reason(await resubmit(hrB))).toMatchObject({ status: 403, reason: 'EXIT_SUBMIT_INITIATOR_ONLY' });
    expect((await resubmit(w.restricted(denyButtons('Employment.DimissionApproval')))).status).toBe(403);
    expect((await resubmit(w.restricted(denyButtons(), other.id))).status).toBe(404);
    expect(await w.stateOf(employee.id)).toEqual(before);
    expect(await w.exitRow(draft.id)).toMatchObject({ initiator: 'hr', initiator_user_id: w.session.user.id });
  });

  it('B-64 审批人不需要发起按钮：无 Dimission / DimissionApproval 的审批人可同意，单据审批通过', async () => {
    const { w, draft } = await drafted('routes-approver');
    const sent = await w.session.request('POST', `/exits/${draft.id}/submit`, { ifMatch: draft.revision, body: {} });
    expect(sent.status).toBe(200);
    const [task] = await w.sqlRows<{ id: string; assignee: string; revision: number }>(sql`SELECT t.id,
        t.assignee_user_id AS assignee, i.revision FROM approval_tasks t
      JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
      WHERE t.tenant_id=${w.session.tenant.id} AND i.business_id=${draft.id}::uuid AND t.status='pending'`);
    const approver = w.asUser(task!.assignee, denyButtons('Employment.Dimission', 'Employment.DimissionApproval'));
    const approved = await approver('POST', `/../approval/tasks/${task!.id}/approve`, {
      ifMatch: Number(task!.revision),
      body: {},
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(await w.business(draft.id)).toMatchObject({ status: 'approved' });
  });

  it('不是离职单 → 404（调动单不能走离职入口）', async () => {
    const { w, employee } = await world('routes-not-exit');
    const transfer = await w.apply(employee.id, '2026-10-25', { departmentId: w.to.id });
    const response = await w.session.request('POST', `/exits/${transfer.id}/withdraw`, {
      ifMatch: transfer.revision,
    });
    expect(response.status).toBe(404);
  });
});
