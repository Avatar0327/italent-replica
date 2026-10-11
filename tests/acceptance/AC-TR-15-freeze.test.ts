/**
 * R3-T04 PR-B6a 评价规则 / 模块等级 / 流程 / 字段的版本冻结（设计 §2.3、§13 第 4 条；TR-R20；AC-TR-15 / D-02）：
 * 模板版本保存时把评价规则头部与等级、模块等级项、流程节点副本整份快照进版本；之后修改规则的上下限 / 无法评价 / 等级、
 * 模块等级、流程，已保存的版本（已发起对象钉住的版本）读回不变；只有再次保存结构的新版本才取到新内容。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { indicatorModule, templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';

const testDb = useTestDb();

describe('AC-TR-15-freeze 模板版本冻结', () => {
  it('改评价规则上下限 / allow_unable、改模块等级项、改流程节点后，已保存版本读回不变；新版本取新内容', async () => {
    const w = await templateWorld(testDb().db, 'freeze');
    const { flow } = await w.threeStepFlow();
    const rule = await w.scoreRule({ minScore: 1, maxScore: 5, allowUnable: false });
    const grade = await w.moduleGrade();
    const t = await w.template(
      templateBody(w.orgId, {
        flowId: flow.id,
        modules: [indicatorModule(rule.id, { name: '业绩', moduleGradeId: grade.id })],
      }),
    );
    const frozen = (await w.read(t.id, '?version=1')).body;
    expect(frozen.modules[0]).toMatchObject({
      ruleSnapshot: { kind: 'numeric', min: 1, max: 5, allowUnable: false },
    });
    expect(frozen.modules[0]!.gradeSnapshot!.items.map((i) => [i.name, i.minScore])).toEqual([
      ['档1', 0],
      ['档2', 2],
      ['档3', 4],
    ]);

    const ruleRead = (await (await w.trRequest('GET', `/score-rules/${rule.id}`)).json()) as { revision: number };
    expect(
      (
        await w.trRequest('PATCH', `/score-rules/${rule.id}`, {
          ifMatch: ruleRead.revision,
          body: { minScore: 0, maxScore: 10, allowUnable: true },
        })
      ).status,
    ).toBe(200);
    const gradeRead = (await (await w.trRequest('GET', `/module-grades/${grade.id}`)).json()) as { revision: number };
    expect(
      (
        await w.trRequest('PATCH', `/module-grades/${grade.id}`, {
          ifMatch: gradeRead.revision,
          body: { items: [{ name: '全部', value: 'ALL', minScore: 0, maxScore: 10 }] },
        })
      ).status,
    ).toBe(200);

    // 已保存的版本读回不变
    expect((await w.read(t.id, '?version=1')).body.modules).toEqual(frozen.modules.map((m) => ({ ...m })));
    expect((await w.read(t.id)).body.modules[0]).toMatchObject({
      ruleSnapshot: { min: 1, max: 5, allowUnable: false },
    });

    // 再次保存结构：新版本取到新内容，旧版本仍是旧内容
    const current = (await w.read(t.id)).body;
    const v2 = (await (
      await w.patch(current, { modules: [indicatorModule(rule.id, { name: '业绩', moduleGradeId: grade.id })] })
    ).json()) as TemplateView;
    expect(v2.versionNo).toBe(2);
    expect(v2.modules[0]).toMatchObject({ ruleSnapshot: { min: 0, max: 10, allowUnable: true } });
    expect(v2.modules[0]!.gradeSnapshot!.items.map((i) => i.name)).toEqual(['全部']);
    expect((await w.read(t.id, '?version=1')).body.modules[0]).toMatchObject({
      ruleSnapshot: { min: 1, max: 5, allowUnable: false },
    });
  });
});
