/**
 * F-474-8c-2a 授权对象与标准授权（AC-INS-12，DEC-896④）：TenantBase.SocialSecurityProfile / SocialInsurancePlan 只预置给
 * 标准版系统管理员与人事管理员（只读，无数据操作），人事专员 / 经理 / 看板 / 员工等其它标准身份一律不含；
 * 调整字段登记在任职记录对象上，同样只给这两个管理员身份，且不进调动联动保存体白名单（接入属 8c-2b）。
 * 已开通租户靠 F-061 回补补齐；租户改过任职记录对象的，调整字段记 withheld，不强行恢复。
 */
import { MODULE_OBJECTS, STANDARD_PROFILES, type ObjectDefinition } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  fieldCode,
  grantsInstalled,
  legacySave,
  legacyWorld,
  ledger,
  objectViewCode,
  permissionOf,
  runBackfill,
  withObject,
} from './support/f061.js';

const testDb = useTestDb();
const ADMIN = 'standard_org_system_admin';
const HR_ADMIN = 'standard_hr_admin';
const ADJUST_FIELDS = ['adjustedInsuranceRegionCode', 'adjustedInsurancePlanId', 'adjustedInsuranceCompanyId'];
const byCode = (code: string): ObjectDefinition | undefined =>
  Object.values(MODULE_OBJECTS).find((o) => o.code === code);
const PROFILE_OBJECT = 'TenantBase.SocialSecurityProfile';
const PLAN_OBJECT = 'TenantBase.SocialInsurancePlan';
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord.code;
const holders = (objectCode: string) =>
  STANDARD_PROFILES.filter((p) => p.objects.some((o) => o.objectCode === objectCode)).map((p) => p.code);

describe('AC-INS-12 授权对象目录', () => {
  it('两个新对象登记在目录里：社保档案（缴交地 / 方案 / 公司）、社保方案；各登记一个列表按钮，且都是系统只读字段', () => {
    const profile = byCode(PROFILE_OBJECT);
    const plan = byCode(PLAN_OBJECT);
    expect(profile?.fields.map((f) => f.code)).toEqual(
      expect.arrayContaining(['insuranceRegionCode', 'insurancePlanId', 'insuranceCompanyId']),
    );
    expect(plan?.fields.map((f) => f.code)).toEqual(expect.arrayContaining(['code', 'name', 'regionCode']));
    for (const definition of [profile, plan]) {
      expect(definition?.buttons.length).toBeGreaterThan(0);
      expect(definition?.fields.filter((f) => !f.system)).toEqual([]);
    }
  });

  it('调整字段登记在任职记录对象上（可编辑的普通字段），原值字段不在任职记录对象上', () => {
    const fields = MODULE_OBJECTS.employmentRecord.fields;
    for (const code of ADJUST_FIELDS) expect(fields.find((f) => f.code === code)?.system, code).toBe(false);
    for (const code of ['insuranceRegionCode', 'insurancePlanId', 'insuranceCompanyId'])
      expect(
        fields.some((f) => f.code === code),
        code,
      ).toBe(false);
  });
});

describe('AC-INS-12 标准身份预置', () => {
  it('两个新对象只有标准版系统管理员与人事管理员持有；专员 / 经理 / 看板 / 员工等其它标准身份都不含', () => {
    expect(holders(PROFILE_OBJECT)).toEqual([ADMIN, HR_ADMIN]);
    expect(holders(PLAN_OBJECT)).toEqual([ADMIN, HR_ADMIN]);
  });

  it('只读：字段全部可见、不可编辑，没有按钮、没有创建 / 修改 / 删除；也不预置任何数据范围（默认空）', () => {
    for (const profile of STANDARD_PROFILES.filter((p) => [ADMIN, HR_ADMIN].includes(p.code))) {
      for (const objectCode of [PROFILE_OBJECT, PLAN_OBJECT]) {
        const granted = profile.objects.find((o) => o.objectCode === objectCode);
        expect(granted?.dataOperations, `${profile.code}/${objectCode}`).toEqual({
          create: false,
          update: false,
          delete: false,
        });
        expect(granted?.buttons).toEqual([]);
        expect(granted?.fields.length).toBeGreaterThan(0);
        expect(granted?.fields.every((f) => f.view && !f.edit)).toBe(true);
      }
      const seeAll = JSON.stringify(profile.seeAll ?? []);
      expect(seeAll).not.toContain(PROFILE_OBJECT);
      expect(seeAll).not.toContain(PLAN_OBJECT);
    }
  });

  it('任职记录上的调整字段只给系统管理员与人事管理员；人事专员、经理等其它持有任职记录的身份不含', () => {
    const withAdjust = (profileCode: string) =>
      STANDARD_PROFILES.find((p) => p.code === profileCode)
        ?.objects.find((o) => o.objectCode === EMPLOYMENT)
        ?.fields.filter((f) => ADJUST_FIELDS.includes(f.fieldCode));
    expect(
      withAdjust(ADMIN)
        ?.map((f) => f.fieldCode)
        .sort(),
    ).toEqual([...ADJUST_FIELDS].sort());
    expect(
      withAdjust(HR_ADMIN)
        ?.map((f) => f.fieldCode)
        .sort(),
    ).toEqual([...ADJUST_FIELDS].sort());
    const others = STANDARD_PROFILES.filter((p) => ![ADMIN, HR_ADMIN].includes(p.code));
    const holdersOfEmployment = others.filter((p) => p.objects.some((o) => o.objectCode === EMPLOYMENT));
    expect(holdersOfEmployment.map((p) => p.code)).toEqual(expect.arrayContaining(['standard_hr_specialist']));
    for (const p of holdersOfEmployment) expect(withAdjust(p.code), p.code).toEqual([]);
  });
});

