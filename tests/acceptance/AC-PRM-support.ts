/**
 * AC-PRM-* 验收测试的公共装配：不注入“全部允许”，走真实的权限授权器（R1-T01）。
 * 租户的第一位租户管理员由平台方开通（L0，runPlatformCommand）；业务对象用合成元数据登记。
 */
import { randomBytes } from 'node:crypto';
import { bootstrapTenantAdmin, type PermissionAdminView, registerObjectDefinition } from '@italent/api';
import { createUser, type Db, grantMembership, type Tenant, type User } from '@italent/db';
import type { ObjectDefinition } from '@italent/domain';
import { cmd, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

export const BASE = '/api/tenant/permission';

/** 合成对象（仿任职记录）：两个普通字段、一个系统字段，直接执行与申请两类按钮。 */
export const DEMO_OBJECT: ObjectDefinition = {
  code: 'Demo.EmploymentRecord',
  application: 'TenantBase',
  fields: [
    { code: 'Name', system: false },
    { code: 'MobilePhone', system: false },
    { code: 'CreatedBy', system: true },
  ],
  buttons: [
    { code: 'Employment.Tranfer', level: 'list_row', requires: 'update' },
    { code: 'EmploymentRecord.TransferApproval', level: 'list_row' },
    { code: 'EmploymentRecord.Edit', level: 'detail', requires: 'update' },
    { code: 'EmploymentRecord.Delete', level: 'detail', requires: 'delete' },
    { code: 'EmploymentRecord.Print', level: 'detail' },
  ],
};

/** 合成对象：属于另一个应用（验证“身份 × 应用”边界）。 */
export const OTHER_APP_OBJECT: ObjectDefinition = {
  code: 'Demo.SalaryItem',
  application: 'DemoPayroll',
  fields: [{ code: 'Amount', system: false }],
  buttons: [{ code: 'SalaryItem.View', level: 'detail' }],
};

/** 合成大对象：与原站任职记录同规模（274 字段、349 按钮，06 §7.2），验证整对象替换载荷可提交。 */
export const LARGE_OBJECT: ObjectDefinition = {
  code: 'Demo.LargeRecord',
  application: 'TenantBase',
  fields: Array.from({ length: 274 }, (_, i) => ({ code: `Field${String(i).padStart(3, '0')}`, system: false })),
  buttons: Array.from({ length: 349 }, (_, i) => ({
    code: `LargeRecord.Button${String(i).padStart(3, '0')}`,
    level: 'detail' as const,
  })),
};

export interface PermissionWorld {
  readonly db: Db;
  readonly tenant: Tenant;
  readonly admin: User;
  readonly adminRecord: PermissionAdminView;
  readonly api: ReturnType<typeof tenantApi>;
  readonly asAdmin: { user: string; tenant: string };
}

export async function seedPermissionWorld(db: Db): Promise<PermissionWorld> {
  for (const definition of [DEMO_OBJECT, OTHER_APP_OBJECT, LARGE_OBJECT]) registerObjectDefinition(definition);
  const { tenant, user: admin } = await seedTenantWithMember(db, 'prm');
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: admin.id }, cmd());
  // authorize: undefined → createApp 使用真实的权限授权器
  const api = tenantApi(db, { authorize: undefined });
  return { db, tenant, admin, adminRecord, api, asAdmin: { user: admin.id, tenant: tenant.id } };
}

export async function addMember(world: PermissionWorld, label: string): Promise<User> {
  const suffix = randomBytes(3).toString('hex');
  const user = await createUser(world.db, { email: `${label}-${suffix}@example.com`, displayName: label }, cmd());
  await grantMembership(world.db, { tenantId: world.tenant.id, userId: user.id, expectedRevision: 0 }, cmd());
  return user;
}

export interface ProfileBody {
  id: string;
  code: string;
  revision: number;
}

export async function createProfile(
  world: PermissionWorld,
  code: string,
  extra: { licenseType?: string; apps?: string[] } = {},
): Promise<ProfileBody> {
  const res = await world.api.request('POST', `${BASE}/profiles`, {
    ...world.asAdmin,
    body: { code, name: `身份${code}`, apps: extra.apps ?? ['TenantBase'], licenseType: extra.licenseType ?? null },
  });
  if (res.status !== 201) throw new Error(`建身份失败：${res.status} ${await res.text()}`);
  return (await res.json()) as ProfileBody;
}

export interface ObjectPermissionInput {
  dataOperations: { create: boolean; update: boolean; delete: boolean };
  fields: { fieldCode: string; view: boolean; edit: boolean }[];
  buttons: { buttonCode: string; level: string }[];
}

export async function setObjectPermission(
  world: PermissionWorld,
  profile: ProfileBody,
  input: ObjectPermissionInput,
  objectCode: string = DEMO_OBJECT.code,
): Promise<Response> {
  const res = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/objects/${objectCode}`, {
    ...world.asAdmin,
    ifMatch: profile.revision,
    body: input,
  });
  if (res.ok) profile.revision = ((await res.clone().json()) as ProfileBody).revision;
  return res;
}

/** 把身份加入租户管理员记录的可授权业务身份（新建身份默认不可授权，原站 FAQ）。 */
export async function makeGrantable(world: PermissionWorld, profileIds: string[]): Promise<void> {
  const current = await world.api.request('GET', `${BASE}/admins/${world.adminRecord.id}`, world.asAdmin);
  const record = (await current.json()) as PermissionAdminView;
  const res = await world.api.request('PUT', `${BASE}/admins/${record.id}`, {
    ...world.asAdmin,
    ifMatch: record.revision,
    body: {
      grantableAdminRoles: record.grantableAdminRoles,
      grantableProfileIds: [...new Set([...record.grantableProfileIds, ...profileIds])],
    },
  });
  if (res.status !== 200) throw new Error(`设置可授权身份失败：${res.status} ${await res.text()}`);
}

export async function grant(world: PermissionWorld, userId: string, profileId: string): Promise<Response> {
  return world.api.request('POST', `${BASE}/grants`, { ...world.asAdmin, body: { userId, profileId } });
}

export interface MyObjectPermission {
  objectCode: string;
  dataOperations: { create: boolean; update: boolean; delete: boolean };
  viewableFields: string[];
  editableFields: string[];
  buttons: { buttonCode: string; level: string }[];
}

export async function myObject(world: PermissionWorld, user: User, objectCode = DEMO_OBJECT.code) {
  return world.api.request('GET', `${BASE}/me/objects/${objectCode}`, { user: user.id, tenant: world.tenant.id });
}
