/**
 * BE-7 PT-3c AC-FWD-11（docs/08_设计/R2-T05_兼职设计.md §3.1 / §5.1，07 §2 条件② 与表第 26 行，PB-08 / PB-25 HTTP 版）：
 * 编辑兼职（直线经理等非日期字段、结束日期）只改本记录：不触发向后更新预览或执行，主职链与在途主职申请不动，
 * 不写 employment.forward-update / employment.record.edit 审计；反过来主职补录 / 编辑也不改兼职（PB-08 在 AC-PT-primary-guards）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { httpWorld } from './AC-PT-http-support.js';

const database = useTestDb();

describe('AC-FWD-11 / PB-25 编辑兼职不触发向后更新', () => {
  it('编辑兼职直线经理与结束日期：主职时间轴与后续主职记录不变，无向后更新 / 任职记录编辑审计，其他业务不动', async () => {
    const w = await httpWorld(database().db, 'fwd11-part-time');
    // 主职链上有一条后续记录（向后更新的潜在目标）
    await w.business(
      w.employeeId,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01' },
      (await w.getEmployee(w.employeeId)).revision,
    );
    const record = await w.make({ endDate: '2026-12-31' });
    const manager = await w.colleague('新经理');
    const primaryBefore = await w.primaryView();
    const rowsBefore = await w.records(w.employeeId);
    const businesses = () =>
      withTenant(w.db, w.tenantId, async (tx) =>
        rowsOf<{ n: number }>(
          await tx.execute(sql`SELECT count(*)::int AS n FROM employment_payload_versions
            WHERE tenant_id=${w.tenantId} AND business_id <> ${record.id} AND employee_id=${w.employeeId}`),
        ),
      );
    const otherPayloads = await businesses();
    const edited = await w.ok(
      await w.edit(record.id, { endDate: '2026-12-01', fields: { directManagerId: manager.id } }, record.revision),
    );
    expect(edited).toMatchObject({ fields: { directManagerId: manager.id }, endDate: '2026-12-01' });
    expect(await w.primaryView()).toEqual(primaryBefore);
    expect(await w.records(w.employeeId)).toEqual(rowsBefore);
    expect(await businesses()).toEqual(otherPayloads);
    const actions = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ action: string }>(
        await tx.execute(sql`SELECT DISTINCT action FROM audit_events WHERE tenant_id=${w.tenantId}
          AND action IN ('employment.forward-update', 'employment.record.edit')`),
      ),
    );
    expect(actions).toEqual([]);
  });
});
