/**
 * R3-T02 C1-6（AC-QL-08，ESS 本人入口）个人主页“员工通道”卡片（规格 23 §19，DEC-399②，DEC-402①；拆分方案 C1-6）：
 * - GET /api/tenant/self-service/development-channel 与 GET /employees/:id/development-channel（:id 只能是绑定本人）；
 * - 关系入口：不要求 Qualification 数据范围，也不要求 DevelopmentChannel / QualificationStandard 的对象权限；要求员工发展通道
 *   页面权限（employeePageGranted），无权 403 PAGE_PERMISSION_REQUIRED；
 * - 卡片数据由后端按本人直接读取，返回固定投影（键集合固定，不随对象字段权限变化），不含各级标准明细（23 §19）；
 * - 没有当前资格是空态；他人员工 ID 不可经 ESS 读。
 * 所有 ESS 请求走真实授权器（authorize: undefined）；配置与权限用全部允许的钩子准备。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant } from '@italent/db';
import { EMPLOYEE_SELF_SERVICE_CODE, QUALIFICATION_OBJECTS, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MANAGER_PROFILE_CODE } from '../../apps/api/src/modules/permission/manager-identity.js';
import { installProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { createProfile, type PermissionWorld, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { boundUser, type ChannelWorld, channelWorld, ESS } from './AC-QL-08-support.js';
import { QL_NOW } from './AC-QL-support.js';
import { putObject } from './support/f061.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const PAGES = 'Qualification.Pages';
const PAGE_BUTTON = { buttonCode: 'EmployeeDevelopmentChannel', level: 'app_page' } as const;
const EMP_DEF = STANDARD_PROFILES.find((p) => p.code === EMPLOYEE_SELF_SERVICE_CODE)!;

interface Card {
  asOf: string;
  current: { categoryId: string; categoryName: string; levelId: string; levelName: string; startDate: string } | null;
  vertical: { levelId: string; levelName: string; displayOrder: number; isCurrent: boolean }[];
  horizontal: {
    fromLevelId: string;
    targetCategoryId: string;
    targetCategoryName: string;
    targetLevelId: string;
    targetLevelName: string;
  }[];
}
const keys = (value: object) => Object.keys(value).sort();

const admins = new WeakMap<ChannelWorld, Promise<PermissionWorld>>();
/** 夹具的租户管理员记录（授权接口要求），每个租户只建一次。 */
const adminOf = (cw: ChannelWorld) => {
  if (!admins.has(cw)) {
    admins.set(
      cw,
      bootstrapTenantAdmin(cw.db, { tenantId: cw.w.tenant.id, userId: cw.w.user.id }, cmd()).then((adminRecord) => ({
        db: cw.db,
        tenant: cw.w.tenant,
        admin: cw.w.user,
        adminRecord,
        api: cw.w.api,
        asAdmin: cw.w.as,
      })),
    );
  }
  return admins.get(cw)!;
};

async function essWorld(label: string, installEmployee = true) {
  const cw = await channelWorld(database, label);
  const real = tenantApi(cw.db, { authorize: undefined, clock: () => QL_NOW });
  let profileId = '';
  if (installEmployee) {
    const write = { tenantId: cw.w.tenant.id, actorUserId: null, now: new Date(), commandId: randomUUID() };
    profileId = (await withTenant(cw.db, cw.w.tenant.id, (tx) => installProfile(tx, write, EMP_DEF))).id;
  }
  const employeeId = await cw.employee();
  await cw.record(employeeId, { levelId: cw.p2.id, startDate: '2026-01-01' });
  const me = await boundUser(cw, employeeId);
  const card = (who = me.as, path = '/development-channel') => real.request('GET', `${ESS}${path}`, who);
  const savePages = (buttons: readonly { buttonCode: string; level: string }[]) =>
    putObject({ api: cw.w.api, asAdmin: cw.w.as }, profileId, PAGES, (o) => ({
      ...o,
      buttons: [...buttons] as typeof o.buttons,
    }));
  return { cw, real, profileId, employeeId, me, card, savePages };
}

