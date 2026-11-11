/**
 * BE-15b2 自动转正的考核类失败条件（docs/02_业务建模/29 PB-R21，§4 AC-PB-08 / AC-PB-11；BE-15a 留下的接口）：
 * 本任职周期（anchor_id）内——
 * - 转正考核：草稿 / 驳回 / 审批中 / 不通过 / 作废，或审批通过但意见 ≠ 正常转正；
 * - 试用中考核：审批中；
 * 任一存在，自动转正失败（台账记 failed、原因 ASSESSMENT_BLOCKS_REGULARIZATION），不发起转正。
 * 例外（F-500，DEC-841①，照北森 F-485 实测，仅“自动发起转正申请”类 application）：试用中考核审批通过且意见 = 提前转正，
 * 自动转正静默跳过——不记失败台账、不进回执失败列、不重试排队；员工仍试用中，同批其他员工照常处理。
 * “直接自动转正”类 direct 无取证依据（F-485 未触发），不适用静默跳过：仍按失败处理、记 failed 台账（F-517 只改命中后的发起方式）。
 * 上一周期（别的 anchor）的考核、不阻断的状态组合不影响。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { EMPLOYEE_STATUS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { autoAssessmentWorld, AUTO_REGULARIZATION_SWITCH, rowsOf } from './AC-PB-BE15b2-support.js';

const testDb = useTestDb();

async function regularizationWorld(label: string, mode: 'direct' | 'application' = 'direct') {
  const w = await autoAssessmentWorld(testDb().db, label);
  const response = await w.emp('POST', '/auto-regularization-rules', {
    ifMatch: 0,
    body: {
      name: '到期当天自动转正',
      priority: 1,
      orgIds: [w.department],
      mode,
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
  // F-500：试用中考核已生效且意见 = 提前转正 不再失败，改为静默跳过（见本文件末尾用例）
  it.each([
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

describe('AC-PB-08 试用中考核已生效且意见 = 提前转正：申请类静默跳过（F-500，DEC-841①）', () => {
  const earlyApproved = { type: 'probation', status: 'approved', opinion: 'early' } as const;

  const world = async (label: string, mode: 'direct' | 'application' = 'application') => {
    const w = await regularizationWorld(label, mode);
    const ledgerRows = async (employeeId: string) =>
      w.asTenant(async (tx) =>
        rowsOf<{ state: string }>(
          await tx.execute(sql`SELECT state FROM employment_auto_regularization_launches
            WHERE tenant_id=${w.tenant.id} AND employee_id=${employeeId}::uuid`),
        ),
      );
    // 试用中 = 当天主职的人员状态仍是试用（与自动转正的候选口径一致）
    const stillProbation = async (employeeId: string) =>
      w.asTenant(async (tx) => {
        const rows = rowsOf<{ employeeId: string }>(
          await tx.execute(sql`SELECT cr.employee_id::text AS "employeeId" FROM employment_timeline cur
            JOIN employment_records cr ON cr.tenant_id=cur.tenant_id AND cr.id=cur.record_id
            LEFT JOIN LATERAL employment_record_status(cr.tenant_id, cr.id) st ON true
            WHERE cur.tenant_id=${w.tenant.id} AND cur.valid_during @> '2026-10-01'::date
              AND cr.employee_id=${employeeId}::uuid AND st.employee_status=${EMPLOYEE_STATUS.probation}`),
        );
        return rows.length === 1;
      });
    return { ...w, ledgerRows, stillProbation };
  };

  it('申请类静默跳过：回执无失败也无发起，无失败台账（不重试排队），员工仍试用中、无新转正记录', async () => {
    const w = await world(`skip-${randomUUID()}`);
    const person = await w.dueEmployee('提前转正已生效员工');
    await w.seedAssessment(person.employeeId, earlyApproved);
    const receipt = await w.run();
    expect(receipt.launched).toEqual([]);
    expect(receipt.failed).toEqual([]);
    expect(await w.ledgerRows(person.employeeId)).toEqual([]);
    expect(await w.regularizations(person.employeeId)).toEqual([]);
    expect(await w.stillProbation(person.employeeId)).toBe(true);
    // 再跑一次仍静默：没有 failed 行累计次数，也没有被发起
    const again = await w.run();
    expect(again.launched).toEqual([]);
    expect(again.failed).toEqual([]);
    expect(await w.ledgerRows(person.employeeId)).toEqual([]);
  });

  it('同批其他员工照常处理，被跳过的人不影响他们；对照：考核审批中的人仍记失败', async () => {
    const w = await world(`batch-${randomUUID()}`);
    const skipped = await w.dueEmployee('被静默跳过员工');
    const failing = await w.dueEmployee('考核审批中员工');
    const normal = await w.dueEmployee('无考核员工');
    await w.seedAssessment(skipped.employeeId, earlyApproved);
    await w.seedAssessment(failing.employeeId, { type: 'probation', status: 'in_review' });
    const receipt = await w.run();
    expect(receipt.launched.map((item) => item.employeeId)).toEqual([normal.employeeId]);
    expect(receipt.failed).toEqual([
      expect.objectContaining({ employeeId: failing.employeeId, reason: 'ASSESSMENT_BLOCKS_REGULARIZATION' }),
    ]);
    expect(await w.ledgerRows(skipped.employeeId)).toEqual([]);
    expect(await w.ledgerRows(failing.employeeId)).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(await w.regularizations(skipped.employeeId)).toEqual([]);
  });

  it.each([
    ['同周期另有试用中考核审批中', { type: 'probation', status: 'in_review' }],
    ['同周期另有转正考核审批中', { type: 'regularization', status: 'in_review' }],
    ['同周期另有转正考核通过但意见 = 延期试用', { type: 'regularization', status: 'approved', opinion: 'extended' }],
  ] as const)('%s：存在其他失败条件时仍记失败，不因“提前转正”被跳过', async (_label, other) => {
    const w = await world(`mixed-${randomUUID()}`);
    const person = await w.dueEmployee('混合条件员工');
    await w.seedAssessment(person.employeeId, earlyApproved);
    await w.seedAssessment(person.employeeId, other);
    const receipt = await w.run();
    expect(receipt.launched).toEqual([]);
    expect(receipt.failed).toEqual([
      expect.objectContaining({ employeeId: person.employeeId, reason: 'ASSESSMENT_BLOCKS_REGULARIZATION' }),
    ]);
    expect(await w.ledgerRows(person.employeeId)).toEqual([expect.objectContaining({ state: 'failed' })]);
  });

  it('跳过只针对“试用中考核”：转正考核通过但意见 = 提前转正 仍记失败（意见 ≠ 正常转正）', async () => {
    const w = await world(`reg-early-${randomUUID()}`);
    const person = await w.dueEmployee('转正考核提前转正员工');
    await w.seedAssessment(person.employeeId, { type: 'regularization', status: 'approved', opinion: 'early' });
    const receipt = await w.run();
    expect(receipt.failed).toEqual([
      expect.objectContaining({ employeeId: person.employeeId, reason: 'ASSESSMENT_BLOCKS_REGULARIZATION' }),
    ]);
  });

  it('直接类（无取证依据）不适用静默跳过：同一考核条件仍失败，回执带原因，记 failed 台账，再跑累计次数，不发起转正', async () => {
    const w = await world(`direct-${randomUUID()}`, 'direct');
    const person = await w.dueEmployee('直接类提前转正已生效员工');
    await w.seedAssessment(person.employeeId, earlyApproved);
    const first = await w.run();
    expect(first.launched).toEqual([]);
    expect(first.failed).toEqual([
      expect.objectContaining({ employeeId: person.employeeId, reason: 'ASSESSMENT_BLOCKS_REGULARIZATION' }),
    ]);
    expect(await w.ledgerRows(person.employeeId)).toEqual([expect.objectContaining({ state: 'failed' })]);
    const again = await w.run();
    expect(again.failed).toEqual([
      expect.objectContaining({ employeeId: person.employeeId, reason: 'ASSESSMENT_BLOCKS_REGULARIZATION' }),
    ]);
    expect(await w.regularizations(person.employeeId)).toEqual([]);
    expect(await w.stillProbation(person.employeeId)).toBe(true);
  });
});
