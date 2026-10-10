/**
 * R3-T02 C1-2b（AC-QL-employee-profile）：预置“员工”标准身份 employee_self_service（DEC-399 / DEC-402 / DEC-404，
 * 契约 docs/08_设计/R3-T02_C1-2b_员工身份_契约.md §2～§5、§7 必测 1～3、5、7～11；必测 4、6、6a 在 AC-TRF-39-standard-profile-parity）。
 * 作用对象：复刻系统。要点：开通即有标准身份；autoHeld（不发授权行、不可授予、不进可授权集合）；
 * DEC-205 默认值迁入 domain 单一来源（行为不变）；页面载体 Qualification.Pages 缺行默认显示；
 * 存量租户经 F-061 登记项补装，CODE_TAKEN 保留原计数另加明细（DEC-402⑤）；租户撤销的授权不被补回。
 */
import { randomUUID } from 'node:crypto';
import {
  auditEvents,
  createUser,
  grantMembership,
  permissionAdminGrantableProfiles,
  permissionAdmins,
  permissionGrants,
  permissionIdentityScopes,
  permissionProfiles,
  platformAuditEvents,
  eq,
  withTenant,
} from '@italent/db';
import {
  EMPLOYEE_DEFAULT_CREATE,
  EMPLOYEE_DEFAULT_EDIT_FIELDS,
  EMPLOYEE_READONLY_FIELDS,
  EMPLOYEE_SELF_SERVICE_BUTTONS,
  EMPLOYEE_SELF_SERVICE_CODE,
  grantCodesDigest,
  profileLedgerMarker,
  QUALIFICATION_OBJECTS,
  STANDARD_GRANT_CODES,
  STANDARD_GRANT_DIGEST,
  STANDARD_GRANT_VERSION,
  STANDARD_PROFILES,
  standardGrantItems,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employeeFieldPolicy } from '../../apps/api/src/modules/employee-self-service/policy.js';
import { installProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { approvalWorld, permissionAdmin } from './AC-APV-support.js';
import { BASE as PRM, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import {
  buttonCode,
  grantsInstalled,
  ledger,
  legacyWorld,
  provisionWorld,
  putObject,
  runBackfill,
  withObject,
  withoutButton,
  type World,
} from './support/f061.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const EMP = EMPLOYEE_SELF_SERVICE_CODE;
const EMP_DEF = STANDARD_PROFILES.find((p) => p.code === EMP)!;
const RECORD = 'TenantBase.EmploymentRecord';
const PAGES = 'Qualification.Pages';
const PAGE_BUTTON = { buttonCode: 'EmployeeDevelopmentChannel', level: 'app_page' } as const;
const pageButtonCode = buttonCode(EMP, PAGES, PAGE_BUTTON);

interface ProfileDetail {
  id: string;
  name: string;
  source: string;
  autoHeld: boolean;
  apps: string[];
  revision: number;
  objects: {
    objectCode: string;
    dataOperations: { create: boolean; update: boolean; delete: boolean };
    fields: { fieldCode: string; view: boolean; edit: boolean }[];
    buttons: { buttonCode: string; level: string }[];
  }[];
}
const detailOf = async (w: Pick<World, 'api' | 'asAdmin' | 'profileIds'>, code: string): Promise<ProfileDetail> => {
  const res = await w.api.request('GET', `${PRM}/profiles/${w.profileIds.get(code)}`, w.asAdmin);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ProfileDetail;
};
const reasonOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; details?: { reason?: string } } }).error.details?.reason;

