import { sql, withTenant } from '@italent/db';
import { codeOf } from '../../apps/api/src/modules/succession/access.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { levelBody, levelKinds, levelsWorld } from './AC-SC-levels-support.js';

const testDb = useTestDb();
describe('AC-SC B2b P2-1 按实际内容推进等级与集合版本', () => {
  it.each(levelKinds.flatMap((kind) => ['save', 'same-order', 'swap'].map((operation) => ({ kind, operation }))))(
    'AC-SC $kind：$operation 后未变化等级仍可按已打开的版本编辑',
    async ({ kind, operation }) => {
      const w = await levelsWorld(testDb().db);
      const body = levelBody(kind);
      const a = await w.createLevel(kind, body);
      const b = await w.createLevel(kind);
      const c = await w.createLevel(kind);
      const before = await w.list(kind);
      const auditCount = () =>
        withTenant(w.db, w.tenant.id, async (tx) => {
          const [count] = rowsOf<{ n: number }>(
            await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
          WHERE tenant_id = ${w.tenant.id}::uuid
            AND object_type = ${codeOf(kind === 'risk' ? 'riskLevel' : 'healthLevel')}`),
          );
          return count!.n;
        });
      const audits = await auditCount();
      let response: Response;
      if (operation === 'save') {
        response = await w.request('PUT', `/${kind}-levels/${a.id}`, {
          ifMatch: 1,
          body: {
            name: body.name,
            color: '#AABBCC',
            rules: {
              expression: body.rules.expression,
              rows: body.rules.rows.map((row) => Object.fromEntries(Object.entries(row).reverse())),
            },
          },
        });
      } else {
        const ids = operation === 'swap' ? [b.id, a.id, c.id] : before.items.map((item) => item.id);
        response = await w.request('PUT', `/${kind}-levels/order`, {
          ifMatch: before.collectionRevision,
          body: { ids },
        });
      }
      expect(response.status, await response.clone().text()).toBe(200);
      const after = await w.list(kind);
      expect(after.collectionRevision).toBe(before.collectionRevision + (operation === 'swap' ? 1 : 0));
      expect(Object.fromEntries(after.items.map((item) => [item.id, item.revision]))).toEqual({
        [a.id]: operation === 'swap' ? 2 : 1,
        [b.id]: operation === 'swap' ? 2 : 1,
        [c.id]: 1,
      });
      expect(after.items.map((item) => item.id)).toEqual(
        operation === 'swap' ? [b.id, a.id, c.id] : before.items.map((item) => item.id),
      );
      expect(await auditCount()).toBe(audits + (operation === 'swap' ? 2 : 0));
      const unchanged = operation === 'save' ? a : c;
      const edited = await w.request('PUT', `/${kind}-levels/${unchanged.id}`, {
        ifMatch: 1,
        body: { color: '#010203' },
      });
      expect(edited.status, await edited.clone().text()).toBe(200);
      expect(await edited.json()).toMatchObject({ id: unchanged.id, color: '#010203', revision: 2 });
    },
  );
});
