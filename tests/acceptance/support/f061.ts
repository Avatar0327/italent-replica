/**
 * F-061 标准身份授权补装测试的公共夹具（方案 §7.1）：
 * - 旧版本升级：按注入的旧定义用 installProfileRows 装全部标准身份（不写台账），模拟“F-061 上线前 / 目录新增前开通的租户”；
 * - 租户管理员经 API 读取 / 保存对象权限（setObjectPermission 的真实入口，含保存登记）；
 * - 平台经 seeds/backfill 回补（只回补 permission 模块的两个登记项）。
 * 台账只追加，测试不清台账；每个用例各建一个租户。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import {
  and,
  eq,
  permissionProfileButtons,
  permissionProfileFields,
  permissionProfileObjects,
  permissionProfiles,
  withTenant,
} from '@italent/db';
import { type ObjectPermission, STANDARD_GRANT_ENTRY, STANDARD_PROFILES, type StandardProfile } from '@italent/domain';
import { installProfileRows } from '../../../apps/api/src/modules/permission/standard-profiles.js';
import { readLedger } from '../../../apps/api/src/seeds/grant-ledger.js';
import { loadObjectPermissions } from '../../../apps/api/src/modules/permission/subject.js';
import { newUser, PLATFORM, seedOperator } from './platform-api.js';
import { cmd, seedTenantWithMember, tenantApi } from './tenant-api.js';

type Db = Parameters<typeof seedTenantWithMember>[0];

/** 测试靶子：人事管理员身份里第一个“有至少两个按钮、有可编辑字段”的对象，另取两个对象备用。 */
export const HR = STANDARD_PROFILES.find((p) => p.code === 'standard_hr_admin')!;
export const OBJ = HR.objects.find((o) => o.buttons.length >= 2 && o.fields.some((f) => f.edit))!;
export const OBJ_B = HR.objects.find((o) => o !== OBJ && o.buttons.length >= 2)!;
export const OBJ_C = HR.objects.find((o) => o !== OBJ && o !== OBJ_B && o.fields.length > 0)!;
/** OBJ 上用来制造“缺失 / 撤销”的按钮与字段。 */
export const BUTTON = OBJ.buttons[OBJ.buttons.length - 1]!;
export const OTHER_BUTTON = OBJ.buttons[0]!;
export const FIELD = OBJ.fields.find((f) => f.edit)!.fieldCode;

export const buttonCode = (profile: string, object: string, button: { buttonCode: string; level: string }) =>
  `${profile}/${object}/button:${button.buttonCode}@${button.level}`;
export const fieldCode = (profile: string, object: string, field: string, mode: 'view' | 'edit') =>
  `${profile}/${object}/field:${field}:${mode}`;
export const objectViewCode = (profile: string, object: string) => `${profile}/${object}/op:view`;

type Mutate = (permission: ObjectPermission) => ObjectPermission;
/** 旧定义：对指定身份的指定对象改写（去掉按钮、去掉字段编辑等）；对象返回 null 表示整个对象旧定义里没有。 */
export function withObject(profileCode: string, objectCode: string, mutate: Mutate | null) {
  return (profile: StandardProfile): StandardProfile => {
    if (profile.code !== profileCode) return profile;
    const objects = profile.objects.flatMap((o) => (o.objectCode !== objectCode ? [o] : mutate ? [mutate(o)] : []));
    return { ...profile, objects };
  };
}
export const withoutButton =
  (button: { buttonCode: string; level: string }): Mutate =>
  (o) => ({
    ...o,
    buttons: o.buttons.filter((b) => !(b.buttonCode === button.buttonCode && b.level === button.level)),
  });
export const withoutFieldEdit =
  (field: string): Mutate =>
  (o) => ({ ...o, fields: o.fields.map((f) => (f.fieldCode === field ? { ...f, edit: false } : f)) });

export interface World {
  readonly db: Db;
  readonly api: ReturnType<typeof tenantApi>;
  readonly operator: { id: string };
  readonly tenantId: string;
  readonly asAdmin: { user: string; tenant: string };
  /** 身份编码 → 身份 ID（旧版本升级夹具装下的标准身份）。 */
  readonly profileIds: ReadonlyMap<string, string>;
}

