/**
 * PR #125 第 2 轮修改清单（依据 Astra 第 1 轮审查，head de2ae1c）的 8 项 P2：
 * 1 待办作答失败的审计不对一般管理员可见；2 进度明细的评价者信封按字段裁剪；3 待办状态与取消回执按查看人范围；
 * 4 报告嵌套字段与分数别名、报表列头按字段裁剪；5 转发须发送人对报告正文有完整查看权；6 待办 / 报告审计不绕过
 * 字段权限；7 重算不恢复旧报告、读取核对批次、改变计分组成的入口都让旧报告失效；8 评价对象移除后报告链接 404。
 */
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import type { ObjectPermissionBody, PersonView, QuestionnaireView } from './AC-360-support.js';
import {
  errorOf,
  hire,
  key,
  my,
  outbox,
  progress,
  progressDetail,
  reportLink,
  reports,
  sceneB,
  type SceneB,
  type TodoView,
} from './AC-360-B-support.js';

const testDb = useTestDb();
const OBJ = survey360.SURVEY360_OBJECTS;

/** 高级管理员身份，按对象隐藏指定字段（查看、编辑都关）。 */
function hiding(hide: Partial<Record<keyof typeof OBJ, readonly string[]>>): ObjectPermissionBody[] {
  const standard = survey360.SURVEY360_PROFILES.find((p) => p.code === 'standard_360_advanced_admin')!;
  return standard.objects.map((o) => {
    const entry = Object.entries(OBJ).find(([, d]) => d.code === o.objectCode)![0] as keyof typeof OBJ;
    const hidden = new Set(hide[entry] ?? []);
    return { ...o, fields: o.fields.map((f) => (hidden.has(f.fieldCode) ? { ...f, view: false, edit: false } : f)) };
  });
}

async function customAdmin(s: SceneB, name: string, hide: Parameters<typeof hiding>[0]) {
  const user = await s.w.member(name);
  await s.w.grantProfile(user, await s.w.defineProfile(name, hiding(hide)));
  const current = await s.w.getActivity(s.activity.id);
  await s.w.ok(s.w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [user] } }));
  return user;
}

const generate = (s: SceneB) => s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} });

async function answeredAndDisabled(label: string) {
  const s = await sceneB(testDb().db, label);
  await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: '自评建议' });
  await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v4', 'v5'], { remark: '上级备注' });
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4'], { suggestion: '同事建议' });
  await s.w.transition(s.activity.id, 'disable');
  return s;
}

describe('第 2 轮 P2-1：待办作答失败的审计', () => {
  it('待办保存失败（revision 冲突）的失败审计不给一般管理员；持“全部活动”者可见', async () => {
    const s = await sceneB(testDb().db, 'r2a');
    const { w } = s;
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }));
    const p1 = my(w, s.user.P1);
    const todo = (await w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items[0]!;
    const res = await p1('PUT', `/todos/${todo.id}/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`, {
      ifMatch: 7,
      body: { answers: [] },
    });
    expect(res.status).toBe(409);
    const general = await w.member('一般管理员');
    await w.appoint(general, 'general');
    const audit = auditApi(w.db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const failures = async (user: string) =>
      (await audit.commandFailures({ user, tenant: w.tenantId }, { limit: '100' })).items.filter((i) =>
        (i.path ?? '').includes('/survey360/my/'),
      );
    expect((await failures(w.admin)).length).toBeGreaterThan(0);
    expect(await failures(general)).toEqual([]);
  });
});

