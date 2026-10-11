/**
 * R3-T04 PR-B3 盘点内容表单与流程定义验收夹具（设计 §2.2 forms / form_fields / flows / nodes / node_roles；DEC-306①）。
 * 接口 /api/tenant/talent-review/forms、/flows；缺省“全部允许”的授权钩子建数据，权限用例另用真实授权器（formOperator）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { TALENT_REVIEW_APP, TALENT_REVIEW_OBJECTS, type TalentReviewObject } from '@italent/domain';
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
import { configBody, configWorld, type ConfigView } from './AC-TR-config-support.js';
import { TR_BASE } from './AC-TR-support.js';
import type { RequestOptions } from './support/tenant-api.js';

export const FORMS = '/forms';
export const FLOWS = '/flows';

export interface FormView extends ConfigView {
  readonly code: string;
  readonly kind: string;
  readonly preset: boolean;
  readonly fields: { fieldId: string; access: string; required: boolean }[];
}
export interface FlowNodeView {
  readonly id: string;
  readonly nodeKey: string;
  readonly name: string;
  readonly kind: string;
  readonly stepType: string;
  readonly mode: string;
  readonly allowReturn: boolean;
  readonly allowTransfer: boolean;
  readonly allowDisagree: boolean;
  readonly roleIds: string[];
}
export interface FlowView extends ConfigView {
  readonly nodes: FlowNodeView[];
}

let counter = 0;
const next = () => {
  counter += 1;
  return `${counter}_${randomUUID().slice(0, 4)}`;
};

export const formBody = (
  fields: { fieldId: string; access?: string; required?: boolean }[],
  extra: Record<string, unknown> = {},
) => {
  const n = next();
  return {
    code: `form_${n}`,
    name: `表单${n}`,
    kind: 'info',
    fields: fields.map((field) => ({ access: 'edit', ...field })),
    ...extra,
  };
};

export const nodeBody = (roleIds: string[], extra: Record<string, unknown> = {}) => {
  const n = next();
  return {
    nodeKey: `n_${n}`,
    name: `节点${n}`,
    kind: 'single',
    stepType: 'evaluate',
    mode: 'single',
    roleIds,
    ...extra,
  };
};
export const flowBody = (nodes: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  name: `流程${next()}`,
  nodes,
  ...extra,
});

/** 一个租户 + 一名成员（全部允许），带表单 / 流程与引用的字段 / 角色的快捷方法。 */
export async function formFlowWorld(db: Db, label: string) {
  const world = await configWorld(db, label);
  const field = (extra: Record<string, unknown> = {}) => world.create('field', configBody('field', extra));
  const role = (extra: Record<string, unknown> = {}) => world.create('role', configBody('role', extra));
  const post = (path: string, body: Record<string, unknown>, options: RequestOptions = {}) =>
    world.request('POST', path, { ifMatch: 0, body, ...options });
  const created = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const response = await post(path, body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  };
  const createForm = async (extra: Record<string, unknown> = {}, fieldIds?: string[]) =>
    created<FormView>(
      FORMS,
      formBody(
        (fieldIds ?? [(await field()).id]).map((fieldId) => ({ fieldId })),
        extra,
      ),
    );
  const createFlow = async (extra: Record<string, unknown> = {}, roleIds?: string[]) =>
    created<FlowView>(FLOWS, flowBody([nodeBody(roleIds ?? [(await role()).id])], extra));
  const read = async <T>(path: string, id: string) => {
    const response = await world.request('GET', `${path}/${id}`);
    return { status: response.status, body: (await response.json()) as T };
  };
  const list = async <T>(path: string, query = '') =>
    (await (await world.request('GET', `${path}${query}`)).json()) as { items: T[] };
  return { ...world, field, role, post, createForm, createFlow, read, list };
}

export const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;

export interface FormOperatorOptions {
  readonly seeAll?: boolean;
  readonly hidden?: readonly string[];
  readonly readonly?: readonly string[];
  readonly buttons?: boolean;
  readonly omitButtons?: readonly string[];
  readonly view?: boolean;
  /** 引用字段 / 角色所需的目录权限：缺省有查看权但没有看全部；seeAll 给看全部；none 不给查看权。 */
  readonly reference?: 'none' | 'creator' | 'seeAll';
}

/**
 * 真实授权器下的操作人：身份带 TalentReview 应用、目标对象（form / flow）与（可选）被引用目录（form → 字段，flow → 角色）的权限。
 */
export async function formOperator(world: PermissionWorld, object: 'form' | 'flow', options: FormOperatorOptions = {}) {
  const target = TALENT_REVIEW_OBJECTS[object];
  const referenced: TalentReviewObject = object === 'form' ? 'field' : 'role';
  const catalog = TALENT_REVIEW_OBJECTS[referenced];
  const profile = await createProfile(world, `trf-${randomUUID().slice(0, 8)}`, { apps: [TALENT_REVIEW_APP] });
  const hidden = new Set(options.hidden ?? []);
  const locked = new Set(options.readonly ?? []);
  const setButtons = async (buttons: boolean) => {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: target.fields.map((item) => ({
          fieldCode: item.code,
          view: !hidden.has(item.code),
          edit: !item.system && !hidden.has(item.code) && !locked.has(item.code),
        })),
        buttons: buttons
          ? target.buttons
              .filter((button) => !options.omitButtons?.includes(button.code))
              .map((button) => ({ buttonCode: button.code, level: button.level }))
          : [],
      },
      target.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  if (options.view !== false) await setButtons(options.buttons ?? true);
  if ((options.reference ?? 'creator') !== 'none') {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: catalog.fields.map((item) => ({ fieldCode: item.code, view: true, edit: false })),
        buttons: [],
      },
      catalog.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `trf-operator-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: world.tenant.id };
  const revisions = new Map<string, number>();
  const setSeeAll = async (which: 'target' | 'referenced', seeAll: boolean) => {
    const code = (which === 'target' ? target : catalog).code;
    const response = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${TALENT_REVIEW_APP}`, {
      ...world.asAdmin,
      ifMatch: revisions.get(code) ?? 0,
      body: { targetKind: 'entity', targetCode: code, seeAll },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    revisions.set(code, ((await response.json()) as { revision: number }).revision);
  };
  if (options.seeAll) await setSeeAll('target', true);
  if (options.reference === 'seeAll') await setSeeAll('referenced', true);
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, `${TR_BASE}${path}`, { ...as, ...extra });
  const lockFields = async (codes: readonly string[]) => {
    for (const code of codes) locked.add(code);
    await setButtons(true);
  };
  return { profile, user, as, request, setSeeAll, setButtons, lockFields };
}
