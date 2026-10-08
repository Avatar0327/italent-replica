/**
 * R3-T07 权限用例夹具（真实授权器）：两个组织（范围内 / 外）+ 范围内组织的下级组织，以及按需配置对象权限、按钮、
 * 字段可见 / 可编辑与组织范围的操作人。DEC-043：数据范围按 用户 × IDP 应用存一份，缺省为空（fail-closed）。
 */
import { randomUUID } from 'node:crypto';
import { IDP_APP, IDP_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  type ProfileBody,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import {
  createOrg,
  IDP_BASE,
  IDP_NOW,
  idpApprovalProcess,
  type ProcessView,
  subProcessBody,
  type TemplateView,
} from './AC-IDP-support.js';

export type IdpObjectKey = keyof typeof IDP_OBJECTS;
export const clock = () => IDP_NOW;

export interface IdpPermissionData {
  readonly setup: ReturnType<typeof tenantApi>;
  readonly insideOrg: string;
  readonly childOrg: string;
  readonly outsideOrg: string;
  /** 范围内组织的流程 / 模板（向下公开）。 */
  readonly inside: { process: ProcessView; template: TemplateView };
  /** 范围内组织、不向下公开的流程 / 模板。 */
  readonly closed: { process: ProcessView; template: TemplateView };
  readonly outside: { process: ProcessView; template: TemplateView };
}

/** 建数据用“全部允许”的授权钩子，操作人是租户管理员。 */
export async function seedIdpData(world: PermissionWorld): Promise<IdpPermissionData> {
  const setup = tenantApi(world.db, { clock });
  const plan = await idpApprovalProcess(world.db, world.asAdmin, 'idp_plan');
  const create = async <T>(path: string, body: unknown, ifMatch = 0): Promise<T> => {
    const response = await setup.request('POST', `${IDP_BASE}${path}`, { ...world.asAdmin, ifMatch, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  };
  const insideOrg = await createOrg(setup, world.asAdmin, '人才发展部（范围内）');
  const childOrg = await createOrg(setup, world.asAdmin, '人才发展部下级', insideOrg);
  const outsideOrg = await createOrg(setup, world.asAdmin, '人才发展部（范围外）');
  const owned = async (orgId: string, label: string, publicDown = true) => {
    const process = await create<ProcessView>('/processes', {
      name: `${label}流程`,
      orgId,
      publicDown,
      subProcesses: [subProcessBody(plan.id, { days: null })],
    });
    let template = await create<TemplateView>('/templates', {
      name: `${label}模板`,
      description: `${label}保密描述`,
      orgId,
      publicDown,
      processId: process.id,
    });
    template = await create<TemplateView>(
      `/templates/${template.id}/modules`,
      { moduleType: 'goal', name: `${label}目标`, description: `${label}模块保密说明` },
      template.revision,
    );
    return { process: { ...process, referenced: true }, template };
  };
  return {
    setup,
    insideOrg,
    childOrg,
    outsideOrg,
    inside: await owned(insideOrg, '内'),
    closed: await owned(insideOrg, '内不公开', false),
    outside: await owned(outsideOrg, '外'),
  };
}

export interface OperatorOptions {
  readonly objects?: readonly IdpObjectKey[];
  readonly hidden?: Partial<Record<IdpObjectKey, readonly string[]>>;
  readonly readonly?: Partial<Record<IdpObjectKey, readonly string[]>>;
  /** 用户 × IDP 的组织范围（含下级）。 */
  readonly orgId?: string;
  /** 是否授予对象登记的全部按钮（缺省授予）。 */
  readonly buttons?: boolean;
  /** 给已有成员授身份（如审计管理员），缺省新建成员。 */
  readonly user?: { readonly id: string };
}

export async function idpOperator(world: PermissionWorld, options: OperatorOptions = {}) {
  const profile: ProfileBody = await createProfile(world, `idp-${randomUUID().slice(0, 8)}`, { apps: [IDP_APP] });
  const setButtons = async (buttons: boolean) => {
    for (const key of options.objects ?? (Object.keys(IDP_OBJECTS) as IdpObjectKey[])) {
      const definition = IDP_OBJECTS[key];
      const hidden = new Set(options.hidden?.[key] ?? []);
      const locked = new Set(options.readonly?.[key] ?? []);
      const response = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: true, update: true, delete: true },
          fields: definition.fields.map((field) => ({
            fieldCode: field.code,
            view: !hidden.has(field.code),
            edit: !field.system && !hidden.has(field.code) && !locked.has(field.code),
          })),
          buttons: buttons
            ? definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level }))
            : [],
        },
        definition.code,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
  };
  await setButtons(options.buttons ?? true);
  await makeGrantable(world, [profile.id]);
  const user = options.user ?? (await addMember(world, `idp-operator-${randomUUID().slice(0, 4)}`));
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: world.tenant.id };
  let scopeRevision = 0;
  /** 用户 × IDP 的组织范围；null 回到缺省（空）。 */
  const setOrg = async (orgId: string | null) => {
    const response = await world.api.request('PUT', `${BASE}/scopes/${user.id}/${IDP_APP}`, {
      ...world.asAdmin,
      ifMatch: scopeRevision,
      body: orgId ? { kind: 'org_range', orgRanges: [{ orgId, includeDescendants: true }] } : { kind: 'default' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    scopeRevision = ((await response.json()) as { revision: number }).revision;
  };
  if (options.orgId) await setOrg(options.orgId);
  const request = (method: string, path: string, extra: Parameters<typeof world.api.request>[2] = {}) =>
    world.api.request(method, `${IDP_BASE}${path}`, { ...as, ...extra });
  return { profile, user, as, request, setOrg, setButtons };
}
