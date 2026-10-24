/** AC-DM-09 / F-317 P2-1：真实提交后丢回执，整批始终按客户端原键恢复。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { handoverWorld, type HandoverWorld } from './AC-EXIT-handover-support.js';

const database = useTestDb();
const path = '/exits/handover/batch-submit';
type Stage = 'manifest' | 'child' | 'aggregate' | 'aggregate-read' | 'visibility-read';
const disconnected = () => Object.assign(new Error('合成提交回执 / 回查连接中断'), { code: 'ECONNRESET' });

async function fixture(stage: Stage) {
  const x = await handoverWorld(database().db, `f317-fault-${stage}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  const exits = [];
  for (const index of [1, 2]) {
    const employee = await x.colleague(`批量故障合成员工${index}`);
    await x.applicantAccount(employee.id);
    exits.push(
      await x.createdExit(employee.id, '2026-10-21', 'direct', {
        exitTypeCode: 'voluntary',
        handoverEmployeeId: x.workOwner.employeeId,
      }),
    );
  }
  const init = {
    idempotencyKey: randomUUID(),
    body: { items: exits.map(({ id, revision }) => ({ exitRequestId: id, revision })) },
  };
  return { x, exits, init };
}

/** 仅包装真实数据库事务：先 await 驱动完成提交，再切断回执 / 紧接的一次读取。 */
function interrupt(x: HandoverWorld, key: string, firstExitId: string, stage: Stage) {
  const transact = x.db.transaction.bind(x.db);
  let nextReadFails = false;
  let committed = false;
  let readFailed = false;
  const spy = vi.spyOn(x.db, 'transaction').mockImplementation(async (...args) => {
    if (nextReadFails) {
      nextReadFails = false;
      readFailed = true;
      throw disconnected();
    }
    const value = await transact(...args);
    const body = (value as { body?: { batchCommandId?: string; exitRequestId?: string; items?: unknown[] } })?.body;
    const target =
      stage === 'manifest' || stage === 'aggregate-read'
        ? body?.batchCommandId === key
        : stage === 'child'
          ? body?.exitRequestId === firstExitId
          : Array.isArray(body?.items);
    if (!committed && target) {
      committed = true;
      nextReadFails = true;
      if (stage !== 'aggregate-read' && stage !== 'visibility-read') throw disconnected();
    }
    return value;
  });
  return { restore: () => spy.mockRestore(), observed: () => ({ committed, readFailed }) };
}

async function lookup(x: HandoverWorld, key: string) {
  return x.api.request('GET', `/api/tenant/commands/${key}/result`, x.tenantAs(x.session.user.id));
}

async function recover(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await f.x.session.request('POST', path, f.init);
  expect(first.status, await first.clone().text()).toBe(200);
  const body = await first.json();
  expect(body.items.map((r: { outcome: string }) => r.outcome)).toEqual(['launched', 'launched']);
  const replay = await f.x.session.request('POST', path, f.init);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toEqual(body);
  for (const exit of f.exits) {
    const rows = await f.x.requestRows(exit.id);
    expect(rows).toHaveLength(1);
    expect(await f.x.auditActions(rows[0]!.id, 'exit_handover.launch')).toHaveLength(1);
  }
  const actors = await f.x.sqlRows<{ actor: string }>(sql`
    SELECT actor_user_id AS actor FROM audit_events
    WHERE tenant_id=${f.x.tenantId} AND action='exit_handover.launch'`);
  expect(actors).toEqual([{ actor: f.x.session.user.id }, { actor: f.x.session.user.id }]);
  expect(await f.x.handoverInstanceCount()).toBe(2);
  expect(await (await lookup(f.x, f.init.idempotencyKey)).json()).toMatchObject({ status: 'succeeded' });
}

describe('AC-DM-09 / F-317 P2-1 原始批次键的统一故障出口（PG / PGlite）', () => {
  it.each<Stage>(['manifest', 'child', 'aggregate', 'aggregate-read', 'visibility-read'])(
    '%s：故障分类、原键回查与恢复均不受内部子命令影响',
    async (stage) => {
      const f = await fixture(stage);
      const { x, exits, init } = f;
      // 同一个客户端键曾有确定失败；本轮未知必须覆盖这条旧失败，不能误导客户端换新键。
      expect((await x.session.request('POST', path, { ...init, body: { items: [] } })).status).toBe(400);
      expect(await (await lookup(x, init.idempotencyKey)).json()).toMatchObject({ status: 'failed' });
      const cut = interrupt(x, init.idempotencyKey, exits[0]!.id, stage);
      let response: Response;
      try {
        response = await x.session.request('POST', path, init);
      } finally {
        cut.restore();
      }
      expect(cut.observed()).toEqual({ committed: true, readFailed: true });
      expect.soft(response.status).toBe(503);
      expect.soft((await response.json()).error.details).toEqual({
        reason: 'RESULT_UNKNOWN',
        commandId: init.idempotencyKey,
      });
      const counts = stage === 'manifest' || stage === 'aggregate-read' ? [0, 0] : stage === 'child' ? [1, 0] : [1, 1];
      for (const [index, exit] of exits.entries()) {
        expect(await x.requestRows(exit.id)).toHaveLength(counts[index]!);
      }
      const root = await lookup(x, init.idempotencyKey);
      // 最终台账已提交则以成功摘要为准；尚无最终台账时，未知只返回 404，绝不回放旧 failed。
      expect.soft(root.status).toBe(stage === 'aggregate' || stage === 'visibility-read' ? 200 : 404);
      if (stage === 'aggregate' || stage === 'visibility-read') {
        expect(await root.json()).toMatchObject({ status: 'succeeded', commandId: init.idempotencyKey });
      }
      const failures = await x.sqlRows<{ commandId: string; actor: string; outcome: string }>(sql`
        SELECT command_id AS "commandId", actor_user_id AS actor, outcome FROM audit_command_failures
        WHERE tenant_id=${x.tenantId} AND path='/api/tenant/employment/exits/handover/batch-submit'`);
      expect
        .soft(failures)
        .toContainEqual({ commandId: init.idempotencyKey, actor: x.session.user.id, outcome: 'unknown' });
      if (stage === 'manifest' || stage === 'child') {
        expect(failures.some((r) => r.commandId !== init.idempotencyKey && r.outcome === 'unknown')).toBe(true);
      }
      await recover(f);
    },
  );
});
