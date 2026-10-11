/**
 * AC-TR-template-pg · R3-T04 PR-B6a 引用并发（真 PostgreSQL；设计 §2.3、§5.1）：模板保存引用流程 / 评价规则 / 盘点字段 / 人才标准时
 * 对被引用行加 KEY SHARE，与被引用对象的删除（行 FOR UPDATE）互斥——要么模板先提交、删除得到 409 *_IN_USE（人才标准
 * CRITERION_REFERENCED），要么删除先提交、模板得到 404（人才标准 400），不会出现悬空引用，也不会撞外键 500。同一模板同一
 * revision 的并发修改只有一个成功。PGlite 单连接无法并发，仅在设置 TEST_DATABASE_URL 时运行。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  indicatorModule,
  templateBody,
  templateWorld,
  TEMPLATES,
  type TemplateView,
} from './AC-TR-template-support.js';

const testDb = useTestDb();

const list = async (w: Awaited<ReturnType<typeof templateWorld>>) =>
  ((await (await w.trRequest('GET', `${TEMPLATES}?pageSize=100`)).json()) as { items: TemplateView[] }).items;

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('盘点模板引用 · PostgreSQL 16 并发', () => {
  it('新建引用评价规则的模板与删除该规则同时发生：要么模板建成且删除 409，要么规则先删模板 404，库里无悬空引用', async () => {
    const w = await templateWorld(testDb().db, 'trt-pg-rule');
    const { flow } = await w.threeStepFlow();
    const rule = await w.scoreRule();
    const [create, remove] = await Promise.all([
      w.trRequest('POST', TEMPLATES, {
        ifMatch: 0,
        body: templateBody(w.orgId, { flowId: flow.id, modules: [indicatorModule(rule.id, { name: '业绩' })] }),
      }),
      w.trRequest('DELETE', `/score-rules/${rule.id}`, { ifMatch: 1 }),
    ]);
    const templates = await list(w);
    if (create.status === 201) {
      expect(remove.status).toBe(409);
      expect(templates).toHaveLength(1);
    } else {
      expect([create.status, remove.status]).toEqual([404, 200]);
      expect(templates).toEqual([]);
    }
  });

  it('新建选用流程的模板与删除该流程同时发生：同样互斥，无悬空引用', async () => {
    const w = await templateWorld(testDb().db, 'trt-pg-flow');
    const { flow } = await w.threeStepFlow();
    const [create, remove] = await Promise.all([
      w.trRequest('POST', TEMPLATES, { ifMatch: 0, body: templateBody(w.orgId, { flowId: flow.id }) }),
      w.trRequest('DELETE', `/flows/${flow.id}`, { ifMatch: 1 }),
    ]);
    const templates = await list(w);
    if (create.status === 201) {
      expect(remove.status).toBe(409);
      expect(templates[0]!.flowId).toBe(flow.id);
    } else {
      expect([create.status, remove.status]).toEqual([404, 200]);
      expect(templates).toEqual([]);
    }
  });

  it('同一模板同一 revision 并发修改：一个 200，一个 409，revision 只加 1，版本不重复', async () => {
    const w = await templateWorld(testDb().db, 'trt-pg-revision');
    const { flow } = await w.threeStepFlow();
    const rule = await w.scoreRule();
    const template = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    const patch = (name: string) =>
      w.patch(template, { modules: [indicatorModule(rule.id, { name })] }, `trt-pg-${randomUUID()}`);
    const responses = await Promise.all([patch('甲'), patch('乙')]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const read = (await w.read(template.id)).body;
    expect([read.revision, read.currentVersionNo, read.versions.length]).toEqual([2, 2, 2]);
  });
});
