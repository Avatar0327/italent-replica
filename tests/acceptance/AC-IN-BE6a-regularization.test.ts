/**
 * BE-6a 直接实习转正（差距表 B41；补证结论 R2f B41；DEC-234 实习转正按入职处理）：
 * 保存即生效、不走审批；新主职从转正日开始、变动类型“实习转正”、雇佣关系改内部员工；
 * 有试用期为“试用”并进试用期管理（开始 = 转正日，预计结束 = 开始 + 月数 − 1 天），否则“正式”；
 * 原任职在转正日前一天结束；超编按编制单一判定入口（严格控编拒绝，非严格先确认后保存）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { internWorld, type InternWorld } from './AC-IN-BE6a-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

interface RecordView {
  readonly id: string;
  readonly kind: string;
  readonly changeType: string | null;
  readonly effectiveDate: string;
  readonly stopDate: string;
  readonly employeeStatus: number;
  readonly fields: Record<string, unknown>;
}

const withProbation = (departmentId: string, extra: Record<string, unknown> = {}) => ({
  effectiveDate: '2026-10-16',
  departmentId,
  probation: true,
  probationMonths: 1,
  ...extra,
});

async function records(w: InternWorld, employeeId: string) {
  return (await w.session.records(employeeId, '2026-12-31')) as unknown as RecordView[];
}

describe('AC-IN-BE6a-01 直接实习转正：保存即生效', () => {
  it('有试用期：新主职“实习转正”、人员状态试用、雇佣关系内部员工；原任职转正前一天结束', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-probation');
    const intern = await w.hire('试用转正合成实习生', 'intern');
    const response = await w.regularize(intern.employee.id, withProbation(w.other.id));
    expect(response.status, await response.clone().text()).toBe(201);
    const business = (await response.json()) as { id: string; status: string; mode: string; record: RecordView };
    expect(business).toMatchObject({ status: 'effective', mode: 'direct' });
    expect(business.record).toMatchObject({
      kind: 'intern_regularization',
      changeType: 'intern_regularization',
      effectiveDate: '2026-10-16',
      employeeStatus: 2,
      fields: { employType: 'internal', departmentId: w.other.id },
    });
    const chain = await records(w, intern.employee.id);
    const previous = chain.find((record) => record.id === intern.hireId)!;
    expect(previous).toMatchObject({ stopDate: '2026-10-15', fields: { employType: 'intern' } });
  });

  it('无试用期：人员状态正式；不进试用期管理', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-regular');
    const intern = await w.hire('正式转正合成实习生', 'intern');
    const response = await w.regularize(intern.employee.id, {
      effectiveDate: '2026-10-16',
      departmentId: w.org.id,
      probation: false,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const business = (await response.json()) as { record: RecordView };
    expect(business.record).toMatchObject({ employeeStatus: 3, fields: { employType: 'internal' } });
    const [converted] = await w.view('converted');
    expect(converted).toMatchObject({ employeeId: intern.employee.id, probation: null });
  });

  it('试用期信息：开始 = 转正日，预计结束按月数（10-16 + 1 个月 = 11-15），手填结束日以手填为准', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-period');
    const auto = await w.hire('自动结束合成实习生', 'intern');
    const manual = await w.hire('手填结束合成实习生', 'intern');
    expect((await w.regularize(auto.employee.id, withProbation(w.org.id))).status).toBe(201);
    const manualBody = withProbation(w.org.id, { probationMonths: 3, probationEndDate: '2027-01-10' });
    expect((await w.regularize(manual.employee.id, manualBody)).status).toBe(201);
    const converted = await w.view('converted');
    const byName = (name: string) => converted.find((item) => item.name === name)!;
    expect(byName('自动结束合成实习生').probation).toEqual({
      startDate: '2026-10-16',
      months: 1,
      endDate: '2026-11-15',
    });
    expect(byName('手填结束合成实习生').probation).toEqual({
      startDate: '2026-10-16',
      months: 3,
      endDate: '2027-01-10',
    });
  });

  it('汇报关系：显式给出的直线 / 虚线经理写入新任职', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-managers');
    const manager = await w.hire('合成直线经理', 'internal');
    const dotted = await w.hire('合成虚线经理', 'internal');
    const intern = await w.hire('有经理合成实习生', 'intern');
    const body = withProbation(w.org.id, {
      directManagerId: manager.employee.id,
      dottedManagerId: dotted.employee.id,
    });
    const response = await w.regularize(intern.employee.id, body);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(((await response.json()) as { record: RecordView }).record.fields).toMatchObject({
      directManagerId: manager.employee.id,
      dottedManagerId: dotted.employee.id,
    });
  });
});

describe('AC-IN-BE6a-02 直接实习转正：校验', () => {
  it.each([
    ['缺实习转正日期', { departmentId: 'ORG', probation: false }],
    ['缺部门', { effectiveDate: '2026-10-16', probation: false }],
    ['缺是否有试用期', { effectiveDate: '2026-10-16', departmentId: 'ORG' }],
    ['有试用期缺月数', { effectiveDate: '2026-10-16', departmentId: 'ORG', probation: true }],
    ['月数超出 1～6', { effectiveDate: '2026-10-16', departmentId: 'ORG', probation: true, probationMonths: 7 }],
    ['无试用期却带月数', { effectiveDate: '2026-10-16', departmentId: 'ORG', probation: false, probationMonths: 1 }],
    [
      '预计结束早于开始',
      {
        effectiveDate: '2026-10-16',
        departmentId: 'ORG',
        probation: true,
        probationMonths: 1,
        probationEndDate: '2026-10-15',
      },
    ],
    ['合同协议本次不新增', { effectiveDate: '2026-10-16', departmentId: 'ORG', probation: false, contract: {} }],
    ['工号不由请求指定', { effectiveDate: '2026-10-16', departmentId: 'ORG', probation: false, jobNumber: 'X' }],
  ])('%s → 400，不写任何记录', async (_label, raw) => {
    const w = await internWorld(testDb().db, `be6a-reg-invalid-${uniqueSuffix()}`);
    const intern = await w.hire('校验合成实习生', 'intern');
    const body = JSON.parse(JSON.stringify(raw).replace('"ORG"', JSON.stringify(w.org.id))) as Record<string, unknown>;
    const response = await w.regularize(intern.employee.id, body);
    expect(response.status, await response.clone().text()).toBe(400);
    expect((await records(w, intern.employee.id)).map((record) => record.kind)).toEqual(['hire']);
  });

  it('不是实习生（内部员工）→ 409 NOT_INTERN', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-not-intern');
    const staff = await w.hire('内部合成员工', 'internal');
    const response = await w.regularize(staff.employee.id, withProbation(w.org.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'NOT_INTERN' } } });
  });

  it('已转正的人不能再直接转正 → 409 NOT_INTERN', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-twice');
    const intern = await w.hire('重复转正合成实习生', 'intern');
    expect((await w.regularize(intern.employee.id, withProbation(w.org.id))).status).toBe(201);
    const again = await w.regularize(intern.employee.id, withProbation(w.org.id, { effectiveDate: '2026-10-20' }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { details: { reason: 'NOT_INTERN' } } });
  });

  it('已离职（结束实习）的人不能再实习转正（IN-R4）→ 409', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-left');
    const intern = await w.hire('已离职合成实习生', 'intern');
    await w.leave(intern.employee.id, '2026-09-20');
    const response = await w.regularize(intern.employee.id, withProbation(w.org.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ACTIVE_EMPLOYMENT_REQUIRED' } } });
  });

  it('有审批中的实习转正申请时不能再直接转正 → 409 INTERN_REGULARIZATION_IN_PROGRESS', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-in-review');
    const intern = await w.hire('转正中合成实习生', 'intern');
    await w.applyRegularization(intern.employee.id);
    const response = await w.regularize(intern.employee.id, withProbation(w.org.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: 'INTERN_REGULARIZATION_IN_PROGRESS' } },
    });
  });

  it('员工 revision 不一致 → 409，不落地', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-revision');
    const intern = await w.hire('并发合成实习生', 'intern');
    const stale = (await w.revision(intern.employee.id)) - 1;
    const response = await w.regularize(intern.employee.id, withProbation(w.org.id), stale);
    expect(response.status).toBe(409);
    expect((await records(w, intern.employee.id)).map((record) => record.kind)).toEqual(['hire']);
  });
});

describe('AC-IN-BE6a-03 直接实习转正：超编', () => {
  async function capacity(w: InternWorld, strictControl: boolean) {
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const request = (path: string, body: object) =>
      api.request('POST', `/api/tenant/establishment${path}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: 0,
        body,
      });
    const scheme = await request('/schemes', {
      name: '合成实习转正控编方案',
      periodType: 'annual',
      maintenanceMode: 'local',
      startDate: '2026-01-01',
      occupancyRanges: [{ employmentType: 'internal' }],
    });
    expect(scheme.status, await scheme.clone().text()).toBe(201);
    const { id: schemeId } = (await scheme.json()) as { id: string };
    const created = await request('/capacities', {
      orgId: w.org.id,
      schemeId,
      periodStart: '2026-01-01',
      localCapacity: 1,
      strictControl,
    });
    expect(created.status, await created.clone().text()).toBe(201);
  }

  it('严格控编：转为内部员工后超编 → 409 ESTABLISHMENT_EXCEEDED，不落地', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-strict');
    await w.hire('占编合成员工', 'internal');
    const intern = await w.hire('严格超编合成实习生', 'intern');
    await capacity(w, true);
    const response = await w.regularize(intern.employee.id, withProbation(w.org.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect((await records(w, intern.employee.id)).map((record) => record.kind)).toEqual(['hire']);
  });

  it('非严格控编：先 409 CONFIRMATION_REQUIRED（不落地），带 confirmed 重提后保存', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-confirm');
    await w.hire('占编合成员工', 'internal');
    const intern = await w.hire('超编确认合成实习生', 'intern');
    await capacity(w, false);
    const first = await w.regularize(intern.employee.id, withProbation(w.org.id));
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({
      error: { details: { reason: 'CONFIRMATION_REQUIRED', warnings: [{ departmentId: w.org.id }] } },
    });
    expect((await records(w, intern.employee.id)).map((record) => record.kind)).toEqual(['hire']);
    const confirmed = await w.regularize(intern.employee.id, withProbation(w.org.id, { confirmed: true }));
    expect(confirmed.status, await confirmed.clone().text()).toBe(201);
  });

  it('未超编：不需要确认', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-capacity-ok');
    const intern = await w.hire('编制充足合成实习生', 'intern');
    await capacity(w, false);
    expect((await w.regularize(intern.employee.id, withProbation(w.org.id))).status).toBe(201);
  });
});
