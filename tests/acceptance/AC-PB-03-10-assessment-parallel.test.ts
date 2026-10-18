/**
 * BE-15b1 PB-R9 互斥校验与考核并行规则（docs/02_业务建模/29 PB-R9，§4 AC-PB-03 / AC-PB-10，§8）：
 * - AC-PB-03：转正考核（或试用中考核）审批中，转正申请、直接转正、调整试用期和另一个考核都被拒，拦截在提交 / 保存时，
 *   草稿照常能存；转正申请审批中同样挡住考核；
 * - AC-PB-10：并行规则两个开关出厂都关；打开并勾选“转正”后，转正考核审批中仍可发起转正申请；调整试用期不是流程发起，
 *   没有例外；开关关闭 / 没勾选 / 取值不合法都不放行；
 * - 考核审批完成时按意见生成转正记录不再受互斥拦截（它是审批结果的落地，不是新发起）；
 * - 视图：“考核中”列出本周期审批中的考核；即将到期不再列出已发起转正考核的人。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { assessmentWorld, PARALLEL_KEYS, reasonOf, type LaunchReceipt } from './AC-PB-BE15b1-support.js';
import type { RegularizationReceipt } from './AC-PB-support.js';

const testDb = useTestDb();

describe('并行规则出厂值（PB-R9）', () => {
  it('两个开关都关、可发起流程为空；不合法的取值 400', async () => {
    const w = await assessmentWorld(testDb().db, 'parallel-default');
    for (const key of Object.values(PARALLEL_KEYS)) {
      const current = await w.json<{ value: unknown }>(await w.request(w.hr.id, 'GET', `/api/tenant/settings/${key}`));
      expect(current.value, key).toEqual({ enabled: false, allowed: [] });
    }
    expect((await w.setParallel('regularization', { enabled: true, allowed: ['regularization'] })).status).toBe(200);
    // 转正考核这一项的候选只有转正考核、转正；开关取值必须是严格对象
    expect((await w.setParallel('regularization', { enabled: true, allowed: ['probation_assessment'] })).status).toBe(
      400,
    );
    expect((await w.setParallel('regularization', { enabled: true })).status).toBe(400);
    expect((await w.setParallel('regularization', { enabled: 'yes', allowed: [] })).status).toBe(400);
    expect(
      (await w.setParallel('regularization', { enabled: true, allowed: ['regularization', 'regularization'] })).status,
    ).toBe(400);
    expect(
      (await w.setParallel('probation', { enabled: true, allowed: ['probation_assessment', 'regularization'] })).status,
    ).toBe(200);
  });
});

describe('AC-PB-03 互斥校验', () => {
  it('转正考核审批中：转正申请、直接转正、调整试用期、再发起考核都被拒；草稿照常保存', async () => {
    const w = await assessmentWorld(testDb().db, 'pb03');
    const person = await w.probationer('互斥员工');
    await w.launch('regularization', person);

    const apply = await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'application'));
    expect(apply.items[0]).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(apply.items[0]!.error!.message).toContain('存在未完成的转正考核');
    expect((apply.items[0]!.error as { details?: { reason?: string } }).details?.reason).toBe(
      'PROBATION_PROCESS_IN_REVIEW',
    );
    const direct = await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'direct'));
    expect(direct.items[0]).toMatchObject({ status: 'failed' });
    expect(await reasonOf(await w.adjustRaw(person.employeeId))).toMatchObject({
      status: 409,
      reason: 'PROBATION_PROCESS_IN_REVIEW',
    });
    for (const type of ['regularization', 'probation'] as const) {
      const again = await w.json<LaunchReceipt>(await w.launchRaw(type, [person]));
      expect(again.items[0], type).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
      expect(again.items[0]!.error!.details?.reason, type).toBe('PROBATION_PROCESS_IN_REVIEW');
    }
    // 拦截在提交时，不在保存草稿时：转正申请草稿照常能存（通用入口）
    const draft = await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${person.employeeId}/businesses`, {
      ifMatch: await w.employeeRevision(person.employeeId),
      body: { kind: 'regularization', mode: 'application', effectiveDate: '2026-12-01', probationResult: 'normal' },
    });
    expect(draft.status, await draft.clone().text()).toBe(201);
  });

  it('审批结束（不同意）后互斥解除；试用中考核审批中同样互斥', async () => {
    const w = await assessmentWorld(testDb().db, 'pb03-release');
    const person = await w.probationer('互斥解除');
    const id = await w.launch('probation', person);
    expect((await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'application'))).items[0]).toMatchObject({
      status: 'failed',
    });
    await w.decide(id, person, 'approve', { selfEvaluation: '自评' });
    await w.decide(id, w.manager, 'disagree');
    expect((await w.get(id)).status).toBe('disapproved');
    const apply = await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'application'));
    expect(apply.items[0], JSON.stringify(apply)).toMatchObject({ status: 'succeeded', businessStatus: 'in_review' });
  });

  it('转正申请审批中，发起考核被拒（三者互斥）', async () => {
    const w = await assessmentWorld(testDb().db, 'pb03-apply');
    const person = await w.probationer('转正申请中');
    const apply = await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'application'));
    expect(apply.items[0], JSON.stringify(apply)).toMatchObject({ status: 'succeeded' });
    const launched = await w.json<LaunchReceipt>(await w.launchRaw('regularization', [person]));
    expect(launched.items[0]).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(launched.items[0]!.error!.details?.reason).toBe('PROBATION_PROCESS_IN_REVIEW');
  });
});

describe('AC-PB-10 考核并行规则', () => {
  it('转正考核并行开关打开并勾选“转正”：转正考核审批中仍可发起转正申请，调整试用期照旧被拒', async () => {
    const w = await assessmentWorld(testDb().db, 'pb10');
    const person = await w.probationer('并行放行');
    await w.launch('regularization', person);
    expect((await w.setParallel('regularization', { enabled: true, allowed: ['regularization'] })).status).toBe(200);
    const apply = await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'application'));
    expect(apply.items[0], JSON.stringify(apply)).toMatchObject({ status: 'succeeded', businessStatus: 'in_review' });
    // 调整试用期不是流程发起，没有并行例外；再发起转正考核没有勾选，也被拒
    expect(await reasonOf(await w.adjustRaw(person.employeeId))).toMatchObject({ status: 409 });
    const again = await w.json<LaunchReceipt>(await w.launchRaw('regularization', [person]));
    expect(again.items[0]).toMatchObject({ status: 'failed' });
  });

  it('开关关闭（即使勾选了）或没勾选“转正”：不放行；试用中考核的开关不影响转正考核', async () => {
    const w = await assessmentWorld(testDb().db, 'pb10-off');
    const person = await w.probationer('并行不放行');
    await w.launch('regularization', person);
    expect((await w.setParallel('regularization', { enabled: false, allowed: ['regularization'] })).status).toBe(200);
    expect((await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'application'))).items[0]).toMatchObject({
      status: 'failed',
    });
    expect(
      (await w.setParallel('regularization', { enabled: true, allowed: ['regularization_assessment'] })).status,
    ).toBe(200);
    expect((await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'application'))).items[0]).toMatchObject({
      status: 'failed',
    });
    expect((await w.setParallel('probation', { enabled: true, allowed: ['regularization'] })).status).toBe(200);
    expect((await w.json<RegularizationReceipt>(await w.regularizeRaw(person, 'application'))).items[0]).toMatchObject({
      status: 'failed',
    });
  });

  it('试用中考核并行放行转正考核：两个考核同时审批；试用中考核完成按提前转正生成记录，不被转正考核拦截', async () => {
    const w = await assessmentWorld(testDb().db, 'pb10-generate');
    const person = await w.probationer('并行生成');
    const probationId = await w.launch('probation', person);
    expect((await w.setParallel('probation', { enabled: true, allowed: ['regularization_assessment'] })).status).toBe(
      200,
    );
    const regularizationId = await w.launch('regularization', person);
    expect((await w.get(regularizationId)).status).toBe('in_review');

    await w.complete(probationId, person, {
      managerRating: 'exceeds',
      regularizationOpinion: 'early',
      regularizationDate: '2026-10-15',
    });
    const done = await w.get(probationId);
    expect(done.status).toBe('approved');
    expect(done.regularizationBusinessId).not.toBeNull();
    expect((await w.get(regularizationId)).status).toBe('in_review');
  });
});

describe('“考核中”与即将到期视图（PB-R1）', () => {
  it('考核中列出本周期审批中的考核人；审批结束后移出；即将到期不再列出已发起转正考核的人', async () => {
    const w = await assessmentWorld(testDb().db, 'pb-views');
    const assessed = await w.probationer('考核中员工', { endDate: '2026-10-20' });
    const idle = await w.probationer('未考核员工', { endDate: '2026-10-20' });
    const id = await w.launch('regularization', assessed);

    const assessing = (await w.view('assessing')).items;
    expect(assessing).toEqual([
      expect.objectContaining({ employeeId: assessed.employeeId, assessmentId: id, assessmentType: 'regularization' }),
    ]);
    const expiring = (await w.view('expiring', '&expectedEndFrom=2026-10-01&expectedEndTo=2026-10-31')).items;
    expect(expiring.map((item) => item.employeeId)).toEqual([idle.employeeId]);
    expect((await w.view('all')).items.map((item) => item.employeeId).sort()).toEqual(
      [assessed.employeeId, idle.employeeId].sort(),
    );

    await w.decide(id, assessed, 'approve', { selfEvaluation: '自评' });
    await w.decide(id, w.manager, 'disagree');
    expect((await w.view('assessing')).items).toEqual([]);
    // 转正考核不通过后可以再发起：回到即将到期
    const afterExpiring = (await w.view('expiring', '&expectedEndFrom=2026-10-01&expectedEndTo=2026-10-31')).items;
    expect(afterExpiring.map((item) => item.employeeId).sort()).toEqual([assessed.employeeId, idle.employeeId].sort());
  });
});

describe('发起入口', () => {
  it('批量发起逐人回执：不在试用中、不存在、revision 过期各自失败，不影响其他人；同键重放不重复创建', async () => {
    const w = await assessmentWorld(testDb().db, 'launch-batch');
    const ok = await w.probationer('可考核');
    const stale = await w.probationer('过期 revision');
    const staleRevision = await w.employeeRevision(stale.employeeId);
    const regularized = await w.probationer('已转正');
    // 转正日期已过：今天起是正式员工，不能再考核
    const direct = await w.json<RegularizationReceipt>(await w.regularizeRaw(regularized, 'direct', '2026-09-30'));
    expect(direct.items[0]).toMatchObject({ status: 'succeeded' });
    const key = `launch-${stale.employeeId}`;
    const body = {
      assessmentType: 'probation',
      assessmentName: '批量考核',
      assessmentDate: '2026-10-01',
      items: [
        { employeeId: ok.employeeId, revision: await w.employeeRevision(ok.employeeId) },
        { employeeId: stale.employeeId, revision: staleRevision - 1 },
        { employeeId: regularized.employeeId, revision: await w.employeeRevision(regularized.employeeId) },
        { employeeId: '00000000-0000-4000-8000-000000000001', revision: 1 },
      ],
    };
    const first = await w.request(w.hr.id, 'POST', '/api/tenant/employment/probation-assessments', {
      body,
      idempotencyKey: key,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    const receipt = (await first.json()) as LaunchReceipt;
    expect(receipt).toMatchObject({ total: 4, succeeded: 1, failed: 3 });
    expect(receipt.items.map((item) => [item.status, item.error?.code, item.error?.details?.reason])).toEqual([
      ['succeeded', undefined, undefined],
      ['failed', 'REVISION_CONFLICT', undefined],
      ['failed', 'CONFLICT', 'ASSESSMENT_NOT_PROBATION'],
      ['failed', 'NOT_FOUND', undefined],
    ]);
    const replay = await w.request(w.hr.id, 'POST', '/api/tenant/employment/probation-assessments', {
      body,
      idempotencyKey: key,
    });
    expect(await replay.json()).toEqual(receipt);
    const listed = await w.json<{ items: { id: string }[] }>(
      await w.request(w.hr.id, 'GET', '/api/tenant/employment/probation-assessments?status=in_review'),
    );
    expect(listed.items.map((item) => item.id)).toEqual([receipt.items[0]!.assessmentId]);
  });

  it('请求体严格：多余字段、空名称、重复员工、超过上限、未知筛选 400；无权限 403 且不写入', async () => {
    const w = await assessmentWorld(testDb().db, 'launch-strict');
    const person = await w.probationer('严格校验');
    const item = { employeeId: person.employeeId, revision: await w.employeeRevision(person.employeeId) };
    const base = { assessmentType: 'probation', assessmentName: '考核', assessmentDate: '2026-10-01', items: [item] };
    const post = (body: unknown) =>
      w.request(w.hr.id, 'POST', '/api/tenant/employment/probation-assessments', { body });
    expect((await post({ ...base, status: 'approved' })).status).toBe(400);
    expect((await post({ ...base, assessmentName: '  ' })).status).toBe(400);
    expect((await post({ ...base, items: [item, item] })).status).toBe(400);
    expect((await post({ ...base, assessmentType: 'other' })).status).toBe(400);
    expect((await post({ ...base, items: [] })).status).toBe(400);
    expect((await w.request(w.hr.id, 'GET', '/api/tenant/employment/probation-assessments?bogus=1')).status).toBe(400);
    const listed = await w.json<{ items: unknown[] }>(
      await w.request(w.hr.id, 'GET', '/api/tenant/employment/probation-assessments'),
    );
    expect(listed.items).toEqual([]);
  });
});