describe('AC-QL-employee-profile 必测 1：开通后员工身份存在且内容等于 DEC-205 默认值', () => {
  it('标准身份、应用、任职对象字段 / 数据操作 / 三个按钮、页面载体按钮；无身份范围行；无任职资格业务对象（AC-QL-employee-profile）', async () => {
    const w = await provisionWorld(testDb().db, 'emp-open');
    const detail = await detailOf(w, EMP);
    expect(detail).toMatchObject({ name: '员工', source: 'standard', autoHeld: true });
    expect([...detail.apps].sort()).toEqual(['Qualification', 'TenantBase']);
    expect(detail.objects.map((o) => o.objectCode).sort()).toEqual([PAGES, RECORD]);

    const record = detail.objects.find((o) => o.objectCode === RECORD)!;
    const readable = [...EMPLOYEE_DEFAULT_EDIT_FIELDS, ...EMPLOYEE_READONLY_FIELDS];
    expect(
      record.fields
        .filter((f) => f.view)
        .map((f) => f.fieldCode)
        .sort(),
    ).toEqual([...readable].sort());
    expect(
      record.fields
        .filter((f) => f.edit)
        .map((f) => f.fieldCode)
        .sort(),
    ).toEqual([...EMPLOYEE_DEFAULT_EDIT_FIELDS].sort());
    expect(record.dataOperations).toEqual({ create: EMPLOYEE_DEFAULT_CREATE, update: false, delete: false });
    expect(record.buttons.map((b) => b.buttonCode).sort()).toEqual(
      EMPLOYEE_SELF_SERVICE_BUTTONS.map((b) => b.buttonCode).sort(),
    );
    expect(record.buttons.every((b) => b.level === 'detail')).toBe(true);

    const pages = detail.objects.find((o) => o.objectCode === PAGES)!;
    expect(pages).toMatchObject({
      fields: [],
      dataOperations: { create: false, update: false, delete: false },
      buttons: [PAGE_BUTTON],
    });
    // 页面载体不授予任职资格业务对象（DEC-399②）
    for (const object of [QUALIFICATION_OBJECTS.developmentChannel, QUALIFICATION_OBJECTS.standard])
      expect(detail.objects.map((o) => o.objectCode)).not.toContain(object.code);

    const scopes = await withTenant(w.db, w.tenantId, (tx) => tx.select().from(permissionIdentityScopes));
    expect(scopes.filter((s) => s.profileId === w.profileIds.get(EMP))).toEqual([]);
  });
});

