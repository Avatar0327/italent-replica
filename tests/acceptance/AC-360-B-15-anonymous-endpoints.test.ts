/**
 * DEC-364②（PR #125 第 5 轮）：匿名活动下逐个调用所有返回答卷相关数据的端点，无资格身份拿不到逐份答案——逐题选项
 * （optionId / optionLabel）、逐份分值卡片、答卷编号、逐份备注与建议原文；有资格身份（DEC-358②：持“全部活动”或
 * 活动创建者，且不兼任该活动被评价人 / 评价者）拿得到。端点写成显式清单：360 与审计的每个端点要么在 ANSWER_ENDPOINTS
 * 里逐个调用，要么在 NO_ANSWER_DATA 里写明不含答卷的理由；新增端点两边都没有时测试失败。
 * 报告正文（个人报告详情、收件人链接里的报告）的“开放性反馈 / 补充反馈”附录是按内容排序、不带评价者标识的汇总
 * （`25` §10.3 ⑬，DEC-358②“汇总不受影响”），只在这两个端点上允许出现建议 / 备注原文。
 * DEC-364①：结构上只有匿名投影层（survey360/anonymous.ts）读答卷内容，其他文件只能写入 / 删除答案。
 * F-060（#125 第 5 轮 P3-1）：枚举要进入有效读取分支再断言——真实待办、与评价关系匹配的令牌、带令牌的报告收件人
 * 请求、未生成报告的生成；保存 / 提交四个入口的回执含本人答案与建议，单独归类为 OWN_ANSWER_ENDPOINTS，并断言
 * 本人拿得到、他人拿不到且数据不变。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, routeManifest } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exportFontReady } from '../../apps/api/src/modules/survey360/export-files.js';
import { key, my, outbox, reportLink, reports, sceneB, type SceneB, sheets } from './AC-360-B-support.js';

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
  `GET ${ACT}/score-tables/download`,
  `GET ${ACT}/objects/:objectId/scores`,
  `GET ${ACT}/progress`,
  `GET ${ACT}/progress/:personId`,
  `GET ${ACT}/reports`,
  `GET ${ACT}/reports/:reportId`,
  `GET ${ACT}/reports/:reportId/download`,
  `POST ${ACT}/reports/generate`,
  `POST ${ACT}/reports/forward/preview`,
  `GET ${SURVEY}/my/todos`,
  `GET ${TODO}/answer`,
  `GET ${TODO}/tasks/:relationId/questionnaires/:questionnaireId`,
  `GET ${LINK}`,
  `GET ${LINK}/tasks/:relationId/questionnaires/:questionnaireId`,
  `GET ${REPORT_LINK}`,
  `GET ${REPORT_LINK}/reports/:reportId`,
  `GET ${REPORT_LINK}/reports/:reportId/download`,
  `GET ${AUDIT}/data-changes`,
  `GET ${AUDIT}/data-changes/:id`,
  `GET ${AUDIT}/operation-logs`,
  `GET ${AUDIT}/command-failures`,
] as const;

/** 报告正文：附录里的建议 / 备注原文是匿名汇总，允许出现。 */
const REPORT_CONTENT = new Set<string>([
  `GET ${ACT}/reports/:reportId`,
  `GET ${ACT}/reports/:reportId/download`,
  `GET ${REPORT_LINK}/reports/:reportId`,
  `GET ${REPORT_LINK}/reports/:reportId/download`,
]);

const CONFIG = '配置 / 人员名单，不含答卷';
const ROSTER = '活动、对象、评价关系、授权、邀请与待办发送：名单与状态，不含答卷';
const ANSWERING = '确认评价人：回执是确认单与候选人名单，不含答卷';
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

/** 保存 / 提交答卷：回执含评价者**本人**的答案与建议（ownSheet），他人拿不到——见“本人 / 他人边界”。 */
const OWN_ANSWER_ENDPOINTS = [
  `PUT ${TODO}/tasks/:relationId/questionnaires/:questionnaireId`,
  `POST ${TODO}/tasks/:relationId/questionnaires/:questionnaireId/submit`,
  `PUT ${LINK}/tasks/:relationId/questionnaires/:questionnaireId`,
  `POST ${LINK}/tasks/:relationId/questionnaires/:questionnaireId/submit`,
] as const;

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
  /** 链接端点用的令牌：没有作答的评价者（客户）——对 P1 的评价关系而言是“他人”。 */
  token: string;
  /** 评价者 P1 的待办（本人账号 user.P1）与作答令牌；被评价人 T 的报告收件人令牌（转发邮件）。 */
  todoId: string;
  ownerToken: string;
  reportToken: string;
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
    .replace(':todoId', t.todoId);
}

