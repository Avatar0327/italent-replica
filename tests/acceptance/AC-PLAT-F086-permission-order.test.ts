/**
 * F-086：CI 偶发失败 ① ②（AC-PLAT-F061-backfill T-01 / T-02，真 PG 分片）的复现与回归。
 * 原因：loadObjectPermissions 读字段 / 按钮没有 ORDER BY，行顺序取决于查询计划（顺序扫描 = 写入顺序，索引扫描 = 主键顺序）。
 * CI 里两次 stateOf 读取之间若 autovacuum / autoanalyze 改了计划，同一份数据的字段数组顺序就变了，toEqual 误报。
 * 这里在同一事务里强制两种计划读同一对象，断言夹具读出的权限一致（顺序无关）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { sql } from '@italent/db';
import { OBJ, permissionOf, provisionWorld } from './support/f061.js';

const testDb = useTestDb();

describe('AC-PLAT-F086 夹具读取权限与查询计划无关', () => {
  it('强制顺序扫描 / 强制索引扫描读同一对象：permissionOf 结果相等', async () => {
    const w = await provisionWorld(testDb().db, 'f086-order');
    // 一条语句一次 execute：PGlite 的预编译语句不接受多条命令。
    const seq = await permissionOf(w, 'standard_hr_admin', OBJ.objectCode, async (tx) => {
      await tx.execute(sql`SET LOCAL enable_indexscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    });
    const idx = await permissionOf(w, 'standard_hr_admin', OBJ.objectCode, (tx) =>
      tx.execute(sql`SET LOCAL enable_seqscan = off`),
    );
    expect(seq).toBeDefined();
    expect(idx).toEqual(seq);
  });
});