describe('AC-QL-employee-profile 必测 2：autoHeld 不可授予、不进可授权集合（DEC-402③）', () => {
  const member = async (w: World, label: string) => {
    const user = await createUser(w.db, { email: `${label}-${randomUUID()}@example.com`, displayName: label }, cmd());
    await grantMembership(w.db, { tenantId: w.tenantId, userId: user.id, expectedRevision: 0 }, cmd());
    return user.id;
  };
  const snapshot = async (w: World) =>
    withTenant(w.db, w.tenantId, async (tx) => ({
      grants: (await tx.select().from(permissionGrants)).length,
      admins: await tx.select().from(permissionAdmins),
      links: (await tx.select().from(permissionAdminGrantableProfiles)).length,
      audits: (await tx.select().from(auditEvents)).filter((a) => a.action.startsWith('permission_')).length,
    }));

  it('POST /grants、PUT /admins/:id、POST /admins 都 403 PROFILE_AUTO_HELD，且没有任何副作用（AC-QL-employee-profile）', async () => {
    const w = await provisionWorld(testDb().db, 'emp-held');
    const profileId = w.profileIds.get(EMP)!;
    const target = await member(w, 'target');
    const before = await snapshot(w);

    const granted = await w.api.request('POST', `${PRM}/grants`, { ...w.asAdmin, body: { userId: target, profileId } });
    expect(granted.status).toBe(403);
    expect(await reasonOf(granted)).toBe('PROFILE_AUTO_HELD');

    const record = before.admins.find((a) => a.userId === w.asAdmin.user)!;
    const current = (await (await w.api.request('GET', `${PRM}/admins/${record.id}`, w.asAdmin)).json()) as {
      grantableAdminRoles: string[];
      grantableProfileIds: string[];
    };
    const updated = await w.api.request('PUT', `${PRM}/admins/${record.id}`, {
      ...w.asAdmin,
      ifMatch: record.revision,
      body: {
        grantableAdminRoles: current.grantableAdminRoles,
        grantableProfileIds: [...current.grantableProfileIds, profileId],
      },
    });
    expect(updated.status).toBe(403);
    expect(await reasonOf(updated)).toBe('PROFILE_AUTO_HELD');

    const created = await w.api.request('POST', `${PRM}/admins`, {
      ...w.asAdmin,
      body: { userId: target, role: 'tenant_admin', grantableAdminRoles: [], grantableProfileIds: [profileId] },
    });
    expect(created.status).toBe(403);
    expect(await reasonOf(created)).toBe('PROFILE_AUTO_HELD');

    const after = await snapshot(w);
    expect(after.grants).toBe(before.grants);
    expect(after.links).toBe(before.links);
    expect(after.audits).toBe(before.audits);
    expect(after.admins.map((a) => [a.id, a.revision])).toEqual(before.admins.map((a) => [a.id, a.revision]));
  });

  it('开通后首位管理员的可授权身份与授权选择器不含它；身份视图 autoHeld 只在它上为 true；GET /grants 没有它（AC-QL-employee-profile）', async () => {
    const w = await provisionWorld(testDb().db, 'emp-held-list');
    const profileId = w.profileIds.get(EMP)!;
    const grantable = await w.api.request('GET', `${PRM}/grantable-profiles`, w.asAdmin);
    const items = ((await grantable.json()) as { items: { id: string }[] }).items;
    expect(items.map((p) => p.id)).not.toContain(profileId);
    expect(items).toHaveLength(STANDARD_PROFILES.length - 1);

    const listed = (await (await w.api.request('GET', `${PRM}/profiles`, w.asAdmin)).json()) as {
      items: { id: string; code: string; autoHeld: boolean }[];
    };
    expect(listed.items.filter((p) => p.autoHeld).map((p) => p.code)).toEqual([EMP]);
    expect(listed.items.every((p) => typeof p.autoHeld === 'boolean')).toBe(true);

    const grants = (await (await w.api.request('GET', `${PRM}/grants`, w.asAdmin)).json()) as {
      items: { profileId: string }[];
    };
    expect(grants.items.map((g) => g.profileId)).not.toContain(profileId);
  });

  it('存量回补新装员工身份后，有效租户管理员的可授权集合不含它；只缺员工身份时不推进管理员 revision、不写管理员审计（AC-QL-employee-profile）', async () => {
    const w = await legacyWorld(testDb().db, 'emp-held-backfill', [], [EMP]);
    const adminBefore = await withTenant(w.db, w.tenantId, (tx) => tx.select().from(permissionAdmins));
    const report = await runBackfill(w);
    expect(report.items.find((i) => i.key === 'standard-profiles')!.installed).toEqual([EMP]);

    const adminAfter = await withTenant(w.db, w.tenantId, (tx) => tx.select().from(permissionAdmins));
    expect(adminAfter.map((a) => [a.id, a.revision])).toEqual(adminBefore.map((a) => [a.id, a.revision]));
    const links = await withTenant(w.db, w.tenantId, (tx) => tx.select().from(permissionAdminGrantableProfiles));
    const employee = await withTenant(w.db, w.tenantId, (tx) =>
      tx.select().from(permissionProfiles).where(eq(permissionProfiles.code, EMP)),
    );
    expect(links.map((l) => l.profileId)).not.toContain(employee[0]!.id);
    const audits = await withTenant(w.db, w.tenantId, (tx) => tx.select().from(auditEvents));
    expect(audits.filter((a) => a.action === 'permission_admin.update')).toEqual([]);
  });
});

