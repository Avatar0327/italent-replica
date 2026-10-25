/**
 * F-284（DEC-647）实习转正申请受理“是否有试用期 / 试用期(月) / 预计结束日期”：
 * 申请与直接转正共用 saveEntryProbation 写试用期版本（DEC-585），审批通过后的试用期结果与直接转正一致；
 * 校验口径与直接转正相同（有试用期必填月数、月数 1～6、预计结束日不早于开始日）；其他业务类型的拒收行为不变。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { internWorld, type InternWorld } from './AC-IN-BE6a-support.js';

const testDb = useTestDb();
const DATE = '2026-09-16';

interface ProbationView {
  readonly revision: number;
  readonly hasProbation: boolean;
  readonly startDate: string | null;
  readonly months: number | null;
  readonly expectedEndDate: string | null;
  readonly records: readonly { readonly kind: string; readonly employeeStatus: number }[];
}

async function probationOf(w: InternWorld, employeeId: string): Promise<ProbationView> {
  const response = await w.session.request('GET', `/employees/${employeeId}/probation?asOf=2026-10-01`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProbationView;
}

/** 通用入口提交实习转正申请；返回原始响应，失败用例读状态码与错误码。 */
async function apply(w: InternWorld, employeeId: string, extra: Record<string, unknown> = {}, mode = 'application') {
  const body = {
    kind: 'intern_regularization',
    mode,
    effectiveDate: DATE,
    fields: { departmentId: w.other.id },
    ...extra,
  };
  return w.session.request('POST', `/employees/${employeeId}/businesses`, {
    ifMatch: await w.revision(employeeId),
    body,
  });
}

async function applyAndApprove(w: InternWorld, employeeId: string, extra: Record<string, unknown>) {
  const created = await apply(w, employeeId, extra);
  expect(created.status, await created.clone().text()).toBe(201);
  const draft = (await created.json()) as { id: string; revision: number };
  const submitted = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
    ifMatch: draft.revision,
    body: {},
  });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  await w.approve(draft.id);
}

const regularizedStatus = (view: ProbationView) =>
  view.records.find((record) => record.kind === 'intern_regularization')?.employeeStatus;

describe('AC-IN-F284 实习转正申请受理试用期', () => {
  it('申请带试用期：审批通过后写入试用期版本，与直接转正结果一致', async () => {
    const w = await internWorld(testDb().db, 'f284-with');
    const applied = await w.hire('申请转正合成实习生', 'intern');
    const direct = await w.hire('直接转正合成实习生', 'intern');
    await applyAndApprove(w, applied.employee.id, { probation: true, probationMonths: 3 });
    const response = await w.regularize(direct.employee.id, {
      effectiveDate: DATE,
      departmentId: w.other.id,
      probation: true,
      probationMonths: 3,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const view = await probationOf(w, applied.employee.id);
    expect(view).toMatchObject({ hasProbation: true, startDate: DATE, months: 3, expectedEndDate: '2026-12-15' });
    const reference = await probationOf(w, direct.employee.id);
    expect(view).toMatchObject({
      hasProbation: reference.hasProbation,
      startDate: reference.startDate,
      months: reference.months,
      expectedEndDate: reference.expectedEndDate,
    });
    expect(regularizedStatus(view)).toBe(regularizedStatus(reference));
  });

  it('申请手填预计结束日：保留手填值', async () => {
    const w = await internWorld(testDb().db, 'f284-manual');
    const { employee } = await w.hire('手填转正合成实习生', 'intern');
    await applyAndApprove(w, employee.id, { probation: true, probationMonths: 2, probationEndDate: '2026-12-31' });
    expect(await probationOf(w, employee.id)).toMatchObject({ months: 2, expectedEndDate: '2026-12-31' });
  });

  it('申请不带试用期（probation:false）：审批通过后记为无试用期、人员状态与直接转正一致', async () => {
    const w = await internWorld(testDb().db, 'f284-without');
    const applied = await w.hire('无试用期合成实习生', 'intern');
    const direct = await w.hire('直接无试用期合成实习生', 'intern');
    await applyAndApprove(w, applied.employee.id, { probation: false });
    await w.regularizeOk(direct.employee.id, DATE, w.other.id);
    const view = await probationOf(w, applied.employee.id);
    expect(view).toMatchObject({ hasProbation: false, startDate: null, months: null, expectedEndDate: null });
    expect(regularizedStatus(view)).toBe(regularizedStatus(await probationOf(w, direct.employee.id)));
  });

  it('同一输入两个入口一致：省略 probation 时申请与直接转正都 400 PROBATION_REQUIRED（DEC-402 不留兼容分叉）', async () => {
    const w = await internWorld(testDb().db, 'f284-parity-omit');
    const applied = await w.hire('省略申请合成实习生', 'intern');
    const direct = await w.hire('省略直接合成实习生', 'intern');
    const application = await apply(w, applied.employee.id, {});
    expect(application.status, await application.clone().text()).toBe(400);
    expect(await application.json()).toMatchObject({ error: { details: { reason: 'PROBATION_REQUIRED' } } });
    const directResponse = await w.regularize(direct.employee.id, { effectiveDate: DATE, departmentId: w.other.id });
    expect(directResponse.status, await directResponse.clone().text()).toBe(400);
  });

  it.each([
    ['有试用期缺月数', { probation: true }],
    ['月数 0', { probation: true, probationMonths: 0 }],
    ['月数 7', { probation: true, probationMonths: 7 }],
    ['无试用期带月数', { probation: false, probationMonths: 3 }],
    ['未填是否有试用期却带月数', { probationMonths: 3 }],
    ['预计结束日格式非法', { probation: true, probationMonths: 1, probationEndDate: '2026-13-01' }],
    ['预计结束日早于转正日', { probation: true, probationMonths: 1, probationEndDate: '2026-09-01' }],
  ])('同一非法输入两个入口一致都 400：%s', async (label, extra) => {
    const w = await internWorld(testDb().db, `f284-parity-${label.length}-${Object.keys(extra).length}`);
    const applied = await w.hire('对照申请合成实习生', 'intern');
    const direct = await w.hire('对照直接合成实习生', 'intern');
    expect((await apply(w, applied.employee.id, extra)).status, `申请：${label}`).toBe(400);
    const response = await w.regularize(direct.employee.id, {
      effectiveDate: DATE,
      departmentId: w.other.id,
      ...extra,
    });
    expect(response.status, `直接：${label}`).toBe(400);
  });

  it('待入职只属于入职：实习转正申请带 pendingEntry → 400，不产生记录', async () => {
    const w = await internWorld(testDb().db, 'f284-pending');
    const { employee } = await w.hire('待入职合成实习生', 'intern');
    const before = await w.revision(employee.id);
    const response = await apply(w, employee.id, { pendingEntry: true, probation: true, probationMonths: 1 });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await w.revision(employee.id)).toBe(before);
  });

  it('有试用期缺月数的错误码为 PROBATION_MONTHS_REQUIRED', async () => {
    const w = await internWorld(testDb().db, 'f284-reason');
    const { employee } = await w.hire('错误码合成实习生', 'intern');
    const response = await apply(w, employee.id, { probation: true });
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'PROBATION_MONTHS_REQUIRED' } } });
  });

  it('负例：实习转正经通用入口直接办理仍不受理试用期（走 /interns/:id/regularize）', async () => {
    const w = await internWorld(testDb().db, 'f284-direct-generic');
    const { employee } = await w.hire('通用直接转正合成实习生', 'intern');
    const response = await apply(w, employee.id, { probation: true, probationMonths: 1 }, 'direct');
    expect(response.status, await response.clone().text()).toBe(400);
  });

  it('负例：其他非入职业务（调动、离职）带试用期字段仍拒收', async () => {
    const w = await internWorld(testDb().db, 'f284-other-kinds');
    const { employee } = await w.hire('其他业务合成员工', 'internal');
    const bodies = [
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-09-20', fields: { departmentId: w.other.id } },
      { kind: 'leave', mode: 'direct', effectiveDate: '2026-09-20', lastWorkDate: '2026-09-20', fields: {} },
    ];
    for (const body of bodies) {
      const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
        ifMatch: await w.revision(employee.id),
        body: { ...body, probation: true, probationMonths: 1 },
      });
      expect(response.status, body.kind).toBe(400);
    }
  });
});

