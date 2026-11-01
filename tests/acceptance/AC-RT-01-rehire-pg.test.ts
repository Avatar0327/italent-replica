/**
 * F-293 / AC-RT-01 / 真 PG 交错 ④（退休设计 §13.3）：保留手工返聘两种顺序，补真实 Offer 写入口。
 * 先占住员工行锁，逐个确认请求已排队才放锁；PGlite 单连接不运行。业务拒绝断言机读原因，不能把 revision 冲突当成顺序校验。
 * DEC-677 的申请挂起 / 退休后顺延 / 作废转失败由 AC-RT-F314-pending 覆盖；这里只验证直接返聘与 DEC-679 Offer 交错。
 */
import './support/exit-gate-enforced.js';
import { pgErrorCode, sql, withTenant, type Db, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { RETIRE_REHIRE_REQUIRES_RETIREMENT } from '../../apps/api/src/modules/employment/retire-rehire-eligibility.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { errorOf } from './AC-OF-BE14a-support.js';
import { syncWorld, type SyncOffer, type SyncWorld } from './AC-OF-BE14b2-support.js';
import { rehireWorld } from './AC-RT-rehire-support.js';
import { rowsOf } from './support/f048.js';
import { settledOrBlocked } from './support/pg-interleave.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => rehireWorld(database().db, label, TODAY);
// 取自 offer/sync.ts 的 assertSyncPlanReady：该产品原因码尚未单独导出，测试不改产品导出契约。
const OFFER_SYNC_AWAITING_RETIREMENT = 'OFFER_SYNC_AWAITING_RETIREMENT';

const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/** 先后启动的请求排在员工行锁后面：第 n 个请求发出后等恰有 n 个会话在等锁，全部排队后才放锁。 */
async function queueBehindEmployeeLock(
  x: { db: Db; session: { tenant: { id: string } }; employee: { id: string } },
  requests: readonly (() => Promise<unknown>)[],
  inspectQueue?: () => Promise<void>,
) {
  const held = signal();
  const release = signal();
  const holder = withTenant(x.db, x.session.tenant.id, async (tx: Tx) => {
    await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${x.session.tenant.id}
      AND id=${x.employee.id}::uuid FOR NO KEY UPDATE`);
    held.resolve();
    await release.promise;
  });
  const running: Promise<unknown>[] = [];
  try {
    await Promise.race([held.promise, holder]);
    for (const [index, request] of requests.entries()) {
      const started = request();
      running.push(started);
      expect(await settledOrBlocked(x.db, started, index + 1)).toBe('blocked');
    }
    await inspectQueue?.();
  } finally {
    release.resolve();
    await Promise.allSettled([holder, ...running]);
  }
  await holder;
  return Promise.allSettled(running);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'AC-RT-01-rehire-pg ④ 退休生效（同时返聘）vs 手工返聘写入',
  () => {
    it.each(['退休生效先', '手工返聘先'] as const)(
      '员工行锁后两种先后（%s）：恰一笔返聘成立，无死锁',
      async (order) => {
        const x = await world(`rt-rehire-pg-${order}`);
        const retire = await x.createdRehire(x.rehireBody('2026-10-15', 'direct'));
        expect(retire.status).toBe('approved');
        // 调度入口对被占用的员工行是跳过（SKIP LOCKED），不排队；这里直接走编排器入口，它会等员工行锁
        const activate = () => x.activate(retire.id, '2026-10-16');
        const manual = async () => {
          if (order === '退休生效先') {
            // 先排到退休事务后，提交后再取 revision，避免旧版本的 409 遮住业务顺序原因。
            await withTenant(x.db, x.session.tenant.id, (tx) =>
              tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${x.session.tenant.id}
                AND id=${x.employee.id}::uuid FOR NO KEY UPDATE`),
            );
          }
          const { revision } = await x.session.getEmployee(x.employee.id);
          return x.session.request('POST', `/employees/${x.employee.id}/businesses`, {
            ifMatch: revision,
            body: {
              kind: 'retire_rehire',
              mode: 'direct',
              effectiveDate: '2026-10-17',
              fields: { employType: 'internal' },
            },
          });
        };

        const settled = await queueBehindEmployeeLock(
          x,
          order === '退休生效先' ? [activate, manual] : [manual, activate],
        );

        expect(
          settled.every((result) => result.status === 'fulfilled'),
          JSON.stringify(settled),
        ).toBe(true);
        const manualResponse = (settled[order === '退休生效先' ? 1 : 0] as PromiseFulfilledResult<Response>).value;
        const text = await manualResponse.clone().text();
        expect(manualResponse.status, text).toBe(409);
        expect(await errorOf(manualResponse)).toMatchObject({
          code: 'CONFLICT',
          details: { reason: RETIRE_REHIRE_REQUIRES_RETIREMENT },
        });
        // 终态：退休生效，时间轴上恰有一条 retire_rehire，且就是退休扩展行记录的那条
        expect((await x.business(retire.id)).status).toBe('effective');
        const timeline = await x.timeline();
        expect(timeline.map((row) => row.kind)).toEqual(['hire', 'retirement', 'retire_rehire']);
        expect(timeline[2]!.record_id).toBe((await x.extension(retire.id))!.rehire_business_id);
        expect(await x.cycles()).toHaveLength(2);
      },
    );
  },
);

