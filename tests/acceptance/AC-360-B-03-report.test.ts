/**
 * R3-T03 PR-B 个人报告与转发（`25` §10.1 ⑬⑭⑮、§10.3；DEC-149 第二个匿名开关；DEC-262②）：
 * - 标准版报告：停用并计分后“生成 / 更新”，2 小时一次；内容是快照（封面、前言〔评价关系表 + 选项分值表〕、概况、优势与
 *   待发展、认知偏差、发展建议、开放性反馈、评估详情、补充反馈、声明），任何位置都没有评价者姓名、人员 ID、答卷 ID；
 * - 报告模板“文本答案中是否呈现评价角色”：开时文本答案带角色名，关时角色键缺席；文本答案按内容排序；
 * - 单人角色照常单列（DEC-149）；
 * - 转发：按汇报关系（本人 / 直线上级 / 虚线上级）、按评价关系角色、其他人；预览给报告数、收件人数、无法转发数；每位
 *   收件人一封邮件，发链接不发附件；收件人只能看邮件里的报告；
 * - Lastest360Cent 在报告生成后才计入，报告失效后不再计入。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loadSurvey360Port } from '../../apps/api/src/modules/survey360/port.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import {
  errorOf,
  key,
  MISSING_SECTION,
  outbox,
  progressDetail,
  reportLink,
  reports,
  sceneB,
  type SceneB,
} from './AC-360-B-support.js';

const testDb = useTestDb();

interface TextAnswer {
  text: string;
  roleName?: string;
}

interface QuestionnaireReport {
  questionnaireId: string;
  name: string;
  preface: {
    relationTable: { roleId: string; roleName: string; completed: number; invited: number; rate: number }[];
    total: { completed: number; invited: number; rate: number };
    scaleTable: { label: string; value: number | null }[];
  };
  overview: { self: number | null; other: number | null; roles: { roleName: string; score: number | null }[] };
  strengths: unknown;
  bias: unknown;
  developmentAdvice: unknown;
  openFeedback: TextAnswer[];
  details: { itemId: string; name: string; level: string }[];
  supplementary: { question: string; answers: TextAnswer[] }[];
}

interface Report {
  id: string;
  objectId: string;
  generatedAt: string;
  cover: { activityName: string; objectName: string; templateName: string };
  questionnaires: QuestionnaireReport[];
  statement: string;
}

/** 自评、上级、两名同事提交并留文本答案；客户未作答（客户角色没有有效数据）。 */
async function reported(label: string) {
  const s = await sceneB(testDb().db, label);
  await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v5', 'v4'], { suggestion: '自评建议：多授权' });
  await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v4', 'v5'], { remark: '上级备注：沟通及时' });
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4'], { suggestion: '乙建议：加强复盘' });
  await s.answerAs(s.person.P2.id, s.rel.p2.id, ['v5', 'v4', 'v3'], { suggestion: '甲建议：多分享' });
  await s.w.transition(s.activity.id, 'disable');
  return s;
}

const generate = (s: SceneB, body: Record<string, unknown> = {}) =>
  s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body });

async function onlyReport(s: SceneB, by = s.w.admin) {
  const [row] = await reports(s, by);
  return s.w.ok<Report>(s.w.as(by)('GET', `${s.path}/reports/${row!.id}`));
}

/** 报告里不能出现的评价者标识：姓名、人员 ID、评价关系 ID、邮箱。 */
function secretsOf(s: SceneB) {
  const people = [s.person.M, s.person.P1, s.person.P2, s.person.X];
  return [...people.flatMap((p) => [p.id, p.name, p.email]), ...Object.values(s.rel).map((r) => r.id)];
}

