/**
 * R3-T04 人才盘点验收夹具（设计 §2.1、§6、§7；PR-A 准备度字典）。接口挂在 /api/tenant/talent-review/ 之下；
 * 缺省注入“全部允许”的授权钩子，权限用例另用真实授权器（readinessOperator）。
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
import { type RequestOptions, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

export const TR_NOW = new Date('2026-10-09T02:00:00.000Z');
export const TR_BASE = '/api/tenant/talent-review';
export const READINESS = TALENT_REVIEW_OBJECTS.readiness;

export interface ReadinessView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string;
  readonly sortNo: number;
  readonly enabled: boolean;
  readonly revision: number;
  readonly createdBy: string;
}

export interface Identity {
  readonly user: string;
  readonly tenant: string;
}

let counter = 0;
export const readinessBody = (extra: Record<string, unknown> = {}) => {
  counter += 1;
  return { code: `RN${counter}-${randomUUID().slice(0, 4)}`, name: `准备度${counter}`, color: '#3366FF', ...extra };
};

/** 一个租户 + 一名成员（全部允许），带准备度快捷方法。 */
export async function readinessWorld(db: Db, label: string) {
  const member = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock: () => TR_NOW });
  const as: Identity = { user: member.user.id, tenant: member.tenant.id };
  const request = (method: string, path: string, options: RequestOptions = {}, who: Identity = as) =>
    api.request(method, `${TR_BASE}${path}`, { ...options, ...who });
  const create = async (body: Record<string, unknown> = readinessBody(), who: Identity = as) => {
    const response = await request('POST', '/readiness-levels', { ifMatch: 0, body }, who);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ReadinessView;
  };
  const read = async (id: string) => {
    const response = await request('GET', `/readiness-levels/${id}`);
    return { status: response.status, body: (await response.json()) as ReadinessView };
  };
  return { api, as, member, request, create, read };
}

export interface OperatorOptions {
  readonly seeAll?: boolean;
  readonly hidden?: readonly string[];
  readonly readonly?: readonly string[];
  readonly buttons?: boolean;
  readonly view?: boolean;
}

/** 真实授权器下的操作人：身份只带 TalentReview 应用与准备度对象，按需配置看全部、隐藏字段、按钮。 */
export async function readinessOperator(world: PermissionWorld, options: OperatorOptions = {}) {
  const profile = await createProfile(world, `tr-${randomUUID().slice(0, 8)}`, { apps: [TALENT_REVIEW_APP] });
  const hidden = new Set(options.hidden ?? []);
  const locked = new Set(options.readonly ?? []);
  const setButtons = async (buttons: boolean) => {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: READINESS.fields.map((field) => ({
          fieldCode: field.code,
          view: !hidden.has(field.code),
          edit: !field.system && !hidden.has(field.code) && !locked.has(field.code),
        })),
        buttons: buttons ? READINESS.buttons.map((button) => ({ buttonCode: button.code, level: button.level })) : [],
      },
      READINESS.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  if (options.view !== false) await setButtons(options.buttons ?? true);
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `tr-operator-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: world.tenant.id };
  let seeAllRevision = 0;
  const setSeeAll = async (seeAll: boolean) => {
    const response = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${TALENT_REVIEW_APP}`, {
      ...world.asAdmin,
      ifMatch: seeAllRevision,
      body: { targetKind: 'entity', targetCode: READINESS.code, seeAll },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    seeAllRevision = ((await response.json()) as { revision: number }).revision;
  };
  if (options.seeAll) await setSeeAll(true);
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, `${TR_BASE}${path}`, { ...as, ...extra });
  return { profile, user, as, request, setSeeAll, setButtons };
}
