/**
 * BE-3 第 1 轮审查返工（#391，Sol high P2-2～P2-5）：
 * - P2-2 PB-R10：有审批通过、未到生效日的转正记录时，带回原转正日期也不能调整试用信息；
 * - P2-3 通用入口 /businesses 的转正与 /regularizations 同一入口：试用结果必填、F-205 默认日期；
 * - P2-4 入职申请可填试用期限，开始日到实际生效时再定（申请期间改期）；
 * - P2-5 视图带“机构”列：部门在行政维度上所属的机构，与部门不同。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { addHire, hireBody } from './AC-EN-BE2a-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import {
  adjust,
  employeeRevision,
  hire,
  pbWorld,
  probationOf,
  probationView,
  transition,
  type PbWorld,
} from './AC-PB-support.js';

const testDb = useTestDb();
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;

async function versionCount(w: PbWorld, employeeId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const [row] = rows<{ count: number }>(
      await tx.execute(sql`SELECT count(*)::int AS count FROM employment_probation_versions
        WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employeeId}::uuid`),
    );
    return row!.count;
  });
}

/** 通用入口 POST /employees/:id/businesses 建一张转正业务（原始响应，失败用例要读码）。 */
async function genericRegularization(w: PbWorld, employeeId: string, body: Record<string, unknown>) {
  return w.session.request('POST', `/employees/${employeeId}/businesses`, {
    ifMatch: await employeeRevision(w, employeeId),
    body: { kind: 'regularization', ...body },
  });
}

describe('P2-2 PB-R10：审批通过、未到生效日的转正记录存在时不能调整试用信息', () => {
  it('带回原转正日期仍被拒；版本数与员工 revision 不变；到生效日后可以调整', async () => {
    const w = await pbWorld(testDb().db, 'pb-r2-r10');
    const { employee } = await hire(w, { months: 3 });
    const draft = await genericRegularization(w, employee.id, {
      mode: 'application',
      effectiveDate: '2026-10-15',
      probationResult: 'normal',
    });
    expect(draft.status, await draft.clone().text()).toBe(201);
    const business = (await draft.json()) as { id: string };
    expect((await transition(w, business, 'submit')).status).toBe(200);
    expect((await transition(w, business, 'approve')).status).toBe(200);
    const versions = await versionCount(w, employee.id);
    const revision = await employeeRevision(w, employee.id);
    const body = {
      hasProbation: true,
      startDate: '2026-09-01',
      months: 3,
      expectedEndDate: '2026-11-29',
      regularizationDate: '2026-10-15',
    };
    const rejected = await adjust(w, employee.id, body);
    expect(rejected.status).toBe(409);
    expect(await reasonOf(rejected)).toBe('PROBATION_REGULARIZATION_NOT_EFFECTIVE');
    expect(await versionCount(w, employee.id)).toBe(versions);
    expect(await employeeRevision(w, employee.id)).toBe(revision);

    w.session.setNow('2026-10-15T01:00:00.000Z');
    expect((await transition(w, business, 'activate', '2026-10-15T01:00:00Z')).status).toBe(200);
    const accepted = await adjust(w, employee.id, body);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await versionCount(w, employee.id)).toBe(versions + 1);
  });
});

describe('P2-3 通用入口的转正：试用结果必填、默认转正日期（与 /regularizations 同一入口）', () => {
  it('直接办理：缺试用结果 400；字典外 400；不填日期取预计结束日次日', async () => {
    const w = await pbWorld(testDb().db, 'pb-r2-generic-direct');
    const { employee } = await hire(w, { months: 3 });
    const missing = await genericRegularization(w, employee.id, { mode: 'direct', effectiveDate: '2026-10-20' });
    expect(missing.status).toBe(400);
    expect(await reasonOf(missing)).toBe('PROBATION_RESULT_REQUIRED');
    const unknown = await genericRegularization(w, employee.id, { mode: 'direct', probationResult: 'unknown' });
    expect(unknown.status).toBe(400);
    expect(await reasonOf(unknown)).toBe('PROBATION_RESULT_UNKNOWN');
    const created = await genericRegularization(w, employee.id, { mode: 'direct', probationResult: 'early' });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(((await created.json()) as { effectiveDate: string }).effectiveDate).toBe('2026-12-01');
    expect(await probationOf(w, employee.id, '2026-12-01')).toMatchObject({
      regularizationDate: '2026-12-01',
      probationResult: 'early',
    });
  });

  it('转正申请：缺试用结果 400；带上后建草稿、提交审批，试用结果随申请保留', async () => {
    const w = await pbWorld(testDb().db, 'pb-r2-generic-apply');
    const { employee } = await hire(w, { months: 3 });
    const missing = await genericRegularization(w, employee.id, { mode: 'application', effectiveDate: '2026-12-01' });
    expect(missing.status).toBe(400);
    expect(await reasonOf(missing)).toBe('PROBATION_RESULT_REQUIRED');
    const created = await genericRegularization(w, employee.id, { mode: 'application', probationResult: 'delayed' });
    expect(created.status, await created.clone().text()).toBe(201);
    const business = (await created.json()) as { id: string; effectiveDate: string };
    expect(business.effectiveDate).toBe('2026-12-01');
    expect((await transition(w, business, 'submit')).status).toBe(200);
    expect(await probationOf(w, employee.id)).toMatchObject({
      regularizationState: 'in_review',
      probationResult: 'delayed',
    });
  });

  it('非转正业务带试用结果 400', async () => {
    const w = await pbWorld(testDb().db, 'pb-r2-generic-other');
    const { employee } = await hire(w, { months: 3 });
    const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: await employeeRevision(w, employee.id),
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-20',
        fields: { place: '调动地点' },
        probationResult: 'normal',
      },
    });
    expect(response.status).toBe(400);
  });
});

