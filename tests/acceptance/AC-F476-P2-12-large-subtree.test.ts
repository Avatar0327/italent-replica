/**
 * AC-F476-12 / 01（P2 返工）：调整范围下级再多，办理也不能因为“多冻结了一份预览输入”而新增失败（设计 §3.5：
 * 不得让提交成功的合法单据到最后审批时才必然失败）。预览树本身受 DEC-728 的 2000 节点上限约束，超出 413：
 * - 子树 ≤ 2000：冻结完整（节点、编制原值逐项一致，事后改编制不漂移），体积远小于 16 MiB；
 * - 子树 > 2000：办理照常成功，办理份记下“超限”，已办预览 / 导出与现值读同一个 413，详情 / 明细仍读冻结份。
 * 错误优先级与现值读一致：先读编制（汇总预算超限 503），再数节点（超限 413）；同时超限时两者都是 503。
 * 夹具一条 SQL 铺下级；断言只看 HTTP 响应与办理份体积。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { APPROVAL } from './AC-F476-support.js';
import { flowWorld } from './AC-OA-approval-support.js';
import { bodyOf, expectError } from './AC-OA-head-support.js';
import { rename } from './AC-OA-items-support.js';
import { flatten, reader } from './AC-OA-read-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { NAME_A } from './AC-F476-support.js';
import {
  exportRes,
  exported,
  localCapacity,
  nodeOf,
  payloadBytes,
  raiseLocalCapacity,
  seedChildren,
} from './AC-F476-P2-support.js';

const testDb = useTestDb();
// 大子树在 PGlite（WASM 单线程）里要跑几十分钟：只在真 PostgreSQL 跑（CI 的 PG 分片；本地 pnpm test:pg）
const onRealPg = describe.skipIf(!process.env.TEST_DATABASE_URL);
const MIB = 1024 * 1024;

/** 响应的错误口径（状态码、错误码、文案）；成功响应没有错误体。 */
const refusalOf = async (res: Response) => ({
  status: res.status,
  code: (await bodyOf(res)).error?.code,
  message: (await bodyOf(res)).error?.message,
});

