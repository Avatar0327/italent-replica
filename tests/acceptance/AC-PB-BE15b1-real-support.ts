/**
 * BE-15b1 第 1 轮审查返工（#415）的真实授权器夹具：不用“看全部”替身，操作人只持有考核对象的功能授权（数据操作 / 字段 /
 * 按钮）和一条组织范围，范围随用例收回；租户管理员（w.hr）负责授权。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import type { AssessmentWorld } from './AC-PB-BE15b1-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission, type ProfileBody } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const EMPLOYMENT = '/api/tenant/employment';
const object = MODULE_OBJECTS.probationAssessment;

/** 考核对象的对象权限：on = 创建 / 修改 + 全部字段（非系统字段可编辑）+ 两个按钮；off = 全部撤销（字段仍可见）。 */
const permission = (on: boolean) => ({
  dataOperations: { create: on, update: on, delete: false },
  fields: object.fields.map((f) => ({ fieldCode: f.code, view: true, edit: on && !f.system })),
  buttons: on ? object.buttons.map((b) => ({ buttonCode: b.code, level: b.level })) : [],
});

async function makeSeed(w: AssessmentWorld) {
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const asAdmin = { user: w.hr.id, tenant: w.tenant.id };
  return { db: w.db, tenant: w.tenant, admin: w.hr, adminRecord, api, asAdmin };
}
// 一个租户只开通一次租户管理员；同一世界里要多个操作人（创建人 / 旁观经办人）时共用
const seeds = new WeakMap<AssessmentWorld, ReturnType<typeof makeSeed>>();
function seedOf(w: AssessmentWorld) {
  if (!seeds.has(w)) seeds.set(w, makeSeed(w));
  return seeds.get(w)!;
}

/** 考核对象的实体数据范围规则（管理单元 / 使用用户等）；配置前考核对象按管理单元 fail-closed 解析。 */
export async function setAssessmentScopeRules(w: AssessmentWorld, dimensions: readonly string[]) {
  const { api, asAdmin } = await seedOf(w);
  const response = await api.request(
    'PUT',
    `/api/tenant/permission/scope-policies/TenantBase/${object.code}/entity/${object.code}`,
    { ...asAdmin, ifMatch: 0, body: { rules: dimensions.map((dimension) => ({ dimension })) } },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

export async function realOperator(w: AssessmentWorld, options: { orgIds?: string[] } = {}) {
  const realSeed = await seedOf(w);
  const { api, asAdmin } = realSeed;
  const seed = realSeed as never;
  const userId = await w.member('考核操作人');
  const profile: ProfileBody = await createProfile(seed, `assess-op-${randomUUID()}`);
  expect((await setObjectPermission(seed, profile, permission(true), object.code)).status).toBe(200);
  await makeGrantable(seed, [profile.id]);
  expect((await grant(seed, userId, profile.id)).status).toBe(201);

  const as = { user: userId, tenant: w.tenant.id };
  const scopePath = `/api/tenant/permission/scopes/${userId}/TenantBase`;
  let scopeRevision = 0;
  async function setScope(orgIds: readonly string[] | null) {
    const body = orgIds
      ? { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: false })) }
      : { kind: 'default' };
    const response = await api.request('PUT', scopePath, { ...asAdmin, ifMatch: scopeRevision, body });
    expect(response.status, await response.clone().text()).toBe(200);
    scopeRevision = ((await response.json()) as { revision: number }).revision;
  }
  if (options.orgIds) await setScope(options.orgIds);
  /** 撤销考核对象的功能授权（数据操作 / 按钮），范围不动。 */
  async function revokePermission() {
    expect((await setObjectPermission(seed, profile, permission(false), object.code)).status).toBe(200);
  }
  const call = (method: string, path: string, options: { ifMatch?: number; body?: unknown; key?: string } = {}) =>
    api.request(method, path.startsWith('/api/') ? path : `${EMPLOYMENT}${path}`, {
      ...as,
      ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.key ? { idempotencyKey: options.key } : {}),
    });
  return { userId, as, call, setScope, revokePermission, api, asAdmin };
}
