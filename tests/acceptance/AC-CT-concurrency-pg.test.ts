import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { allowAll } from './support/tenant-api.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';

const testDb = useTestDb();
async function blocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = rowsOf<{ count: number }>(
      await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (row?.count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`未观测到 ${expected} 个被锁阻塞的并发操作`);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('R2-T06 PostgreSQL 16 强制交错', () => {
  it.each(['renew', 'expire'] as const)('%s 多实例：第一实例持员工锁后阻塞，第二实例 SKIP LOCKED', async (kind) => {
    const w = await contractWorld(testDb().db, `ctpg${kind}`);
    const contract = await w.create();
    if (kind === 'renew') {
      await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
      await w.settings({ autoRenew: true });
      const rule = await w.request('POST', '/rules', {
        ifMatch: 0,
        body: {
          name: '续签',
          priority: 1,
          orgIds: [w.org.id],
          personIds: [],
          details: [
            {
              typeId: w.type.id,
              months: 12,
              initiatorId: w.session.user.id,
              daysBefore: 10,
              skipTypeIds: [],
            },
          ],
        },
      });
      expect(rule.status).toBe(201);
    } else await w.settings({ autoTerminate: true });
    const sweep = () =>
      runContractJobs(
        w.db,
        { tenantId: w.session.tenant.id },
        {
          clock: () => new Date('2026-10-01T01:00:00Z'),
          authorize: allowAll,
        },
      );
    const [first, second] = await withTenant(w.db, w.session.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM contract_records WHERE id=${contract.id}::uuid FOR UPDATE`);
      const one = sweep();
      await blocked(w.db, 1);
      const two = await sweep();
      expect(two.runs[0]?.outcomes).toContainEqual(expect.objectContaining({ state: 'locked' }));
      return [one, two] as const;
    });
    expect(second.runs[0]?.outcomes).toHaveLength(1);
    expect((await first).runs[0]?.outcomes).toContainEqual(expect.objectContaining({ state: 'succeeded' }));
    await sweep();
    const attempts = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT id FROM contract_job_attempts WHERE object_id=${contract.id}::uuid
        AND kind=${kind} AND state='succeeded'`),
      ),
    );
    expect(attempts).toHaveLength(1);
    if (kind === 'renew') expect(await w.list('in_review')).toHaveLength(1);
    else expect((await w.list())[0]?.status).toBe('terminated');
  });

  it.each(['batch-first', 'single-first'] as const)('%s 批量与单条共用员工锁，旧 revision 整批回滚', async (order) => {
    const w = await contractWorld(testDb().db, 'ctpgbatch');
    const first = await w.create();
    const second = await w.create();
    const batch = () =>
      w.request('POST', '/batch', {
        ifMatch: 0,
        body: {
          items: [first, second].map((target) => ({
            revision: target.revision,
            command: {
              operation: 'terminate',
              mode: 'direct',
              employeeId: w.employee.id,
              targetId: target.id,
              fields: { actualTerminationDate: '2026-09-30' },
            },
          })),
        },
      });
    const single = () => w.change(first, 'terminate', { actualTerminationDate: '2026-09-30' });
    const requests = await withTenant(w.db, w.session.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM employment_employees WHERE id=${w.employee.id}::uuid FOR UPDATE`);
      const one = order === 'batch-first' ? batch() : single();
      await blocked(w.db, 1);
      const two = order === 'batch-first' ? single() : batch();
      await blocked(w.db, 2);
      return [one, two];
    });
    const responses = await Promise.all(requests);
    expect(responses[0]!.status).toBe(order === 'batch-first' ? 200 : 201);
    expect(responses[1]!.status).toBe(409);
    const final = await w.list();
    expect(final.find((c) => c.id === second.id)?.status).toBe(order === 'batch-first' ? 'terminated' : 'valid');
  });
});
