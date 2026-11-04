/**
 * F-429 ① 离职生效作废在途考核：与任职 / 合同同结构写 exit_effects 台账（phase=effective、业务 = 离职单），
 * 与作废同事务：后续步骤失败整单回滚时台账随之回滚（设计 R2-T03 §2：exit_effects 是离职副作用的唯一清单）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { sql } from '@italent/db';
import {
  assessmentExitWorld,
  EFFECTIVE_DAY,
  LAST_WORK_DATE,
  type AssessmentExitWorld,
} from './AC-EXIT-F229-support.js';

const database = useTestDb();

const ledger = (x: AssessmentExitWorld, leaveId: string) =>
  x.rows<{ phase: string; kind: string; target_type: string; target_id: string; detail: Record<string, unknown> }>(sql`
    SELECT phase, kind, target_type, target_id::text, detail FROM exit_effects
    WHERE tenant_id=${x.tenantId} AND business_id=${leaveId}::uuid AND kind='assessment_voided' ORDER BY target_id`);

async function directLeave(x: AssessmentExitWorld, employeeId: string) {
  const { ackToken } = await x.reasonOf(
    await x.leaveCall(employeeId, { kind: 'leave', mode: 'direct', lastWorkDate: LAST_WORK_DATE, fields: {} }),
  );
  return x.createdLeave(employeeId, 'direct', { pendingTransferAck: ackToken });
}

describe('F-429 ① 作废在途考核写 exit_effects', () => {
  it('每条被作废的考核一行 assessment_voided（目标 = 考核、详情带类型 / 作废前状态 / 最后工作日）；已终态的考核不写', async () => {
    const x = await assessmentExitWorld(database().db, 'f429-ledger');
    const person = await x.probationer('台账员工');
    const inFlight = await x.launch('regularization', person);
    const leave = await directLeave(x, person.employeeId);

    expect(await x.activate(leave.id, EFFECTIVE_DAY)).toMatchObject({ outcome: 'effective' });

    expect(await ledger(x, leave.id)).toEqual([
      {
        phase: 'effective',
        kind: 'assessment_voided',
        target_type: 'assessment',
        target_id: inFlight,
        detail: expect.objectContaining({
          assessmentType: 'regularization',
          stateBefore: 'in_review',
          lastWorkDate: LAST_WORK_DATE,
        }),
      },
    ]);
  });

  it('没有在途考核时不写台账', async () => {
    const x = await assessmentExitWorld(database().db, 'f429-ledger-none');
    const person = await x.probationer('无在途员工');
    const finished = await x.launch('probation', person);
    await x.complete(finished, person);
    const leave = await x.createdLeave(person.employeeId, 'direct');
    expect(await x.activate(leave.id, EFFECTIVE_DAY)).toMatchObject({ outcome: 'effective' });
    expect(await ledger(x, leave.id)).toEqual([]);
  });
});
