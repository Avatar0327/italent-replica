/** C2-1b / F-055：补入的未来离职被删除后，也必须在生效前被真实循环取到。 */
import { sql } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { evaluationLeaveWorld, rowsOf, LEAVE_MIGRATION } from './AC-EV-leave-support.js';
import { runEvaluationLeave } from '../../apps/api/src/modules/evaluation/leave-handler.js';
import { addPreBlacklistTable } from './support/pre-blacklist-schema.js';

it('AC-EV-leave-upgrade：补入未来离职后在生效前删除，立即 skipped 且不终止评定', async () => {
  const handle = await createTestDb({ migrateBefore: LEAVE_MIGRATION });
  try {
    // R2 BE-8a：前置步骤里的入职会查黑名单表，旧结构上临时补出，升级迁移前撤掉（support/pre-blacklist-schema.ts）
    const restore = await addPreBlacklistTable(handle.db);
    const w = await evaluationLeaveWorld(handle.db);
    await restore();
    const id = await w.seed();
    const before = await w.read(id);
    const [date] = rowsOf<{ future: string }>(await handle.db.execute(sql`SELECT (CURRENT_DATE+7)::text AS future`));
    const leave = await w.leave(date!.future);
    await handle.migrate();
    expect(await w.queue(leave.id)).toHaveLength(1);
    await w.remove(leave);
    expect(await runEvaluationLeave(handle.db, w.tenantId)).toMatchObject({ skipped: 1, done: 0 });
    expect(await w.queue(leave.id)).toEqual([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE', attempts: 1 }]);
    expect(await w.read(id)).toEqual(before);
  } finally {
    await handle.close();
  }
});