/** 旧版本升级夹具：tenant + 租户管理员 + 全部标准身份（installProfileRows，按 transforms 改写旧定义，不写台账）。 */
export async function legacyWorld(
  db: Db,
  label: string,
  transforms: readonly ((profile: StandardProfile) => StandardProfile)[] = [],
  skipCodes: readonly string[] = [],
): Promise<World> {
  const api = tenantApi(db, { authorize: undefined });
  const operator = await seedOperator(db, `ops-${label}`);
  const { tenant, user } = await seedTenantWithMember(db, label);
  await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: user.id }, cmd());
  const profileIds = new Map<string, string>();
  const write = { tenantId: tenant.id, actorUserId: null, now: new Date(), commandId: `legacy-${randomUUID()}` };
  await withTenant(db, tenant.id, async (tx) => {
    for (const standard of STANDARD_PROFILES) {
      if (skipCodes.includes(standard.code)) continue;
      const legacy = transforms.reduce((profile, transform) => transform(profile), standard);
      profileIds.set(legacy.code, (await installProfileRows(tx, write, legacy)).id);
    }
  });
  return { db, api, operator, tenantId: tenant.id, asAdmin: { user: user.id, tenant: tenant.id }, profileIds };
}

export interface BackfillReport {
  items: { module: string; key: string; version: number; installed: string[]; existing: number }[];
}
export const backfill = (
  w: Pick<World, 'api' | 'operator' | 'tenantId'>,
  body: object = { modules: ['permission'] },
  idempotencyKey?: string,
) =>
  w.api.request('POST', `${PLATFORM}/tenants/${w.tenantId}/seeds/backfill`, {
    user: w.operator.id,
    body,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
export async function runBackfill(w: Pick<World, 'api' | 'operator' | 'tenantId'>, body?: object, key?: string) {
  const res = await backfill(w, body, key);
  if (res.status !== 200) throw new Error(`回补失败：${res.status} ${await res.text()}`);
  return (await res.json()) as BackfillReport;
}
/** 回补报告里 permission/standard-profile-grants 本次补装的编码。 */
export const grantsInstalled = (report: BackfillReport) =>
  report.items.find((i) => i.key === 'standard-profile-grants')!.installed;

export const ledger = (w: Pick<World, 'db' | 'tenantId'>, entry = STANDARD_GRANT_ENTRY) =>
  withTenant(w.db, w.tenantId, (tx) => readLedger(tx, entry));

export const permissionOf = async (
  w: Pick<World, 'db' | 'tenantId' | 'profileIds'>,
  profileCode: string,
  objectCode: string,
): Promise<ObjectPermission | undefined> =>
  withTenant(w.db, w.tenantId, async (tx) => {
    const [permission] = await loadObjectPermissions(tx, [w.profileIds.get(profileCode)!], objectCode);
    return permission;
  });

export const revisionOf = async (w: Pick<World, 'db' | 'tenantId' | 'profileIds'>, profileCode: string) =>
  withTenant(w.db, w.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(permissionProfiles)
      .where(eq(permissionProfiles.id, w.profileIds.get(profileCode)!));
    return row!.revision;
  });

/** 租户管理员经 API 保存某身份某对象的权限（先读当前 revision 与对象权限，mutate 后整体替换）。 */
export async function putObject(
  w: Pick<World, 'api' | 'asAdmin'>,
  profileId: string,
  objectCode: string,
  mutate: Mutate,
): Promise<Response> {
  const detailRes = await w.api.request('GET', `/api/tenant/permission/profiles/${profileId}`, w.asAdmin);
  const detail = (await detailRes.json()) as { revision: number; objects: ObjectPermission[] };
  const current = detail.objects.find((o) => o.objectCode === objectCode)!;
  // 缺省按不带目录指纹的旧客户端保存（D2 = A 的用例自己带指纹）
  const {
    objectCode: _code,
    catalogDigest: _digest,
    ...body
  } = mutate(current) as ObjectPermission & {
    catalogDigest?: string;
  };
  return w.api.request('PUT', `/api/tenant/permission/profiles/${profileId}/objects/${objectCode}`, {
    ...w.asAdmin,
    ifMatch: detail.revision,
    body,
  });
}

/**
 * F-061 上线前的租户保存（旧 setObjectPermission）：直接改权限行、revision + 1、写 set_object 审计，不写台账标记。
 * 用来造“有 set_object 审计、没有 @modified 标记”的历史。
 */
export async function legacySave(w: World, profileCode: string, objectCode: string, mutate: Mutate): Promise<void> {
  const profileId = w.profileIds.get(profileCode)!;
  const { recordAudit } = await import('../../../apps/api/src/audit/record.js');
  await withTenant(w.db, w.tenantId, async (tx) => {
    const [current] = await loadObjectPermissions(tx, [profileId], objectCode);
    const next = mutate(current!);
    const key = { tenantId: w.tenantId, profileId, objectCode };
    await tx
      .delete(permissionProfileObjects)
      .where(
        and(eq(permissionProfileObjects.profileId, profileId), eq(permissionProfileObjects.objectCode, objectCode)),
      );
    await tx.insert(permissionProfileObjects).values({
      ...key,
      canCreate: next.dataOperations.create,
      canUpdate: next.dataOperations.update,
      canDelete: next.dataOperations.delete,
    });
    if (next.fields.length)
      await tx
        .insert(permissionProfileFields)
        .values(next.fields.map((f) => ({ ...key, fieldCode: f.fieldCode, canView: f.view, canEdit: f.edit })));
    if (next.buttons.length)
      await tx
        .insert(permissionProfileButtons)
        .values(next.buttons.map((b) => ({ ...key, buttonCode: b.buttonCode, level: b.level })));
    const [row] = await tx.select().from(permissionProfiles).where(eq(permissionProfiles.id, profileId));
    const [bumped] = await tx
      .update(permissionProfiles)
      .set({ revision: row!.revision + 1 })
      .where(eq(permissionProfiles.id, profileId))
      .returning();
    await recordAudit(tx, {
      tenantId: w.tenantId,
      actorUserId: w.asAdmin.user,
      action: 'permission_profile.set_object',
      objectType: 'permission_profile',
      objectId: profileId,
      before: current ?? null,
      after: { ...next, revision: bumped!.revision },
      commandId: `legacy-save-${randomUUID()}`,
      // 上线前的旧审计：早于保留期（默认 6 个月），T-22 用审计保留清理把它删掉
      occurredAt: new Date('2025-01-01T00:00:00Z'),
    });
  });
}

/** 模拟更早的保存审计已被清理：直接把身份 revision 调大（审计条数 < revision − 1）。 */
export const inflateRevision = (w: World, profileCode: string, by: number) =>
  withTenant(w.db, w.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(permissionProfiles)
      .where(eq(permissionProfiles.id, w.profileIds.get(profileCode)!));
    await tx
      .update(permissionProfiles)
      .set({ revision: row!.revision + by })
      .where(eq(permissionProfiles.id, row!.id));
  });

/** 新开通的租户（走平台开通命令），返回租户管理员与各标准身份 ID。 */
export async function provisionWorld(db: Db, label: string): Promise<World> {
  const { provisioned } = await import('./platform-api.js');
  const api = tenantApi(db, { authorize: undefined });
  const operator = await seedOperator(db, `ops-${label}`);
  const admin = await newUser(db, `admin-${label}`);
  const exception = await newUser(db, `exception-${label}`);
  const result = await provisioned(api, operator, {
    firstAdminUserId: admin.id,
    exceptionAdminUserId: exception.id,
    licenses: [{ licenseType: 'core_hr', quota: 10 }],
  });
  return {
    db,
    api,
    operator,
    tenantId: result.tenant.id,
    asAdmin: { user: admin.id, tenant: result.tenant.id },
    profileIds: new Map(result.profiles.map((p) => [p.code, p.id])),
  };
}
