/**
 * R3-T03 360 度评估验收夹具：租户成员、360 人员、套卷、活动、评价关系与链接作答。
 * 360 身份照 DEC-280：企业管理员在权限管理“用户授权”里授予（身份 × 应用 Survey360），360 侧没有管理员设置。
 * 测试数据一律合成，邮箱用 example.com。
 */
import { randomUUID } from 'node:crypto';
import { type Authorizer, bootstrapTenantAdmin, createPermissionAuthorizer } from '@italent/api';
import { createUser, type Db, grantMembership, sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';
import { PERSONNEL_OBJECT, survey360 } from '@italent/domain';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  registerScopeProvider,
} from '../../apps/api/src/modules/permission/module-access.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';

export const BASE = '/api/tenant/survey360';
export const LINK = '/api/survey360/link';

export interface PersonView {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  staffCode: string | null;
  department: string | null;
  position: string | null;
  superiorPersonId: string | null;
  employeeId: string | null;
  previousEmployeeId: string | null;
  emailLocked: boolean;
  source: string;
  revision: number;
}

export interface QuestionnaireView {
  id: string;
  name: string;
  type: string;
  status: string;
  revision: number;
  roles: { id: string; key: string; roleId: string; weight: number }[];
  scales: { id: string; key: string; name: string; options: { id: string; key: string; label: string }[] }[];
  dimensions: { id: string; key: string; parentId: string | null; name: string; weight: number }[];
  questions: { id: string; key: string; dimensionId: string; text: string }[];
}

export interface ActivityView {
  id: string;
  name: string;
  status: string;
  form: string;
  showAppraiserName: boolean;
  roleDisplay: string;
  revision: number;
  startedAt: string | null;
}

export interface ObjectView {
  id: string;
  personId: string;
  questionnaireIds: string[];
  revision: number;
}

export interface RelationView {
  id: string;
  objectId: string;
  appraiserPersonId: string;
  roleId: string;
  revision: number;
}

export interface ScoreRow {
  questionnaireId: string;
  level: string;
  itemId: string | null;
  scope: string;
  roleId: string | null;
  score: number | null;
  raterCount: number;
}

/** 关键行为套卷的选项分值：含 3.5 / 4.3 便于直接构造规格里的角色分（AC-360-03）。 */
export const VALUES = [1, 2, 3, 3.5, 4, 4.3, 5] as const;

/** 组织员工侧可查看的字段（同步按此裁剪）；未列出的对象视为全部字段可见。 */
export const FULL_EMPLOYEE_FIELDS = new Set(['name', 'code', 'email', 'workEmail', 'mobilePhone']);
export const FULL_RECORD_FIELDS = new Set(['departmentId', 'positionId', 'directManagerId']);

/**
 * 可调的员工数据范围与字段权限（替身权限提供方，模拟操作人在组织员工侧的当前权限）：
 * 测试中途改 scope / fields 即模拟撤权、收窄字段。
 */
export interface EmployeeAccess {
  scope: ModuleScope;
  fields: Record<string, ReadonlySet<string>>;
  /** 是否有员工信息的查看权限（object.view）。 */
  canView: boolean;
}

