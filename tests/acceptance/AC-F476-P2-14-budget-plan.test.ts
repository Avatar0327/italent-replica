/**
 * AC-F476-12 / 01（P2 第 5 轮）：批量造数（或批量导入）后、统计信息还没收集时，编制汇总的递归查询不得退化成
 * 子树规模的平方。CI 的 PG 分片每次从空库起，autovacuum 来不及分析：旧写法里规划器把层级链接估成 1 行，
 * 递归每一步都用嵌套循环把整张工作表、整份「组织现行版本」重扫一遍，1 万个下级要扫约 1 亿行（本机 54 s，CI 超时）。
 * 本测试关掉相关表的 autovacuum、不做 ANALYZE，用 EXPLAIN ANALYZE 数执行计划实际处理的行数，与机器快慢无关。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { batchLocalSums } from '../../apps/api/src/modules/establishment/capacity-read.js';
import { flowWorld } from './AC-OA-approval-support.js';
import { localCapacity, seedChildren } from './AC-F476-P2-support.js';
import { resultRows } from './AC-ORG-people-support.js';

type SQL = ReturnType<typeof sql>;

const testDb = useTestDb();
const CHILDREN = 2000;
const AS_OF = '2026-11-01';
const TABLES = [
  'org_objects',
  'org_versions',
  'org_hierarchy_links',
  'establishment_objects',
  'establishment_versions',
];

interface PlanNode {
  readonly 'Actual Rows'?: number;
  readonly 'Actual Loops'?: number;
  readonly 'Rows Removed by Filter'?: number;
  readonly 'Rows Removed by Join Filter'?: number;
  readonly Plans?: readonly PlanNode[];
}

/** 执行计划各节点实际产出与过滤掉的行数之和（每个节点按循环次数计）。 */
function rowsTouched(node: PlanNode): number {
  const loops = node['Actual Loops'] ?? 1;
  const own =
    (node['Actual Rows'] ?? 0) * loops +
    (node['Rows Removed by Filter'] ?? 0) * loops +
    (node['Rows Removed by Join Filter'] ?? 0) * loops;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + rowsTouched(child), 0);
}

/** 截下 batchLocalSums 发出的那条 SQL，原样拿去 EXPLAIN。 */
function capturing(tx: Tx, captured: SQL[]): Tx {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop !== 'execute') return Reflect.get(target, prop, receiver);
      return (query: SQL) => {
        captured.push(query);
        return target.execute(query);
      };
    },
  });
}

describe('AC-F476-12 编制汇总在无统计信息时也随子树线性', () => {
  it(`${CHILDREN} 个下级、未 ANALYZE：汇总结果正确，执行计划处理的行数不超过节点数的 50 倍`, async () => {
    const db = testDb().db;
    for (const table of TABLES) await db.execute(sql.raw(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`));
    const w = await flowWorld(db, 'f476p2-budget-plan');
    const [first] = await seedChildren(w, w.a, CHILDREN, { keep: 1 });
    const scheme = await localCapacity(w, w.a, 5);
    await localCapacity(w, first!, 7, scheme);

    await withTenant(w.db, w.tenant.id, async (tx) => {
      const [root] = resultRows<{ id: string; orgId: string; schemeId: string; periodStart: string }>(
        await tx.execute(sql`SELECT id::text, org_id::text AS "orgId", scheme_id::text AS "schemeId",
          period_start::text AS "periodStart" FROM establishment_objects WHERE org_id = ${w.a}::uuid`),
      );
      const captured: SQL[] = [];
      const sums = await batchLocalSums(capturing(tx, captured), w.tenant.id, [root!], AS_OF);
      expect(sums.get(root!.id)).toBe(12); // 本级 5 + 下级 7：行为不变
      expect(captured).toHaveLength(1);

      const [explained] = resultRows<{ 'QUERY PLAN': unknown }>(
        await tx.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${captured[0]!}`),
      );
      const raw = explained!['QUERY PLAN'];
      const [plan] = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];
      // 线性写法约十几倍节点数；旧写法每一步重扫整张工作表与整份现行版本（PG16 实测 4021 万行，约 10 × N²）
      expect(rowsTouched(plan!.Plan)).toBeLessThan(CHILDREN * 50);
    });
  });
});
