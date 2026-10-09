/**
 * R3-T02 PR-A 任职资格权限用例的公共夹具（真实授权器）：
 * - seed：上级部 / 下级部 / 其他部三个组织；管理员（单一授权管理单元）在上级部建一套向下公开的对象，在其他部建
 *   范围外类别；另建职务序列、职级（引入 / 关联用）；`adminIn(org)` 让管理员切到某个组织下继续建对象；
 * - operator：按选项授予 Qualification 各对象的数据操作、字段查看 / 编辑、按钮，岗职务对象看全部，Qualification
 *   看全部，日志审计管理员；返回请求函数与撤销范围等操作。
 */
import { randomUUID } from 'node:crypto';
import { MODULE_OBJECTS, QUALIFICATION_OBJECTS } from '@italent/domain';
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
import {
  assignQualificationMou,
  type CategoryView,
  QL_APP,
  QL_BASE,
  QL_NOW,
  type StandardView,
} from './AC-QL-support.js';
import { createMou, createOrg } from './AC-TC-support.js';
import { type RequestOptions, tenantApi } from './support/tenant-api.js';

export type ObjectKey = keyof typeof QUALIFICATION_OBJECTS;

export interface Data {
  readonly parent: string;
  readonly child: string;
  readonly outside: string;
  readonly childMou: string;
  readonly parentMou: string;
  readonly open: CategoryView;
  readonly closed: CategoryView;
  readonly foreign: CategoryView;
  readonly levelId: string;
  readonly typeId: string;
  readonly plainTarget: string;
  readonly commonTarget: string;
  readonly standardId: string;
  readonly schemeId: string;
  readonly gradeTarget: string;
  readonly sequences: readonly string[];
  readonly jobLevels: readonly string[];
  readonly levelTypeId: string;
  /** 管理员切到只含该组织的授权管理单元，在其下建对象（返回 201 的响应体）。 */
  readonly adminIn: (orgId: string) => Promise<<T>(path: string, body: unknown) => Promise<T>>;
  /** 管理员直接请求（全部允许的授权钩子之外的真实接口，用于读取 / 修改夹具对象）。 */
  readonly admin: (method: string, path: string, options?: RequestOptions) => Promise<Response>;
}

export const code = (prefix = 'Q') => `${prefix}${randomUUID().slice(0, 6)}`;

