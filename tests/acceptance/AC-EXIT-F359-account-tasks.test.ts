/**
 * F-359（DEC-684、F-327 R1 范围外）：提前停用 / 恢复账号任务的列表查看与失败重试。
 * 列表可按状态筛（失败项一眼可见），非法状态 400；重试只对失败 / 受阻项生效，已在排队（pending）或已终结的任务
 * 重试是无副作用的空操作（不涨 revision、不写审计、不再触发一轮消费）；同一 revision 的并发重试只有一个生效。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';

const database = useTestDb();
type World = Awaited<ReturnType<typeof downstreamWorld>>;
type Receipt = { businessId: string; status: string; reason: string | null; revision: number; attempts: number };

async function world(label: string) {
  const x = await downstreamWorld(database().db, `f359-${label}`);
  // 真实离职入口：10-04 保存最后工作日 10-04 的直接离职，10-05 调度生效并登记账号停用任务
  const exit = await x.directLeave('2026-10-04', { exitTypeCode: 'voluntary' });
  await x.runScheduler('2026-10-05T01:00:00Z');
  x.setNow('2026-10-06T01:00:00.000Z');
  return { x, exit };
}
const taskAudits = (x: World, id: string) =>
  x
    .sqlRows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_events
    WHERE tenant_id=${x.session.tenant.id} AND object_id=${id} AND action='employment.exit_account.task'`,
    )
    .then((rows) => rows[0]!.n);
/** 把任务改成指定状态（合成数据，模拟停用 / 恢复执行的各种结果），当前会话用户为待办接收人。 */
const setStatus = (x: World, id: string, status: string, reason: string | null) =>
  x.sqlRows(sql`UPDATE exit_account_tasks SET status=${status}, reason=${reason}, revision=revision+1,
    recipient_user_ids=ARRAY[${x.session.user.id}]::uuid[]
    WHERE tenant_id=${x.session.tenant.id} AND business_id=${id}::uuid`);
const task = async (x: World, id: string) =>
  (await (await x.session.request('GET', `/exit-account/tasks/${id}`)).json()) as Receipt;
const list = (x: World, query: string) => x.session.request('GET', `/exit-account/tasks${query}`);
const retry = (x: World, id: string, revision: number) =>
  x.session.request('POST', `/exit-account/tasks/${id}/retry`, {
    ifMatch: revision,
    idempotencyKey: crypto.randomUUID(),
    body: {},
  });

describe('F-359 提前停用任务列表与失败重试', () => {
  it('列表可按状态筛选：失败项只在 status=failed 里，其它状态筛不到；非法状态 400', async () => {
    const { x, exit } = await world('filter');
    await setStatus(x, exit.id, 'failed', 'SYNTHETIC_DISABLE_FAILED');
    const only = async (query: string) =>
      ((await (await list(x, query)).json()) as { items: Receipt[] }).items.map((item) => item.businessId);
    expect(await only('')).toEqual([exit.id]);
    expect(await only('?status=failed')).toEqual([exit.id]);
    expect(await only('?status=blocked')).toEqual([]);
    expect(await only('?status=disabled')).toEqual([]);
    const bad = await list(x, '?status=not-a-status');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it.each(['pending', 'disabled', 'restored', 'skipped'])(
    '%s 状态的任务重试是空操作：回执原样返回，revision 不涨，不写审计',
    async (status) => {
      const { x, exit } = await world(`noop-${status}`);
      await setStatus(x, exit.id, status, null);
      const before = await task(x, exit.id);
      const audits = await taskAudits(x, exit.id);
      const response = await retry(x, exit.id, before.revision);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ businessId: exit.id, status, revision: before.revision });
      expect(await task(x, exit.id)).toEqual(before);
      expect(await taskAudits(x, exit.id)).toBe(audits);
    },
  );

  it('失败项重试：转 pending 并写一条审计；同一 revision 的并发重试只有一个生效，另一个 409', async () => {
    const { x, exit } = await world('race');
    await setStatus(x, exit.id, 'failed', 'SYNTHETIC_DISABLE_FAILED');
    const before = await task(x, exit.id);
    const audits = await taskAudits(x, exit.id);
    const results = await Promise.all([retry(x, exit.id, before.revision), retry(x, exit.id, before.revision)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const after = await task(x, exit.id);
    expect(after.revision).toBeGreaterThan(before.revision);
    // 本次重试至少一条、至多两条审计（转 pending + 消费回写），败者不能再多写
    expect((await taskAudits(x, exit.id)) - audits).toBeLessThanOrEqual(2);
    const loser = results.find((response) => response.status === 409)!;
    expect(await loser.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  });
});
