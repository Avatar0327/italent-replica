/**
 * R2-T04 BE-5a / AC-RT-04、06、07、08、22①③：退休办理入口（设计 §1.2、§3.1、§3.2、§3.5）。
 * 通用入口 POST employees/:id/businesses kind=retirement 与专用入口 POST retirements/employees/:id 是同一个申请服务、
 * 同一个门禁（权限链 → 前置条件），写 exit_requests + retirement_requests；退休按钮独立（Employment.Retire*），
 * 不复用 Dimission*；退休与离职互斥；退休类型由 L 与创建时快照的 P 派生。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as RetirementApplication from '../../apps/api/src/modules/employment/retirement-application.js';
import { denyButtons, leaveBody } from './AC-EXIT-gate-support.js';
import { dedicatedBody, retireBody, retirementWorld } from './AC-RT-support.js';

const injected = vi.hoisted(() => ({ failExtension: false }));
vi.mock('../../apps/api/src/modules/employment/retirement-application.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RetirementApplication>();
  return {
    ...actual,
    writeRetirementExtension: (...args: Parameters<typeof actual.writeRetirementExtension>) => {
      if (injected.failExtension) throw new Error('注入：扩展行写入失败');
      return actual.writeRetirementExtension(...args);
    },
  };
});

const database = useTestDb();
const TODAY = '2026-10-06';
const LATER = '2026-10-20';
const world = (label: string) => retirementWorld(database().db, label, TODAY);

describe('AC-RT-04 通用入口 kind=retirement：经门禁与申请服务', () => {
  it('申请：201 draft，写 exit_requests（HR 发起）+ retirement_requests（P 快照、类型派生），审计 retirement.request.create', async () => {
    const x = await world('rt04-create');
    await x.setExpectedRetirement('2030-06-01');
    const created = await x.createdRetire(x.employee.id, retireBody(LATER));
    expect(created.status).toBe('draft');
    expect(await x.exitRow(created.id)).toMatchObject({ mode: 'application', initiator: 'hr', exit_type_code: null });
    expect(await x.retirementRow(created.id)).toMatchObject({
      employee_id: x.employee.id,
      expected_retirement_date: '2030-06-01',
      retire_type: 'early',
      re_employed: false,
    });
    const audits = await x.audits(created.id, 'retirement.request.create');
    expect(audits).toHaveLength(1);
    expect(await x.audits(created.id, 'exit.request.create')).toEqual([]);
  });

  it('按钮：申请要 Employment.RetireApproval、直接要 Employment.Retire，有 Dimission* 也不行；没有 Dimission* 照样能办退休', async () => {
    const x = await world('rt04-buttons');
    const before = await x.stateOf(x.employee.id);
    const create = async (api: ReturnType<typeof x.restricted>, mode: 'application' | 'direct') => {
      const { revision } = await x.session.getEmployee(x.employee.id);
      const body = retireBody(LATER, mode);
      return api('POST', `/employees/${x.employee.id}/businesses`, { ifMatch: revision, body });
    };
    expect((await create(x.restricted(denyButtons('Employment.RetireApproval')), 'application')).status).toBe(403);
    expect((await create(x.restricted(denyButtons('Employment.Retire')), 'direct')).status).toBe(403);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    const noDimission = x.restricted(
      denyButtons(
        'Employment.Dimission',
        'Employment.DimissionApproval',
        'Employment.DimissionEdit',
        'Employment.DimissionCancel',
      ),
    );
    expect((await create(noDimission, 'application')).status).toBe(201);
  });

  it('离职专用字段：400 RETIREMENT_FIELD_NOT_ALLOWED，无任何写入；交接人 / 加黑允许', async () => {
    const x = await world('rt04-fields');
    const before = await x.stateOf(x.employee.id);
    for (const exit of [
      { exitTypeCode: 'voluntary' },
      { reasonCode: 'personal' },
      { whereaboutsCode: 'startup' },
      { compensationAmount: 100 },
      { actualLeaveDate: '2026-10-01' },
    ]) {
      const response = await x.createRetire(x.employee.id, retireBody(LATER, 'application', exit));
      expect(await x.reason(response)).toMatchObject({
        status: 400,
        reason: 'RETIREMENT_FIELD_NOT_ALLOWED',
      });
    }
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    const colleague = await x.session.employee('交接人');
    const created = await x.createdRetire(
      x.employee.id,
      retireBody(LATER, 'application', { handoverEmployeeId: colleague.id, addToBlacklist: false }),
    );
    expect(await x.exitRow(created.id)).toMatchObject({ handover_employee_id: colleague.id, add_to_blacklist: false });
  });

  it('专用入口 POST retirements/employees/:id：同一服务，不接受 kind', async () => {
    const x = await world('rt04-dedicated');
    const { revision } = await x.session.getEmployee(x.employee.id);
    const created = await x.session.request('POST', `/retirements/employees/${x.employee.id}`, {
      ifMatch: revision,
      body: dedicatedBody(LATER),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const business = (await created.json()) as { id: string; status: string };
    expect(business.status).toBe('draft');
    expect(await x.retirementRow(business.id)).toMatchObject({ employee_id: x.employee.id });
    const withKind = await x.session.request('POST', `/retirements/employees/${x.employee.id}`, {
      ifMatch: (await x.session.getEmployee(x.employee.id)).revision,
      body: { ...dedicatedBody('2026-10-25'), kind: 'retirement' },
    });
    expect(withKind.status).toBe(400);
  });
});

describe('AC-RT-06 退休与离职互斥', () => {
  it('有未办结离职：通用 / 专用入口建退休都 409 EXIT_IN_PROGRESS，无写入；反向同样', async () => {
    const x = await world('rt06-leave-first');
    await x.createdLeave(x.employee.id, leaveBody(LATER));
    const before = await x.stateOf(x.employee.id);
    expect(await x.reason(await x.createRetire(x.employee.id, retireBody('2026-10-25')))).toMatchObject({
      status: 409,
      reason: 'EXIT_IN_PROGRESS',
    });
    const { revision } = await x.session.getEmployee(x.employee.id);
    const dedicated = await x.session.request('POST', `/retirements/employees/${x.employee.id}`, {
      ifMatch: revision,
      body: dedicatedBody('2026-10-25'),
    });
    expect(await x.reason(dedicated)).toMatchObject({ status: 409, reason: 'EXIT_IN_PROGRESS' });
    expect(await x.stateOf(x.employee.id)).toEqual(before);

    const y = await world('rt06-retire-first');
    await y.createdRetire(y.employee.id, retireBody(LATER));
    const after = await y.stateOf(y.employee.id);
    expect(await y.reason(await y.createLeave(y.employee.id, leaveBody('2026-10-25')))).toMatchObject({
      status: 409,
      reason: 'EXIT_IN_PROGRESS',
    });
    expect(await y.stateOf(y.employee.id)).toEqual(after);
  });
});

describe('AC-RT-08 退休类型派生：创建时快照 P', () => {
  it.each([
    ['L < P', '2026-10-20', '2026-10-25', 'early'],
    ['L = P', '2026-10-20', '2026-10-20', 'normal'],
    ['L > P', '2026-10-20', '2026-10-10', 'delayed'],
    ['P 为空', '2026-10-20', null, null],
  ])('%s → %s', async (_name, last, expected, type) => {
    const x = await world(`rt08-${type}`);
    if (expected) await x.setExpectedRetirement(expected);
    const created = await x.createdRetire(x.employee.id, retireBody(last));
    expect(await x.retirementRow(created.id)).toMatchObject({ expected_retirement_date: expected, retire_type: type });
  });

  it('创建后人事 P 被重算 / 改动：已建单的快照与类型不变', async () => {
    const x = await world('rt08-frozen');
    await x.setExpectedRetirement('2026-10-25');
    const created = await x.createdRetire(x.employee.id, retireBody(LATER));
    await x.setExpectedRetirement('2026-10-01');
    expect(await x.retirementRow(created.id)).toMatchObject({
      expected_retirement_date: '2026-10-25',
      retire_type: 'early',
    });
  });
});

describe('AC-RT-22 创建时序与原子性（设计 §3.2）', () => {
  it('① 直接退休 L 已过：扩展行先写、随后当场生效，生效读到的类型与扩展行一致', async () => {
    const x = await world('rt22-direct');
    await x.setExpectedRetirement('2026-10-05');
    const created = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect(created.status).toBe('effective');
    expect(await x.retirementRow(created.id)).toMatchObject({
      expected_retirement_date: '2026-10-05',
      retire_type: 'normal',
    });
    expect(await x.employeeStatusOf(created.id)).toBe(6);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement']);
    expect((await x.retirementDates()).actual).toBe(TODAY);
  });

  it('③ 注入扩展写入失败：业务头、exit_requests、审计、命令台账都不留', async () => {
    const x = await world('rt22-inject');
    const before = await x.stateOf(x.employee.id);
    injected.failExtension = true;
    try {
      const response = await x.createRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
      expect(response.status).toBe(500);
    } finally {
      injected.failExtension = false;
    }
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });
});
