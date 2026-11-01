/**
 * F-400（DEC-725，返工 B3）：离职生效时按“终止在途流程”配置（规格 30 SwitchTypes=41）处理在途流程。
 * ① 按流程类型配置终止：勾选的终止全部，未勾选的任职类只终止计划日晚于最后工作日 L 的、合同类只终止终止日期晚于 L 的；
 *    本租户预置勾选 27 类，只有“新建合同协议”不勾。
 * ② 劳务转正式 / 实习转正：已勾选不拦离职、生效时终止；未勾选时计划日 ≤ L 的审批中转正才拦（409）。
 * ③ 晚于 L、已落地的未来调动在离职生效时作废（任职显示“作废”，DEC-520②），写审计、发通知。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { EXIT_TERMINATION_PRESET } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';
import { EXIT_TERMINATION_KEY, setExitTermination } from './support/exit-termination.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const L = '2026-10-05';
const world = (label: string) => downstreamWorld(database().db, label, TODAY);

/** 按“申请”模式提交一条新建合同协议申请（in_review，有审批实例）。 */
async function createRequest(x: DownstreamWorld, extra: Record<string, unknown>) {
  const typeId = await x.contractType(`类型-${Object.values(extra).join('-')}`);
  return (await x.createContract(typeId, extra, 'application')).id;
}

const configure = (x: DownstreamWorld, changes: Record<string, boolean>) =>
  setExitTermination(database().db, x.session.tenant.id, x.session.user.id, changes);

describe('F-400 ① 按流程类型配置终止在途流程', () => {
  it('配置读取：预置勾选 27 类，只有新建合同协议（contract_create）不勾', async () => {
    const x = await world('f400-preset');
    const response = await x.api.request('GET', `/api/tenant/settings/${EXIT_TERMINATION_KEY}`, {
      tenant: x.session.tenant.id,
      user: x.session.user.id,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { value, source } = (await response.json()) as { value: Record<string, boolean>; source: string };
    expect(source).toBe('system');
    expect(Object.keys(value)).toHaveLength(28);
    expect(Object.entries(value).filter(([, on]) => !on)).toEqual([['contract_create', false]]);
    // 迁移 0180 的系统值与领域预置逐键一致
    expect(value).toEqual(EXIT_TERMINATION_PRESET);
  });

  it('预置：勾选的转正（计划日早于 L）作废；未勾选的新建合同协议只撤回终止日期晚于 L 的，早于 L 的保留', async () => {
    const x = await world('f400-default');
    const regularization = await x.synthetic(x.employee.id, {
      kind: 'regularization',
      state: 'in_review',
      effectiveDate: '2026-10-03',
    });
    const later = await createRequest(x, { effectiveDate: '2026-10-10', endDate: '2027-10-09' });
    const earlier = await createRequest(x, { effectiveDate: '2026-01-01', endDate: '2026-09-30' });
    const leave = await x.directLeave(L);
    const kept = (await x.instanceOf(earlier))!;

    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });

    expect(await x.stateOfBusiness(regularization)).toBe('voided');
    const requests = new Map((await x.requestRows()).map((row) => [row.id, row.status]));
    expect(requests.get(later)).toBe('withdrawn');
    expect(requests.get(earlier)).toBe('in_review');
    expect(await x.instanceOf(earlier)).toEqual(kept);
    expect(
      (await x.effects(leave.id)).filter((row) => row.kind === 'contract_request_withdrawn').map((r) => r.target_id),
    ).toEqual([later]);
  });

  it('改配置：取消勾选转正 → 计划日 ≤ L 的转正保留、晚于 L 的作废；勾选新建合同协议 → 不论终止日期一律撤回', async () => {
    const x = await world('f400-custom');
    await configure(x, { regularization: false, contract_create: true });
    const early = await x.synthetic(x.employee.id, {
      kind: 'regularization',
      state: 'in_review',
      effectiveDate: '2026-10-03',
    });
    const late = await x.synthetic(x.employee.id, {
      kind: 'regularization',
      state: 'in_review',
      effectiveDate: '2026-10-20',
    });
    const earlier = await createRequest(x, { effectiveDate: '2026-01-01', endDate: '2026-09-30' });
    const leave = await x.directLeave(L);

    await x.activate(leave.id, TODAY);

    expect(await x.stateOfBusiness(early)).toBe('in_review');
    expect(await x.stateOfBusiness(late)).toBe('voided');
    expect((await x.requestRows()).find((row) => row.id === earlier)!.status).toBe('withdrawn');
    expect(
      (await x.effects(leave.id)).filter((row) => row.kind === 'application_voided').map((row) => row.target_id),
    ).toEqual([late]);
  });
});