describe('AC-QL-08 ESS：员工通道卡片', () => {
  it('本人没有 Qualification 数据范围、没有任何身份、租户没有员工身份行，也能看到当前级别 / 纵向 / 横向（AC-QL-08，DEC-402①）', async () => {
    const { cw, card } = await essWorld('ql08-ess-card', false);
    const { category, otherCategory, bareCategory, p1, p2, p3 } = cw;
    const res = await card();
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Card;
    expect(body.current).toMatchObject({
      categoryId: category.id,
      levelId: p2.id,
      levelName: 'P20',
      startDate: '2026-01-01',
    });
    expect(body.vertical).toEqual([
      expect.objectContaining({ levelId: p1.id, displayOrder: 10, isCurrent: false }),
      expect.objectContaining({ levelId: p2.id, displayOrder: 20, isCurrent: true }),
      expect.objectContaining({ levelId: p3.id, displayOrder: 30, isCurrent: false }),
    ]);
    // 横向：只含当前级别及以下节点设置的路径，带目的地的类别 / 级别名称
    expect(body.horizontal.map((h) => [h.fromLevelId, h.targetCategoryId, h.targetLevelId]).sort()).toEqual(
      [
        [p1.id, otherCategory.id, p2.id],
        [p1.id, bareCategory.id, p3.id],
      ].sort(),
    );
    expect(body.horizontal.every((h) => h.targetCategoryName && h.targetLevelName)).toBe(true);
  });

  it('没有 DevelopmentChannel / QualificationStandard 的对象权限仍可看（同一用户访问管理接口 403）（AC-QL-08）', async () => {
    const { cw, real, card, me } = await essWorld('ql08-ess-noobject');
    expect((await card()).status).toBe(200);
    for (const path of [
      '/api/tenant/qualification/standards',
      `/api/tenant/qualification/standards/${cw.standard.id}/channels`,
    ])
      expect((await real.request('GET', path, me.as)).status, path).toBe(403);
  });

  it('员工身份去掉页面权限 → 403 PAGE_PERMISSION_REQUIRED（带应用与页面）；加回即可看（AC-QL-08，DEC-399②）', async () => {
    const { card, savePages } = await essWorld('ql08-ess-page');
    expect((await card()).status).toBe(200);
    expect((await savePages([])).status).toBe(200);
    const denied = await card();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        details: { reason: 'PAGE_PERMISSION_REQUIRED', app: 'Qualification', page: 'EmployeeDevelopmentChannel' },
      },
    });
    expect((await savePages([PAGE_BUTTON])).status).toBe(200);
    expect((await card()).status).toBe(200);
  });

  it('没有当前资格 → 200 空态，键集合与有数据时相同（AC-QL-08）', async () => {
    const { cw, card } = await essWorld('ql08-ess-empty');
    const filled = (await (await card()).json()) as Card;
    const lone = await cw.employee();
    const user = await boundUser(cw, lone, 'empty');
    const res = await card(user.as);
    expect(res.status).toBe(200);
    const empty = (await res.json()) as Card;
    expect(empty).toMatchObject({ current: null, vertical: [], horizontal: [] });
    expect(keys(empty)).toEqual(keys(filled));
  });

  it('当前类别没有标准 → 有当前资格，纵向 / 横向为空（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-ess-nostd');
    const real = tenantApi(cw.db, { authorize: undefined, clock: () => QL_NOW });
    const id = await cw.employee();
    await cw.record(id, { categoryId: cw.bareCategory.id, levelId: cw.p1.id });
    const user = await boundUser(cw, id);
    const body = (await (await real.request('GET', `${ESS}/development-channel`, user.as)).json()) as Card;
    expect(body.current).toMatchObject({ categoryId: cw.bareCategory.id, levelId: cw.p1.id });
    expect(body).toMatchObject({ vertical: [], horizontal: [] });
  });
});

