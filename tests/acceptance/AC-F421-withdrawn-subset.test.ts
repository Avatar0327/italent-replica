/**
 * F-421 ①（DEC-740）：勾选了个人信息类流程的租户，已撤回的员工子集变更申请与驳回待重提的一样是离职终止候选。
 * 预览、§8 确认令牌、生效执行共用 exit-flow-candidates 这一个入口；终止后申请不可再重提；未勾选则一律不终止。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { intentionWorld, type IntentionWorld } from './AC-RT-intention-support.js';
import { setExitTermination } from './support/exit-termination.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const EMPLOYMENT = '/api/tenant/employment';
const APPROVAL = '/api/tenant/approval';
const FLOW_ACK = 'EXIT_FLOW_TERMINATION_ACK_REQUIRED';

/** 员工本人发起的教育经历变更申请，已由本人撤回（实例 withdrawn、业务单 withdrawn）。 */
async function world(label: string) {
  const w = await intentionWorld(database().db, `f421-${label}-${uniqueSuffix()}`);
  await installExitSeeds(database().db, w.tenant.id);
  await installApprovalFallbacks(database().db, w.tenant.id, w.hr.id, ['leave', 'personnel_change']);
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
  const running = await w.instanceOf(request.id, w.subject.userId);
  const withdrawn = await w.request(w.subject.userId, 'POST', `${APPROVAL}/instances/${running.id}/withdraw`, {
    ifMatch: running.revision,
  });
  expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
  expect(await instanceStatus(w, request.id)).toBe('withdrawn');
  return { w, request, instanceId: running.id };
}

const instanceStatus = async (w: IntentionWorld, requestId: string) =>
  (
    await w.rows<{ status: string }>(sql`SELECT status FROM approval_instances
      WHERE tenant_id=${w.tenant.id} AND business_id=${requestId}::uuid`)
  )[0]?.status;

const requestStatus = async (w: IntentionWorld, requestId: string) =>
  (
    await w.rows<{ status: string }>(sql`SELECT status FROM personnel_change_requests
      WHERE tenant_id=${w.tenant.id} AND id=${requestId}::uuid`)
  )[0]?.status;

const hr = (w: IntentionWorld, method: string, path: string, init: Record<string, unknown> = {}) =>
  w.request(w.hr.id, method, `${EMPLOYMENT}${path}`, init);

async function preview(w: IntentionWorld) {
  const response = await hr(w, 'POST', `/exits/employees/${w.subject.employeeId}/preview`, {
    body: { lastWorkDate: '2026-10-05' },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as {
    ack: { ackToken: string } | null;
    warnings: { reason: string; items?: { businessId: string }[]; hiddenCount?: number }[];
  };
}

const createLeave = async (w: IntentionWorld, ack?: string) =>
  hr(w, 'POST', `/employees/${w.subject.employeeId}/businesses`, {
    ifMatch: await w.revisionOf(),
    body: leaveBody('2026-10-05', 'application', {
      exitTypeCode: 'voluntary',
      ...(ack ? { pendingTransferAck: ack } : {}),
    }),
  });

/** 保存（带令牌）→ 提交 → 审批通过 → 10-06 生效。 */
async function saveSubmitActivate(w: IntentionWorld, ack: string | undefined) {
  const saved = await createLeave(w, ack);
  expect(saved.status, await saved.clone().text()).toBe(201);
  const draft = (await saved.json()) as { id: string; revision: number };
  const submitted = await hr(w, 'POST', `/exits/${draft.id}/submit`, {
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
  return draft.id;
}

describe('F-421 ① 已撤回的员工子集变更申请是离职终止候选', () => {
  it('勾选（预置）：预览列出、不带令牌 409 要求确认且令牌一致、生效时终止并不可再重提', async () => {
    const { w, request, instanceId } = await world('on');
    const shown = await preview(w);
    const flows = shown.warnings.find((item) => item.reason === 'EXIT_FLOWS_TO_TERMINATE');
    expect(flows?.items?.map((item) => item.businessId)).toEqual([request.id]);
    expect(shown.ack?.ackToken).toBeTruthy();

    const refused = await createLeave(w);
    expect(refused.status, await refused.clone().text()).toBe(409);
    const details = ((await refused.json()) as { error: { details: { reason: string; ackToken: string } } }).error
      .details;
    expect(details).toMatchObject({ reason: FLOW_ACK, ackToken: shown.ack!.ackToken });

    await saveSubmitActivate(w, details.ackToken);

    const effects = await w.rows<{ target: string }>(sql`SELECT target_id::text AS target FROM exit_effects
      WHERE tenant_id=${w.tenant.id} AND target_type='approval-flow'`);
    expect(effects.map((row) => row.target)).toEqual([request.id]);
    // 终止后实例不再是“已撤回待重提”：审批侧重提被拒，业务单仍是已撤回
    expect(await instanceStatus(w, request.id)).toBe('cancelled');
    expect(await requestStatus(w, request.id)).toBe('withdrawn');
    const log = await w.rows<{ event: string }>(sql`SELECT event FROM approval_logs
      WHERE tenant_id=${w.tenant.id} AND instance_id=${instanceId}::uuid ORDER BY created_at, id`);
    expect(log.map((row) => row.event)).toContain('system_revoke');
    const resubmit = await w.request(w.subject.userId, 'POST', `${APPROVAL}/instances/${instanceId}/resubmit`);
    expect(resubmit.status, await resubmit.clone().text()).toBe(409);
  });

  it('未勾选教育经历：预览与令牌都不含已撤回的申请，生效后实例仍是已撤回、可重提', async () => {
    const { w, request } = await world('off');
    await setExitTermination(database().db, w.tenant.id, w.hr.id, { education: false });
    const shown = await preview(w);
    expect(shown.ack).toBeNull();
    expect(shown.warnings.find((item) => item.reason === 'EXIT_FLOWS_TO_TERMINATE')).toBeUndefined();

    await saveSubmitActivate(w, undefined);

    const effects = await w.rows<{ target: string }>(sql`SELECT target_id::text AS target FROM exit_effects
      WHERE tenant_id=${w.tenant.id} AND target_type='approval-flow'`);
    expect(effects).toEqual([]);
    expect(await instanceStatus(w, request.id)).toBe('withdrawn');
    expect(await requestStatus(w, request.id)).toBe('withdrawn');
  });
});
