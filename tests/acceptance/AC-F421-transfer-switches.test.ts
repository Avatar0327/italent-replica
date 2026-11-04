/**
 * F-421 ②（F-430①，规格 30）：调动 / 机构间调动 / 批量调动 是三个独立的“离职生效时终止在途流程”开关。
 * 未勾选的那一类，计划日 ≤ 最后工作日 L 的在途申请保留；其余两类照旧终止。取消一类不影响另外两类。
 * 任职侧靠表单区分：机构间调入表单 → inter_org_transfer，批量调动表单 → batch_transfer，其余调动表单 → transfer。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';
import { setExitTermination } from './support/exit-termination.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const L = '2026-10-05';
const PLANNED = '2026-10-03';
const INTER_ORG = 'TenantBase.InterOrgTransferMultiFormView';
const INTER_ORG_STORE = 'TenantBase.IndustryOrgApplyForTransferFormView';
const BATCH = 'TenantBase.BatchTransferMultiFormView';

async function inFlight(x: DownstreamWorld, formId?: string) {
  return x.synthetic(x.employee.id, {
    kind: 'transfer',
    state: 'in_review',
    effectiveDate: PLANNED,
    ...(formId ? { formId } : {}),
  });
}

/** 三类各一条在途申请（计划日都 ≤ L）。 */
async function threeKinds(x: DownstreamWorld) {
  return { plain: await inFlight(x), interOrg: await inFlight(x, INTER_ORG), batch: await inFlight(x, BATCH) };
}

/** 有确认清单时先取令牌再带回（§8）；返回离职单与确认清单里的业务 ID（没有确认清单则为空）。 */
async function leaveWithAck(x: DownstreamWorld) {
  const first = await x.atDay(L, () => x.createLeave(x.employee.id, leaveBody(L, 'direct')));
  if (first.status === 201) return { leave: (await first.json()) as { id: string }, ack: [] as string[] };
  const refused = await x.reason(first);
  expect(refused).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
  const leave = await x.directLeave(L, { pendingTransferAck: refused.ackToken });
  return { leave, ack: (refused.items ?? []).map((item) => item.businessId) };
}

const untick = (x: DownstreamWorld, ...flows: string[]) =>
  setExitTermination(
    database().db,
    x.session.tenant.id,
    x.session.user.id,
    Object.fromEntries(flows.map((flow) => [flow, false])),
  );

async function states(x: DownstreamWorld, ids: Record<string, string>) {
  return Object.fromEntries(
    await Promise.all(Object.entries(ids).map(async ([name, id]) => [name, await x.stateOfBusiness(id)])),
  );
}

describe('F-421 ② 三类调动开关各自独立', () => {
  it('预置全勾：三类都终止', async () => {
    const x = await downstreamWorld(database().db, 'f421-all-on', TODAY);
    const ids = await threeKinds(x);
    const { leave } = await leaveWithAck(x);
    await x.activate(leave.id, TODAY);
    expect(await states(x, ids)).toEqual({ plain: 'voided', interOrg: 'voided', batch: 'voided' });
  });

  it('只取消“机构间调动”：机构间保留，调动与批量调动照旧终止；确认清单不含机构间', async () => {
    const x = await downstreamWorld(database().db, 'f421-inter-org-off', TODAY);
    await untick(x, 'inter_org_transfer');
    const ids = await threeKinds(x);
    const { leave, ack } = await leaveWithAck(x);
    expect(ack.sort()).toEqual([ids.plain, ids.batch].sort());
    await x.activate(leave.id, TODAY);
    expect(await states(x, ids)).toEqual({ plain: 'voided', interOrg: 'in_review', batch: 'voided' });
  });

  it('只取消“调动”：普通调动保留，机构间与批量照旧终止（机构间门店表单同属机构间）', async () => {
    const x = await downstreamWorld(database().db, 'f421-transfer-off', TODAY);
    await untick(x, 'transfer');
    const ids = { ...(await threeKinds(x)), interOrgStore: await inFlight(x, INTER_ORG_STORE) };
    const { leave } = await leaveWithAck(x);
    await x.activate(leave.id, TODAY);
    expect(await states(x, ids)).toEqual({
      plain: 'in_review',
      interOrg: 'voided',
      batch: 'voided',
      interOrgStore: 'voided',
    });
  });

  it('只取消“批量调动”：批量保留，其余两类照旧终止', async () => {
    const x = await downstreamWorld(database().db, 'f421-batch-off', TODAY);
    await untick(x, 'batch_transfer');
    const ids = await threeKinds(x);
    const { leave } = await leaveWithAck(x);
    await x.activate(leave.id, TODAY);
    expect(await states(x, ids)).toEqual({ plain: 'voided', interOrg: 'voided', batch: 'in_review' });
  });

  it('三类全取消：计划日 ≤ L 全保留，没有确认清单', async () => {
    const x = await downstreamWorld(database().db, 'f421-all-off', TODAY);
    await untick(x, 'transfer', 'inter_org_transfer', 'batch_transfer');
    const ids = await threeKinds(x);
    const leave = await x.directLeave(L);
    await x.activate(leave.id, TODAY);
    expect(await states(x, ids)).toEqual({ plain: 'in_review', interOrg: 'in_review', batch: 'in_review' });
  });
});
