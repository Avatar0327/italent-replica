/** PR #82 P1：真实 PG 两个事务交错，屏障只暂停真实查询之后的执行，不伪造统计或写入。 */
import { sql, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as people from '../../apps/api/src/modules/employment/org-people.js';
import * as positions from '../../apps/api/src/modules/job/read-model.js';
import * as capacity from '../../apps/api/src/modules/employment/activation-checks.js';
import { activationWorld } from './AC-TRF-activation-support.js';
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

/** 暂停持锁事务，直到另一事务真实阻塞（或旧实现已越过屏障提交）。 */
async function waitForBlockedOrFinished(db: Db, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) return;
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%org_settings%'`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
    if (rows[0]!.n > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('对端既未完成也未等待组织互斥锁');
}

async function interleave<A, B>(
  db: Db,
  first: () => Promise<A>,
  second: () => Promise<B>,
  reached: ReturnType<typeof signal>,
  release: ReturnType<typeof signal>,
) {
  const a = first();
  let b: Promise<B> | undefined;
  try {
    await Promise.race([
      reached.promise,
      a.then(() => {
        throw new Error('未到统计屏障');
      }),
    ]);
    let finished = false;
    b = second().finally(() => {
      finished = true;
    });
    await waitForBlockedOrFinished(db, () => finished);
    release.resolve();
    return await Promise.all([a, b]);
  } finally {
    release.resolve();
    await Promise.allSettled([a, ...(b ? [b] : [])]);
  }
}

async function world(label: string, cascade: boolean) {
  const w = await activationWorld(database().db, label);
  const target = cascade ? await w.session.org('级联目标', { parents: { admin: { parentId: w.to.id } } }) : w.to;
  const { employee, hire } = await w.hired();
  const draft = await w.session.business(
    employee.id,
    {
      kind: 'transfer',
      mode: 'application',
      effectiveDate: '2026-10-05',
      fields: { departmentId: target.id },
    },
    hire.employeeRevision,
  );
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-02T01:00:00Z') });
  const disable = () =>
    api.request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
      tenant: w.session.tenant.id,
      user: w.session.user.id,
      ifMatch: w.to.revision,
      body: { enabled: false, effectiveDate: '2026-10-03' },
    });
  const submit = () =>
    w.session.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {} });
  async function assertOrg(enabled: boolean) {
    const response = await api.request('GET', '/api/tenant/org/organizations?asOf=2026-10-10&includeDisabled=true', {
      tenant: w.session.tenant.id,
      user: w.session.user.id,
    });
    const { items } = (await response.json()) as { items: { id: string; enabled: boolean; revision: number }[] };
    for (const id of new Set([w.to.id, target.id]))
      expect(items.find((item) => item.id === id)).toMatchObject({ enabled, revision: enabled ? 1 : 2 });
  }
  return { ...w, draft, employee, disable, submit, assertOrg };
}

async function blocked(response: Response) {
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      message: '当前组织或下级组织中存在待入职或在职员工任职记录1条，不能被停用',
      details: { reason: 'ORG_SUBTREE_NOT_EMPTY' },
    },
  });
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-ORG-21 真 PG 停用与调入互斥', () => {
  describe.each([false, true])('级联=%s', (cascade) => {
    it.each(['approve', 'activate'] as const)('已有在途：任职统计后与 %s 落地交错不能漏计', async (action) => {
      const w = await world(`org21-pg-${action}-${cascade}`, cascade);
      expect((await w.submit()).status).toBe(200);
      if (action === 'activate') await w.approve(w.draft, '2026-10-02T01:00:00Z');
      const reached = signal();
      const release = signal();
      const original = people.countDepartmentStaff;
      vi.spyOn(people, 'countDepartmentStaff').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        expect([...result.values()]).toEqual([]);
        reached.resolve();
        await release.promise;
        return result;
      });
      const [disabled] = await interleave(
        w.db,
        w.disable,
        async () => {
          if (action === 'approve') return w.approve(w.draft, '2026-10-05T01:00:00Z');
          const result = await w.runScheduler('2026-10-05T01:00:00Z');
          expect(result).toMatchObject({ activated: [w.draft.id], errors: [] });
          return result;
        },
        reached,
        release,
      );
      await blocked(disabled);
      await w.assertOrg(true);
      expect(await w.business(w.draft.id)).toMatchObject({ status: 'effective', record: { id: w.draft.id } });
    });

    it('统计无在途后新提交：停用先提交，等待者须复查部门并回滚', async () => {
      const w = await world(`org21-pg-new-${cascade}`, cascade);
      const reached = signal();
      const release = signal();
      const original = positions.countEnabledPositions;
      vi.spyOn(positions, 'countEnabledPositions').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        reached.resolve();
        await release.promise;
        return result;
      });
      const [disabled, submitted] = await interleave(w.db, w.disable, w.submit, reached, release);
      expect(disabled.status, await disabled.clone().text()).toBe(200);
      expect(submitted.status, await submitted.clone().text()).toBe(400);
      expect(await submitted.json()).toMatchObject({
        error: { details: { reason: 'EMPLOYMENT_DEPARTMENT_DISABLED' } },
      });
      await w.assertOrg(false);
      expect(await w.business(w.draft.id)).toMatchObject({ status: 'draft', revision: w.draft.revision, record: null });
    });
  });

  it('提交先做预检：停用等待提交完成，锁内重读后拒绝', async () => {
    const w = await world('org21-pg-submit-first', true);
    const reached = signal();
    const release = signal();
    const original = capacity.assertEstablishmentCapacity;
    vi.spyOn(capacity, 'assertEstablishmentCapacity').mockImplementationOnce(async (...args) => {
      await original(...args);
      reached.resolve();
      await release.promise;
    });
    const [submitted, disabled] = await interleave(w.db, w.submit, w.disable, reached, release);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    await blocked(disabled);
    await w.assertOrg(true);
    expect(await w.business(w.draft.id)).toMatchObject({ status: 'in_review', record: null });
  });
});
