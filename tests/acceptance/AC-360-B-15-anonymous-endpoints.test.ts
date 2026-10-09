/**
 * DEC-364②（PR #125 第 5 轮）：匿名活动下逐个调用所有返回答卷相关数据的端点，无资格身份拿不到逐份答案——逐题选项
 * （optionId / optionLabel）、逐份分值卡片、答卷编号、逐份备注与建议原文；有资格身份（DEC-358②：持“全部活动”或
 * 活动创建者，且不兼任该活动被评价人 / 评价者）拿得到。端点写成显式清单：360 与审计的每个端点要么在 ANSWER_ENDPOINTS
 * 里逐个调用，要么在 NO_ANSWER_DATA 里写明不含答卷的理由；新增端点两边都没有时测试失败。
 * 报告正文（个人报告详情、收件人链接里的报告）的“开放性反馈 / 补充反馈”附录是按内容排序、不带评价者标识的汇总
 * （`25` §10.3 ⑬，DEC-358②“汇总不受影响”），只在这两个端点上允许出现建议 / 备注原文。
 * DEC-364①：结构上只有匿名投影层（survey360/anonymous.ts）读答卷内容，其他文件只能写入 / 删除答案。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, routeManifest } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { key, reports, sceneB, type SceneB, sheets } from './AC-360-B-support.js';

const testDb = useTestDb();

const SURVEY = '/api/tenant/survey360';
const ACT = `${SURVEY}/activities/:id`;
const TODO = `${SURVEY}/my/todos/:todoId`;
const LINK = '/api/survey360/link';
const REPORT_LINK = '/api/survey360/report-link';
const AUDIT = '/api/tenant/audit';

/** 返回答卷相关数据的端点：逐个调用（写入类带最小请求体，无资格身份通常 403 / 404 / 400，同样不得带答卷）。 */
const ANSWER_ENDPOINTS = [
  `GET ${ACT}/sheets`,
  `POST ${ACT}/sheets/:sheetId/block`,
  `POST ${ACT}/sheets/:sheetId/unblock`,
  `POST ${ACT}/sheets/block-suspected`,
  `POST ${ACT}/sheets/unblock-all`,
  `GET ${ACT}/score-tables`,
  `GET ${ACT}/objects/:objectId/scores`,
  `GET ${ACT}/progress`,
  `GET ${ACT}/progress/:personId`,
  `GET ${ACT}/reports`,
  `GET ${ACT}/reports/:reportId`,
  `POST ${ACT}/reports/generate`,
  `POST ${ACT}/reports/forward/preview`,
  `GET ${SURVEY}/my/todos`,
  `GET ${TODO}/answer`,
  `GET ${TODO}/tasks/:relationId/questionnaires/:questionnaireId`,
  `GET ${LINK}`,
  `GET ${LINK}/tasks/:relationId/questionnaires/:questionnaireId`,
  `GET ${REPORT_LINK}`,
  `GET ${REPORT_LINK}/reports/:reportId`,
  `GET ${AUDIT}/data-changes`,
  `GET ${AUDIT}/data-changes/:id`,
  `GET ${AUDIT}/operation-logs`,
  `GET ${AUDIT}/command-failures`,
] as const;

/** 报告正文：附录里的建议 / 备注原文是匿名汇总，允许出现。 */
const REPORT_CONTENT = new Set<string>([`GET ${ACT}/reports/:reportId`, `GET ${REPORT_LINK}/reports/:reportId`]);