describe('AC-QL-employee-profile 必测 3：E1 单一来源守卫（改动前的字面量抄在这里作“旧值”）', () => {
  // 改动前 employee-self-service/policy.ts 与 access.ts 的字面量
  const OLD_EDIT = ['effectiveDate', 'reasonCode', 'departmentId', 'directManagerId'];
  const OLD_READ = [...OLD_EDIT, 'postId', 'levelId', 'sequenceId'];
  const OLD_BUTTONS = ['Transfer.Self', 'Employment.Create', 'Employment.Submit'];

  it('身份定义算出的 { view, edit, create, buttons } 等于旧字面量（AC-QL-employee-profile）', () => {
    const record = EMP_DEF.objects.find((o) => o.objectCode === RECORD)!;
    expect(
      record.fields
        .filter((f) => f.view)
        .map((f) => f.fieldCode)
        .sort(),
    ).toEqual([...OLD_READ].sort());
    expect(
      record.fields
        .filter((f) => f.view && f.edit)
        .map((f) => f.fieldCode)
        .sort(),
    ).toEqual([...OLD_EDIT].sort());
    expect(record.dataOperations).toEqual({ create: true, update: false, delete: false });
    expect(record.buttons.map((b) => b.buttonCode).sort()).toEqual([...OLD_BUTTONS].sort());
    expect([...EMPLOYEE_READONLY_FIELDS].sort()).toEqual(['levelId', 'postId', 'sequenceId']);
    expect(EMP_DEF).toMatchObject({ autoHeld: true, licenseType: null, name: '员工', hr: false });
  });

  it('没有身份行的租户：employeeFieldPolicy 兜底值等于旧字面量，并带三个按钮（AC-QL-employee-profile）', async () => {
    const w = await legacyWorld(testDb().db, 'emp-fallback', [], [EMP]);
    const policy = await withTenant(w.db, w.tenantId, (tx) => employeeFieldPolicy(tx, w.tenantId));
    expect([...policy.view].sort()).toEqual([...OLD_READ].sort());
    expect([...policy.edit].sort()).toEqual([...OLD_EDIT].sort());
    expect(policy.create).toBe(true);
    expect([...policy.buttons].sort()).toEqual([...OLD_BUTTONS].sort());
  });

  it('装有标准身份的租户：读标准行得到同一结果（AC-QL-employee-profile）', async () => {
    const w = await provisionWorld(testDb().db, 'emp-policy-row');
    const policy = await withTenant(w.db, w.tenantId, (tx) => employeeFieldPolicy(tx, w.tenantId));
    expect([...policy.view].sort()).toEqual([...OLD_READ].sort());
    expect([...policy.edit].sort()).toEqual([...OLD_EDIT].sort());
    expect(policy.create).toBe(true);
    expect([...policy.buttons].sort()).toEqual([...OLD_BUTTONS].sort());
  });
});

describe('AC-QL-employee-profile 必测 5：E3 存量租户补装前后同输出，台账随装入记账', () => {
  it('回补前（兜底）与回补后（标准行）的字段策略相同；installed 含员工身份；台账有全部编码与 @ledger（AC-QL-employee-profile）', async () => {
    const w = await legacyWorld(testDb().db, 'emp-e3', [], [EMP]);
    const x = await withTenant(w.db, w.tenantId, (tx) => employeeFieldPolicy(tx, w.tenantId));
    const report = await runBackfill(w);
    expect(report.items.find((i) => i.key === 'standard-profiles')!.installed).toContain(EMP);
    const y = await withTenant(w.db, w.tenantId, (tx) => employeeFieldPolicy(tx, w.tenantId));
    expect({ ...y, view: [...y.view].sort(), edit: [...y.edit].sort(), buttons: [...y.buttons].sort() }).toEqual({
      ...x,
      view: [...x.view].sort(),
      edit: [...x.edit].sort(),
      buttons: [...x.buttons].sort(),
    });
    const entries = await ledger(w);
    const expected = [...standardGrantItems([EMP_DEF]).map((item) => item.code), profileLedgerMarker(EMP)];
    for (const code of expected) expect(entries.has(code), code).toBe(true);
    expect(entries.get(pageButtonCode)).toBe('install');
  });
});

