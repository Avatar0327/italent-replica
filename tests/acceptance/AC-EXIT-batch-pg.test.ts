/**
 * R2-T03 B2b 真 PG 交错 ③（设计 §9）：批量离职申请与同员工的单人直接离职并发。两条连接各自在员工行锁后重读未办结离职：
 * 恰一方成功——单人先得锁则批量整批 409（该员工 EXIT_IN_PROGRESS，批内其他人也不写入）；批量先得锁则单人 409
 * EXIT_IN_PROGRESS。无死锁（批量先锁齐全批员工再提交，提交取组织锁不会反过来等员工锁），库中该员工只有一条离职扩展行。
 * 交错时机靠多轮覆盖：锁齐之前的实现 12 轮里稳定出现 40P01 死锁。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { batchItems, dutyPlan, orderedPeople } from './AC-EXIT-batch-support.js';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';

const database = useTestDb();
const LATER = '2026-10-20';
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-batch-pg 批量 vs 单人直接离职', () => {
  it('恰一方成功，另一方 409 EXIT_IN_PROGRESS（批量时整批回滚）', async () => {
    const w = await gateWorld(database().db, 'batch-pg');
    for (let round = 0; round < 8; round += 1) {
      const shared = (await w.hired(`共同员工${round}`)).employee.id;
      const peer = (await w.hired(`批内员工${round}`)).employee.id;
      const items = await Promise.all(
        [peer, shared].map(async (employeeId) => ({
          employeeId,
          revision: (await w.session.getEmployee(employeeId)).revision,
          lastWorkDate: LATER,
          exit: { exitTypeCode: 'voluntary' },
        })),
      );
      const revision = (await w.session.getEmployee(shared)).revision;
      const [batch, single] = await Promise.all([
        w.session.request('POST', '/exits/batch', { body: { items } }),
        w.session.request('POST', `/employees/${shared}/businesses`, {
          ifMatch: revision,
          body: leaveBody(LATER, 'direct'),
        }),
      ]);
      const texts = [await batch.clone().text(), await single.clone().text()];
      expect([batch.status, single.status].sort(), String(texts)).toEqual([201, 409]);
      expect(texts.join()).toContain('EXIT_IN_PROGRESS');
      expect((await w.stateOf(shared)).exits).toHaveLength(1);
      expect((await w.stateOf(peer)).exits).toHaveLength(batch.status === 201 ? 1 : 0);
    }
  });
});

/**
 * P2-2 返工：批量入口与单人入口争用同一参与员工闭包（UUID 顺序 S < A < B，B 携带转交下属 S 的计划）。
 * 持锁会话先占住 S，两个请求按固定先后排队（pg_stat_activity 屏障），放锁后无死锁、无并发冲突码，两个请求都成功。
 */
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-batch-pg 批量 vs 单人争用同一闭包', () => {
  it.each(['批量先', '单人先'] as const)(
    '两连接强制交错（%s）：都成功，无 40P01 / TRANSFER_LOCK_PLAN_CHANGED',
    async (order) => {
      const w = await gateWorld(database().db, `batch-closure-pg-${order}`);
      const p = await orderedPeople(w);
      const batch = async () =>
        w.session.request('POST', '/exits/batch', {
          body: { items: await batchItems(w, [{ id: p.a }, { id: p.b, exit: dutyPlan(p.s, p.receiver) }]) },
        });
      const single = async () =>
        w.session.request('POST', `/employees/${p.s}/businesses`, {
          ifMatch: (await w.session.getEmployee(p.s)).revision,
          body: leaveBody(LATER, 'direct'),
        });
      const held = signal();
      const release = signal();
      const holder = withTenant(w.db, w.session.tenant.id, async (tx) => {
        await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${w.session.tenant.id}
        AND id=${p.s}::uuid FOR NO KEY UPDATE`);
        held.resolve();
        await release.promise;
      });
      const running: Promise<Response>[] = [];
      await withRelease(
        () => release.resolve(),
        async (cleanup) => {
          cleanup.track(holder);
          await held.promise;
          const requests = order === '批量先' ? [batch, single] : [single, batch];
          // 请求体（含 revision 查询）先备好再排队，避免等待期间占满连接池
          for (const [index, request] of requests.entries()) {
            running.push(cleanup.track(request()));
            await waitForBlocked(w.db, index + 1);
          }
        },
        [holder],
      );
      const responses = await Promise.all(running);
      const texts = await Promise.all(responses.map((response) => response.clone().text()));
      expect(
        responses.map((response) => response.status),
        texts.join('\n'),
      ).toEqual([201, 201]);
      expect(texts.join('\n')).not.toMatch(/DEADLOCK|TRANSFER_LOCK_PLAN_CHANGED|40P01/);
    },
  );
});