const CONFIG = '配置 / 人员名单，不含答卷';
const ROSTER = '活动、对象、评价关系、授权、邀请与待办发送：名单与状态，不含答卷';
const ANSWERING = '作答写入 / 确认评价人：回执只有本人答卷的状态与修订号';
const NO_ANSWER_DATA: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      `GET ${SURVEY}/questionnaires`,
      `POST ${SURVEY}/questionnaires`,
      `GET ${SURVEY}/questionnaires/:id`,
      `PUT ${SURVEY}/questionnaires/:id`,
      `DELETE ${SURVEY}/questionnaires/:id`,
      `POST ${SURVEY}/questionnaires/:id/enable`,
      `POST ${SURVEY}/questionnaires/:id/save-as-template`,
      `GET ${SURVEY}/questionnaire-templates`,
      `POST ${SURVEY}/questionnaire-templates`,
      `GET ${SURVEY}/questionnaire-templates/:id`,
      `PUT ${SURVEY}/questionnaire-templates/:id`,
      `DELETE ${SURVEY}/questionnaire-templates/:id`,
      `POST ${SURVEY}/questionnaire-templates/:id/instantiate`,
      `GET ${SURVEY}/roles`,
      `POST ${SURVEY}/roles`,
      `PUT ${SURVEY}/roles/:id`,
      `GET ${SURVEY}/settings`,
      `PUT ${SURVEY}/settings`,
      `GET ${SURVEY}/report-template`,
      `PUT ${SURVEY}/report-template`,
      `GET ${SURVEY}/people`,
      `POST ${SURVEY}/people`,
      `GET ${SURVEY}/people/:id`,
      `PUT ${SURVEY}/people/:id`,
      `GET ${SURVEY}/people/:id/link-logs`,
      `POST ${SURVEY}/people/sync`,
      `GET ${SURVEY}/people/sync-conflicts`,
      `POST ${SURVEY}/people/sync-conflicts/:id/resolve`,
    ].map((k) => [k, CONFIG]),
  ),
  ...Object.fromEntries(
    [
      `GET ${SURVEY}/activities`,
      `POST ${SURVEY}/activities`,
      `GET ${ACT}`,
      `PUT ${ACT}`,
      `DELETE ${ACT}`,
      `POST ${ACT}/enable`,
      `POST ${ACT}/disable`,
      `GET ${ACT}/grants`,
      `POST ${ACT}/grants`,
      `DELETE ${ACT}/grants/:userId`,
      `GET ${ACT}/objects`,
      `POST ${ACT}/objects`,
      `DELETE ${ACT}/objects/:objectId`,
      `PUT ${ACT}/objects/:objectId/questionnaires`,
      `GET ${ACT}/objects/:objectId/appraisers`,
      `POST ${ACT}/objects/:objectId/appraisers`,
      `POST ${ACT}/objects/:objectId/appraisers/auto`,
      `DELETE ${ACT}/objects/:objectId/appraisers/:relationId`,
      `POST ${ACT}/objects/:objectId/confirmation`,
      `POST ${ACT}/appraisers/import`,
      `POST ${ACT}/invitations`,
      `POST ${ACT}/todos`,
      `POST ${ACT}/todos/cancel`,
    ].map((k) => [k, ROSTER]),
  ),
  ...Object.fromEntries(
    [
      `PUT ${TODO}/tasks/:relationId/questionnaires/:questionnaireId`,
      `POST ${TODO}/tasks/:relationId/questionnaires/:questionnaireId/submit`,
      `PUT ${LINK}/tasks/:relationId/questionnaires/:questionnaireId`,
      `POST ${LINK}/tasks/:relationId/questionnaires/:questionnaireId/submit`,
      `GET ${LINK}/confirmation/candidates`,
      `POST ${LINK}/confirmation/appraisers`,
      `DELETE ${LINK}/confirmation/appraisers/:relationId`,
      `POST ${LINK}/confirmation/submit`,
    ].map((k) => [k, ANSWERING]),
  ),
  [`GET ${TODO}/avatars/:attachmentId/content`]: '评价对象头像图片',
  [`GET ${LINK}/avatars/:attachmentId/content`]: '评价对象头像图片',
  [`POST ${ACT}/relations/:relationId/reanswer`]: '回执只有评价关系进度；清除前快照只进审计（审计出口逐个调用）',
  [`POST ${ACT}/reports/forward`]: '回执只有报告数与收件人数；邮件只带收件人链接（收件人链接端点逐个调用）',
};

const MODULES = new Set(['survey360', 'survey360-link', 'survey360-report-link', 'audit']);

interface Target {
  activityId: string;
  objectId: string;
  personId: string;
  relationId: string;
  questionnaireId: string;
  reportId: string;
  sheet: { id: string; revision: number };
  /** 该活动全部答卷编号（逐份卡片 / 审计对象编号）与逐份备注、建议原文。 */
  sheetIds: string[];
  texts: string[];
  /** 管理员可见的答卷日志编号（逐条调详情）。 */
  auditIds: string[];
  /** 链接端点用的令牌：没有作答的评价者（客户）。 */
  token: string;
}

function fill(route: string, t: Target, auditId = ''): string {
  return route
    .replace(/^(GET|POST|PUT|DELETE) /, '')
    .replace(':id/', `${t.activityId}/`)
    .replace(/:id$/, auditId)
    .replace(':objectId', t.objectId)
    .replace(':personId', t.personId)
    .replace(':relationId', t.relationId)
    .replace(':questionnaireId', t.questionnaireId)
    .replace(':reportId', t.reportId)
    .replace(':sheetId', t.sheet.id)
    .replace(':todoId', key());
}

const QUERIES: Readonly<Record<string, string>> = {
  [`GET ${ACT}/score-tables`]: '?level=questionnaire',
  [`GET ${AUDIT}/data-changes`]: '?limit=100&objectType=survey360-sheet',
  [`GET ${AUDIT}/operation-logs`]: '?limit=100',
  [`GET ${AUDIT}/command-failures`]: '?limit=100',
};

