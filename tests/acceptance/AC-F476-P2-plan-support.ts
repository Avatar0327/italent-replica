/**
 * F-476 P2 第 5 轮夹具：在大子树上调编制汇总（batchLocalSums），按原顺序 EXPLAIN ANALYZE 重放它发出的全部 SQL
 * （含它自设、自还原的规划参数），数执行计划实际处理的行数。行数与机器快慢无关，可直接判断是否随子树平方增长。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { expect } from 'vitest';
import { batchLocalSums } from '../../apps/api/src/modules/establishment/capacity-read.js';
import { loadPreviewInput } from '../../apps/api/src/modules/org-adjustment/preview-input.js';
import { flowWorld } from './AC-OA-approval-support.js';
import { localCapacity, seedChildren } from './AC-F476-P2-support.js';
import { resultRows } from './AC-ORG-people-support.js';

type SQL = ReturnType<typeof sql>;
type Db = Parameters<typeof flowWorld>[0];

const AS_OF = '2026-11-01';
export const PLAN_TABLES = [
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

/** 截下 batchLocalSums 发出的全部 SQL。 */
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

/** 关掉相关表的 autovacuum：统计信息只在测试显式 ANALYZE 时出现。 */
export async function freezeStats(db: Db) {
  for (const table of PLAN_TABLES) await db.execute(sql.raw(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`));
}

/**
 * 根组织下铺 count 个直属下级，根挂本级 5、第一个下级挂本级 7（同方案同期间），按需 ANALYZE，然后调汇总。
 * 返回根的汇总值与执行计划处理的行数；同时核对汇总后同一事务的规划参数已还原。
 */
export async function plannedSum(db: Db, name: string, count: number, analyze: boolean) {
  const w = await flowWorld(db, name);
  const [first] = await seedChildren(w, w.a, count, { keep: 1 });
  const scheme = await localCapacity(w, w.a, 5);
  await localCapacity(w, first!, 7, scheme);
  if (analyze) await db.execute(sql.raw(`ANALYZE ${PLAN_TABLES.join(', ')}`));

  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [root] = resultRows<{ id: string; orgId: string; schemeId: string; periodStart: string }>(
      await tx.execute(sql`SELECT id::text, org_id::text AS "orgId", scheme_id::text AS "schemeId",
        period_start::text AS "periodStart" FROM establishment_objects WHERE org_id = ${w.a}::uuid`),
    );
    const seqscan = async () =>
      resultRows<{ v: string }>(await tx.execute(sql`SELECT current_setting('enable_seqscan') AS v`))[0]!.v;
    const before = await seqscan();
    const captured: SQL[] = [];
    const sums = await batchLocalSums(capturing(tx, captured), w.tenant.id, [root!], AS_OF);
    // 汇总之后同一事务里的其他查询照常规划
    expect(await seqscan()).toBe(before);

    let touched = 0;
    for (const query of captured) {
      const [explained] = resultRows<{ 'QUERY PLAN': unknown }>(
        await tx.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`),
      );
      const raw = explained!['QUERY PLAN'];
      const [plan] = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];
      touched += rowsTouched(plan!.Plan);
    }
    return { total: sums.get(root!.id), touched };
  });
}

/** 当前事务里各表、各索引实际读到的行数（顺序扫描读的行 + 索引返回的条目 + 按索引取回的行）。 */
async function xactTuplesRead(tx: Tx): Promise<number> {
  const [row] = resultRows<{ n: string }>(
    await tx.execute(sql`SELECT coalesce(sum(coalesce(pg_stat_get_xact_tuples_returned(c.oid), 0)
        + coalesce(pg_stat_get_xact_tuples_fetched(c.oid), 0)), 0)::text AS n
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'i')`),
  );
  return Number(row!.n);
}

/**
 * 读调整范围（根组织）的预览输入（组织快照、全称路径、编制汇总、负责人姓名，办理冻结与现值预览共用），
 * 返回读取结果与这一次实际读到的行数。整段 SQL 由产品代码发出，计数取自同一事务的表级统计，与机器快慢无关。
 */
export async function previewInputTouched(w: Awaited<ReturnType<typeof flowWorld>>) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const before = await xactTuplesRead(tx);
    const input = await loadPreviewInput(tx, w.tenant.id, AS_OF, [w.a], [], 'freeze');
    return { input, touched: (await xactTuplesRead(tx)) - before };
  });
}
