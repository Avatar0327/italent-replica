/**
 * R3-T02 PR-B B4（评价表，标准模式）的验收夹具（设计 §3.2、§5.2 #6）。真实授权器：
 * - 租户管理员（缺省授权钩子）搭数据：组织、通用评分项、任职资格指标；
 * - 被测操作人：评价表对象（按所属组织裁剪，TEvaluation 数据范围 = 管理单元）、通用评分项对象（字典，单独一个身份：撤销
 *   它的授权就是撤销字典查看权；对象级看全部）、任职资格指标对象（只放开查看，DEC-352；单独一个身份，同理）。
 * 测试数据一律合成，邮箱用 example.com。
 */
import { randomUUID } from 'node:crypto';
import { EVALUATION_OBJECTS, QUALIFICATION_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import { EV_APP, EV_BASE } from './AC-EV-support.js';
import { type ReviewWorld, reviewWorld } from './AC-EV-review-support.js';
import { addMember, BASE, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { assignQualificationMou } from './AC-QL-support.js';
import { createMou } from './AC-TC-support.js';
import type { RequestOptions } from './support/tenant-api.js';
import type { Db } from '@italent/db';

export const FORMS = '/evaluation-forms';
export const GENERAL_ITEMS = '/general-score-items';
const QL_BASE = '/api/tenant/qualification';

export interface ItemView {
  readonly kind: 'standard' | 'general';
  readonly generalItemId?: string;
  readonly name?: string;
  readonly weight: number | null;
  readonly hiddenTargets?: { id: string; name?: string }[];
}
export interface FormView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly enabled: boolean;
  readonly scoreMode: 'by_indicator' | 'by_total';
  readonly fullScore: number;
  readonly passScore: number;
  readonly totalRule: 'average' | 'weighted' | 'sum' | null;
  readonly createdBy: string;
  readonly items: ItemView[];
}
export interface GeneralItem {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
}
export interface TargetRef {
  readonly id: string;
  readonly name: string;
}

const suffix = () => randomUUID().slice(0, 6);

export async function formWorld(db: Db) {
  const base = await reviewWorld(db);
  const { setup, asAdmin } = base;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await setup.request('POST', path, { ...asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  }
  /** 管理员建通用评分项（字典，缺省授权钩子）。 */
  const generalItem = (name = `评分项${suffix()}`, extra: Record<string, unknown> = {}) =>
    post<GeneralItem>(`${EV_BASE}${GENERAL_ITEMS}`, { name, ...extra });
  // 管理员建任职资格对象要有 Qualification 授权管理单元（DEC-043）：只含甲部
  await assignQualificationMou(
    setup,
    asAdmin,
    asAdmin.user,
    await createMou(setup, asAdmin, [base.orgA], '任职资格'),
    0,
  );
  /** 管理员建任职资格指标（指标类型 → 指标；管理员用缺省授权钩子，owner 取管理员自己的范围）。 */
  async function qlTarget(name = `指标${suffix()}`, extra: Record<string, unknown> = {}): Promise<TargetRef> {
    const type = await post<{ id: string }>(`${QL_BASE}/target-types`, {
      code: `T${suffix()}`,
      name: `类型${suffix()}`,
    });
    const target = await post<{ id: string; name: string }>(`${QL_BASE}/targets`, {
      code: `Z${suffix()}`,
      name,
      typeId: type.id,
      description: '指标说明',
      evalMode: 'score',
      ...extra,
    });
    return { id: target.id, name: target.name };
  }
  /** 管理员停用指标（只拦新引用，已引用照常显示，DEC-281⑧）。 */
  async function disableTarget(id: string): Promise<void> {
    const current = await setup.request('GET', `${QL_BASE}/targets/${id}`, asAdmin);
    const revision = ((await current.json()) as { revision: number }).revision;
    const response = await setup.request('PATCH', `${QL_BASE}/targets/${id}`, {
      ...asAdmin,
      ifMatch: revision,
      body: { enabled: false },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  /** 管理员停用 / 启用通用评分项。 */
  async function setGeneralEnabled(item: GeneralItem, enabled: boolean): Promise<GeneralItem> {
    const response = await setup.request('PATCH', `${EV_BASE}${GENERAL_ITEMS}/${item.id}`, {
      ...asAdmin,
      ifMatch: item.revision,
      body: { enabled },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as GeneralItem;
  }
  /** 管理员直接建评价表（缺省授权钩子，看全部）。 */
  async function adminForm(body: Record<string, unknown>): Promise<FormView> {
    const response = await setup.request('POST', `${EV_BASE}${FORMS}`, { ...asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as FormView;
  }
  return { ...base, generalItem, qlTarget, disableTarget, setGeneralEnabled, adminForm };
}
export type FormWorld = Awaited<ReturnType<typeof formWorld>> & ReviewWorld;

export interface FormOperatorOptions {
  /** TEvaluation 数据范围：这些组织（管理单元，不含下级）。 */
  readonly evOrgs?: readonly string[];
  /** 评价表对象里看不到 / 看得到不能编辑的字段。 */
  readonly hidden?: readonly string[];
  readonly readonly?: readonly string[];
  readonly noCreate?: boolean;
  readonly noUpdate?: boolean;
  readonly noDelete?: boolean;
  readonly noButtons?: boolean;
  /** 完全不授通用评分项对象 / 其中看不到的字段。 */
  readonly noGeneralObject?: boolean;
  readonly hiddenGeneralFields?: readonly string[];
  /** 通用评分项对象另授编辑（停用 / 启用用，列出引用方的可见范围按本操作人的评价表范围）。 */
  readonly generalWritable?: boolean;
  /** 完全不授任职资格指标对象 / 其中看不到的字段。 */
  readonly noTargetObject?: boolean;
  readonly hiddenTargetFields?: readonly string[];
  /** 日志审计管理员。 */
  readonly auditor?: boolean;
}

export async function formOperator(world: FormWorld, options: FormOperatorOptions = {}) {
  const form = EVALUATION_OBJECTS.evaluationForm;
  const generalObject = EVALUATION_OBJECTS.generalScoreItem;
  const targetObject = QUALIFICATION_OBJECTS.target;
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
  const viewOnly = (fields: readonly { code: string }[], hiddenFields: readonly string[]) => ({
    dataOperations: { create: false, update: false, delete: false },
    fields: fields.map((field) => ({ fieldCode: field.code, view: !hiddenFields.includes(field.code), edit: false })),
    buttons: [],
  });

  const profile = await createProfile(world, `evf-${suffix()}`, { apps: [EV_APP] });
  const formBody = (extraHidden: readonly string[], extraReadonly: readonly string[]) => ({
    dataOperations: { create: !options.noCreate, update: !options.noUpdate, delete: !options.noDelete },
    fields: form.fields.map((field) => ({
      fieldCode: field.code,
      view: !hidden.has(field.code) && !extraHidden.includes(field.code),
      edit:
        !field.system &&
        !hidden.has(field.code) &&
        !readonly.has(field.code) &&
        !extraHidden.includes(field.code) &&
        !extraReadonly.includes(field.code),
    })),
    buttons: options.noButtons ? [] : form.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
  });
  await grantObject(profile, form.code, formBody([], []));
  // 通用评分项：单独一个身份（撤销它 = 撤销字典查看权），对象级看全部（字典行没有所属组织）
  const generalProfile = await createProfile(world, `evg-${suffix()}`, { apps: [EV_APP] });
  if (!options.noGeneralObject) {
    await grantObject(
      generalProfile,
      generalObject.code,
      viewOnly(generalObject.fields, options.hiddenGeneralFields ?? []),
    );
    const seeAll = await world.api.request('PUT', `${BASE}/profiles/${generalProfile.id}/data-scopes/${EV_APP}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'entity', targetCode: generalObject.code, seeAll: true },
    });
    expect(seeAll.status, await seeAll.clone().text()).toBe(200);
  }
  const targetProfile = await createProfile(world, `evt-${suffix()}`, { apps: ['Qualification'] });
  if (!options.noTargetObject) {
    await grantObject(
      targetProfile,
      targetObject.code,
      viewOnly(targetObject.fields, options.hiddenTargetFields ?? []),
    );
  }
  await makeGrantable(world, [profile.id, generalProfile.id, targetProfile.id]);
  const user = await addMember(world, `evf-op-${suffix()}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const generalGrant = (await (await grant(world, user.id, generalProfile.id)).json()) as {
    id: string;
    revision: number;
  };
  const targetGrant = (await (await grant(world, user.id, targetProfile.id)).json()) as {
    id: string;
    revision: number;
  };
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
      ? { kind: 'mou', mouId: await createMou(world.api, world.asAdmin, orgs, '评价表') }
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
  const revoke = async (granted: { id: string; revision: number }) => {
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
    /** 改评价表的数据范围（所属组织）。 */
    setEvOrgs: setRange,
    /** 撤销（检查之后）：通用评分项对象的查看（字典查看权）/ 指标对象的查看。 */
    revokeGeneralView: () => revoke(generalGrant),
    revokeTargetView: () => revoke(targetGrant),
    /** 撤销（检查之后）：评价表对象的某些字段编辑权。 */
    hideFormFields: (fields: readonly string[]) => grantObject(profile, form.code, formBody([], fields)),
    /** 撤销（检查之后）：评价表对象的全部授权。 */
    revokeFormObject: () =>
      grantObject(profile, form.code, {
        dataOperations: { create: false, update: false, delete: false },
        fields: form.fields.map((field) => ({ fieldCode: field.code, view: false, edit: false })),
        buttons: [],
      }),
  };
}
export type FormOperator = Awaited<ReturnType<typeof formOperator>>;
