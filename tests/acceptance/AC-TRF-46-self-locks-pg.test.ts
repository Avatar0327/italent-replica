/** DEC-216 / F-019：本人提交沿共享服务取员工 → 组织锁；停用先提交时，等待者重新校验并原子回滚。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as positions from '../../apps/api/src/modules/job/read-model.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { approvalWorld } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
afterEach(() => vi.restoreAllMocks());
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitForOrganization(db: Db, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('员工提交绕过了组织锁');
    const rows = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%org_settings%'`),
    );
    if (rows[0]!.n > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('本人提交未到达组织锁屏障');
}
async function fixture() {
  const w = await approvalWorld(database().db, 'self-locks');
  const source = await w.org('合成原部门');
  const target = await w.org('合成待停用部门');
  const post = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/job/posts', {
      ifMatch: 0,
      body: { code: 'SELF_LOCK_POST', name: '合成职务', startDate: '2020-01-01' },
    }),
    201,
  );
  const position = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/job/positions', {
      ifMatch: 0,
      body: { code: 'SELF_LOCK_POSITION', name: '合成原职位', startDate: '2020-01-01', orgId: source, postId: post.id },
    }),
    201,
  );
  const person = await w.person('合成自助员工', source, { positionId: position.id, postId: post.id });
  await w.publishedProcess({ nodes: [{ key: 'review', approver: 'owner' }] });
  const api = tenantApi(database().db, { authorize: undefined, clock: w.clock });
  const profile = await w.json<{ employee: { revision: number } }>(
    await api.request('GET', '/api/tenant/self-service/profile', w.as(person.userId)),
  );
  const command = randomUUID();
  return {
    ...w,
    person,
    command,
    api,
    revision: profile.employee.revision,
    submit: () =>
      api.request('POST', '/api/tenant/self-service/transfer', {
        ...w.as(person.userId),
        idempotencyKey: command,
        ifMatch: profile.employee.revision,
        body: { effectiveDate: '2026-10-19', fields: { departmentId: target } },
      }),
    disable: () =>
      w.request(w.hr.id, 'PATCH', `/api/tenant/org/organizations/${target}`, {
        ifMatch: 1,
        body: { enabled: false, effectiveDate: '2026-10-03' },
      }),
  };
}
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TRF-46 / 51 占职位本人提交全局锁序（真 PG）', () => {
  it('停用在组织锁内先完成，员工等待后拒绝且不落业务、审批或成功审计', async () => {
    const w = await fixture();
    const reached = signal();
    const release = signal();
    const original = positions.countEnabledPositions;
    vi.spyOn(positions, 'countEnabledPositions').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      reached.resolve();
      await release.promise;
      return result;
    });
    const disabling = w.disable();
    let submitting: Promise<Response> | undefined;
    try {
      await Promise.race([
        reached.promise,
        disabling.then(() => {
          throw new Error('未到停用屏障');
        }),
      ]);
      let finished = false;
      submitting = w.submit().finally(() => {
        finished = true;
      });
      await waitForOrganization(w.db, () => finished);
      release.resolve();
      const [disabled, submitted] = await Promise.all([disabling, submitting]);
      expect(disabled.status, await disabled.clone().text()).toBe(200);
      expect(submitted.status, await submitted.clone().text()).toBe(400);
      expect(await submitted.json()).toMatchObject({
        error: { details: { reason: 'EMPLOYMENT_DEPARTMENT_DISABLED' } },
      });
      const profile = await w.json<{ employee: { revision: number } }>(
        await w.api.request('GET', '/api/tenant/self-service/profile', w.as(w.person.userId)),
      );
      expect(profile.employee.revision).toBe(w.revision);
      const counts = await withTenant(w.db, w.tenant.id, async (tx) =>
        rowsOf<{ businesses: number; audits: number }>(
          await tx.execute(sql`
        SELECT (SELECT count(*)::int FROM employment_business_objects
          WHERE tenant_id=${w.tenant.id} AND employee_id=${w.person.employeeId}::uuid) AS businesses,
          (SELECT count(*)::int FROM audit_events WHERE command_id=${w.command}) AS audits
      `),
        ),
      );
      expect(counts[0]).toEqual({ businesses: 1, audits: 0 });
    } finally {
      release.resolve();
      await Promise.allSettled([disabling, ...(submitting ? [submitting] : [])]);
    }
  });
});
