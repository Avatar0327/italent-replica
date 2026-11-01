/**
 * F-400 第 2 轮（DEC-725）：个人信息类在途流程（意向退休日期申请、员工子集变更申请）的离职终止。
 * ③ 预览、确认令牌、生效执行三处用同一个“实际终止候选”入口：预览列出的、409 要求确认的、生效时终止的是同一个集合；
 *    未勾选的不在其中；看不到的只计 hiddenCount、不露 ID，令牌仍覆盖它。
 * ④ 终止的专项审计按业务对象登记（人事申请 / 意向申请），有权限的 HR 能经审计查询接口读到。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { auditApi } from './AC-AUD-support.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { intentionWorld, type IntentionWorld } from './AC-RT-intention-support.js';
import { setExitTermination } from './support/exit-termination.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const EMPLOYMENT = '/api/tenant/employment';
const FLOW_ACK = 'EXIT_FLOW_TERMINATION_ACK_REQUIRED';
type Send = (method: string, path: string, init?: Record<string, unknown>) => Promise<Response>;
interface Disclosed {
  readonly items: { businessId: string }[];
  readonly hiddenCount: number;
}
interface Preview {
  readonly ack: ({ ackToken: string } & Partial<Disclosed>) | null;
  readonly warnings: ({ reason: string } & Partial<Disclosed>)[];
}

/** 意向申请（HR 发起并提交）+ 员工本人发起的教育经历变更申请，都在审批中。 */
async function world(label: string) {
  const w = await intentionWorld(database().db, `f400r2-${label}-${uniqueSuffix()}`);
  await installExitSeeds(database().db, w.tenant.id);
  await installApprovalFallbacks(database().db, w.tenant.id, w.hr.id, ['leave', 'personnel_change']);
  const intention = await w.create({ intendedDate: '2030-03-01' });
  await w.act(intention.id, 'submit');
  const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
    ifMatch: 0,
    body: { value: { education: ['school'] } },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  const path = `/api/tenant/personnel/employees/${w.subject.employeeId}/subsets/education`;
  const record = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: { school: '甲校', educationLevel: '本科' } }),
    201,
  );
  const created = await w.request(w.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
    ifMatch: 0,
    body: {
      employeeId: w.subject.employeeId,
      subset: 'education',
      recordId: record.id,
      targetRevision: record.revision,
      values: { school: '乙校' },
    },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const request = (await created.json()) as { id: string };
  expect((await w.instance(intention.id)).status).toBe('running');
  expect((await w.instanceOf(request.id, w.subject.userId)).status).toBe('running');
  const hr: Send = (method, path, init = {}) => w.request(w.hr.id, method, `${EMPLOYMENT}${path}`, init);
  return { w, intention, request, hr };
}

/** 受限 HR：数据范围只含“本人创建的对象”（同 AC-EXIT-gate-support restricted）。 */
function restricted(w: IntentionWorld): Send {
  const authorize: Authorizer = () => true;
  const scope = {
    ...EMPTY_SCOPE,
    hasDataPermission: true,
    terms: [{ dimension: 'using_user' as const, orgIds: [], personIds: [], creatorId: w.hr.id }],
  };
  registerScopeProvider(authorize, {
    scope: async () => scope,
    authorize: async () => true,
    fields: async () => new Set(['id', 'employeeId', 'kind', 'effectiveDate', 'status', 'revision', 'lastWorkDate']),
  });
  const api = tenantApi(database().db, { authorize, clock: w.clock });
  return (method, path, init = {}) =>
    api.request(method, `${EMPLOYMENT}${path}`, { ...init, user: w.hr.id, tenant: w.tenant.id });
}

async function preview(send: Send, w: IntentionWorld, lastWorkDate: string) {
  const response = await send('POST', `/exits/employees/${w.subject.employeeId}/preview`, { body: { lastWorkDate } });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Preview;
}

const flowsWarning = (value: Preview) => value.warnings.find((item) => item.reason === 'EXIT_FLOWS_TO_TERMINATE');

