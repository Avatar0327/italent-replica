/**
 * R3-T04 PR-B6a 盘点模板验收夹具（设计 §2.3；TR-R11～R20）：一个租户 + 一名成员 + 一个范围内组织（人才标准世界），带模板引用的
 * 流程（三个节点：本人单人 / 同事会签两角色 / 校准）、评价规则、模块等级、字段与人才标准。缺省“全部允许”的授权钩子；
 * 权限用例另用真实授权器（templateOperator，AC-TR-template-permissions）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { TALENT_REVIEW_APP, TALENT_REVIEW_OBJECTS, type TalentReviewObject } from '@italent/domain';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { talentWorld } from './AC-TC-support.js';
import { configBody } from './AC-TR-config-support.js';
import { flowBody, nodeBody } from './AC-TR-form-flow-support.js';
import { gradeRuleBody, moduleGradeBody, scoreRuleBody } from './AC-TR-scoring-support.js';
import { TR_BASE, TR_NOW } from './AC-TR-support.js';
import type { RequestOptions } from './support/tenant-api.js';

export const TEMPLATES = '/templates';
export { TR_BASE, TR_NOW };

export interface TemplateStepView {
  readonly nodeKey: string;
  readonly name: string;
  readonly kind: string;
  readonly stepType: string;
  readonly mode: string;
  readonly showMatrix: boolean;
  readonly roles: { roleId: string; resolver: string }[];
}
export interface TemplateModuleView {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly scoring?: string | null;
  readonly scoreRuleId?: string | null;
  readonly moduleGradeId?: string | null;
  readonly ruleSnapshot?: {
    kind: string;
    min: number | null;
    max: number | null;
    allowUnable: boolean;
    levels: { name: string; value: number }[];
  } | null;
  readonly gradeSnapshot?: { items: { name: string; value: string; minScore: number | null }[] } | null;
  readonly fieldIds?: string[];
  readonly [key: string]: unknown;
}
export interface TemplatePermissionView {
  readonly nodeKey: string;
  readonly roleId: string | null;
  readonly moduleName: string;
  readonly visible: boolean;
  readonly scoreEnabled: boolean;
  readonly weight: number | null;
  readonly [key: string]: unknown;
}
export interface TemplateView {
  readonly id: string;
  readonly name: string;
  readonly ownerOrgId: string;
  readonly downwardPublic: boolean;
  readonly flowId: string | null;
  readonly enabled: boolean;
  readonly currentVersionNo: number;
  readonly versionNo: number;
  readonly revision: number;
  readonly accessLevel: string;
  readonly steps: TemplateStepView[];
  readonly modules: TemplateModuleView[];
  readonly permissions: TemplatePermissionView[];
  readonly configErrors: { moduleName: string; code: string; sum: number }[];
  readonly versions: { versionNo: number }[];
  readonly [key: string]: unknown;
}

let counter = 0;
const next = () => {
  counter += 1;
  return `${counter}_${randomUUID().slice(0, 4)}`;
};
export const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;

/** 指标评估模块的最小合法载荷（任职资格来源、加权求和）。 */
export const indicatorModule = (scoreRuleId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'indicator',
  name: `指标${next()}`,
  source: 'qualification',
  scoring: 'weighted_sum',
  scoreRuleId,
  ...extra,
});
export const templateBody = (ownerOrgId: string, extra: Record<string, unknown> = {}) => ({
  name: `模板${next()}`,
  ownerOrgId,
  ...extra,
});

