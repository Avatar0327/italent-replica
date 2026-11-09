/**
 * AC-F476-09（P1 部分）：幂等与同事务。同一命令 ID 重放只有一份办理份；同键异内容 409；
 * 办理份写入失败时整笔办理回滚（任务仍待办、日志 / 业务 / 审计 / outbox 全表增量为 0），修好后可重试。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { APPROVAL, copiesOf } from './AC-F476-support.js';

const testDb = useTestDb();

async function started(label: string) {
  const w = await flowWorld(testDb().db, label);
  const { id } = await w.draft();
  await w.submitted(id);
  const view = await w.instance(id);
  const task = view.tasks.find((t) => t.status === 'pending')!;
  return { w, id, instanceId: view.id, taskId: task.id, revision: view.revision };
}

/** 办理相关全表计数（回滚必须全部不变）。 */
async function tally(w: Awaited<ReturnType<typeof flowWorld>>) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<Record<string, number>>(
      await tx.execute(sql`SELECT
        (SELECT count(*) FROM approval_instance_logs)::int AS logs,
        (SELECT count(*) FROM approval_tasks WHERE status = 'pending')::int AS pending,
        (SELECT count(*) FROM approval_outbox)::int AS outbox,
        (SELECT count(*) FROM audit_events)::int AS audits,
        (SELECT approval_status FROM org_adjustments LIMIT 1)::int AS approval`),
    );
    return row!;
  });
}

describe('AC-F476-09 幂等与同事务', () => {
  it('同一命令 ID 重放：回执一致、只有一份办理份；同键异内容 409', async () => {
    const { w, id, instanceId, taskId, revision } = await started('f476-09-idem');
    const call = (comment: string) =>
      w.call(
        'POST',
        `${APPROVAL}/tasks/${taskId}/approve`,
        { ifMatch: revision, idempotencyKey: 'f476-09-key', body: { comment } },
        w.hrbp.userId,
      );
    const first = await call('合成意见');
    expect(first.status, await first.clone().text()).toBe(200);
    const replay = await call('合成意见');
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(await first.text());
    expect(await copiesOf(w, instanceId)).toHaveLength(1);
    const conflict = await call('另一段意见');
    expect(conflict.status).toBe(409);
    expect(await copiesOf(w, instanceId)).toHaveLength(1);
    expect((await w.state(id)).approval).toBe(1);
  });

  it('办理份写入失败：整笔办理回滚（全表增量 0），移除故障后同一任务可重试成功', async () => {
    const { w, id, instanceId, taskId, revision } = await started('f476-09-fault');
    await copiesOf(w, instanceId); // 表存在性（红点）
    await w.db.transaction(async (tx) => {
      await tx.execute(sql`CREATE OR REPLACE FUNCTION f476_fail_copy() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'f476 injected failure'; END $$`);
      await tx.execute(sql`CREATE TRIGGER f476_fail_copy BEFORE INSERT ON approval_handling_contents
        FOR EACH ROW EXECUTE FUNCTION f476_fail_copy()`);
    });
    const before = await tally(w);
    try {
      const failed = await w.call(
        'POST',
        `${APPROVAL}/tasks/${taskId}/approve`,
        { ifMatch: revision, body: { comment: '合成意见' } },
        w.hrbp.userId,
      );
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await tally(w)).toEqual(before);
      expect(await copiesOf(w, instanceId)).toHaveLength(0);
    } finally {
      await w.db.transaction(async (tx) => {
        await tx.execute(sql`DROP TRIGGER IF EXISTS f476_fail_copy ON approval_handling_contents`);
        await tx.execute(sql`DROP FUNCTION IF EXISTS f476_fail_copy()`);
      });
    }
    const retry = await w.call(
      'POST',
      `${APPROVAL}/tasks/${taskId}/approve`,
      { ifMatch: revision, body: { comment: '合成意见' } },
      w.hrbp.userId,
    );
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await copiesOf(w, instanceId)).toHaveLength(1);
    expect((await w.state(id)).approval).toBe(1);
  });
});
