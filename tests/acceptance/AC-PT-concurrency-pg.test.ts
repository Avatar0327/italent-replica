/**
 * BE-7 PT-3a 真 PostgreSQL 交错（docs/08_设计/R2-T05_兼职设计.md §7.1 / §7.5，§9 PB-53 / PB-55）。PGlite 单连接无法并发，
 * 只在设了 TEST_DATABASE_URL 时运行：
 * - PB-53：同员工并发新增两条外派 —— 后到者在员工行锁上真实等待，先到者提交后复核失败，恰一条成功；
 * - PB-55：组织停用 vs 新增兼职 —— 组织锁串行：兼职先提交，停用在锁后统计到它 → 409；停用统计完后兼职再提交，
 *   等待者在锁内复查部门停用 → 400，不会漏计。
 */
import { withTenant, type Db, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as partTimeStore from '../../apps/api/src/modules/employment/part-time/store.js';
import { createPartTime } from '../../apps/api/src/modules/employment/part-time/service.js';
import { serviceWorld, type ServiceWorld } from './AC-PT-service-support.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
afterEach(() => vi.restoreAllMocks());

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 在租户事务里执行 work，停在提交之前直到 release；返回提交结果（成功 undefined，失败为错误）。 */
function holdThen(db: Db, tenantId: string, work: (tx: Tx) => Promise<unknown>) {
  const held = signal();
  const release = signal();
  const done = withTenant(db, tenantId, async (tx) => {
    await work(tx);
    held.resolve();
    await release.promise;
  }).then(
    () => undefined,
    (error: unknown) => {
      held.resolve();
      return error;
    },
  );
  return { held: held.promise, release: release.resolve, done };
}

const create = (w: ServiceWorld, tx: Tx, patch: Parameters<ServiceWorld['create']>[0]) =>
  createPartTime(tx, w.context(), {
    employeeId: w.employeeId,
    serviceType: 'part_time',
    startDate: '2026-09-01',
    departmentId: w.partTimeOrg.id,
    ...patch,
  });

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-PT-concurrency-pg 兼职写入真 PG 交错', () => {
  it('PB-53：同员工并发新增两条外派 —— 后到者等员工行锁，先到者提交后被拒，恰一条成功', async () => {
    const w = await serviceWorld(database().db, 'pt-pg-exclusive');
    const first = holdThen(w.db, w.tenantId, (tx) => create(w, tx, { serviceType: 'expatriate' }));
    await first.held;
    const second = w.rejection({ serviceType: 'secondment', startDate: '2026-09-10' });
    await waitForBlocked(w.db, 1);
    first.release();
    expect(await first.done).toBeUndefined();
    const error = await second;
    expect(w.reason(error)).toBe('PART_TIME_EXCLUSIVE_TYPE_EXISTS');
    expect(await w.writes()).toMatchObject({ records: 2 });
  });

  it('PB-55：兼职先提交（持组织锁）→ 停用在锁后统计到它，409，组织仍启用', async () => {
    const w = await serviceWorld(database().db, 'pt-pg-org-first');
    const org = await w.session.org(`并发部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    const writer = holdThen(w.db, w.tenantId, (tx) => create(w, tx, { departmentId: org.id }));
    await writer.held;
    const disable = w.disableOrg(org, '2026-10-02');
    await waitForBlocked(w.db, 1);
    writer.release();
    expect(await writer.done).toBeUndefined();
    const response = await disable;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ORG_SUBTREE_NOT_EMPTY' } } });
  });

  it('PB-55：停用统计完后兼职再提交 —— 兼职在组织锁上等待，放行后锁内复查部门停用，400，不会漏计', async () => {
    const w = await serviceWorld(database().db, 'pt-pg-org-second');
    const org = await w.session.org(`并发部门二${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    const reached = signal();
    const release = signal();
    const original = partTimeStore.countDepartmentPartTimes;
    vi.spyOn(partTimeStore, 'countDepartmentPartTimes').mockImplementationOnce(async (...args) => {
      const counted = await original(...args);
      expect([...counted.values()]).toEqual([]);
      reached.resolve();
      await release.promise;
      return counted;
    });
    const disable = w.disableOrg(org, '2026-10-02');
    await reached.promise;
    const writer = w.rejection({ departmentId: org.id, startDate: '2026-10-01' });
    await waitForBlocked(w.db, 1);
    release.resolve();
    const response = await disable;
    expect(response.status, await response.clone().text()).toBe(200);
    const error = await writer;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(w.reason(error)).toBe('EMPLOYMENT_DEPARTMENT_DISABLED');
    expect(await w.writes()).toMatchObject({ records: 1 });
  });
});
