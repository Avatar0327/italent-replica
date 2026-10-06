import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgPeopleWorld, resultRows, type OrgPeopleWorld } from './AC-ORG-people-support.js';
import { allowAll, tenantApi } from './support/tenant-api.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';

const testDb = useTestDb();
const now = new Date('2026-10-05T01:00:00Z');
async function worker(db: Db, tenantId: string, authorize: Authorizer = allowAll) {
  const path = '../../apps/api/src/modules/job/sequence-worker.js';
  const module = await import(path);
  return module.runSequenceSyncJobs(db, tenantId, { clock: () => now, authorize });
}
function callAt(db: Db, world: OrgPeopleWorld, authorize: Authorizer = allowAll) {
  const api = tenantApi(db, { clock: () => now, authorize });
  return (method: string, path: string, body?: unknown, revision = 0, key = randomUUID()) =>
    api.request(method, `/api/tenant/job/${path}`, {
      user: world.user.id,
      tenant: world.tenant.id,
      body,
      ifMatch: revision,
      idempotencyKey: key,
    });
}
async function scenario(db: Db, kind: 'posts' | 'positions' = 'posts') {
  const world = await orgPeopleWorld(db, `seq${randomUUID().slice(0, 8)}`);
  const org = await world.org('同步部门');
  const oldSequence = await world.job('sequences', '原序列');
  const nextSequence = await world.job('sequences', '新序列');
  const post = await world.job('posts', '同步职务', { sequenceId: oldSequence.id });
  const position = await world.job('positions', '同步职位', {
    orgId: org.id,
    postId: post.id,
    sequenceId: oldSequence.id,
  });
  const target = kind === 'posts' ? post : position;
  const fields = { departmentId: org.id, postId: post.id, positionId: position.id, sequenceId: oldSequence.id };
  const employee = await world.hire('同步员工', fields);
  const current = await world.business(
    employee.id,
    {
      kind: 'org_adjustment',
      mode: 'direct',
      effectiveDate: '2026-10-03',
      fields,
    },
    employee.revision,
  );
  const future = await world.business(
    employee.id,
    {
      kind: 'org_adjustment',
      mode: 'direct',
      effectiveDate: '2026-10-12',
      fields,
    },
    current.employeeRevision,
  );
  return { world, org, target, employee, current, future, oldSequence, nextSequence, call: callAt(db, world) };
}
async function versions(db: Db, tenantId: string, employeeId: string) {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<{ businessId: string; count: number }>(
      await tx.execute(sql`SELECT business_id AS "businessId",count(*)::int AS count
      FROM employment_payload_versions WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
      GROUP BY business_id ORDER BY business_id`),
    ),
  );
}

