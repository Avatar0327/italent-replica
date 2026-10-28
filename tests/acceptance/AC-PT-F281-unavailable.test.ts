/**
 * F-281（#453 R1 P3）兼职待执行联动的“记录不可读”留痕（docs/08_设计/R2-T05_兼职设计.md §4.8，DEC-634）：
 * 待执行事件对应的兼职记录读不到时（内连接查不到、锁定读不出来），定时生效不得静默略过，而是按 EVENTS.skipped 口径
 * 记一条 reason = UNAVAILABLE 的跳过事件并结清该待办；重复调度不重复留痕，同一员工名下可读的联动照常执行。
 * 没有公开入口能删除或作废已落地的兼职记录，夹具可信造数：给员工的一条主职业务头补一个待执行事件（主职不是兼职记录，
 * 兼职读口径读不到它），与真实“记录不可读”走同一条分支。
 * 日期框架：今天 2026-10-01，兼职开始日 2026-10-10 由定时生效执行。
 */
import { PART_TIME_AUDIT_OBJECTS } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { auditEmployment } from '../../apps/api/src/modules/employment/context.js';
import { LINKED, linkageWorld, PENDING, SKIPPED, type LinkageWorld } from './AC-PT-linkage-support.js';

const database = useTestDb();
const FUTURE = '2026-10-10';

/** 员工的主职业务头（不是兼职记录）。 */
const primaryBusinessId = (w: LinkageWorld) =>
  withTenant(w.db, w.tenantId, async (tx) => {
    const [row] = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id::text AS id FROM employment_records
        WHERE tenant_id=${w.tenantId} AND employee_id=${w.employeeId}::uuid AND service_type='primary' LIMIT 1`),
    );
    return row!.id;
  });

/** 给该业务头补一个待执行联动事件，造出“有待办、兼职记录读不到”。 */
const queueUnreadable = (w: LinkageWorld, businessId: string) =>
  withTenant(w.db, w.tenantId, (tx) =>
    auditEmployment(
      tx,
      w.context(),
      PENDING,
      PART_TIME_AUDIT_OBJECTS.record,
      businessId,
      null,
      { reason: 'seed' },
      undefined,
      undefined,
      {
        employeeId: w.employeeId,
      },
    ),
  );

describe('F-281 待执行联动：兼职记录不可读 → UNAVAILABLE 留痕并结清', () => {
  it('到期调度：留一条 reason = UNAVAILABLE 的跳过事件，不报错、不卡队列；同员工可读的联动照常执行', async () => {
    const w = await linkageWorld(database().db, 'f281-trace');
    const readable = await w.create({ startDate: FUTURE, isDepartmentHead: true });
    const orphan = await primaryBusinessId(w);
    await queueUnreadable(w, orphan);
    const run = await w.sweep(FUTURE);
    expect(run.errors).toEqual([]);
    expect(await w.skipReasons(orphan)).toEqual(['UNAVAILABLE']);
    expect(await w.events(orphan)).toMatchObject({ [PENDING]: 1, [SKIPPED]: 1 });
    expect(await w.events(orphan)).not.toHaveProperty(LINKED);
    // 不可读的待办不影响同员工名下可读的联动
    expect(await w.events(readable.id)).toMatchObject({ [LINKED]: 1 });
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
  });

  it('重跑调度不重复留痕（已结清的待办不再被候选命中）', async () => {
    const w = await linkageWorld(database().db, 'f281-idempotent');
    const orphan = await primaryBusinessId(w);
    await queueUnreadable(w, orphan);
    await w.sweep(FUTURE);
    await w.sweep(FUTURE);
    await w.sweep('2026-10-11');
    expect(await w.skipReasons(orphan)).toEqual(['UNAVAILABLE']);
    expect(await w.events(orphan)).toMatchObject({ [SKIPPED]: 1 });
  });
});
