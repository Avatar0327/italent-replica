/**
 * R3-T03 PR-B 验收夹具：在 PR-A 夹具之上搭“组织员工 → 360 人员（同步挂接）→ 员工账号”的活动场景，
 * 供待办、进程控制、屏蔽与重新作答、个人报告与结果报表的用例共用。测试数据一律合成，邮箱用 example.com。
 * 入职（hire）即由人员建档端口创建并绑定租户账号（DEC-128），待办接收人取这个账号。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { type PersonView, type QuestionnaireView, world360, type World360 } from './AC-360-support.js';
import type { RequestOptions } from './support/tenant-api.js';

export const MY = '/api/tenant/survey360/my';
export const REPORT_LINK = '/api/survey360/report-link';

export const DATA_CHANGED = '数据发生变化,请启用-停用活动后再生成/更新报告！';
export const TODO_NOT_ELIGIBLE =
  '仅支持给未完成作答且属于系统管理内部员工的评价者发送待办，目前选中的评价者均不符合条件。';
export const MISSING_SECTION = '因缺少有效数据，该部分报告内容缺失。';

export interface ProgressItem {
  personId: string;
  name: string;
  email: string;
  status: 'not_started' | 'in_progress' | 'completed';
  lastSentAt: string | null;
  progress: { done: number; total: number };
  emailState: string | null;
  todo: 'open' | 'done' | null;
}

export interface Progress {
  total: { completed: number; all: number };
  items: ProgressItem[];
}

export interface ProgressDetailItem {
  relationId: string;
  objectId: string;
  objectName: string;
  roleId: string;
  roleName: string;
  status: 'not_started' | 'in_progress' | 'submitted' | 'submitted_blocked';
  revision: number;
}

export interface SheetCard {
  id: string;
  objectId: string;
  objectName: string;
  questionnaireId: string;
  questionnaireName: string;
  role: { id: string; name: string };
  blocked: boolean;
  blockSource: string | null;
  total: number | null;
  items: { itemId: string; optionLabel: string; score: number | null }[];
  revision: number;
}

export interface TodoView {
  id: string;
  activityId: string;
  title: string;
  content: string;
  status: 'open' | 'done';
  sentAt: string;
  doneAt: string | null;
}

export interface ReportRow {
  id: string | null;
  objectId: string;
  objectName: string;
  template: { id: string; name: string };
  status: 'not_generated' | 'generated' | 'outdated';
  generatedAt: string | null;
}

export const errorOf = async (res: Response) =>
  ((await res.clone().json()) as { error: { code: string; message: string; details?: { reason?: string } } }).error;

export async function hire(w: World360, name: string, orgId: string, managerId?: string, dottedId?: string) {
  const employee = await w.session.employee(name);
  await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: {
        departmentId: orgId,
        ...(managerId ? { directManagerId: managerId } : {}),
        ...(dottedId ? { dottedManagerId: dottedId } : {}),
      },
    },
    employee.revision,
  );
  return employee;
}

/** 入职时建档端口绑定的租户账号（DEC-128）。 */
export async function userOf(w: World360, employeeId: string): Promise<string> {
  const result = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT user_id FROM permission_user_person_links WHERE employee_id = ${employeeId}::uuid`),
  );
  const list = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { user_id: string }[];
  expect(list.length, `员工 ${employeeId} 没有绑定账号`).toBe(1);
  return list[0]!.user_id;
}

export async function outbox(w: World360, eventType: string) {
  const result = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT payload, created_at FROM survey360_outbox WHERE event_type = ${eventType}
      ORDER BY created_at, id`),
  );
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    payload: Record<string, unknown> & { token: string; personId?: string; to: string };
  }[];
}

/** 登录账号本人的待办入口（只要租户成员身份，不要 360 身份）。 */
export function my(w: World360, user: string) {
  return (method: string, path: string, opts: RequestOptions = {}) =>
    w.api.request(method, `${MY}${path}`, { ...opts, user, tenant: w.tenantId });
}

/** 转发报告的收件人链接（令牌取自转发邮件 outbox）。 */
export function reportLink(w: World360, token: string) {
  return (method: string, path = '') =>
    w.api.request(method, `${REPORT_LINK}${path}`, { tenant: w.tenantId, headers: { 'x-survey360-token': token } });
}

/** 关键行为套卷，两层指标（复合 c → 基础 b1 / b2），题目 q1、q2 挂 b1，q3 挂 b2；题目允许备注（文本答案）。 */
export function twoLevelContent(w: World360, weights: Record<string, number>) {
  const base = w.keyBehaviorContent(weights);
  return {
    ...base,
    dimensions: [
      { key: 'c', name: '协作能力', weight: 100 },
      { key: 'b1', parentKey: 'c', name: '沟通', weight: 50 },
      { key: 'b2', parentKey: 'c', name: '支持', weight: 50 },
    ],
    questions: [
      { key: 'q1', dimensionKey: 'b1', text: '主动沟通', weight: 1, scaleKey: 's', allowRemark: true },
      { key: 'q2', dimensionKey: 'b1', text: '倾听反馈', weight: 1, scaleKey: 's' },
      { key: 'q3', dimensionKey: 'b2', text: '协作支持', weight: 1, scaleKey: 's' },
    ],
  };
}

