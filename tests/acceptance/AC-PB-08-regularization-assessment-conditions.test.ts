/**
 * BE-15b2 自动转正的考核类失败条件（docs/02_业务建模/29 PB-R21，§4 AC-PB-08 / AC-PB-11；BE-15a 留下的接口）：
 * 本任职周期（anchor_id）内——
 * - 转正考核：草稿 / 驳回 / 审批中 / 不通过 / 作废，或审批通过但意见 ≠ 正常转正；
 * - 试用中考核：审批中，或审批通过且意见 = 提前转正；
 * 任一存在，自动转正失败（台账记 failed、原因 ASSESSMENT_BLOCKS_REGULARIZATION），不发起转正。
 * 上一周期（别的 anchor）的考核、不阻断的状态组合不影响。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { autoAssessmentWorld, AUTO_REGULARIZATION_SWITCH, rowsOf } from './AC-PB-BE15b2-support.js';

const testDb = useTestDb();

async function regularizationWorld(label: string) {
  const w = await autoAssessmentWorld(testDb().db, label);
  const response = await w.emp('POST', '/auto-regularization-rules', {
    ifMatch: 0,
    body: {
      name: '到期当天自动转正',
      priority: 1,
      orgIds: [w.department],
      mode: 'direct',
      daysBefore: 0,
      initiatorType: 'rule_operator',
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  await w.enableSwitch(AUTO_REGULARIZATION_SWITCH);
  // 预计试用结束日 09-30 ≤ 今天 10-01，自动转正到期
  const dueEmployee = (name: string) => w.probationer(name, { endDate: '2026-09-30' });
  const run = async () => {
    const result = await w.emp('POST', '/auto-regularization/run', { ifMatch: 0, body: {} });
    expect(result.status, await result.clone().text()).toBe(200);
    return (await result.json()) as {
      launched: { employeeId: string }[];
      failed: { employeeId: string; reason: string }[];
    };
  };
  const regularizations = async (employeeId: string) =>
    w.asTenant(async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT b.id FROM employment_business_objects b
          JOIN LATERAL (SELECT kind FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
            AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
          WHERE b.tenant_id=${w.tenant.id} AND b.employee_id=${employeeId}::uuid AND p.kind='regularization'`),
      ),
    );
  return { ...w, dueEmployee, run, regularizations };
}

describe('AC-PB-08 考核类失败条件阻断自动转正（PB-R21）', () => {
  it.each([
    ['试用中考核审批通过且意见 = 提前转正（AC-PB-08）', { type: 'probation', status: 'approved', opinion: 'early' }],
    ['试用中考核审批中', { type: 'probation', status: 'in_review' }],
    ['转正考核审批中', { type: 'regularization', status: 'in_review' }],
    ['转正考核已驳回', { type: 'regularization', status: 'rejected' }],
    ['转正考核不通过', { type: 'regularization', status: 'disapproved' }],
    ['转正考核已作废', { type: 'regularization', status: 'cancelled' }],
    ['转正考核通过但意见 = 延期试用', { type: 'regularization', status: 'approved', opinion: 'extended' }],
    ['转正考核通过但意见 = 不通过', { type: 'regularization', status: 'approved', opinion: 'failed' }],
    ['转正考核通过但没有转正意见', { type: 'regularization', status: 'approved', opinion: null }],
  ] as const)('%s：自动转正失败，不发起转正', async (_label, seed) => {
    const w = await regularizationWorld(`blocked-${randomUUID()}`);
    const person = await w.dueEmployee('被考核阻断员工');
    await w.seedAssessment(person.employeeId, seed);
    const receipt = await w.run();
    expect(receipt.launched).toEqual([]);
    expect(receipt.failed).toEqual([
      expect.objectContaining({ employeeId: person.employeeId, reason: 'ASSESSMENT_BLOCKS_REGULARIZATION' }),
    ]);
    expect(await w.regularizations(person.employeeId)).toEqual([]);
  });

  it.each([
    ['转正考核通过且意见 = 正常转正', { type: 'regularization', status: 'approved', opinion: 'normal' }],
    ['试用中考核通过且意见 = 正常转正', { type: 'probation', status: 'approved', opinion: 'normal' }],
    ['试用中考核通过且没有转正意见', { type: 'probation', status: 'approved', opinion: null }],
    ['试用中考核已驳回', { type: 'probation', status: 'rejected' }],
    ['试用中考核不通过', { type: 'probation', status: 'disapproved' }],
    ['试用中考核已作废', { type: 'probation', status: 'cancelled' }],
  ] as const)('%s：不阻断，照常自动转正', async (_label, seed) => {
    const w = await regularizationWorld(`pass-${randomUUID()}`);
    const person = await w.dueEmployee('不被阻断员工');
    await w.seedAssessment(person.employeeId, seed);
    const receipt = await w.run();
    expect(receipt.failed).toEqual([]);
    expect(receipt.launched.map((item) => item.employeeId)).toEqual([person.employeeId]);
    expect(await w.regularizations(person.employeeId)).toHaveLength(1);
  });

  it('只看本人本任职周期：别人的阻断考核不影响；条件消失（考核作废）后下一次执行重试成功（DEC-052）', async () => {
    const w = await regularizationWorld('cycle');
    const person = await w.dueEmployee('周期员工');
    const other = await w.dueEmployee('另一员工');
    const blocking = await w.seedAssessment(person.employeeId, { type: 'probation', status: 'in_review' });
    const first = await w.run();
    expect(first.failed.map((item) => item.employeeId)).toEqual([person.employeeId]);
    expect(first.launched.map((item) => item.employeeId)).toEqual([other.employeeId]);
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE employment_probation_assessments SET status='cancelled'
        WHERE tenant_id=${w.tenant.id} AND id=${blocking}::uuid`),
    );
    const retried = await w.run();
    expect(retried.failed).toEqual([]);
    expect(retried.launched.map((item) => item.employeeId)).toEqual([person.employeeId]);
  });
});