describe('第 2 轮 P2-2 / P2-3：进度明细信封与范围内待办状态', () => {
  it('看不到评价者姓名 / 人员 ID 时，进度明细的 appraiser 信封同样缺席这两个键', async () => {
    const s = await sceneB(testDb().db, 'r2b');
    const user = await customAdmin(s, '看不到评价者', { relation: ['name', 'personId'] });
    const detail = await progressDetail(s, s.person.P1.id, user);
    const text = JSON.stringify(detail);
    expect(text).not.toContain('同事一');
    expect(text).not.toContain(s.person.P1.id);
  });

  it('受限管理员：评价者只完成范围外任务前后，待办状态与取消回执都不变', async () => {
    const s = await sceneB(testDb().db, 'r2c');
    const { w } = s;
    const orgB = await w.session.org('乙部门', { establishedOn: '2025-01-01' });
    const U = await hire(w, '范围外对象', orgB.id);
    await w.ok(w.request('POST', '/people/sync', { body: {} }));
    const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
    const personU = people.find((p) => p.employeeId === U.id)!;
    const objectU = await w.object(s.activity.id, personU.id, [s.q.id]);
    const relU = await w.appraiser(s.activity.id, objectU.id, s.person.P1.id, 'peer');
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }));
    await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v4', 'v3']);

    const mou = await w.ok<{ id: string }>(
      w.enterprise('POST', '/mous', {
        ifMatch: 0,
        body: { code: 'mou-r2c', name: '甲部门', orgRanges: [{ orgId: s.org.id, includeDescendants: true }] },
      }),
      201,
    );
    const admin = await w.member('受限管理员');
    await w.appoint(admin, 'advanced');
    await w.ok(
      w.enterprise('PUT', `/scopes/${admin}/${survey360.SURVEY360_APP}`, {
        ifMatch: 0,
        body: { kind: 'mou', mouId: mou.id },
      }),
    );
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
    const current = await w.getActivity(s.activity.id);
    await w.ok(w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [admin] } }));

    const row = async () => (await progress(s, admin)).items.find((i) => i.personId === s.person.P1.id)!;
    const cancel = async () =>
      w.ok<{ cancelled: number }>(
        w.as(admin)('POST', `${s.path}/todos/cancel`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }),
      );
    const before = await row();
    const cancelBefore = await cancel();
    await s.answerAs(s.person.P1.id, relU.id, ['v4', 'v4', 'v4']);
    expect(await row()).toEqual(before);
    expect(await cancel()).toEqual(cancelBefore);
  });
});

describe('第 2 轮 P2-4 / P2-5：报告与报表的字段裁剪、转发的正文查看权', () => {
  it('看不到分数 / 生成时间 / 套卷 ID / 层级：报告任何层级都不带这些值；看不到 scope 时报表列头不带', async () => {
    const s = await answeredAndDisabled('r2d');
    await s.w.ok(generate(s));
    const user = await customAdmin(s, '看不到分数', {
      result: ['score', 'generatedAt', 'questionnaireId', 'level', 'scope'],
    });
    const [row] = await reports(s, user);
    const report = await s.w.ok<Record<string, unknown>>(s.w.as(user)('GET', `${s.path}/reports/${row!.id}`));
    const text = JSON.stringify(report);
    for (const keyName of [
      'score',
      'self',
      'other',
      'gap',
      'value',
      'reference',
      'generatedAt',
      'questionnaireId',
      'level',
    ])
      expect(text, keyName).not.toContain(`"${keyName}":`);
    expect(text).not.toContain('4.25');
    const table = await s.w.ok<{ columns: Record<string, unknown>[] }>(
      s.w.as(user)('GET', `${s.path}/score-tables?level=questionnaire`),
    );
    for (const column of table.columns) expect(column).not.toHaveProperty('scope');
  });

  it('看不到套卷名 / 指标与题目名 / 模板 / 条目 ID：报告任何层级都不带这些名称（自检补充）', async () => {
    const s = await answeredAndDisabled('r2j');
    await s.w.ok(generate(s));
    const user = await customAdmin(s, '看不到名称', {
      result: ['questionnaireName', 'itemName', 'template', 'itemId'],
    });
    const [row] = await reports(s, user);
    const report = await s.w.ok<Record<string, unknown>>(s.w.as(user)('GET', `${s.path}/reports/${row!.id}`));
    const text = JSON.stringify(report);
    for (const name of [s.q.name, '协作能力', '沟通', '支持', '主动沟通', '倾听反馈', '协作支持', '标准版'])
      expect(text, name).not.toContain(name);
    for (const keyName of ['dimensionId', 'itemId', 'templateName', 'question'])
      expect(text, keyName).not.toContain(`"${keyName}":`);
  });

  it('转发要求发送人对报告正文有完整查看权：看不到分数的转发人 403，不发邮件', async () => {
    const s = await answeredAndDisabled('r2e');
    await s.w.ok(generate(s));
    const user = await customAdmin(s, '看不到正文', { result: ['score'] });
    const body = { mode: 'others', others: [{ name: '自己', email: 'self-r2e@example.com' }] };
    for (const path of ['/reports/forward', '/reports/forward/preview']) {
      const res = await s.w.as(user)('POST', `${s.path}${path}`, { idempotencyKey: key(), body });
      expect(res.status, path).toBe(403);
      expect((await errorOf(res)).details?.reason).toBe('REPORT_FIELDS_RESTRICTED');
    }
    expect(await outbox(s.w, 'survey360.report_forward')).toEqual([]);
  });
});

