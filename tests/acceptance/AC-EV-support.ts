/**
 * R3-T02 PR-B（人才评定配置）的验收夹具（设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §3.2、§5.1）。
 * 接口挂在 /api/tenant/evaluation/ 之下；权限用例用真实授权器：身份只含 TEvaluation 应用，按选项授予各对象的数据操作、
 * 字段查看 / 编辑与按钮，数据范围按（用户 × TEvaluation）一份、缺省为空（DEC-043）。
 */
import { randomUUID } from 'node:crypto';
import { EVALUATION_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { TC_NOW } from './AC-TC-support.js';
import type { RequestOptions } from './support/tenant-api.js';

export const EV_BASE = '/api/tenant/evaluation';
export const EV_APP = 'TEvaluation';
export const EV_NOW = TC_NOW;

export type EvaluationKey = keyof typeof EVALUATION_OBJECTS;

export interface ActivityTypeView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly displayOrder: number;
  readonly enabled: boolean;
  readonly syncQualification: boolean;
  readonly createdBy: string;
}

export interface OperatorOptions {
  /** 看不到（也不能编辑）的字段。 */
  readonly hidden?: Partial<Record<EvaluationKey, string[]>>;
  /** 看得到、不能编辑的字段。 */
  readonly readonly?: Partial<Record<EvaluationKey, string[]>>;
  /** 没有新建 / 编辑 / 删除数据操作权的对象。 */
  readonly noCreate?: readonly EvaluationKey[];
  readonly noUpdate?: readonly EvaluationKey[];
  readonly noDelete?: readonly EvaluationKey[];
  /** 完全不授权的对象（没有查看权）。 */
  readonly noObject?: readonly EvaluationKey[];
  /** 授权了对象但不给按钮。 */
  readonly noButtons?: readonly EvaluationKey[];
  /** TEvaluation 看全部（身份级）。 */
  readonly seeAll?: boolean;
  /** 日志审计管理员。 */
  readonly auditor?: boolean;
}

const seeAllRevisions = new Map<string, number>();
const policyRevisions = new Map<string, number>();

async function setSeeAll(world: PermissionWorld, profileId: string, value: boolean) {
  const key = `${profileId}:${EV_APP}`;
  const response = await world.api.request('PUT', `${BASE}/profiles/${profileId}/data-scopes/${EV_APP}`, {
    ...world.asAdmin,
    ifMatch: seeAllRevisions.get(key) ?? 0,
    body: { targetKind: 'app', targetCode: '', seeAll: value },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  seeAllRevisions.set(key, ((await response.json()) as { revision: number }).revision);
}

/** 某对象的企业范围策略改为只认“使用用户”维度（创建人，DEC-121 字典口径）。 */
export async function creatorOnly(world: PermissionWorld, key: EvaluationKey) {
  const object = EVALUATION_OBJECTS[key].code;
  const response = await world.api.request(
    'PUT',
    `/api/tenant/permission/scope-policies/${EV_APP}/${object}/entity/${object}`,
    { ...world.asAdmin, ifMatch: policyRevisions.get(object) ?? 0, body: { rules: [{ dimension: 'using_user' }] } },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  policyRevisions.set(object, ((await response.json()) as { revision: number }).revision);
}

export async function operator(world: PermissionWorld, options: OperatorOptions = {}) {
  const profile = await createProfile(world, `ev-${randomUUID().slice(0, 8)}`, { apps: [EV_APP] });
  const apply = async (key: EvaluationKey, hiddenFields: readonly string[]) => {
    const definition = EVALUATION_OBJECTS[key];
    const hidden = new Set(hiddenFields);
    const readonly = new Set(options.readonly?.[key] ?? []);
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: {
          create: !options.noCreate?.includes(key),
          update: !options.noUpdate?.includes(key),
          delete: !options.noDelete?.includes(key),
        },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: !hidden.has(field.code),
          edit: !field.system && !hidden.has(field.code) && !readonly.has(field.code),
        })),
        buttons: options.noButtons?.includes(key)
          ? []
          : definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  for (const key of Object.keys(EVALUATION_OBJECTS) as EvaluationKey[]) {
    if (!options.noObject?.includes(key)) await apply(key, options.hidden?.[key] ?? []);
  }
  if (options.seeAll) await setSeeAll(world, profile.id, true);
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `ev-op-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  if (options.auditor) {
    const response = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId: user.id, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  const as = { user: user.id, tenant: world.tenant.id };
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, path.startsWith('/api/') ? path : `${EV_BASE}${path}`, { ...as, ...extra });
  return {
    request,
    as,
    userId: user.id,
    profileId: profile.id,
    /** 撤销身份级看全部（回到缺省：空；字典另可经 creatorOnly 只剩创建人维度）。 */
    revokeSeeAll: () => setSeeAll(world, profile.id, false),
    /** 改某对象的隐藏字段（其余授权不变）。 */
    hide: (key: EvaluationKey, fields: readonly string[]) => apply(key, fields),
  };
}

export type Operator = Awaited<ReturnType<typeof operator>>;

/** 响应体解析：断言状态码并带出原文便于排错。 */
export async function ok<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

/** 错误响应的 { code, reason }。 */
export async function errorOf(response: Response): Promise<{ code?: string; reason?: string }> {
  const body = (await response.clone().json()) as { error?: { code?: string; details?: { reason?: string } } };
  return { code: body.error?.code, reason: body.error?.details?.reason };
}
