/**
 * AC-ESIGN-F505-18（S1 部分，第 1 轮返工 P2-1）：待入职行内编辑只改试用期（日期与雇佣关系不变）也是来源变化，
 * 须在同一事务内发 changed 事件（设计 §6.2）。经真实 PATCH /employment/pending-entries/:id 验证：
 * 变化发一次、不变不发；订阅者抛错时试用期、revision、审计一起回滚。
 */
import type { ESignSourceEvent } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerEntrySourceEvents,
  resetEntrySourceEventsForTest,
} from '../../apps/api/src/modules/employment/entry-source-events.js';
import { addPending, businessRevision, entryWorld, type EntryWorld } from './AC-EN-BE2a-support.js';

const testDb = useTestDb();
const seen: ESignSourceEvent[] = [];

afterEach(() => {
  seen.length = 0;
  resetEntrySourceEventsForTest();
});

const rows = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows);

async function probationState(w: EntryWorld, id: string) {
  const items = await w.session.request('GET', '/pending-entries?view=all');
  const found = ((await items.json()) as { items: { id: string; probation: boolean | null }[] }).items.find(
    (item) => item.id === id,
  );
  return { probation: found?.probation, revision: await businessRevision(w, id) };
}

async function auditCount(w: EntryWorld, id: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const found = rows(
      await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
        WHERE tenant_id=${w.session.tenant.id} AND action='employment.entry.edit' AND object_id=${id}`),
    ) as { n: number }[];
    return found[0]!.n;
  });
}

async function editProbation(w: EntryWorld, id: string, probation: boolean) {
  return w.session.request('PATCH', `/pending-entries/${id}`, {
    ifMatch: await businessRevision(w, id),
    body: { effectiveDate: '2026-10-10', probation },
  });
}

describe('AC-ESIGN-F505-18 待入职只改试用期', () => {
  it('试用期实际变化发一次 changed（同 ID、事件后 revision）；值不变不发', async () => {
    const w = await entryWorld(testDb().db, 'f505-probation');
    const { recordId } = await addPending(w, '2026-10-10');
    registerEntrySourceEvents('recorder', async (_tx, _ctx, event) => void seen.push(event));

    const first = await editProbation(w, recordId, true);
    expect(first.status, await first.clone().text()).toBe(200);
    const afterFirst = await probationState(w, recordId);
    expect(seen).toEqual([{ source: 'entry', sourceId: recordId, change: 'changed', revision: afterFirst.revision }]);

    seen.length = 0;
    const same = await editProbation(w, recordId, true);
    expect(same.status, await same.clone().text()).toBe(200);
    expect(seen, '试用期值没变，不是来源变化').toEqual([]);

    const back = await editProbation(w, recordId, false);
    expect(back.status, await back.clone().text()).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sourceId: recordId, change: 'changed' });
  });

  it('订阅者抛错：试用期、revision、审计一起回滚', async () => {
    const w = await entryWorld(testDb().db, 'f505-probation-rollback');
    const { recordId } = await addPending(w, '2026-10-10');
    const ok = await editProbation(w, recordId, true);
    expect(ok.status, await ok.clone().text()).toBe(200);
    const before = await probationState(w, recordId);
    const auditBefore = await auditCount(w, recordId);
    registerEntrySourceEvents('boom', async () => {
      throw new Error('订阅方不可用');
    });

    const failed = await editProbation(w, recordId, false);
    expect(failed.status, '订阅者抛错须使整笔写入失败').toBeGreaterThanOrEqual(500);
    expect(await probationState(w, recordId)).toEqual(before);
    expect(await auditCount(w, recordId)).toBe(auditBefore);
  });
});