async function createLeave(send: Send, w: IntentionWorld, lastWorkDate: string, ack?: string) {
  const exit = { exitTypeCode: 'voluntary', ...(ack ? { pendingTransferAck: ack } : {}) };
  return send('POST', `/employees/${w.subject.employeeId}/businesses`, {
    ifMatch: await w.revisionOf(),
    body: leaveBody(lastWorkDate, 'application', exit),
  });
}

async function ackRequired(response: Response) {
  expect(response.status, await response.clone().text()).toBe(409);
  const body = (await response.json()) as { error: { details: Record<string, unknown> } };
  return body.error.details as { reason: string; ackToken: string; flows?: Disclosed };
}

/** ④⑤ 只关心生效之后：令牌取自预览（③ 已校验令牌与 409 一致），没有确认清单时不带。 */
const previewAck = async (send: Send, w: IntentionWorld) => (await preview(send, w, '2026-10-05')).ack?.ackToken;

/** 保存（带令牌）→ 提交 → 审批通过 → 10-06 生效，返回生效时实际终止的业务单。 */
async function saveSubmitActivate(w: IntentionWorld, send: Send, ack: string | undefined) {
  const saved = await createLeave(send, w, '2026-10-05', ack);
  expect(saved.status, await saved.clone().text()).toBe(201);
  const draft = (await saved.json()) as { id: string; revision: number };
  const submitted = await send('POST', `/exits/${draft.id}/submit`, {
    ifMatch: draft.revision,
    body: { pendingTransferAck: ack },
  });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  const view = await w.instanceOf(draft.id);
  const task = w.pending(view)[0]!;
  const done = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {});
  expect(done.status, await done.clone().text()).toBe(200);
  expect(await exitActivator(database().db, { tenant: w.tenant, user: w.hr })(draft.id, '2026-10-06')).toMatchObject({
    outcome: 'effective',
  });
  const effects = await w.rows<{ target: string }>(sql`SELECT target_id::text AS target FROM exit_effects
    WHERE tenant_id=${w.tenant.id} AND business_id=${draft.id}::uuid AND target_type='approval-flow'`);
  return { leaveId: draft.id, terminated: effects.map((row) => row.target).sort() };
}

describe('F-400 r2 ③ 预览 / 确认令牌 / 生效执行同一候选集合', () => {
  it('勾选（预置）：预览列出两张申请；不带令牌创建 409 要求确认、令牌与预览一致；生效时终止的正是这两张', async () => {
    const { w, intention, request, hr } = await world('all');
    const expected = [intention.id, request.id].sort();
    const shown = await preview(hr, w, '2026-10-05');
    expect(flowsWarning(shown)).toMatchObject({ hiddenCount: 0 });
    expect(
      flowsWarning(shown)!
        .items!.map((item) => item.businessId)
        .sort(),
    ).toEqual(expected);
    expect(shown.ack?.ackToken).toBeTruthy();

    const required = await ackRequired(await createLeave(hr, w, '2026-10-05'));
    expect(required.reason).toBe(FLOW_ACK);
    expect(required.ackToken).toBe(shown.ack!.ackToken);
    expect(required.flows!.items.map((item) => item.businessId).sort()).toEqual(expected);

    const { terminated } = await saveSubmitActivate(w, hr, required.ackToken);
    expect(terminated).toEqual(expected);
    expect((await w.get(intention.id)).status).toBe('withdrawn');
  });

  it('未勾选教育经历：预览与令牌只含意向申请，生效时只终止意向申请，教育经历申请仍在审批中', async () => {
    const { w, intention, request, hr } = await world('unticked');
    await setExitTermination(database().db, w.tenant.id, w.hr.id, { education: false });
    const shown = await preview(hr, w, '2026-10-05');
    expect(flowsWarning(shown)).toMatchObject({ hiddenCount: 0 });
    expect(flowsWarning(shown)!.items!.map((item) => item.businessId)).toEqual([intention.id]);
    const required = await ackRequired(await createLeave(hr, w, '2026-10-05'));
    expect(required.ackToken).toBe(shown.ack!.ackToken);
    expect(required.flows!.items.map((item) => item.businessId)).toEqual([intention.id]);

    const { terminated } = await saveSubmitActivate(w, hr, required.ackToken);
    expect(terminated).toEqual([intention.id]);
    // 员工已离职、账号失效，按库读审批实例状态
    const [kept] = await w.rows<{ status: string }>(sql`SELECT status FROM approval_instances
      WHERE tenant_id=${w.tenant.id} AND business_id=${request.id}::uuid`);
    expect(kept?.status).toBe('running');
  });

  it('看不到的申请（员工本人发起）只计 hiddenCount、不露 ID；令牌与全量可见时一致，带令牌可提交并终止两张', async () => {
    const { w, intention, request, hr } = await world('hidden');
    const full = await preview(hr, w, '2026-10-05');
    const limited = restricted(w);
    const shown = await preview(limited, w, '2026-10-05');
    expect(JSON.stringify(shown)).not.toContain(request.id);
    expect(flowsWarning(shown)).toMatchObject({ hiddenCount: 1 });
    expect(flowsWarning(shown)!.items!.map((item) => item.businessId)).toEqual([intention.id]);
    expect(shown.ack!.ackToken).toBe(full.ack!.ackToken);

    const response = await createLeave(limited, w, '2026-10-05');
    expect(await response.clone().text()).not.toContain(request.id);
    const required = await ackRequired(response);
    expect(required.flows).toMatchObject({ hiddenCount: 1 });
    expect(required.ackToken).toBe(full.ack!.ackToken);

    const { terminated } = await saveSubmitActivate(w, limited, required.ackToken);
    expect(terminated).toEqual([intention.id, request.id].sort());
  });
});

