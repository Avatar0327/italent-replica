/**
 * F-474-8c-2c 第 2 轮审查（P2-2 / P2-3，AC-INS-13）：社保追加审计与联动审计——
 * ① 经真实审计列表 / 详情 HTTP 可读：有日志权 + 对象权 + 范围可见；三个调整字段逐项按字段权披露，撤权则隐藏；
 * ② 追加审计记业务位置上的真实前后变化（before = 本单业务位置之前的折叠原值，只记本单填写项），
 *    迟到落地的业务不取“最大追加版本”当 before。
 * 读取走受控权限替身（同一应用实例、同一统一范围 SQL），写入走真实 HTTP + 真实定时任务。
 */
import { registerEmploymentActivationChecks } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { controlledApi, D, everyField, type ControlledGrants } from './AC-LNK-support.js';
import type { DataChangeDetail, DataChangeLog } from './AC-AUD-support.js';
import { insuranceScene, insuranceWriteWorld, type InsuranceWriteWorld } from './support/insurance-write.js';

const testDb = useTestDb();
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord.code;
const AT_D = `${D}T01:00:00Z`;
const NOW = '2026-10-30T02:00:00Z';
const REGION = 'adjustedInsuranceRegionCode';
const PLAN = 'adjustedInsurancePlanId';
const COMPANY = 'adjustedInsuranceCompanyId';
const ADJUSTED = [REGION, PLAN, COMPANY];

let fullDepartments = new Set<string>();
registerEmploymentActivationChecks({
  establishmentExceeded: async (_tx, _ctx, target) => fullDepartments.has(target.departmentId ?? ''),
});
afterEach(() => {
  fullDepartments = new Set();
});

const withoutFields = (...hidden: string[]): ControlledGrants => ({
  fields: { [EMPLOYMENT]: everyField(EMPLOYMENT).filter((field) => !hidden.includes(field)) },
});

function reader(w: InsuranceWriteWorld, grants: ControlledGrants = {}) {
  const request = controlledApi(w.db, w.tenantId, w.session.user.id, grants, NOW);
  return {
    async list(businessId: string, objectType: string, extra: Record<string, string> = {}) {
      const query = new URLSearchParams({ objectType, objectId: businessId, limit: '100', ...extra });
      const response = await request('GET', `/api/tenant/audit/data-changes?${query}`);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: DataChangeLog[] }).items;
    },
    get: (id: string) => request('GET', `/api/tenant/audit/data-changes/${id}`),
    async detail(id: string) {
      const response = await request('GET', `/api/tenant/audit/data-changes/${id}`);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as DataChangeDetail;
    },
  };
}
const fieldsOf = (log: { changes: { field: string }[] }) => log.changes.map((change) => change.field);

async function executed() {
  const scene = await insuranceScene(testDb().db, 'ins-audit');
  const { w, person, adjust } = scene;
  const business = await w.submitTransfer(person, D, adjust);
  await w.approve(business, '2026-10-02T01:00:00Z');
  await w.runScheduler(AT_D);
  return { ...scene, business };
}

