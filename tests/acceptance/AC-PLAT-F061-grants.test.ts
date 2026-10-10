/**
 * F-061 PR-1（契约 PR）：标准身份授权补装的台账与编码（docs/08_设计/F-061_标准身份授权补装_方案.md §3、§7.2）。
 * 覆盖 T-14（台账租户隔离与只追加）、T-16（编码 / 指纹守卫），以及 T-01、T-07 里 PR-1 就落地的“装入即记账”：
 * - 授权项编码唯一、可解析、可往返；只有身份定义授予的项才进编码；指纹与 version 匹配（目录变了守卫就失败）；
 * - seed_grant_ledger：租户 RLS、只追加（表属主也不能改删）、同一编码第一次登记的来源为准；
 * - 开通、旧路由补整个身份都走 installProfile，装入即记账；installProfileRows 只写权限行；
 * - 开通后各身份的权限表内容与身份定义逐项一致（拆分 installProfile 不改变落库结果）。
 * 补装、接管、保存登记属于 PR-2 / PR-3，不在本文件。
 */
import { createHash, randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import {
  eq,
  permissionProfileApps,
  permissionProfileButtons,
  permissionProfileFields,
  permissionProfileObjects,
  permissionProfiles,
  pgErrorCode,
  seedGrantLedger,
  sql,
  type Tx,
  withTenant,
} from '@italent/db';
import {
  grantCodesDigest,
  grantParentCode,
  objectModifiedMarker,
  parseGrantCode,
  profileLedgerMarker,
  STANDARD_GRANT_CODES,
  STANDARD_GRANT_DIGEST,
  STANDARD_GRANT_ENTRY,
  STANDARD_GRANT_VERSION,
  STANDARD_PROFILES,
  standardGrantItems,
  type StandardProfile,
  validateObjectPermission,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS } from '../../apps/api/src/errors.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { installProfileRows } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { lockTenantSeeds, readLedger, recordLedger } from '../../apps/api/src/seeds/grant-ledger.js';
import { sha256Hex } from '../../packages/domain/src/platform/sha256.js';
import { newUser, PLATFORM, provisioned, seedOperator } from './support/platform-api.js';
import { cmd, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const NOW = new Date('2026-10-10T08:00:00Z');

describe('AC-PLAT-F061 T-16 授权项编码与指纹守卫', () => {
  const items = standardGrantItems();

  it('编码唯一、可解析、往返不变；任何编码段里都不含分隔符', () => {
    expect(new Set(STANDARD_GRANT_CODES).size).toBe(STANDARD_GRANT_CODES.length);
    expect(items.map((item) => item.code)).toEqual([...STANDARD_GRANT_CODES]);
    for (const item of items) {
      const parsed = parseGrantCode(item.code);
      expect(parsed, item.code).toEqual(item);
    }
    for (const profile of STANDARD_PROFILES) {
      for (const object of profile.objects) {
        expect(object.objectCode).not.toMatch(/[/]/);
        for (const field of object.fields) expect(field.fieldCode).not.toMatch(/[/]/);
        for (const button of object.buttons) expect(button.buttonCode).not.toMatch(/[/@]/);
      }
    }
  });

  it('无法识别的编码返回 null，不抛错、不猜测', () => {
    for (const bad of ['', 'x', 'p/o/op:drop', 'p/o/field:f', 'p/o/field:f:x', 'p/o/button:b', 'p/app:', '/app:A'])
      expect(parseGrantCode(bad), bad).toBeNull();
  });

  it('标记编码不在授权项编码里，且可解析为标记', () => {
    const profile = STANDARD_PROFILES[0]!;
    const object = profile.objects[0]!.objectCode;
    expect(profileLedgerMarker(profile.code)).toBe(`${profile.code}/@ledger`);
    expect(objectModifiedMarker(profile.code, object)).toBe(`${profile.code}/${object}/@modified`);
    expect(parseGrantCode(profileLedgerMarker(profile.code))).toEqual({
      kind: 'ledger',
      code: `${profile.code}/@ledger`,
      profileCode: profile.code,
    });
    expect(parseGrantCode(objectModifiedMarker(profile.code, object))).toMatchObject({
      kind: 'modified',
      profileCode: profile.code,
      objectCode: object,
    });
    const codes = new Set(STANDARD_GRANT_CODES);
    expect(codes.has(profileLedgerMarker(profile.code))).toBe(false);
    expect(codes.has(objectModifiedMarker(profile.code, object))).toBe(false);
  });

  it('只有身份定义授予的项才进编码：只读身份无按钮 / 数据操作，系统字段无 edit，未授予的按钮不出现', () => {
    const manager = STANDARD_PROFILES.find((p) => p.code === 'standard_manager')!;
    const managerItems = standardGrantItems([manager]);
    expect(managerItems.some((i) => i.kind === 'button' || i.kind === 'op')).toBe(false);
    expect(managerItems.some((i) => i.kind === 'field' && i.mode === 'view')).toBe(true);
    expect(managerItems.some((i) => i.kind === 'field' && i.mode === 'edit')).toBe(false);

    for (const profile of STANDARD_PROFILES) {
      const granted = new Set(standardGrantItems([profile]).map((i) => i.code));
      for (const object of profile.objects) {
        const definition = objectCatalog.get(object.objectCode)!;
        for (const field of definition.fields.filter((f) => f.system))
          expect(granted.has(`${profile.code}/${object.objectCode}/field:${field.code}:edit`)).toBe(false);
        for (const button of definition.buttons) {
          const code = `${profile.code}/${object.objectCode}/button:${button.code}@${button.level}`;
          expect(granted.has(code), code).toBe(object.buttons.some((b) => b.buttonCode === button.code));
        }
      }
    }
    // 360 一般管理员排除的按钮不是增量（编码里没有）
    const general = STANDARD_PROFILES.find((p) => p.code === 'standard_360_general_admin')!;
    const excluded = general.objects.flatMap((o) =>
      (objectCatalog.get(o.objectCode)?.buttons ?? [])
        .filter((b) => !o.buttons.some((x) => x.buttonCode === b.code))
        .map((b) => `${general.code}/${o.objectCode}/button:${b.code}@${b.level}`),
    );
    expect(excluded.length).toBeGreaterThan(0);
    for (const code of excluded) expect(STANDARD_GRANT_CODES).not.toContain(code);
  });

  it('依赖关系：应用 → 对象查看 → 数据操作 / 字段查看 / 按钮；字段查看 → 字段编辑；应用没有父项', () => {
    const appOf = (objectCode: string) => objectCatalog.get(objectCode)?.application;
    const chain = (code: string) => {
      const out: string[] = [];
      for (let c: string | null = code; c; c = grantParentCode(c, appOf)) out.push(c);
      return out;
    };
    const p = STANDARD_PROFILES.find((x) => x.code === 'standard_hr_admin')!;
    const object = p.objects[0]!.objectCode;
    const edit = items.find(
      (i) => i.kind === 'field' && i.profileCode === p.code && i.objectCode === object && i.mode === 'edit',
    )!;
    expect(chain(edit.code).map((c) => parseGrantCode(c)!.kind)).toEqual(['field', 'field', 'object', 'app']);
    const button = items.find((i) => i.kind === 'button' && i.profileCode === p.code && i.objectCode === object)!;
    expect(chain(button.code).map((c) => parseGrantCode(c)!.kind)).toEqual(['button', 'object', 'app']);
    // 每个授权项的父项都是编码本身的一员；应用项的父项为空
    for (const item of items) {
      const parent = grantParentCode(item.code, appOf);
      if (item.kind === 'app') expect(parent).toBeNull();
      else expect(STANDARD_GRANT_CODES, item.code).toContain(parent);
    }
  });

  it('指纹与 version 匹配（目录变了：version +1 并更新 STANDARD_GRANT_DIGEST）', () => {
    expect(Number.isInteger(STANDARD_GRANT_VERSION) && STANDARD_GRANT_VERSION >= 1).toBe(true);
    expect(grantCodesDigest(STANDARD_GRANT_CODES), '目录变了：version +1 并更新 STANDARD_GRANT_DIGEST').toBe(
      STANDARD_GRANT_DIGEST,
    );
    // 与顺序无关；少一个编码指纹就变
    expect(grantCodesDigest([...STANDARD_GRANT_CODES].reverse())).toBe(STANDARD_GRANT_DIGEST);
    expect(grantCodesDigest(STANDARD_GRANT_CODES.slice(1))).not.toBe(STANDARD_GRANT_DIGEST);
  });

  it('版本历史：编码集合每变一次 version 必须递增（#203 P3，DEC-404）', () => {
    // 每次改动授权项编码集合：version +1，并在这里追加一行“version → 指纹”。只改指纹不改 version 时，这一行对不上而失败；
    // 只改 version 不改编码时，指纹与上一行相同而失败。合并前最后一次合 main 时，以 main 的最后一行为准再 +1（DEC-404）。
    const HISTORY: Record<number, string> = {
      7: 'de040eb38bfcd54a',
      8: '1892446da0d1f77c',
      // C1-2b（DEC-399）：新增员工身份 employee_self_service 的授权项
      9: '9805dbb4eadff84b',
    };
    expect(HISTORY[STANDARD_GRANT_VERSION], `version ${STANDARD_GRANT_VERSION} 没有登记指纹：追加一行`).toBe(
      STANDARD_GRANT_DIGEST,
    );
    const versions = Object.keys(HISTORY)
      .map(Number)
      .sort((a, b) => a - b);
    expect(versions[versions.length - 1], '当前 version 必须是历史里最大的').toBe(STANDARD_GRANT_VERSION);
    for (let i = 1; i < versions.length; i++)
      expect(HISTORY[versions[i]!], `version ${versions[i]} 与上一版指纹相同：编码没变就不该递增`).not.toBe(
        HISTORY[versions[i - 1]!],
      );
  });

  it('纯 TS 的 SHA-256 与 node:crypto 一致（含多块、中文、空串）', () => {
    for (const text of [
      '',
      'abc',
      '盘点管理员/TalentReview.Settings/op:view',
      'x'.repeat(55),
      'x'.repeat(56),
      'y'.repeat(1000),
      '😀 emoji 𠮷',
    ])
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('所有标准身份按对象目录校验通过（身份定义不引用未登记的对象 / 字段 / 按钮）', () => {
    for (const profile of STANDARD_PROFILES) {
      for (const permission of profile.objects) {
        const definition = objectCatalog.get(permission.objectCode);
        expect(definition, `${profile.code}/${permission.objectCode}`).toBeDefined();
        expect(validateObjectPermission(definition!, permission)).toEqual([]);
      }
    }
  });

  it('错误码 CATALOG_CHANGED 为 409（统一错误码，PR-3 使用）', () => {
    expect(ERROR_STATUS.CATALOG_CHANGED).toBe(409);
  });
});

/** 一个身份落库后的权限内容（应用、对象 × 数据操作、字段、按钮），与定义逐项比较。 */
async function storedContent(tx: Tx, profileId: string) {
  const [apps, objects, fields, buttons] = await Promise.all([
    tx.select().from(permissionProfileApps).where(eq(permissionProfileApps.profileId, profileId)),
    tx.select().from(permissionProfileObjects).where(eq(permissionProfileObjects.profileId, profileId)),
    tx.select().from(permissionProfileFields).where(eq(permissionProfileFields.profileId, profileId)),
    tx.select().from(permissionProfileButtons).where(eq(permissionProfileButtons.profileId, profileId)),
  ]);
  return {
    apps: apps.map((r) => r.appCode).sort(),
    objects: objects.map((r) => `${r.objectCode}:${r.canCreate}:${r.canUpdate}:${r.canDelete}`).sort(),
    fields: fields.map((r) => `${r.objectCode}/${r.fieldCode}:${r.canView}:${r.canEdit}`).sort(),
    buttons: buttons.map((r) => `${r.objectCode}/${r.buttonCode}@${r.level}`).sort(),
  };
}

function definedContent(profile: StandardProfile) {
  return {
    apps: [...profile.apps].sort(),
    objects: profile.objects
      .map((o) => `${o.objectCode}:${o.dataOperations.create}:${o.dataOperations.update}:${o.dataOperations.delete}`)
      .sort(),
    fields: profile.objects
      .flatMap((o) => o.fields.map((f) => `${o.objectCode}/${f.fieldCode}:${f.view}:${f.edit}`))
      .sort(),
    buttons: profile.objects.flatMap((o) => o.buttons.map((b) => `${o.objectCode}/${b.buttonCode}@${b.level}`)).sort(),
  };
}

const ledgerOf = (tenantId: string, entry = STANDARD_GRANT_ENTRY) =>
  withTenant(testDb().db, tenantId, (tx) => readLedger(tx, entry));
const expectedLedgerCodes = (profiles: readonly StandardProfile[] = STANDARD_PROFILES) =>
  [...standardGrantItems(profiles).map((i) => i.code), ...profiles.map((p) => profileLedgerMarker(p.code))].sort();

describe('AC-PLAT-F061 T-01 装入即记账：开通', () => {
  it('新租户开通：台账含全部标准授权项编码与每个身份的 @ledger（来源 install、同一命令 ID）；权限表与身份定义一致', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, 'ops-f061-prov');
    const admin = await newUser(db, 'admin-f061-prov');
    const exception = await newUser(db, 'exception-f061-prov');
    const result = await provisioned(api, operator, {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: exception.id,
      licenses: [{ licenseType: 'core_hr', quota: 10 }],
    });
    const tenantId = result.tenant.id;

    const ledger = await ledgerOf(tenantId);
    expect([...ledger.keys()].sort()).toEqual(expectedLedgerCodes());
    expect(new Set(ledger.values())).toEqual(new Set(['install']));
    const rows = await withTenant(db, tenantId, (tx) => tx.select().from(seedGrantLedger));
    expect(new Set(rows.map((r) => r.commandId)).size).toBe(1);
    expect(rows[0]!.commandId).toBeTruthy();
    expect(new Set(rows.map((r) => r.entry))).toEqual(new Set([STANDARD_GRANT_ENTRY]));
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([tenantId]));

    await withTenant(db, tenantId, async (tx) => {
      const stored = await tx.select().from(permissionProfiles);
      for (const profile of STANDARD_PROFILES) {
        const row = stored.find((p) => p.code === profile.code)!;
        expect(row.source).toBe('standard');
        expect(await storedContent(tx, row.id), profile.code).toEqual(definedContent(profile));
      }
    });
  });
});

describe('AC-PLAT-F061 T-07 旧路由补整个身份：装入即记账', () => {
  it('新装身份记 install；已装身份再补不新增台账行；租户手工同编码身份（CODE_TAKEN）不记账', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, 'ops-f061-legacy');
    const { tenant, user } = await seedTenantWithMember(db, 'f061legacy');
    await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: user.id }, cmd());
    const manual = await api.request('POST', '/api/tenant/permission/profiles', {
      user: user.id,
      tenant: tenant.id,
      body: { code: 'standard_manager', name: '租户手工建的同编码', apps: ['TenantBase'], licenseType: null },
    });
    expect(manual.status, await manual.clone().text()).toBe(201);

    const backfill = () =>
      api.request('POST', `${PLATFORM}/tenants/${tenant.id}/standard-profiles/backfill`, {
        user: operator.id,
        body: {},
      });
    const first = await backfill();
    expect(first.status, await first.clone().text()).toBe(200);
    const body = (await first.json()) as { installed: string[]; skipped: { code: string; reason: string }[] };
    expect(body.skipped).toEqual([{ code: 'standard_manager', reason: 'CODE_TAKEN' }]);

    const installedProfiles = STANDARD_PROFILES.filter((p) => p.code !== 'standard_manager');
    const ledger = await ledgerOf(tenant.id);
    expect([...ledger.keys()].sort()).toEqual(expectedLedgerCodes(installedProfiles));
    expect(new Set(ledger.values())).toEqual(new Set(['install']));
    expect([...ledger.keys()].some((code) => code.startsWith('standard_manager/'))).toBe(false);

    const second = await backfill();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { installed: string[] }).installed).toEqual([]);
    expect([...(await ledgerOf(tenant.id)).keys()].sort()).toEqual(expectedLedgerCodes(installedProfiles));
  });

  it('installProfileRows 只写权限行与审计，不写台账（F-061 上线前租户夹具）', async () => {
    const { db } = testDb();
    const { tenant } = await seedTenantWithMember(db, 'f061rows');
    const profile = STANDARD_PROFILES.find((p) => p.code === 'standard_hr_specialist')!;
    const write = { tenantId: tenant.id, actorUserId: null, now: NOW, commandId: 'f061-rows' };
    const installed = await withTenant(db, tenant.id, (tx) => installProfileRows(tx, write, profile));
    expect(installed.code).toBe(profile.code);
    await withTenant(db, tenant.id, async (tx) => {
      expect(await storedContent(tx, installed.id)).toEqual(definedContent(profile));
    });
    expect((await ledgerOf(tenant.id)).size).toBe(0);
  });
});