async function callAs(s: SceneB, user: string, route: string, t: Target, auditId?: string) {
  const [method] = route.split(' ') as [string];
  const path = fill(route, t, auditId) + (QUERIES[route] ?? '');
  const base = { user, tenant: s.w.tenantId };
  const linkRoute = route.includes(LINK) || route.includes(REPORT_LINK);
  const headers = route.includes(LINK) ? { 'x-survey360-token': t.token } : undefined;
  const opts = linkRoute ? { tenant: s.w.tenantId, ...(headers ? { headers } : {}) } : base;
  if (route.endsWith('/block') || route.endsWith('/unblock'))
    return s.w.api.request(method, path, { ...opts, ifMatch: t.sheet.revision });
  if (route.endsWith('/forward/preview'))
    return s.w.api.request(method, path, { ...opts, body: { mode: 'reporting', targets: ['self'] } });
  if (method === 'POST') return s.w.api.request(method, path, { ...opts, idempotencyKey: key(), body: {} });
  return s.w.api.request(method, path, opts);
}

/** 无资格身份逐个调用清单里的端点：响应里不得有逐题选项、答卷编号与（报告正文以外的）备注 / 建议原文。 */
async function expectNoAnswers(s: SceneB, user: string, t: Target, who: string) {
  for (const route of ANSWER_ENDPOINTS) {
    const ids = route.endsWith('/data-changes/:id') ? t.auditIds : [undefined];
    for (const auditId of ids) {
      const res = await callAs(s, user, route, t, auditId);
      const text = await res.text();
      const where = `${who} ${route} → ${res.status}`;
      for (const marker of ['"optionId"', '"optionLabel"', ...t.sheetIds]) expect(text, where).not.toContain(marker);
      if (!REPORT_CONTENT.has(route)) for (const marker of t.texts) expect(text, where).not.toContain(marker);
    }
  }
}

async function auditSheetIds(s: SceneB, activityId: string) {
  const res = await s.w.api.request('GET', `${AUDIT}/data-changes?limit=100&objectType=survey360-sheet`, {
    user: s.w.admin,
    tenant: s.w.tenantId,
  });
  expect(res.status).toBe(200);
  const items = ((await res.json()) as { items: { id: string }[] }).items;
  const mine = [];
  for (const item of items) {
    const detail = await s.w.api.request('GET', `${AUDIT}/data-changes/${item.id}`, {
      user: s.w.admin,
      tenant: s.w.tenantId,
    });
    if ((await detail.text()).includes(activityId)) mine.push(item.id);
  }
  return mine;
}

/** 被评价人 T 的自评、上级 M、同事 P1 / P2 提交（各带建议与备注），停用、生成报告。 */
async function answered(label: string) {
  const s = await sceneB(testDb().db, label);
  const texts: string[] = [];
  for (const [person, relation, picks] of [
    [s.person.T, s.rel.self, ['v5', 'v4', 'v4']],
    [s.person.M, s.rel.superior, ['v3', 'v4', 'v5']],
    [s.person.P1, s.rel.p1, ['v4', 'v3', 'v4']],
    [s.person.P2, s.rel.p2, ['v2', 'v5', 'v3']],
  ] as const) {
    const suggestion = `${label}建议${texts.length}`;
    const remark = `${label}备注${texts.length}`;
    texts.push(suggestion, remark);
    await s.answerAs(person.id, relation.id, picks, { suggestion, remark });
  }
  await s.w.transition(s.activity.id, 'disable');
  await s.w.ok(s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
  const cards = await sheets(s);
  const target: Target = {
    activityId: s.activity.id,
    objectId: s.object.id,
    personId: s.person.P1.id,
    relationId: s.rel.p1.id,
    questionnaireId: s.q.id,
    reportId: (await reports(s))[0]!.id!,
    sheet: { id: cards[0]!.id, revision: cards[0]!.revision },
    sheetIds: cards.map((c) => c.id),
    texts,
    auditIds: await auditSheetIds(s, s.activity.id),
    token: await s.w.token(s.activity.id, s.person.X.id),
  };
  return { s, target };
}

/** 夹具捷径：把活动的创建者改记为 user 并授权（创建者经接口建活动即自动授权；该路径见 AC-360-B-13 / B-14）。 */
async function createdBy(s: SceneB, user: string) {
  await withTenant(s.w.db, s.w.tenantId, (tx) =>
    tx.execute(sql`UPDATE survey360_activities SET created_by = ${user}::uuid WHERE id = ${s.activity.id}::uuid`),
  );
  await grantActivity(s, user);
}

async function grantActivity(s: SceneB, user: string) {
  const current = await s.w.getActivity(s.activity.id);
  await s.w.ok(s.w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [user] } }));
}

