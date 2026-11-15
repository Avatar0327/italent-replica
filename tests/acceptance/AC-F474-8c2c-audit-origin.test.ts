/**
 * F-474-8c-2c 第 3 轮审查（P2，设计 §4.3）：社保追加审计里的“原值”（before / changes.from / 由它们派生的文案）
 * 属于社保档案对象，按查看人**当前**的 SocialSecurityProfile 对象查看权与对应原值字段权裁剪（fail-closed）；
 * “新值”（after / changes.to）仍按任职调整字段权披露，不受影响。
 * 真实 HTTP（审计列表 + 详情）+ 真实定时任务生效；受控权限替身只改社保档案的对象权 / 字段权，
 * 保留日志权、任职对象及三个调整字段查看权与员工范围。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { controlledApi, D, everyField, type ControlledGrants } from './AC-LNK-support.js';
import type { DataChangeDetail, DataChangeLog } from './AC-AUD-support.js';
import { insuranceWriteWorld, type InsuranceWriteWorld } from './support/insurance-write.js';

const testDb = useTestDb();
const PROFILE = MODULE_OBJECTS.socialSecurityProfile.code;
const NOW = '2026-10-30T02:00:00Z';
const REGION = 'adjustedInsuranceRegionCode';
const PLAN = 'adjustedInsurancePlanId';
const COMPANY = 'adjustedInsuranceCompanyId';

const withoutProfileFields = (...hidden: string[]): ControlledGrants => ({
  fields: { [PROFILE]: everyField(PROFILE).filter((field) => !hidden.includes(field)) },
});
const noProfileView: ControlledGrants = {
  deny: (request) => request.action === 'object.view' && request.resource === PROFILE,
};

/** 员工先有一版完整档案（440100 / P1 / C1），本单调整为 110105 / P2 / C2 并生效。 */
async function scene() {
  const w = await insuranceWriteWorld(testDb().db, 'ins-audit-origin');
  const person = await w.hire('原值员工');
  const [p1, p2] = [await w.plan('P1', '440100', w.MONTH), await w.plan('P2', '110105', w.MONTH)];
  const [c1, c2] = [await w.company('C1'), await w.company('C2')];
  const first = await w.submitTransfer(person, '2026-10-05', {
    adjustedInsuranceRegionCode: '440100',
    adjustedInsurancePlanId: p1,
    adjustedInsuranceCompanyId: c1,
  });
  await w.approve(first, '2026-10-02T01:00:00Z');
  await w.runScheduler('2026-10-05T01:00:00Z');
  const second = await w.submitTransfer(person, D, {
    adjustedInsuranceRegionCode: '110105',
    adjustedInsurancePlanId: p2,
    adjustedInsuranceCompanyId: c2,
  });
  await w.approve(second, '2026-10-02T02:00:00Z');
  await w.runScheduler(`${D}T01:00:00Z`);
  const origin = { [REGION]: '440100', [PLAN]: p1, [COMPANY]: c1 };
  const next = { [REGION]: '110105', [PLAN]: p2, [COMPANY]: c2 };
  return { w, business: second, origin, next };
}

/** 列表 + 详情两条出口，返回原始 JSON 文本（断言“原值完全不出现”用）与解析结果。 */
async function read(w: InsuranceWriteWorld, businessId: string, grants: ControlledGrants = {}) {
  const request = controlledApi(w.db, w.tenantId, w.session.user.id, grants, NOW);
  const query = new URLSearchParams({ objectType: 'insurance-archive', objectId: businessId, limit: '100' });
  const listed = await request('GET', `/api/tenant/audit/data-changes?${query}`);
  expect(listed.status, await listed.clone().text()).toBe(200);
  const listText = await listed.text();
  const [log] = (JSON.parse(listText) as { items: DataChangeLog[] }).items;
  expect(log, listText).toBeDefined();
  const detailed = await request('GET', `/api/tenant/audit/data-changes/${log!.id}`);
  expect(detailed.status, await detailed.clone().text()).toBe(200);
  const detailText = await detailed.text();
  return { log: log!, detail: JSON.parse(detailText) as DataChangeDetail, texts: [listText, detailText] };
}
const change = (log: { changes: { field: string }[] }, field: string) =>
  log.changes.find((item) => item.field === field);

describe('P2 社保追加审计的原值按社保档案当前对象 / 字段查看权裁剪', () => {
  it('(c) 权限齐全：原值与新值都可见，列表与详情一致', async () => {
    const { w, business, origin, next } = await scene();
    const { log, detail } = await read(w, business.id);
    for (const field of [REGION, PLAN, COMPANY]) {
      expect(change(log, field)).toMatchObject({ from: origin[field], to: next[field] });
      expect(change(detail, field)).toMatchObject({ from: origin[field], to: next[field] });
    }
    expect(detail.before).toMatchObject(origin);
    expect(detail.after).toMatchObject(next);
    expect(log.content).toContain('440100');
  });

  it('(a) 撤社保档案对象查看权：列表 from、详情 before、文案里都没有任何原值；新值仍可见', async () => {
    const { w, business, origin, next } = await scene();
    const { log, detail, texts } = await read(w, business.id, noProfileView);
    for (const text of texts) for (const value of Object.values(origin)) expect(text).not.toContain(value);
    for (const field of [REGION, PLAN, COMPANY]) {
      expect(change(log, field)).toMatchObject({ from: null, fromText: '', to: next[field] });
      expect(change(detail, field)).toMatchObject({ from: null, to: next[field] });
    }
    expect(detail.before ?? {}).not.toHaveProperty(REGION);
    expect(detail.before ?? {}).not.toHaveProperty(PLAN);
    expect(detail.before ?? {}).not.toHaveProperty(COMPANY);
    expect(detail.after).toMatchObject(next);
  });

  it('(b) 只撤某一项原值字段权：仅该项原值隐藏，其余原值与全部新值照旧', async () => {
    const { w, business, origin, next } = await scene();
    const cases = [
      ['insuranceRegionCode', REGION],
      ['insurancePlanId', PLAN],
      ['insuranceCompanyId', COMPANY],
    ] as const;
    for (const [profileField, hidden] of cases) {
      const { log, detail, texts } = await read(w, business.id, withoutProfileFields(profileField));
      for (const text of texts) expect(text).not.toContain(origin[hidden]);
      expect(change(log, hidden)).toMatchObject({ from: null, to: next[hidden] });
      expect(change(detail, hidden)).toMatchObject({ from: null, to: next[hidden] });
      expect(detail.before ?? {}).not.toHaveProperty(hidden);
      for (const field of [REGION, PLAN, COMPANY].filter((item) => item !== hidden)) {
        expect(change(log, field)).toMatchObject({ from: origin[field], to: next[field] });
        expect(detail.before).toMatchObject({ [field]: origin[field] });
      }
      expect(detail.after).toMatchObject(next);
    }
  });
});
