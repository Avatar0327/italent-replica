/**
 * R2-T03 B3-3 / AC-DM-27（计数）：组织停用校验的离职计数（设计 §6A.1，DEC-275②）。
 * 审批通过未生效的离职，同周期在职记录从生效日 E 起不计入占用（D ≥ E 不计、D < E 照计）；审批中 / 草稿 / 已驳回照常计入；
 * 作废的离职不影响计数；计数单位改为任职记录条数（不再按员工去重）；离职只影响同一任职周期。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-06';

async function world(label: string) {
  const x = await downstreamWorld(database().db, label, TODAY);
  const api = tenantApi(x.db, { clock: () => new Date(`${TODAY}T01:00:00Z`) });
  /** 调出部门（员工所在）自 effectiveDate 起停用。 */
  const disable = (effectiveDate: string) =>
    api.request('PATCH', `/api/tenant/org/organizations/${x.from.id}`, {
      tenant: x.session.tenant.id,
      user: x.session.user.id,
      ifMatch: x.from.revision,
      body: { enabled: false, effectiveDate },
    });
  return { ...x, disable };
}

/** 409 ORG_SUBTREE_NOT_EMPTY，文案里的任职记录条数。 */
async function blockedWith(response: Response, count: number) {
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      message: `当前组织或下级组织中存在待入职或在职员工任职记录${count}条，不能被停用`,
      details: { reason: 'ORG_SUBTREE_NOT_EMPTY' },
    },
  });
}

describe('AC-DM-27 B-61 审批通过未生效的离职：从 E 起不计入占用', () => {
  it('对照：没有离职时员工计入（任职记录 1 条）', async () => {
    const x = await world('count-base');
    await blockedWith(await x.disable('2026-10-20'), 1);
  });

  it('D ≥ E 不计、可停用；D < E 照常计入', async () => {
    const x = await world('count-approved');
    const leave = await x.directLeave('2026-10-14');
    expect(leave.status).toBe('approved');
    // 停用日 10-10 早于 E = 10-15：员工到 L 才离开，停用后仍在职，照常计入
    await blockedWith(await x.disable('2026-10-10'), 1);
    // 停用日 10-15 = E、之后任何日期：离职后不再占用
    const allowed = await x.disable('2026-10-15');
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });

  it('申请离职：审批中照常计入；审批通过后 D ≥ E 不计', async () => {
    const x = await world('count-application');
    const draft = await x.submittedLeave('2026-10-14');
    await blockedWith(await x.disable('2026-10-20'), 1);
    await x.approve(draft, `${TODAY}T02:00:00Z`);
    expect((await x.disable('2026-10-20')).status).toBe(200);
  });

  it('草稿 / 已驳回的离职照常计入；作废（撤销审批中）的离职不影响计数', async () => {
    const x = await world('count-states');
    const draft = await x.createdLeave(x.employee.id, leaveBody('2026-10-14', 'application'));
    await blockedWith(await x.disable('2026-10-20'), 1);
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const revoked = await x.session.request('POST', `/exits/${draft.id}/cancel`, {
      ifMatch: (await x.business(draft.id)).revision,
      body: { reason: '撤销审批中的离职' },
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(draft.id)).toBe('voided');
    await blockedWith(await x.disable('2026-10-20'), 1);
  });
});

describe('AC-DM-27 B-61 计数单位改为任职记录条数，离职只影响同一任职周期', () => {
  it('同员工同组织两条主职记录（组织内岗位调整后）按 2 条计；审批通过的离职在 E 之后把两条都排除', async () => {
    const x = await world('count-records');
    const employee = await x.session.getEmployee(x.employee.id);
    const adjusted = await x.session.business(
      x.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-15', fields: { place: '新地点' } },
      employee.revision,
    );
    expect(adjusted.status).toBe('effective');
    await blockedWith(await x.disable('2026-10-10'), 2);
    // D = 10-16 之后只剩第二条记录
    await blockedWith(await x.disable('2026-10-16'), 1);
    await x.createdLeave(x.employee.id, leaveBody('2026-10-19', 'direct'));
    expect((await x.disable('2026-10-20')).status).toBe(200);
  });

  it('跨周期：旧周期已生效的离职不影响重聘后新周期的记录，新周期照常计入', async () => {
    const x = await world('count-cycles');
    const leave = await x.directLeave('2026-10-10');
    expect(await x.runScheduler('2026-10-12T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    const employee = await x.session.getEmployee(x.employee.id);
    await x.session.business(
      employee.id,
      { kind: 'rehire', mode: 'direct', effectiveDate: '2026-11-01', fields: { departmentId: x.from.id } },
      employee.revision,
    );
    await blockedWith(await x.disable('2026-11-05'), 1);
  });
});