describe('AC-INS-12 已开通租户回补（F-061）', () => {
  const OLD_PROFILES = [ADMIN, HR_ADMIN];
  const withoutAdjust = <T extends { fields: readonly { fieldCode: string }[] }>(o: T): T => ({
    ...o,
    fields: o.fields.filter((f) => !ADJUST_FIELDS.includes(f.fieldCode)),
  });
  const oldDefinitions = OLD_PROFILES.flatMap((code) => [
    withObject(code, PROFILE_OBJECT, null),
    withObject(code, PLAN_OBJECT, null),
    withObject(code, EMPLOYMENT, withoutAdjust),
  ]);

  it('旧定义没有新对象和调整字段：回补装上两个管理员的两个只读对象和调整字段；专员 / 经理没有，也不被补', async () => {
    const w = await legacyWorld(testDb().db, 'f474-8c2a-topup', oldDefinitions);
    expect(await permissionOf(w, HR_ADMIN, PROFILE_OBJECT)).toBeUndefined();
    const installed = grantsInstalled(await runBackfill(w));
    for (const profile of OLD_PROFILES) {
      expect(installed).toContain(objectViewCode(profile, PROFILE_OBJECT));
      expect(installed).toContain(objectViewCode(profile, PLAN_OBJECT));
      const created = await permissionOf(w, profile, PROFILE_OBJECT);
      expect(created?.fields.every((f) => f.view && !f.edit)).toBe(true);
      expect(created?.buttons).toEqual([]);
      const employment = await permissionOf(w, profile, EMPLOYMENT);
      for (const code of ADJUST_FIELDS)
        expect(
          employment?.fields.find((f) => f.fieldCode === code),
          `${profile}/${code}`,
        ).toMatchObject({
          view: true,
          edit: true,
        });
    }
    for (const other of ['standard_hr_specialist', 'standard_manager']) {
      expect(await permissionOf(w, other, PROFILE_OBJECT), other).toBeUndefined();
      const employment = await permissionOf(w, other, EMPLOYMENT);
      expect(
        employment?.fields.some((f) => ADJUST_FIELDS.includes(f.fieldCode)),
        other,
      ).toBe(false);
    }
  });

  it('租户改过任职记录对象：调整字段记 withheld 不恢复；没改过的两个新对象照常补', async () => {
    const w = await legacyWorld(testDb().db, 'f474-8c2a-withheld', oldDefinitions);
    await legacySave(w, HR_ADMIN, EMPLOYMENT, (o) => ({
      ...o,
      fields: o.fields.map((f) => (f.fieldCode === 'remark' ? { ...f, edit: false } : f)),
    }));
    const installed = grantsInstalled(await runBackfill(w));
    expect(installed).toContain(objectViewCode(HR_ADMIN, PROFILE_OBJECT));
    const employment = await permissionOf(w, HR_ADMIN, EMPLOYMENT);
    expect(employment?.fields.some((f) => ADJUST_FIELDS.includes(f.fieldCode))).toBe(false);
    const now = await ledger(w);
    for (const code of ADJUST_FIELDS)
      expect(now.get(fieldCode(HR_ADMIN, EMPLOYMENT, code, 'view')), code).toBe('withheld');
    // 另一个管理员身份没改过：调整字段照常补
    const admin = await permissionOf(w, ADMIN, EMPLOYMENT);
    for (const code of ADJUST_FIELDS)
      expect(
        admin?.fields.some((f) => f.fieldCode === code),
        code,
      ).toBe(true);
  });
});