describe('P2-2 社保追加审计 insurance-archive：经审计列表 / 详情可读，逐字段披露', () => {
  it('有日志权、对象权与范围：列表与详情可见，三个调整字段的前后值都在；撤某一字段权只隐藏该字段', async () => {
    const { w, business, plan, company } = await executed();
    const full = reader(w);
    const [log] = await full.list(business.id, 'insurance-archive');
    expect(log).toMatchObject({ action: 'insurance.archive.append', objectId: business.id });
    expect(fieldsOf(log!)).toEqual(expect.arrayContaining(ADJUSTED));
    const detail = await full.detail(log!.id);
    expect(detail.changes.find((change) => change.field === PLAN)).toMatchObject({ from: null, to: plan });
    expect(detail.changes.find((change) => change.field === COMPANY)).toMatchObject({ from: null, to: company });

    const noPlan = reader(w, withoutFields(PLAN));
    const [partial] = await noPlan.list(business.id, 'insurance-archive');
    expect(partial?.id).toBe(log!.id);
    expect(fieldsOf(partial!)).toEqual(expect.arrayContaining([REGION, COMPANY]));
    expect(fieldsOf(partial!)).not.toContain(PLAN);
    expect(JSON.stringify(await noPlan.detail(log!.id))).not.toContain(plan);
  });

  it('三个调整字段都无查看权、范围外、无任职对象查看权：列表为空、详情 404', async () => {
    const { w, business } = await executed();
    const [log] = await reader(w).list(business.id, 'insurance-archive');
    expect(log).toBeDefined();
    const hidden: ControlledGrants[] = [
      withoutFields(...ADJUSTED),
      { scopes: { [EMPLOYMENT]: EMPTY_SCOPE } },
      { deny: (request) => request.action === 'object.view' && request.resource === EMPLOYMENT },
    ];
    for (const grants of hidden) {
      const r = reader(w, grants);
      expect(await r.list(business.id, 'insurance-archive')).toEqual([]);
      expect((await r.get(log!.id)).status).toBe(404);
    }
  });

  it('联动保存审计的三个调整字段进入字段映射：有字段权可见，撤权只隐藏该字段', async () => {
    const { w, business, plan } = await executed();
    const [save] = (await reader(w).list(business.id, 'transfer-linkage', { action: 'transfer.linkage.save' }))!;
    expect(fieldsOf(save!)).toEqual(expect.arrayContaining(ADJUSTED));
    const r = reader(w, withoutFields(PLAN));
    const [partial] = await r.list(business.id, 'transfer-linkage', { action: 'transfer.linkage.save' });
    expect(fieldsOf(partial!)).toEqual(expect.arrayContaining([REGION, COMPANY]));
    expect(fieldsOf(partial!)).not.toContain(PLAN);
    expect(JSON.stringify(await r.detail(save!.id))).not.toContain(plan);
  });

  it('社保子项的审计（子项成功 / 失败）：三个调整字段都可看才可见，缺任一项整条隐藏', async () => {
    const { w, business } = await executed();
    const action = 'transfer.linkage.item.succeeded';
    const [item] = await reader(w).list(business.id, 'transfer-linkage', { action });
    expect(item).toBeDefined();
    for (const hidden of ADJUSTED) {
      const r = reader(w, withoutFields(hidden));
      expect(await r.list(business.id, 'transfer-linkage', { action })).toEqual([]);
      expect((await r.get(item!.id)).status).toBe(404);
    }
    expect(
      await reader(w, { scopes: { [EMPLOYMENT]: EMPTY_SCOPE } }).list(business.id, 'transfer-linkage', { action }),
    ).toEqual([]);
  });

  it('失败的社保子项审计同样按字段权可见 / 隐藏', async () => {
    const { w, person, plan, adjust } = await insuranceScene(testDb().db, 'ins-audit-failed');
    const business = await w.submitTransfer(person, D, adjust);
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.disablePlan(plan);
    await w.runScheduler(AT_D);
    const action = 'transfer.linkage.item.failed';
    expect(await reader(w).list(business.id, 'transfer-linkage', { action })).toHaveLength(1);
    expect(await reader(w, withoutFields(COMPANY)).list(business.id, 'transfer-linkage', { action })).toEqual([]);
  });
});