/** 普通退休与独立 Offer 返聘：退休不自行生成返聘，唯一新周期必须来自真实 Offer 同步（DEC-679）。 */
async function offerRetirementWorld(label: string) {
  const w = await syncWorld(database().db, `rt01-${label}`);
  await installExitSeeds(w.db, w.tenant.id);
  const employee = await w.internEmployee('合成退休返聘员工');
  const current = await w.employment('GET', `/employees/${employee.id}`);
  expect(current.status).toBe(200);
  const { revision } = (await current.json()) as { revision: number };
  const response = await w.employment('POST', `/retirements/employees/${employee.id}`, {
    ifMatch: revision,
    body: { mode: 'direct', lastWorkDate: '2026-10-25' },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const retire = (await response.json()) as { id: string; status: string };
  expect(retire.status).toBe('approved');

  // 创建、关联、接受、同步都走 HTTP；自动同步关闭，接受时不提前抢员工锁做同步。
  await w.timing({ enabled: false });
  const created = await w.social({
    personalEmail: loginEmailOf(employee.id),
    plannedEntryDate: '2026-10-27',
    hasProbation: false,
  });
  const linked = await w.request('POST', `/${created.id}/link-employee`, {
    ifMatch: created.revision,
    body: { employeeId: employee.id },
  });
  expect(linked.status, await linked.clone().text()).toBe(200);
  const offer = await w.accepted((await linked.json()) as SyncOffer);
  expect(offer).toMatchObject({
    status: 'accepted',
    linkedEmployeeId: employee.id,
    syncStatus: null,
    syncReason: null,
    syncAttempts: 0,
    pendingEntryBusinessId: null,
  });
  // 两个竞争操作均在退休日执行；GET 夹具仍可用固定 asOf 读取完整时间轴。
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-26T02:00:00Z') });
  const sync = (target = offer) =>
    api.request('POST', `/api/tenant/offers/${target.id}/sync`, {
      user: w.user.id,
      tenant: w.tenant.id,
      ifMatch: target.revision,
      body: {},
    });
  const session = { tenant: w.tenant, user: w.user };
  const activate = () => exitActivator(w.db, session)(retire.id, '2026-10-26');
  return { ...w, session, employee, retire, offer, sync, activate };
}

/** 排除并发退休自身，核对整个夹具租户没有新增人员、业务、任职版本、周期或待入职子表产物。 */
async function offerProducts(w: Pick<SyncWorld, 'db' | 'tenant'>, retirementId: string) {
  const tenantId = w.tenant.id;
  return withTenant(w.db, tenantId, async (tx) => {
    const [snapshot] = rowsOf<Record<string, string[]>>(
      await tx.execute(sql`SELECT
        ARRAY(SELECT id FROM employment_employees WHERE tenant_id=${tenantId} ORDER BY id) AS employees,
        ARRAY(SELECT id FROM employment_business_objects WHERE tenant_id=${tenantId}
          AND id<>${retirementId}::uuid ORDER BY id) AS businesses,
        ARRAY(SELECT id FROM employment_payload_versions WHERE tenant_id=${tenantId}
          AND business_id<>${retirementId}::uuid ORDER BY id) AS versions,
        ARRAY(SELECT id FROM employment_records WHERE tenant_id=${tenantId}
          AND id<>${retirementId}::uuid ORDER BY id) AS records,
        ARRAY(SELECT id FROM employment_cycles WHERE tenant_id=${tenantId} ORDER BY id) AS cycles,
        ARRAY(SELECT business_id FROM employment_pending_entry_contract
          WHERE tenant_id=${tenantId} ORDER BY business_id) AS contracts,
        ARRAY(SELECT business_id FROM employment_pending_entry_probation
          WHERE tenant_id=${tenantId} ORDER BY business_id) AS probation`),
    );
    expect(snapshot).toBeDefined();
    return snapshot!;
  });
}

async function expectOfferRehire(w: Awaited<ReturnType<typeof offerRetirementWorld>>, response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  const synced = (await response.json()) as SyncOffer;
  expect(synced).toMatchObject({
    syncStatus: 'success',
    syncReason: null,
    syncAttempts: 1,
    syncTarget: 'pending_entry',
    pendingEntryBusinessId: expect.any(String),
    linkedEmployeeId: w.employee.id,
  });
  expect(await w.entries()).toEqual([
    expect.objectContaining({
      id: synced.pendingEntryBusinessId,
      employeeId: w.employee.id,
      effectiveDate: '2026-10-27',
      employeeStatus: EMPLOYEE_STATUS.pendingEntry,
    }),
  ]);
  expect(await w.record(synced.pendingEntryBusinessId!)).toMatchObject({
    employeeId: w.employee.id,
    kind: 'retire_rehire',
  });
  expect((await w.recordsOf(w.employee.id)).map((row) => [row.kind, row.effectiveDate])).toEqual([
    ['hire', '2026-10-17'],
    ['retirement', '2026-10-26'],
    ['retire_rehire', '2026-10-27'],
  ]);
  const products = await offerProducts(w, w.retire.id);
  const beforeRepeat = await w.read(synced.id);
  const repeated = await w.sync(beforeRepeat);
  expect(repeated.status, await repeated.clone().text()).toBe(200);
  expect(await w.read(synced.id)).toEqual(beforeRepeat);
  expect(await offerProducts(w, w.retire.id)).toEqual(products);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-01 / F-293 / DEC-679 真实 Offer 与退休生效', () => {
  it.each(['Offer 同步先', '退休生效先'] as const)(
    '员工锁后两种先后（%s）：退休前拒绝、退休后恰一笔返聘',
    async (order) => {
      const w = await offerRetirementWorld(order);
      const beforeOffer = await w.read(w.offer.id);
      const beforeProducts = await offerProducts(w, w.retire.id);
      const sync = () => w.sync(w.offer);
      const settled = await queueBehindEmployeeLock(
        w,
        order === 'Offer 同步先' ? [sync, w.activate] : [w.activate, sync],
        async () => {
          // 同步已持 Offer 锁但仍等员工锁：退休先排队时可先落地，并不产生第三种业务终态。
          const lockError = await withTenant(w.db, w.tenant.id, (tx) =>
            tx.execute(sql`SELECT id FROM offers WHERE tenant_id=${w.tenant.id}
            AND id=${w.offer.id}::uuid FOR UPDATE NOWAIT`),
          ).then(() => undefined, pgErrorCode);
          expect(lockError).toBe('55P03');
        },
      );
      expect(
        settled.every((result) => result.status === 'fulfilled'),
        JSON.stringify(settled),
      ).toBe(true);
      const syncResponse = (settled[order === 'Offer 同步先' ? 0 : 1] as PromiseFulfilledResult<Response>).value;
      const activation = (settled[order === 'Offer 同步先' ? 1 : 0] as PromiseFulfilledResult<unknown>).value;
      expect(activation).toMatchObject({ outcome: 'effective' });
      const retirement = await w.employment('GET', `/businesses/${w.retire.id}`);
      expect(retirement.status).toBe(200);
      expect(await retirement.json()).toMatchObject({ status: 'effective' });

      if (order === '退休生效先') {
        await expectOfferRehire(w, syncResponse);
        return;
      }
      expect(syncResponse.status, await syncResponse.clone().text()).toBe(409);
      expect(await errorOf(syncResponse)).toMatchObject({
        code: 'CONFLICT',
        details: { reason: OFFER_SYNC_AWAITING_RETIREMENT },
      });
      // 手动同步在保存点外明确拒绝，整个命令回滚；只有自动同步才记录 Offer failed（F-314 §8.4）。
      expect(await w.read(w.offer.id)).toEqual(beforeOffer);
      expect(await offerProducts(w, w.retire.id)).toEqual(beforeProducts);
      expect(await w.entries()).toEqual([]);
      expect((await w.recordsOf(w.employee.id)).map((row) => row.kind)).toEqual(['hire', 'retirement']);
      // 明确 409 后，待退休确已生效再显式重提；第一次没有产物，第二次只建一个 retire_rehire。
      await expectOfferRehire(w, await w.sync(await w.read(w.offer.id)));
    },
  );
});