describe('AC-QL-employee-profile 必测 7：员工发展通道页面判定 employeePageGranted（契约 §3.2）', () => {
  type PageWorld = Awaited<ReturnType<typeof approvalWorld>>;
  const setup = async (label: string, installEmployee: boolean) => {
    const world = await approvalWorld(testDb().db, label);
    const admin = await permissionAdmin(world);
    if (installEmployee)
      await withTenant(world.db, world.tenant.id, (tx) =>
        installProfile(
          tx,
          { tenantId: world.tenant.id, actorUserId: null, now: new Date(), commandId: randomUUID() },
          EMP_DEF,
        ),
      );
    const department = await world.org('合成部门');
    return { world, admin, department };
  };
  const granted = async (world: PageWorld, userId: string) => {
    const { employeePageGranted } = await import('../../apps/api/src/modules/employee-self-service/page-permission.js');
    return withTenant(world.db, world.tenant.id, (tx) =>
      employeePageGranted(tx, { tenantId: world.tenant.id, userId }, 'EmployeeDevelopmentChannel'),
    );
  };
  const profileBody = async (admin: Awaited<ReturnType<typeof permissionAdmin>>, code: string) => {
    const list = (await (await admin.api.request('GET', `${PRM}/profiles`, admin.asAdmin)).json()) as {
      items: { id: string; code: string; revision: number }[];
    };
    return list.items.find((p) => p.code === code)!;
  };
  const savePages = async (
    admin: Awaited<ReturnType<typeof permissionAdmin>>,
    buttons: { buttonCode: string; level: string }[],
  ) =>
    setObjectPermission(
      admin,
      await profileBody(admin, EMP),
      { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons },
      PAGES,
    );

  it('开通租户默认授予；保存按钮为空 → 不授予；勾回 → 授予（AC-QL-employee-profile）', async () => {
    const { world, admin, department } = await setup('emp-page-toggle', true);
    const person = await world.person('员工甲', department);
    expect(await granted(world, person.userId)).toBe(true);
    expect((await savePages(admin, [])).status).toBe(200);
    expect(await granted(world, person.userId)).toBe(false);
    expect((await savePages(admin, [PAGE_BUTTON])).status).toBe(200);
    expect(await granted(world, person.userId)).toBe(true);
  });

  it('无身份行的租户 → 授予；custom 同编码行（只有 TenantBase）→ 授予（DEC-402①）（AC-QL-employee-profile）', async () => {
    const none = await setup('emp-page-none', false);
    const a = await none.world.person('员工乙', none.department);
    expect(await granted(none.world, a.userId)).toBe(true);

    const custom = await setup('emp-page-custom', false);
    await createProfile(custom.admin, EMP);
    const b = await custom.world.person('员工丙', custom.department);
    expect(await granted(custom.world, b.userId)).toBe(true);
  });

  it('员工身份去掉后，用户另持有带该按钮的身份 → 授予（并集）；未绑定员工 → 403（AC-QL-employee-profile）', async () => {
    const { world, admin, department } = await setup('emp-page-union', true);
    const person = await world.person('员工丁', department);
    expect((await savePages(admin, [])).status).toBe(200);
    expect(await granted(world, person.userId)).toBe(false);

    const extra = await createProfile(admin, 'page_holder', { apps: ['Qualification'] });
    expect(
      (
        await setObjectPermission(
          admin,
          extra,
          { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons: [PAGE_BUTTON] },
          PAGES,
        )
      ).status,
    ).toBe(200);
    await makeGrantable(admin, [extra.id]);
    expect((await grant(admin, person.userId, extra.id)).status).toBe(201);
    expect(await granted(world, person.userId)).toBe(true);

    const unbound = await world.member('未绑定员工');
    await expect(granted(world, unbound)).rejects.toMatchObject({ code: 'FORBIDDEN', message: '当前用户未绑定员工' });
  });

  it('跨租户：A 租户的页面身份不参与 B 租户的判定（AC-QL-employee-profile）', async () => {
    const a = await setup('emp-page-tenant-a', true);
    const b = await setup('emp-page-tenant-b', true);
    expect((await savePages(b.admin, [])).status).toBe(200);
    const person = await b.world.person('跨租户员工', b.department);
    // 用户在 A 租户持有带页面按钮的身份
    await grantMembership(
      a.world.db,
      { tenantId: a.world.tenant.id, userId: person.userId, expectedRevision: 0 },
      cmd(),
    );
    const extra = await createProfile(a.admin, 'page_holder_a', { apps: ['Qualification'] });
    await setObjectPermission(
      a.admin,
      extra,
      { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons: [PAGE_BUTTON] },
      PAGES,
    );
    await makeGrantable(a.admin, [extra.id]);
    expect((await grant(a.admin, person.userId, extra.id)).status).toBe(201);
    expect(await granted(b.world, person.userId)).toBe(false);
  });

  it('页面载体不授予任职资格业务对象：只有员工身份的员工访问发展通道 / 任职资格标准接口 403，HR 端任职接口仍 403（AC-QL-employee-profile）', async () => {
    const { world, department } = await setup('emp-page-neg', true);
    const realApi = tenantApi(world.db, { authorize: undefined, clock: world.clock });
    const person = await world.person('普通员工', department);
    for (const path of [
      '/api/tenant/qualification/standards',
      `/api/tenant/qualification/standards/${randomUUID()}/channels`,
      '/api/tenant/employment/employees',
    ]) {
      // 真实授权器（approvalWorld 的默认请求器是放行的测试授权器）
      const res = await realApi.request('GET', path, world.as(person.userId));
      expect(res.status, path).toBe(403);
    }
  });
});

