/**
 * F-061 PR-2：标准身份授权补装（docs/08_设计/F-061_标准身份授权补装_方案.md §3.2、§4、§7.2）。
 * 平台经 POST /api/platform/tenants/:id/seeds/backfill 补 permission 模块的两个登记项：
 * standard-profiles（缺整个身份，沿用 #117 口径）与 standard-profile-grants（已装身份上缺的应用 / 对象 / 数据操作 /
 * 字段 / 按钮）。核心规则：缺失 = 当前没有 ∧ 台账没有，所以租户撤销过的不会被补回；手工同编码身份一律不碰。
 * 覆盖 T-01～T-04、T-06、T-07、T-10、T-11、T-17、T-19、T-23（首次接管 T-08/09/18 见 takeover，并发见 concurrency-pg）。
 */
import { randomUUID } from 'node:crypto';
import {
  auditEvents,
  employmentCustomFieldObjects,
  eq,
  permissionProfileFields,
  platformAuditEvents,
  withTenant,
} from '@italent/db';
import { profileLedgerMarker, STANDARD_GRANT_CODES, STANDARD_GRANT_ENTRY, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerManagedGrants, recordTenantSave, recordLedger } from '../../apps/api/src/seeds/grant-ledger.js';
import { PLATFORM } from './support/platform-api.js';
import {
  BUTTON,
  buttonCode,
  fieldCode,
  FIELD,
  grantsInstalled,
  HR,
  legacyWorld,
  ledger,
  OBJ,
  OBJ_B,
  OTHER_BUTTON,
  permissionOf,
  provisionWorld,
  putObject,
  revisionOf,
  runBackfill,
  withObject,
  withoutButton,
  withoutFieldEdit,
  type World,
} from './support/f061.js';

const testDb = useTestDb();
const OBJECT = OBJ.objectCode;
const hrButton = buttonCode(HR.code, OBJECT, BUTTON);
const hrFieldEdit = fieldCode(HR.code, OBJECT, FIELD, 'edit');
/** 旧定义里 HR 的 OBJ 缺 BUTTON 按钮和 FIELD 的编辑。 */
const missingTwo = [
  withObject(HR.code, OBJECT, withoutButton(BUTTON)),
  withObject(HR.code, OBJECT, withoutFieldEdit(FIELD)),
];
const auditsOf = (w: Pick<World, 'db' | 'tenantId'>, action: string) =>
  withTenant(w.db, w.tenantId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, action)));
const stateOf = async (w: World) =>
  Promise.all(
    STANDARD_PROFILES.map(async (p) => [
      p.code,
      await revisionOf(w, p.code),
      await Promise.all(p.objects.map((o) => permissionOf(w, p.code, o.objectCode))),
    ]),
  );

describe('AC-PLAT-F061 T-01 新租户开通后回补无缺失', () => {
  it('开通 → 首次 seeds/backfill：permission 两项 installed 为空；台账与权限表、身份 revision 不变', async () => {
    const w = await provisionWorld(testDb().db, 'f061-t01');
    const ledgerBefore = await ledger(w);
    const stateBefore = await stateOf(w);
    const report = await runBackfill(w);
    expect(report.items.map((i) => `${i.module}/${i.key}`)).toEqual([
      'permission/standard-profiles',
      'permission/standard-profile-grants',
    ]);
    expect(report.items.every((i) => i.installed.length === 0)).toBe(true);
    expect(report.items[1]!.existing).toBe(STANDARD_GRANT_CODES.length);
    expect(await ledger(w)).toEqual(ledgerBefore);
    expect(await stateOf(w)).toEqual(stateBefore);
    expect(await auditsOf(w, 'permission_profile.backfill_grants')).toEqual([]);
  });
});

