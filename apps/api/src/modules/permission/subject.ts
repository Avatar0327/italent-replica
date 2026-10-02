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
  return rows.map((r) => r.role).filter(isAdminRole);
}

export async function loadActiveProfileIds(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ profileId: permissionGrants.profileId })
    .from(permissionGrants)
    .where(and(eq(permissionGrants.userId, userId), eq(permissionGrants.status, 'active')));
  return rows.map((r) => r.profileId);
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
  const objects = await tx.select().from(permissionProfileObjects).where(byObject(permissionProfileObjects));
  const fields = await tx.select().from(permissionProfileFields).where(byObject(permissionProfileFields));
  const buttons = await tx.select().from(permissionProfileButtons).where(byObject(permissionProfileButtons));
  const same = (o: (typeof objects)[number]) => (r: { profileId: string; objectCode: string }) =>
    r.profileId === o.profileId && r.objectCode === o.objectCode;
  return objects.map((o) => ({
    profileId: o.profileId,
    objectCode: o.objectCode,
    dataOperations: { create: o.canCreate, update: o.canUpdate, delete: o.canDelete },
    fields: fields.filter(same(o)).map((f) => ({ fieldCode: f.fieldCode, view: f.canView, edit: f.canEdit })),
    buttons: buttons.filter(same(o)).map((b) => ({ buttonCode: b.buttonCode, level: b.level as ButtonLevel })),
  }));
}

/** 用户有效授权带来的对象权限，各自带上所属身份登记的应用（判定应用边界用）。 */
export async function loadGrantedObjectPermissions(
  tx: Tx,
  userId: string,
  objectCode?: string,
): Promise<GrantedObjectPermission[]> {
  const profileIds = await loadActiveProfileIds(tx, userId);
  if (profileIds.length === 0) return [];
  const permissions = await loadObjectPermissionRows(tx, profileIds, objectCode);
  const apps = await tx
    .select({ profileId: permissionProfileApps.profileId, appCode: permissionProfileApps.appCode })
    .from(permissionProfileApps)
    .where(inArray(permissionProfileApps.profileId, profileIds));
  return permissions.map(({ profileId, ...permission }) => ({
    ...permission,
    profileApps: apps.filter((a) => a.profileId === profileId).map((a) => a.appCode),
  }));
}

export async function loadSubject(tx: Tx, userId: string, objectCode?: string): Promise<PermissionSubject> {
  const adminRoles = await loadAdminRoles(tx, userId);
  const objectPermissions = await loadGrantedObjectPermissions(tx, userId, objectCode);
  return { adminRoles, objectPermissions };
}
