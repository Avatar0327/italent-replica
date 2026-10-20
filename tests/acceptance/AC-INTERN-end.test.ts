/**
 * BE-6b 结束实习（差距表 B41；补证结论 R2d / R2f1；31 IN-R4 / IN-R7；DEC-593①，DEC-234）：
 * 结束实习 = 离职的一种，复用 BE-4 离职生效链（activateExit，来源 free_direct）——保存后直接生效、不走审批、不产生待办；
 * 新任职从结束日次日起，业务“离职”、变动类型“实习结束”、人员状态“离职”，雇佣关系仍为“实习生”；离职类型 / 原因为空、不发交接；
 * 进离职管理“已完成的离职”与实习“已离职”视图，不进“已转正”；结束后不能再实习转正（IN-R4）。
 */
import { EMPLOYEE_STATUS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { endWorld, restrictedRequest } from './AC-INTERN-end-support.js';
import { names } from './AC-IN-BE6a-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

describe('AC-INTERN-end-01 结束实习：保存即生效', () => {
  it('结束日次日已到：当场生效，任职“离职 / 实习结束 / 实习生”，不走审批、无待办、无交接', async () => {
    const w = await endWorld(testDb().db, 'end-effective');
    const intern = await w.hire('结束实习合成实习生', 'intern');
    const business = await w.terminateOk(intern.employee.id, { endDate: '2026-09-30' });
    expect(business).toMatchObject({ status: 'effective', mode: 'direct', kind: 'leave' });
    expect(business.record).toMatchObject({
      kind: 'leave',
      changeType: 'intern_end',
      effectiveDate: '2026-10-01',
      employeeStatus: EMPLOYEE_STATUS.left,
      fields: { employType: 'intern' },
    });
    // 原任职在结束日结束；新任职从次日起
    expect(await w.timeline(intern.employee.id)).toMatchObject([
      { kind: 'hire', valid: '[2026-09-01,2026-10-01)' },
      { kind: 'leave', start_date: '2026-10-01' },
    ]);
    // 离职记录：直接离职、离职类型 / 原因 / 去向 / 交接人为空
    expect(await w.exitRow(business.id)).toMatchObject({
      mode: 'direct',
      initiator: 'hr',
      reason_code: null,
      exit_type_code: null,
      whereabouts_code: null,
      handover_employee_id: null,
    });
    expect(await w.instanceOf(business.id)).toBeUndefined();
  });

  it('生效链来源 free_direct：审计与生效端口都带出；复用生效链的作废 / 状态 / 台账步骤', async () => {
    const w = await endWorld(testDb().db, 'end-source');
    const intern = await w.hire('来源合成实习生', 'intern');
    const business = await w.terminateOk(intern.employee.id, { endDate: '2026-09-30' });
    const [audit] = await w.audits(business.id, 'employment.exit.effective');
    expect(audit!.after).toMatchObject({ state: 'effective', source: 'free_direct', effectiveDate: '2026-10-01' });
    expect(await w.audits(business.id, 'exit.request.create')).toHaveLength(1);
    expect(await w.outboxCount(business.id, 'employment.exit.effective')).toBe(1);
  });

  it('进“已完成的离职”与实习“已离职”视图；不进“已转正 / 实习中 / 转正中”', async () => {
    const w = await endWorld(testDb().db, 'end-views');
    const intern = await w.hire('视图合成实习生', 'intern');
    const stay = await w.hire('在职合成实习生', 'intern');
    expect(names(await w.view('interning'))).toEqual(['在职合成实习生', '视图合成实习生'].sort());
    const business = await w.terminateOk(intern.employee.id, { endDate: '2026-09-30' });
    expect(names(await w.view('interning'))).toEqual([stay.name]);
    expect(await w.view('converted')).toEqual([]);
    expect(await w.view('converting')).toEqual([]);
    const [left] = await w.view('left');
    expect(left).toMatchObject({
      id: business.record && (left as { id: string }).id,
      employeeId: intern.employee.id,
      kind: 'leave',
      lastWorkDate: '2026-09-30',
      employType: 'intern',
    });
    const completed = await w.session.request('GET', '/exits?view=completed');
    expect(completed.status, await completed.clone().text()).toBe(200);
    const items = ((await completed.json()) as { items: { id: string }[] }).items;
    expect(items.map((item) => item.id)).toEqual([business.id]);
  });

  it('结束日在将来：保存为“审批通过待生效”，仍在实习中；到期调度生效，来源仍是 free_direct', async () => {
    const w = await endWorld(testDb().db, 'end-future');
    const intern = await w.hire('将来结束合成实习生', 'intern');
    const business = await w.terminateOk(intern.employee.id, { endDate: '2026-10-10' });
    expect(business).toMatchObject({ status: 'approved', mode: 'direct', kind: 'leave' });
    expect(names(await w.view('interning'))).toEqual([intern.name]);
    expect(await w.view('left')).toEqual([]);
    const run = await w.runScheduler('2026-10-11T01:00:00Z');
    expect(run.activated).toEqual([business.id]);
    expect(await w.statusOf(business.id)).toBe('effective');
    const [audit] = await w.audits(business.id, 'employment.exit.effective');
    expect(audit!.after).toMatchObject({
      source: 'free_direct',
      effectiveDate: '2026-10-11',
      lastWorkDate: '2026-10-10',
    });
    expect(await w.leaves(intern.employee.id)).toBe(1);
  });
});

describe('AC-INTERN-end-02 校验', () => {
  it.each([
    ['缺实习结束日期', {}],
    ['日期不合法', { endDate: '2026-02-30' }],
    ['不接受离职类型', { endDate: '2026-09-30', exitTypeCode: 'voluntary' }],
    ['不接受离职原因', { endDate: '2026-09-30', reasonCode: 'personal' }],
    ['开关必须是布尔', { endDate: '2026-09-30', cancelPendingEntry: 'yes' }],
  ])('%s → 400，不写任何记录', async (_label, body) => {
    const w = await endWorld(testDb().db, `end-invalid-${uniqueSuffix()}`);
    const intern = await w.hire('校验合成实习生', 'intern');
    const response = await w.terminate(intern.employee.id, body);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await w.timeline(intern.employee.id)).toHaveLength(1);
  });

  it('结束日期早于实习入职日期：原站未验证，按最保守做法拒绝（统一的离职日期校验码），不写任何记录', async () => {
    const w = await endWorld(testDb().db, 'end-before-entry');
    const intern = await w.hire('早于入职合成实习生', 'intern');
    const response = await w.terminate(intern.employee.id, { endDate: '2026-08-31' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'EXIT_LAST_WORK_DATE_BEFORE_ENTRY' } } });
    expect(await w.timeline(intern.employee.id)).toHaveLength(1);
  });

  it('员工 revision 不一致 → 409，不落地', async () => {
    const w = await endWorld(testDb().db, 'end-revision');
    const intern = await w.hire('版本合成实习生', 'intern');
    const response = await w.terminate(
      intern.employee.id,
      { endDate: '2026-09-30' },
      (await w.revision(intern.employee.id)) - 1,
    );
    expect(response.status).toBe(409);
    expect(await w.timeline(intern.employee.id)).toHaveLength(1);
  });

  type Setup = (w: Awaited<ReturnType<typeof endWorld>>) => Promise<string>;
  it.each<[string, string, Setup]>([
    ['内部员工不能结束实习', 'NOT_INTERN', async (w) => (await w.hire('内部合成员工', 'internal')).employee.id],
    [
      '已转正的人不能结束实习',
      'NOT_INTERN',
      async (w) => {
        const intern = await w.hire('已转正合成实习生', 'intern');
        await w.regularizeOk(intern.employee.id, '2026-09-10', w.org.id);
        return intern.employee.id;
      },
    ],
    [
      '已结束实习不能重复结束',
      'ACTIVE_EMPLOYMENT_REQUIRED',
      async (w) => {
        const intern = await w.hire('重复结束合成实习生', 'intern');
        await w.terminateOk(intern.employee.id, { endDate: '2026-09-20' });
        return intern.employee.id;
      },
    ],
    [
      '已有未办结的离职',
      'EXIT_IN_PROGRESS',
      async (w) => {
        const intern = await w.hire('已有离职合成实习生', 'intern');
        await w.terminateOk(intern.employee.id, { endDate: '2026-10-20' });
        return intern.employee.id;
      },
    ],
  ])('%s → 409 %s', async (_label, reason, setup) => {
    const w = await endWorld(testDb().db, `end-reject-${uniqueSuffix()}`);
    const response = await w.terminate(await setup(w), { endDate: '2026-09-30' });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason } } });
  });
});

