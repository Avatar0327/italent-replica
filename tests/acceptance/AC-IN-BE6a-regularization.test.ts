/**
 * BE-6a 直接实习转正（差距表 B41；补证结论 R2f B41；DEC-234 实习转正按入职处理）：
 * 保存即生效、不走审批；新主职从转正日开始、变动类型“实习转正”、雇佣关系改内部员工；
 * 有试用期为“试用”并进试用期管理（开始 = 转正日，预计结束 = 开始 + 月数 − 1 天），否则“正式”；
 * 原任职在转正日前一天结束；超编按编制单一判定入口（严格控编拒绝，非严格先确认后保存）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { internWorld, scopedRequest, type InternWorld } from './AC-IN-BE6a-support.js';
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

const kinds = async (w: InternWorld, employeeId: string) => (await records(w, employeeId)).map((record) => record.kind);
const BASE = { effectiveDate: '2026-10-16', probation: false };

describe('AC-IN-BE6a-01 直接实习转正：保存即生效', () => {
  it('有试用期：新主职“实习转正”、人员状态试用、雇佣关系内部员工、汇报关系写入；原任职转正前一天结束', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-probation');
    const intern = await w.hire('试用转正合成实习生', 'intern');
    const manager = await w.hire('合成直线经理', 'internal');
    const managers = { directManagerId: manager.employee.id, dottedManagerId: manager.employee.id };
    const response = await w.regularize(intern.employee.id, withProbation(w.other.id, managers));
    expect(response.status, await response.clone().text()).toBe(201);
    const business = (await response.json()) as { id: string; status: string; mode: string; record: RecordView };
    expect(business).toMatchObject({ status: 'effective', mode: 'direct' });
    expect(business.record).toMatchObject({
      kind: 'intern_regularization',
      changeType: 'intern_regularization',
      effectiveDate: '2026-10-16',
      employeeStatus: 2,
      fields: { employType: 'internal', departmentId: w.other.id, ...managers },
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
});

describe('AC-IN-BE6a-02 直接实习转正：校验', () => {
  it.each([
    ['缺实习转正日期', { effectiveDate: undefined }],
    ['缺部门', { departmentId: undefined }],
    ['缺是否有试用期', { probation: undefined }],
    ['有试用期缺月数', { probation: true }],
    ['月数超出 1～6', { probation: true, probationMonths: 7 }],
    ['无试用期却带月数', { probationMonths: 1 }],
    ['预计结束早于开始', { probation: true, probationMonths: 1, probationEndDate: '2026-10-15' }],
    ['合同协议本次不新增', { contract: {} }],
    ['工号不由请求指定', { jobNumber: 'X' }],
  ])('%s → 400，不写任何记录', async (_label, override) => {
    const w = await internWorld(testDb().db, `be6a-reg-invalid-${uniqueSuffix()}`);
    const intern = await w.hire('校验合成实习生', 'intern');
    const body = JSON.parse(JSON.stringify({ ...BASE, departmentId: w.org.id, ...override })) as Record<
      string,
      unknown
    >;
    const response = await w.regularize(intern.employee.id, body);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await kinds(w, intern.employee.id)).toEqual(['hire']);
  });

  type Setup = (w: InternWorld) => Promise<string>;
  const intern: Setup = async (w) => (await w.hire('合成实习生', 'intern')).employee.id;
  it.each<[string, string, Setup]>([
    ['不是实习生（内部员工）', 'NOT_INTERN', async (w) => (await w.hire('内部合成员工', 'internal')).employee.id],
    [
      '已转正的人不能再直接转正',
      'NOT_INTERN',
      async (w) => {
        const id = await intern(w);
        expect((await w.regularize(id, withProbation(w.org.id, { effectiveDate: '2026-10-10' }))).status).toBe(201);
        return id;
      },
    ],
    [
      '回填到已转正之前（审查 P2-1 同类）',
      'NOT_INTERN',
      async (w) => {
        const id = await intern(w);
        expect((await w.regularize(id, withProbation(w.org.id, { effectiveDate: '2026-10-20' }))).status).toBe(201);
        return id;
      },
    ],
    [
      '已离职（结束实习）的人不能再实习转正（IN-R4）',
      'ACTIVE_EMPLOYMENT_REQUIRED',
      async (w) => {
        const id = await intern(w);
        await w.leave(id, '2026-09-20');
        return id;
      },
    ],
    // 有审批中的实习转正申请：BE-6b 起直接转正改为自动作废在途申请（DEC-593③），见 AC-INTERN-end-regularization
  ])('%s → 409 %s', async (_label, reason, setup) => {
    const w = await internWorld(testDb().db, `be6a-reg-reject-${uniqueSuffix()}`);
    const response = await w.regularize(await setup(w), withProbation(w.org.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason } } });
  });

  it('目标部门不在数据范围 → 404，不落地（反向）', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-scope');
    const id = await intern(w);
    const request = scopedRequest(w, [w.org.id], ['id']);
    const body = { ...BASE, departmentId: w.other.id };
    expect((await request('POST', `/interns/${id}/regularize`, { ifMatch: await w.revision(id), body })).status).toBe(
      404,
    );
    expect(await kinds(w, id)).toEqual(['hire']);
  });

  it('审查 P2-1：已离职后回填离职前的转正日期 → 409 ACTIVE_EMPLOYMENT_REQUIRED，记录 / revision / 试用期不变', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-backfill');
    const id = await intern(w);
    await w.leave(id, '2026-09-20');
    const revision = await w.revision(id);
    const response = await w.regularize(id, withProbation(w.org.id, { effectiveDate: '2026-09-15' }), revision);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ACTIVE_EMPLOYMENT_REQUIRED' } } });
    expect((await kinds(w, id)).sort()).toEqual(['hire', 'leave']);
    expect(await w.revision(id)).toBe(revision);
    expect(await w.view('converted')).toEqual([]);
  });

  it('员工 revision 不一致 → 409，不落地', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-revision');
    const id = await intern(w);
    const response = await w.regularize(id, withProbation(w.org.id), (await w.revision(id)) - 1);
    expect(response.status).toBe(409);
    expect(await kinds(w, id)).toEqual(['hire']);
  });
});

describe('AC-IN-BE6a-03 直接实习转正：超编', () => {
  async function capacity(w: InternWorld, strictControl: boolean) {
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const as = { user: w.session.user.id, tenant: w.session.tenant.id, ifMatch: 0 };
    const post = (path: string, body: object) =>
      api.request('POST', `/api/tenant/establishment${path}`, { ...as, body });
    const ranges = [{ employmentType: 'internal' }];
    const base = { periodType: 'annual', maintenanceMode: 'local', startDate: '2026-01-01', occupancyRanges: ranges };
    const scheme = await post('/schemes', { name: '合成实习转正控编方案', ...base });
    expect(scheme.status, await scheme.clone().text()).toBe(201);
    const { id: schemeId } = (await scheme.json()) as { id: string };
    const cap = { orgId: w.org.id, schemeId, periodStart: '2026-01-01', localCapacity: 1, strictControl };
    expect((await post('/capacities', cap)).status).toBe(201);
  }

  it('严格控编：转为内部员工后超编 → 409 ESTABLISHMENT_EXCEEDED，不落地', async () => {
    const w = await internWorld(testDb().db, 'be6a-reg-strict');
    await w.hire('占编合成员工', 'internal');
    const intern = await w.hire('严格超编合成实习生', 'intern');
    await capacity(w, true);
    const response = await w.regularize(intern.employee.id, withProbation(w.org.id));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect(await kinds(w, intern.employee.id)).toEqual(['hire']);
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
    expect(await kinds(w, intern.employee.id)).toEqual(['hire']);
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
