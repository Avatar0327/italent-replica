/**
 * R3-T02 C1-2（AC-QL-presets）：三个预置身份进 STANDARD_PROFILES（DEC-331②，拆分方案 §5 C1-2、F-061 方案 §3.5 / §10）。
 * - 任职资格系统管理员：Qualification 应用的全部业务功能；
 * - 评定管理员：TEvaluation 应用的配置对象 + 流程对象；Qualification 里被评定引用的四个对象只读（🟡，DEC-352 查看权）；
 * - 评定专员：只含流程对象（评定过程 / 评定记录）。
 * 数据范围一律缺省为空（硬规则）：三个身份开通时不预置任何看全部。
 * 新租户开通即有；存量租户经平台回补（permission/standard-profiles 登记项）补齐，不覆盖租户手工建的同编码身份，
 * 租户撤销过的授权不被再次补回（F-061 台账）。员工身份（C1-2b，DEC-399）见 AC-QL-employee-profile。
 */
import {
  EVALUATION_FLOW_OBJECTS,
  EVALUATION_OBJECTS,
  QUALIFICATION_OBJECTS,
  STANDARD_GRANT_CODES,
  STANDARD_PROFILES,
} from '@italent/domain';
import { permissionIdentityScopes, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { describe, expect, it } from 'vitest';
import {
  backfill,
  grantsInstalled,
  legacyWorld,
  provisionWorld,
  putObject,
  runBackfill,
  type World,
} from './support/f061.js';
import { holderOfProfile } from './support/ql-presets.js';

const testDb = useTestDb();

const QL_ADMIN = 'standard_qualification_admin';
const EV_ADMIN = 'standard_evaluation_admin';
const EV_SPECIALIST = 'standard_evaluation_specialist';
const NEW_CODES = [QL_ADMIN, EV_ADMIN, EV_SPECIALIST] as const;

const flowCodes = Object.values(EVALUATION_FLOW_OBJECTS).map((o) => o.code);
const evalConfigCodes = Object.values(EVALUATION_OBJECTS).map((o) => o.code);
const qualificationCodes = Object.values(QUALIFICATION_OBJECTS).map((o) => o.code);
/** 评定引用类别、级别、指标、标准时要有对象查看权（设计 §5.2，DEC-352）；只读，不含写。 */
const referencedCodes = [
  QUALIFICATION_OBJECTS.category,
  QUALIFICATION_OBJECTS.level,
  QUALIFICATION_OBJECTS.target,
  QUALIFICATION_OBJECTS.standard,
].map((o) => o.code);

interface ProfileDetail {
  apps: string[];
  source: string;
  revision: number;
  objects: {
    objectCode: string;
    dataOperations: { create: boolean; update: boolean; delete: boolean };
    fields: { fieldCode: string; view: boolean; edit: boolean }[];
    buttons: { buttonCode: string; level: string }[];
  }[];
}
const detailOf = async (w: World, code: string): Promise<ProfileDetail> => {
  const res = await w.api.request('GET', `/api/tenant/permission/profiles/${w.profileIds.get(code)}`, w.asAdmin);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ProfileDetail;
};
const objectCodesOf = (detail: ProfileDetail) => detail.objects.map((o) => o.objectCode).sort();

describe('AC-QL-presets 新租户开通即有三个预置身份（DEC-331②）', () => {
  it('应用与对象：任职资格系统管理员 = Qualification 全部；评定管理员 = 配置 + 流程 + 四个只读引用对象；评定专员 = 仅流程（AC-QL-presets）', async () => {
    const w = await provisionWorld(testDb().db, 'ql-presets-open');
    for (const code of NEW_CODES) expect(w.profileIds.has(code), code).toBe(true);

    const ql = await detailOf(w, QL_ADMIN);
    expect(ql).toMatchObject({ apps: ['Qualification'], source: 'standard' });
    expect(objectCodesOf(ql)).toEqual([...qualificationCodes].sort());

    const ev = await detailOf(w, EV_ADMIN);
    expect([...ev.apps].sort()).toEqual(['Qualification', 'TEvaluation']);
    expect(objectCodesOf(ev)).toEqual([...evalConfigCodes, ...flowCodes, ...referencedCodes].sort());
    for (const code of referencedCodes) {
      const o = ev.objects.find((x) => x.objectCode === code)!;
      expect(o.dataOperations, `${code} 只读`).toEqual({ create: false, update: false, delete: false });
      expect(o.buttons, `${code} 无按钮`).toEqual([]);
    }

    const specialist = await detailOf(w, EV_SPECIALIST);
    expect(specialist.apps).toEqual(['TEvaluation']);
    expect(objectCodesOf(specialist)).toEqual([...flowCodes].sort());
  });

  it('完整权限矩阵：每个预置身份的每个对象，数据操作 / 字段 / 按钮都等于对象目录推出的期望值（AC-QL-presets，#203 P3）', async () => {
    const w = await provisionWorld(testDb().db, 'ql-presets-matrix');
    const FULL = 'full';
    const READONLY = 'readonly';
    // 期望值只从对象目录（对象自己的字段 / 按钮清单）推出，不读 STANDARD_PROFILES，避免“拿定义验定义”
    const expectedOf = (objectCode: string, mode: typeof FULL | typeof READONLY) => {
      const definition = objectCatalog.get(objectCode)!;
      const all = mode === FULL;
      return {
        dataOperations: { create: all, update: all, delete: all },
        fields: definition.fields
          .map((f) => ({ fieldCode: f.code, view: true, edit: all && !f.system }))
          .sort((a, b) => a.fieldCode.localeCompare(b.fieldCode)),
        buttons: all ? definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })).sort(byButton) : [],
      };
    };
    const byButton = (a: { buttonCode: string; level: string }, b: { buttonCode: string; level: string }) =>
      `${a.buttonCode}@${a.level}`.localeCompare(`${b.buttonCode}@${b.level}`);
    const matrix: Record<string, Record<string, typeof FULL | typeof READONLY>> = {
      [QL_ADMIN]: Object.fromEntries(qualificationCodes.map((code) => [code, FULL])),
      [EV_ADMIN]: {
        ...Object.fromEntries([...evalConfigCodes, ...flowCodes].map((code) => [code, FULL])),
        ...Object.fromEntries(referencedCodes.map((code) => [code, READONLY])),
      },
      [EV_SPECIALIST]: Object.fromEntries(flowCodes.map((code) => [code, FULL])),
    };
    for (const [profile, objects] of Object.entries(matrix)) {
      const detail = await detailOf(w, profile);
      expect(detail.objects.map((o) => o.objectCode).sort(), profile).toEqual(Object.keys(objects).sort());
      for (const permission of detail.objects) {
        const expected = expectedOf(permission.objectCode, objects[permission.objectCode]!);
        const actual = {
          dataOperations: permission.dataOperations,
          fields: [...permission.fields].sort((a, b) => a.fieldCode.localeCompare(b.fieldCode)),
          buttons: [...permission.buttons].sort(byButton),
        };
        expect(actual, `${profile} / ${permission.objectCode}`).toEqual(expected);
      }
    }
  });

  it('授予后的实际效果：评定专员能用流程对象的按钮，配置对象与任职资格对象 403；任职资格管理员反之（AC-QL-presets）', async () => {
    const w = await provisionWorld(testDb().db, 'ql-presets-effect');
    const specialist = await holderOfProfile(w, EV_SPECIALIST, 'ev-specialist');
    const qlAdmin = await holderOfProfile(w, QL_ADMIN, 'ql-admin');
    const buttonsOf = async (as: { user: string; tenant: string }, objectCode: string) => {
      const res = await w.api.request('GET', `/api/tenant/permission/me/objects/${objectCode}`, as);
      if (res.status !== 200) return res.status;
      return ((await res.json()) as { buttons: { buttonCode: string }[] }).buttons.map((b) => b.buttonCode).sort();
    };
    expect(await buttonsOf(specialist, EVALUATION_FLOW_OBJECTS.staffEvaluation.code)).toEqual(
      expect.arrayContaining(['nominate', 'publishResult', 'revoke']),
    );
    expect(await buttonsOf(specialist, EVALUATION_FLOW_OBJECTS.judgeRecord.code)).toContain('Abstain');
    expect(await buttonsOf(specialist, EVALUATION_OBJECTS.activityType.code)).toBe(403);
    expect(await buttonsOf(specialist, QUALIFICATION_OBJECTS.category.code)).toBe(403);

    expect(await buttonsOf(qlAdmin, QUALIFICATION_OBJECTS.category.code)).toContain('create');
    expect(await buttonsOf(qlAdmin, EVALUATION_FLOW_OBJECTS.staffEvaluation.code)).toBe(403);
  });

  it('数据范围缺省为空：三个预置身份开通时不带任何看全部 / 身份范围行（硬规则，不照继任 / 盘点预置字典看全部）（AC-QL-presets）', async () => {
    const w = await provisionWorld(testDb().db, 'ql-presets-scope');
    const rows = await withTenant(w.db, w.tenantId, (tx) => tx.select().from(permissionIdentityScopes));
    const ids = new Set(NEW_CODES.map((code) => w.profileIds.get(code)));
    expect(rows.filter((row) => ids.has(row.profileId))).toEqual([]);
  });
});

