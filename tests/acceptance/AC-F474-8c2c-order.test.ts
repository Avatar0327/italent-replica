/**
 * F-474-8c-2c 业务先后（AC-INS-14 / 15，设计 §3.3 / §4.1）：社保档案版本的先后只看业务位置
 * （生效日、计划生效日、操作先后），不看 version_no 与追加顺序。场景沿用 AC-TRF-33-35-order 的真实 HTTP + 定时任务 +
 * REBUILD_REQUIRED 闸门。0218 没有“每人每日唯一”约束，所以 AC-INS-14 验证“同日 A、B 都写成”，不构造 23505。
 */
import { registerEmploymentActivationChecks } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { foldInsuranceOrigin, insurancePosition } from '../../apps/api/src/modules/insurance/archive-fold.js';
import { D } from './AC-LNK-support.js';
import { insuranceWriteWorld, type InsuranceWriteWorld } from './support/insurance-write.js';
import { asOwner } from './support/insurance-tables.js';

const testDb = useTestDb();

let fullDepartments = new Set<string>();
registerEmploymentActivationChecks({
  establishmentExceeded: async (_tx, _ctx, target) => fullDepartments.has(target.departmentId ?? ''),
});
afterEach(() => {
  fullDepartments = new Set();
});

/** 员工在“业务位置之前”的社保原值（businessId 缺省 = 最晚位置，即折叠全部事件）。 */
async function originAt(w: InsuranceWriteWorld, employeeId: string, effectiveDate: string, businessId?: string) {
  return asOwner(testDb().db, w.tenantId, async (tx) => {
    const position = await insurancePosition(tx, w.tenantId, employeeId, effectiveDate, businessId);
    return foldInsuranceOrigin(tx, w.tenantId, employeeId, position);
  });
}

describe('AC-INS-14 同日 A、B 都调整社保，审批完成先后与提交先后相反', () => {
  it('两条版本都写成；B 的原值含 A 的调整，B 未填项继承 A、填写项取 B；重复运行各只留一条', async () => {
    const w = await insuranceWriteWorld(testDb().db, 'ins-order-same-day');
    const person = await w.hire('同日社保员工');
    const [p1, p2] = [await w.plan('P1', '440100', w.MONTH), await w.plan('P2', '440100', w.MONTH)];
    const company = await w.company('C1');
    const a = await w.submitTransfer(person, D, {
      adjustedInsuranceRegionCode: '440100',
      adjustedInsurancePlanId: p1,
      adjustedInsuranceCompanyId: company,
    });
    const b = await w.submitTransfer(person, D, { adjustedInsurancePlanId: p2 });
    // 审批完成先后与发起先后相反：业务先后仍按发起先后（DEC-108）
    await w.approve(b, '2026-10-02T02:00:00Z');
    await w.approve(a, '2026-10-02T03:00:00Z');

    const run = await w.runScheduler(`${D}T01:00:00Z`);
    expect(run).toMatchObject({ activated: [a.id, b.id], failed: [] });
    const chain = await w.archive(person.employee.id);
    expect(chain.map((v) => v.businessId).sort()).toEqual([a.id, b.id].sort());
    const rowOf = (id: string) => chain.find((v) => v.businessId === id)!;
    expect(rowOf(a.id)).toMatchObject({ regionCode: '440100', planId: p1, companyId: company });
    // B 只存本单填写的项，不复制 A
    expect(rowOf(b.id)).toMatchObject({ regionCode: null, planId: p2, companyId: null });
    expect(BigInt(rowOf(a.id).seq)).toBeLessThan(BigInt(rowOf(b.id).seq));

    expect(await originAt(w, person.employee.id, D, a.id)).toEqual({ regionCode: null, planId: null, companyId: null });
    expect(await originAt(w, person.employee.id, D, b.id)).toEqual({
      regionCode: '440100',
      planId: p1,
      companyId: company,
    });
    // 折叠全部事件：B 填写的方案覆盖 A，其余继承 A
    expect(await originAt(w, person.employee.id, '2026-12-31')).toEqual({
      regionCode: '440100',
      planId: p2,
      companyId: company,
    });

    await w.runScheduler('2026-10-10T02:00:00Z');
    expect(await w.archive(person.employee.id)).toEqual(chain);
  });
});