describe('DEC-364② 匿名活动的答卷出口枚举', () => {
  it('端点清单完整：360 与审计的每个端点都已归类（新增端点不在清单里即失败）', () => {
    const declared = routeManifest(createApp({ db: testDb().db }))
      .declared.filter((r) => MODULES.has(r.module))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const listed = [...ANSWER_ENDPOINTS, ...Object.keys(NO_ANSWER_DATA)];
    expect(new Set(listed).size, '两份清单不得重复').toBe(listed.length);
    expect([...listed].sort()).toEqual(declared);
  });

  it('一般活动管理员（被授权、非创建者）与兼任被评价人的“全部活动”持有人：所有出口都拿不到逐份答案', async () => {
    const { s, target } = await answered('enum-a');
    expect(target.auditIds.length).toBeGreaterThan(0);
    const general = await s.w.member('一般活动管理员');
    await s.w.appoint(general, 'general');
    await grantActivity(s, general);
    await expectNoAnswers(s, general, target, '一般活动管理员');
    await s.w.appoint(s.user.T, 'system');
    await expectNoAnswers(s, s.user.T, target, '兼任被评价人的全部活动持有人');
  });

  it('兼任评价者的活动创建者：自己创建的活动里所有出口都拿不到逐份答案', async () => {
    const { s, target } = await answered('enum-b');
    // 活动创建者记为 M（M 同时是该活动的上级评价者）
    await s.w.appoint(s.user.M, 'general');
    await createdBy(s, s.user.M);
    await expectNoAnswers(s, s.user.M, target, '兼任评价者的创建者');
  });

  it('有资格身份拿得到：不兼任的“全部活动”持有人与不兼任的活动创建者看卡片与答卷日志里的答案', async () => {
    const { s, target } = await answered('enum-c');
    const creator = await s.w.member('不兼任的创建者');
    await s.w.appoint(creator, 'general');
    await createdBy(s, creator);
    for (const [user, who] of [
      [s.w.admin, '全部活动持有人'],
      [creator, '活动创建者'],
    ] as const) {
      const cards = await callAs(s, user, `GET ${ACT}/sheets`, target);
      expect(cards.status, who).toBe(200);
      expect(await cards.text(), who).toContain('"optionLabel"');
      const details = await Promise.all(
        target.auditIds.map(async (id) => (await callAs(s, user, `GET ${AUDIT}/data-changes/:id`, target, id)).text()),
      );
      const joined = details.join('');
      expect(joined, who).toContain('"optionId"');
      for (const text of target.texts) expect(joined, `${who} ${text}`).toContain(text);
    }
  });
});

/** DEC-364①：只有匿名投影层读答卷内容；其他文件对答案表只能写入 / 删除，不读建议与备注。 */
describe('DEC-364① 匿名投影层是唯一的答卷读取点', () => {
  const ROOT = fileURLToPath(new URL('../../apps/api/src', import.meta.url));
  const LAYER = 'modules/survey360/anonymous.ts';
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
    );
  const sources = files(ROOT).map((file) => ({ file: relative(ROOT, file), text: readFileSync(file, 'utf8') }));

  it('投影层存在', () => {
    expect(sources.map((s) => s.file)).toContain(LAYER);
  });

  it('答案表：投影层以外只有 import、insert 与 delete', () => {
    const offenders = sources
      .filter((s) => s.file !== LAYER)
      .flatMap((s) =>
        s.text
          .split('\n')
          .map((line, i) => ({ where: `${s.file}:${i + 1}`, line }))
          .filter(({ line }) => /survey360Answers|survey360_answers/.test(line))
          .filter(({ line }) => !/^\s*(import\b|survey360Answers,|\} from)/.test(line))
          .filter(({ line }) => !/\.(insert|delete)\(survey360Answers\)/.test(line)),
      );
    expect(offenders).toEqual([]);
  });

  it('建议与备注：投影层以外只读请求输入（input.suggestion / a.remark），不从答卷行读取', () => {
    const offenders = sources
      .filter((s) => s.file.startsWith('modules/survey360/') && s.file !== LAYER)
      .flatMap((s) =>
        s.text
          .split('\n')
          .map((line, i) => ({ where: `${s.file}:${i + 1}`, line }))
          .filter(({ line }) => /\.(suggestion|remark)\b/.test(line))
          .filter(({ line }) => !/\b(input\.suggestion|a\.remark)\b/.test(line)),
      );
    expect(offenders).toEqual([]);
  });
});
