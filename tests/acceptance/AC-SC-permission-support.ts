/**
 * R3-T05 权限用例夹具（真实授权器；设计 §8、DEC-043）：在 successionWorld 的租户上开通租户管理员，按需建
 * “继任记录”身份——应用 SuccessionAndDevelopment、对象 Succession.Record 的字段 / 按钮、看全部或管理单元范围。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { SUCCESSION_APP, SUCCESSION_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { SC_BASE, SC_NOW, type SuccessionWorld } from './AC-SC-support.js';
import { cmd, type RequestOptions, tenantApi } from './support/tenant-api.js';

export const RECORD = SUCCESSION_OBJECTS.record;
const PERMISSION = '/api/tenant/permission';

export async function permissionWorldOf(w: SuccessionWorld): Promise<PermissionWorld> {
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
  const api = tenantApi(w.db, { authorize: undefined, clock: () => SC_NOW });
  return {
    db: w.db,
    tenant: w.tenant,
    admin: w.user,
    adminRecord,
    api,
    asAdmin: { user: w.user.id, tenant: w.tenant.id },
  };
}

export interface OperatorOptions {
  /** 绑定到已有用户（如某名员工的账号）；缺省新建成员。 */
  readonly userId?: string;
  readonly seeAll?: boolean;
  /** 授权管理单元包含的组织（含下级）；缺省为空 = 没有范围。 */
  readonly orgIds?: readonly string[];
  readonly hidden?: readonly string[];
  readonly view?: boolean;
  /** 同时开通审计查看（admin 角色 audit_admin）。 */
  readonly audit?: boolean;
  /** 写权限（A2）：数据操作开关、按钮（缺省全列表级 / 详情级按对象目录）与可编辑字段（缺省全部）；缺省无写权限。 */
  readonly writer?: {
    readonly operations: { create?: boolean; update?: boolean; delete?: boolean };
    readonly buttons: readonly string[];
    readonly noEdit?: readonly string[];
  };
}

/** 继任记录查看人：对象查看权 + 字段 +（可选）看全部 / 管理单元；所有字段都可查看，除 hidden 外。 */
export async function recordOperator(world: PermissionWorld, options: OperatorOptions = {}) {
  const profile = await createProfile(world, `sc-${randomUUID().slice(0, 8)}`, { apps: [SUCCESSION_APP] });
  const hidden = new Set(options.hidden ?? []);
  if (options.view !== false) {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false, ...options.writer?.operations },
        fields: RECORD.fields.map((field) => ({
          fieldCode: field.code,
          view: !hidden.has(field.code),
          edit: Boolean(options.writer) && !field.system && !(options.writer?.noEdit ?? []).includes(field.code),
        })),
        buttons: RECORD.buttons
          .filter((button) => options.writer?.buttons.includes(button.code))
          .map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      RECORD.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  const userId = options.userId ?? (await addMember(world, `sc-op-${randomUUID().slice(0, 4)}`)).id;
  expect((await grant(world, userId, profile.id)).status).toBe(201);
  const as = { user: userId, tenant: world.tenant.id };
  if (options.seeAll) {
    const response = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${SUCCESSION_APP}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'entity', targetCode: RECORD.code, seeAll: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  if (options.orgIds) {
    const mou = await world.api.request('POST', `${PERMISSION}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: {
        code: `sc-${randomUUID().slice(0, 8)}`,
        name: '继任管理单元',
        orgRanges: options.orgIds.map((orgId) => ({ orgId, includeDescendants: true })),
      },
    });
    expect(mou.status, await mou.clone().text()).toBe(201);
    const assigned = await world.api.request('PUT', `${PERMISSION}/scopes/${userId}/${SUCCESSION_APP}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'mou', mouId: ((await mou.json()) as { id: string }).id },
    });
    expect(assigned.status, await assigned.clone().text()).toBe(200);
  }
  if (options.audit) {
    const response = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, `${SC_BASE}${path}`, { ...as, ...extra });
  return { profile, userId, as, request };
}
