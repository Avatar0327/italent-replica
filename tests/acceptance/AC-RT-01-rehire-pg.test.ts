/**
 * F-293 / AC-RT-01 / 真 PG 交错 ④（退休设计 §13.3）：保留手工返聘两种顺序，补真实 Offer 写入口。
 * 先占住员工行锁，逐个确认请求已排队才放锁；PGlite 单连接不运行。业务拒绝断言机读原因，不能把 revision 冲突当成顺序校验。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { errorOf } from './AC-OF-BE14a-support.js';
import { syncWorld, type SyncOffer } from './AC-OF-BE14b2-support.js';
import { rehireWorld } from './AC-RT-rehire-support.js';
import { settledOrBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => rehireWorld(database().db, label, TODAY);

const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/** 先后启动的请求排在员工行锁后面：第 n 个请求发出后等恰有 n 个会话在等锁，全部排队后才放锁。 */
async function queueBehindEmployeeLock(
  x: { db: Db; session: { tenant: { id: string } }; employee: { id: string } },
  requests: readonly (() => Promise<unknown>)[],
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
        // write-service.ts sequenceViolation：这里校验顺序拒绝，不校验中文文案。
        expect(await errorOf(manualResponse)).toMatchObject({
          code: 'CONFLICT',
          details: { reason: 'RETIRE_REHIRE_REQUIRES_RETIREMENT' },
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

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-01 / F-293 真实 Offer 与退休生效', () => {
  it('设计 PG ④：Offer 先生成退休返聘，随后退休因顺序校验失败', async () => {
    const w = await syncWorld(database().db, 'rt01-offer-first');
    await installExitSeeds(w.db, w.tenant.id);
    const employee = await w.internEmployee('合成退休返聘员工');
    const current = await w.employment('GET', `/employees/${employee.id}`);
    expect(current.status).toBe(200);
    const { revision } = (await current.json()) as { revision: number };
    const response = await w.employment('POST', `/retirements/employees/${employee.id}`, {
      ifMatch: revision,
      body: {
        mode: 'direct',
        lastWorkDate: '2026-10-25',
        reEmployed: true,
        rehire: { fields: { employType: 'internal', departmentId: w.department.id }, entry: { probation: false } },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const retire = (await response.json()) as { id: string; status: string };
    expect(retire.status).toBe('approved');

    // Offer 的创建、关联、接受与同步全部经 HTTP 写入口；关闭自动同步以便把立即同步排入 PG 屏障。
    await w.timing({ enabled: false });
    const created = await w.social({
      personalEmail: loginEmailOf(employee.id),
      source: 'intern_conversion',
      plannedEntryDate: '2026-10-27',
      hasProbation: false,
    });
    const linked = await w.request('POST', `/${created.id}/link-employee`, {
      ifMatch: created.revision,
      body: { employeeId: employee.id },
    });
    expect(linked.status, await linked.clone().text()).toBe(200);
    const offer = await w.accepted((await linked.json()) as SyncOffer);
    expect(offer).toMatchObject({ linkedEmployeeId: employee.id, syncStatus: null });
    const session = { tenant: w.tenant, user: w.user };
    const activate = () => exitActivator(w.db, session)(retire.id, '2026-10-26');
    const sync = () => w.sync(offer);
    const settled = await queueBehindEmployeeLock({ db: w.db, session, employee }, [sync, activate]);
    expect(
      settled.every((result) => result.status === 'fulfilled'),
      JSON.stringify(settled),
    ).toBe(true);
    const syncResponse = (settled[0] as PromiseFulfilledResult<Response>).value;
    expect(syncResponse.status, await syncResponse.clone().text()).toBe(200);
    const synced = (await syncResponse.json()) as SyncOffer;
    const activation = (settled[1] as PromiseFulfilledResult<unknown>).value;
    const records = await w.recordsOf(employee.id);
    const kinds = records.map((record) => record.kind);
    const evidence = JSON.stringify({
      syncStatus: synced.syncStatus,
      syncTarget: synced.syncTarget,
      activation,
      kinds,
    });
    expect(synced.syncStatus, evidence).toBe('success');
    // retirement-rehire.ts 包装顺序拒绝；编排器落失败尝试，CONFLICT 对应 HTTP 409。
    expect(activation, evidence).toMatchObject({
      outcome: 'failed',
      reason: 'RETIREMENT_REHIRE_FAILED',
      detail: { code: 'CONFLICT', rule: 'RETIRE_REHIRE_REQUIRES_RETIREMENT' },
    });
    // 保留设计 §13.3 PG ④ 的产物要求；不能用实习转正冒充退休返聘，口径冲突交总编排决定。
    expect(kinds, evidence).toEqual(['hire', 'retire_rehire']);
  });
});
