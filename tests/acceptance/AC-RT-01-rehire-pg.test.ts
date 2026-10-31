/**
 * R2-T04 BE-5b / 真 PG 交错 ④（设计 §13.3）：同时返聘的退休生效 vs 同员工另一笔返聘写入。PGlite 单连接无法并发，只在设了
 * TEST_DATABASE_URL 时运行。交错同 AC-RT-05-activation-pg：持锁会话占住员工行锁，按固定先后启动请求，等恰有 N 个会话在等锁
 * （屏障）后才放锁。
 * 设计原文以“Offer 同步（退休返聘）”为另一笔写入；Offer 同步只会关联在职/已离职的实习生、普通 Offer 另建人员，无法与本员工的
 * 退休交错，所以这里用同一条顺序校验（write-service assertBusinessSequence，Offer 同步与通用入口共用）的另一个入口：
 * 通用 POST employees/:id/businesses kind=retire_rehire。串行后恰一笔返聘成立：
 * 退休生效先 → 手工返聘看到前一条已是返聘（在职），按既有规则 409；手工返聘先 → 退休尚未落地，顺序校验失败 409，退休随后生成返聘。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rehireWorld, type RehireWorld } from './AC-RT-rehire-support.js';
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
async function queueBehindEmployeeLock(x: RehireWorld, requests: readonly (() => Promise<unknown>)[]) {
  const held = signal();
  const release = signal();
  const holder = withTenant(x.db, x.session.tenant.id, async (tx: Tx) => {
    await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${x.session.tenant.id}
      AND id=${x.employee.id}::uuid FOR NO KEY UPDATE`);
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const running: Promise<unknown>[] = [];
  for (const [index, request] of requests.entries()) {
    const started = request();
    running.push(started);
    // 请求要么排到锁后，要么在拿锁前就被业务规则拒绝（结束）；两种都继续，终态断言兜底
    await settledOrBlocked(x.db, started, index + 1);
  }
  release.resolve();
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
        expect(text).not.toContain('APPROVAL_CONCURRENT_CONFLICT');
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
