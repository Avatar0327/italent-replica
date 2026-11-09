/**
 * AC-DM-30-F493-28 ③（F-493 S1）：360 自动添加评价者按 (工号, id) 键集分页，跨过空工号不重不漏。
 * 页大小 100：231 人（230 名下级 + 任职种子）里前 120 人有工号、后 110 人空工号：
 * 第 1 页（100）全有工号；第 2 页（100）跨过有工号 → 空工号边界，游标工号为空；
 * 第 3 页（31）从空工号游标继续，走 after.code === null 分支（只推进更大的 id）。
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
  it('120 人有工号 + 110 人空工号 + 种子：三页，全部下级各添加一次，没有重复也没有遗漏', async () => {
    const s = await boundedScene(testDb().db, 'f493s1keyset', 230, { nullCodeFrom: 120 });
    const result = await s.w.ok<Result>(s.auto({ roles: ['subordinate'], limits: { subordinate: 500 } }));
    expect(result.skipped).toEqual([]);
    const ids = result.added.map((r) => r.appraiserPersonId);
    expect(new Set(ids).size).toBe(ids.length);
    // 230 个克隆下级 + 任职种子本人
    expect(ids).toHaveLength(231);
    // 键集分页翻了三页（100 + 100 + 31），第三页的游标工号为空
    const pages = s.pages();
    expect(pages.map((o) => o.ids.length)).toEqual([100, 100, 31]);
    const paged = pages.flatMap((o) => o.ids);
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged).toHaveLength(231);
    for (let n = 1; n <= 230; n += 1) expect(paged).toContain(s.id(n));
  }, 300_000);
});