describe('AC-IN-F284 申请期间的改期与取消（审查实测探针转正式）', () => {
  async function draftApplication(w: InternWorld, employeeId: string, extra: Record<string, unknown>) {
    const created = await apply(w, employeeId, extra);
    expect(created.status, await created.clone().text()).toBe(201);
    return (await created.json()) as { id: string; revision: number };
  }

  async function act(w: InternWorld, business: { id: string }, action: string) {
    const current = (await (await w.session.request('GET', `/businesses/${business.id}`)).json()) as {
      revision: number;
    };
    const response = await w.session.request('POST', `/businesses/${business.id}/${action}`, {
      ifMatch: current.revision,
      body: {},
    });
    expect(response.status, `${action}：${await response.clone().text()}`).toBe(200);
  }

  it('申请填月数 → 改期 → 批准：开始日 = 新转正日，预计结束日按新开始日推算', async () => {
    const w = await internWorld(testDb().db, 'f284-reschedule');
    const { employee } = await w.hire('改期合成实习生', 'intern');
    const draft = await draftApplication(w, employee.id, { probation: true, probationMonths: 3 });
    const patched = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { effectiveDate: '2026-09-20' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    await act(w, draft, 'submit');
    await w.approve(draft.id);
    expect(await probationOf(w, employee.id)).toMatchObject({
      hasProbation: true,
      startDate: '2026-09-20',
      months: 3,
      expectedEndDate: '2026-12-19',
    });
  });

  it.each(['withdraw', 'revoke'])('申请提交后 %s：预写的试用期版本不污染当前试用期与人员状态', async (action) => {
    const w = await internWorld(testDb().db, `f284-cancel-${action}`);
    const { employee } = await w.hire('取消合成实习生', 'intern');
    const { revision: _before, ...before } = await probationOf(w, employee.id);
    const draft = await draftApplication(w, employee.id, { probation: true, probationMonths: 3 });
    await act(w, draft, 'submit');
    await act(w, draft, action);
    // 员工 revision 随每次业务操作递增，其余字段（试用期、人员状态、记录）须与申请前一致
    const { revision: _after, ...after } = await probationOf(w, employee.id);
    expect(after).toEqual(before);
  });
});