describe('F-400 r2 ④ 终止的专项审计按业务对象登记，能经审计查询接口读到', () => {
  it('意向申请与员工子集申请的 employment.exit.flow_terminated_by_exit 都能被有权限的 HR 查到', async () => {
    const { w, intention, request, hr } = await world('audit');
    await saveSubmitActivate(w, hr, await previewAck(hr, w));
    const audit = auditApi(database().db, '2026-10-06T01:00:00Z');
    const as = { tenant: w.tenant.id, user: w.hr.id };
    for (const objectId of [intention.id, request.id]) {
      const [raw] = await w.rows<{ id: string }>(sql`SELECT id::text FROM audit_events WHERE tenant_id=${w.tenant.id}
        AND object_id=${objectId} AND action='employment.exit.flow_terminated_by_exit'`);
      expect(raw, objectId).toBeDefined();
      const page = await audit.dataChanges(as, { objectId, action: 'employment.exit.flow_terminated_by_exit' });
      expect(page.items.map((item) => item.id)).toContain(raw!.id);
      expect((await audit.get(`/data-changes/${raw!.id}`, as)).status).toBe(200);
    }
  });
});

describe('F-400 r2 ⑤ 撤销离职清单里被终止的流程按申请单查看权裁剪', () => {
  interface Cancelled {
    readonly downstream: { additional: { kind: string; targets: { id: string }[]; hiddenCount: number }[] };
  }
  async function cancel(send: Send, leaveId: string) {
    const current = (await (await send('GET', `/exits/${leaveId}`)).json()) as { revision: number };
    const response = await send('POST', `/exits/${leaveId}/cancel`, {
      ifMatch: current.revision,
      body: { reason: '录入有误' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as Cancelled;
    return body.downstream.additional.find((entry) => entry.kind === 'application_voided')!;
  }

  it('可见：有权限的 HR 看到两张被终止的申请', async () => {
    const { w, intention, request, hr } = await world('cancel-full');
    const { leaveId } = await saveSubmitActivate(w, hr, await previewAck(hr, w));
    const voided = await cancel(hr, leaveId);
    expect(voided.targets.map((target) => target.id).sort()).toEqual([intention.id, request.id].sort());
    expect(voided.hiddenCount).toBe(0);
  });

  it('不可见：受限 HR 看不到员工本人发起的申请，只计 hiddenCount、不露 ID', async () => {
    const { w, intention, request } = await world('cancel-hidden');
    const limited = restricted(w);
    const { leaveId } = await saveSubmitActivate(w, limited, await previewAck(limited, w));
    const voided = await cancel(limited, leaveId);
    expect(voided.targets.map((target) => target.id)).toEqual([intention.id]);
    expect(voided.hiddenCount).toBe(1);
    expect(JSON.stringify(voided)).not.toContain(request.id);
  });
});