describe('P2-4 入职申请填写试用期限，开始日到生效时再定', () => {
  async function applyHire(w: PbWorld, extra: Record<string, unknown>) {
    const employee = await w.session.employee();
    const created = await addHire(
      w.session,
      employee,
      hireBody(w.org.id, '2026-09-10', { mode: 'application', probation: true, ...extra }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const business = (await created.json()) as { id: string; revision: number };
    return { employee, business };
  }

  async function reschedule(w: PbWorld, business: { id: string }, effectiveDate: string) {
    const current = (await (await w.session.request('GET', `/businesses/${business.id}`)).json()) as {
      revision: number;
    };
    const patched = await w.session.request('PATCH', `/businesses/${business.id}`, {
      ifMatch: current.revision,
      body: { effectiveDate },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
  }

  async function approve(w: PbWorld, business: { id: string }) {
    for (const action of ['submit', 'approve'] as const)
      expect((await transition(w, business, action)).status).toBe(200);
  }

  it('填月数 → 改期 → 批准生效：开始日 = 新入职日，预计结束日按新开始日推算', async () => {
    const w = await pbWorld(testDb().db, 'pb-r2-apply-months');
    const { employee, business } = await applyHire(w, { probationMonths: 3 });
    await reschedule(w, business, '2026-09-20');
    await approve(w, business);
    expect(await probationOf(w, employee.id)).toMatchObject({
      hasProbation: true,
      startDate: '2026-09-20',
      months: 3,
      expectedEndDate: '2026-12-19',
    });
  });

  it('手填预计结束日：改期后仍不早于开始日则保留；早于新开始日则改按月数推算', async () => {
    const w = await pbWorld(testDb().db, 'pb-r2-apply-manual');
    const kept = await applyHire(w, { probationMonths: 3, probationEndDate: '2026-12-31' });
    await reschedule(w, kept.business, '2026-09-20');
    await approve(w, kept.business);
    expect(await probationOf(w, kept.employee.id)).toMatchObject({
      startDate: '2026-09-20',
      expectedEndDate: '2026-12-31',
    });

    const stale = await applyHire(w, { probationMonths: 2, probationEndDate: '2026-09-15' });
    await reschedule(w, stale.business, '2026-09-20');
    await approve(w, stale.business);
    expect(await probationOf(w, stale.employee.id)).toMatchObject({
      startDate: '2026-09-20',
      expectedEndDate: '2026-11-19',
    });
  });

  it('手填预计结束日早于申请上的入职日 → 400', async () => {
    const w = await pbWorld(testDb().db, 'pb-r2-apply-invalid');
    const employee = await w.session.employee();
    const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: withLoginEmail(
        employee.id,
        hireBody(w.org.id, '2026-09-10', { mode: 'application', probation: true, probationEndDate: '2026-09-01' }),
      ),
    });
    expect(response.status).toBe(400);
  });
});

describe('P2-5 视图带“机构”列', () => {
  it('部门挂在机构下：行里部门与机构两列不同；部门自己是机构时机构 = 部门', async () => {
    const w = await pbWorld(testDb().db, 'pb-r2-organization');
    const company = await w.session.org('合成分公司', { establishedOn: '2026-01-01', broadType: '机构' });
    const department = await w.session.org('合成分公司销售部', {
      establishedOn: '2026-01-01',
      parents: { admin: { parentId: company.id } },
    });
    const inDepartment = await hire({ ...w, org: department }, { months: 3, name: '部门员工' });
    const inCompany = await hire({ ...w, org: company }, { months: 3, name: '机构员工' });
    const items = await probationView(w, 'all');
    const row = (id: string) => items.find((item) => item.employeeId === id)!;
    expect(row(inDepartment.employee.id)).toMatchObject({ departmentId: department.id, organizationId: company.id });
    expect(row(inCompany.employee.id)).toMatchObject({ departmentId: company.id, organizationId: company.id });
  });
});
