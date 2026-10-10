/**
 * R3-T04 PR-B1 配置对象验收夹具（设计 §2.2、§6.1、§7 配置 CRUD 行）：盘点分类 / 角色 / 字段目录 / 租户设置。
 * 接口挂在 /api/tenant/talent-review/ 之下；缺省注入“全部允许”的授权钩子，权限用例另用真实授权器（configOperator）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { TALENT_REVIEW_APP, TALENT_REVIEW_OBJECTS } from '@italent/domain';
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
import { TR_BASE, TR_NOW } from './AC-TR-support.js';
import { type RequestOptions, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

export { TR_BASE, TR_NOW };

/** 带列表信封的配置对象（设置是单例，不在其中）。 */
export const CONFIG_KINDS = {
  category: { path: '/categories', duplicate: 'CATEGORY_DUPLICATE', inUse: 'CATEGORY_IN_USE' },
  role: { path: '/roles', duplicate: 'ROLE_DUPLICATE', inUse: 'ROLE_IN_USE' },
  field: { path: '/fields', duplicate: 'FIELD_DUPLICATE', inUse: 'FIELD_IN_USE' },
} as const;
export type ConfigKind = keyof typeof CONFIG_KINDS;
export type ConfigObject = ConfigKind | 'settings';

let counter = 0;
const next = () => {
  counter += 1;
  return `${counter}_${randomUUID().slice(0, 4)}`;
};
/** 每种配置对象的最小合法载荷（编码 / 名称唯一）。 */
export const configBody = (kind: ConfigKind, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const n = next();
  if (kind === 'category') return { name: `分类${n}`, ...extra };
  if (kind === 'role') return { code: `role_${n}`, name: `角色${n}`, resolver: 'direct_manager', ...extra };
  return { code: `fld_${n}`, name: `字段${n}`, kind: 'text', group: 'evaluation', ...extra };
};

export interface ConfigView {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly createdBy: string;
  readonly [key: string]: unknown;
}
export interface Identity {
  readonly user: string;
  readonly tenant: string;
}

/** 一个租户 + 一名成员（全部允许），带配置对象快捷方法。 */
export async function configWorld(db: Db, label: string, deps: Parameters<typeof tenantApi>[1] = {}) {
  const member = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock: () => TR_NOW, ...deps });
  const as: Identity = { user: member.user.id, tenant: member.tenant.id };
  const request = (method: string, path: string, options: RequestOptions = {}, who: Identity = as) =>
    api.request(method, `${TR_BASE}${path}`, { ...options, ...who });
  const create = async (kind: ConfigKind, body: Record<string, unknown> = configBody(kind), who: Identity = as) => {
    const response = await request('POST', CONFIG_KINDS[kind].path, { ifMatch: 0, body }, who);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ConfigView;
  };
  const read = async (kind: ConfigKind, id: string, who: Identity = as) => {
    const response = await request('GET', `${CONFIG_KINDS[kind].path}/${id}`, {}, who);
    return { status: response.status, body: (await response.json()) as ConfigView };
  };
  return { api, as, member, request, create, read };
}

export interface OperatorOptions {
  readonly seeAll?: boolean;
  readonly hidden?: readonly string[];
  readonly readonly?: readonly string[];
  readonly buttons?: boolean;
  readonly view?: boolean;
  /** 数据操作权，缺省全开。 */
  readonly operations?: { create: boolean; update: boolean; delete: boolean };
  /** 即使 buttons 为真也不授予的按钮编码。 */
  readonly omitButtons?: readonly string[];
}

/** 真实授权器下的操作人：身份只带 TalentReview 应用与指定对象，按需配置看全部、隐藏字段、按钮。 */
export async function configOperator(world: PermissionWorld, object: ConfigObject, options: OperatorOptions = {}) {
  const definition = TALENT_REVIEW_OBJECTS[object];
  const profile = await createProfile(world, `trc-${randomUUID().slice(0, 8)}`, { apps: [TALENT_REVIEW_APP] });
  const hidden = new Set(options.hidden ?? []);
  const locked = new Set(options.readonly ?? []);
  const setButtons = async (buttons: boolean, omit: readonly string[] | undefined = options.omitButtons) => {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: options.operations ?? { create: true, update: true, delete: true },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: !hidden.has(field.code),
          edit: !field.system && !hidden.has(field.code) && !locked.has(field.code),
        })),
        buttons: buttons
          ? definition.buttons
              .filter((button) => !omit?.includes(button.code))
              .map((button) => ({ buttonCode: button.code, level: button.level }))
          : [],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  if (options.view !== false) await setButtons(options.buttons ?? true);
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `trc-operator-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: world.tenant.id };
  let seeAllRevision = 0;
  const setSeeAll = async (seeAll: boolean) => {
    const response = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${TALENT_REVIEW_APP}`, {
      ...world.asAdmin,
      ifMatch: seeAllRevision,
      body: { targetKind: 'entity', targetCode: definition.code, seeAll },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    seeAllRevision = ((await response.json()) as { revision: number }).revision;
  };
  if (options.seeAll) await setSeeAll(true);
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, `${TR_BASE}${path}`, { ...as, ...extra });
  return { profile, user, as, request, setSeeAll, setButtons };
}