describe('AC-QL-presets 存量租户经平台回补补齐（permission/standard-profiles）', () => {
  it('补装缺失的三个身份；重复回补无副作用；revision 不变（AC-QL-presets）', async () => {
    const w = await legacyWorld(testDb().db, 'ql-presets-backfill', [], NEW_CODES);
    const first = await runBackfill(w);
    const installed = first.items.find((i) => i.key === 'standard-profiles')!.installed;
    expect([...installed].sort()).toEqual([...NEW_CODES].sort());

    const second = await runBackfill(w);
    expect(second.items.find((i) => i.key === 'standard-profiles')!.installed).toEqual([]);
    expect(grantsInstalled(second)).toEqual([]);
  });

  it('租户手工建过同编码身份：不装、不覆盖、不往里写授权（CODE_TAKEN）（AC-QL-presets）', async () => {
    const w = await legacyWorld(testDb().db, 'ql-presets-taken', [], NEW_CODES);
    const manual = await w.api.request('POST', '/api/tenant/permission/profiles', {
      ...w.asAdmin,
      body: { code: EV_SPECIALIST, name: '租户手工建的同编码', apps: ['TEvaluation'], licenseType: null },
    });
    expect(manual.status, await manual.clone().text()).toBe(201);
    const manualProfile = (await manual.json()) as { id: string; revision: number };

    const report = await runBackfill(w);
    const installed = report.items.find((i) => i.key === 'standard-profiles')!.installed;
    expect([...installed].sort()).toEqual([QL_ADMIN, EV_ADMIN].sort());

    const kept = (await (
      await w.api.request('GET', `/api/tenant/permission/profiles/${manualProfile.id}`, w.asAdmin)
    ).json()) as ProfileDetail;
    expect(kept).toMatchObject({ source: 'custom', revision: manualProfile.revision, objects: [] });
  });

  it('租户撤销过的授权不被再次补回：开通 → 租户去掉评定专员一个按钮 → 回补不恢复（AC-QL-presets）', async () => {
    const w = await provisionWorld(testDb().db, 'ql-presets-revoke');
    const objectCode = EVALUATION_FLOW_OBJECTS.staffEvaluation.code;
    const profileId = w.profileIds.get(EV_SPECIALIST)!;
    const saved = await putObject(w, profileId, objectCode, (o) => ({
      ...o,
      buttons: o.buttons.filter((b) => b.buttonCode !== 'nominate'),
    }));
    expect(saved.status, await saved.clone().text()).toBe(200);

    const report = await runBackfill(w);
    expect(grantsInstalled(report)).toEqual([]);
    const detail = await detailOf(w, EV_SPECIALIST);
    const current = detail.objects.find((o) => o.objectCode === objectCode)!;
    expect((current.buttons as { buttonCode: string }[]).map((b) => b.buttonCode)).not.toContain('nominate');
  });

  it('回补入口只认平台运营身份（租户管理员 403）（AC-QL-presets）', async () => {
    const w = await legacyWorld(testDb().db, 'ql-presets-denied', [], NEW_CODES);
    const res = await backfill({ ...w, operator: { id: w.asAdmin.user } });
    expect(res.status).toBe(403);
  });
});

