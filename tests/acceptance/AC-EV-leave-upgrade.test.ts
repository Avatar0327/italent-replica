/** C2-1b：真实旧结构升级，时间轴删除排除、跨多日补入与迁移幂等。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { evaluationLeaveWorld, rowsOf, LEAVE_MIGRATION, replayLeaveMigration } from './AC-EV-leave-support.js';
import { removeEmploymentTimeline } from '../../apps/api/src/modules/employment/timeline.js';
import { runEvaluationLeave } from '../../apps/api/src/modules/evaluation/leave-handler.js';

it('AC-EV-leave-upgrade：C1 未来离职、三天前已生效且有评定的周期补入；已删除与无评定旧周期排除，重跑不重复', async () => {
  const handle = await createTestDb({ migrateBefore: LEAVE_MIGRATION });
  try {
    const w = await evaluationLeaveWorld(handle.db);
    const [date] = rowsOf<{ old: string; future: string; later: string }>(
      await handle.db.execute(sql`
      SELECT (CURRENT_DATE-4)::text AS old, (CURRENT_DATE+3)::text AS future, (CURRENT_DATE+5)::text AS later`),
    );
    const oldId = await w.seed();
    const oldLeave = await w.leave(date!.old);
    const futurePerson = await w.hire('迁移未来离职', w.orgA);
    const futureId = await w.seed({}, futurePerson.id);
    const futureLeave = await w.leave(date!.future, futurePerson.id);
    const removedPerson = await w.hire('迁移已删除离职', w.orgA);
    const removed = await w.leave(date!.future, removedPerson.id);
    // 迁移前已删除：直接追加 deleted 状态事件、墓碑并摘掉时间轴行（复用时间轴删除步骤），不经通用删除内核——
    // 旧结构里还没有 F-194 的待入职合同表，新内核会查它（迁移的排除依据是时间轴行；生产总是先迁移再服务）
    await withTenant(handle.db, w.tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO employment_state_events(id, tenant_id, employee_id, business_id,
        payload_version_id, state, event_no, command_id, created_at)
        SELECT gen_random_uuid(), tenant_id, employee_id, business_id, payload_version_id, 'deleted',
          event_no + 1, ${randomUUID()}, now()
        FROM employment_state_events WHERE tenant_id=${w.tenantId} AND business_id=${removed.id}::uuid
        ORDER BY event_no DESC LIMIT 1`);
      await tx.execute(sql`INSERT INTO employment_record_tombstones(id, tenant_id, employee_id, record_id, command_id)
        SELECT gen_random_uuid(), tenant_id, employee_id, id, ${randomUUID()}
        FROM employment_records WHERE tenant_id=${w.tenantId} AND id=${removed.id}::uuid`);
      await removeEmploymentTimeline(tx, w.ctx(), removedPerson.id, removed.id, false);
    });
    const noEvaluation = await w.hire('迁移旧周期无评定', w.orgA);
    const ignored = await w.leave(date!.old, noEvaluation.id);
    expect(await w.queue(oldLeave.id)).toEqual([]);
    expect(await w.queue(futureLeave.id)).toEqual([]);
    await handle.migrate();
    expect(await w.queue(oldLeave.id)).toHaveLength(1);
    expect(await w.queue(futureLeave.id)).toHaveLength(1);
    expect(await w.queue(removed.id)).toEqual([]);
    expect(await w.queue(ignored.id)).toEqual([]);
    await replayLeaveMigration(handle.db);
    expect(await w.queue(oldLeave.id)).toHaveLength(1);
    expect(await w.queue(futureLeave.id)).toHaveLength(1);
    expect(
      await runEvaluationLeave(handle.db, w.tenantId, {
        clock: () => new Date(`${date!.later}T08:00:00Z`),
      }),
    ).toMatchObject({ done: 2, failed: 0 });
    expect(await w.read(oldId)).toMatchObject({ terminated_reason: 'leave' });
    expect(await w.read(futureId)).toMatchObject({ terminated_reason: 'leave' });
  } finally {
    await handle.close();
  }
});
