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

const attempt = async (w: FlowWorld, run: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<unknown>) =>
  withTenant(w.db, w.tenant.id, run).then(
    () => 'ok',
    (error: unknown) => String(error),
  );

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

  it('同一办理日志只能一份（任务可有多份：前加签座位复活后再办理）；轮次或节点与任务不一致的插入被拒', async () => {
    const { w, instanceId, copy } = await oneCopy();
    const clone = (change: string) =>
      attempt(w, async (tx) => {
        await tx.execute(sql`CREATE TEMP TABLE f476_clone ON COMMIT DROP AS
          SELECT * FROM approval_handling_contents WHERE id = ${copy.id}::uuid`);
        await tx.execute(sql`UPDATE f476_clone SET id = gen_random_uuid()`);
        await tx.execute(sql.raw(`UPDATE f476_clone SET ${change}`));
        await tx.execute(sql`INSERT INTO approval_handling_contents SELECT * FROM f476_clone`);
      });
    expect(await clone('created_at = created_at')).not.toBe('ok'); // 同日志重复
    expect(await clone(`round = round + 1`)).not.toBe('ok');
    expect(await clone(`node_key = 'zzz'`)).not.toBe('ok');
    expect(await copiesOf(w, instanceId)).toHaveLength(1);
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
