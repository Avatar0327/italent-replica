/**
 * R2-T03 B1a 真 PG 交错（设计 §18 B1a 行）：同一租户同一字典、同编码（大小写不同）的两次新增并发提交，恰一条成功（201），
 * 另一条 409 EXIT_DICTIONARY_CODE_TAKEN；不出现 500，库里只有一行、审计只有一条。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import { and, auditEvents, eq, exitTypes, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitWorld } from './AC-EXIT-support.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();

describe.runIf(realPostgres)('AC-EXIT-dictionary-pg 同编码并发新增', () => {
  it('两条并发新增恰一条成功，另一条 409，库中一行、审计一条', async () => {
    const w = await exitWorld(testDb().db, 'dict-pg');
    for (let round = 0; round < 5; round += 1) {
      const code = `race_${round}`;
      const responses = await Promise.all([
        w.add('types', { code, name: `并发甲${round}` }),
        w.add('types', { code: code.toUpperCase(), name: `并发乙${round}` }),
      ]);
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses, await Promise.all(responses.map((r) => r.clone().text())).then(String)).toEqual([201, 409]);
      const loser = responses.find((r) => r.status === 409)!;
      expect(await loser.json()).toMatchObject({ error: { details: { reason: 'EXIT_DICTIONARY_CODE_TAKEN' } } });
      await withTenant(w.db, w.tenant.id, async (tx) => {
        const rows = await tx
          .select({ id: exitTypes.id })
          .from(exitTypes)
          .where(and(eq(exitTypes.tenantId, w.tenant.id), sql`lower(${exitTypes.code}) = ${code}`));
        expect(rows).toHaveLength(1);
        const audits = await tx
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, w.tenant.id), eq(auditEvents.objectId, rows[0]!.id)));
        expect(audits).toHaveLength(1);
      });
    }
  });
});
