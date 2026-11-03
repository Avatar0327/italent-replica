/**
 * F-400（DEC-725）：任职、合同以外的在途流程也按“离职生效时终止在途流程”配置处理（规格 30 SwitchTypes=41）。
 * 以意向退休日期申请（个人信息类，勾选才终止）为代表：勾选时离职生效终止审批实例（已终止）、申请撤回，
 * 写审计并给发起人与申请人发站内消息；未勾选时保留。另有一条端到端：申请离职 → 审批通过 → 生效 → 在途流程被终止。
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

async function world(label: string) {
  const w = await intentionWorld(database().db, `f400-${label}-${uniqueSuffix()}`);
  await installExitSeeds(database().db, w.tenant.id);
  await installApprovalFallbacks(database().db, w.tenant.id, w.hr.id, ['leave']);
  const draft = await w.create({ intendedDate: '2030-03-01' });
  await w.act(draft.id, 'submit');
  const instance = await w.instance(draft.id);
  expect(instance.status).toBe('running');
  return { w, intention: draft, instance };
}

/** 有勾选终止的在途流程时先 409 要求确认（§8，F-400 第 2 轮），带回令牌再建；返回业务与令牌（提交时再带）。 */
async function createLeave(w: IntentionWorld, lastWorkDate: string, mode: 'direct' | 'application') {
  const send = async (ack?: string) => {
    const exit = {
      ...(mode === 'application' ? { exitTypeCode: 'voluntary' } : {}),
      ...(ack ? { pendingTransferAck: ack } : {}),
    };
    return w.request(w.hr.id, 'POST', `${EMPLOYMENT}/employees/${w.subject.employeeId}/businesses`, {
      ifMatch: await w.revisionOf(),
      body: leaveBody(lastWorkDate, mode, Object.keys(exit).length ? exit : undefined),
    });
  };
  let response = await send();
  let ack: string | undefined;
  if (response.status === 409) {
    ack = ((await response.json()) as { error: { details: { ackToken: string } } }).error.details.ackToken;
    response = await send(ack);
  }
  expect(response.status, await response.clone().text()).toBe(201);
  return { ...((await response.json()) as { id: string; revision: number; status: string }), ack };
}

const audits = (w: IntentionWorld, objectId: string) =>
  w.rows<{ action: string; after: Record<string, unknown> | null }>(sql`SELECT action, after FROM audit_events
    WHERE tenant_id=${w.tenant.id} AND object_id=${objectId} AND action LIKE '%terminated_by_exit'`);
const notices = (w: IntentionWorld, instanceId: string) =>
  w.rows<{ recipient: string; template: string }>(sql`
    SELECT recipient_user_id AS recipient, template_code AS template FROM approval_notifications
    WHERE tenant_id=${w.tenant.id} AND instance_id=${instanceId}::uuid AND kind='message'
      AND template_code LIKE '%_by_exit'`);

describe('F-400 ① 个人信息类在途流程（意向退休日期申请）', () => {
  it('勾选（预置）：直接离职当场生效，终止意向申请的审批实例、申请撤回，写审计一条、发起人与申请人收到站内消息', async () => {
    const { w, intention, instance } = await world('on');
    const leave = await createLeave(w, '2026-09-30', 'direct');
    expect(leave.status).toBe('effective');

    expect((await w.instance(intention.id)).status).toBe('cancelled');
    expect((await w.get(intention.id)).status).toBe('withdrawn');
    const rows = await audits(w, intention.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ exitBusinessId: leave.id, flowType: 'retirement_intention' });
    // 沿用离职作废通道：发起人与申请人各一条（同 exit-void-applications.ts）
    const sent = (await notices(w, instance.id)).map((n) => `${n.recipient}:${n.template}`).sort();
    expect(sent).toEqual([w.hr.id, w.subject.userId].map((u) => `${u}:flow_terminated_by_exit`).sort());
  });

  it('未勾选：离职生效后意向申请仍在审批中', async () => {
    const { w, intention } = await world('off');
    await setExitTermination(database().db, w.tenant.id, w.hr.id, { retirement_intention: false });
    const leave = await createLeave(w, '2026-09-30', 'direct');
    expect(leave.status).toBe('effective');
    expect((await w.instance(intention.id)).status).toBe('running');
    expect((await w.get(intention.id)).status).toBe('in_review');
    expect(await audits(w, intention.id)).toEqual([]);
  });

  it('端到端：申请离职 → 审批通过 → 到生效日生效 → 在途意向申请被终止', async () => {
    const { w, intention } = await world('e2e');
    const draft = await createLeave(w, '2026-10-05', 'application');
    const submitted = await w.request(w.hr.id, 'POST', `${EMPLOYMENT}/exits/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: draft.ack ? { pendingTransferAck: draft.ack } : {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const view = await w.instanceOf(draft.id);
    const task = w.pending(view)[0]!;
    const done = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {});
    expect(done.status, await done.clone().text()).toBe(200);
    expect((await w.business(draft.id)).status).toBe('approved');
    expect((await w.instance(intention.id)).status).toBe('running');

    const activate = exitActivator(database().db, { tenant: w.tenant, user: w.hr });
    expect(await activate(draft.id, '2026-10-06')).toMatchObject({ outcome: 'effective' });

    expect((await w.instance(intention.id)).status).toBe('cancelled');
    expect((await w.get(intention.id)).status).toBe('withdrawn');
    expect(await audits(w, intention.id)).toHaveLength(1);
  });
});
