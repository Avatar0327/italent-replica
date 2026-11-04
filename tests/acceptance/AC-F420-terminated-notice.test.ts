/**
 * F-420（F-400 R1 / 复审后补）：在途流程被离职终止后，收件人在站内消息里看到的是说明性文案，而不是一个模板码。
 * 申请人与发起人各收到一条 flow_terminated_by_exit：标题说明“因员工离职生效，流程已终止”，正文带流程名称、员工、离职生效日，
 * 没有未替换的占位符；消息列表带业务引用（P3-5），收件人能据此回到被终止的业务单。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { intentionWorld } from './AC-RT-intention-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const EMPLOYMENT = '/api/tenant/employment';
const NOTIFICATIONS = '/api/tenant/approval/notifications';

interface Inbox {
  readonly items: {
    template: string | null;
    title?: string | null;
    body?: string | null;
    instanceId: string | null;
    businessType?: string | null;
    businessId?: string | null;
  }[];
}

async function terminatedWorld() {
  const w = await intentionWorld(database().db, `f420-${uniqueSuffix()}`);
  await installExitSeeds(database().db, w.tenant.id);
  await installApprovalFallbacks(database().db, w.tenant.id, w.hr.id, ['leave']);
  const intention = await w.create({ intendedDate: '2030-03-01' });
  await w.act(intention.id, 'submit');
  const instance = await w.instance(intention.id);
  const [{ title }] = await w
    .rows<{ title: string }>(
      sql`SELECT title FROM approval_instances
    WHERE tenant_id=${w.tenant.id} AND id=${instance.id}::uuid`,
    )
    .then((rows) => rows as [{ title: string }]);
  // 直接办理的离职当场生效；有在途流程时先 409 要求确认（F-400 §8），带回令牌再建
  const send = async (ack?: string) =>
    w.request(w.hr.id, 'POST', `${EMPLOYMENT}/employees/${w.subject.employeeId}/businesses`, {
      ifMatch: await w.revisionOf(),
      body: leaveBody('2026-09-30', 'direct', ack ? { pendingTransferAck: ack } : undefined),
    });
  let response = await send();
  if (response.status === 409) {
    const ack = ((await response.json()) as { error: { details: { ackToken: string } } }).error.details.ackToken;
    response = await send(ack);
  }
  expect(response.status, await response.clone().text()).toBe(201);
  const leave = (await response.json()) as { id: string; status: string };
  expect(leave.status).toBe('effective');
  return { w, intention, flowName: title, leave };
}

describe('F-420 流程被离职终止的站内消息', () => {
  it('发起人读到说明性标题与正文：带流程名称、员工、离职生效日，无占位符', async () => {
    const { w, intention, flowName, leave } = await terminatedWorld();
    const [version] = await w.rows<{ effective: string }>(sql`SELECT effective_date::text AS effective
      FROM employment_payload_versions WHERE tenant_id=${w.tenant.id} AND business_id=${leave.id}::uuid
      ORDER BY version_no DESC LIMIT 1`);

    // 申请人的账号随离职生效停用（读不了收件箱）；他那条与发起人同一模板同一渲染，AC-F400 已核对发出
    const inbox = (await (await w.request(w.hr.id, 'GET', NOTIFICATIONS)).json()) as Inbox;
    const notice = inbox.items.find((item) => item.template === 'flow_terminated_by_exit');
    expect(notice, '发起人应收到被离职终止的消息').toBeDefined();
    expect(notice!.title).toBe('因员工离职生效，流程已终止');
    expect(notice!.body).toContain(flowName);
    expect(notice!.body).toContain(w.subject.name);
    expect(notice!.body).toContain(version!.effective);
    expect(notice!.body).not.toMatch(/[{}]/);
    expect(notice!.businessId).toBe(intention.id);
  });
});
