/**
 * AC-F476-09（P3 部分）：流转出口的幂等与同事务。
 * 自动处理的系统办理份与人工办理同一事务：任何一份写失败整笔回滚；同一命令 ID 重放不重复写份（含系统份）；
 * 转交 / 前加签同样整笔回滚；outbox 写入失败时办理份一并回滚。以全表增量对比，不只看办理份。
 */
import { sql, withTenant } from '@italent/db';
import { approverSource } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type FlowWorld, flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { APPROVAL, copiesOf } from './AC-F476-support.js';

const testDb = useTestDb();
const HRBP = approverSource('approval_subject_org_hrbp');
const SAME_SKIP = () =>
  oaNodes([{ actions: { transfer: true, addSign: true } }, { approver: HRBP, sameAssigneeSkip: true }]);

async function started(label: string, nodes = SAME_SKIP()) {
  const w = await flowWorld(testDb().db, label, { nodes });
  const { id } = await w.draft();
  await w.submitted(id);
  const view = await w.instance(id);
  return { w, id, instanceId: view.id, task: view.tasks.find((t) => t.status === 'pending')!, revision: view.revision };
}

/** 办理相关全表计数（回滚必须全部不变）。 */
async function tally(w: FlowWorld) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<Record<string, number>>(
      await tx.execute(sql`SELECT
        (SELECT count(*) FROM approval_instance_logs)::int AS logs,
        (SELECT count(*) FROM approval_tasks)::int AS tasks,
        (SELECT count(*) FROM approval_tasks WHERE status = 'pending')::int AS pending,
        (SELECT count(*) FROM approval_handling_contents)::int AS copies,
        (SELECT count(*) FROM approval_outbox)::int AS outbox,
        (SELECT count(*) FROM audit_events)::int AS audits,
        (SELECT approval_status FROM org_adjustments LIMIT 1)::int AS approval`),
    );
    return row!;
  });
}

/** 在 `table` 上装一个“满足 `when` 即抛错”的触发器，返回拆除函数。 */
async function inject(w: FlowWorld, table: string, when: string) {
  await w.db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION f476_p3_fail() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'f476 p3 injected failure'; END $$`),
    );
    await tx.execute(
      sql.raw(`CREATE TRIGGER f476_p3_fail BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${when})
        EXECUTE FUNCTION f476_p3_fail()`),
    );
  });
  return () =>
    w.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`DROP TRIGGER IF EXISTS f476_p3_fail ON ${table}`));
      await tx.execute(sql`DROP FUNCTION IF EXISTS f476_p3_fail()`);
    });
}

const approve = (w: FlowWorld, s: Awaited<ReturnType<typeof started>>, key?: string) =>
  w.call(
    'POST',
    `${APPROVAL}/tasks/${s.task.id}/approve`,
    { ifMatch: s.revision, ...(key ? { idempotencyKey: key } : {}), body: { comment: '合成意见' } },
    w.hrbp.userId,
  );

describe('AC-F476-09 流转出口：幂等与同事务', () => {
  it('同一命令 ID 重放（办理触发同人自动同意）：回执一致，人工 1 份 + 系统 1 份不重复；回查可见已办', async () => {
    const s = await started('f476-09p3-replay');
    const first = await approve(s.w, s, 'f476-09p3-key');
    expect(first.status, await first.clone().text()).toBe(200);
    const after = await tally(s.w);
    const replay = await approve(s.w, s, 'f476-09p3-key');
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(await first.text());
    expect(await tally(s.w)).toEqual(after);
    const copies = await copiesOf(s.w, s.instanceId);
    expect(copies.map((c) => c.handling_kind).sort()).toEqual(['human', 'system']);
    // 结果未知时的回查：按原单读取，状态已是办结
    expect((await s.w.instance(s.id)).status).toBe('approved');
  });

  it('系统办理份写失败：同一事务里的人工办理一并回滚（全表增量 0），修好后同一任务可重试', async () => {
    const s = await started('f476-09p3-system-fault');
    await copiesOf(s.w, s.instanceId); // 表存在性
    const remove = await inject(s.w, 'approval_handling_contents', `NEW.handling_kind = 'system'`);
    const before = await tally(s.w);
    try {
      const failed = await approve(s.w, s);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await tally(s.w)).toEqual(before);
    } finally {
      await remove();
    }
    const retry = await approve(s.w, s);
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await copiesOf(s.w, s.instanceId)).toHaveLength(2);
  });

  it('outbox 写入失败：办理（含办理份）整笔回滚', async () => {
    const s = await started('f476-09p3-outbox-fault');
    const remove = await inject(s.w, 'approval_outbox', 'true');
    const before = await tally(s.w);
    try {
      const failed = await approve(s.w, s);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await tally(s.w)).toEqual(before);
      expect(await copiesOf(s.w, s.instanceId)).toHaveLength(0);
    } finally {
      await remove();
    }
  });

  it('转交写份失败：转交整笔回滚（待办仍在原人名下），修好后可重试', async () => {
    const s = await started('f476-09p3-transfer-fault');
    const taker = await s.w.person('接手人', s.w.subject);
    const move = () =>
      s.w.call(
        'POST',
        `${APPROVAL}/tasks/${s.task.id}/transfer`,
        { ifMatch: s.revision, body: { toUserId: taker.userId, comment: '合成意见' } },
        s.w.hrbp.userId,
      );
    await copiesOf(s.w, s.instanceId);
    const remove = await inject(s.w, 'approval_handling_contents', 'true');
    const before = await tally(s.w);
    try {
      expect((await move()).status).toBeGreaterThanOrEqual(500);
      expect(await tally(s.w)).toEqual(before);
    } finally {
      await remove();
    }
    const retry = await move();
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect((await copiesOf(s.w, s.instanceId)).map((c) => c.action)).toEqual(['transfer']);
  });

  it('同键异内容（转交给另一个人）→ 409，不多写份', async () => {
    const s = await started('f476-09p3-transfer-conflict');
    const [a, b] = [await s.w.person('接手甲', s.w.subject), await s.w.person('接手乙', s.w.subject)];
    const move = (to: string) =>
      s.w.call(
        'POST',
        `${APPROVAL}/tasks/${s.task.id}/transfer`,
        { ifMatch: s.revision, idempotencyKey: 'f476-09p3-move', body: { toUserId: to, comment: '合成意见' } },
        s.w.hrbp.userId,
      );
    expect((await move(a.userId)).status).toBe(200);
    expect((await move(a.userId)).status).toBe(200);
    expect((await move(b.userId)).status).toBe(409);
    expect(await copiesOf(s.w, s.instanceId)).toHaveLength(1);
  });
});
