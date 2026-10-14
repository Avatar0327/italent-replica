import { objectPermissionSets, permissionSet } from './sets.js';
import { sql } from '@italent/db';
import { scopeRows } from './scope-hierarchy.js';
import { employeeIdentityProfileId } from './employee-identity.js';
import {
  managerIdentity,
  defaultManagerPermissions,
  MANAGER_PROFILE_CODE,
  type ManagerQuery,
} from './manager-identity.js';
/**
 * 读取一个用户在当前租户的权限主体：有效的管理员身份（L2）+ 有效授权所对应身份的对象权限（L3）。
 * 每次请求都从库里重新读取（AGENTS.md §10「权限」：每次请求重验，撤权即生效，无缓存）。
 * 必须在 withTenant 事务内调用：RLS 保证只读到当前租户的数据。
 */
import {
  and,
  eq,
  permissionAdmins,
  permissionGrants,
  permissionProfileApps,
  permissionProfileButtons,
  permissionProfileFields,
  permissionProfileObjects,
  type Tx,
} from '@italent/db';
import { inArray } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  type AdminRole,
  type ButtonLevel,
  type GrantedObjectPermission,
  isAdminRole,
  type ObjectPermission,
  type PermissionSubject,
} from '@italent/domain';

export async function loadAdminRoles(tx: Tx, userId: string): Promise<AdminRole[]> {
  const rows = await tx
    .select({ role: permissionAdmins.role })
    .from(permissionAdmins)
    .where(and(eq(permissionAdmins.userId, userId), eq(permissionAdmins.status, 'active')));
  return permissionSet(rows.map((r) => r.role).filter(isAdminRole));
}

export async function loadActiveProfileIds(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ profileId: permissionGrants.profileId })
    .from(permissionGrants)
    .where(and(eq(permissionGrants.userId, userId), eq(permissionGrants.status, 'active')));
  return permissionSet(rows.map((r) => r.profileId));
}

/** 身份对象权限（按 身份 × 对象 一条，未合并）；objectCode 给定时只取该对象。 */
export async function loadObjectPermissions(
  tx: Tx,
  profileIds: readonly string[],
  objectCode?: string,
): Promise<ObjectPermission[]> {
  const rows = await loadObjectPermissionRows(tx, profileIds, objectCode);
  return rows.map(({ profileId: _profileId, ...permission }) => permission);
}

async function loadObjectPermissionRows(
  tx: Tx,
  profileIds: readonly string[],
  objectCode?: string,
): Promise<(ObjectPermission & { profileId: string })[]> {
  if (profileIds.length === 0) return [];
  const byObject = (table: { profileId: AnyPgColumn; objectCode: AnyPgColumn }) =>
    and(
      inArray(table.profileId, [...profileIds]),
      objectCode === undefined ? undefined : eq(table.objectCode, objectCode),
    );
  const objects = await tx
    .select()
    .from(permissionProfileObjects)
    .where(byObject(permissionProfileObjects))
    .orderBy(permissionProfileObjects.profileId, permissionProfileObjects.objectCode);
  const fields = await tx.select().from(permissionProfileFields).where(byObject(permissionProfileFields));
  const buttons = await tx.select().from(permissionProfileButtons).where(byObject(permissionProfileButtons));
  const same = (o: (typeof objects)[number]) => (r: { profileId: string; objectCode: string }) =>
    r.profileId === o.profileId && r.objectCode === o.objectCode;
  return objects.map((o) =>
    objectPermissionSets({
      profileId: o.profileId,
      objectCode: o.objectCode,
      dataOperations: { create: o.canCreate, update: o.canUpdate, delete: o.canDelete },
      fields: fields.filter(same(o)).map((f) => ({ fieldCode: f.fieldCode, view: f.canView, edit: f.canEdit })),
      buttons: buttons.filter(same(o)).map((b) => ({ buttonCode: b.buttonCode, level: b.level as ButtonLevel })),
    }),
  );
}

export interface SubjectOptions {
  /** 叠加员工自动身份（employee_self_service）的对象权限；需要同时传 managerQuery 以带上租户。 */
  employeeIdentity?: boolean;
}

/** 用户有效授权带来的对象权限，各自带上所属身份登记的应用（判定应用边界用）。 */
export async function loadGrantedObjectPermissions(
  tx: Tx,
  userId: string,
  objectCode?: string,
  managerQuery?: ManagerQuery,
  options: SubjectOptions = {},
): Promise<GrantedObjectPermission[]> {
  const profileIds = await loadActiveProfileIds(tx, userId);
  // F-141 ①（DEC-500）：员工自动身份只在调用方明确要求时叠加（功能权限查询 /me/objects）。授权器与快照不叠加，
  // 以免员工因此获得 HR 接口的功能通过或多出应用入口；员工的本人范围始终只在本人入口里。
  if (options.employeeIdentity && managerQuery) {
    const employeeProfile = await employeeIdentityProfileId(tx, managerQuery.tenantId, userId);
    if (employeeProfile && !profileIds.includes(employeeProfile)) profileIds.push(employeeProfile);
  }
  let defaults: GrantedObjectPermission[] = [];
  if (managerQuery && (await managerIdentity(tx, managerQuery)).active) {
    const [profile] = scopeRows<{ id: string }>(
      await tx.execute(sql`
      SELECT id FROM permission_profiles WHERE tenant_id=${managerQuery.tenantId} AND code=${MANAGER_PROFILE_CODE}
    `),
    );
    if (profile) profileIds.push(profile.id);
    else defaults = defaultManagerPermissions().filter((p) => !objectCode || p.objectCode === objectCode);
  }
  if (profileIds.length === 0) return defaults.map((permission) => objectPermissionSets(permission));
  const permissions = await loadObjectPermissionRows(tx, profileIds, objectCode);
  const apps = await tx
    .select({ profileId: permissionProfileApps.profileId, appCode: permissionProfileApps.appCode })
    .from(permissionProfileApps)
    .where(inArray(permissionProfileApps.profileId, profileIds));
  return [
    ...defaults.map((permission) => objectPermissionSets(permission)),
    ...permissions.map(({ profileId, ...permission }) => ({
      ...permission,
      profileApps: permissionSet(apps.filter((a) => a.profileId === profileId).map((a) => a.appCode)),
    })),
  ];
}

export async function loadSubject(
  tx: Tx,
  userId: string,
  objectCode?: string,
  managerQuery?: ManagerQuery,
  options: SubjectOptions = {},
): Promise<PermissionSubject> {
  const adminRoles = await loadAdminRoles(tx, userId);
  const objectPermissions = await loadGrantedObjectPermissions(tx, userId, objectCode, managerQuery, options);
  return { adminRoles, objectPermissions };
}