describe('PR-B 个人报告', () => {
  it('生成标准版快照：评价关系表、选项分值表、概况、文本答案带角色且按内容排序；无评价者标识', async () => {
    const s = await reported('b03a');
    const { w } = s;
    const before = await reports(s);
    expect(before).toEqual([
      expect.objectContaining({ id: null, objectId: s.object.id, status: 'not_generated', generatedAt: null }),
    ]);
    expect(await w.ok(generate(s))).toEqual({ generated: 1 });
    const [row] = await reports(s);
    expect(row).toMatchObject({ status: 'generated', generatedAt: '2026-10-01T01:00:00.000Z' });
    expect(row!.template.name).toBe('标准版');

    const report = await onlyReport(s);
    expect(report.cover).toMatchObject({ objectName: '评价对象', templateName: '标准版' });
    expect(report.cover.activityName).toBe(s.activity.name);
    const [part] = report.questionnaires;
    const table = Object.fromEntries(part!.preface.relationTable.map((r) => [r.roleName, [r.completed, r.invited]]));
    expect(table).toEqual({ 自评: [1, 1], 上级: [1, 1], 同事: [2, 2], 客户: [0, 1] });
    expect(part!.preface.total).toMatchObject({ completed: 4, invited: 5 });
    expect(part!.preface.scaleTable.map((o) => [o.label, o.value])).toContainEqual(['不做评价', null]);
    expect(part!.overview.roles.map((r) => r.roleName)).toEqual(['上级', '同事']);
    expect(part!.overview.self).not.toBeNull();
    expect(part!.openFeedback).toEqual([
      { text: '乙建议：加强复盘', roleName: '同事' },
      { text: '甲建议：多分享', roleName: '同事' },
      { text: '自评建议：多授权', roleName: '自评' },
    ]);
    expect(part!.supplementary).toEqual([
      { question: '主动沟通', answers: [{ text: '上级备注：沟通及时', roleName: '上级' }] },
    ]);
    const text = JSON.stringify(report);
    for (const secret of secretsOf(s)) expect(text).not.toContain(secret);
  });

  it('2 小时一次；模板关闭“文本答案呈现评价角色”后重新生成，角色键缺席', async () => {
    const s = await reported('b03b');
    const { w } = s;
    await w.ok(generate(s));
    const again = await generate(s);
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toMatchObject({
      message: '生成活动下所有报告120分钟后才可以重新生成报告！',
      details: { reason: 'RATE_LIMITED' },
    });
    const template = await w.ok<{ showTextRole: boolean; revision: number }>(w.request('GET', '/report-template'));
    expect(template.showTextRole).toBe(true);
    await w.ok(w.request('PUT', '/report-template', { ifMatch: template.revision, body: { showTextRole: false } }));
    w.setNow('2026-10-01T03:00:01Z');
    await w.ok(generate(s));
    const [part] = (await onlyReport(s)).questionnaires;
    expect(part!.openFeedback).toEqual([
      { text: '乙建议：加强复盘' },
      { text: '甲建议：多分享' },
      { text: '自评建议：多授权' },
    ]);
    for (const answer of [...part!.openFeedback, ...part!.supplementary.flatMap((q) => q.answers)])
      expect(Object.keys(answer)).toEqual(['text']);
  });

  it('缺少他评数据的模块显示原站文案；单人角色照常单列', async () => {
    const s = await sceneB(testDb().db, 'b03c');
    await s.answerAs(s.person.T.id, s.rel.self.id, ['v4', 'v4', 'v4']);
    await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v3', 'v3']);
    await s.w.transition(s.activity.id, 'disable');
    await s.w.ok(generate(s));
    const [part] = (await onlyReport(s)).questionnaires;
    expect(part!.overview.roles).toEqual([expect.objectContaining({ roleName: '上级', score: 3 })]);
    const t = await sceneB(testDb().db, 'b03d');
    await t.answerAs(t.person.T.id, t.rel.self.id, ['v4', 'v4', 'v4']);
    await t.w.transition(t.activity.id, 'disable');
    await t.w.ok(generate(t));
    const [only] = (await onlyReport(t)).questionnaires;
    expect(only!.strengths).toBe(MISSING_SECTION);
    expect(only!.bias).toBe(MISSING_SECTION);
  });

  it('活动未停用不能生成；无授权管理员 404', async () => {
    const s = await sceneB(testDb().db, 'b03e');
    const res = await generate(s);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details?.reason).toBe('ACTIVITY_NOT_DISABLED');
    const outsider = await s.w.member('无授权管理员');
    await s.w.appoint(outsider, 'advanced');
    for (const [method, path] of [
      ['GET', '/reports'],
      ['POST', '/reports/generate'],
      ['GET', '/score-tables?level=questionnaire'],
    ] as const) {
      const opts = method === 'GET' ? {} : { idempotencyKey: key(), body: {} };
      const r = await s.w.as(outsider)(method, `${s.path}${path}`, opts);
      expect(r.status, path).toBe(404);
    }
  });
});