describe('AC-PLAT-F061 T-14 台账租户隔离与只追加', () => {
  const record = (
    tenantId: string,
    codes: string[],
    source: 'install' | 'adopted' | 'tenant_saved' | 'withheld',
    commandId: string | null = 'cmd-1',
  ) =>
    withTenant(testDb().db, tenantId, (tx) =>
      recordLedger(tx, { entry: 'test/entry', codes, source, commandId, now: NOW }),
    );

  it('同一编码第一次登记的来源为准；重复登记返回空；空编码不写', async () => {
    const { tenant } = await seedTenantWithMember(testDb().db, 'f061first');
    expect(await record(tenant.id, ['a', 'b'], 'install')).toEqual(['a', 'b']);
    expect(await record(tenant.id, ['b', 'c'], 'adopted', null)).toEqual(['c']);
    expect(await record(tenant.id, ['a', 'b', 'c'], 'withheld')).toEqual([]);
    expect(await record(tenant.id, [], 'install')).toEqual([]);
    const ledger = await withTenant(testDb().db, tenant.id, (tx) => readLedger(tx, 'test/entry'));
    expect(Object.fromEntries(ledger)).toEqual({ a: 'install', b: 'install', c: 'adopted' });
    const rows = await withTenant(testDb().db, tenant.id, (tx) => tx.select().from(seedGrantLedger));
    expect(rows.find((r) => r.code === 'c')).toMatchObject({ commandId: null, tenantId: tenant.id, recordedAt: NOW });
  });

  it('一次登记很多编码（超过单条语句的参数上限）也整笔成功', async () => {
    const { tenant } = await seedTenantWithMember(testDb().db, 'f061many');
    const codes = Array.from({ length: 21_000 }, (_, i) => `p/o${i}/op:view`);
    expect((await record(tenant.id, codes, 'install')).length).toBe(codes.length);
    const ledger = await withTenant(testDb().db, tenant.id, (tx) => readLedger(tx, 'test/entry'));
    expect(ledger.size).toBe(codes.length);
  });

  it('按登记项 entry 分开读；租户之间互相读不到、也不能以别的租户身份写入', async () => {
    const { db } = testDb();
    const a = await seedTenantWithMember(db, 'f061iso-a');
    const b = await seedTenantWithMember(db, 'f061iso-b');
    await record(a.tenant.id, ['x'], 'install');
    await withTenant(db, a.tenant.id, (tx) =>
      recordLedger(tx, { entry: 'other/entry', codes: ['y'], source: 'adopted', commandId: null, now: NOW }),
    );
    expect([...(await ledgerOf(a.tenant.id, 'test/entry')).keys()]).toEqual(['x']);
    expect([...(await ledgerOf(a.tenant.id, 'other/entry')).keys()]).toEqual(['y']);
    expect((await ledgerOf(b.tenant.id, 'test/entry')).size).toBe(0);
    expect(await withTenant(db, b.tenant.id, (tx) => tx.select().from(seedGrantLedger))).toEqual([]);

    // 在 B 的上下文里直接写 A 的行：RLS WITH CHECK 拒绝
    await expect(
      withTenant(db, b.tenant.id, (tx) =>
        tx.execute(
          sql`INSERT INTO seed_grant_ledger (tenant_id, entry, code, source, recorded_at)
              VALUES (${a.tenant.id}::uuid, 'test/entry', 'forged', 'install', now())`,
        ),
      ),
    ).rejects.toThrow();
    expect((await ledgerOf(a.tenant.id, 'test/entry')).has('forged')).toBe(false);
  });

  it('来源只能是 install / adopted / tenant_saved / withheld', async () => {
    const { tenant } = await seedTenantWithMember(testDb().db, 'f061source');
    await expect(
      withTenant(testDb().db, tenant.id, (tx) =>
        tx.execute(
          sql`INSERT INTO seed_grant_ledger (tenant_id, entry, code, source, recorded_at)
              VALUES (${tenant.id}::uuid, 'test/entry', 'z', 'whatever', now())`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('只追加：应用角色没有改删权限；表属主的 UPDATE / DELETE / TRUNCATE 也被触发器拒绝（55000），行内容不变', async () => {
    const { db } = testDb();
    const { tenant } = await seedTenantWithMember(db, 'f061append');
    await record(tenant.id, ['k'], 'install');
    const before = await withTenant(db, tenant.id, (tx) => tx.select().from(seedGrantLedger));

    for (const statement of [
      sql`UPDATE seed_grant_ledger SET source = 'withheld'`,
      sql`DELETE FROM seed_grant_ledger`,
      sql`TRUNCATE seed_grant_ledger`,
    ])
      await expect(withTenant(db, tenant.id, (tx) => tx.execute(statement))).rejects.toThrow();

    for (const statement of [
      sql`UPDATE seed_grant_ledger SET source = 'withheld'`,
      sql`DELETE FROM seed_grant_ledger`,
      sql`TRUNCATE seed_grant_ledger`,
    ]) {
      const error = await db
        .transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`);
          await tx.execute(statement);
        })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(pgErrorCode(error)).toBe('55000');
    }
    expect(await withTenant(db, tenant.id, (tx) => tx.select().from(seedGrantLedger))).toEqual(before);
  });

  it('lockTenantSeeds 接受大小写不同的同一租户 UUID（与 installMissingSeeds 同一把锁，SQL 不变）', async () => {
    const { db } = testDb();
    const { tenant } = await seedTenantWithMember(db, 'f061lock');
    await withTenant(db, tenant.id, async (tx) => {
      await lockTenantSeeds(tx, tenant.id.toUpperCase());
      await lockTenantSeeds(tx, tenant.id);
    });
    await expect(
      withTenant(db, tenant.id, (tx) => lockTenantSeeds(tx, `not-a-uuid-${randomUUID()}`)),
    ).rejects.toThrow();
  });
});
