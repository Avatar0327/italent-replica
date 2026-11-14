/**
 * AC-F476-12 / 01（P2 第 5 轮）：批量造数（或批量导入）后、统计信息还没收集时，编制汇总的递归查询不得退化成
 * 子树规模的平方。CI 的 PG 分片每次从空库起，autovacuum 来不及分析：旧写法里规划器把层级链接估成 1 行，
 * 递归每一步都用嵌套循环把整张工作表、整份「组织现行版本」重扫一遍，1 万个下级要扫约 1 亿行（本机 54 s，CI 超时）。
 * 本测试关掉相关表的 autovacuum、不做 ANALYZE，用 EXPLAIN ANALYZE 数执行计划实际处理的行数，与机器快慢无关。
 * 统计信息齐全但分布偏斜的情形见 AC-F476-P2-14-budget-plan-stats（须独占一个库，见该文件说明）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { freezeStats, plannedSum } from './AC-F476-P2-plan-support.js';

const testDb = useTestDb();
const CHILDREN = 2000;

describe('AC-F476-12 编制汇总在无统计信息时也随子树线性', () => {
  it(`${CHILDREN} 个下级、未 ANALYZE：汇总结果正确，执行计划处理的行数不超过节点数的 50 倍`, async () => {
    const db = testDb().db;
    await freezeStats(db);
    const { total, touched } = await plannedSum(db, 'f476p2-budget-plan', CHILDREN, false);
    expect(total).toBe(12); // 本级 5 + 下级 7：行为不变
    // 线性写法约十几倍节点数；旧写法每一步重扫整张工作表与整份现行版本（PG16 实测 4021 万行，约 10 × N²）
    expect(touched).toBeLessThan(CHILDREN * 50);
  });
});
