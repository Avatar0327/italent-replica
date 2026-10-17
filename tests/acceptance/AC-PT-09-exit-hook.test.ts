/**
 * AC-PT-09（结束）离职 / 退休结束兼职（docs/08_设计/R2-T05_兼职设计.md §4.6，§3.3 S6 / S7 / S11，§9 PB-28 / PB-29；PT-3a）：
 * 订阅方 `part-time` 在离职落地的同一事务里，把该任职周期的每条兼职结束于 L′（= 离职实际生效日 − 1）：
 * 当前结束日为空或晚于 L′ 的追加期限；开始日晚于 L′ 的写空区间；source = exit、source_id = 离职记录。
 * 原站对“离职对兼职”的结果未验证（B-4 / A-3），复刻取最保守：员工不在职就不能有进行中的兼职。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { PART_TIME_EXIT_HOOKS } from '../../apps/api/src/modules/employment/part-time/exit-hook.js';
import { insertPartTimeRecord } from './AC-PT-support.js';
import { serviceWorld } from './AC-PT-service-support.js';

const database = useTestDb();

describe('AC-PT-09 离职落地结束兼职', () => {
  it('PB-28（S6）：P1 无结束 / P2 结束日更晚 → 结束于 L′；P3 开始于离职之后 → 空区间；已更早结束的不动；均 source = exit', async () => {
    const w = await serviceWorld(database().db, 'pt09-exit');
    const p1 = await w.create({ startDate: '2026-09-01', endDate: null });
    const p2 = await w.create({ startDate: '2026-09-10', endDate: '2026-12-31', serviceType: 'secondment' });
    const p3 = await w.create({ startDate: '2026-09-20', endDate: null });
    const early = await w.create({ startDate: '2026-09-02', endDate: '2026-09-05' });
    const revisions = await Promise.all([p1, p2, p3, early].map((item) => w.headRevision(item.id)));
    const exit = await w.leave('2026-09-15');
    expect(await w.terms(p1.id)).toEqual([
      { term_no: 1, end_date: null, source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-09-15', source: 'exit', source_id: exit.id },
    ]);
    expect((await w.terms(p2.id)).at(-1)).toEqual({
      term_no: 2,
      end_date: '2026-09-15',
      source: 'exit',
      source_id: exit.id,
    });
    expect((await w.terms(p3.id)).at(-1)).toEqual({
      term_no: 2,
      end_date: '2026-09-19',
      source: 'exit',
      source_id: exit.id,
    });
    expect(await w.terms(early.id)).toHaveLength(1);
    // 被改期限的兼职记录 revision +1，没动的不变
    expect(await Promise.all([p1, p2, p3, early].map((item) => w.headRevision(item.id)))).toEqual([
      revisions[0]! + 1,
      revisions[1]! + 1,
      revisions[2]! + 1,
      revisions[3],
    ]);
    // 审计 / outbox 按兼职部门归属，同事务写入
    const audits = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ object_id: string; scope_org_id: string }>(
        await tx.execute(sql`SELECT object_id, scope_org_id FROM audit_events
          WHERE tenant_id=${w.tenantId} AND action='employment.part_time.ended_by_exit' ORDER BY object_id`),
      ),
    );
    expect(audits.map((row) => row.object_id).sort()).toEqual([p1.id, p2.id, p3.id].sort());
    expect(new Set(audits.map((row) => row.scope_org_id))).toEqual(new Set([w.partTimeOrg.id]));
    const queued = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM employment_outbox
          WHERE tenant_id=${w.tenantId} AND event_type='employment.part_time.ended_by_exit'`),
      ),
    );
    expect(queued[0]!.n).toBe(3);
  });

  it('S6：其他员工的兼职不受影响（只按离职员工的任职周期结束）', async () => {
    const w = await serviceWorld(database().db, 'pt09-other');
    const other = await w.employee('另一名员工');
    await w.business(
      other.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: w.primaryOrg.id } },
      other.revision,
    );
    const stranger = await withTenant(w.db, w.tenantId, (tx) =>
      insertPartTimeRecord(tx, {
        tenantId: w.tenantId,
        employeeId: other.id,
        departmentId: w.partTimeOrg.id,
        startDate: '2026-09-01',
        endDate: null,
      }),
    );
    await w.leave('2026-09-15');
    expect(await w.terms(stranger)).toHaveLength(1);
  });

  it('PB-29（S7）：事件携带顺延后的生效日，兼职结束于 E′ − 1 而不是原计划日；重复通知幂等（不再追加期限）', async () => {
    const w = await serviceWorld(database().db, 'pt09-postponed');
    const record = await w.seedPartTime({ startDate: '2026-09-01', endDate: null });
    const exit = await w.leave('2026-09-15');
    // leave() 落地时钩子已把 record 结束于 09-15；这里再模拟“顺延到 09-18 生效”的通知：区间已更短，不追加
    const notify = (effectiveDate: string) =>
      withTenant(w.db, w.tenantId, async (tx) => {
        const context = w.context();
        await PART_TIME_EXIT_HOOKS.onRecordMaterialized!(tx, context, {
          employeeId: w.employeeId,
          recordId: exit.id,
          kind: 'leave',
          effectiveDate,
          lastWorkDate: null,
          employeeStatus: 8,
        });
      });
    await notify('2026-09-18');
    expect(await w.terms(record)).toHaveLength(2);
    // 另一条在顺延事件之前被可信造数、结束日晚于 E′ − 1 的兼职，按事件日期结束于 09-17
    const later = await w.seedPartTime({ startDate: '2026-09-01', endDate: '2026-12-31' });
    await notify('2026-09-18');
    expect((await w.terms(later)).at(-1)).toEqual({
      term_no: 2,
      end_date: '2026-09-17',
      source: 'exit',
      source_id: exit.id,
    });
    await notify('2026-09-18');
    expect(await w.terms(later)).toHaveLength(2);
  });

  it('S11：退休同样结束兼职；其他业务类型（调动、转正）的落地不动兼职', async () => {
    const w = await serviceWorld(database().db, 'pt09-retire');
    const record = await w.seedPartTime({ startDate: '2026-09-01', endDate: null });
    const exit = await w.leave('2026-09-15');
    const event = (kind: string, effectiveDate: string) => ({
      employeeId: w.employeeId,
      recordId: exit.id,
      kind: kind as never,
      effectiveDate,
      lastWorkDate: null,
      employeeStatus: 6 as const,
    });
    const run = (kind: string, effectiveDate: string) =>
      withTenant(w.db, w.tenantId, (tx) =>
        PART_TIME_EXIT_HOOKS.onRecordMaterialized!(tx, w.context(), event(kind, effectiveDate)),
      );
    await run('transfer', '2026-08-01');
    await run('regularization', '2026-08-01');
    expect(await w.terms(record)).toHaveLength(2);
    // 退休：事件日期更早（09-10），兼职再缩短到 09-09
    await run('retirement', '2026-09-10');
    expect((await w.terms(record)).at(-1)).toMatchObject({ end_date: '2026-09-09', source: 'exit' });
  });
});
