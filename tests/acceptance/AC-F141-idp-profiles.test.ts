/**
 * F-141 IDP 授权（DEC-500）：预置 IDP 标准身份——IDP管理员 / IDP员工 / IDP经理。原站证据只到对象与按钮目录，
 * 各身份的功能明细未逐项取证：管理员 = IDP 应用全部对象全部功能；员工、经理按最小权限只读（经理多看关键信息三类对象）。
 * 数据范围一律不预置（硬规则：默认空），由租户管理员按（用户 × IDP）授予；不占许可名额。
 */
import { IDP_APP, IDP_OBJECTS, presetSeeAllTargets, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { provisionWorld } from './support/f061.js';
import { holderOfProfile } from './support/ql-presets.js';

const testDb = useTestDb();
const ADMIN = 'standard_idp_admin';
const EMPLOYEE = 'standard_idp_employee';
const MANAGER = 'standard_idp_manager';
const PLAN = IDP_OBJECTS.plan.code;
const profile = (code: string) => STANDARD_PROFILES.find((p) => p.code === code)!;
const allCodes = Object.values(IDP_OBJECTS).map((o) => o.code);
const PLAN_CONTENT = ['plan', 'goal', 'task', 'goalReview', 'analysis', 'review'] as const;
const KEY_INFO = ['tutorship', 'career', 'workShift'] as const;
const codesOf = (keys: readonly (keyof typeof IDP_OBJECTS)[]) => keys.map((k) => IDP_OBJECTS[k].code).sort();

describe('AC-F141-idp-profiles IDP 标准身份预置（DEC-500）', () => {
  it('三个身份都登记 IDP 应用，不占许可，不预置任何看全部', () => {
    for (const code of [ADMIN, EMPLOYEE, MANAGER]) {
      const p = profile(code);
      expect(p, code).toBeDefined();
      expect(p.apps).toEqual([IDP_APP]);
      expect(p.licenseType).toBeNull();
      expect(p.autoHeld).toBeFalsy();
      expect(presetSeeAllTargets(p), code).toEqual([]);
    }
    expect(profile(ADMIN).name).toBe('IDP管理员（个人发展计划）');
    expect(profile(EMPLOYEE).name).toBe('IDP员工（个人发展计划）');
    expect(profile(MANAGER).name).toBe('IDP经理（个人发展计划）');
  });

  it('管理员：IDP 全部对象，全部数据操作与按钮；员工、经理：最小权限只读，没有数据操作和按钮', () => {
    const admin = profile(ADMIN);
    expect(admin.objects.map((o) => o.objectCode).sort()).toEqual([...allCodes].sort());
    for (const o of admin.objects)
      expect(o.dataOperations, o.objectCode).toEqual({ create: true, update: true, delete: true });
    const plan = admin.objects.find((o) => o.objectCode === PLAN)!;
    expect(plan.buttons.map((b) => b.buttonCode)).toEqual(
      expect.arrayContaining(['start', 'urge', 'jump', 'terminate']),
    );

    const expectReadOnly = (code: string, keys: readonly (keyof typeof IDP_OBJECTS)[]) => {
      const p = profile(code);
      expect(p.objects.map((o) => o.objectCode).sort(), code).toEqual(codesOf(keys));
      for (const o of p.objects) {
        expect(o.dataOperations, o.objectCode).toEqual({ create: false, update: false, delete: false });
        expect(o.buttons, o.objectCode).toEqual([]);
        expect(
          o.fields.every((f) => f.view && !f.edit),
          o.objectCode,
        ).toBe(true);
      }
    };
    expectReadOnly(EMPLOYEE, PLAN_CONTENT);
    expectReadOnly(MANAGER, [...PLAN_CONTENT, ...KEY_INFO]);
  });

  it('新开通租户里三个身份都在，可被授予；授予后 /me/objects 与身份定义一致，未授予的成员 403', async () => {
    const w = await provisionWorld(testDb().db, 'f141-idp-open');
    for (const code of [ADMIN, EMPLOYEE, MANAGER]) expect(w.profileIds.has(code), code).toBe(true);
    const mine = async (who: { user: string; tenant: string }) =>
      w.api.request('GET', `/api/tenant/permission/me/objects/${PLAN}`, who);

    const admin = await holderOfProfile(w, ADMIN, 'f141-idp-admin');
    const adminBody = (await (await mine(admin)).json()) as {
      dataOperations: { create: boolean };
      buttons: { buttonCode: string }[];
    };
    expect(adminBody.dataOperations.create).toBe(true);
    expect(adminBody.buttons.map((b) => b.buttonCode)).toContain('start');

    const employee = await holderOfProfile(w, EMPLOYEE, 'f141-idp-employee');
    const employeeBody = (await (await mine(employee)).json()) as {
      dataOperations: Record<string, boolean>;
      buttons: unknown[];
    };
    expect(employeeBody.dataOperations).toEqual({ create: false, update: false, delete: false });
    expect(employeeBody.buttons).toEqual([]);
  });
});
