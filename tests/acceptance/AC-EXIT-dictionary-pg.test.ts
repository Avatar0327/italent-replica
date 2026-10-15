/**
 * R2-T03 B1a 真 PG 交错（设计 §18 B1a 行）：同一字典、同编码（大小写不同）的两次新增并发提交，恰一条 201、另一条 409
 * EXIT_DICTIONARY_CODE_TAKEN，不出现 500，库中一行、审计一条（上限用例在 AC-DM-19 里，PGlite 与真 PG 都跑）。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitWorld } from './AC-EXIT-support.js';

const testDb = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-dictionary-pg 同编码并发新增', () => {
  it('两条并发新增恰一条成功，另一条 409，库中一行、审计一条', async () => {
    const w = await exitWorld(testDb().db, 'dict-pg');
    for (let round = 0; round < 5; round += 1) {
      const code = `race_${round}`;
      const responses = await Promise.all([
        w.add('types', { code, name: `并发甲${round}` }),
        w.add('types', { code: code.toUpperCase(), name: `并发乙${round}` }),
      ]);
      const texts = await Promise.all(responses.map((r) => r.clone().text()));
      expect(responses.map((r) => r.status).sort(), String(texts)).toEqual([201, 409]);
      expect(texts.join()).toContain('EXIT_DICTIONARY_CODE_TAKEN');
      // 恰一行、恰一条审计：否则除零，把计数不对变成错误文本
      const exact = sql`SELECT 1 / (SELECT (count(*) = 1)::int FROM exit_types t
        JOIN audit_events a ON a.object_id = t.id::text
        WHERE t.tenant_id = ${w.tenant.id} AND lower(t.code) = ${code})`;
      expect(await w.attempt(exact)).toBeUndefined();
    }
  });
});
