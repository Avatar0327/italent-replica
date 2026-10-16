/**
 * BE-2a 失效删除待入职端口（F-171 / DEC-529，交 BE-14 在 Offer 失效时调用）：领域端口层测试，与 HTTP 层分开。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { deletePendingEntry } from '../../apps/api/src/modules/employment/entry-actions.js';
import {
  addPending,
  businessRevision,
  entryAction,
  entryRecords,
  entryWorld,
  portContext,
} from './AC-EN-BE2a-support.js';

const testDb = useTestDb();

describe('BE-2a 失效删除待入职端口', () => {
  it('同一删除内核：待入职可删，已入职拒绝', async () => {
    const w = await entryWorld(testDb().db, 'be2a-delete-port');
    const pending = await addPending(w, '2026-10-10', '失效待入职');
    const hired = await addPending(w, '2026-09-01', '失效已入职');
    await entryAction(w, hired.recordId, 'complete', { probation: false });
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      deletePendingEntry(tx, portContext(w, pending.business.revision), pending.recordId),
    );
    expect(await entryRecords(w, pending.employee.id)).toEqual([]);
    const hiredRevision = await businessRevision(w, hired.recordId);
    await expect(
      withTenant(w.db, w.session.tenant.id, (tx) =>
        deletePendingEntry(tx, portContext(w, hiredRevision), hired.recordId),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'NOT_PENDING_ENTRY' } });
  });
});