describe('AC-INTERN-end-03 结束后不能再实习转正（IN-R4），只能重聘', () => {
  it('直接实习转正 → 409 ACTIVE_EMPLOYMENT_REQUIRED，不写任何记录', async () => {
    const w = await endWorld(testDb().db, 'end-no-regularize');
    const intern = await w.hire('结束后转正合成实习生', 'intern');
    await w.terminateOk(intern.employee.id, { endDate: '2026-09-20' });
    const before = await w.timeline(intern.employee.id);
    const response = await w.regularize(intern.employee.id, {
      effectiveDate: '2026-10-16',
      departmentId: w.org.id,
      probation: false,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ACTIVE_EMPLOYMENT_REQUIRED' } } });
    expect(await w.timeline(intern.employee.id)).toEqual(before);
  });

  it('通用入口发起实习转正申请 → 同样 409', async () => {
    const w = await endWorld(testDb().db, 'end-no-apply');
    const intern = await w.hire('结束后申请合成实习生', 'intern');
    await w.terminateOk(intern.employee.id, { endDate: '2026-09-20' });
    const response = await w.session.request('POST', `/employees/${intern.employee.id}/businesses`, {
      ifMatch: await w.revision(intern.employee.id),
      body: {
        kind: 'intern_regularization',
        mode: 'application',
        effectiveDate: '2026-10-20',
        fields: {},
        probation: false,
      },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ACTIVE_EMPLOYMENT_REQUIRED' } } });
  });
});

describe('AC-INTERN-end-04 权限：沿用直接离职的写权限组合', () => {
  it('没有“直接离职”按钮 → 403，不写任何记录', async () => {
    const w = await endWorld(testDb().db, 'end-no-button');
    const intern = await w.hire('无按钮合成实习生', 'intern');
    const request = restrictedRequest(w, denyButtons('Employment.Dimission'));
    const response = await request('POST', `/interns/${intern.employee.id}/terminate`, {
      ifMatch: await w.revision(intern.employee.id),
      body: { endDate: '2026-09-30' },
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await w.timeline(intern.employee.id)).toHaveLength(1);
  });

  it('员工不在数据范围 → 404，不写任何记录（反向）', async () => {
    const w = await endWorld(testDb().db, 'end-scope');
    const intern = await w.hire('范围外合成实习生', 'intern');
    const request = restrictedRequest(w, () => true, [w.other.id]);
    const response = await request('POST', `/interns/${intern.employee.id}/terminate`, {
      ifMatch: await w.revision(intern.employee.id),
      body: { endDate: '2026-09-30' },
    });
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await w.timeline(intern.employee.id)).toHaveLength(1);
  });

  it('有“直接离职”按钮且在范围内 → 201', async () => {
    const w = await endWorld(testDb().db, 'end-allowed');
    const intern = await w.hire('有权限合成实习生', 'intern');
    const request = restrictedRequest(w, denyButtons('Employment.DimissionApproval'));
    const response = await request('POST', `/interns/${intern.employee.id}/terminate`, {
      ifMatch: await w.revision(intern.employee.id),
      body: { endDate: '2026-09-30' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  });
});

describe('AC-INTERN-end-05 与 BE-4j 通用撤销衔接（#432）', () => {
  it('撤销已生效的结束实习：按普通直接离职撤销，恢复在职，雇佣关系仍为实习生，回到“实习中”', async () => {
    const w = await endWorld(testDb().db, 'end-cancel');
    const intern = await w.hire('撤销合成实习生', 'intern');
    const business = await w.terminateOk(intern.employee.id, { endDate: '2026-09-30' });
    expect(names(await w.view('left'))).toEqual([intern.name]);
    const current = (await (await w.session.request('GET', `/businesses/${business.id}`)).json()) as {
      revision: number;
    };
    const response = await w.session.request('POST', `/exits/${business.id}/cancel`, {
      ifMatch: current.revision,
      body: { reason: '合成撤销原因' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await w.timeline(intern.employee.id)).toMatchObject([{ kind: 'hire', valid: '[2026-09-01,)' }]);
    expect(await w.view('left')).toEqual([]);
    expect(names(await w.view('interning'))).toEqual([intern.name]);
    const [record] = (await w.session.records(intern.employee.id, '2026-10-05')) as unknown as {
      kind: string;
      fields: Record<string, unknown>;
    }[];
    expect(record).toMatchObject({ kind: 'hire', fields: { employType: 'intern' } });
  });
});