const QUERIES: Readonly<Record<string, string>> = {
  [`GET ${ACT}/score-tables`]: '?level=questionnaire',
  [`GET ${ACT}/score-tables/download`]: '?level=questionnaire',
  [`GET ${AUDIT}/data-changes`]: '?limit=100&objectType=survey360-sheet',
  [`GET ${AUDIT}/operation-logs`]: '?limit=100',
  [`GET ${AUDIT}/command-failures`]: '?limit=100',
};

async function callAs(s: SceneB, user: string, route: string, t: Target, auditId?: string) {
  const [method] = route.split(' ') as [string];
  const path = fill(route, t, auditId) + (QUERIES[route] ?? '');
  const base = { user, tenant: s.w.tenantId };
  const linkRoute = route.includes(LINK) || route.includes(REPORT_LINK);
  // 报告收件人请求必须带令牌，否则只是在测“缺令牌 404”；链接作答用他人（客户）的令牌，待办用查看人自己的账号
  const headers = route.includes(REPORT_LINK)
    ? { 'x-survey360-token': t.reportToken }
    : route.includes(LINK)
      ? { 'x-survey360-token': t.token }
      : undefined;
  const opts = linkRoute ? { tenant: s.w.tenantId, ...(headers ? { headers } : {}) } : base;
  if (route.endsWith('/block') || route.endsWith('/unblock'))
    return s.w.api.request(method, path, { ...opts, ifMatch: t.sheet.revision });
  if (route.endsWith('/forward/preview'))
    return s.w.api.request(method, path, { ...opts, body: { mode: 'reporting', targets: ['self'] } });
  if (method === 'POST') return s.w.api.request(method, path, { ...opts, idempotencyKey: key(), body: {} });
  return s.w.api.request(method, path, opts);
}

/** 逐份卡片与按编号屏蔽：无资格身份只能得到 403 / 404（汇总类端点可以 200，但响应不得带逐份内容）。 */
const CARD_DENIED = new Set<string>([
  `GET ${ACT}/sheets`,
  `POST ${ACT}/sheets/:sheetId/block`,
  `POST ${ACT}/sheets/:sheetId/unblock`,
]);
const isBinary = (res: Response) => /^(image\/|application\/pdf)/.test(res.headers.get('content-type') ?? '');

/**
 * 逐端点预期状态（F-060 第 3 轮 P3，Opus 接手）：三类无资格身份（被授权的一般管理员、兼任被评价人的全部活动持有人、
 * 兼任评价者的创建者）在这些端点上的状态相同，固定下来，防止有效读取退化成拒绝（或反之）时仍能通过。
 * - 汇总 / 报告 / 链接 / 审计读取：200（内容另由标记断言保证不带逐份答案）；
 * - 卡片与按编号屏蔽：403；令牌 / 待办不是本人的：404；
 * - 报告已生成后再生成：409；“屏蔽疑似”每个活动 2 小时只能用一次（RATE_LIMITED），同一活动先调的身份 200、后调 409；
 * - 下载（PNG / PDF）：有中文字体 200，无中文字体 503 EXPORT_FONT_UNAVAILABLE。
 */
const DOWNLOAD = 'download';
const EXPECTED_STATUS: Readonly<Record<string, readonly number[] | typeof DOWNLOAD>> = {
  [`GET ${ACT}/sheets`]: [403],
  [`POST ${ACT}/sheets/:sheetId/block`]: [403],
  [`POST ${ACT}/sheets/:sheetId/unblock`]: [403],
  [`POST ${ACT}/sheets/block-suspected`]: [200, 409],
  [`POST ${ACT}/sheets/unblock-all`]: [200],
  [`GET ${ACT}/score-tables`]: [200],
  [`GET ${ACT}/score-tables/download`]: DOWNLOAD,
  [`GET ${ACT}/objects/:objectId/scores`]: [200],
  [`GET ${ACT}/progress`]: [200],
  [`GET ${ACT}/progress/:personId`]: [200],
  [`GET ${ACT}/reports`]: [200],
  [`GET ${ACT}/reports/:reportId`]: [200],
  [`GET ${ACT}/reports/:reportId/download`]: DOWNLOAD,
  [`POST ${ACT}/reports/generate`]: [409],
  [`POST ${ACT}/reports/forward/preview`]: [200],
  [`GET ${SURVEY}/my/todos`]: [200],
  [`GET ${TODO}/answer`]: [404],
  [`GET ${TODO}/tasks/:relationId/questionnaires/:questionnaireId`]: [404],
  [`GET ${LINK}`]: [200],
  [`GET ${LINK}/tasks/:relationId/questionnaires/:questionnaireId`]: [404],
  [`GET ${REPORT_LINK}`]: [200],
  [`GET ${REPORT_LINK}/reports/:reportId`]: [200],
  [`GET ${REPORT_LINK}/reports/:reportId/download`]: DOWNLOAD,
  [`GET ${AUDIT}/data-changes`]: [200],
  [`GET ${AUDIT}/data-changes/:id`]: [200],
  [`GET ${AUDIT}/operation-logs`]: [200],
  [`GET ${AUDIT}/command-failures`]: [200],
};
const expectedStatus = (route: string, fonts: boolean): readonly number[] => {
  const expected = EXPECTED_STATUS[route];
  if (!expected) throw new Error(`缺少逐端点预期状态：${route}`);
  return expected === DOWNLOAD ? [fonts ? 200 : 503] : expected;
};

