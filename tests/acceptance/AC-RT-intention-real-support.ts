/**
 * BE-5d2 AC-RT-20b / 20c 的真实授权器夹具：不用“看全部”替身，操作人只持有任职记录对象的功能授权（数据操作 / 字段 / 按钮）、
 * 审批实例对象的管理员按钮和一条数据范围（组织范围或使用用户维度），范围与按钮随用例收回；租户管理员（w.hr）负责授权。
 */
import { randomUUID } from 'node:crypto';
import { APPROVAL_INSTANCE_OBJECT, MODULE_OBJECTS, RETIREMENT_INTENTION_BUTTON } from '@italent/domain';
import { expect } from 'vitest';
import { permissionAdmin } from './AC-APV-support.js';
import { EMPLOYMENT, type IntentionWorld } from './AC-RT-intention-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';

const record = MODULE_OBJECTS.employmentRecord;
const worlds = new WeakMap<IntentionWorld, ReturnType<typeof permissionAdmin>>();
const adminOf = (w: IntentionWorld) => {
  if (!worlds.has(w)) worlds.set(w, permissionAdmin(w));
  return worlds.get(w)!;
};

/** 任职记录对象的对象权限：创建 / 修改 + 全部字段（非系统字段可编辑）+ 意向申请按钮（可选）；off = 按钮收回，其余照旧。 */
const recordPermission = (button: boolean, readOnlyFields: readonly string[] = []) => ({
  dataOperations: { create: true, update: true, delete: false },
  fields: record.fields.map((f) => ({
    fieldCode: f.code,
    view: true,
    edit: !f.system && !readOnlyFields.includes(f.code),
  })),
  buttons: button ? [{ buttonCode: RETIREMENT_INTENTION_BUTTON, level: 'detail' as const }] : [],
});

export interface RealUserOptions {
  /** 持有任职记录对象功能授权（含意向申请按钮）；缺省 true。 */
  readonly intentionButton?: boolean;
  /** 审批实例对象的管理员按钮（详情 / 转交范围用）；缺省无。 */
  readonly adminButtons?: readonly string[];
  /** 初始的组织范围；缺省不设（默认范围为空，fail-closed）。 */
  readonly orgIds?: readonly string[];
}

export async function realUser(w: IntentionWorld, name: string, options: RealUserOptions = {}) {
  const world = await adminOf(w);
  const userId = await w.member(name);
  const profile = await createProfile(world, `rt20-${randomUUID()}`);
  expect(
    (await setObjectPermission(world, profile, recordPermission(options.intentionButton ?? true), record.code)).status,
  ).toBe(200);
  if (options.adminButtons?.length)
    expect(
      (
        await setObjectPermission(
          world,
          profile,
          {
            dataOperations: { create: false, update: false, delete: false },
            fields: [],
            buttons: options.adminButtons.map((buttonCode) => ({ buttonCode, level: 'detail' })),
          },
          APPROVAL_INSTANCE_OBJECT,
        )
      ).status,
    ).toBe(200);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, userId, profile.id)).status).toBe(201);

  const as = { user: userId, tenant: w.tenant.id };
  let scopeRevision = 0;
  /** 应用级数据范围（管理单元 → 组织范围）；null = 回到默认（空范围）。 */
  async function setScope(orgIds: readonly string[] | null) {
    const body = orgIds
      ? { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: false })) }
      : { kind: 'default' };
    const response = await world.api.request('PUT', `/api/tenant/permission/scopes/${userId}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: scopeRevision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    scopeRevision = ((await response.json()) as { revision: number }).revision;
  }
  if (options.orgIds) await setScope(options.orgIds);
  /** 收回意向申请按钮（保留对象的数据操作与字段权）。 */
  async function revokeButton() {
    expect((await setObjectPermission(world, profile, recordPermission(false), record.code)).status).toBe(200);
  }
  /** 收回指定字段的编辑权（保留对象更新权、按钮与字段查看权）。 */
  async function revokeFieldEdit(...fieldCodes: string[]) {
    expect((await setObjectPermission(world, profile, recordPermission(true, fieldCodes), record.code)).status).toBe(
      200,
    );
  }
  const call = (method: string, path: string, init: { ifMatch?: number; body?: unknown } = {}) =>
    world.api.request(method, path.startsWith('/api/') ? path : `${EMPLOYMENT}${path}`, {
      ...as,
      ...(init.ifMatch !== undefined ? { ifMatch: init.ifMatch } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  return { userId, as, call, setScope, revokeButton, revokeFieldEdit, world };
}

/** 任职记录对象的实体数据范围规则（如只有“使用用户”维度）；配置前按管理单元 fail-closed 解析。 */
export async function setRecordScopeRules(w: IntentionWorld, dimensions: readonly string[]) {
  const world = await adminOf(w);
  const response = await world.api.request(
    'PUT',
    `/api/tenant/permission/scope-policies/TenantBase/${record.code}/entity/${record.code}`,
    { ...world.asAdmin, ifMatch: 0, body: { rules: dimensions.map((dimension) => ({ dimension })) } },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}