describe('AC-PLAT-F061 T-02 幂等', () => {
  it('同一命令 ID 重放返回原结果；不同命令 ID 重复回补不新增权限行、台账行、业务审计，revision 不变', async () => {
    const w = await legacyWorld(testDb().db, 'f061t02', [withObject(HR.code, OBJECT, withoutButton(BUTTON))]);
    const key = randomUUID();
    const first = await runBackfill(w, undefined, key);
    expect(grantsInstalled(first)).toEqual([hrButton]);
    const replay = await runBackfill(w, undefined, key);
    expect(replay).toEqual(first);

    const audits = (await auditsOf(w, 'permission_profile.backfill_grants')).length;
    const ledgerRows = (await ledger(w)).size;
    const state = await stateOf(w);
    const again = await runBackfill(w);
    expect(again.items.every((i) => i.installed.length === 0)).toBe(true);
    expect((await auditsOf(w, 'permission_profile.backfill_grants')).length).toBe(audits);
    expect((await ledger(w)).size).toBe(ledgerRows);
    expect(await stateOf(w)).toEqual(state);
  });
});

describe('AC-PLAT-F061 T-03 租户撤销过的不补', () => {
  it('开通 → 租户关字段查看、关字段编辑、去掉按钮 → 回补：都不恢复', async () => {
    const w = await provisionWorld(testDb().db, 'f061t03');
    const second = OBJ.fields.filter((f) => f.edit)[1]!.fieldCode;
    const res = await putObject(w, w.profileIds.get(HR.code)!, OBJECT, (o) => ({
      ...o,
      fields: o.fields.map((f) =>
        f.fieldCode === FIELD ? { ...f, view: false, edit: false } : f.fieldCode === second ? { ...f, edit: false } : f,
      ),
      buttons: o.buttons.filter((b) => b.buttonCode !== OTHER_BUTTON.buttonCode),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    const saved = await permissionOf(w, HR.code, OBJECT);
    const report = await runBackfill(w);
    expect(grantsInstalled(report)).toEqual([]);
    expect(await permissionOf(w, HR.code, OBJECT)).toEqual(saved);
  });
});

describe('AC-PLAT-F061 T-04 目录新增的项补一次，撤销后不再补', () => {
  it('旧版本升级夹具缺按钮与字段编辑 → 回补补上、记 install、写 backfill_grants；租户撤销 → 再回补不恢复', async () => {
    const w = await legacyWorld(testDb().db, 'f061t04', missingTwo);
    const revision = await revisionOf(w, HR.code);
    const first = await runBackfill(w);
    expect(grantsInstalled(first).sort()).toEqual([hrButton, hrFieldEdit].sort());
    const installed = await permissionOf(w, HR.code, OBJECT);
    expect(installed!.buttons.some((b) => b.buttonCode === BUTTON.buttonCode)).toBe(true);
    expect(installed!.fields.find((f) => f.fieldCode === FIELD)).toMatchObject({ view: true, edit: true });
    expect(await revisionOf(w, HR.code)).toBe(revision + 1);
    const ledgerNow = await ledger(w);
    expect(ledgerNow.get(hrButton)).toBe('install');
    expect(ledgerNow.get(hrFieldEdit)).toBe('install');
    const audits = await auditsOf(w, 'permission_profile.backfill_grants');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.objectId).toBe(w.profileIds.get(HR.code));

    const revoked = await putObject(w, w.profileIds.get(HR.code)!, OBJECT, (o) => ({
      ...o,
      fields: o.fields.map((f) => (f.fieldCode === FIELD ? { ...f, edit: false } : f)),
      buttons: o.buttons.filter((b) => b.buttonCode !== BUTTON.buttonCode),
    }));
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const afterRevoke = await permissionOf(w, HR.code, OBJECT);
    expect(grantsInstalled(await runBackfill(w))).toEqual([]);
    expect(await permissionOf(w, HR.code, OBJECT)).toEqual(afterRevoke);
  });
});

describe('AC-PLAT-F061 T-06 手工同编码身份一律不碰', () => {
  it('租户手工建了同编码身份（CODE_TAKEN）：其应用 / 对象 / 字段 / 按钮 / revision 逐字不变，编码全计入 existing，台账无记录', async () => {
    const code = 'standard_hr_specialist';
    const w = await legacyWorld(testDb().db, 'f061t06', [], [code]);
    const created = await w.api.request('POST', '/api/tenant/permission/profiles', {
      ...w.asAdmin,
      body: { code, name: '租户手工建的同编码', apps: ['TenantBase'], licenseType: null },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const manual = (await created.json()) as { id: string };
    const full = {
      dataOperations: { create: false, update: false, delete: false },
      fields: [{ fieldCode: FIELD, view: true, edit: false }],
      buttons: [],
    };
    const saved = await w.api.request('PUT', `/api/tenant/permission/profiles/${manual.id}/objects/${OBJECT}`, {
      ...w.asAdmin,
      ifMatch: 1,
      body: full,
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const wManual: World = { ...w, profileIds: new Map([...w.profileIds, [code, manual.id]]) };
    const before = [await revisionOf(wManual, code), await permissionOf(wManual, code, OBJECT)];

    const report = await runBackfill(w);
    expect(report.items[0]!.installed).not.toContain(code);
    expect(grantsInstalled(report).some((c) => c.startsWith(`${code}/`))).toBe(false);
    const total = report.items[1]!;
    expect(total.existing + total.installed.length).toBe(STANDARD_GRANT_CODES.length);
    expect([await revisionOf(wManual, code), await permissionOf(wManual, code, OBJECT)]).toEqual(before);
    expect([...(await ledger(w)).keys()].some((c) => c.startsWith(`${code}/`))).toBe(false);
  });
});

describe('AC-PLAT-F061 T-07 旧路由与 seeds/backfill 衔接', () => {
  it('旧路由新装全部标准身份后，seeds/backfill 两项都无缺失', async () => {
    const { db } = testDb();
    const w = await legacyWorld(
      db,
      'f061t07',
      [],
      STANDARD_PROFILES.map((p) => p.code),
    );
    const old = await w.api.request('POST', `${PLATFORM}/tenants/${w.tenantId}/standard-profiles/backfill`, {
      user: w.operator.id,
      body: {},
    });
    expect(old.status, await old.clone().text()).toBe(200);
    expect(((await old.json()) as { installed: string[] }).installed).toHaveLength(STANDARD_PROFILES.length);
    const report = await runBackfill(w);
    expect(report.items.every((i) => i.installed.length === 0)).toBe(true);
  });
});

describe('AC-PLAT-F061 T-10 审计', () => {
  it('每个受影响身份一条 backfill_grants，before / after 只含受影响对象；平台审计一条汇总', async () => {
    const other = STANDARD_PROFILES.find((p) => p.code === 'standard_org_system_admin')!;
    const w = await legacyWorld(testDb().db, 'f061t10', [
      withObject(HR.code, OBJECT, withoutButton(BUTTON)),
      withObject(other.code, OBJ_B.objectCode, withoutButton(OBJ_B.buttons[0]!)),
    ]);
    const key = randomUUID();
    await runBackfill(w, undefined, key);
    const audits = await auditsOf(w, 'permission_profile.backfill_grants');
    expect(audits.map((a) => a.objectId).sort()).toEqual(
      [w.profileIds.get(HR.code)!, w.profileIds.get(other.code)!].sort(),
    );
    for (const audit of audits) {
      const before = audit.before as { objects: { objectCode: string }[]; revision: number };
      const after = audit.after as { objects: { objectCode: string }[]; revision: number };
      const expected = audit.objectId === w.profileIds.get(HR.code) ? OBJECT : OBJ_B.objectCode;
      expect(before.objects.map((o) => o.objectCode)).toEqual([expected]);
      expect(after.objects.map((o) => o.objectCode)).toEqual([expected]);
      expect(after.revision).toBe(before.revision + 1);
    }
    const platform = await testDb()
      .db.select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.subjectTenantId, w.tenantId));
    expect(platform.filter((p) => p.action === 'tenant.seeds.backfill' && p.commandId === key)).toHaveLength(1);
  });
});

describe('AC-PLAT-F061 T-11 保存登记：租户授予过的项撤销后不补', () => {
  it('旧版本升级夹具缺按钮 → 租户手工授予 → 撤销 → 首次回补：不恢复', async () => {
    const w = await legacyWorld(testDb().db, 'f061t11', [withObject(HR.code, OBJECT, withoutButton(BUTTON))]);
    const profileId = w.profileIds.get(HR.code)!;
    const granted = await putObject(w, profileId, OBJECT, (o) => ({ ...o, buttons: [...o.buttons, BUTTON] }));
    expect(granted.status, await granted.clone().text()).toBe(200);
    const revoked = await putObject(w, profileId, OBJECT, (o) => ({
      ...o,
      buttons: o.buttons.filter((b) => b.buttonCode !== BUTTON.buttonCode),
    }));
    expect(revoked.status).toBe(200);
    const ledgerNow = await ledger(w);
    expect(ledgerNow.get(hrButton)).toBe('tenant_saved');
    expect(ledgerNow.get(`${HR.code}/${OBJECT}/@modified`)).toBe('tenant_saved');
    expect(grantsInstalled(await runBackfill(w))).toEqual([]);
    expect((await permissionOf(w, HR.code, OBJECT))!.buttons.some((b) => b.buttonCode === BUTTON.buttonCode)).toBe(
      false,
    );
  });
});

describe('AC-PLAT-F061 T-17 持续登记', () => {
  it('台账里只有 @ledger、没有授权项（绕过保存登记的已有授权）：下次回补记 adopted；撤销后不恢复', async () => {
    const w = await legacyWorld(testDb().db, 'f061t17');
    await withTenant(w.db, w.tenantId, (tx) =>
      recordLedger(tx, {
        entry: STANDARD_GRANT_ENTRY,
        codes: [profileLedgerMarker(HR.code)],
        source: 'install',
        commandId: null,
        now: new Date(),
      }),
    );
    expect(grantsInstalled(await runBackfill(w))).toEqual([]);
    const adopted = await ledger(w);
    const otherButton = buttonCode(HR.code, OBJECT, OTHER_BUTTON);
    expect(adopted.get(otherButton)).toBe('adopted');
    expect(adopted.get(hrFieldEdit)).toBe('adopted');
    expect(adopted.get(profileLedgerMarker(HR.code))).toBe('install');

    const revoked = await putObject(w, w.profileIds.get(HR.code)!, OBJECT, (o) => ({
      ...o,
      buttons: o.buttons.filter((b) => b.buttonCode !== OTHER_BUTTON.buttonCode),
    }));
    expect(revoked.status).toBe(200);
    expect(grantsInstalled(await runBackfill(w))).toEqual([]);
    expect(
      (await permissionOf(w, HR.code, OBJECT))!.buttons.some((b) => b.buttonCode === OTHER_BUTTON.buttonCode),
    ).toBe(false);
  });
});

describe('AC-PLAT-F061 T-19 租户扩展字段', () => {
  const extensionRows = (w: World, count: number) =>
    withTenant(w.db, w.tenantId, async (tx) => {
      const rows = await tx
        .insert(employmentCustomFieldObjects)
        .values(
          Array.from({ length: count }, (_, i) => ({
            tenantId: w.tenantId,
            objectType: 'contract' as const,
            code: `ext_${i}`,
            name: `扩展${i}`,
            valueType: 'text' as const,
          })),
        )
        .returning({ id: employmentCustomFieldObjects.id });
      const first = `custom:${rows[0]!.id}`;
      await tx.insert(permissionProfileFields).values({
        tenantId: w.tenantId,
        profileId: w.profileIds.get(HR.code)!,
        objectCode: OBJECT,
        fieldCode: first,
        canView: true,
        canEdit: true,
      });
      return first;
    });

  it.each([
    ['有一个扩展字段', 1],
    ['扩展字段超过上限（扩展目录不含租户字段）', 1001],
  ])('%s：目录新增的按钮补上，custom:<id> 行逐字保留，回补仍成功', async (_label, count) => {
    const w = await legacyWorld(testDb().db, `f061t19-${count}`, [withObject(HR.code, OBJECT, withoutButton(BUTTON))]);
    const extension = await extensionRows(w, count);
    const report = await runBackfill(w);
    expect(grantsInstalled(report)).toEqual([hrButton]);
    const after = await permissionOf(w, HR.code, OBJECT);
    expect(after!.fields.find((f) => f.fieldCode === extension)).toEqual({
      fieldCode: extension,
      view: true,
      edit: true,
    });
    expect(after!.buttons.some((b) => b.buttonCode === BUTTON.buttonCode)).toBe(true);
  });
});

describe('AC-PLAT-F061 T-23 受管授权登记', () => {
  it('手工身份（source=custom）和未登记身份保存对象权限不写台账；标准身份保存只写本登记项的行，多个登记项各记各的 entry', async () => {
    const { db } = testDb();
    const w = await legacyWorld(db, 'f061t23', [], ['standard_hr_specialist']);
    const created = await w.api.request('POST', '/api/tenant/permission/profiles', {
      ...w.asAdmin,
      body: { code: 'standard_hr_specialist', name: '手工同编码', apps: ['TenantBase'], licenseType: null },
    });
    const manual = (await created.json()) as { id: string };
    const plain = await w.api.request('POST', '/api/tenant/permission/profiles', {
      ...w.asAdmin,
      body: { code: `custom_${randomUUID().slice(0, 8)}`, name: '普通自定义', apps: ['TenantBase'], licenseType: null },
    });
    const custom = (await plain.json()) as { id: string };
    const full = {
      dataOperations: { create: false, update: false, delete: false },
      fields: [{ fieldCode: FIELD, view: true, edit: false }],
      buttons: [],
    };
    for (const id of [manual.id, custom.id]) {
      const res = await w.api.request('PUT', `/api/tenant/permission/profiles/${id}/objects/${OBJECT}`, {
        ...w.asAdmin,
        ifMatch: 1,
        body: full,
      });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    expect([...(await ledger(w)).keys()]).toEqual([]);

    // 标准身份保存：只写本登记项（permission/standard-profile-grants）
    const hrId = w.profileIds.get(HR.code)!;
    expect((await putObject(w, hrId, OBJECT, (o) => o)).status).toBe(200);
    expect((await ledger(w)).get(`${HR.code}/${OBJECT}/@modified`)).toBe('tenant_saved');
    expect((await ledger(w, 'test/managed')).size).toBe(0);

    // 另一个登记项也为这个标准身份登记后，一次保存各写各的 entry
    registerManagedGrants({
      entry: 'test/managed',
      profileCode: HR.code,
      profileSource: 'standard',
      codesFor: () => [hrButton],
    });
    expect((await putObject(w, hrId, OBJECT, (o) => o)).status).toBe(200);
    const mine = await ledger(w, 'test/managed');
    expect([...mine.keys()].sort()).toEqual([hrButton, `${HR.code}/${OBJECT}/@modified`].sort());
    expect(new Set(mine.values())).toEqual(new Set(['tenant_saved']));
    expect([...(await ledger(w)).keys()].includes(hrButton)).toBe(true);

    // 直接调用：自定义来源的身份、没有登记的身份编码都不写行
    await withTenant(db, w.tenantId, async (tx) => {
      const write = { tenantId: w.tenantId, now: new Date(), commandId: 'direct' };
      const perm = (await permissionOf(w, HR.code, OBJECT))!;
      await recordTenantSave(tx, write, { code: HR.code, source: 'custom' }, OBJECT, perm, perm);
      await recordTenantSave(tx, write, { code: 'nobody', source: 'standard' }, OBJECT, perm, perm);
    });
    expect((await ledger(w, 'test/managed')).size).toBe(2);
  });

  it('同一（登记项 × 身份 × 来源）不能重复登记', () => {
    expect(() =>
      registerManagedGrants({
        entry: STANDARD_GRANT_ENTRY,
        profileCode: HR.code,
        profileSource: 'standard',
        codesFor: () => [],
      }),
    ).toThrow(/已登记/);
  });
});