describe('第 2 轮 P2-6：待办 / 报告审计按字段权限裁剪', () => {
  it('看不到人员 ID、生成时间、收件人邮箱时，审计详情也不带', async () => {
    const s = await answeredAndDisabled('r2f');
    const { w } = s;
    await w.transition(s.activity.id, 'enable');
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P2.id] } }));
    await w.transition(s.activity.id, 'disable');
    await w.ok(generate(s));
    await w.ok(
      w.request('POST', `${s.path}/reports/forward`, {
        idempotencyKey: key(),
        body: { mode: 'others', others: [{ name: 'HRBP', email: 'hrbp-r2f@example.com' }] },
      }),
    );
    const user = await customAdmin(s, '审计裁剪', {
      relation: ['personId'],
      result: ['generatedAt', 'recipientEmail'],
    });
    const audit = auditApi(w.db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const as = { user, tenant: w.tenantId };
    const items = (await audit.dataChanges(as, { limit: '100' })).items.filter((i) =>
      ['survey360-todo', 'survey360-report'].includes(i.objectType),
    );
    expect(items.map((i) => i.objectType).sort()).toEqual(['survey360-report', 'survey360-report', 'survey360-todo']);
    for (const item of items) {
      const detail = JSON.stringify([item, await audit.dataChange(as, item.id)]);
      expect(detail).not.toContain(s.person.P2.id);
      expect(detail).not.toContain('hrbp-r2f@example.com');
      expect(detail).not.toContain('"generatedAt"');
    }
  });
});

describe('第 2 轮 P2-7：报告失效与批次一致', () => {
  it('停用后删除已提交的评价关系：生成被拦（数据已变化）；重算后才能生成', async () => {
    const s = await answeredAndDisabled('r2g');
    const { w } = s;
    const list = await w.ok<{ items: { id: string; revision: number }[] }>(
      w.request('GET', `${s.path}/objects/${s.object.id}/appraisers`),
    );
    const superior = list.items.find((r) => r.id === s.rel.superior.id)!;
    await w.ok(
      w.request('DELETE', `${s.path}/objects/${s.object.id}/appraisers/${superior.id}`, { ifMatch: superior.revision }),
    );
    const res = await generate(s);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details?.reason).toBe('DATA_CHANGED');
  });

  it('已使用套卷改权重（活动停用中）：已生成的报告失效', async () => {
    const s = await answeredAndDisabled('r2h');
    const { w } = s;
    await w.ok(generate(s));
    const q = await w.ok<QuestionnaireView>(w.request('GET', `/questionnaires/${s.q.id}`));
    const content = {
      roles: q.roles.map((r) => ({ key: r.key, roleId: r.roleId, weight: r.key === 'superior' ? 9 : r.weight })),
      scales: q.scales.map((sc) => ({
        key: sc.key,
        name: sc.name,
        options: sc.options.map(({ id: _id, ...o }) => o),
      })),
      dimensions: q.dimensions.map((d) => ({
        key: d.key,
        parentKey: q.dimensions.find((x) => x.id === d.parentId)?.key ?? null,
        name: d.name,
        weight: d.weight,
      })),
      questions: q.questions.map((x) => ({
        key: x.key,
        dimensionKey: q.dimensions.find((d) => d.id === x.dimensionId)!.key,
        text: x.text,
        weight: 1,
        scaleKey: 's',
        ...(x.key === 'q1' ? { allowRemark: true } : {}),
      })),
    };
    await w.ok(w.request('PUT', `/questionnaires/${s.q.id}`, { ifMatch: q.revision, body: { content } }));
    expect((await reports(s))[0]!.status).toBe('outdated');
  });
});

describe('第 2 轮 P2-8：评价对象移除后报告链接', () => {
  it('转发后移除评价对象，收件人链接直达报告 404（与不存在相同）', async () => {
    const s = await answeredAndDisabled('r2i');
    const { w } = s;
    await w.ok(generate(s));
    await w.ok(
      w.request('POST', `${s.path}/reports/forward`, {
        idempotencyKey: key(),
        body: { mode: 'others', others: [{ name: 'HRBP', email: 'hrbp-r2i@example.com' }] },
      }),
    );
    const [mail] = await outbox(w, 'survey360.report_forward');
    const call = reportLink(w, mail!.payload.token);
    const [row] = await reports(s);
    await w.ok(call('GET', `/reports/${row!.id}`));
    const objects = await w.ok<{ items: { id: string; revision: number }[] }>(w.request('GET', `${s.path}/objects`));
    const object = objects.items.find((o) => o.id === s.object.id)!;
    await w.ok(w.request('DELETE', `${s.path}/objects/${object.id}`, { ifMatch: object.revision }));
    const gone = await call('GET', `/reports/${row!.id}`);
    const missing = await call('GET', `/reports/${crypto.randomUUID()}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual(await missing.json());
  });
});
