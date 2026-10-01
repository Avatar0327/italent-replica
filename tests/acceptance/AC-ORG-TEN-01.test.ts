import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgSession, resultRows } from './AC-ORG-support.js';

const testDb = useTestDb();

describe('AC-TEN-01 R1-T03 真实组织表的租户隔离', () => {
  it('真实 org_objects 由 RLS 裁剪，两个租户同名组织仅各自可读', async () => {
    const { db } = testDb();
    const a = await orgSession(db, 'orgten1a');
    const b = await orgSession(db, 'orgten1b');
    const orgA = await a.create('同名研发中心');
    const orgB = await b.create('同名研发中心');
    for (const [session, own, foreign] of [
      [a, orgA, orgB],
      [b, orgB, orgA],
    ] as const) {
      const raw = await withTenant(db, session.tenant.id, (tx) =>
        tx.execute(sql`SELECT id, tenant_id FROM org_objects WHERE id IN (${own.id}, ${foreign.id})`),
      );
      const rows = resultRows<{ id: string; tenant_id: string }>(raw);
      expect(rows).toEqual([{ id: own.id, tenant_id: session.tenant.id }]);
      const listed = await session.list('同名研发中心');
      expect(listed.map((item) => [item.id, item.tenantId])).toEqual([[own.id, session.tenant.id]]);
      const forbiddenWrite = await session.request('PATCH', `/organizations/${foreign.id}`, {
        ifMatch: foreign.revision,
        body: { name: '不得跨租户修改', effectiveDate: '2026-10-01' },
      });
      expect([403, 404]).toContain(forbiddenWrite.status);
    }
  });
});