describe('F-400 ② 劳务转正式 / 实习转正与配置共用', () => {
  const internRegularization = (x: DownstreamWorld) =>
    x.synthetic(x.employee.id, { kind: 'intern_regularization', state: 'in_review', effectiveDate: '2026-10-03' });

  it('已勾选（预置）：计划日 ≤ L 的审批中实习转正不拦离职，生效时作废并写审计', async () => {
    const x = await world('f400-intern-on');
    const regularization = await internRegularization(x);
    const leave = await x.directLeave(L);

    await x.activate(leave.id, TODAY);

    expect(await x.stateOfBusiness(regularization)).toBe('voided');
    expect((await x.audits(regularization, 'employment.business.voided_by_exit'))[0]!.after).toMatchObject({
      exitBusinessId: leave.id,
      kind: 'intern_regularization',
    });
  });

  it('未勾选：同样的在途实习转正 → 创建离职 409 EXIT_REGULARIZATION_IN_FLIGHT', async () => {
    const x = await world('f400-intern-off');
    await configure(x, { intern_regularization: false });
    const regularization = await internRegularization(x);
    const refused = await x.reason(await x.createLeave(x.employee.id, leaveBody(L, 'direct')));
    expect(refused).toMatchObject({ status: 409, reason: 'EXIT_REGULARIZATION_IN_FLIGHT' });
    expect(refused.items).toEqual([{ businessId: regularization, effectiveDate: '2026-10-03' }]);
  });
});

describe('F-400 ③ 晚于最后工作日、已落地的未来调动', () => {
  async function landedTransfer(x: DownstreamWorld, effectiveDate: string) {
    const { revision } = await x.session.getEmployee(x.employee.id);
    const transfer = await x.session.business(
      x.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId: x.to.id } },
      revision,
    );
    expect(transfer.status).toBe('effective');
    return transfer;
  }

  it('离职生效时作废：业务显示“作废”、离开时间轴，台账记需重新发起，写审计与通知 outbox', async () => {
    const x = await world('f400-future');
    const transfer = await landedTransfer(x, '2026-10-20');
    const leave = await x.directLeave(L);

    await x.activate(leave.id, TODAY);

    expect(await x.stateOfBusiness(transfer.id)).toBe('voided');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'leave']);
    const effects = (await x.effects(leave.id)).filter((row) => row.target_id === transfer.id);
    expect(effects.map((row) => row.kind).sort()).toEqual(['application_voided', 'future_transfer_detached']);
    const audits = await x.audits(transfer.id, 'employment.transfer.voided_by_exit');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ exitBusinessId: leave.id, kind: 'transfer', stateBefore: 'effective' });
    expect(await x.outboxCount(transfer.id, 'employment.transfer.voided_by_exit')).toBe(1);
  });

  it('撤销离职后被作废的调动不再挂回时间轴', async () => {
    const x = await world('f400-future-cancel');
    const transfer = await landedTransfer(x, '2026-10-20');
    const leave = await x.directLeave(L);
    await x.activate(leave.id, TODAY);
    const cancelled = await x.session.request('POST', `/exits/${leave.id}/cancel`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { reason: '合成撤销原因' },
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(transfer.id)).toBe('voided');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
  });
});
