/** C2-1b / F-055：补入的未来离职被删除后，也必须在生效前被真实循环取到。 */
import { sql } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { evaluationLeaveWorld, rowsOf, LEAVE_MIGRATION } from './AC-EV-leave-support.js';
import { runEvaluationLeave } from '../../apps/api/src/modules/evaluation/leave-handler.js';
import { addPreAssessmentTable } from './support/pre-assessment-schema.js';
import { addPreBlacklistTable } from './support/pre-blacklist-schema.js';
import { addPrePartTimeTables } from './support/pre-part-time-schema.js';

it('AC-EV-leave-upgrade：补入未来离职后在生效前删除，立即 skipped 且不终止评定', async () => {
  const handle = await createTestDb({ migrateBefore: LEAVE_MIGRATION });
  try {
    // R2 BE-8a：前置步骤里的入职会查黑名单表，旧结构上临时补出，升级迁移前撤掉（support/pre-blacklist-schema.ts）
    const restoreBlacklist = await addPreBlacklistTable(handle.db);
    // R2 BE-7 PT-2：前置步骤的任职写入在提交前复核会查兼职表，旧结构上临时补出，升级迁移前撤掉（support/pre-part-time-schema.ts）
    const restorePartTime = await addPrePartTimeTables(handle.db);
    // R2-T03 B3-3：离职开闸后旧结构上的离职会查在途考核，临时补出考核表，升级迁移前撤掉（support/pre-assessment-schema.ts）
    const restoreAssessment = await addPreAssessmentTable(handle.db);
    const w = await evaluationLeaveWorld(handle.db);
    await restoreBlacklist();
    const id = await w.seed();
    const before = await w.read(id);
    const [date] = rowsOf<{ future: string }>(await handle.db.execute(sql`SELECT (CURRENT_DATE+7)::text AS future`));
    const leave = await w.leave(date!.future);
    await restorePartTime();
    await restoreAssessment();
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
