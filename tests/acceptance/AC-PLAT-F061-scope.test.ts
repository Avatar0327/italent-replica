/**
 * F-061 PR-3：预置“看全部”的补装与对象目录指纹（方案 §3.1、§4.1、§4.4 第 3 步、§9；DEC-374）。
 * - D3 = A′（DEC-374②）：只给本批批准清单里的目标补“看全部”（盘点管理员 × TalentReview × 实体 × Settings / Category /
 *   Role / Field），租户关过的不补；以后新增目标逐次问用户才能加进批准清单。未批准目标不进授权项编码，新租户开通不受影响。
 * - D2 = A：租户保存对象权限时，请求带的对象目录指纹与服务端一致，面板上可见但未勾的项才算“已决定不授予”；
 *   不一致返回 409 CATALOG_CHANGED，不写任何行；不带指纹的旧客户端不作负向登记。
 * - setIdentityScope 锁序：身份行 → 范围锁，回补与租户保存看全部不再互等（T-20，真 PG）。
 * 覆盖 T-05（看全部部分）、T-15、T-20、T-21，以及批准清单 / 编码 / 指纹守卫。
 */
import {
  auditEvents,
  employmentCustomFieldObjects,
  eq,
  permissionIdentityScopes,
  permissionProfileFields,
  permissionScopeVersions,
  pgErrorCode,
  sql,
  withTenant,
} from '@italent/db';
import {
  type ObjectDefinition,
  objectCatalogDigest,
  presetSeeAllTargets,
  profileLedgerMarker,
  SEE_ALL_BACKFILL_APPROVED,
  seeAllGrantCode,
  STANDARD_GRANT_ENTRY,
  STANDARD_GRANT_CODES,
  STANDARD_GRANT_VERSION,
  STANDARD_PROFILES,
  type StandardProfile,
  standardGrantItems,
  unapprovedSeeAllTargets,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { scopeLockProbe, setIdentityScope } from '../../apps/api/src/modules/permission/scope-policy-service.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/registry.js';
import { recordLedger, registerManagedGrants } from '../../apps/api/src/seeds/grant-ledger.js';
import {
  BUTTON,
  expectWaitingOnLock,
  buttonCode,
  grantsInstalled,
  HR,
  legacyWorld,
  ledger,
  OBJ,
  OBJ_B,
  permissionOf,
  provisionWorld,
  revisionOf,
  runBackfill,
  withObject,
  withoutButton,
  type World,
} from './support/f061.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const TR = 'standard_talent_review_admin';
const TR_APP = 'TalentReview';
const APPROVED = ['Settings', 'Category', 'Role', 'Field'].map((name) => `${TR_APP}.${name}`);
/** DEC-384 追加批准的盘点目标。 */
const EXTRA_TR = ['Readiness', 'Matrix', 'CalcRule'].map((name) => `${TR_APP}.${name}`);
const seeAllCode = (target: string) => seeAllGrantCode(TR, TR_APP, 'entity', target);
const OBJECT = OBJ.objectCode;
const hrButton = buttonCode(HR.code, OBJECT, BUTTON);

const MATRIX = `${TR_APP}.Matrix`;
const PRESET_COUNT = STANDARD_PROFILES.flatMap(presetSeeAllTargets).length;

describe('AC-PLAT-F061 D3 批准清单守卫（DEC-374②、DEC-384）', () => {
  it('批准清单每行写身份、应用、种类、目标编码与 DEC 号：DEC-374② 的四个盘点设置对象 + DEC-384 的 32 个', () => {
    expect(SEE_ALL_BACKFILL_APPROVED).toHaveLength(36);
    const byDec = (dec: string) => SEE_ALL_BACKFILL_APPROVED.filter((a) => a.dec === dec);
    expect(byDec('DEC-374②')).toEqual(
      APPROVED.map((targetCode) => ({
        profileCode: TR,
        appCode: TR_APP,
        targetKind: 'entity',
        targetCode,
        dec: 'DEC-374②',
      })),
    );
    expect(byDec('DEC-384')).toHaveLength(32);
    expect(new Set(SEE_ALL_BACKFILL_APPROVED.map((a) => a.dec))).toEqual(new Set(['DEC-374②', 'DEC-384']));
    for (const a of SEE_ALL_BACKFILL_APPROVED) {
      expect(a.profileCode && a.appCode && a.targetCode, JSON.stringify(a)).toBeTruthy();
      expect(['entity', 'datasource']).toContain(a.targetKind);
    }
    const unique = new Set(
      SEE_ALL_BACKFILL_APPROVED.map((a) => `${a.profileCode}|${a.appCode}|${a.targetKind}|${a.targetCode}`),
    );
    expect(unique.size).toBe(36);
  });

  it('批准的目标就是身份定义里全部预置看全部的目标：unapprovedSeeAllTargets() 为空，看全部编码恰好 36 个', () => {
    expect(unapprovedSeeAllTargets()).toEqual([]);
    expect(PRESET_COUNT).toBe(SEE_ALL_BACKFILL_APPROVED.length);
    const seeAllCodes = STANDARD_GRANT_CODES.filter((code) => code.includes('/seeAll:'));
    const expected = SEE_ALL_BACKFILL_APPROVED.map((a) =>
      seeAllGrantCode(a.profileCode, a.appCode, a.targetKind, a.targetCode),
    );
    expect(seeAllCodes.sort()).toEqual(expected.sort());
  });

  it('以后新增、未批准的看全部目标不进授权项编码（夹具构造一个未批准目标），也不影响已批准的', () => {
    const base = STANDARD_PROFILES.find((p) => p.code === TR)!;
    const target = { appCode: TR_APP, targetKind: 'entity' as const, targetCode: `${TR_APP}.NotYetApproved` };
    const fixture = { ...base, seeAll: [...(base.seeAll ?? []), target] };
    expect(unapprovedSeeAllTargets([fixture])).toEqual([{ ...target, profileCode: TR }]);
    const codes = standardGrantItems([fixture]).map((item) => item.code);
    expect(codes).not.toContain(seeAllCode(target.targetCode));
    expect(codes).toEqual(standardGrantItems([base]).map((item) => item.code));
  });

  it('授权项编码集合变了：version 已加 1（DEC-384 起为 3）', () => {
    expect(STANDARD_GRANT_VERSION).toBeGreaterThanOrEqual(3);
  });

  it('新租户开通不受影响：全部预置看全部行照旧写入；台账里每个已批准目标的看全部编码都记 install', async () => {
    const w = await provisionWorld(testDb().db, 'f061-scope-new');
    const profileId = w.profileIds.get(TR)!;
    const rows = await scopeRows(w, profileId);
    for (const target of [...APPROVED, ...EXTRA_TR])
      expect(
        rows.find((r) => r.targetCode === target),
        target,
      ).toMatchObject({ seeAll: true, revision: 1 });
    const now = await ledger(w);
    for (const a of SEE_ALL_BACKFILL_APPROVED)
      expect(now.get(seeAllGrantCode(a.profileCode, a.appCode, a.targetKind, a.targetCode)), a.targetCode).toBe(
        'install',
      );
    const report = await runBackfill(w);
    expect(report.items.every((i) => i.installed.length === 0)).toBe(true);
  });
});

describe('AC-PLAT-F061 对象目录指纹 objectCatalogDigest（方案 §3.1）', () => {
  const base: ObjectDefinition = {
    code: 'T.Obj',
    application: 'T',
    fields: [
      { code: 'a', system: false },
      { code: 'b', system: true },
    ],
    buttons: [
      { code: 'x', level: 'list', requires: 'create' },
      { code: 'y', level: 'detail', requires: 'update' },
    ],
  };
  it('16 位十六进制；与字段 / 按钮的书写顺序无关；对象目录里每个对象都能算', () => {
    const digest = objectCatalogDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(
      objectCatalogDigest({ ...base, fields: [...base.fields].reverse(), buttons: [...base.buttons].reverse() }),
    ).toBe(digest);
    for (const profile of STANDARD_PROFILES)
      for (const o of profile.objects)
        expect(objectCatalogDigest(objectCatalog.get(o.objectCode)!)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('字段、按钮、层级、依赖的数据操作、系统字段标记、应用、对象编码任一变化，指纹都变', () => {
    const digest = objectCatalogDigest(base);
    const variants: ObjectDefinition[] = [
      { ...base, fields: [...base.fields, { code: 'c', system: false }] },
      { ...base, fields: [{ code: 'a', system: true }, base.fields[1]!] },
      { ...base, buttons: [base.buttons[0]!] },
      { ...base, buttons: [{ ...base.buttons[0]!, level: 'detail' }, base.buttons[1]!] },
      { ...base, buttons: [{ ...base.buttons[0]!, requires: 'delete' }, base.buttons[1]!] },
      { ...base, application: 'U' },
      { ...base, code: 'T.Other' },
    ];
    for (const variant of variants) expect(objectCatalogDigest(variant)).not.toBe(digest);
  });
});

async function scopeRows(w: Pick<World, 'db' | 'tenantId'>, profileId: string) {
  return withTenant(w.db, w.tenantId, (tx) =>
    tx.select().from(permissionIdentityScopes).where(eq(permissionIdentityScopes.profileId, profileId)),
  );
}
/** 旧定义：盘点管理员没有这些目标的对象与预置看全部（模拟 #148 前开通的租户）。 */
const withoutTargets =
  (profileCode: string, targets: readonly string[]) =>
  (p: StandardProfile): StandardProfile =>
    p.code !== profileCode
      ? p
      : {
          ...p,
          objects: p.objects.filter((o) => !targets.includes(o.objectCode)),
          seeAll: p.seeAll?.filter((t) => !targets.includes(t.targetCode)),
        };
const closeScope = (w: World, profileId: string, target: string, ifMatch: number) =>
  w.api.request('PUT', `/api/tenant/permission/profiles/${profileId}/data-scopes/${TR_APP}`, {
    ...w.asAdmin,
    ifMatch,
    body: { targetKind: 'entity', targetCode: target, seeAll: false },
  });

describe('AC-PLAT-F061 T-05 看全部补装（D3 = A′，DEC-374②、DEC-384）', () => {
  it('盘点管理员缺新对象与预置看全部（含 DEC-384 追加批准的 Matrix）：对象、数据操作、字段、按钮、看全部补齐并写范围版本与审计；租户关掉后不恢复', async () => {
    const w = await legacyWorld(testDb().db, 'f061t05', [withoutTargets(TR, [...APPROVED, MATRIX])]);
    const profileId = w.profileIds.get(TR)!;
    const wanted = [...APPROVED, MATRIX];
    for (const target of wanted) expect(await permissionOf(w, TR, target)).toBeUndefined();
    expect((await scopeRows(w, profileId)).map((r) => r.targetCode)).not.toContain(MATRIX);

    const installed = grantsInstalled(await runBackfill(w));
    for (const target of wanted) {
      expect(installed).toContain(seeAllCode(target));
      expect(installed).toContain(`${TR}/${target}/op:view`);
      const object = (await permissionOf(w, TR, target))!;
      expect(object.fields.length).toBeGreaterThan(0);
    }
    expect(installed.filter((c) => c.includes('/seeAll:')).sort()).toEqual(wanted.map(seeAllCode).sort());
    // 范围行：see_all、revision 1，与开通预置同样留范围版本与审计
    const rows = await scopeRows(w, profileId);
    for (const target of wanted) {
      expect(rows.find((r) => r.targetCode === target)).toMatchObject({
        seeAll: true,
        revision: 1,
        targetKind: 'entity',
      });
      const versions = await withTenant(w.db, w.tenantId, (tx) =>
        tx
          .select()
          .from(permissionScopeVersions)
          .where(eq(permissionScopeVersions.objectId, `${profileId}:${TR_APP}:entity:${target}`)),
      );
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ revision: 1 });
    }
    expect((await ledger(w)).get(seeAllCode(MATRIX))).toBe('install');
    // 范围审计：每个补上的目标一条 permission_identity_scope.change（空 → see_all = true、revision 1）
    const audits = await withTenant(w.db, w.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'permission_identity_scope.change')),
    );
    for (const target of wanted) {
      const mine = audits.filter((a) => a.objectId === `${profileId}:${TR_APP}:entity:${target}`);
      expect(mine, target).toHaveLength(1);
      expect(mine[0]!.before).toMatchObject({ seeAll: false, revision: 0 });
      expect(mine[0]!.after).toMatchObject({ seeAll: true, revision: 1, targetCode: target });
    }

    // 租户关掉 Settings 的看全部 → 再回补不恢复
    const closed = await closeScope(w, profileId, APPROVED[0]!, 1);
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect(grantsInstalled(await runBackfill(w))).toEqual([]);
    expect((await scopeRows(w, profileId)).find((r) => r.targetCode === APPROVED[0])).toMatchObject({
      seeAll: false,
      revision: 2,
    });
    // DEC-384 追加批准的 Matrix 同样：租户关过的不恢复
    expect((await closeScope(w, profileId, MATRIX, 1)).status).toBe(200);
    expect(grantsInstalled(await runBackfill(w))).toEqual([]);
    expect((await scopeRows(w, profileId)).find((r) => r.targetCode === MATRIX)).toMatchObject({
      seeAll: false,
      revision: 2,
    });
  });

  it('范围行已存在但 see_all=false（租户在回补前关过）：不可装，不覆盖', async () => {
    const w = await legacyWorld(testDb().db, 'f061t05b', [withoutTargets(TR, [...APPROVED])]);
    const profileId = w.profileIds.get(TR)!;
    // 租户在回补之前先建了一条关闭的范围行（对象行仍缺）
    const closed = await w.api.request('PUT', `/api/tenant/permission/profiles/${profileId}/data-scopes/${TR_APP}`, {
      ...w.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'entity', targetCode: APPROVED[1]!, seeAll: false },
    });
    expect(closed.status, await closed.clone().text()).toBe(200);
    const installed = grantsInstalled(await runBackfill(w));
    expect(installed).not.toContain(seeAllCode(APPROVED[1]!));
    expect(installed).toContain(seeAllCode(APPROVED[0]!));
    expect((await scopeRows(w, profileId)).find((r) => r.targetCode === APPROVED[1])).toMatchObject({
      seeAll: false,
      revision: 1,
    });
  });
});