describe('PR-B 报告转发', () => {
  it('按汇报关系转发给本人与直线、虚线上级：预览、每人一封、发链接；收件人只能看邮件里的报告', async () => {
    const s = await reported('b03f');
    const { w } = s;
    await w.ok(generate(s));
    const body = { mode: 'reporting', targets: ['self', 'direct', 'dotted'] };
    const preview = await w.ok<{
      reportCount: number;
      recipientCount: number;
      unresolvedReports: number;
      items: { objectName: string; recipientName: string; recipientEmail: string; relation: string }[];
    }>(w.request('POST', `${s.path}/reports/forward/preview`, { body }));
    expect(preview).toMatchObject({ reportCount: 1, recipientCount: 3, unresolvedReports: 0 });
    expect(preview.items.map((i) => [i.relation, i.recipientEmail]).sort()).toEqual(
      [
        ['dotted', s.person.D.email],
        ['direct', s.person.M.email],
        ['self', s.person.T.email],
      ].sort(),
    );
    expect(await w.ok(w.request('POST', `${s.path}/reports/forward`, { idempotencyKey: key(), body }))).toEqual({
      reportCount: 1,
      recipientCount: 3,
      unresolvedReports: 0,
    });
    const mails = await outbox(w, 'survey360.report_forward');
    expect(mails.map((m) => m.payload.to).sort()).toEqual(
      [s.person.D.email, s.person.M.email, s.person.T.email].sort(),
    );
    expect(mails[0]!.payload).toMatchObject({ subject: '请下载报告', channel: 'email' });
    expect(mails[0]!.payload).not.toHaveProperty('attachments');

    const mine = mails.find((m) => m.payload.to === s.person.T.email)!.payload.token;
    const call = reportLink(w, mine);
    const list = await w.ok<{ reports: { id: string; objectName: string }[] }>(call('GET'));
    expect(list.reports.map((r) => r.objectName)).toEqual(['评价对象']);
    const viewed = await w.ok<Report>(call('GET', `/reports/${list.reports[0]!.id}`));
    expect(viewed.questionnaires[0]!.openFeedback).toHaveLength(3);
    for (const secret of secretsOf(s)) expect(JSON.stringify(viewed)).not.toContain(secret);
    expect((await call('GET', `/reports/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await reportLink(w, 'forged-token')('GET')).status).toBe(404);

    // 报告失效后收件人查看同样被拦
    const row = (await progressDetail(s, s.person.P1.id)).items[0]!;
    await w.ok(w.request('POST', `${s.path}/relations/${row.relationId}/reanswer`, { ifMatch: row.revision }));
    const stale = await call('GET', `/reports/${list.reports[0]!.id}`);
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).details?.reason).toBe('DATA_CHANGED');
  });

  it('按评价关系角色与其他人转发；没有可转发收件人的报告计入无法转发', async () => {
    const s = await reported('b03g');
    const { w } = s;
    await w.ok(generate(s));
    const byRole = await w.ok<{ recipientCount: number; items: { recipientEmail: string }[] }>(
      w.request('POST', `${s.path}/reports/forward/preview`, { body: { mode: 'relation', roleIds: [w.role('peer')] } }),
    );
    expect(byRole.items.map((i) => i.recipientEmail).sort()).toEqual([s.person.P1.email, s.person.P2.email].sort());
    const others = await w.ok<{ recipientCount: number; items: { recipientName: string }[] }>(
      w.request('POST', `${s.path}/reports/forward/preview`, {
        body: { mode: 'others', others: [{ name: 'HRBP', email: 'hrbp@example.com' }] },
      }),
    );
    expect(others).toMatchObject({ recipientCount: 1, items: [{ recipientName: 'HRBP' }] });
    const nobody = await w.ok<{ reportCount: number; recipientCount: number; unresolvedReports: number }>(
      w.request('POST', `${s.path}/reports/forward/preview`, {
        body: { mode: 'relation', roleIds: [w.role('subordinate')] },
      }),
    );
    expect(nobody).toMatchObject({ reportCount: 0, recipientCount: 0, unresolvedReports: 1 });
  });
});

describe('PR-B 报告与 Lastest360Cent', () => {
  it('报告生成后才计入，报告失效（清除作答）后不再计入', async () => {
    const s = await reported('b03h');
    const { w } = s;
    const ALL = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
    const records = async () =>
      (
        await withTenant(w.db, w.tenantId, (tx) =>
          loadSurvey360Port(tx, { tenantId: w.tenantId, employeeIds: [s.employees.T.id], scope: ALL }),
        )
      ).records(s.employees.T.id);
    expect(await records()).toEqual({ ok: true, data: [] });
    await w.ok(generate(s));
    const after = await records();
    expect(after.ok && after.data.length).toBeGreaterThan(0);
    const row = (await progressDetail(s, s.person.P2.id)).items[0]!;
    await w.ok(w.request('POST', `${s.path}/relations/${row.relationId}/reanswer`, { ifMatch: row.revision }));
    expect(await records()).toEqual({ ok: true, data: [] });
  });
});
