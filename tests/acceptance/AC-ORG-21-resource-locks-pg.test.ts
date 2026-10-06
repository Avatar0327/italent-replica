/** PR #82 第三轮 P1：不同员工 / 部门，真实提交或审批与定时生效 / HR 重试不得互锁。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as capacity from '../../apps/api/src/modules/employment/activation-checks.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
afterEach(() => vi.restoreAllMocks());

function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 只观察真实 PostgreSQL 锁等待，不用固定延时猜另一事务是否到达。 */
async function waitingOnOrganization(db: Db, owner: number) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = rowsOf<{ pid: number }>(
      await db.execute(sql`
      SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query ILIKE '%org_settings%'
        AND ${owner}=ANY(pg_blocking_pids(pid))
    `),
    );
    if (rows.length) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('生效 / 重试未进入组织锁等待');
}

/** 先用真实严格编制制造失败，再扩编，为 HR 重试准备合法前置状态。 */
async function failThenExpand(w: ActivationWorld, departmentId: string, businessId: string) {
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-05T01:00:00Z') });
  const request = (method: string, path: string, body: object, revision = 0) =>
    api.request(method, `/api/tenant/establishment${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: revision,
      body,
    });
  const scheme = await request('POST', '/schemes', {
    name: '重试锁序严格方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
  });
  expect(scheme.status, await scheme.clone().text()).toBe(201);
  const { id: schemeId } = (await scheme.json()) as { id: string };
  const created = await request('POST', '/capacities', {
    orgId: departmentId,
    schemeId,
    periodStart: '2026-01-01',
    localCapacity: 0,
    strictControl: true,
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const cap = (await created.json()) as { id: string; revision: number };
  expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({ failed: [businessId], errors: [] });
  expect((await w.business(businessId)).activation).toMatchObject({ failureReason: 'ESTABLISHMENT_EXCEEDED' });
  const expanded = await request(
    'PATCH',
    `/capacities/${cap.id}`,
    {
      localCapacity: 2,
      effectiveDate: '2026-10-05',
    },
    cap.revision,
  );
  expect(expanded.status, await expanded.clone().text()).toBe(200);
}

async function fixture(action: 'submit' | 'approve', execution: 'scheduler' | 'retry') {
  const w = await activationWorld(database().db, `org21-lock-${action}-${execution}`);
  const other = await w.session.org('另一调入部门', { establishedOn: '2026-01-01' });
  const first = await w.hired('正常提交员工');
  const second = await w.hired('到期生效员工');
  const draft = await w.session.business(
    first.employee.id,
    {
      kind: 'transfer',
      mode: 'application',
      effectiveDate: '2026-10-08',
      fields: { departmentId: w.to.id },
    },
    first.hire.employeeRevision,
  );
  if (action === 'approve') {
    const submitted = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(submitted.status).toBe(200);
  }
  const pending = await w.approve(
    await w.apply(second.employee.id, '2026-10-05', { departmentId: other.id }),
    '2026-10-02T01:00:00Z',
  );
  if (execution === 'retry') await failThenExpand(w, other.id, pending.id);
  const business = await w.business(draft.id);
  const commandId = randomUUID();
  const [task] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{
      id: string;
      assignee: string;
      revision: number;
    }>(
      await tx.execute(sql`
    SELECT t.id,t.assignee_user_id AS assignee,i.revision FROM approval_instances i
    JOIN approval_tasks t ON t.tenant_id=i.tenant_id AND t.instance_id=i.id
    WHERE i.tenant_id=${w.session.tenant.id} AND i.business_id=${draft.id}::uuid AND t.status='pending'
  `),
    ),
  );
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-05T01:00:00Z') });
  const firstRequest = () =>
    action === 'submit'
      ? w.session.request('POST', `/businesses/${draft.id}/submit`, {
          ifMatch: business.revision,
          idempotencyKey: commandId,
          body: {},
        })
      : api.request('POST', `/api/tenant/approval/tasks/${task!.id}/approve`, {
          user: task!.assignee,
          tenant: w.session.tenant.id,
          ifMatch: task!.revision,
          idempotencyKey: commandId,
          body: {},
        });
  return { ...w, draft, pending, firstRequest };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-ORG-21 组织 → 编制全局锁序（真 PG）', () => {
  describe.each(['submit', 'approve'] as const)('%s 与生效交错', (action) => {
    it.each(['scheduler', 'retry'] as const)('%s：无死锁，两名员工的业务正确推进', async (execution) => {
      const w = await fixture(action, execution);
      const reached = signal<number>();
      const release = signal();
      const original = capacity.assertEstablishmentCapacity;
      vi.spyOn(capacity, 'assertEstablishmentCapacity').mockImplementation(async (...args) => {
        if (args[2].businessId === w.draft.id) {
          // 正常提交 / 审批已取得组织锁，尚未进入真实编制校验。
          const [owner] = rowsOf<{ pid: number }>(await args[0].execute(sql`SELECT pg_backend_pid() AS pid`));
          reached.resolve(owner!.pid);
          await release.promise;
        }
        return original(...args);
      });
      const first = w.firstRequest();
      let second: Promise<unknown> | undefined;
      try {
        const pid = await Promise.race([
          reached.promise,
          first.then(() => {
            throw new Error('未到锁序屏障');
          }),
        ]);
        second =
          execution === 'scheduler'
            ? w.runScheduler('2026-10-05T02:00:00Z').then((run) => {
                expect(run).toMatchObject({ activated: [w.pending.id], failed: [], errors: [] });
              })
            : w.retry(w.pending, '2026-10-05T02:00:00Z').then(async (response) => {
                expect(response.status, await response.clone().text()).toBe(200);
                expect(await response.json()).toMatchObject({ status: 'effective' });
              });
        // 旧实现此时生效事务持编制锁等组织锁；释放首事务后形成 org ↔ establishment 环。
        // 正确实现应在取得编制锁前等待组织锁，释放后两笔依次成功。
        const outcomes = Promise.allSettled([first, second]);
        await waitingOnOrganization(w.db, pid);
        release.resolve();
        const settled = await outcomes;
        expect(settled.filter((result) => result.status === 'rejected')).toEqual([]);
        expect((await first).status).toBe(200);
        expect(await w.business(w.draft.id)).toMatchObject({ status: action === 'submit' ? 'in_review' : 'approved' });
        expect(await w.business(w.pending.id)).toMatchObject({ status: 'effective', record: { id: w.pending.id } });
      } finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    });
  });
});