describe('AC-JOB-08～11 F-021 序列同步', () => {
  for (const kind of ['posts', 'positions'] as const) {
    it(`AC-JOB-08 ${kind} 编辑按引用异步追加当前/未来版本，历史与原始记录不变`, async () => {
      const { db } = testDb();
      const s = await scenario(db, kind);
      const before = await versions(db, s.world.tenant.id, s.employee.id);
      const key = randomUUID();
      const body = { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true };
      const response = await s.call('PATCH', `${kind}/${s.target.id}`, body, 1, key);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before);
      await worker(db, s.world.tenant.id);
      const records = await s.world.employmentRecords(s.employee.id, '2026-10-05');
      expect(records.map((r) => r.fields.sequenceId)).toEqual([s.oldSequence.id, s.nextSequence.id, s.nextSequence.id]);
      expect(records.map((r) => r.effectiveDate)).toEqual(['2026-10-01', '2026-10-03', '2026-10-12']);
      const after = await versions(db, s.world.tenant.id, s.employee.id);
      for (const row of after)
        expect(row.count).toBe(
          before.find((b) => b.businessId === row.businessId)!.count + (row.businessId === s.employee.recordId ? 0 : 1),
        );
      await worker(db, s.world.tenant.id);
      expect((await s.call('PATCH', `${kind}/${s.target.id}`, body, 1, key)).status).toBe(200);
      expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(after);
      await withTenant(db, s.world.tenant.id, async (tx) => {
        const originals = resultRows<{ sequence: string }>(
          await tx.execute(sql`
          SELECT sequence_id AS sequence FROM employment_records WHERE employee_id=${s.employee.id}::uuid`),
        );
        expect(originals.every((r) => r.sequence === s.oldSequence.id)).toBe(true);
        const audit = resultRows(
          await tx.execute(sql`SELECT id FROM audit_events
          WHERE action='employment.sequence-sync' AND command_id=${key}`),
        );
        expect(audit).toHaveLength(2);
        const events = resultRows(
          await tx.execute(sql`SELECT id FROM employment_outbox
          WHERE event_type='job.sequence-sync.completed' AND payload->'after'->>'recipientUserId'=${s.world.user.id}`),
        );
        expect(events).toHaveLength(1);
      });
    });
  }

  it('AC-JOB-09 清空不排队，新建不同步，非空编辑不能以 false 绕过锁定', async () => {
    const { db } = testDb();
    const s = await scenario(db);
    const before = await versions(db, s.world.tenant.id, s.employee.id);
    const cleared = await s.call(
      'PATCH',
      `posts/${s.target.id}`,
      {
        sequenceId: null,
        effectiveDate: '2026-10-05',
      },
      1,
    );
    expect(cleared.status).toBe(200);
    await worker(db, s.world.tenant.id);
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before);
    const changed = await s.call(
      'PATCH',
      `posts/${s.target.id}`,
      {
        sequenceId: s.nextSequence.id,
        syncSequenceToAssignments: false,
        effectiveDate: '2026-10-05',
      },
      2,
    );
    expect(changed.status).toBe(200);
    await worker(db, s.world.tenant.id);
    expect((await s.world.record(s.current.id)).fields.sequenceId).toBe(s.nextSequence.id);
  });

  it('AC-JOB-10 列表同口径、重试幂等、整单失败无部分追加', async () => {
    const { db } = testDb();
    const s = await scenario(db);
    const before = await versions(db, s.world.tenant.id, s.employee.id);
    const response = await s.call('POST', 'posts/sync-sequence', { items: [{ id: s.target.id, revision: 1 }] });
    expect(response.status, await response.clone().text()).toBe(202);
    await worker(db, s.world.tenant.id);
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before); // 相同值不追加
    expect(
      (
        await s.call(
          'PATCH',
          `posts/${s.target.id}`,
          {
            sequenceId: s.nextSequence.id,
            effectiveDate: '2026-10-05',
          },
          1,
        )
      ).status,
    ).toBe(200);
    await worker(db, s.world.tenant.id, () => false);
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before);
    await withTenant(db, s.world.tenant.id, async (tx) => {
      expect(
        resultRows(
          await tx.execute(sql`SELECT id FROM employment_outbox_attempts
        WHERE state='failed' AND error_reason IS NOT NULL`),
        ).length,
      ).toBeGreaterThan(0);
    });
    await worker(db, s.world.tenant.id);
    const after = await versions(db, s.world.tenant.id, s.employee.id);
    expect(after.reduce((n, r) => n + r.count, 0)).toBe(before.reduce((n, r) => n + r.count, 0) + 2);
    await worker(db, s.world.tenant.id);
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(after);
  });

  it('AC-JOB-11 范围为空整单拒绝，跨租户对象拒绝，批量上限与 revision', async () => {
    const { db } = testDb();
    const s = await scenario(db);
    const restricted = callAt(
      db,
      s.world,
      (r) => r.action !== 'data.scope.all' || r.resource !== 'TenantBase.EmploymentRecord',
    );
    const response = await restricted(
      'PATCH',
      `posts/${s.target.id}`,
      {
        sequenceId: s.nextSequence.id,
        effectiveDate: '2026-10-05',
      },
      1,
    );
    expect(response.status, await response.clone().text()).toBe(403);
    const other = await orgPeopleWorld(db, 'seqother');
    expect(
      (
        await callAt(db, other)('POST', 'posts/sync-sequence', {
          items: [{ id: s.target.id, revision: 1 }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await s.call('POST', 'posts/sync-sequence', {
          items: [{ id: s.target.id, revision: 99 }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await s.call('POST', 'posts/sync-sequence', {
          items: Array.from({ length: 101 }, () => ({ id: randomUUID(), revision: 1 })),
        })
      ).status,
    ).toBe(400);
  });
});
