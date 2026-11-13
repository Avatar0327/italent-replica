/**
 * AC-F476-12 / 01（P2 第 6 轮）：预览输入（组织快照、全称路径、编制汇总）在“无统计、偏斜统计、准确统计”三种状态下
 * 都随子树线性。CI 实测（第 5 轮后仍超时）的偏斜状态是：autovacuum 在前一个用例造完数后分析过，统计里只有那个租户；
 * 下一个用例新建租户批量造数后马上读，新租户不在高频值里，规划器把“本租户的行”估成 1 行，所有以租户开头的索引
 * 代价打平，于是按版本 ID / 组织 ID 的连接只用租户列做索引条件、其余靠过滤，每一行重扫整个租户（N²）。
 * 生产上批量导入新租户后、下一次自动分析之前同样如此。表级读行计数取自同一事务，与机器快慢无关。
 * 本文件独占一个库并关掉相关表的 autovacuum，统计只在测试显式 ANALYZE 时变化。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { localCapacity, seedChildren } from './AC-F476-P2-support.js';
import { freezeStats, PLAN_TABLES, previewInputTouched } from './AC-F476-P2-plan-support.js';

const testDb = useTestDb();
const CHILDREN = 1999; // 连同范围组织共 2000 个节点：恰在预览上限内（DEC-728），办理份照常冻结整棵树

async function world(name: string) {
  const w = await flowWorld(testDb().db, name);
  const [first] = await seedChildren(w, w.a, CHILDREN, { keep: 1 });
  const scheme = await localCapacity(w, w.a, 5);
  await localCapacity(w, first!, 7, scheme);
  return w;
}

async function expectLinear(w: Awaited<ReturnType<typeof world>>) {
  const { input, touched } = await previewInputTouched(w);
  expect(input.kind).toBe('tree');
  if (input.kind !== 'tree') return;
  expect(input.orgs).toHaveLength(CHILDREN + 1);
  expect(input.orgs.find((org) => org.id === w.a)?.establishment).toBe(12); // 本级 5 + 下级 7：行为不变
  // 线性写法每个节点读十来行；退化的计划每个节点重扫整个租户（约 3 × N² 行）
  expect(touched).toBeLessThan(CHILDREN * 50);
}

const analyze = () => testDb().db.execute(sql.raw(`ANALYZE ${PLAN_TABLES.join(', ')}`));

describe('AC-F476-12 预览输入在三种统计状态下都随子树线性', () => {
  it('无统计 → 只统计了旧租户时读新租户 → 准确统计', { timeout: 600_000 }, async () => {
    await freezeStats(testDb().db);
    const old = await world('f476p2-stats-old');
    await expectLinear(old); // 无统计
    await analyze();
    const fresh = await world('f476p2-stats-new');
    await expectLinear(fresh); // 统计只有旧租户：新租户被估成 1 行
    await analyze();
    await expectLinear(fresh); // 准确统计
  });
});
