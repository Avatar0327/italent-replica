/**
 * R3-T02 PR-B B5（评定活动主体与环节）的验收夹具（设计 §3.2、§5.1、§5.3）。真实授权器，被测操作人由若干单独的身份拼成，
 * 撤销某个身份的授权就是撤销对应对象的查看权：
 * - 活动身份：评定活动对象（按所属组织裁剪，TEvaluation 数据范围 = 管理单元）；
 * - 类型 / 周期 / 评价表身份：活动类型、活动周期（字典，对象级看全部）与评价表（按所属组织，跟随 TEvaluation 范围）的查看；
 * - 任职资格身份：类别、级别的查看（只放开查看，DEC-352）；
 * - 员工信息身份：负责人的人员范围与姓名 / 工号字段权（TenantBase）。
 * 租户管理员（缺省授权钩子）搭数据。测试数据一律合成，邮箱用 example.com。
 */
import { randomUUID } from 'node:crypto';
import { EVALUATION_OBJECTS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS, QUALIFICATION_OBJECTS } from '@italent/domain';
import { sql, type Db } from '@italent/db';
import { expect } from 'vitest';
import { EV_APP, EV_BASE } from './AC-EV-support.js';
import { type Employee, type ReviewOperatorOptions, reviewWorld } from './AC-EV-review-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission, BASE, addMember } from './AC-PRM-support.js';
import { assignQualificationMou } from './AC-QL-support.js';
import { createMou } from './AC-TC-support.js';
import type { RequestOptions } from './support/tenant-api.js';

export const ACTIVITIES = '/activities';
const QL_BASE = '/api/tenant/qualification';

export interface ChainView {
  readonly id: string;
  readonly type: 'apply' | 'material' | 'defense' | 'result';
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly formId: string | null;
  readonly approvalProcessCode: string | null;
  readonly materialTemplate: string | null;
  readonly hardDeadline: boolean;
  readonly allowException: boolean;
  readonly exceptionRoles: string[];
  readonly transferMode: 'auto' | 'manual';
  readonly noticeTemplateCode: string | null;
}
export interface ActivityView {
  readonly id: string;
  readonly revision: number;
  readonly code: string;
  readonly name: string;
  readonly typeId: string;
  readonly cycleId: string;
  readonly year: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly orgRange: string[];
  readonly managerEmployeeId: string | null;
  readonly manager?: { name?: string; code?: string } | null;
  readonly applicantMode: 'self' | 'others' | 'both';
  readonly categoryIds: string[];
  readonly levelIds: string[];
  readonly maxLevelJump: number;
  readonly effectiveDate: string | null;
  readonly noticeOrgRange: string[];
  readonly status: 'draft' | 'published' | 'completed';
  readonly applyCount: number;
  readonly createdBy: string;
  readonly chains: ChainView[];
}
export interface Dict {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
}
export interface Ref {
  readonly id: string;
  readonly revision: number;
}

const suffix = () => randomUUID().slice(0, 6);