const isDownload = (route: string) => route.endsWith('/download');

/**
 * 无资格身份逐个调用清单里的端点：响应里不得有逐题选项、答卷编号与（报告正文以外的）备注 / 建议原文，并断言预期状态：
 * 卡片类 403 / 404，其余不得 5xx。二进制下载（PNG / PDF）不能用 .text() 查标记——图内 / PDF 内的内容由数据层断言：
 * 对应 JSON 端点（score-tables / 报告详情）在本循环里逐个检查，文件内容与 JSON 一致由 AC-360-F060 的版面模型测试保证。
 * 下载端点按字体可用性分支（用 F-060 第 2 轮的 fontconfig 检测，不硬编码环境）：
 * - 有中文字体：同其余端点（不得 5xx；成功时是二进制文件，不查标记）；
 * - 无中文字体（如 CI 镜像）：授权失败仍是 4xx，通过授权的一律 503 EXPORT_FONT_UNAVAILABLE，响应体同样不含任何答案 / 建议 /
 *   答卷编号（错误体不泄露内容）。
 */
async function expectNoAnswers(s: SceneB, user: string, t: Target, who: string) {
  const fonts = await exportFontReady();
  for (const route of ANSWER_ENDPOINTS) {
    const ids = route.endsWith('/data-changes/:id') ? t.auditIds : [undefined];
    for (const auditId of ids) {
      const res = await callAs(s, user, route, t, auditId);
      const where = `${who} ${route} → ${res.status}`;
      const noFontDownload = isDownload(route) && !fonts;
      if (CARD_DENIED.has(route)) expect([403, 404], where).toContain(res.status);
      expect(expectedStatus(route, fonts), where).toContain(res.status);
      if (res.status === 409 && route.endsWith('/block-suspected'))
        expect(JSON.parse(await res.clone().text()).error.details.reason, where).toBe('RATE_LIMITED');
      if (isBinary(res)) {
        expect(isDownload(route) && fonts, `${where} 只有有字体时的下载端点返回二进制`).toBe(true);
        continue;
      }
      const text = await res.text();
      if (noFontDownload && res.status === 503) expect(text, where).toContain('EXPORT_FONT_UNAVAILABLE');
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
  await s.w.ok(
    s.w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }),
  );
  const todoId = (await s.w.ok<{ items: { id: string }[] }>(my(s.w, s.user.P1)('GET', '/todos'))).items[0]!.id;
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
  await s.w.ok(
    s.w.request('POST', `${s.path}/reports/forward`, {
      idempotencyKey: key(),
      body: { mode: 'reporting', targets: ['self'] },
    }),
  );
  const mail = (await outbox(s.w, 'survey360.report_forward')).find((m) => m.payload.to === s.person.T.email)!;
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
    todoId,
    ownerToken: await s.w.token(s.activity.id, s.person.P1.id),
    reportToken: mail.payload.token,
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
    const listed = [...ANSWER_ENDPOINTS, ...OWN_ANSWER_ENDPOINTS, ...Object.keys(NO_ANSWER_DATA)];
    expect(new Set(listed).size, '两份清单不得重复').toBe(listed.length);
    expect([...listed].sort()).toEqual(declared);
    expect(Object.keys(EXPECTED_STATUS).sort(), '每个答卷出口都有逐端点预期状态').toEqual([...ANSWER_ENDPOINTS].sort());
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

/** F-060（#125 第 5 轮 P3-1）：进入有效读取 / 成功分支后的本人 / 他人边界。 */
describe('AC-360-B-15 / F-060 有效资源、成功状态与本人 / 他人边界', () => {
  const OPTION = (s: SceneB, k: string) => s.q.scales[0]!.options.find((o) => o.key === k)!.id;
  const answersOf = (s: SceneB, picks: readonly string[], suggestion: string) => ({
    answers: s.q.questions.map((question, i) => ({ itemId: question.id, optionId: OPTION(s, picks[i]!) })),
    suggestion,
  });

  it('读：本人经链接与待办拿到自己的答案；他人的令牌 / 账号 404 且响应不带内容', async () => {
    const { s, target } = await answered('own-read');
    const task = `/tasks/${target.relationId}/questionnaires/${target.questionnaireId}`;
    const own = await s.w.link(target.ownerToken)('GET', task);
    expect(own.status, '本人令牌').toBe(200);
    const mine = await own.text();
    expect(mine).toContain('"optionId"');
    // texts 按 T、M、P1、P2 顺序成对（建议、备注）；P1 是第三位，其余六条是别人的
    for (const other of target.texts.filter((_, i) => i < 4 || i >= 6))
      expect(mine, `本人读到别人的 ${other}`).not.toContain(other);
    const todo = my(s.w, s.user.P1);
    const viaTodo = await todo('GET', `/todos/${target.todoId}${task}`);
    expect(viaTodo.status, '本人待办').toBe(200);
    expect(await viaTodo.text()).toContain('"optionId"');

    // 他人：客户令牌读 P1 的评价关系、别的账号读 P1 的待办、管理员读 P1 的待办——一律 404，且不含任何答卷痕迹
    const others = [
      await s.w.link(target.token)('GET', task),
      await my(s.w, s.user.P2)('GET', `/todos/${target.todoId}${task}`),
      await s.w.api.request('GET', `${SURVEY}/my/todos/${target.todoId}${task}`, {
        user: s.w.admin,
        tenant: s.w.tenantId,
      }),
    ];
    for (const res of others) {
      expect(res.status).toBe(404);
      const text = await res.text();
      for (const marker of ['"optionId"', '"optionLabel"', ...target.texts]) expect(text).not.toContain(marker);
    }
  });

  it('保存 / 提交四个入口：本人成功且回执只含本人答案与建议；他人 404 且本人答卷不变', async () => {
    const s = await sceneB(testDb().db, 'own-write');
    const { w } = s;
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: {} }));
    // P2 先留一份他人的草稿，作为“别人的内容”
    await s.answerAs(s.person.P2.id, s.rel.p2.id, ['v2', 'v5', 'v3'], { suggestion: '他人草稿建议', submit: false });
    const otherSheet = (
      await w.ok<{ sheet: { revision: number } }>(
        w.link(await w.token(s.activity.id, s.person.P2.id))('GET', `/tasks/${s.rel.p2.id}/questionnaires/${s.q.id}`),
      )
    ).sheet;

    const path = (relationId: string) => `/tasks/${relationId}/questionnaires/${s.q.id}`;
    const p1Token = await w.token(s.activity.id, s.person.P1.id);
    const p1Link = w.link(p1Token);
    const stranger = w.link(await w.token(s.activity.id, s.person.X.id));
    const forbidden = (text: string) => {
      for (const marker of ['"optionId"', '他人草稿建议', '本人建议一', '本人建议二'])
        expect(text).not.toContain(marker);
    };

    // 链接入口：他人（客户令牌）保存 / 提交 P1 的任务 404 且无内容；本人保存成功，回执含本人答案与建议
    const denied = await stranger('PUT', path(s.rel.p1.id), {
      ifMatch: 0,
      body: answersOf(s, ['v4', 'v3', 'v4'], '本人建议一'),
    });
    expect(denied.status).toBe(404);
    forbidden(await denied.text());
    const saved = await p1Link('PUT', path(s.rel.p1.id), {
      ifMatch: 0,
      body: answersOf(s, ['v4', 'v3', 'v4'], '本人建议一'),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.text();
    expect(savedBody).toContain('"optionId"');
    expect(savedBody).toContain('本人建议一');
    expect(savedBody).not.toContain('他人草稿建议');
    const revision = (JSON.parse(savedBody) as { revision: number }).revision;
    const deniedSubmit = await stranger('POST', `${path(s.rel.p1.id)}/submit`, { ifMatch: revision });
    expect(deniedSubmit.status).toBe(404);
    forbidden(await deniedSubmit.text());
    // 他人的失败调用没有改动本人答卷
    const reread = await (await p1Link('GET', path(s.rel.p1.id))).text();
    expect(reread).toContain('本人建议一');
    expect(JSON.parse(reread).sheet).toMatchObject({ status: 'draft', revision });
    const submitted = await p1Link('POST', `${path(s.rel.p1.id)}/submit`, { ifMatch: revision });
    expect(submitted.status).toBe(200);
    const submittedBody = await submitted.text();
    expect(submittedBody).toContain('"optionId"');
    expect(submittedBody).toContain('本人建议一');
    expect(submittedBody).not.toContain('他人草稿建议');

    // 待办入口：P2 本人保存（在自己的草稿上）并提交成功；P1 / 管理员用 P2 的待办 404
    const p2Todos = (await w.ok<{ items: { id: string }[] }>(my(w, s.user.P2)('GET', '/todos'))).items;
    const todoPath = `/todos/${p2Todos[0]!.id}${path(s.rel.p2.id)}`;
    const adminTodo = (m: string, p: string, o?: object) =>
      w.api.request(m, `${SURVEY}/my${p}`, { ...(o ?? {}), user: w.admin, tenant: w.tenantId });
    for (const intruder of [my(w, s.user.P1), adminTodo] as const) {
      const res = await intruder('PUT', todoPath, {
        ifMatch: otherSheet.revision,
        body: answersOf(s, ['v1', 'v1', 'v1'], '本人建议二'),
      });
      expect(res.status).toBe(404);
      forbidden(await res.text());
    }
    // 他人提交 P2 待办里的答卷：同样 404 且无内容（先于本人提交）
    for (const intruder of [my(w, s.user.P1), adminTodo]) {
      const res = await intruder('POST', `${todoPath}/submit`, { ifMatch: otherSheet.revision });
      expect(res.status).toBe(404);
      forbidden(await res.text());
    }
    const ownSave = await my(w, s.user.P2)('PUT', todoPath, {
      ifMatch: otherSheet.revision,
      body: answersOf(s, ['v3', 'v3', 'v3'], '本人建议二'),
    });
    expect(ownSave.status).toBe(200);
    const ownSaveBody = await ownSave.text();
    expect(ownSaveBody).toContain('"optionId"');
    expect(ownSaveBody).toContain('本人建议二');
    expect(ownSaveBody).not.toContain('本人建议一');
    const ownRevision = (JSON.parse(ownSaveBody) as { revision: number }).revision;
    const ownSubmit = await my(w, s.user.P2)('POST', `${todoPath}/submit`, { ifMatch: ownRevision });
    expect(ownSubmit.status).toBe(200);
    expect(await ownSubmit.text()).toContain('本人建议二');
  });

  it('报告收件人链接：带有效令牌读到汇总，不带答卷编号 / 逐份选项；令牌与报告不匹配、缺令牌 404', async () => {
    const { s, target } = await answered('own-report');
    const call = reportLink(s.w, target.reportToken);
    const list = await call('GET');
    expect(list.status).toBe(200);
    const report = await call('GET', `/reports/${target.reportId}`);
    expect(report.status).toBe(200);
    const text = await report.text();
    for (const marker of ['"optionId"', '"optionLabel"', ...target.sheetIds]) expect(text).not.toContain(marker);
    // 令牌与报告不匹配：别的令牌（伪造）、不在链接清单里的报告编号；缺令牌
    expect((await reportLink(s.w, 'forged-token')('GET', `/reports/${target.reportId}`)).status).toBe(404);
    expect((await call('GET', `/reports/${crypto.randomUUID()}`)).status).toBe(404);
    const missing = await s.w.api.request('GET', `${REPORT_LINK}/reports/${target.reportId}`, { tenant: s.w.tenantId });
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('"questionnaires"');
  });

  it('生成报告：未生成时成功且回执只有人数；已有报告再生成 409', async () => {
    const s = await sceneB(testDb().db, 'own-generate');
    await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: '生成建议', remark: '生成备注' });
    await s.w.transition(s.activity.id, 'disable');
    const first = await s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} });
    expect(first.status).toBe(200);
    const body = await first.text();
    for (const marker of ['"optionId"', '"optionLabel"', '生成建议', '生成备注']) expect(body).not.toContain(marker);
    expect(JSON.parse(body)).toMatchObject({ generated: 1 });
    const again = await s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} });
    expect(again.status).toBe(409);
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
