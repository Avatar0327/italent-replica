/**
 * AC-DM-19 / F-174 P2-01：合法 Unicode 编码的选择与名称回显必须使用同一套数据库 lower 语义。
 * 经公开 HTTP 新增 İ，再分别与合并查询 i / İ；结果必须保留请求原文作为键。
 * PGlite 的 Unicode 折叠与 PG16 不同，故此专项只在真 PG 执行；PG 下不按折叠结果跳过。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import * as dictionaries from '../../apps/api/src/modules/employment/exit-dictionaries.js';
import { exitWorld } from './AC-EXIT-support.js';

const testDb = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-DM-19 F-174 Unicode 编码 PG 专项', () => {
  it.each([{ codes: ['i'] }, { codes: ['İ'] }, { codes: ['i', 'İ'] }])(
    '请求编码 $codes：选择通过且名称按请求原文返回',
    async ({ codes }) => {
      const w = await exitWorld(testDb().db, 'f174-unicode');
      const created = await w.added('types', { code: 'İ', name: '非 ASCII 离职类型' });
      expect(created.code).toBe('İ');
      await withTenant(w.db, w.tenant.id, async (tx) => {
        // 强制确认复现前提，防止数据库配置不同而让回归用例虚绿。
        const [folding] = await tx.select({ code: sql<string>`lower('İ')` }).from(sql`(values (1)) as probe(value)`);
        expect(folding!.code).toBe('i');
        for (const code of codes) {
          await expect(
            dictionaries.assertExitDictionaryEnabled(tx, w.tenant.id, 'types', code),
          ).resolves.toBeUndefined();
        }
        const names = await dictionaries.exitDictionaryNames(tx, w.tenant.id, 'types', codes);
        expect(Object.fromEntries(names)).toEqual(Object.fromEntries(codes.map((code) => [code, created.name])));
      });
    },
  );
});
