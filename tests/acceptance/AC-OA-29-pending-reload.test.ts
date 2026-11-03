/**
 * F-341 / F-354②（BE-11a 审查转出，11b 接入前修）：执行器返回 'pending' 后，同组下一次调用必须拿到本事务内重读的组快照，
 * 不能继续用领组时的旧对象——§7.5 的 T2 / T3 靠 exec_phase 与游标判断走到哪一步，旧快照会让分段执行回到 T1 重做组织写入。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { GroupExecutor } from '../../apps/api/src/modules/org-adjustment/execution-groups.js';
import { runOrgAdjustmentTenant } from '../../apps/api/src/modules/org-adjustment/execution-runner.js';
import { scheduleOrgAdjustmentExecution } from '../../apps/api/src/modules/org-adjustment/schedule.js';
import { orgPeopleWorld, resultRows, TODAY } from './AC-ORG-people-support.js';
import { itemResults, seedAdjustment, seedItem } from './support/org-adjustment-execution.js';

const testDb = useTestDb();

describe('F-341 / F-354② pending 后重读组快照', () => {
  it('pending 两次：第 2 次调用看到第 1 次写的 exec_phase=1，第 3 次看到第 2 次推进后的状态；组只收尾一次', async () => {
    const db = testDb().db;
    const w = await orgPeopleWorld(db, 'oa-f341');
    const now = new Date(`${TODAY}T02:00:00.000Z`);
    const tenant = { id: w.tenant.id, timezone: w.tenant.timezone };
    const target = await w.org('ZZ_分段组织');
    const adjustment = await seedAdjustment(db, tenant.id, {
      createdBy: w.user.id,
      subjectOrgId: target.id,
      effectiveDate: TODAY,
    });
    const itemId = await seedItem(db, tenant.id, adjustment.id, { seq: 1, target_org_id: target.id });
    await withTenant(db, tenant.id, (tx) =>
      scheduleOrgAdjustmentExecution(
        tx,
        { tenantId: tenant.id, userId: w.user.id, timezone: tenant.timezone, now, commandId: randomUUID() },
        adjustment.id,
      ),
    );

    // 假执行器按 §7.5 的分段模式：exec_phase 0 → 写 1 并 pending；1 且已有进度 → 收尾；1 无进度 → 记进度并 pending。
    const seen: { phase: number; result: number | null }[] = [];
    const executor: GroupExecutor = async (tx, { group }) => {
      const lead = group.items[0]!;
      seen.push({ phase: lead.execPhase, result: lead.executionResult });
      if (seen.length > 5) throw new Error('执行器重复调用超过预期，旧快照导致死循环');
      if (lead.execPhase === 0) {
        await tx.execute(sql`UPDATE org_adjustment_org_items SET exec_phase=1
          WHERE tenant_id=${tenant.id} AND id=${lead.id}::uuid`);
        return 'pending';
      }
      const [row] = resultRows<{ employment_done: number }>(
        await tx.execute(sql`SELECT employment_done FROM org_adjustment_org_items
          WHERE tenant_id=${tenant.id} AND id=${lead.id}::uuid`),
      );
      if (!row?.employment_done) {
        await tx.execute(sql`UPDATE org_adjustment_org_items SET employment_done=employment_done+1
          WHERE tenant_id=${tenant.id} AND id=${lead.id}::uuid`);
        return 'pending';
      }
      return 'done';
    };

    const outcome = await runOrgAdjustmentTenant(db, tenant, () => now, {
      holderToken: `p-${randomUUID()}`,
      executors: { 2: executor },
    });

    // 旧实现每次都传领组时的对象：三次都看到 exec_phase=0，第 2 次又回到“T1”重写。
    expect(seen.map((s) => s.phase)).toEqual([0, 1, 1]);
    expect(outcome.completed).toEqual([adjustment.id]);
    const results = await itemResults(db, tenant.id, adjustment.id);
    expect(results.get(itemId)).toMatchObject({ execution_result: 1, exec_phase: 2 });
  });
});
