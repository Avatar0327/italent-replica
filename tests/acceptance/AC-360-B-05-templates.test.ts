/**
 * R3-T03 PR-B 题库 / 套卷模板（`25` §3.1 E3-R2、E3-R10；§4 首版范围“题库 / 套卷模板 ✅”）：
 * - 模板新建、整卷编辑、删除；套卷“另存为模板”；模板“新建套卷”（新套卷为草稿）；
 * - 引用即复制：套卷里改内容不回写模板，模板改了也不影响已建套卷；
 * - 模板与套卷互不可见：套卷列表 / 详情不含模板，模板不能被评价对象选用；
 * - 编辑他人模板与套卷同一口径：要“编辑他人套卷”按钮（高级管理员 403）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type QuestionnaireView, world360 } from './AC-360-support.js';

const testDb = useTestDb();

describe('PR-B 套卷模板', () => {
  it('另存为模板、从模板新建套卷都是复制；模板与套卷互不可见', async () => {
    const w = await world360(testDb().db, 'b05a');
    const q = await w.enableQuestionnaire(await w.keyBehavior());
    const template = await w.ok<QuestionnaireView>(
      w.request('POST', `/questionnaires/${q.id}/save-as-template`, { ifMatch: 0, body: { name: '沟通模板' } }),
      201,
    );
    expect(template).toMatchObject({ name: '沟通模板', type: 'key_behavior' });
    expect(template.id).not.toBe(q.id);
    expect(template.questions.map((x) => x.text)).toEqual(['主动沟通', '协作支持']);

    // 互不可见
    const list = (await w.ok<{ items: { id: string }[] }>(w.request('GET', '/questionnaires'))).items;
    expect(list.map((i) => i.id)).not.toContain(template.id);
    expect((await w.request('GET', `/questionnaires/${template.id}`)).status).toBe(404);
    expect((await w.request('GET', `/questionnaire-templates/${q.id}`)).status).toBe(404);
    const templates = (
      await w.ok<{ items: { id: string; name: string }[] }>(w.request('GET', '/questionnaire-templates'))
    ).items;
    expect(templates.map((t) => t.id)).toEqual([template.id]);

    // 从模板新建套卷：草稿；之后改模板不影响套卷，改套卷不回写模板
    const created = await w.ok<QuestionnaireView>(
      w.request('POST', `/questionnaire-templates/${template.id}/instantiate`, {
        ifMatch: 0,
        body: { name: '新套卷' },
      }),
      201,
    );
    expect(created).toMatchObject({ name: '新套卷', status: 'draft' });
    const content = w.keyBehaviorContent({ self: 0, superior: 5, peer: 3, subordinate: 2 });
    const changed = {
      ...content,
      questions: content.questions.map((x) => (x.key === 'q1' ? { ...x, text: '模板里改过的题目' } : x)),
    };
    const updated = await w.ok<QuestionnaireView>(
      w.request('PUT', `/questionnaire-templates/${template.id}`, {
        ifMatch: template.revision,
        body: { content: changed },
      }),
    );
    expect(updated.questions[0]!.text).toBe('模板里改过的题目');
    const copy = await w.ok<QuestionnaireView>(w.request('GET', `/questionnaires/${created.id}`));
    expect(copy.questions[0]!.text).toBe('主动沟通');
    const source = await w.ok<QuestionnaireView>(w.request('GET', `/questionnaires/${q.id}`));
    expect(source.questions[0]!.text).toBe('主动沟通');

    // 模板不能被评价对象选用（按不存在处理）
    const activity = await w.activity();
    const target = await w.person('评价对象');
    const res = await w.request('POST', `/activities/${activity.id}/objects`, {
      ifMatch: 0,
      body: { personId: target.id, questionnaireIds: [template.id] },
    });
    expect(res.status).toBe(404);

    // 删除模板
    const latest = await w.ok<QuestionnaireView>(w.request('GET', `/questionnaire-templates/${template.id}`));
    await w.ok(w.request('DELETE', `/questionnaire-templates/${template.id}`, { ifMatch: latest.revision }));
    expect((await w.request('GET', `/questionnaire-templates/${template.id}`)).status).toBe(404);
  });

  it('新建空白模板；高级管理员不能编辑他人模板；模板不能启用', async () => {
    const w = await world360(testDb().db, 'b05b');
    const blank = await w.ok<QuestionnaireView>(
      w.request('POST', '/questionnaire-templates', { ifMatch: 0, body: { name: '空白模板', type: 'rating' } }),
      201,
    );
    expect(blank).toMatchObject({ type: 'rating', roles: [], dimensions: [] });
    expect((await w.request('POST', `/questionnaires/${blank.id}/enable`, { ifMatch: blank.revision })).status).toBe(
      404,
    );
    const advanced = await w.member('高级管理员');
    await w.appoint(advanced, 'advanced');
    const visible = (await w.ok<{ items: { id: string }[] }>(w.as(advanced)('GET', '/questionnaire-templates'))).items;
    expect(visible.map((t) => t.id)).toEqual([blank.id]);
    const res = await w.as(advanced)('PUT', `/questionnaire-templates/${blank.id}`, {
      ifMatch: blank.revision,
      body: { name: '改名' },
    });
    expect(res.status).toBe(403);
    expect((await w.ok<QuestionnaireView>(w.request('GET', `/questionnaire-templates/${blank.id}`))).name).toBe(
      '空白模板',
    );
  });
});
