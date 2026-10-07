/**
 * R3-T03 360 度评估验收夹具：租户成员（系统管理员）、360 人员、套卷、活动、评价关系与链接作答。
 * 测试数据一律合成，邮箱用 example.com。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { createUser, type Db, grantMembership, sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';

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

export async function world360(db: Db, label: string, options: { authorize?: Authorizer } = {}) {
  const session = await employmentSession(db, label);
  let now = new Date('2026-10-01T01:00:00Z');
  const admin = session.user.id;
  // 业务权限全部放行；企业设置的“管理员”管理能力只给租户首位成员（企业管理员），其他成员没有
  const enterprise: Authorizer = (request) => request.action !== 'admin.admin_manage' || request.userId === admin;
  const api = tenantApi(db, { clock: () => now, authorize: options.authorize ?? enterprise });
  const tenantId = session.tenant.id;

  const as =
    (user: string) =>
    (method: string, path: string, opts: RequestOptions = {}) =>
      api.request(method, `${BASE}${path}`, { ...opts, user, tenant: tenantId });
  const request = as(admin);

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

  async function appoint(userId: string, role: 'system' | 'advanced' | 'general', by = admin) {
    return ok<{ id: string; revision: number }>(as(by)('POST', '/admins', { ifMatch: 0, body: { userId, role } }), 201);
  }
  // 租户内首位 360 系统管理员由企业管理员（管理员管理能力）指定
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
    session,
    tenantId,
    admin,
    as,
    request,
    ok,
    member,
    appoint,
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