describe('AC-INS-15 前序挂起 / 迟到重试，三条调动的追加顺序与业务先后相反', () => {
  it('终态 A→B→C：前驱与最终值按业务先后读取；后项继承、显式值不被覆盖、旧事件不变、重跑不新增、实际日为顺延日', async () => {
    const w = await insuranceWriteWorld(testDb().db, 'ins-order-rebuild');
    const person = await w.hire('重建社保员工');
    const [p1, p2] = [await w.plan('P1', '440100', w.MONTH), await w.plan('P2', '440100', w.MONTH)];
    const [c1, c2] = [await w.company('C1'), await w.company('C2')];
    const a = await w.submitTransfer(person, '2026-10-05', {
      adjustedInsuranceRegionCode: '440100',
      adjustedInsurancePlanId: p1,
      adjustedInsuranceCompanyId: c1,
    });
    const b = await w.submitTransfer(person, '2026-10-05', {
      adjustedInsurancePlanId: p2,
      adjustedInsuranceCompanyId: c2,
    });
    await w.approve(a, '2026-10-02T02:00:00Z');
    await w.approve(b, '2026-10-02T03:00:00Z');
    fullDepartments.add(w.to.id);
    expect(await w.runScheduler('2026-10-04T17:15:00Z')).toMatchObject({ failed: [a.id], suspended: [b.id] });
    expect(await w.archive(person.employee.id)).toEqual([]);

    // A 失败后再发起、审批通过时生效日已到的 C：排在 A 之后，计划日 10-06，审批日 10-07 顺延生效
    // C 不进编制已满的调入部门（保存即会被编制校验拒绝），留在调出部门，只带社保调整
    const c = await w.submitTransfer(
      person,
      '2026-10-06',
      { adjustedInsuranceRegionCode: '110105' },
      { departmentId: w.from.id },
    );
    await w.approve(c, '2026-10-07T02:00:00Z');
    fullDepartments.delete(w.to.id);
    expect((await w.retry(a, '2026-10-07T04:00:00Z')).status).toBe(200);
    expect((await w.business(a.id)).activation).toMatchObject({ failureReason: 'REBUILD_REQUIRED' });
    // 未落任职的 A、B 不写档案；先落地的 C 先写（追加顺序与业务先后相反）
    expect((await w.archive(person.employee.id)).map((v) => v.businessId)).toEqual([c.id]);
    const first = await w.archive(person.employee.id);

    expect((await w.retry(b, '2026-10-07T05:00:00Z')).status).toBe(200);
    expect((await w.retry(a, '2026-10-07T06:00:00Z')).status).toBe(200);
    const chain = await w.archive(person.employee.id);
    expect(chain.map((v) => v.businessId)).toEqual([c.id, b.id, a.id]);
    expect(chain[0]).toEqual(first[0]); // 旧事件一字不改
    const byPosition = [...chain].sort(
      (x, y) =>
        x.effectiveDate.localeCompare(y.effectiveDate) ||
        x.plannedDate.localeCompare(y.plannedDate) ||
        Number(BigInt(x.seq) - BigInt(y.seq)),
    );
    expect(byPosition.map((v) => v.businessId)).toEqual([a.id, b.id, c.id]);
    // 实际生效日是顺延日（迟到执行日），计划日保持原计划
    expect(chain.map((v) => [v.businessId, v.effectiveDate, v.plannedDate])).toEqual([
      [c.id, '2026-10-07', '2026-10-06'],
      [b.id, '2026-10-07', '2026-10-05'],
      [a.id, '2026-10-07', '2026-10-05'],
    ]);

    const origin = (id: string) => originAt(w, person.employee.id, '2026-10-07', id);
    expect(await origin(a.id)).toEqual({ regionCode: null, planId: null, companyId: null });
    expect(await origin(b.id)).toEqual({ regionCode: '440100', planId: p1, companyId: c1 });
    // C 的原值 = A、B 折叠：B 的方案 / 公司覆盖 A，地区继承 A
    expect(await origin(c.id)).toEqual({ regionCode: '440100', planId: p2, companyId: c2 });
    // 终态：C 只填地区，方案 / 公司继承 B，显式地区覆盖
    expect(await originAt(w, person.employee.id, '2026-12-31')).toEqual({
      regionCode: '110105',
      planId: p2,
      companyId: c2,
    });

    await w.runScheduler('2026-10-08T01:00:00Z');
    expect(await w.archive(person.employee.id)).toEqual(chain);
  });

  it('同计划日按操作先后：同日 X、Y 审批先后相反，原值仍按 X→Y 折叠', async () => {
    const w = await insuranceWriteWorld(testDb().db, 'ins-order-seq');
    const person = await w.hire('同日操作序员工');
    const [p1, p2] = [await w.plan('P1', '440100', w.MONTH), await w.plan('P2', '440100', w.MONTH)];
    const x = await w.submitTransfer(person, '2026-10-05', { adjustedInsurancePlanId: p1 });
    const y = await w.submitTransfer(person, '2026-10-05', { adjustedInsurancePlanId: p2 });
    await w.approve(y, '2026-10-02T02:00:00Z');
    await w.approve(x, '2026-10-02T03:00:00Z');
    await w.runScheduler('2026-10-04T17:15:00Z');
    const chain = await w.archive(person.employee.id);
    expect(chain).toHaveLength(2);
    expect(await originAt(w, person.employee.id, '2026-10-05', y.id)).toMatchObject({ planId: p1 });
    expect(await originAt(w, person.employee.id, '2026-10-05', x.id)).toMatchObject({ planId: null });
  });
});
