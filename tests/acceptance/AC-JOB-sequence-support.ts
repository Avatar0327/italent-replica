import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { orgPeopleWorld, resultRows, type OrgPeopleWorld } from './AC-ORG-people-support.js';
import { allowAll, tenantApi } from './support/tenant-api.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';
export const now = new Date('2026-10-05T01:00:00Z');
export async function worker(
  db: Db,
  tenantId: string,
  authorize: Authorizer = allowAll,
  options: { limit?: number; cursor?: string; clock?: () => Date } = {},
) {
  const path = '../../apps/api/src/modules/job/sequence-worker.js';
  const module = await import(path);
  return module.runSequenceSyncJobs(db, tenantId, { clock: () => now, authorize, ...options });
}
export function callAt(db: Db, world: OrgPeopleWorld, authorize: Authorizer = allowAll) {
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
export async function scenario(db: Db, kind: 'posts' | 'positions' = 'posts') {
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
export async function versions(db: Db, tenantId: string, employeeId: string) {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<{ businessId: string; count: number }>(
      await tx.execute(sql`SELECT business_id AS "businessId",count(*)::int AS count
      FROM employment_payload_versions WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
      GROUP BY business_id ORDER BY business_id`),
    ),
  );
}