export async function seed(world: PermissionWorld): Promise<Data> {
  const setup = tenantApi(world.db, { clock: () => QL_NOW });
  const parent = await createOrg(setup, world.asAdmin, '任职资格上级部');
  const child = await createOrg(setup, world.asAdmin, '任职资格下级部', parent);
  const outside = await createOrg(setup, world.asAdmin, '任职资格其他部');
  let revision = 0;
  const admin = (method: string, path: string, options: RequestOptions = {}) =>
    setup.request(method, path.startsWith('/api/') ? path : `${QL_BASE}${path}`, { ...world.asAdmin, ...options });
  const create = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await admin('POST', path, { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  };
  const adminIn = async (orgId: string) => {
    const mou = await createMou(setup, world.asAdmin, [orgId], '任职资格');
    revision = await assignQualificationMou(setup, world.asAdmin, world.asAdmin.user, mou, revision);
    return create;
  };
  await adminIn(parent);
  const klass = await create<{ id: string }>('/category-classes', { code: code(), name: '分类', publicDown: true });
  const open = await create<CategoryView>('/categories', {
    code: code(),
    name: '公开类',
    classId: klass.id,
    publicDown: true,
  });
  const closed = await create<CategoryView>('/categories', { code: code(), name: '不公开类', classId: klass.id });
  const level = await create<{ id: string }>('/levels', {
    code: code(),
    name: 'P1',
    displayOrder: 1,
    publicDown: true,
  });
  const type = await create<{ id: string }>('/target-types', { code: code(), name: '类型', publicDown: true });
  const plainTarget = await create<{ id: string }>('/targets', {
    code: code(),
    name: '普通指标',
    typeId: type.id,
    description: '保密说明',
    evalMode: 'score',
    publicDown: true,
  });
  const commonTarget = await create<{ id: string }>('/targets', {
    code: code(),
    name: '通用指标',
    typeId: type.id,
    description: '通用保密说明',
    evalMode: 'score',
    isCommon: true,
    confirmOverwrite: true,
    publicDown: true,
  });
  const standard = await create<StandardView>('/standards', {
    categoryId: open.id,
    name: '公开标准',
    levelIds: [level.id],
    details: [{ levelId: level.id, targetId: commonTarget.id }],
  });
  const scheme = await create<{ id: string }>('/grade-schemes', {
    name: `方案${code()}`,
    details: [{ name: '初级', grade: 1, description: '明细保密描述' }],
  });
  const gradeTarget = await create<{ id: string }>('/targets', {
    code: code(),
    name: '评级指标',
    typeId: type.id,
    evalMode: 'grade',
    gradeSchemeId: scheme.id,
    publicDown: true,
  });
  const job = async (path: string, body: Record<string, unknown>) => {
    const response = await admin('POST', `/api/tenant/job/${path}`, {
      ifMatch: 0,
      body: { code: code('J'), startDate: '2020-01-01', ...body },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const sequences = [await job('sequences', { name: '保密序列甲' }), await job('sequences', { name: '保密序列乙' })];
  const levelType = await job('level-types', { name: '职级体系' });
  const jobLevels = [
    await job('levels', { name: '保密职级甲', level: 1, levelTypeId: levelType }),
    await job('levels', { name: '保密职级乙', level: 2, levelTypeId: levelType }),
  ];
  await adminIn(outside);
  const foreignClass = await create<{ id: string }>('/category-classes', { code: code(), name: '外分类' });
  const foreign = await create<CategoryView>('/categories', { code: code(), name: '外类', classId: foreignClass.id });
  const childMou = await createMou(setup, world.asAdmin, [child], '下级');
  const parentMou = await createMou(setup, world.asAdmin, [parent], '上级');
  return {
    parent,
    child,
    outside,
    childMou,
    parentMou,
    open,
    closed,
    foreign,
    levelId: level.id,
    typeId: type.id,
    plainTarget: plainTarget.id,
    commonTarget: commonTarget.id,
    standardId: standard.id,
    schemeId: scheme.id,
    gradeTarget: gradeTarget.id,
    sequences,
    jobLevels,
    levelTypeId: levelType,
    adminIn,
    admin,
  };
}

export interface OperatorOptions {
  readonly mouId?: string;
  /** 看不到（也不能编辑）的字段。 */
  readonly hidden?: Partial<Record<ObjectKey, string[]>>;
  /** 看得到、不能编辑的字段。 */
  readonly readonly?: Partial<Record<ObjectKey, string[]>>;
  /** 没有删除数据操作权的对象。 */
  readonly noDelete?: readonly ObjectKey[];
  /** 岗职务对象（序列、职级、职等、职位、职务、职级类别）看全部，并隐藏这些字段；不给则不授岗职务权限。 */
  readonly sequenceHidden?: string[];
  /** Qualification 看全部（身份级）。 */
  readonly seeAll?: boolean;
  /** 日志审计管理员。 */
  readonly auditor?: boolean;
}

const JOB_OBJECTS = [
  MODULE_OBJECTS.jobSequence,
  MODULE_OBJECTS.jobLevel,
  MODULE_OBJECTS.jobGrade,
  MODULE_OBJECTS.jobLevelType,
  MODULE_OBJECTS.jobPost,
  MODULE_OBJECTS.jobPosition,
];

export async function operator(world: PermissionWorld, options: OperatorOptions) {
  const jobs = options.sequenceHidden !== undefined;
  const apps = jobs ? [QL_APP, 'TenantBase'] : [QL_APP];
  const profile = await createProfile(world, `ql-${randomUUID().slice(0, 8)}`, { apps });
  for (const key of Object.keys(QUALIFICATION_OBJECTS) as ObjectKey[]) {
    const definition = QUALIFICATION_OBJECTS[key];
    const hidden = new Set(options.hidden?.[key] ?? []);
    const readonly = new Set(options.readonly?.[key] ?? []);
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: !options.noDelete?.includes(key) },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: !hidden.has(field.code),
          edit: !field.system && !hidden.has(field.code) && !readonly.has(field.code),
        })),
        buttons: definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  if (jobs) await allowJobs(world, profile, options.sequenceHidden!);
  if (options.seeAll) await seeAll(world, profile.id, QL_APP);
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `ql-op-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  if (options.auditor) {
    const response = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId: user.id, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  const as = { user: user.id, tenant: world.tenant.id };
  let scopeRevision = 0;
  const assign = async (body: Record<string, unknown>) => {
    const response = await world.api.request('PUT', `${BASE}/scopes/${user.id}/${QL_APP}`, {
      ...world.asAdmin,
      ifMatch: scopeRevision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    scopeRevision = ((await response.json()) as { revision: number }).revision;
  };
  if (options.mouId) await assign({ kind: 'mou', mouId: options.mouId });
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, path.startsWith('/api/') ? path : `${QL_BASE}${path}`, { ...as, ...extra });
  return {
    request,
    as,
    userId: user.id,
    profileId: profile.id,
    /** 撤销用户 × Qualification 的数据范围（回到缺省：空）。 */
    revoke: () => assign({ kind: 'default' }),
    /** 撤销身份级看全部。 */
    revokeSeeAll: () => seeAll(world, profile.id, QL_APP, false),
  };
}

export type Operator = Awaited<ReturnType<typeof operator>>;

const seeAllRevisions = new Map<string, number>();

async function seeAll(world: PermissionWorld, profileId: string, app: string, value = true) {
  const key = `${profileId}:${app}`;
  const response = await world.api.request('PUT', `${BASE}/profiles/${profileId}/data-scopes/${app}`, {
    ...world.asAdmin,
    ifMatch: seeAllRevisions.get(key) ?? 0,
    body: { targetKind: 'app', targetCode: '', seeAll: value },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  seeAllRevisions.set(key, ((await response.json()) as { revision: number }).revision);
}

/** 组织员工侧：岗职务对象看全部（职位以外无组织字段），按需隐藏字段。 */
async function allowJobs(world: PermissionWorld, profile: Awaited<ReturnType<typeof createProfile>>, hidden: string[]) {
  for (const definition of JOB_OBJECTS) {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: !hidden.includes(field.code),
          edit: false,
        })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await seeAll(world, profile.id, 'TenantBase');
}

/** 错误响应的 reason。 */
export async function reasonOf(response: Response): Promise<string | undefined> {
  return ((await response.clone().json()) as { error?: { details?: { reason?: string } } }).error?.details?.reason;
}
