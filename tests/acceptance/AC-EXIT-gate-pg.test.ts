/**
 * R2-T03 B2a 真 PG 交错（设计 §18 B2a 行）：同一员工并发两笔离职申请，恰一笔成功，另一笔 409 EXIT_IN_PROGRESS
 * （员工行锁后重读未办结离职；败者不会先撞 revision 冲突），库中只有一条离职扩展行。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-gate-pg 同员工并发离职申请', () => {
  it('两条并发申请（直接 + 申请）恰一条 201，另一条 409 EXIT_IN_PROGRESS，扩展行一条', async () => {
    const w = await gateWorld(database().db, 'gate-pg');
    for (let round = 0; round < 3; round += 1) {
      const { employee } = await w.hired(`并发员工${round}`);
      const revision = (await w.session.getEmployee(employee.id)).revision;
      const send = (mode: 'application' | 'direct') =>
        w.session.request('POST', `/employees/${employee.id}/businesses`, {
          ifMatch: revision,
          body: leaveBody('2026-10-20', mode),
        });
      const responses = await Promise.all([send('application'), send('direct')]);
      const texts = await Promise.all(responses.map((response) => response.clone().text()));
      expect(responses.map((response) => response.status).sort(), String(texts)).toEqual([201, 409]);
      expect(texts.join()).toContain('EXIT_IN_PROGRESS');
      expect((await w.stateOf(employee.id)).exits).toHaveLength(1);
    }
  });
});
