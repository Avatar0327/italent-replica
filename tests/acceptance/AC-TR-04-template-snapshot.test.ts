/**
 * R3-T04 PR-B6a 第 2 轮审查 P2-03（PR #244）：计分方式校验必须基于“最终保存的快照”，而不是源模块等级的实时口径。
 * 带模块 ID 且引用没换时沿用原冻结快照（DEC-425①），源模块等级之后改了口径（得分区间 ↔ 按指标数目）不应让只改名的保存失败，
 * 也不能保存出“按指标数目计算但快照只有得分区间”之类的不一致配置：
 * - 只改名（两个方向）→ 200，沿用原快照；
 * - 改名 + 切换计分方式 → 改取新快照后再校验：新快照口径与新计分方式一致才 200，快照与计分方式始终一致。
 * 同类出口：评价规则的类型建后不可改，字段 / 人才标准没有快照（只保存引用），不存在“先校验实时对象、后替换快照”的顺序问题。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { indicatorModule, reasonOf, templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';

const testDb = useTestDb();

const SCORE_ITEMS = [
  { name: '低', value: 'L', minScore: 0, maxScore: 5 },
  { name: '高', value: 'H', minScore: 5, maxScore: 10 },
];
const COUNT_ITEMS = [
  { name: '多', value: 'M', minCount: 5 },
  { name: '少', value: 'S', minCount: 1 },
];

async function setup(label: string, mode: 'score' | 'count') {
  const w = await templateWorld(testDb().db, label);
  const { flow } = await w.threeStepFlow();
  const rule = await w.gradeRule();
  const grade = await w.moduleGrade({ items: mode === 'score' ? SCORE_ITEMS : COUNT_ITEMS });
  const scoring = mode === 'score' ? 'weighted_sum' : 'by_count';
  const module = (extra: Record<string, unknown> = {}) =>
    indicatorModule(rule.id, { name: '甲', moduleGradeId: grade.id, scoring, ...extra });
  const t = await w.template(templateBody(w.orgId, { flowId: flow.id, modules: [module()] }));
  const changeGrade = async (items: object[]) => {
    const read = (await (await w.trRequest('GET', `/module-grades/${grade.id}`)).json()) as { revision: number };
    const response = await w.trRequest('PATCH', `/module-grades/${grade.id}`, {
      ifMatch: read.revision,
      body: { items },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  return { w, t, module, changeGrade, id: t.modules[0]!.id };
}
const items = (view: TemplateView) => view.modules[0]!.gradeSnapshot!.items;

describe('AC-TR-04-template P2-03 校验基于最终快照', () => {
  it('得分区间的模块，源等级改成按指标数目后只改名 → 200，沿用原得分区间快照', async () => {
    const { w, t, module, changeGrade, id } = await setup('tpl-snap-a', 'score');
    await changeGrade(COUNT_ITEMS);
    const response = await w.patch(t, { modules: [module({ id, name: '甲改' })] });
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as TemplateView;
    expect(items(view).map((i) => [i.minScore, i.minCount])).toEqual([
      [0, null],
      [5, null],
    ]);
  });

  it('按指标数目的模块，源等级改成得分区间后只改名 → 200，沿用原按指标数目快照', async () => {
    const { w, t, module, changeGrade, id } = await setup('tpl-snap-b', 'count');
    await changeGrade(SCORE_ITEMS);
    const response = await w.patch(t, { modules: [module({ id, name: '甲改' })] });
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as TemplateView;
    expect(items(view).map((i) => [i.minScore, i.minCount])).toEqual([
      [null, 5],
      [null, 1],
    ]);
  });

  it('得分区间的模块，源等级已改成按指标数目，改名 + 改为按指标数目计算 → 改取新快照再校验，快照与计分方式一致', async () => {
    const { w, t, module, changeGrade, id } = await setup('tpl-snap-c', 'score');
    await changeGrade(COUNT_ITEMS);
    const response = await w.patch(t, { modules: [module({ id, name: '甲改', scoring: 'by_count' })] });
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as TemplateView;
    expect(view.modules[0]).toMatchObject({ name: '甲改', scoring: 'by_count' });
    expect(items(view).map((i) => [i.minScore, i.minCount])).toEqual([
      [null, 5],
      [null, 1],
    ]);
  });

  it('按指标数目的模块，源等级已改成得分区间，改名 + 改为加权求和 → 改取新快照再校验，快照与计分方式一致', async () => {
    const { w, t, module, changeGrade, id } = await setup('tpl-snap-d', 'count');
    await changeGrade(SCORE_ITEMS);
    const response = await w.patch(t, { modules: [module({ id, name: '甲改', scoring: 'weighted_sum' })] });
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as TemplateView;
    expect(view.modules[0]).toMatchObject({ name: '甲改', scoring: 'weighted_sum' });
    expect(items(view).map((i) => [i.minScore, i.minCount])).toEqual([
      [0, null],
      [5, null],
    ]);
  });

  it('对照：源等级口径与新计分方式不一致时仍然拒绝（得分区间的源等级 + 改为按指标数目 → 400 MODULE_BY_COUNT_GRADE），数据不变', async () => {
    const { w, t, module, id } = await setup('tpl-snap-e', 'score');
    const response = await w.patch(t, { modules: [module({ id, name: '甲改', scoring: 'by_count' })] });
    expect([response.status, await reasonOf(response)]).toEqual([400, 'MODULE_BY_COUNT_GRADE']);
    expect((await w.read(t.id)).body).toEqual(t);
  });
});