describe('AC-QL-presets 守卫：目录变化必须同步 version / 指纹（F-061 方案 §3.4）', () => {
  it('授权项编码含三个新身份（AC-QL-presets）', () => {
    for (const code of NEW_CODES)
      expect(
        STANDARD_GRANT_CODES.some((grant) => grant.startsWith(`${code}/`)),
        code,
      ).toBe(true);
    // version 递增与指纹历史由 AC-PLAT-F061-grants 的“版本历史”守卫和 AC-QL-employee-profile 必测 11 证明
  });

  it('STANDARD_PROFILES 含员工身份且 autoHeld；其对象清单不含发展通道 / 任职资格标准（DEC-399，AC-QL-presets）', () => {
    const employee = STANDARD_PROFILES.find((p) => p.code === 'employee_self_service');
    expect(employee).toMatchObject({ autoHeld: true });
    const objectCodes = employee!.objects.map((o) => o.objectCode);
    expect(objectCodes).not.toContain(QUALIFICATION_OBJECTS.developmentChannel.code);
    expect(objectCodes).not.toContain(QUALIFICATION_OBJECTS.standard.code);
    expect(
      STANDARD_PROFILES.filter((p) => 'autoHeld' in p && p.autoHeld).map((p) => p.code),
      '只有员工身份是 autoHeld',
    ).toEqual(['employee_self_service']);
  });
});
