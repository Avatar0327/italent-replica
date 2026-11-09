/**
 * AC-F476-11（P1 部分）：办理份表的约束与失败闭合。租户隔离（FORCE RLS）、只追加（UPDATE / DELETE / TRUNCATE 被拒）、
 * 同一办理日志只能一份、插入守卫（轮次 / 节点与任务不一致被拒）；缺份时已办读取 503，不退回现值（DEC-807）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld } from './AC-APV-support.js';
import { flowWorld, type FlowWorld } from './AC-OA-approval-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { copiesOf, expectTable, handledThenChanged, seenBy } from './AC-F476-support.js';

const testDb = useTestDb();

async function oneCopy() {
  const w = await flowWorld(testDb().db, 'f476-11');
  const { id } = await w.draft();
  await w.submitted(id);
  await w.acted(id, w.hrbp, 'approve');
  const instanceId = (await w.instance(id)).id;
  return { w, id, instanceId, copy: (await copiesOf(w, instanceId))[0]! };
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** 失败原因文本：驱动把真正的数据库报错放在 cause 链上。 */
const reasonOf = (error: unknown): string => {
  const parts: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) parts.push(e.message);
  return parts.join(' <- ');
};

const attempt = async (w: FlowWorld, run: (tx: Tx) => Promise<unknown>) =>
  withTenant(w.db, w.tenant.id, run).then(
    () => 'ok',
    (error: unknown) => reasonOf(error),
  );

/** 复制一份办理份并改字段后插入；freshLog=true 时先为它另造一条合法的办理日志（同实例 / 轮次 / 办理人，新序号）。 */
async function cloneCopy(tx: Tx, copyId: string, change: string, freshLog: boolean) {
  await tx.execute(sql`CREATE TEMP TABLE f476_clone ON COMMIT DROP AS
    SELECT * FROM approval_handling_contents WHERE id = ${copyId}::uuid`);
  await tx.execute(sql`UPDATE f476_clone SET id = gen_random_uuid()`);
  if (freshLog) {
    await tx.execute(sql`INSERT INTO approval_instance_logs
        (id, tenant_id, instance_id, seq, round, node_key, task_id, event, actor_user_id, detail)
      SELECT gen_random_uuid(), l.tenant_id, l.instance_id,
        (SELECT max(seq) + 1 FROM approval_instance_logs WHERE tenant_id = l.tenant_id AND instance_id = l.instance_id),
        l.round, l.node_key, l.task_id, l.event, l.actor_user_id, l.detail
      FROM approval_instance_logs l JOIN f476_clone c ON c.tenant_id = l.tenant_id AND c.handling_log_id = l.id`);
    await tx.execute(sql`UPDATE f476_clone SET handling_log_id = (SELECT id FROM approval_instance_logs
      WHERE tenant_id = f476_clone.tenant_id AND instance_id = f476_clone.instance_id ORDER BY seq DESC LIMIT 1)`);
  }
  await tx.execute(sql.raw(`UPDATE f476_clone SET ${change}`));
  await tx.execute(sql`INSERT INTO approval_handling_contents SELECT * FROM f476_clone`);
}

describe('AC-F476-11 表约束', () => {
  it('RLS：另一租户看不到本租户的办理份；FORCE RLS 已开启', async () => {
    const { w } = await oneCopy();
    const other = await approvalWorld(testDb().db, 'f476-11-other');
    const [own] = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM approval_handling_contents`)),
    );
    const [foreign] = await withTenant(other.db, other.tenant.id, async (tx) =>
      resultRows<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM approval_handling_contents`)),
    );
    expect(own!.n).toBeGreaterThan(0);
    expect(foreign!.n).toBe(0);
    const [flags] = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ rls: boolean; forced: boolean }>(
        await tx.execute(sql`SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
          WHERE relname = 'approval_handling_contents'`),
      ),
    );
    expect(flags).toEqual({ rls: true, forced: true });
  });

  it('只追加：UPDATE / DELETE / TRUNCATE 都被拒，行不变', async () => {
    const { w, instanceId, copy } = await oneCopy();
    expect(await attempt(w, (tx) => tx.execute(sql`UPDATE approval_handling_contents SET payload_bytes = 1`))).not.toBe(
      'ok',
    );
    expect(await attempt(w, (tx) => tx.execute(sql`DELETE FROM approval_handling_contents`))).not.toBe('ok');
    expect(await attempt(w, (tx) => tx.execute(sql`TRUNCATE approval_handling_contents`))).not.toBe('ok');
    expect(await copiesOf(w, instanceId)).toEqual([copy]);
  });

  it('同一办理日志只能一份（任务可有多份：前加签座位复活后再办理）', async () => {
    const { w, instanceId, copy } = await oneCopy();
    const error = await attempt(w, (tx) => cloneCopy(tx, copy.id, 'created_at = created_at', false));
    expect(error).toMatch(/duplicate key|unique/i);
    expect(await copiesOf(w, instanceId)).toHaveLength(1);
  });

  it('轮次或节点与任务不一致的插入被守卫拒绝（用独立的合法日志，不借唯一约束拦下）', async () => {
    const { w, instanceId, copy } = await oneCopy();
    for (const change of ['round = round + 1', `node_key = 'zzz'`]) {
      const error = await attempt(w, (tx) => cloneCopy(tx, copy.id, change, true));
      expect(error, change).toContain('approval_handling_contents 与任务 / 日志 / 实例不一致');
    }
    // 对照：同一份独立日志、不改字段 → 守卫放行（任务可有多份），证明上面的拒绝确实来自改动的字段
    expect(await attempt(w, (tx) => cloneCopy(tx, copy.id, 'created_at = created_at', true))).toBe('ok');
    expect(await copiesOf(w, instanceId)).toHaveLength(2);
  });
});

describe('AC-F476-11 失败闭合', () => {
  it('缺份：已办读取审批中心与组织调整两入口都 503，不回退现值', async () => {
    const w = await flowWorld(testDb().db, 'f476-11-missing');
    const s = await handledThenChanged(w);
    await expectTable(w);
    await w.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
      await tx.execute(sql`ALTER TABLE approval_handling_contents DISABLE TRIGGER USER`);
      await tx.execute(sql`DELETE FROM approval_handling_contents WHERE actor_user_id = ${w.hrbp.userId}::uuid`);
      await tx.execute(sql`ALTER TABLE approval_handling_contents ENABLE TRIGGER USER`);
    });
    const seen = await seenBy(w, s, w.hrbp.userId, false);
    expect(seen.orgStatus).toBe(503);
    const center = await w.call('GET', `/api/tenant/approval/instances/${s.instanceId}`, {}, w.hrbp.userId);
    expect(center.status).toBe(503);
    // 其他人的份不受影响
    expect((await seenBy(w, s, w.head.userId)).centerNames).toEqual(['ZZ_办理时名称']);
  });
});