describe('AC-QL-employee-profile 必测 8：撤销保留（F-061 §10 两条，换成员工身份）', () => {
  it('开通 → 租户去掉页面按钮 → 首次与再次回补都不恢复（AC-QL-employee-profile）', async () => {
    const w = await provisionWorld(testDb().db, 'emp-revoke-open');
    expect((await putObject(w, w.profileIds.get(EMP)!, PAGES, (o) => ({ ...o, buttons: [] }))).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      expect(grantsInstalled(await runBackfill(w))).toEqual([]);
      const pages = (await detailOf(w, EMP)).objects.find((o) => o.objectCode === PAGES)!;
      expect(pages.buttons).toEqual([]);
    }
  });

  it('开通 → 租户去掉任职字段 reasonCode 的编辑 → 回补不恢复（AC-QL-employee-profile）', async () => {
    const w = await provisionWorld(testDb().db, 'emp-revoke-field');
    const saved = await putObject(w, w.profileIds.get(EMP)!, RECORD, (o) => ({
      ...o,
      fields: o.fields.map((f) => (f.fieldCode === 'reasonCode' ? { ...f, edit: false } : f)),
    }));
    expect(saved.status).toBe(200);
    expect(grantsInstalled(await runBackfill(w))).toEqual([]);
    const record = (await detailOf(w, EMP)).objects.find((o) => o.objectCode === RECORD)!;
    expect(record.fields.find((f) => f.fieldCode === 'reasonCode')!.edit).toBe(false);
  });

  it('存量租户（无台账）：回补装入 → 租户去掉页面按钮 → 再次回补不恢复（AC-QL-employee-profile）', async () => {
    const w = await legacyWorld(testDb().db, 'emp-revoke-legacy', [], [EMP]);
    await runBackfill(w);
    const profiles = (await (await w.api.request('GET', `${PRM}/profiles`, w.asAdmin)).json()) as {
      items: { id: string; code: string }[];
    };
    const ids = new Map(profiles.items.map((p) => [p.code, p.id]));
    expect((await putObject(w, ids.get(EMP)!, PAGES, (o) => ({ ...o, buttons: [] }))).status).toBe(200);
    expect(grantsInstalled(await runBackfill(w))).toEqual([]);
    expect(
      (await detailOf({ ...w, profileIds: ids }, EMP)).objects.find((o) => o.objectCode === PAGES)!.buttons,
    ).toEqual([]);
  });

  it('保存登记的区分力：旧定义缺页面按钮（装入即记账）→ 租户勾上再撤销 → 回补不恢复（AC-QL-employee-profile）', async () => {
    // 只靠安装记账测不出“保存登记”是否生效：身份已有 @ledger，页面按钮“当前没有、台账也没有”，只有保存登记写入
    // tenant_saved 后撤销才不会被补回。临时让 standard-managed-grants.ts 对员工身份不登记，这条会失败。
    const w = await legacyWorld(testDb().db, 'emp-revoke-discriminate', [], [EMP]);
    const legacy = withObject(EMP, PAGES, withoutButton(PAGE_BUTTON))(EMP_DEF);
    const installed = await withTenant(w.db, w.tenantId, (tx) =>
      installProfile(tx, { tenantId: w.tenantId, actorUserId: null, now: new Date(), commandId: randomUUID() }, legacy),
    );
    const ids = new Map([[EMP, installed.id]]);
    const world = { ...w, profileIds: ids };
    expect((await ledger(w)).has(pageButtonCode)).toBe(false);

    expect((await putObject(world, installed.id, PAGES, (o) => ({ ...o, buttons: [PAGE_BUTTON] }))).status).toBe(200);
    expect((await ledger(w)).get(pageButtonCode)).toBe('tenant_saved');
    expect((await putObject(world, installed.id, PAGES, (o) => ({ ...o, buttons: [] }))).status).toBe(200);

    expect(grantsInstalled(await runBackfill(w))).not.toContain(pageButtonCode);
    expect((await detailOf(world, EMP)).objects.find((o) => o.objectCode === PAGES)!.buttons).toEqual([]);
  });
});

