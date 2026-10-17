/**
 * R2-T03 B2b 真 PG 交错 ③（设计 §9）：批量离职申请与同员工的单人直接离职并发。两条连接各自在员工行锁后重读未办结离职：
 * 恰一方成功——单人先得锁则批量整批 409（该员工 EXIT_IN_PROGRESS，批内其他人也不写入）；批量先得锁则单人 409
 * EXIT_IN_PROGRESS。无死锁，库中该员工只有一条离职扩展行。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const LATER = '2026-10-20';

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-batch-pg 批量 vs 单人直接离职', () => {
  it('恰一方成功，另一方 409 EXIT_IN_PROGRESS（批量时整批回滚）', async () => {
    const w = await gateWorld(database().db, 'batch-pg');
    for (let round = 0; round < 3; round += 1) {
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
