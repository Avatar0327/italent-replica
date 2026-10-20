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

  it('申请不带试用期（明确无 / 不填）：审批通过后记为无试用期、人员状态与直接转正一致', async () => {
    const w = await internWorld(testDb().db, 'f284-without');
    const explicit = await w.hire('无试用期合成实习生', 'intern');
    const omitted = await w.hire('未填试用期合成实习生', 'intern');
    const direct = await w.hire('直接无试用期合成实习生', 'intern');
    await applyAndApprove(w, explicit.employee.id, { probation: false });
    await applyAndApprove(w, omitted.employee.id, {});
    await w.regularizeOk(direct.employee.id, DATE, w.other.id);
    const reference = await probationOf(w, direct.employee.id);
    for (const { employee } of [explicit, omitted]) {
      const view = await probationOf(w, employee.id);
      expect(view).toMatchObject({ hasProbation: false, startDate: null, months: null, expectedEndDate: null });
      expect(regularizedStatus(view)).toBe(regularizedStatus(reference));
    }
  });

  it.each([
    ['有试用期缺月数', { probation: true }],
    ['月数 0', { probation: true, probationMonths: 0 }],
    ['月数 7', { probation: true, probationMonths: 7 }],
    ['无试用期带月数', { probation: false, probationMonths: 3 }],
    ['未填是否有试用期却带月数', { probationMonths: 3 }],
    ['预计结束日格式非法', { probation: true, probationMonths: 1, probationEndDate: '2026-13-01' }],
    ['预计结束日早于转正日', { probation: true, probationMonths: 1, probationEndDate: '2026-09-01' }],
    ['待入职只属于入职', { pendingEntry: true, probation: true, probationMonths: 1 }],
  ])('字段非法 → 400，不产生记录：%s', async (label, extra) => {
    const w = await internWorld(testDb().db, `f284-invalid-${label.length}-${Object.keys(extra).length}`);
    const { employee } = await w.hire('非法转正合成实习生', 'intern');
    const before = await w.revision(employee.id);
    const response = await apply(w, employee.id, extra);
    expect(response.status, label).toBe(400);
    expect(await w.revision(employee.id), label).toBe(before);
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
