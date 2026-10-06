/**
 * AC-AUD-05（docs/02_业务建模/20 §2、§5 第 4 条；REQ-AUD-001 R5）：查询 7 个月前的日志。
 * 原站“一次最多查询最近 3 个月、最远只能查 6 个月内”；复刻版把查询期与保留期做成租户级配置
 * （系统预置 audit.retention = { queryMonths: 3, retainMonths: 6 }，租户可覆盖、可恢复，AC-TEN-03）。
 * 保留期由定时清理执行：只删本租户超过保留期的日志；审计表对应用角色仍只追加（不能直接 DELETE / TRUNCATE）。
 */
import { runAuditRetention } from '@italent/api';
import { pgErrorCode, sql, withPlatform, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { auditApi } from './AC-AUD-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { creatorOf } from '../../apps/api/src/modules/permission/scope-audit.js';

const testDb = useTestDb();
const SEVEN_MONTHS_AGO = '2026-03-01T01:00:00.000Z';
const NOW = '2026-10-01T01:00:00.000Z';

async function tenantWithOldLog(db: Db, label: string, retention?: { queryMonths: number; retainMonths: number }) {
  const session = await employmentSession(db, label);
  session.setNow(SEVEN_MONTHS_AGO);
  const department = await session.org('七个月前的部门', { establishedOn: '2026-01-01' });
  const employee = await session.employee('七个月前的员工');
  const hire = await session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2026-03-01', fields: { departmentId: department.id } },
    employee.revision,
  );
  const edited = await session.request('PATCH', `/records/${hire.id}`, {
    ifMatch: hire.revision,
    body: { fields: { place: '七个月前的地点' } },
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  if (retention) {
    const response = await tenantApi(db).request('PUT', '/api/tenant/settings/audit.retention', {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: 0,
      body: { value: retention },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  return { session, employee, hire, as: { user: session.user.id, tenant: session.tenant.id } };
}

async function logCount(db: Db, tenantId: string, objectId: string, action: string): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
      WHERE object_id=${objectId} AND action=${action}`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { n: number }[];
    return rows[0]!.n;
  });
}

describe('AC-AUD-05 查询期与保留期按租户配置', () => {
  it('默认（保留 6 个月）：7 个月前的日志查不到，跨度超过 3 个月的查询被拒绝', async () => {
    const { db } = testDb();
    const w = await tenantWithOldLog(db, 'aud05-default');
    const audit = auditApi(db, NOW);
    const old = await audit.get('/data-changes?from=2026-02-25&to=2026-03-05', w.as);
    expect(old.status).toBe(400);
    expect(await old.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { reason: 'AUDIT_BEYOND_RETENTION', earliest: '2026-04-01' } },
    });
    const wide = await audit.get('/data-changes?from=2026-05-01&to=2026-09-30', w.as);
    expect(wide.status).toBe(400);
    expect(await wide.json()).toMatchObject({ error: { details: { reason: 'AUDIT_QUERY_WINDOW_TOO_LONG' } } });
    // 不带时间条件时默认查最近 3 个月（按租户时区的业务日期）
    const recent = await audit.dataChanges(w.as);
    expect(recent.window).toEqual({ from: '2026-07-01', to: '2026-10-01', earliest: '2026-04-01' });
    expect(recent.items.some((item) => item.objectId === w.employee.id)).toBe(false);
  });

  it('租户把保留期改为 12 个月：7 个月前的日志可以查到', async () => {
    const { db } = testDb();
    const w = await tenantWithOldLog(db, 'aud05-longer', { queryMonths: 3, retainMonths: 12 });
    const audit = auditApi(db, NOW);
    const found = await audit.dataChanges(w.as, { from: '2026-02-25', to: '2026-03-05' });
    expect(found.window.earliest).toBe('2025-10-01');
    expect(found.items).toContainEqual(
      expect.objectContaining({ objectId: w.employee.id, operation: 'create', occurredAt: SEVEN_MONTHS_AGO }),
    );
    expect(found.items).toContainEqual(
      expect.objectContaining({ objectId: w.hire.id, action: 'employment.record.edit', operation: 'update' }),
    );
  });

  it('定时清理按各租户保留期删除过期日志，并留下清理记录；应用角色不能直接删改审计', async () => {
    const { db } = testDb();
    const short = await tenantWithOldLog(db, 'aud05-purge-default');
    const long = await tenantWithOldLog(db, 'aud05-purge-long', { queryMonths: 3, retainMonths: 12 });
    const EDIT = 'employment.record.edit';
    expect(await logCount(db, short.session.tenant.id, short.hire.id, EDIT)).toBe(1);

    for (const target of [short, long]) {
      await expect(
        withTenant(db, target.session.tenant.id, (tx) => tx.execute(sql`DELETE FROM audit_events`)),
      ).rejects.toThrow();
      await expect(
        withTenant(db, target.session.tenant.id, (tx) => tx.execute(sql`UPDATE audit_events SET action='x'`)),
      ).rejects.toThrow();
    }

    const clock = () => new Date(NOW);
    const shortRun = await runAuditRetention(db, cmd(), { tenantId: short.session.tenant.id }, { clock });
    expect(shortRun.runs).toEqual([
      expect.objectContaining({ tenantId: short.session.tenant.id, retainMonths: 6, cutoff: '2026-04-01' }),
    ]);
    expect(shortRun.runs[0]!.purged.dataChanges).toBeGreaterThan(0);
    await runAuditRetention(db, cmd(), { tenantId: long.session.tenant.id }, { clock });

    expect(await logCount(db, short.session.tenant.id, short.hire.id, EDIT)).toBe(0);
    expect(await logCount(db, long.session.tenant.id, long.hire.id, EDIT)).toBe(1);
    // DEC-198：保留期严格执行，首个新增事件同样清理；「创建人」只以最小元数据（对象、创建人、创建时间）另存
    const CREATE = 'employment.employee.create';
    expect(await logCount(db, short.session.tenant.id, short.employee.id, CREATE)).toBe(0);
    await withTenant(db, short.session.tenant.id, async (tx) => {
      const creator = await creatorOf(tx, short.session.tenant.id, short.employee.id, CREATE, 'employment_employee');
      expect(creator).toBe(short.session.user.id);
      const result = await tx.execute(sql`SELECT * FROM audit_object_creators WHERE object_id=${short.employee.id}`);
      const rows = (Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows) as Record<
        string,
        unknown
      >[];
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!).sort()).toEqual(
        ['action', 'created_at', 'creator_user_id', 'object_id', 'object_type', 'tenant_id'].sort(),
      );
    });

    // 清理本身留痕：操作人“系统”、来源动作“定时任务”
    const operations = await auditApi(db, NOW).operationLogs(short.as, { behavior: 'purge' });
    expect(operations.items).toEqual([
      expect.objectContaining({
        behaviorLabel: '日志清理',
        operator: { userId: null, name: '系统' },
        successCount: shortRun.runs[0]!.purged.total,
      }),
    ]);
  });

  it('P2-2：清理函数不对业务角色开放；保留月数只取租户配置；直接调用也原子留痕', async () => {
    const { db } = testDb();
    const short = await tenantWithOldLog(db, 'aud05-guard-default');
    const long = await tenantWithOldLog(db, 'aud05-guard-long', { queryMonths: 3, retainMonths: 12 });
    const tenantId = short.session.tenant.id;
    const denied = await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`SELECT * FROM purge_expired_audit(${tenantId}::uuid, ${NOW}::timestamptz, 1000)`),
    ).catch((error: unknown) => error);
    expect(pgErrorCode(denied)).toBe('42501');
    // 旧签名（调用方传保留月数）不再存在
    await expect(
      withPlatform(db, (tx) => tx.execute(sql`SELECT * FROM purge_expired_audit(${tenantId}::uuid, 1, now())`)),
    ).rejects.toThrow();
    const purge = (id: string) =>
      withPlatform(db, async (tx) => {
        const result = await tx.execute(sql`SELECT * FROM purge_expired_audit(${id}::uuid, ${NOW}::timestamptz, 1000)`);
        return (
          (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Record<string, unknown>[]
        )[0]!;
      });
    expect(await purge(long.session.tenant.id)).toMatchObject({ retain_months: 12, data_changes: 0 });
    expect(await logCount(db, long.session.tenant.id, long.hire.id, 'employment.record.edit')).toBe(1);
    const purged = await purge(tenantId);
    expect(purged).toMatchObject({ retain_months: 6, cutoff: '2026-04-01' });
    expect(Number(purged.data_changes)).toBeGreaterThan(0);
    const operations = await auditApi(db, NOW).operationLogs(short.as, { behavior: 'purge' });
    expect(operations.items).toHaveLength(1);
  });
});
