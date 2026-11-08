/**
 * AC-DM-30-F493-28 ③（F-493 S1）：360 自动添加评价者按 (工号, id) 键集分页，跨过空工号不重不漏。
 * 页大小 100：131 名下级里 120 人有工号、后 10 人空工号 + 任职种子，翻页边界落在有工号 → 空工号之间。
 * 偏离说明：不把页大小改成 1，而是用真实页大小 100 造出跨边界的数据（不为测试改产品常量）。
 */
import { describe, expect, it } from 'vitest';
import { boundedScene, useBoundedDb } from './AC-360-F088-support.js';

const testDb = useBoundedDb();

interface Result {
  added: { appraiserPersonId: string; employeeId?: string }[];
  skipped: { employeeId: string; reason: string }[];
}

describe('AC-DM-30-F493-28 ③ 360 自动添加键集分页跨过空工号', () => {
  it('120 人有工号 + 10 人空工号 + 种子：全部下级各添加一次，没有重复也没有遗漏', async () => {
    const s = await boundedScene(testDb().db, 'f493s1keyset', 130, { nullCodeFrom: 120 });
    const result = await s.w.ok<Result>(s.auto({ roles: ['subordinate'], limits: { subordinate: 500 } }));
    expect(result.skipped).toEqual([]);
    const ids = result.added.map((r) => r.appraiserPersonId);
    expect(new Set(ids).size).toBe(ids.length);
    // 130 个克隆下级 + 任职种子本人
    expect(ids).toHaveLength(131);
    // 键集分页至少翻了两页（100 + 31），空工号员工出现在第二页
    expect(s.pages().length).toBeGreaterThanOrEqual(2);
    const paged = s.pages().flatMap((o) => o.ids);
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged).toHaveLength(131);
    for (let n = 121; n <= 130; n += 1) expect(paged).toContain(s.id(n));
  }, 300_000);
});