describe('AC-PLAT-F061 T-15 / T-21 D2 = A：对象目录指纹', () => {
  /** 台账里已有 HR 的 @ledger（模拟已接管，之后目录新增了 BUTTON）；旧定义缺 OBJ 的 BUTTON 和 OBJ_B 的第一个按钮。 */
  async function takenOver(label: string) {
    const w = await legacyWorld(testDb().db, label, [
      withObject(HR.code, OBJECT, withoutButton(BUTTON)),
      withObject(HR.code, OBJ_B.objectCode, withoutButton(OBJ_B.buttons[0]!)),
    ]);
    await withTenant(w.db, w.tenantId, (tx) =>
      recordLedger(tx, {
        entry: STANDARD_GRANT_ENTRY,
        codes: [profileLedgerMarker(HR.code)],
        source: 'install',
        commandId: null,
        now: new Date(),
      }),
    );
    return w;
  }
  const detail = async (w: World, profileId: string) =>
    (await (await w.api.request('GET', `/api/tenant/permission/profiles/${profileId}`, w.asAdmin)).json()) as {
      revision: number;
      objects: { objectCode: string; catalogDigest: string }[];
    };
  const save = async (
    w: World,
    digest: string | undefined,
    options: { extraFields?: { fieldCode: string; view: boolean; edit: boolean }[]; catalogFieldsOnly?: boolean } = {},
  ) => {
    const profileId = w.profileIds.get(HR.code)!;
    const current = (await detail(w, profileId)).objects.find((o) => o.objectCode === OBJECT)!;
    const { objectCode: _o, catalogDigest: _d, ...rest } = current as typeof current & Record<string, unknown>;
    const known = new Set(objectCatalog.get(OBJECT)!.fields.map((f) => f.code));
    const fields = (rest.fields as { fieldCode: string; view: boolean; edit: boolean }[]).filter(
      (f) => !options.catalogFieldsOnly || known.has(f.fieldCode),
    );
    return w.api.request('PUT', `/api/tenant/permission/profiles/${profileId}/objects/${OBJECT}`, {
      ...w.asAdmin,
      ifMatch: (await detail(w, profileId)).revision,
      body: {
        ...rest,
        fields: [...fields, ...(options.extraFields ?? [])],
        ...(digest ? { catalogDigest: digest } : {}),
      },
    });
  };

  it('GET 详情每个对象带 catalogDigest，等于服务端按解析后的对象定义算出的指纹', async () => {
    const w = await takenOver('f061t15a');
    const got = await detail(w, w.profileIds.get(HR.code)!);
    for (const o of got.objects) expect(o.catalogDigest, o.objectCode).toMatch(/^[0-9a-f]{16}$/);
    const mine = got.objects.find((o) => o.objectCode === OBJECT)!;
    expect(mine.catalogDigest).toBe(objectCatalogDigest(objectCatalog.get(OBJECT)!));
  });

  it('T-15 带一致指纹保存：面板上可见但未勾的 BUTTON 算拒绝，回补不补；没保存过的对象缺项仍补', async () => {
    const w = await takenOver('f061t15b');
    const profileId = w.profileIds.get(HR.code)!;
    const digest = (await detail(w, profileId)).objects.find((o) => o.objectCode === OBJECT)!.catalogDigest;
    const res = await save(w, digest);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await ledger(w)).get(hrButton)).toBe('tenant_saved');
    const installed = grantsInstalled(await runBackfill(w));
    expect(installed).not.toContain(hrButton);
    expect(installed).toContain(buttonCode(HR.code, OBJ_B.objectCode, OBJ_B.buttons[0]!));
    expect((await permissionOf(w, HR.code, OBJECT))!.buttons.some((b) => b.buttonCode === BUTTON.buttonCode)).toBe(
      false,
    );
  });

  it('T-15 同一对象保存之后目录新增的项：保存时不在面板上，不记为拒绝，之后仍算缺失', async () => {
    const w = await takenOver('f061t15c');
    const profileId = w.profileIds.get(HR.code)!;
    const future = `${HR.code}/${OBJECT}/button:futureButton@detail`;
    // 本登记项管的编码随发版增长：保存时只有 BUTTON，保存之后目录才新增 futureButton
    let managed = [hrButton];
    registerManagedGrants({
      entry: 'test/growing',
      profileCode: HR.code,
      profileSource: 'standard',
      codesFor: (objectCode) => (objectCode === OBJECT ? managed : []),
    });
    const digest = (await detail(w, profileId)).objects.find((o) => o.objectCode === OBJECT)!.catalogDigest;
    const res = await save(w, digest);
    expect(res.status, await res.clone().text()).toBe(200);
    managed = [hrButton, future];
    const mine = await ledger(w, 'test/growing');
    expect(mine.get(hrButton)).toBe('tenant_saved');
    expect(mine.has(future)).toBe(false);
    // 真实登记项：同一次保存只拒绝了当时可见的 BUTTON，没保存过的对象缺项仍补
    const installed = grantsInstalled(await runBackfill(w));
    expect(installed).not.toContain(hrButton);
    expect(installed).toContain(buttonCode(HR.code, OBJ_B.objectCode, OBJ_B.buttons[0]!));
  });

  it('T-21 目录失配优先于权限语义校验：旧指纹 + 目录里已不存在的字段 → 409 CATALOG_CHANGED；指纹一致的同一请求 → 400', async () => {
    const w = await takenOver('f061t21d');
    const profileId = w.profileIds.get(HR.code)!;
    const digest = (await detail(w, profileId)).objects.find((o) => o.objectCode === OBJECT)!.catalogDigest;
    const gone = [{ fieldCode: 'removed_in_new_release', view: true, edit: false }];
    const before = [await revisionOf(w, HR.code), await permissionOf(w, HR.code, OBJECT), await ledger(w)];
    const stale = await save(w, '0123456789abcdef', { extraFields: gone });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('CATALOG_CHANGED');
    const invalid = await save(w, digest, { extraFields: gone });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    expect([await revisionOf(w, HR.code), await permissionOf(w, HR.code, OBJECT), await ledger(w)]).toEqual(before);
  });

  it('T-21 不带指纹的旧客户端：只做保存前后授予的登记，未展示的新项随后仍被补', async () => {
    const w = await takenOver('f061t21a');
    const res = await save(w, undefined);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await ledger(w)).has(hrButton)).toBe(false);
    expect(grantsInstalled(await runBackfill(w))).toContain(hrButton);
  });

  it('T-21 旧指纹保存：409 CATALOG_CHANGED，不写任何行（权限、revision、台账都不变）', async () => {
    const w = await takenOver('f061t21b');
    const before = [await revisionOf(w, HR.code), await permissionOf(w, HR.code, OBJECT), await ledger(w)];
    const res = await save(w, '0123456789abcdef');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CATALOG_CHANGED');
    expect([await revisionOf(w, HR.code), await permissionOf(w, HR.code, OBJECT), await ledger(w)]).toEqual(before);
  });

  it('T-21 租户追加扩展字段后指纹变化：旧指纹 409，刷新取新指纹后可保存；扩展字段超限（含既存扩展字段授权）时 GET 与 PUT 指纹一致、可保存', async () => {
    const w = await takenOver('f061t21c');
    const profileId = w.profileIds.get(HR.code)!;
    const digestOf = async () =>
      (await detail(w, profileId)).objects.find((o) => o.objectCode === OBJECT)!.catalogDigest;
    const old = await digestOf();
    const addFields = (count: number, from: number) =>
      withTenant(w.db, w.tenantId, (tx) =>
        tx
          .insert(employmentCustomFieldObjects)
          .values(
            Array.from({ length: count }, (_, i) => ({
              tenantId: w.tenantId,
              objectType: 'contract' as const,
              code: `ext_${from + i}`,
              name: `扩展${from + i}`,
              valueType: 'text' as const,
            })),
          )
          .returning({ id: employmentCustomFieldObjects.id }),
      );
    const [extension] = await addFields(1, 0);
    // 既存的扩展字段授权（custom:<id>）：超限后它不在扩展目录里，客户端只提交目录字段
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.insert(permissionProfileFields).values({
        tenantId: w.tenantId,
        profileId,
        objectCode: OBJECT,
        fieldCode: `custom:${extension!.id}`,
        canView: true,
        canEdit: true,
      }),
    );
    const fresh = await digestOf();
    expect(fresh).not.toBe(old);
    expect((await save(w, old)).status).toBe(409);
    expect((await save(w, fresh)).status).toBe(200);

    // 超过上限：扩展目录不含租户字段，指纹退回目录本身；GET 与 PUT 同一函数，口径一致
    await addFields(1001, 1);
    const capped = await digestOf();
    expect(capped).toBe(objectCatalogDigest(objectCatalog.get(OBJECT)!));
    const res = await save(w, capped, { catalogFieldsOnly: true });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe.skipIf(!realPostgres)('AC-PLAT-F061 T-20 回补补看全部 × setIdentityScope 双向交错（真 PG）', () => {
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
  };
  const write = (w: World) => ({
    tenantId: w.tenantId,
    actorUserId: null,
    now: new Date(),
    commandId: `hold-${w.tenantId}`,
  });
  const missing = [withoutTargets(TR, [...APPROVED])];

  it('租户先提交：回补读到范围行，不覆盖，不出现 40P01', async () => {
    const w = await legacyWorld(testDb().db, 'f061t20a', missing);
    const profileId = w.profileIds.get(TR)!;
    const hold = gate();
    const started = gate();
    const tenant = withTenant(w.db, w.tenantId, async (tx) => {
      await setIdentityScope(
        tx,
        { tenantId: w.tenantId, userId: w.asAdmin.user, now: new Date(), commandId: 'tenant-1' },
        { profileId, appCode: TR_APP, targetKind: 'entity', targetCode: APPROVED[0]! },
        false,
        0,
      );
      started.open();
      await hold.opened;
    });
    await started.opened;
    const filling = runBackfill(w);
    await expectWaitingOnLock(w.db, filling);
    hold.open();
    await tenant;
    const installed = grantsInstalled(await filling);
    expect(installed).not.toContain(seeAllCode(APPROVED[0]!));
    expect(installed).toContain(seeAllCode(APPROVED[1]!));
    expect((await scopeRows(w, profileId)).find((r) => r.targetCode === APPROVED[0])).toMatchObject({
      seeAll: false,
      revision: 1,
    });
  });

  /** 另开一个连接试着锁同一条身份行（NOWAIT）：55P03 说明该行已被别的事务持锁。 */
  const identityRowLocked = (w: World, profileId: string) =>
    w.db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenantId}, true)`);
        await tx.execute(sql`SELECT id FROM permission_profiles WHERE id = ${profileId}::uuid FOR UPDATE NOWAIT`);
      })
      .then(
        () => false,
        (error: unknown) => pgErrorCode(error) === '55P03',
      );
  /** 让第一个走到“取范围锁之前”的事务停在探针处，直到 release.open()。 */
  const pauseBeforeScopeLock = () => {
    const reached = gate();
    const release = gate();
    scopeLockProbe.beforeScopeLock = async () => {
      scopeLockProbe.beforeScopeLock = undefined;
      reached.open();
      await release.opened;
    };
    return { reached: reached.opened, release };
  };

  it('交错点在“已持身份行锁、尚未取范围锁”之间（租户一侧）：身份行已被锁住，回补在身份行上等待；旧锁序在此处没持身份行锁，会被检出', async () => {
    const w = await legacyWorld(testDb().db, 'f061t20c', missing);
    const profileId = w.profileIds.get(TR)!;
    const pause = pauseBeforeScopeLock();
    try {
      const saving = closeScope(w, profileId, APPROVED[0]!, 0);
      await pause.reached;
      expect(await identityRowLocked(w, profileId)).toBe(true);
      const filling = runBackfill(w);
      await expectWaitingOnLock(w.db, filling);
      pause.release.open();
      expect((await saving).status).toBe(200);
      const installed = grantsInstalled(await filling);
      expect(installed).not.toContain(seeAllCode(APPROVED[0]!));
      expect(installed).toContain(seeAllCode(APPROVED[1]!));
    } finally {
      scopeLockProbe.beforeScopeLock = undefined;
      pause.release.open();
    }
  });

  it('交错点在“已持身份行锁、尚未取范围锁”之间（回补一侧）：身份行已被锁住，租户保存看全部在身份行上等待，之后按范围 revision 409', async () => {
    const w = await legacyWorld(testDb().db, 'f061t20d', missing);
    const profileId = w.profileIds.get(TR)!;
    const pause = pauseBeforeScopeLock();
    try {
      const filling = runBackfill(w);
      await pause.reached;
      expect(await identityRowLocked(w, profileId)).toBe(true);
      const saving = closeScope(w, profileId, APPROVED[0]!, 0);
      await expectWaitingOnLock(w.db, saving);
      pause.release.open();
      expect(grantsInstalled(await filling)).toContain(seeAllCode(APPROVED[0]!));
      const res = await saving;
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
    } finally {
      scopeLockProbe.beforeScopeLock = undefined;
      pause.release.open();
    }
  });

  it('回补先提交：租户按范围 revision 0 保存返回 409，刷新后（revision 1）可关闭', async () => {
    const w = await legacyWorld(testDb().db, 'f061t20b', missing);
    const profileId = w.profileIds.get(TR)!;
    const hold = gate();
    const started = gate();
    const filling = withTenant(w.db, w.tenantId, async (tx) => {
      const report = await installMissingSeeds(tx, write(w), { modules: ['permission'] });
      started.open();
      await hold.opened;
      return report;
    });
    await started.opened;
    const saving = closeScope(w, profileId, APPROVED[0]!, 0);
    await expectWaitingOnLock(w.db, saving);
    hold.open();
    await filling;
    const res = await saving;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
    expect((await closeScope(w, profileId, APPROVED[0]!, 1)).status).toBe(200);
  });
});
