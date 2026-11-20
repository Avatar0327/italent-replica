/**
 * AC-ESIGN-F505-18（S1 部分，第 1 轮返工 P2-2）：职务 / 职位序列同步（真实同步队列）会直接追加待入职记录的业务内容，
 * 实际改变待入职记录的目标须在同事务内发 changed 事件（设计 §6.2）；无变化不发；订阅失败整单回滚。
 */
import type { ESignSourceEvent } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerEntrySourceEvents,
  resetEntrySourceEventsForTest,
} from '../../apps/api/src/modules/employment/entry-source-events.js';
import { addHire } from './AC-EN-BE2a-support.js';
import { scenario, versions, worker } from './AC-JOB-sequence-support.js';

const testDb = useTestDb();
const seen: ESignSourceEvent[] = [];

afterEach(() => {
  seen.length = 0;
  resetEntrySourceEventsForTest();
});

async function sequenceWorld() {
  const { db } = testDb();
  const s = await scenario(db, 'posts');
  const employee = await s.world.employee('待入职同步员工');
  const fields = {
    employType: 'internal',
    departmentId: s.org.id,
    postId: s.target.id,
    sequenceId: s.oldSequence.id,
  };
  const response = await addHire(s.world, employee, {
    kind: 'hire',
    mode: 'direct',
    effectiveDate: '2026-10-20',
    fields,
    pendingEntry: true,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const pending = (await response.json()) as { id: string; revision: number };
  const revision = async () => {
    const got = await s.world.request('GET', `/businesses/${pending.id}`);
    return ((await got.json()) as { revision: number }).revision;
  };
  return { db, s, employee, pending, revision };
}

describe('AC-ESIGN-F505-18 序列同步改待入职', () => {
  it('同步实际改了待入职记录：发一次 changed（旧 ID、更新后 revision）；无变化再同步不发', async () => {
    const { db, s, pending, revision } = await sequenceWorld();
    registerEntrySourceEvents('recorder', async (_tx, _ctx, event) => void seen.push(event));
    const patched = await s.call(
      'PATCH',
      `posts/${s.target.id}`,
      { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true },
      1,
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    await worker(db, s.world.tenant.id);
    expect(seen).toEqual([{ source: 'entry', sourceId: pending.id, change: 'changed', revision: await revision() }]);

    seen.length = 0;
    const again = await s.call('POST', 'posts/sync-sequence', { items: [{ id: s.target.id, revision: 2 }] });
    expect(again.status, await again.clone().text()).toBe(202);
    await worker(db, s.world.tenant.id);
    expect(seen, '序列已一致，没有写入，不发事件').toEqual([]);
  });

  it('订阅者抛错：同步整单回滚（待入职与其他目标都不追加版本、不改 revision）', async () => {
    const { db, s, employee, revision } = await sequenceWorld();
    const tenantId = s.world.tenant.id;
    const before = {
      pendingEmployee: await versions(db, tenantId, employee.id),
      otherEmployee: await versions(db, tenantId, s.employee.id),
      revision: await revision(),
    };
    registerEntrySourceEvents('boom', async () => {
      throw new Error('订阅方不可用');
    });
    const patched = await s.call(
      'PATCH',
      `posts/${s.target.id}`,
      { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true },
      1,
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    await worker(db, s.world.tenant.id);
    expect(await versions(db, tenantId, employee.id)).toEqual(before.pendingEmployee);
    expect(await versions(db, tenantId, s.employee.id), '同批其他目标一并回滚').toEqual(before.otherEmployee);
    expect(await revision()).toBe(before.revision);
  });
});