describe('AC-QL-employee-profile 必测 9、10：CODE_TAKEN 保留计数另加明细；重复回补无副作用（DEC-402⑤）', () => {
  it('租户已有 custom 同编码行：不装不改，existing 计数照旧，existingDetails 列 CODE_TAKEN，汇总审计带明细（AC-QL-employee-profile）', async () => {
    const w = await legacyWorld(testDb().db, 'emp-taken', [], [EMP, 'standard_manager']);
    for (const code of [EMP, 'standard_manager']) {
      const created = await w.api.request('POST', `${PRM}/profiles`, {
        ...w.asAdmin,
        body: { code, name: '租户手工建的同编码', apps: ['TenantBase'], licenseType: null },
      });
      expect(created.status, await created.clone().text()).toBe(201);
    }
    const custom = await withTenant(w.db, w.tenantId, (tx) =>
      tx.select().from(permissionProfiles).where(eq(permissionProfiles.code, EMP)),
    );
    const key = randomUUID();
    const report = await runBackfill(w, undefined, key);
    const item = report.items.find((i) => i.key === 'standard-profiles') as unknown as {
      installed: string[];
      existing: number;
      existingDetails?: { code: string; reason: string }[];
    };
    expect(item.installed).not.toContain(EMP);
    expect(item.installed).not.toContain('standard_manager');
    expect(item.existing).toBe(STANDARD_PROFILES.length);
    expect(item.existingDetails).toEqual(
      expect.arrayContaining([
        { code: EMP, reason: 'CODE_TAKEN' },
        { code: 'standard_manager', reason: 'CODE_TAKEN' },
      ]),
    );
    expect(item.existingDetails).toHaveLength(2);

    const after = await withTenant(w.db, w.tenantId, (tx) =>
      tx.select().from(permissionProfiles).where(eq(permissionProfiles.code, EMP)),
    );
    expect(after[0]).toMatchObject({ source: 'custom', revision: custom[0]!.revision });

    const platform = await testDb()
      .db.select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.subjectTenantId, w.tenantId));
    const summary = platform.find((p) => p.action === 'tenant.seeds.backfill' && p.commandId === key)!;
    const items = (summary.after as { items: { key: string; existingDetails?: unknown }[] }).items;
    expect(items.find((i) => i.key === 'standard-profiles')!.existingDetails).toEqual(item.existingDetails);

    // 重复回补：报告相同，不新增业务变更审计
    const audits = async () =>
      (await withTenant(w.db, w.tenantId, (tx) => tx.select().from(auditEvents))).filter((a) =>
        a.action.startsWith('permission_'),
      ).length;
    const before = await audits();
    const again = (await runBackfill(w)).items.find((i) => i.key === 'standard-profiles') as unknown as typeof item;
    expect(again.existingDetails).toEqual(item.existingDetails);
    expect(again.existing).toBe(item.existing);
    expect(await audits()).toBe(before);
  });

  it('员工身份已装的租户再回补两次：installed 为空，权限行、台账、业务变更审计不增加（AC-QL-employee-profile）', async () => {
    const w = await provisionWorld(testDb().db, 'emp-idempotent');
    const counts = async () => {
      const entries = await ledger(w);
      const audits = (await withTenant(w.db, w.tenantId, (tx) => tx.select().from(auditEvents))).filter((a) =>
        a.action.startsWith('permission_'),
      ).length;
      return { ledger: entries.size, audits, detail: JSON.stringify(await detailOf(w, EMP)) };
    };
    const before = await counts();
    for (let i = 0; i < 2; i++) {
      const report = await runBackfill(w);
      expect(report.items.find((x) => x.key === 'standard-profiles')!.installed).toEqual([]);
      expect(grantsInstalled(report)).toEqual([]);
    }
    expect(await counts()).toEqual(before);
    const platform = await testDb()
      .db.select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.subjectTenantId, w.tenantId));
    expect(platform.filter((p) => p.action === 'tenant.seeds.backfill')).toHaveLength(2);
  });
});