export async function templateWorld(db: Db, label: string) {
  const t = await talentWorld(db, label);
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    t.api.request(method, `${TR_BASE}${path}`, { ...t.as, ...options });
  const created = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await request('POST', path, { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  };
  const field = (extra: Record<string, unknown> = {}) => created<{ id: string }>('/fields', configBody('field', extra));
  const role = (extra: Record<string, unknown> = {}) => created<{ id: string }>('/roles', configBody('role', extra));
  const scoreRule = (extra: Record<string, unknown> = {}) =>
    created<{ id: string }>('/score-rules', scoreRuleBody(extra));
  const gradeRule = (extra: Record<string, unknown> = {}) =>
    created<{ id: string }>('/score-rules', gradeRuleBody(extra));
  const moduleGrade = (extra: Record<string, unknown> = {}) =>
    created<{ id: string }>('/module-grades', moduleGradeBody(extra));
  /** 三个节点的流程：本人（单人）→ 同事（会签，两个角色）→ 校准（单人、批量）。 */
  async function threeStepFlow() {
    const self = await role();
    const peerA = await role();
    const peerB = await role();
    const calibrator = await role();
    const flow = await created<{ id: string; nodes: { nodeKey: string }[] }>(
      '/flows',
      flowBody([
        nodeBody([self.id], { nodeKey: 'self', name: '本人自评' }),
        nodeBody([peerA.id, peerB.id], { nodeKey: 'peers', name: '同事评价', kind: 'countersign' }),
        nodeBody([calibrator.id], { nodeKey: 'calibrate', name: '审核校准', stepType: 'calibrate', mode: 'batch' }),
      ]),
    );
    return { flow, roles: { self, peerA, peerB, calibrator } };
  }
  const template = (body: Record<string, unknown>) => created<TemplateView>(TEMPLATES, body);
  const read = async (id: string, query = '') => {
    const response = await request('GET', `${TEMPLATES}/${id}${query}`);
    return { status: response.status, body: (await response.json()) as TemplateView };
  };
  const patch = (template: { id: string; revision: number }, body: Record<string, unknown>, key?: string) =>
    request('PATCH', `${TEMPLATES}/${template.id}`, {
      ifMatch: template.revision,
      ...(key ? { idempotencyKey: key } : {}),
      body,
    });
  return {
    ...t,
    trRequest: request,
    created,
    field,
    role,
    scoreRule,
    gradeRule,
    moduleGrade,
    threeStepFlow,
    template,
    read,
    patch,
  };
}
export type TemplateWorld = Awaited<ReturnType<typeof templateWorld>>;

// ---- 真实授权器下的操作人（权限用例）-------------------------------------------------------------------------------------

/** 模板引用的目录对象：流程（节点角色随流程）、评价规则、模块等级、盘点字段。 */
export const REFERENCED_OBJECTS = [
  'flow',
  'scoreRule',
  'moduleGrade',
  'field',
] as const satisfies readonly TalentReviewObject[];

export interface TemplateOperatorOptions {
  /** 用户 × TalentReview 的组织范围（含下级）；缺省为空。 */
  readonly orgId?: string;
  readonly hidden?: readonly string[];
  readonly readonly?: readonly string[];
  readonly buttons?: boolean;
  readonly omitButtons?: readonly string[];
  readonly view?: boolean;
  /** 被引用目录对象：none 不给查看权；creator（缺省）给查看权但没有看全部；seeAll 给查看权与看全部。 */
  readonly references?: 'none' | 'creator' | 'seeAll';
}

export async function templateOperator(world: PermissionWorld, options: TemplateOperatorOptions = {}) {
  const target = TALENT_REVIEW_OBJECTS.template;
  const profile = await createProfile(world, `trt-${randomUUID().slice(0, 8)}`, { apps: [TALENT_REVIEW_APP] });
  const hidden = new Set(options.hidden ?? []);
  const locked = new Set(options.readonly ?? []);
  const setButtons = async (buttons: boolean, omit: readonly string[] | undefined = options.omitButtons) => {
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
          ? target.buttons.filter((b) => !omit?.includes(b.code)).map((b) => ({ buttonCode: b.code, level: b.level }))
          : [],
      },
      target.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  if (options.view !== false) await setButtons(options.buttons ?? true);
  const revisions = new Map<string, number>();
  const referenceView = async (object: TalentReviewObject, view: boolean) => {
    const definition = TALENT_REVIEW_OBJECTS[object];
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((item) => ({ fieldCode: item.code, view, edit: false })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const setSeeAll = async (object: TalentReviewObject, seeAll: boolean) => {
    const code = TALENT_REVIEW_OBJECTS[object].code;
    const response = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${TALENT_REVIEW_APP}`, {
      ...world.asAdmin,
      ifMatch: revisions.get(code) ?? 0,
      body: { targetKind: 'entity', targetCode: code, seeAll },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    revisions.set(code, ((await response.json()) as { revision: number }).revision);
  };
  if ((options.references ?? 'creator') !== 'none') {
    for (const object of REFERENCED_OBJECTS) await referenceView(object, true);
  }
  if (options.references === 'seeAll') for (const object of REFERENCED_OBJECTS) await setSeeAll(object, true);
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `trt-operator-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: world.tenant.id };
  let scopeRevision = 0;
  /** 用户 × TalentReview 的组织范围：独立应用只接受管理单元或缺省；null 回到缺省（空）。 */
  const setOrg = async (orgId: string | null) => {
    let body: unknown = { kind: 'default' };
    if (orgId) {
      const mou = await world.api.request('POST', `${BASE}/mous`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: {
          code: `trt-mou-${randomUUID().slice(0, 6)}`,
          name: '盘点管理单元',
          orgRanges: [{ orgId, includeDescendants: true }],
        },
      });
      expect(mou.status, await mou.clone().text()).toBe(201);
      body = { kind: 'mou', mouId: ((await mou.json()) as { id: string }).id };
    }
    const response = await world.api.request('PUT', `${BASE}/scopes/${user.id}/${TALENT_REVIEW_APP}`, {
      ...world.asAdmin,
      ifMatch: scopeRevision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    scopeRevision = ((await response.json()) as { revision: number }).revision;
  };
  if (options.orgId) await setOrg(options.orgId);
  const lockFields = async (codes: readonly string[]) => {
    for (const code of codes) locked.add(code);
    await setButtons(true);
  };
  const request = (method: string, path: string, extra: RequestOptions = {}) =>
    world.api.request(method, `${TR_BASE}${path}`, { ...as, ...extra });
  return { profile, user, as, request, setOrg, setButtons, lockFields, setSeeAll, referenceView };
}
