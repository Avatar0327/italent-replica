/**
 * AC-TRF-32 / AC-TEN-05（DEC-056）：服务器时钟为 UTC，定时任务按各租户时区判定业务日；
 * 北京时间 10-01 00:30（UTC 09-30 16:30）运行即生效，不因 UTC 日期仍是 09-30 推迟；UTC 租户到 UTC 10-01 才生效。
 * 审计事件时间以 UTC 存储，按租户时区换算为业务日。另：停用 / 恢复隔离中的租户不运行（DEC-061）。
 */
import { randomUUID } from 'node:crypto';
import { runEmploymentActivations } from '@italent/api';
import { setTenantStatus, sql, withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { resultRows } from './AC-ORG-support.js';
import { cmd } from './support/tenant-api.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';

const testDb = useTestDb();

async function approvedTransfer(w: ActivationWorld) {
  const { employee } = await w.hired();
  const approved = await w.approve(
    await w.apply(employee.id, '2026-10-01', { departmentId: w.to.id }),
    '2026-09-20T02:00:00Z',
  );
  expect(approved.status).toBe('approved');
  return approved;
}

async function sweep(at: string, tenantIds: readonly string[]) {
  const runs = [];
  for (const tenantId of tenantIds) {
    const result = await runEmploymentActivations(testDb().db, cmd(), { tenantId }, { clock: () => new Date(at) });
    runs.push(...result.runs);
  }
  return runs;
}

describe('AC-TRF-32 / AC-TEN-05 按租户时区判定生效日', () => {
  it('UTC 09-30 16:30 运行：上海租户已到 10-01 生效，UTC 租户仍为审批通过，到 UTC 10-01 才生效', async () => {
    const shanghai = await activationWorld(testDb().db, 'trf32-shanghai', { today: '2026-09-20' });
    const utc = await activationWorld(testDb().db, 'trf32-utc', { timezone: 'UTC', today: '2026-09-20' });
    expect(shanghai.session.tenant.timezone).toBe('Asia/Shanghai');
    const a = await approvedTransfer(shanghai);
    const b = await approvedTransfer(utc);
    const tenants = [shanghai.session.tenant.id, utc.session.tenant.id];

    // 北京时间 09-30 23:59：两边都未到。
    const beforeMidnight = await sweep('2026-09-30T15:59:00Z', tenants);
    expect(beforeMidnight.map((run) => [run.businessDate, run.activated])).toEqual([
      ['2026-09-30', []],
      ['2026-09-30', []],
    ]);

    // 跨过北京时间午夜：上海租户的业务日是 10-01，生效；UTC 租户的业务日仍是 09-30。
    const [sh, u] = await sweep('2026-09-30T16:30:00Z', tenants);
    expect(sh).toMatchObject({ businessDate: '2026-10-01', activated: [a.id] });
    expect(u).toMatchObject({ businessDate: '2026-09-30', activated: [] });
    expect((await sweep('2026-09-30T17:00:00Z', [utc.session.tenant.id]))[0]!.activated).toEqual([]);
    expect(await utc.business(b.id)).toMatchObject({ status: 'approved', record: null });

    const created = (await shanghai.auditEvents(a.id)).find((event) => event.action === 'employment.record.create');
    const occurredAt = new Date(created!.occurredAt);
    expect(occurredAt.toISOString()).toBe('2026-09-30T16:30:00.000Z');
    expect(tenantLocalDate(occurredAt, 'Asia/Shanghai')).toBe('2026-10-01');

    const [late] = await sweep('2026-10-01T00:00:30Z', [utc.session.tenant.id]);
    expect(late).toMatchObject({ businessDate: '2026-10-01', activated: [b.id] });
    expect(await utc.business(b.id)).toMatchObject({ status: 'effective', record: { effectiveDate: '2026-10-01' } });
  });

  it('不指定租户时遍历全部启用租户；停用租户不运行', async () => {
    const active = await activationWorld(testDb().db, 'trf32-all-active', { today: '2026-09-20' });
    const suspended = await activationWorld(testDb().db, 'trf32-all-suspended', { today: '2026-09-20' });
    const a = await approvedTransfer(active);
    const s = await approvedTransfer(suspended);
    await setTenantStatus(
      testDb().db,
      {
        tenantId: suspended.session.tenant.id,
        status: 'suspended',
        expectedRevision: suspended.session.tenant.revision,
      },
      cmd(),
    );
    const result = await runEmploymentActivations(
      testDb().db,
      cmd(),
      {},
      {
        clock: () => new Date('2026-09-30T17:00:00Z'),
      },
    );
    const byTenant = new Map(result.runs.map((run) => [run.tenantId, run]));
    expect(byTenant.get(active.session.tenant.id)).toMatchObject({ activated: [a.id] });
    expect(byTenant.has(suspended.session.tenant.id)).toBe(false);
    const stored = await withTenant(testDb().db, suspended.session.tenant.id, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM employment_records WHERE id=${s.id}::uuid`),
    );
    expect(resultRows<{ n: number }>(stored)[0]!.n).toBe(0);
  });

  it('运维手动触发受平台命令约束：同一命令 ID 重放首次结果，不重复运行', async () => {
    const w = await activationWorld(testDb().db, 'trf32-manual', { today: '2026-09-20' });
    const approved = await approvedTransfer(w);
    const meta = { actorUserId: null, commandId: randomUUID() };
    const clock = { clock: () => new Date('2026-09-30T17:00:00Z') };
    const first = await runEmploymentActivations(testDb().db, meta, { tenantId: w.session.tenant.id }, clock);
    expect(first.runs[0]).toMatchObject({ activated: [approved.id] });
    const replay = await runEmploymentActivations(testDb().db, meta, { tenantId: w.session.tenant.id }, clock);
    expect(replay).toEqual(first);
    await expect(
      runEmploymentActivations(testDb().db, meta, { tenantId: w.session.tenant.id, limit: 5 }, clock),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // 租户接口上没有触发入口：定时任务只能经平台路径运行。
    const probe = await w.session.request('POST', '/activation-runs', { body: {} });
    expect(probe.status).toBe(404);
  });
});