describe('AC-QL-employee-profile 必测 11：version / 指纹守卫（DEC-404）', () => {
  // main 在 C1-2b 开始时的值；合并前最后一次合 main 时，把这里改成合并进来的 main 的值（DEC-404）
  const MAIN = { version: 7, digest: 'de040eb38bfcd54a' };

  it('授权项编码含员工身份任职对象三个按钮与页面载体按钮；version 比 main 当前值至少 +1，指纹随编码变化（AC-QL-employee-profile）', () => {
    for (const button of EMPLOYEE_SELF_SERVICE_BUTTONS)
      expect(STANDARD_GRANT_CODES).toContain(buttonCode(EMP, RECORD, button));
    expect(STANDARD_GRANT_CODES).toContain(pageButtonCode);
    expect(STANDARD_GRANT_CODES).toContain(`${EMP}/${PAGES}/op:view`);
    expect(STANDARD_GRANT_CODES).toContain(`${EMP}/app:Qualification`);
    // 编码集合变了：指纹必须不同于 main 的指纹，version 必须严格大于 main 的 version（证明递增，而不只是“>= 某个下限”）
    expect(grantCodesDigest(STANDARD_GRANT_CODES)).toBe(STANDARD_GRANT_DIGEST);
    expect(STANDARD_GRANT_DIGEST).not.toBe(MAIN.digest);
    expect(STANDARD_GRANT_VERSION).toBeGreaterThan(MAIN.version);
    // 去掉员工身份的编码就回到 main 的指纹（防止“指纹变了但变化与本 PR 无关”）
    const withoutEmployee = STANDARD_GRANT_CODES.filter((code) => !code.startsWith(`${EMP}/`));
    expect(grantCodesDigest(withoutEmployee)).toBe(MAIN.digest);
  });
});