export async function activityWorld(db: Db) {
  const base = await reviewWorld(db);
  const { setup, asAdmin } = base;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await setup.request('POST', path, { ...asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  }
  async function patchAs<T>(path: string, revision: number, body: unknown): Promise<T> {
    const response = await setup.request('PATCH', path, { ...asAdmin, ifMatch: revision, body });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
  }
  // 管理员建任职资格对象要有 Qualification 授权管理单元（DEC-043）：只含甲部
  await assignQualificationMou(
    setup,
    asAdmin,
    asAdmin.user,
    await createMou(setup, asAdmin, [base.orgA], '任职资格'),
    0,
  );

  const activityType = (name = `类型${suffix()}`) => post<Dict>(`${EV_BASE}/activity-types`, { name });
  const activityCycle = (name = `周期${suffix()}`) => post<Dict>(`${EV_BASE}/activity-cycles`, { name });
  const setEnabled = async (kind: 'activity-types' | 'activity-cycles', item: Dict, enabled: boolean) =>
    patchAs<Dict>(`${EV_BASE}/${kind}/${item.id}`, item.revision, { enabled });
  /** 管理员建评价表（缺省授权钩子，看全部）。 */
  const form = (ownerOrgId = base.orgA, name = `评价表${suffix()}`) =>
    post<Dict & { enabled: boolean }>(`${EV_BASE}/evaluation-forms`, {
      name,
      ownerOrgId,
      scoreMode: 'by_total',
      fullScore: 100,
      passScore: 60,
      items: [],
    });
  const setFormEnabled = (item: Dict, enabled: boolean) =>
    patchAs<Dict>(`${EV_BASE}/evaluation-forms/${item.id}`, item.revision, { enabled });
  /** 管理员建任职资格类别 / 级别（类别分类 → 类别；级别按顺序号）。 */
  async function qlCategory(name = `类别${suffix()}`): Promise<Ref & { name: string }> {
    const cls = await post<{ id: string }>(`${QL_BASE}/category-classes`, { code: `K${suffix()}`, name: '管理类' });
    return post(`${QL_BASE}/categories`, { code: `C${suffix()}`, name, classId: cls.id });
  }
  const qlLevel = (displayOrder: number): Promise<Ref & { name: string }> =>
    post(`${QL_BASE}/levels`, { code: `L${suffix()}`, name: `P${displayOrder}-${suffix()}`, displayOrder });
  const disableQl = (kind: 'categories' | 'levels', item: Ref) =>
    patchAs(`${QL_BASE}/${kind}/${item.id}`, item.revision, { enabled: false });

  /** 管理员直接建活动（缺省授权钩子，看全部）。 */
  async function adminActivity(body: Record<string, unknown>): Promise<ActivityView> {
    const response = await setup.request('POST', `${EV_BASE}${ACTIVITIES}`, { ...asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ActivityView;
  }
  const adminRead = async (id: string) =>
    (await (await setup.request('GET', `${EV_BASE}${ACTIVITIES}/${id}`, asAdmin)).json()) as ActivityView;
  /** 库属主连接带租户上下文改活动行（造“进行中 / 已有报名”的数据；B5 只写草稿，发布与报名数由 C2 维护）。 */
  async function asOwner(work: (run: (query: ReturnType<typeof sql>) => Promise<unknown>) => Promise<void>) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${base.tenant.id}, true)`);
      await work((query) => tx.execute(query));
    });
  }
  const setStatus = (id: string, status: ActivityView['status']) =>
    asOwner((run) =>
      run(sql`UPDATE ev_activities SET status = ${status} WHERE id = ${id}::uuid`).then(() => undefined),
    );
  const setApplyCount = (id: string, count: number) =>
    asOwner((run) =>
      run(sql`UPDATE ev_activities SET apply_count = ${count} WHERE id = ${id}::uuid`).then(() => undefined),
    );
  /** 绕过“被引用拒停用”直接置停用（造“活动引用着一个已停用对象”的历史数据）。 */
  const forceDisable = (table: 'ev_activity_types' | 'ev_cycles' | 'ev_forms', id: string) =>
    asOwner((run) =>
      run(sql`UPDATE ${sql.identifier(table)} SET enabled = false WHERE id = ${id}::uuid`).then(() => undefined),
    );
  return {
    ...base,
    forceDisable,
    activityType,
    activityCycle,
    setEnabled,
    form,
    setFormEnabled,
    qlCategory,
    qlLevel,
    disableQl,
    adminActivity,
    adminRead,
    setStatus,
    setApplyCount,
    asOwner,
  };
}
export type ActivityWorld = Awaited<ReturnType<typeof activityWorld>>;

export interface ActivityOperatorOptions extends Pick<ReviewOperatorOptions, 'auditor'> {
  /** TEvaluation 数据范围：这些组织（管理单元，不含下级）。 */
  readonly evOrgs?: readonly string[];
  /** 员工信息（TenantBase）数据范围：这些组织（不含下级）。 */
  readonly personOrgs?: readonly string[];
  /** 活动对象里看不到 / 看得到不能编辑的字段。 */
  readonly hidden?: readonly string[];
  readonly readonly?: readonly string[];
  readonly noCreate?: boolean;
  readonly noUpdate?: boolean;
  readonly noDelete?: boolean;
  readonly noButtons?: boolean;
  /** 完全不授某个被引用对象的查看权。 */
  readonly noTypeObject?: boolean;
  readonly noCycleObject?: boolean;
  readonly noFormObject?: boolean;
  readonly noCategoryObject?: boolean;
  readonly noLevelObject?: boolean;
  readonly noEmployeeObject?: boolean;
  /** 员工信息里看不到的字段。 */
  readonly hiddenEmployeeFields?: readonly string[];
  /** 评价表对象里看不到的字段（名称字段权）。 */
  readonly hiddenFormFields?: readonly string[];
}

/** 被测操作人。 */
export async function activityOperator(world: ActivityWorld, options: ActivityOperatorOptions = {}) {
  const activity = EVALUATION_OBJECTS.evaluationActivity;
  const hidden = new Set(options.hidden ?? []);
  const readonly = new Set(options.readonly ?? []);
  const grantObject = async (
    profile: Awaited<ReturnType<typeof createProfile>>,
    code: string,
    body: Parameters<typeof setObjectPermission>[2],
  ) => {
    const response = await setObjectPermission(world, profile, body, code);
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const viewOnly = (fields: readonly { code: string }[], hiddenFields: readonly string[] = []) => ({
    dataOperations: { create: false, update: false, delete: false },
    fields: fields.map((field) => ({ fieldCode: field.code, view: !hiddenFields.includes(field.code), edit: false })),
    buttons: [],
  });
  const activityBody = (extraReadonly: readonly string[]) => ({
    dataOperations: { create: !options.noCreate, update: !options.noUpdate, delete: !options.noDelete },
    fields: activity.fields.map((field) => ({
      fieldCode: field.code,
      view: !hidden.has(field.code),
      edit:
        !field.system && !hidden.has(field.code) && !readonly.has(field.code) && !extraReadonly.includes(field.code),
    })),
    buttons: options.noButtons
      ? []
      : activity.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
  });

  const profile = await createProfile(world, `eva-${suffix()}`, { apps: [EV_APP] });
  await grantObject(profile, activity.code, activityBody([]));
  const seeAllEntity = async (profileId: string, code: string) => {
    const response = await world.api.request('PUT', `${BASE}/profiles/${profileId}/data-scopes/${EV_APP}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'entity', targetCode: code, seeAll: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const dictProfile = async (key: 'activityType' | 'activityCycle', skip: boolean | undefined) => {
    const item = await createProfile(world, `evd-${suffix()}`, { apps: [EV_APP] });
    if (!skip) {
      const object = EVALUATION_OBJECTS[key];
      await grantObject(item, object.code, viewOnly(object.fields));
      await seedAllFor(item.id, object.code);
    }
    return item;
  };
  const seedAllFor = seeAllEntity;
  const typeProfile = await dictProfile('activityType', options.noTypeObject);
  const cycleProfile = await dictProfile('activityCycle', options.noCycleObject);
  // 评价表：只授查看，范围跟随操作人的 TEvaluation 管理单元（所属组织 ∪ 所属人）
  const formObject = EVALUATION_OBJECTS.evaluationForm;
  const formProfile = await createProfile(world, `evf-${suffix()}`, { apps: [EV_APP] });
  const grantForm = (hiddenFields: readonly string[]) =>
    grantObject(formProfile, formObject.code, viewOnly(formObject.fields, hiddenFields));
  if (!options.noFormObject) await grantForm(options.hiddenFormFields ?? []);
  // 类别、级别：Qualification 应用的只放开查看（DEC-352），各一个身份
  const category = QUALIFICATION_OBJECTS.category;
  const level = QUALIFICATION_OBJECTS.level;
  const categoryProfile = await createProfile(world, `evc-${suffix()}`, { apps: ['Qualification'] });
  if (!options.noCategoryObject) await grantObject(categoryProfile, category.code, viewOnly(category.fields));
  const levelProfile = await createProfile(world, `evl-${suffix()}`, { apps: ['Qualification'] });
  if (!options.noLevelObject) await grantObject(levelProfile, level.code, viewOnly(level.fields));
  // 员工信息（负责人的人员范围与姓名 / 工号字段权）：TenantBase 单独一个身份，范围直接选组织
  const personnel = PERSONNEL_OBJECTS.find((object) => object.code === PERSONNEL_OBJECT)!;
  const employeeProfile = await createProfile(world, `eve-${suffix()}`, { apps: ['TenantBase'] });
  const grantEmployees = (hiddenFields: readonly string[]) =>
    grantObject(employeeProfile, PERSONNEL_OBJECT, viewOnly(personnel.fields, hiddenFields));
  if (!options.noEmployeeObject) await grantEmployees(options.hiddenEmployeeFields ?? []);
  await makeGrantable(world, [
    profile.id,
    typeProfile.id,
    cycleProfile.id,
    formProfile.id,
    categoryProfile.id,
    levelProfile.id,
    employeeProfile.id,
  ]);
  const user = await addMember(world, `eva-op-${suffix()}`);
  const grants = new Map<string, { id: string; revision: number }>();
  for (const [key, item] of Object.entries({
    activity: profile,
    type: typeProfile,
    cycle: cycleProfile,
    form: formProfile,
    category: categoryProfile,
    level: levelProfile,
    employee: employeeProfile,
  })) {
    const response = await grant(world, user.id, item.id);
    expect(response.status, await response.clone().text()).toBe(201);
    grants.set(key, (await response.json()) as { id: string; revision: number });
  }
  if (options.auditor) {
    const response = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId: user.id, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  let scopeRevision = 0;
  const setRange = async (orgs: readonly string[] | undefined) => {
    const body = orgs?.length
      ? { kind: 'mou', mouId: await createMou(world.api, world.asAdmin, orgs, '评定活动') }
      : { kind: 'default' };
    const response = await world.api.request('PUT', `${BASE}/scopes/${user.id}/${EV_APP}`, {
      ...world.asAdmin,
      ifMatch: scopeRevision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    scopeRevision = ((await response.json()) as { revision: number }).revision;
  };
  if (options.evOrgs?.length) await setRange(options.evOrgs);
  let personRevision = 0;
  const setPersonOrgs = async (orgs: readonly string[] | undefined) => {
    const body = orgs?.length
      ? { kind: 'org_range', orgRanges: orgs.map((orgId) => ({ orgId, includeDescendants: false })) }
      : { kind: 'default' };
    const response = await world.api.request('PUT', `${BASE}/scopes/${user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: personRevision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    personRevision = ((await response.json()) as { revision: number }).revision;
  };
  if (options.personOrgs?.length) await setPersonOrgs(options.personOrgs);
  const revoke = async (key: string) => {
    const granted = grants.get(key)!;
    const response = await world.api.request('POST', `${BASE}/grants/${granted.id}/revoke`, {
      ...world.asAdmin,
      ifMatch: granted.revision,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const as = { user: user.id, tenant: world.tenant.id };
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, path.startsWith('/api/') ? path : `${EV_BASE}${path}`, { ...as, ...extra });
  return {
    request,
    as,
    userId: user.id,
    /** 改员工信息的人员范围 / 撤销员工信息的查看 / 改员工信息的字段权（负责人的呈现）。 */
    setPersonOrgs,
    revokeEmployeeView: () => revoke('employee'),
    hideEmployeeFields: (fields: readonly string[]) => grantEmployees(fields),
    /** 改活动的数据范围（所属组织）。 */
    setEvOrgs: setRange,
    /** 撤销（检查之后）：某个被引用对象的查看权。 */
    revokeTypeView: () => revoke('type'),
    revokeCycleView: () => revoke('cycle'),
    revokeFormView: () => revoke('form'),
    revokeCategoryView: () => revoke('category'),
    revokeLevelView: () => revoke('level'),
    /** 撤销（检查之后）：活动对象的某些字段编辑权 / 全部授权。 */
    hideActivityFields: (fields: readonly string[]) => grantObject(profile, activity.code, activityBody(fields)),
    revokeActivityObject: () =>
      grantObject(profile, activity.code, {
        dataOperations: { create: false, update: false, delete: false },
        fields: activity.fields.map((field) => ({ fieldCode: field.code, view: false, edit: false })),
        buttons: [],
      }),
    /** 改评价表对象的名称字段权（名称字段看不到时，重复提示不带名称由活动对象的名称字段权决定，见 hideActivityNameView）。 */
    hideFormFields: (fields: readonly string[]) => grantForm(fields),
  };
}
export type ActivityOperator = Awaited<ReturnType<typeof activityOperator>>;

/** 合成员工（给 hire 用的占位类型再导出，免得测试里重复 import）。 */
export type { Employee };

/** 一套通用的合成数据：类型 / 周期 / 评价表 / 类别 / 级别 / 负责人，以及合法的活动请求体。 */
export async function activityFixtures(w: ActivityWorld) {
  const type1 = await w.activityType(`晋升评定${suffix()}`);
  const type2 = await w.activityType(`年度评定${suffix()}`);
  const cycle1 = await w.activityCycle(`上半年${suffix()}`);
  const form1 = await w.form(w.orgA, `答辩评价表${suffix()}`);
  const formB = await w.form(w.orgB, `乙部评价表${suffix()}`);
  const cat1 = await w.qlCategory(`教师${suffix()}`);
  const cat2 = await w.qlCategory(`管理${suffix()}`);
  const lv1 = await w.qlLevel(1);
  const lv2 = await w.qlLevel(2);
  const mgrA = await w.hire('负责人甲', w.orgA);
  const mgrB = await w.hire('负责人乙', w.orgB);
  const chains = (formId: string = form1.id) => [
    {
      type: 'apply',
      name: '资格申报',
      startDate: '2026-01-10',
      endDate: '2026-03-31',
      approvalProcessCode: 'QUAL_APPLY',
      hardDeadline: true,
      allowException: true,
      exceptionRoles: ['hrbp'],
      transferMode: 'auto',
    },
    {
      type: 'material',
      name: '材料举证',
      startDate: '2026-04-01',
      endDate: '2026-05-31',
      formId,
      approvalProcessCode: 'MATERIAL_REVIEW',
      materialTemplate: 'TPL_MATERIAL',
      transferMode: 'auto',
    },
    {
      type: 'defense',
      name: '答辩评审',
      startDate: '2026-06-01',
      endDate: '2026-08-31',
      formId,
      transferMode: 'manual',
    },
    { type: 'result', name: '结果发布', startDate: '2026-09-01', endDate: '2026-12-31' },
  ];
  const body = (extra: Record<string, unknown> = {}) => ({
    code: `EV${suffix()}`,
    name: `评定活动${suffix()}`,
    typeId: type1.id,
    cycleId: cycle1.id,
    year: 2026,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    ownerOrgId: w.orgA,
    orgRange: [w.orgA],
    managerEmployeeId: mgrA.id,
    applicantMode: 'self',
    categoryIds: [cat1.id],
    levelIds: [lv1.id, lv2.id],
    effectiveDate: '2027-01-01',
    noticeOrgRange: [w.orgA],
    chains: chains(),
    ...extra,
  });
  return { type1, type2, cycle1, form1, formB, cat1, cat2, lv1, lv2, mgrA, mgrB, chains, body };
}
export type ActivityFixtures = Awaited<ReturnType<typeof activityFixtures>>;

/** 响应里的环节还原成可提交的形状（去掉 ID 与空值）。 */
export function sendableChain(chain: ChainView): Record<string, unknown> {
  const { id: _id, ...rest } = chain;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null));
}