describe('AC-QL-08 ESS：固定投影（不走对象字段权限，不含各级标准明细）', () => {
  /** 给员工另授一个 Qualification 身份：DevelopmentChannel / QualificationStandard 字段全可见或全隐藏。 */
  async function withQualificationIdentity(cw: ChannelWorld, userId: string, visible: boolean) {
    const admin = await adminOf(cw);
    const profile = await createProfile(admin, `ql-card-${randomUUID().slice(0, 6)}`, { apps: ['Qualification'] });
    for (const object of [QUALIFICATION_OBJECTS.standard, QUALIFICATION_OBJECTS.developmentChannel]) {
      const response = await setObjectPermission(
        admin,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: object.fields.map((f) => ({ fieldCode: f.code, view: visible, edit: false })),
          buttons: [],
        },
        object.code,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    await makeGrantable(admin, [profile.id]);
    expect((await grant(admin, userId, profile.id)).status).toBe(201);
  }

  it('无身份 / 对象字段全可见 / 对象字段全隐藏的三个员工，卡片逐字相同；键集合固定；无标准明细字段（AC-QL-08）', async () => {
    const { cw, real, card } = await essWorld('ql08-ess-fixed');
    const baseline = (await (await card()).json()) as Card;
    const bodies: Card[] = [baseline];
    for (const visible of [true, false]) {
      const id = await cw.employee();
      await cw.record(id, { levelId: cw.p2.id, startDate: '2026-01-01' });
      const user = await boundUser(cw, id, `fixed-${visible}`);
      await withQualificationIdentity(cw, user.userId, visible);
      const res = await real.request('GET', `${ESS}/development-channel`, user.as);
      expect(res.status, await res.clone().text()).toBe(200);
      bodies.push((await res.json()) as Card);
    }
    for (const body of bodies) expect(body).toEqual(baseline);
    // 固定键集合（契约：不随对象字段权限变化）
    expect(keys(baseline)).toEqual(['asOf', 'current', 'horizontal', 'vertical']);
    expect(keys(baseline.current!)).toEqual(['categoryId', 'categoryName', 'levelId', 'levelName', 'startDate']);
    expect(keys(baseline.vertical[0]!)).toEqual(['displayOrder', 'isCurrent', 'levelId', 'levelName']);
    expect(keys(baseline.horizontal[0]!)).toEqual([
      'fromLevelId',
      'targetCategoryId',
      'targetCategoryName',
      'targetLevelId',
      'targetLevelName',
    ]);
    const text = JSON.stringify(baseline);
    for (const hidden of ['cells', 'abilities', 'details', 'description', 'content', '本类二级能力']) {
      expect(text, hidden).not.toContain(hidden);
    }
  });
});

describe('AC-QL-08 ESS：他人员工 ID 不可读；未绑定员工拒绝', () => {
  it('/employees/:id/development-channel：本人 ID 与卡片相同，他人 ID 403，查询参数不能换人（AC-QL-08）', async () => {
    const { cw, card, employeeId, me } = await essWorld('ql08-ess-other');
    const other = await cw.employee();
    await cw.record(other, { levelId: cw.p3.id });
    const own = await card(me.as, `/employees/${employeeId}/development-channel`);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual(await (await card()).json());
    expect((await card(me.as, `/employees/${employeeId.toUpperCase()}/development-channel`)).status).toBe(200);
    expect((await card(me.as, `/employees/${other}/development-channel`)).status).toBe(403);
    expect((await card(me.as, `/employees/not-a-uuid/development-channel`)).status).toBe(400);
    const swapped = (await (await card(me.as, `/development-channel?employeeId=${other}`)).json()) as Card;
    expect(swapped.current?.levelId).toBe(cw.p2.id);
  });

  it('未绑定员工 403“当前用户未绑定员工”，页面权限检查在其后（AC-QL-08）', async () => {
    const { cw, card } = await essWorld('ql08-ess-unbound');
    const outsider = await boundUser(cw, await cw.employee(), 'unbound');
    await cw.tx((t) =>
      t.execute(sql`DELETE FROM permission_user_person_links WHERE tenant_id = ${cw.w.tenant.id}
        AND user_id = ${outsider.userId}::uuid`),
    );
    const res = await card(outsider.as);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { message: '当前用户未绑定员工' } });
  });
});

describe('AC-QL-08 ESS：页面权限并集含经理自动身份（F-087 后补-权限，C1-6 顺手改为用请求的真实授权器判定）', () => {
  it('员工身份去掉页面后，经理自动身份（department_manager_self_service）勾了页面的负责人可看，非负责人仍 403（AC-QL-08）', async () => {
    const { cw, real, card, me, savePages, employeeId } = await essWorld('ql08-ess-manager');
    expect((await savePages([])).status).toBe(200);
    expect((await card()).status).toBe(403);

    // 租户配置经理自动身份：Qualification 应用 + 员工发展通道页面
    const admin = await adminOf(cw);
    const profile = await createProfile(admin, MANAGER_PROFILE_CODE, { apps: ['Qualification'] });
    const saved = await setObjectPermission(
      admin,
      profile,
      { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons: [PAGE_BUTTON] },
      PAGES,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    // 还不是任何部门的负责人、也没有下属：派生身份不生效
    expect((await real.request('GET', `${ESS}/development-channel`, me.as)).status).toBe(403);

    // 设为部门负责人后派生身份生效
    await cw.tx(async (tx) => {
      const [old] = await tx
        .select()
        .from(orgVersions)
        .where(eq(orgVersions.orgId, cw.w.orgId))
        .orderBy(sql`version_no DESC`)
        .limit(1);
      const versionId = randomUUID();
      await tx.insert(orgVersions).values({
        ...old!,
        id: versionId,
        versionNo: old!.versionNo + 1,
        previousVersionId: old!.id,
        personInChargeId: employeeId,
      });
      const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
      if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
    });
    expect((await real.request('GET', `${ESS}/development-channel`, me.as)).status).toBe(200);
  });
});
