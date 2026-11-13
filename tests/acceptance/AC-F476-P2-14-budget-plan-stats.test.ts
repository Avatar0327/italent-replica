/**
 * AC-F476-12 / 01（P2 第 5 轮）：统计信息齐全、但分布偏斜（一个上级挂上万个直属下级）时，编制汇总同样不得随子树
 * 平方增长。ANALYZE 后规划器按“上级取值只有寥寥几个”估算每个上级约有半张表的下级，逐步查下级时会改选顺序扫描，
 * 递归每一步滤掉整张链接表，1 万个下级约 1 亿行（本轮 10,002 节点用例实测 7 s）。
 * 本文件独占一个库：库里上级取值越多，规划器估得越少、越倾向索引，与其他用例同库就测不出这一退化。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { freezeStats, plannedSum } from './AC-F476-P2-plan-support.js';

const testDb = useTestDb();
const CHILDREN = 10_000;

describe('AC-F476-12 编制汇总在统计信息偏斜时也随子树线性', () => {
  it(`${CHILDREN} 个下级挂在同一上级、已 ANALYZE：汇总结果正确，执行计划处理的行数不超过节点数的 50 倍`, async () => {
    const db = testDb().db;
    await freezeStats(db);
    const { total, touched } = await plannedSum(db, 'f476p2-budget-plan-stats', CHILDREN, true);
    expect(total).toBe(12); // 本级 5 + 下级 7：行为不变
    // 逐步顺序扫描时每一步都滤掉整张链接表，约 N² 行
    expect(touched).toBeLessThan(CHILDREN * 50);
  });
});