export function fullAccess(): EmployeeAccess {
  return {
    scope: { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
    fields: { [PERSONNEL_OBJECT]: FULL_EMPLOYEE_FIELDS, 'TenantBase.EmploymentRecord': FULL_RECORD_FIELDS },
    canView: true,
  };
}

export type ObjectPermissionBody = survey360.Survey360Profile['objects'][number];
export type IdentityKind = 'system' | 'advanced' | 'general';
const PROFILE_OF: Record<IdentityKind, string> = {
  system: 'standard_360_system_admin',
  advanced: 'standard_360_advanced_admin',
  general: 'standard_360_general_admin',
};
const PERMISSION = '/api/tenant/permission';

const isSurvey360 = (request: Parameters<Authorizer>[0]) =>
  (request.resource ?? '').startsWith(`${survey360.SURVEY360_APP}.`);

/**
 * 授权器：360 对象走真实的权限判定（身份 × 应用 + 用户授权 + 数据权限），组织员工侧用可调替身
 * （模拟操作人在组织员工侧的当前权限，测试中途改 scope / fields 即模拟撤权、收窄字段）。
 */
function hybridAuthorizer(db: Db, clock: () => Date, access: EmployeeAccess): Authorizer {
  const real = createPermissionAuthorizer(db, objectCatalog, clock);
  const employee = (request: Parameters<Authorizer>[0]) =>
    request.action === 'object.view' && request.resource === PERSONNEL_OBJECT ? access.canView : true;
  const authorize: Authorizer = (request) => (isSurvey360(request) ? real(request) : employee(request));
  const deps = { authorize: real, clock, db };
  registerScopeProvider(authorize, {
    authorize: async (request, tx) =>
      isSurvey360(request) ? authorizeInTransaction(real, tx)(request) : employee(request),
    scope: async (query, tx) => {
      if (!(query.objectCode ?? '').startsWith(`${survey360.SURVEY360_APP}.`)) return access.scope;
      return tx ? resolveDataScope(tx, query) : withTenant(db, query.tenantId, (t) => resolveDataScope(t, query));
    },
    fields: async (tenantId, userId, objectCode, tx) => {
      if (objectCode.startsWith(`${survey360.SURVEY360_APP}.`)) {
        const ctx = { tenantId, userId, timezone: 'UTC' };
        const read = (t: Parameters<typeof getModuleViewableFieldsInTransaction>[3]) =>
          getModuleViewableFieldsInTransaction(deps, ctx, objectCode, t);
        return (await (tx ? read(tx) : withTenant(db, tenantId, read))) ?? new Set<string>();
      }
      return access.fields[objectCode] ?? new Set(objectCatalog.get(objectCode)?.fields.map((f) => f.code) ?? []);
    },
  });
  return authorize;
}

export async function world360(db: Db, label: string, options: { access?: EmployeeAccess } = {}) {
  const session = await employmentSession(db, label);
  let now = new Date('2026-10-01T01:00:00Z');
  const admin = session.user.id;
  const tenantId = session.tenant.id;
  const clock = () => now;
  const authorize = hybridAuthorizer(db, clock, options.access ?? fullAccess());
  const api = tenantApi(db, { clock, authorize });
  // 权限管理接口走真实授权器；租户首位成员是企业管理员（开通时指定）
  const permission = tenantApi(db, { clock, authorize: undefined });

  const as =
    (user: string) =>
    (method: string, path: string, opts: RequestOptions = {}) =>
      api.request(method, `${BASE}${path}`, { ...opts, user, tenant: tenantId });
  const request = as(admin);
  const enterprise = (method: string, path: string, opts: RequestOptions = {}) =>
    permission.request(method, `${PERMISSION}${path}`, { ...opts, user: admin, tenant: tenantId });

  async function ok<T>(response: Promise<Response> | Response, status = 200): Promise<T> {
    const res = await response;
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  }

  /** 新成员（无任何 360 身份）。 */
  async function member(name: string) {
    const user = await createUser(db, { email: `${name}-${randomUUID()}@example.com`, displayName: name }, cmd());
    await grantMembership(db, { tenantId, userId: user.id, expectedRevision: 0 }, cmd());
    return user.id;
  }

  /**
   * 租户身份管理员按 permission 的“新建身份 → 登记应用 → 配对象权限”建一个 360 身份（自定义身份同此路径），
   * 并加入企业管理员的可授权身份。
   */
  async function defineProfile(name: string, objects: readonly ObjectPermissionBody[]) {
    const code = `s360_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const created = await ok<{ id: string; revision: number }>(
      enterprise('POST', '/profiles', {
        body: { code, name, apps: [survey360.SURVEY360_APP], licenseType: null },
      }),
      201,
    );
    let revision = created.revision;
    for (const { objectCode, ...body } of objects) {
      const saved = await ok<{ revision: number }>(
        enterprise('PUT', `/profiles/${created.id}/objects/${objectCode}`, { ifMatch: revision, body }),
      );
      revision = saved.revision;
    }
    const record = await ok<{ id: string; revision: number; grantableAdminRoles: string[] }>(
      enterprise('GET', `/admins/${adminRecord.id}`),
    );
    const current = record as unknown as { grantableProfileIds: string[] };
    await ok(
      enterprise('PUT', `/admins/${record.id}`, {
        ifMatch: record.revision,
        body: {
          grantableAdminRoles: record.grantableAdminRoles,
          grantableProfileIds: [...current.grantableProfileIds, created.id],
        },
      }),
    );
    return created.id;
  }

  /** 企业管理员在“用户授权”里给用户授予 360 身份（DEC-280②）。 */
  async function grantProfile(userId: string, profileId: string) {
    return ok<{ id: string; revision: number }>(enterprise('POST', '/grants', { body: { userId, profileId } }), 201);
  }

  /** 撤销用户授权（只停授权，不删活动授权行）。 */
  async function revokeGrant(grant: { id: string; revision: number }) {
    return ok(enterprise('POST', `/grants/${grant.id}/revoke`, { ifMatch: grant.revision }));
  }

  // 本夹具的租户不经平台开通，三类内置 360 身份按 SURVEY360_PROFILES 在租户内建同样内容的身份
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId, userId: admin }, cmd());
  const profiles = {} as Record<IdentityKind, string>;
  for (const kind of Object.keys(PROFILE_OF) as IdentityKind[]) {
    const standard = survey360.SURVEY360_PROFILES.find((p) => p.code === PROFILE_OF[kind])!;
    profiles[kind] = await defineProfile(standard.name, standard.objects);
  }

  async function appoint(userId: string, kind: IdentityKind) {
    return grantProfile(userId, profiles[kind]);
  }
  await appoint(admin, 'system');

  const roles = (await ok<{ items: { id: string; code: string | null; name: string }[] }>(request('GET', '/roles')))
    .items;
  const role = (code: string) => roles.find((r) => r.code === code)!.id;

  async function person(name: string, extra: Record<string, unknown> = {}) {
    return ok<PersonView>(
      request('POST', '/people', {
        ifMatch: 0,
        body: { name, email: `p-${randomUUID().slice(0, 8)}@example.com`, ...extra },
      }),
      201,
    );
  }

  /** 关键行为套卷：一个指标两道题；角色 自评 0 / 上级 5 / 同事 3 / 下级 2（AC-360-03 的例子）。 */
  async function keyBehavior(
    weights: Record<string, number> = { self: 0, superior: 5, peer: 3, subordinate: 2 },
    extra: Record<string, unknown> = {},
  ) {
    const created = await ok<QuestionnaireView>(
      request('POST', '/questionnaires', {
        ifMatch: 0,
        body: { name: `套卷${randomUUID().slice(0, 6)}`, type: 'key_behavior' },
      }),
      201,
    );
    const updated = await ok<QuestionnaireView>(
      request('PUT', `/questionnaires/${created.id}`, {
        ifMatch: created.revision,
        body: { ...extra, content: keyBehaviorContent(weights) },
      }),
    );
    return updated;
  }

  function keyBehaviorContent(weights: Record<string, number>) {
    return {
      roles: Object.entries(weights).map(([code, weight]) => ({ key: code, roleId: role(code), weight })),
      scales: [
        {
          key: 's',
          name: '分值',
          options: [
            ...VALUES.map((value) => ({ key: `v${value}`, label: String(value), value })),
            { key: 'none', label: '不做评价', notScored: true },
          ],
        },
      ],
      dimensions: [{ key: 'd', name: '沟通协作', weight: 100 }],
      questions: [
        { key: 'q1', dimensionKey: 'd', text: '主动沟通', weight: 1, scaleKey: 's' },
        { key: 'q2', dimensionKey: 'd', text: '协作支持', weight: 1, scaleKey: 's' },
      ],
    };
  }

  async function enableQuestionnaire(q: { id: string; revision: number }) {
    return ok<QuestionnaireView>(request('POST', `/questionnaires/${q.id}/enable`, { ifMatch: q.revision }));
  }

  async function activity(body: Record<string, unknown> = {}, by = admin) {
    return ok<ActivityView>(
      as(by)('POST', '/activities', {
        ifMatch: 0,
        body: {
          name: `活动${randomUUID().slice(0, 6)}`,
          form: 'single',
          showAppraiserName: true,
          roleDisplay: 'name',
          ...body,
        },
      }),
      201,
    );
  }

  async function object(activityId: string, personId: string, questionnaireIds: string[]) {
    return ok<ObjectView>(
      request('POST', `/activities/${activityId}/objects`, { ifMatch: 0, body: { personId, questionnaireIds } }),
      201,
    );
  }

  async function appraiser(activityId: string, objectId: string, personId: string, roleCode: string) {
    return ok<RelationView>(
      request('POST', `/activities/${activityId}/objects/${objectId}/appraisers`, {
        ifMatch: 0,
        body: { personId, roleId: role(roleCode) },
      }),
      201,
    );
  }

  async function getActivity(id: string, by = admin) {
    return ok<ActivityView>(as(by)('GET', `/activities/${id}`));
  }

  async function transition(id: string, action: 'enable' | 'disable') {
    const current = await getActivity(id);
    return ok<ActivityView>(request('POST', `/activities/${id}/${action}`, { ifMatch: current.revision }));
  }

  /** 作答链接令牌：取自邀请邮件 outbox（邮件不接真实发送）。 */
  async function token(activityId: string, personId: string, kind = 'survey360.answer_invitation') {
    const rows = await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`SELECT payload FROM survey360_outbox WHERE event_type = ${kind}
        AND payload->>'activityId' = ${activityId} AND payload->>'personId' = ${personId}
        ORDER BY created_at DESC LIMIT 1`),
    );
    const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { payload: { token: string } }[];
    expect(list.length, `outbox 中没有 ${personId} 的邀请`).toBe(1);
    return list[0]!.payload.token;
  }

  function link(tokenValue: string) {
    return (method: string, path: string, opts: Omit<RequestOptions, 'user' | 'tenant'> = {}) =>
      api.request(method, `${LINK}${path}`, {
        ...opts,
        tenant: tenantId,
        headers: { ...opts.headers, 'x-survey360-token': tokenValue },
      });
  }

  /** 用作答链接答完并提交一份答卷；answers 为 题目序号 → 选项键（v4、none…）。 */
  async function answer(
    tokenValue: string,
    relationId: string,
    q: QuestionnaireView,
    picks: readonly string[],
    submit = true,
  ) {
    const call = link(tokenValue);
    const options = q.scales[0]!.options;
    const answers = q.questions.map((question, index) => ({
      itemId: question.id,
      optionId: options.find((o) => o.key === picks[index])!.id,
    }));
    const saved = await ok<{ revision: number; status: string }>(
      call('PUT', `/tasks/${relationId}/questionnaires/${q.id}`, { ifMatch: 0, body: { answers } }),
    );
    if (!submit) return saved;
    return call('POST', `/tasks/${relationId}/questionnaires/${q.id}/submit`, { ifMatch: saved.revision });
  }

  async function scores(activityId: string, objectId: string, by = admin) {
    return (await ok<{ items: ScoreRow[] }>(as(by)('GET', `/activities/${activityId}/objects/${objectId}/scores`)))
      .items;
  }

  return {
    db,
    api,
    /** 本夹具的授权器（审计查询等其他入口要用同一套判定）。 */
    authorize,
    session,
    tenantId,
    admin,
    as,
    request,
    ok,
    member,
    appoint,
    profiles,
    defineProfile,
    grantProfile,
    revokeGrant,
    enterprise,
    roles,
    role,
    person,
    keyBehavior,
    keyBehaviorContent,
    enableQuestionnaire,
    activity,
    object,
    appraiser,
    getActivity,
    transition,
    token,
    link,
    answer,
    scores,
    setNow(iso: string) {
      now = new Date(iso);
    },
  };
}

export type World360 = Awaited<ReturnType<typeof world360>>;

export function overall(rows: readonly ScoreRow[], scope: string, roleId: string | null = null) {
  return rows.find((r) => r.level === 'questionnaire' && r.scope === scope && r.roleId === roleId)?.score ?? null;
}