export const WEIGHTS = { self: 0, superior: 5, peer: 3, subordinate: 2, customer: 1 };

/**
 * 场景：甲部门经理 M（虚线上级 D）、评价对象 T（直线经理 M、虚线经理 D）、同事 P1 / P2（同一经理，内部员工、有账号），
 * 外部客户 X（360 手工录入，无员工、无账号）。活动“一次评价一人”，T 的评价者：T 自评、M 上级、P1 / P2 同事、X 客户。
 */
export async function sceneB(db: World360['db'], label: string, activityBody: Record<string, unknown> = {}) {
  const w = await world360(db, label);
  const org = await w.session.org('甲部门', { establishedOn: '2025-01-01' });
  const D = await hire(w, '虚线经理', org.id);
  const M = await hire(w, '直线经理', org.id);
  const T = await hire(w, '评价对象', org.id, M.id, D.id);
  const P1 = await hire(w, '同事一', org.id, M.id);
  const P2 = await hire(w, '同事二', org.id, M.id);
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
  const personOf = (employeeId: string) => people.find((p) => p.employeeId === employeeId)!;
  const X = await w.person('外部客户');
  const created = await w.ok<QuestionnaireView>(
    w.request('POST', '/questionnaires', { ifMatch: 0, body: { name: `套卷${label}`, type: 'key_behavior' } }),
    201,
  );
  const q = await w.enableQuestionnaire(
    await w.ok<QuestionnaireView>(
      w.request('PUT', `/questionnaires/${created.id}`, {
        ifMatch: created.revision,
        body: { content: twoLevelContent(w, WEIGHTS) },
      }),
    ),
  );
  const activity = await w.activity({ name: `${label} 年度360`, ...activityBody });
  const object = await w.object(activity.id, personOf(T.id).id, [q.id]);
  const rel = {
    self: await w.appraiser(activity.id, object.id, personOf(T.id).id, 'self'),
    superior: await w.appraiser(activity.id, object.id, personOf(M.id).id, 'superior'),
    p1: await w.appraiser(activity.id, object.id, personOf(P1.id).id, 'peer'),
    p2: await w.appraiser(activity.id, object.id, personOf(P2.id).id, 'peer'),
    customer: await w.appraiser(activity.id, object.id, X.id, 'customer'),
  };
  await w.transition(activity.id, 'enable');
  const person = {
    T: personOf(T.id),
    M: personOf(M.id),
    D: personOf(D.id),
    P1: personOf(P1.id),
    P2: personOf(P2.id),
    X,
  };
  const user = {
    T: await userOf(w, T.id),
    M: await userOf(w, M.id),
    P1: await userOf(w, P1.id),
    P2: await userOf(w, P2.id),
  };

  /** 用链接按选项键作答三道题；remark 给 q1 的文本答案，suggestion 给发展建议。 */
  async function answerAs(
    personId: string,
    relationId: string,
    picks: readonly string[],
    extra: { remark?: string; suggestion?: string; submit?: boolean } = {},
  ) {
    const call = w.link(await w.token(activity.id, personId));
    const options = q.scales[0]!.options;
    const answers = q.questions.map((question, index) => ({
      itemId: question.id,
      optionId: options.find((o) => o.key === picks[index])!.id,
      ...(index === 0 && extra.remark ? { remark: extra.remark } : {}),
    }));
    const saved = await w.ok<{ revision: number }>(
      call('PUT', `/tasks/${relationId}/questionnaires/${q.id}`, {
        ifMatch: 0,
        body: { answers, ...(extra.suggestion ? { suggestion: extra.suggestion } : {}) },
      }),
    );
    if (extra.submit === false) return;
    await w.ok(call('POST', `/tasks/${relationId}/questionnaires/${q.id}/submit`, { ifMatch: saved.revision }));
  }

  const path = `/activities/${activity.id}`;
  return { w, org, q, activity, object, rel, person, user, answerAs, path, employees: { D, M, T, P1, P2 } };
}

export type SceneB = Awaited<ReturnType<typeof sceneB>>;

export async function progress(s: SceneB, by = s.w.admin) {
  return s.w.ok<Progress>(s.w.as(by)('GET', `${s.path}/progress`));
}

export async function progressDetail(s: SceneB, personId: string, by = s.w.admin) {
  return s.w.ok<{ appraiser: { personId: string; name: string }; items: ProgressDetailItem[] }>(
    s.w.as(by)('GET', `${s.path}/progress/${personId}`),
  );
}

export async function sheets(s: SceneB, by = s.w.admin) {
  return (await s.w.ok<{ items: SheetCard[] }>(s.w.as(by)('GET', `${s.path}/sheets`))).items;
}

export async function reports(s: SceneB, by = s.w.admin) {
  return (await s.w.ok<{ items: ReportRow[] }>(s.w.as(by)('GET', `${s.path}/reports`))).items;
}

export const key = () => randomUUID();
