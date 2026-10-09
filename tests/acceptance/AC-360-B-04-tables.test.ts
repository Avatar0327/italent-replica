/**
 * R3-T03 PR-B 结果报表（`25` §7 实例、§10.1 ⑰、§10.3 ⑱⑲）：
 * - 关键行为类：总分 / 复合指标 / 基础指标 / 题目得分清单，按角色分列（自评、各角色、他评），保留 4 位小数；
 * - 没有有效数据的角色整列消失，不加“已屏蔽 / 未作答”标记；单人角色照常单列（DEC-149）；
 * - 读最新计分批次：重算前仍是旧结果；“下载”是前端截图，后端没有数据导出接口。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { key, sceneB, type SceneB, sheets } from './AC-360-B-support.js';

const testDb = useTestDb();

interface Table {
  level: string;
  columns: { scope: 'self' | 'role' | 'other'; roleId?: string; roleName?: string }[];
  items: {
    objectId: string;
    objectName: string;
    questionnaireName: string;
    itemName: string | null;
    values: (number | null)[];
  }[];
}

const table = (s: SceneB, level: string) => s.w.ok<Table>(s.w.request('GET', `${s.path}/score-tables?level=${level}`));
const header = (t: Table) => t.columns.map((c) => (c.scope === 'role' ? c.roleName : c.scope));

describe('PR-B 结果报表', () => {
  it('四种清单按角色分列、4 位小数；单人角色单列', async () => {
    const s = await sceneB(testDb().db, 'b04a');
    await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4']);
    await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v4', 'v5']);
    await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v4.3', 'v5']);
    expect((await table(s, 'questionnaire')).items).toEqual([]);
    await s.w.transition(s.activity.id, 'disable');

    const total = await table(s, 'questionnaire');
    expect(header(total)).toEqual(['self', '上级', '同事', 'other']);
    expect(total.items).toHaveLength(1);
    expect(total.items[0]!).toMatchObject({ objectName: '评价对象', itemName: null });
    // 自评 (4.5+4)/2=4.25；上级 (3.5+5)/2=4.25；同事 (4.15+5)/2=4.575；他评 (4.25×5+4.575×3)/8=4.371875
    expect(total.items[0]!.values).toEqual([4.25, 4.25, 4.575, 4.3719]);

    const composite = await table(s, 'composite');
    expect(composite.items.map((i) => i.itemName)).toEqual(['协作能力']);
    const basic = await table(s, 'basic');
    expect(basic.items.map((i) => i.itemName)).toEqual(['沟通', '支持']);
    const questions = await table(s, 'question');
    expect(questions.items.map((i) => i.itemName)).toEqual(['主动沟通', '倾听反馈', '协作支持']);
    expect(questions.items[1]!.values).toEqual([4, 4, 4.3, 4.1125]);
    const bad = await s.w.request('GET', `${s.path}/score-tables?level=team`);
    expect(bad.status).toBe(400);
  });

  it('唯一的同事被屏蔽、另一位未提交：重算后同事整列消失；重算前仍是旧结果', async () => {
    const s = await sceneB(testDb().db, 'b04b');
    await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4']);
    await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v4', 'v4']);
    await s.answerAs(s.person.P2.id, s.rel.p2.id, ['v2', 'v2', 'v2'], { submit: false });
    await s.w.transition(s.activity.id, 'disable');
    expect(header(await table(s, 'questionnaire'))).toEqual(['self', '同事', 'other']);
    const peer = (await sheets(s)).find((c) => c.role.name === '同事')!;
    await s.w.ok(s.w.request('POST', `${s.path}/sheets/${peer.id}/block`, { ifMatch: peer.revision }));
    expect(header(await table(s, 'questionnaire'))).toEqual(['self', '同事', 'other']);
    await s.w.transition(s.activity.id, 'enable');
    await s.w.transition(s.activity.id, 'disable');
    const after = await table(s, 'questionnaire');
    expect(header(after)).toEqual(['self']);
    expect(after.items[0]!.values).toEqual([4.25]);
    expect(JSON.stringify(after)).not.toMatch(/屏蔽|未作答/);
    // 没有数据导出接口（“下载”是前端截图）
    const exported = await s.w.request('POST', `${s.path}/score-tables/export`, { idempotencyKey: key(), body: {} });
    expect(exported.status).toBe(404);
  });
});