describe('P2-3 追加审计记业务位置上的真实前后变化（AC-INS-13）', () => {
  it('已有前驱：地区 440100 → 本单改 110105，记 440100 → 110105；只记本单填写项，未填的方案不出现', async () => {
    const { w, person, plan, company } = await insuranceScene(testDb().db, 'ins-audit-before');
    const first = await w.submitTransfer(person, '2026-10-05', {
      adjustedInsuranceRegionCode: '440100',
      adjustedInsurancePlanId: plan,
    });
    await w.approve(first, '2026-10-02T01:00:00Z');
    await w.runScheduler('2026-10-05T01:00:00Z');
    const second = await w.submitTransfer(person, D, {
      adjustedInsuranceRegionCode: '110105',
      adjustedInsuranceCompanyId: company,
    });
    await w.approve(second, '2026-10-02T02:00:00Z');
    await w.runScheduler(AT_D);

    const [row] = await w.auditRows(second.id, 'insurance-archive');
    expect(row!.before).toEqual({ [REGION]: '440100', [COMPANY]: null });
    expect(row!.after).toMatchObject({ versionNo: 2, [REGION]: '110105', [COMPANY]: company });
    expect(Object.keys(row!.after!)).not.toContain(PLAN);

    const [log] = await reader(w).list(second.id, 'insurance-archive');
    const detail = await reader(w).detail(log!.id);
    expect(detail.changes.find((change) => change.field === REGION)).toMatchObject({ from: '440100', to: '110105' });
  });

  it('迟到插入：先落地的业务位置更晚，后落地的业务 before 取它业务位置之前的旧值，不取最大追加版本', async () => {
    const w = await insuranceWriteWorld(testDb().db, 'ins-audit-late');
    const person = await w.hire('迟到插入员工');
    const [p0, p1, p2] = [
      await w.plan('P0', '440100', w.MONTH),
      await w.plan('P1', '440100', w.MONTH),
      await w.plan('P2', '440100', w.MONTH),
    ];
    const [c0, c1, c2, c3] = [
      await w.company('C0'),
      await w.company('C1'),
      await w.company('C2'),
      await w.company('C3'),
    ];
    // 前驱 P：先于一切落地
    const base = await w.submitTransfer(person, '2026-10-03', {
      adjustedInsuranceRegionCode: '440100',
      adjustedInsurancePlanId: p0,
      adjustedInsuranceCompanyId: c0,
    });
    await w.approve(base, '2026-10-02T01:00:00Z');
    await w.runScheduler('2026-10-03T01:00:00Z');

    // 业务先后 a < b < c，落地顺序 c、b、a（与 AC-INS-15 同一套前序挂起 / 迟到重试机制）
    const a = await w.submitTransfer(person, '2026-10-05', {
      adjustedInsuranceRegionCode: '440100',
      adjustedInsurancePlanId: p1,
      adjustedInsuranceCompanyId: c1,
    });
    const b = await w.submitTransfer(person, '2026-10-05', {
      adjustedInsurancePlanId: p2,
      adjustedInsuranceCompanyId: c2,
    });
    await w.approve(a, '2026-10-04T02:00:00Z');
    await w.approve(b, '2026-10-04T03:00:00Z');
    fullDepartments.add(w.to.id);
    expect(await w.runScheduler('2026-10-04T17:15:00Z')).toMatchObject({ failed: [a.id], suspended: [b.id] });
    const c = await w.submitTransfer(
      person,
      '2026-10-06',
      { adjustedInsuranceRegionCode: '110105', adjustedInsuranceCompanyId: c3 },
      { departmentId: w.from.id },
    );
    await w.approve(c, '2026-10-07T02:00:00Z');
    fullDepartments.delete(w.to.id);
    expect((await w.retry(a, '2026-10-07T04:00:00Z')).status).toBe(200);
    expect((await w.retry(b, '2026-10-07T05:00:00Z')).status).toBe(200);
    expect((await w.retry(a, '2026-10-07T06:00:00Z')).status).toBe(200);
    expect((await w.archive(person.employee.id)).map((v) => v.businessId)).toEqual([base.id, c.id, b.id, a.id]);

    const before = async (id: string) => (await w.auditRows(id, 'insurance-archive'))[0]!.before;
    // c 最先落地：业务位置之前只有 P
    expect(await before(c.id)).toEqual({ [REGION]: '440100', [COMPANY]: c0 });
    // b 落地时 a 还没写、c 已写：原值 = P（方案 p0、公司 c0），不是 c 的公司 c3
    expect(await before(b.id)).toEqual({ [PLAN]: p0, [COMPANY]: c0 });
    // a 最后落地，业务位置最靠前：原值 = P，不含任何后写入的 b / c
    expect(await before(a.id)).toEqual({ [REGION]: '440100', [PLAN]: p0, [COMPANY]: c0 });
  });
});