onRealPg('AC-F476-12 大子树的办理与冻结（真 PostgreSQL）', { timeout: 600_000 }, () => {
  it('10,002 个节点、根组织有「仅本级」编制：办理成功（不因编制汇总预算 503）；已办预览 / 导出与现值读同为 503（编制预算先于节点数判断），详情仍读冻结份', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-big-local');
    await seedChildren(w, w.a, 10_001);
    await localCapacity(w, w.a, 5);
    const { id } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'approve');

    const bytes = await payloadBytes(w, (await w.instance(id)).id);
    expect(bytes).toHaveLength(1);
    expect(bytes[0]).toBeLessThan(MIB);
    await expectError(await reader(w).previewRes(id, w.hrbp.userId), 503, 'SERVICE_UNAVAILABLE');
    await expectError(await exportRes(w, id, w.hrbp.userId), 503, 'SERVICE_UNAVAILABLE');
    const detail = await reader(w).detail(id, w.hrbp.userId);
    expect(detail.id).toBe(id);
    expect((await reader(w).items(id, w.hrbp.userId)).items.map((item) => item.name)).toEqual([NAME_A]);
  });

  it('25,000 个节点、名称各 200 字：办理成功（不因 16 MiB 上限 413），办理份仍远小于上限', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-big-size');
    await seedChildren(w, w.a, 24_999, { nameLength: 200 });
    const { id } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'approve');

    const bytes = await payloadBytes(w, (await w.instance(id)).id);
    expect(bytes).toHaveLength(1);
    expect(bytes[0]).toBeLessThan(MIB);
    await expectError(await reader(w).previewRes(id, w.hrbp.userId), 413, 'PAYLOAD_TOO_LARGE');
  });

  it('恰好 2001 个节点：办理成功，已办预览与现值读同样 413（上限边界）', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-big-edge');
    await seedChildren(w, w.a, 2000);
    const { id } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    await expectError(await reader(w).previewRes(id, w.hr.id), 413, 'PAYLOAD_TOO_LARGE'); // 现值读：发起人
    await w.acted(id, w.hrbp, 'approve');
    await expectError(await reader(w).previewRes(id, w.hrbp.userId), 413, 'PAYLOAD_TOO_LARGE');
  });

  it('恰好 2000 个节点（名称 200 字、「仅本级」编制）：冻结完整，节点数与编制原值逐项一致，事后改编制不漂移，体积远小于 16 MiB', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-big-full');
    const [one, two, three] = await seedChildren(w, w.a, 1999, { nameLength: 200, keep: 3 });
    const scheme = await localCapacity(w, w.a, 5);
    for (const [org, local] of [
      [one, 1],
      [two, 2],
      [three, 3],
    ] as const)
      await localCapacity(w, org!, local, scheme);
    const { id } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'approve');

    const view = await reader(w).preview(id, w.hrbp.userId);
    const nodes = flatten(view.roots);
    expect(nodes).toHaveLength(2000);
    const values = (orgId: string) => nodeOf(view, orgId).establishment;
    expect([w.a, one!, two!, three!].map(values)).toEqual([11, 1, 2, 3]);
    expect(nodes.filter((node) => node.establishment !== null)).toHaveLength(4);
    const instanceId = (await w.instance(id)).id;
    const [bytes] = await payloadBytes(w, instanceId);
    expect(bytes).toBeGreaterThan(0.2 * MIB); // 确实带了整棵子树
    expect(bytes).toBeLessThan(2 * MIB);

    // 事后改编制：发起人读现值（含下级 11 → 106），已办仍是办理时的 11
    await raiseLocalCapacity(w, w.a, 100);
    expect(nodeOf(await reader(w).preview(id, w.hr.id), w.a).establishment).toBe(106);
    expect(nodeOf(await reader(w).preview(id, w.hrbp.userId), w.a).establishment).toBe(11);
    expect((await exported(w, id, w.hrbp.userId)).svg).toContain('>11<');
  });

  it('根组织下 10,001 个已停用 / 未启用的下级只计入编制汇总范围：办理成功，已办预览与现值读同一个 503', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-big-disabled');
    await seedChildren(w, w.a, 10_001, { enabled: false });
    await localCapacity(w, w.a, 5);
    const { id } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    const live = await reader(w).previewRes(id, w.hr.id); // 现值读：汇总范围超预算，503（既有行为）
    await expectError(live, 503, 'SERVICE_UNAVAILABLE');
    await w.acted(id, w.hrbp, 'approve'); // 办理不能因此失败
    expect(await payloadBytes(w, (await w.instance(id)).id)).toHaveLength(1);
    await expectError(await reader(w).previewRes(id, w.hrbp.userId), 503, 'SERVICE_UNAVAILABLE');
    expect((await reader(w).detail(id, w.hrbp.userId)).id).toBe(id);
  });

  describe.each([
    ['节点与编制预算同时超限（现值先撞编制预算 503，不是 413）', 10_001, true, 503, 'SERVICE_UNAVAILABLE'],
    ['仅节点超限（413）', 2_500, false, 413, 'PAYLOAD_TOO_LARGE'],
    ['仅编制预算超限（启用节点不超 2000，503）', 10_001, 'disabled', 503, 'SERVICE_UNAVAILABLE'],
  ] as const)('冻结读与办理前现值读同口径：%s', (_label, children, capacity, status, code) => {
    it('预览与导出的状态码、错误码、文案办理前后逐项相同', async () => {
      const w = await flowWorld(testDb().db, `f476p2-same-${status}-${children}-${capacity}`);
      await seedChildren(w, w.a, children, { enabled: capacity !== 'disabled' });
      if (capacity) await localCapacity(w, w.a, 5);
      const { id } = await w.draft(rename(w.a, { name: NAME_A }));
      await w.submitted(id);
      const readAll = async (user: string) => [
        await refusalOf(await reader(w).previewRes(id, user)),
        await refusalOf(await exportRes(w, id, user)),
      ];

      const live = await readAll(w.hr.id); // 办理前：发起人读现值
      for (const entry of live) expect(entry).toMatchObject({ status, code });
      await w.acted(id, w.hrbp, 'approve');
      expect(await readAll(w.hrbp.userId)).toEqual(live); // 办理后：冻结读，错误口径一字不差
    });
  });

  it('大子树单据办理时办理份写入失败：整笔回滚（任务 / 日志 / 办理份无残留），移除故障后可重试成功', async () => {
    const w = await flowWorld(testDb().db, 'f476p2-big-rollback');
    await seedChildren(w, w.a, 2500);
    const { id } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    const view = await w.instance(id);
    const task = view.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === w.hrbp.userId)!;
    const tally = () =>
      withTenant(w.db, w.tenant.id, async (tx) =>
        resultRows<Record<string, number>>(
          await tx.execute(sql`SELECT (SELECT count(*) FROM approval_instance_logs)::int AS logs,
            (SELECT count(*) FROM approval_tasks WHERE status = 'pending')::int AS pending,
            (SELECT count(*) FROM approval_handling_contents)::int AS copies`),
        ),
      );
    const call = () =>
      w.call(
        'POST',
        `${APPROVAL}/tasks/${task.id}/approve`,
        { ifMatch: view.revision, body: { comment: '合成意见' } },
        w.hrbp.userId,
      );
    await w.db.transaction(async (tx) => {
      await tx.execute(sql`CREATE OR REPLACE FUNCTION f476_big_fail() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'f476 injected failure'; END $$`);
      await tx.execute(sql`CREATE TRIGGER f476_big_fail BEFORE INSERT ON approval_handling_contents
        FOR EACH ROW EXECUTE FUNCTION f476_big_fail()`);
    });
    const before = await tally();
    try {
      expect((await call()).status).toBeGreaterThanOrEqual(500);
      expect(await tally()).toEqual(before);
    } finally {
      await w.db.transaction(async (tx) => {
        await tx.execute(sql`DROP TRIGGER IF EXISTS f476_big_fail ON approval_handling_contents`);
        await tx.execute(sql`DROP FUNCTION IF EXISTS f476_big_fail()`);
      });
    }
    const retry = await call();
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await payloadBytes(w, view.id)).toHaveLength(1);
  });
});
