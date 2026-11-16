/**
 * F-474-8c-2c 保存侧（设计 §4.2，AC-INS-03 / 04 写侧、05 审批≠生效）：联动保存体新增三个调整值，
 * 缴交地须是字典内编码，方案须在生效日当月有效且启用，公司须是本租户合同公司；跨租户 ID 不泄露存在性。
 * 真实 HR 调动入口、真实 HTTP；审批通过用可信端口，生效用真实定时任务。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { D } from './AC-LNK-support.js';
import { insuranceWriteWorld } from './support/insurance-write.js';

const testDb = useTestDb();

async function scene(label: string) {
  const w = await insuranceWriteWorld(testDb().db, label);
  const person = await w.hire('社保调整员工');
  const [plan, company] = [await w.plan('P', '440100', w.MONTH), await w.company('C')];
  return { w, person, plan, company };
}

const body = async (response: Response) =>
  (await response.json()) as { error?: { code: string; details?: { reason?: string } } };
const reasonOf = async (response: Response) => (await body(response)).error?.details?.reason;

describe('AC-INS-03 缴交地：字典内编码', () => {
  it('字典内的省 / 市 / 区编码都能保存，保存的值落在联动版本的三列', async () => {
    const { w, person } = await scene('ins-save-region');
    for (const code of ['110000', '440100', '110105']) {
      const p = await w.hire(`地区${code}`);
      const business = await w.saved(await w.transfer(p, { linkage: { adjustedInsuranceRegionCode: code } }));
      expect(await w.savedAdjust(business.id)).toEqual([{ region: code, plan: null, company: null }]);
    }
    expect(person.employee.id).toBeTruthy();
  });

  it('非字典编码 → 400，不产生调动单', async () => {
    const { w, person } = await scene('ins-save-bad-region');
    expect((await w.transfer(person, { linkage: { adjustedInsuranceRegionCode: '440100' } })).status).toBe(201);
    const response = await w.transfer(person, { linkage: { adjustedInsuranceRegionCode: '999999' } });
    expect(response.status).toBe(400);
    expect(await reasonOf(response)).toBe('INSURANCE_REGION_INVALID');
  });
});

describe('AC-INS-04 候选约束（写侧）', () => {
  it('方案：停用、尚未生效、已过停用月都是 400；生效日当月有效且启用才可保存', async () => {
    const { w, person, plan } = await scene('ins-save-plan');
    const disabled = await w.plan('D', '440100', w.MONTH);
    await w.disablePlan(disabled);
    const future = await w.plan('F', '440100', '2026-11-01');
    const stopped = await w.plan('S', '440100', '2026-01-01', { stop: '2026-10-01' });
    const ok = await w.transfer(person, { linkage: { adjustedInsurancePlanId: plan } });
    expect(ok.status, await ok.clone().text()).toBe(201);
    for (const planId of [disabled, future, stopped]) {
      const response = await w.transfer(person, { linkage: { adjustedInsurancePlanId: planId } });
      expect([response.status, await reasonOf(response)], planId).toEqual([400, 'INSURANCE_PLAN_INVALID']);
    }
  });

  it('公司：不存在的 ID → 400', async () => {
    const { w, person, company } = await scene('ins-save-company');
    expect((await w.transfer(person, { linkage: { adjustedInsuranceCompanyId: company } })).status).toBe(201);
    const response = await w.transfer(person, {
      linkage: { adjustedInsuranceCompanyId: '00000000-0000-4000-8000-000000000000' },
    });
    expect([response.status, await reasonOf(response)]).toEqual([400, 'INSURANCE_COMPANY_INVALID']);
  });

  it('跨租户的方案 / 公司 ID：与不存在同形（同状态码、同错误码），不泄露存在性', async () => {
    const { w, person, plan, company } = await scene('ins-save-tenant-a');
    // 对照：本租户的方案 / 公司可保存（排除“整个字段都被拒”的假红）
    const mine = await w.transfer(person, {
      linkage: { adjustedInsurancePlanId: plan, adjustedInsuranceCompanyId: company },
    });
    expect(mine.status, await mine.clone().text()).toBe(201);
    const other = await insuranceWriteWorld(testDb().db, 'ins-save-tenant-b');
    const foreign = { plan: await other.plan('X', '440100', other.MONTH), company: await other.company('X') };
    const ghost = '00000000-0000-4000-8000-000000000000';
    const results = [];
    for (const key of ['adjustedInsurancePlanId', 'adjustedInsuranceCompanyId'] as const) {
      const real = await w.transfer(person, {
        linkage: { [key]: key.includes('Plan') ? foreign.plan : foreign.company },
      });
      const none = await w.transfer(person, { linkage: { [key]: ghost } });
      results.push([real.status, await reasonOf(real), none.status, await reasonOf(none)]);
    }
    for (const [realStatus, realReason, noneStatus, noneReason] of results) {
      expect([400, 404]).toContain(realStatus);
      expect(realReason).toMatch(/^INSURANCE_(PLAN|COMPANY)_INVALID$/);
      expect([realStatus, realReason]).toEqual([noneStatus, noneReason]);
    }
  });

  it('三项都可空：全空的联动不写调整值；带值才写（任一项带值即写联动版本）', async () => {
    const { w, person, company } = await scene('ins-save-nullable');
    const business = await w.saved(await w.transfer(person, { linkage: { adjustedInsuranceCompanyId: company } }));
    expect(await w.savedAdjust(business.id)).toEqual([{ region: null, plan: null, company }]);
    const view = await w.linkage(business.id);
    expect(view.options).toMatchObject({ adjustedInsuranceCompanyId: company });
  });
});

describe('AC-INS-05 审批通过 ≠ 生效', () => {
  it('审批通过后、生效日之前不写档案；生效日当天定时任务才写一条版本', async () => {
    const { w, person, plan, company } = await scene('ins-save-approval');
    const business = await w.saved(
      await w.transfer(person, {
        linkage: {
          adjustedInsuranceRegionCode: '440100',
          adjustedInsurancePlanId: plan,
          adjustedInsuranceCompanyId: company,
        },
      }),
    );
    await w.approve(business, '2026-10-02T01:00:00Z');
    expect(await w.archive(person.employee.id)).toEqual([]);
    expect((await w.runScheduler('2026-10-09T01:00:00Z')).activated).toEqual([]);
    expect(await w.archive(person.employee.id)).toEqual([]);
    expect((await w.runScheduler(`${D}T01:00:00Z`)).activated).toEqual([business.id]);
    const [version] = await w.archive(person.employee.id);
    expect(version).toMatchObject({
      versionNo: 1,
      businessId: business.id,
      effectiveDate: D,
      regionCode: '440100',
      planId: plan,
      companyId: company,
    });
  });
});
