/**
 * BE-15b1 试用期考核对象（docs/02_业务建模/29 PB-R3～R7，§4 AC-PB-01 / AC-PB-02）：
 * - 预置流程：员工自评 → 经理评价，“编辑并同意”，自评节点取考核对象本人；
 * - AC-PB-01：试用中考核，经理选“提前转正 2026-10-15” → 审批完成生成 10-15 生效的转正任职记录，到期人员状态变正式；
 * - PB-R5：转正考核的正常 / 提前 / 延期转正生成转正记录，不通过、延期试用不生成；试用中考核只有提前转正生成；
 * - AC-PB-02：审批通过后 HR 把意见改为提前转正 → 不补生成（PB-R6）；审批中不能走 HR 修改入口；
 * - 不同意 / 驳回 / 撤回回写考核状态；生成被拒（如试用结果字典项被停用）时整次审批回滚，考核仍在审批中。
 */
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { assessmentWorld, reasonOf } from './AC-PB-BE15b1-support.js';

const testDb = useTestDb();
const presetOf = (type: string) => PRESET_PROCESSES.find((p) => p.approvalType === type)!;

describe('预置草稿（DEC-094，PB-R3）', () => {
  it.each(['probation_assessment', 'regularization_assessment'])('%s：员工自评 → 经理评价，均为编辑并同意', (type) => {
    const nodes = presetOf(type).definition.nodes;
    expect(
      nodes.map((n) => [n.key, 'approver' in n && n.approver, n.editMode, n.editableFields, n.actions.avoidSelf]),
    ).toEqual([
      ['self_evaluation', 'assessment_employee', 'with_approve', ['selfEvaluation'], false],
      [
        'manager_review',
        'direct_manager',
        'with_approve',
        ['managerRating', 'regularizationOpinion', 'regularizationDate'],
        true,
      ],
    ]);
  });
});

describe('AC-PB-01 试用中考核按审批时的意见生成转正记录（PB-R4）', () => {
  it('经理选“提前转正 2026-10-15”：审批完成后生成 10-15 生效的转正记录，到期人员状态变正式', async () => {
    const w = await assessmentWorld(testDb().db, 'pb01');
    const person = await w.probationer('提前转正员工');
    const id = await w.launch('probation', person);
    expect(await w.get(id)).toMatchObject({ status: 'in_review', regularizationBusinessId: null });
    await w.complete(id, person, {
      managerRating: 'exceeds',
      regularizationOpinion: 'early',
      regularizationDate: '2026-10-15',
    });
    const done = await w.get(id);
    expect(done).toMatchObject({
      status: 'approved',
      selfEvaluation: '自评：完成情况良好',
      managerRating: 'exceeds',
      regularizationOpinion: 'early',
      regularizationDate: '2026-10-15',
    });
    expect(done.regularizationBusinessId).not.toBeNull();
    const detail = await w.probationDetail(person.employeeId, '2026-10-15');
    expect(detail).toMatchObject({
      regularizationDate: '2026-10-15',
      regularizationBusinessId: done.regularizationBusinessId,
      probationResult: 'early',
    });
    // 10-15 之前仍是试用（2），转正记录起为正式（3）
    expect(detail.records.map((r) => [r.kind, r.effectiveDate, r.employeeStatus])).toEqual([
      ['hire', '2026-09-01', 2],
      ['regularization', '2026-10-15', 3],
    ]);
  });

  it('试用中考核的其他意见（正常转正 / 延期转正 / 不通过 / 延期试用）都不生成转正记录', async () => {
    const w = await assessmentWorld(testDb().db, 'pb01-other');
    for (const [opinion, date] of [
      ['normal', null],
      ['delayed', '2026-12-15'],
      ['failed', null],
      ['extended', null],
    ] as const) {
      const person = await w.probationer(`试用中-${opinion}`);
      const id = await w.launch('probation', person);
      await w.complete(id, person, {
        managerRating: 'meets',
        regularizationOpinion: opinion,
        ...(date ? { regularizationDate: date } : {}),
      });
      const done = await w.get(id);
      expect(done, opinion).toMatchObject({ status: 'approved', regularizationBusinessId: null });
      expect((await w.probationDetail(person.employeeId)).regularizationBusinessId, opinion).toBeNull();
    }
  });
});

describe('PB-R5 转正考核', () => {
  it('正常转正没填日期：取预计试用结束日次日；提前 / 延期转正取填写的日期；试用结果随意见', async () => {
    const w = await assessmentWorld(testDb().db, 'pb-r5');
    const cases = [
      ['normal', undefined, '2026-12-01'],
      ['early', '2026-10-20', '2026-10-20'],
      ['delayed', '2026-12-20', '2026-12-20'],
    ] as const;
    for (const [opinion, date, expected] of cases) {
      const person = await w.probationer(`转正考核-${opinion}`);
      const id = await w.launch('regularization', person);
      await w.complete(id, person, {
        managerRating: 'meets',
        regularizationOpinion: opinion,
        ...(date ? { regularizationDate: date } : {}),
      });
      const done = await w.get(id);
      expect(done.status, opinion).toBe('approved');
      expect(await w.probationDetail(person.employeeId, expected), opinion).toMatchObject({
        regularizationDate: expected,
        regularizationBusinessId: done.regularizationBusinessId,
        probationResult: opinion,
      });
    }
  });

  it('不通过、延期试用、没填意见：审批完成但不生成转正记录', async () => {
    const w = await assessmentWorld(testDb().db, 'pb-r5-none');
    for (const opinion of ['failed', 'extended', undefined] as const) {
      const person = await w.probationer(`转正考核-${opinion ?? '无意见'}`);
      const id = await w.launch('regularization', person);
      await w.complete(id, person, { managerRating: 'below', ...(opinion ? { regularizationOpinion: opinion } : {}) });
      expect(await w.get(id), String(opinion)).toMatchObject({ status: 'approved', regularizationBusinessId: null });
    }
  });
});

describe('AC-PB-02 审批后改意见不补生成（PB-R6）', () => {
  it('审批通过后 HR 把意见改为提前转正：考核记录更新，不生成转正记录；已生成的也不随之修改', async () => {
    const w = await assessmentWorld(testDb().db, 'pb02');
    const person = await w.probationer('审批后改意见');
    const id = await w.launch('probation', person);
    await w.complete(id, person, { managerRating: 'meets', regularizationOpinion: 'normal' });
    const approved = await w.get(id);

    const edited = await w.patchRaw(id, approved.revision, {
      regularizationOpinion: 'early',
      regularizationDate: '2026-10-15',
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({
      regularizationOpinion: 'early',
      regularizationDate: '2026-10-15',
      revision: approved.revision + 1,
      regularizationBusinessId: null,
    });
    expect((await w.probationDetail(person.employeeId, '2026-10-15')).regularizationBusinessId).toBeNull();

    // 已按“提前转正”生成过的考核：事后改成不通过，转正记录原样保留
    const other = await w.probationer('已生成后改意见');
    const generated = await w.launch('probation', other);
    await w.complete(generated, other, {
      managerRating: 'exceeds',
      regularizationOpinion: 'early',
      regularizationDate: '2026-10-15',
    });
    const before = await w.get(generated);
    const changed = await w.patchRaw(generated, before.revision, { regularizationOpinion: 'failed' });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await w.get(generated)).toMatchObject({
      regularizationOpinion: 'failed',
      regularizationBusinessId: before.regularizationBusinessId,
    });
    expect((await w.probationDetail(other.employeeId, '2026-10-15')).regularizationDate).toBe('2026-10-15');
  });

  it('HR 修改入口：审批中 409、过期 revision 409、提前转正缺日期 400、未知字段 400、没有改动 400', async () => {
    const w = await assessmentWorld(testDb().db, 'pb02-edit');
    const person = await w.probationer('修改入口');
    const id = await w.launch('probation', person);
    const inReview = await w.get(id);
    expect(await reasonOf(await w.patchRaw(id, inReview.revision, { managerRating: 'meets' }))).toMatchObject({
      status: 409,
      reason: 'ASSESSMENT_IN_APPROVAL',
    });
    await w.complete(id, person, { managerRating: 'meets', regularizationOpinion: 'normal' });
    const approved = await w.get(id);
    expect((await w.patchRaw(id, approved.revision - 1, { managerRating: 'exceeds' })).status).toBe(409);
    expect(await reasonOf(await w.patchRaw(id, approved.revision, { regularizationOpinion: 'early' }))).toMatchObject({
      status: 400,
      reason: 'ASSESSMENT_DATE_REQUIRED',
    });
    expect((await w.patchRaw(id, approved.revision, { status: 'in_review' })).status).toBe(400);
    expect((await w.patchRaw(id, approved.revision, {})).status).toBe(400);
    expect((await w.get(id)).revision).toBe(approved.revision);
  });
});

describe('审批结果回写考核状态', () => {
  it('经理不同意 → 不通过，不生成转正记录；经理驳回 → 已驳回；发起人撤回 → 已作废', async () => {
    const w = await assessmentWorld(testDb().db, 'pb-status');
    const refused = await w.probationer('不同意');
    const refusedId = await w.launch('regularization', refused);
    await w.decide(refusedId, refused, 'approve', { selfEvaluation: '自评' });
    await w.decide(refusedId, w.manager, 'disagree');
    expect(await w.get(refusedId)).toMatchObject({ status: 'disapproved', regularizationBusinessId: null });

    const rejected = await w.probationer('驳回');
    const rejectedId = await w.launch('probation', rejected);
    await w.decide(rejectedId, rejected, 'approve', { selfEvaluation: '自评' });
    await w.decide(rejectedId, w.manager, 'reject');
    expect((await w.get(rejectedId)).status).toBe('rejected');

    const withdrawn = await w.probationer('撤回');
    const withdrawnId = await w.launch('probation', withdrawn);
    const view = await w.instance(withdrawnId);
    const response = await w.instanceAction(w.hr.id, view.id, 'withdraw', view.revision, {});
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await w.get(withdrawnId)).status).toBe('cancelled');
  });

  it('生成转正记录被拒（试用结果“提前转正”被停用）：整次审批回滚，考核仍在审批中，处理后可重新审批', async () => {
    const w = await assessmentWorld(testDb().db, 'pb-rollback');
    const person = await w.probationer('生成被拒');
    const id = await w.launch('probation', person);
    const results = await w.json<{ items: { id: string; code: string; revision: number }[] }>(
      await w.request(w.hr.id, 'GET', '/api/tenant/employment/probation-results'),
    );
    const early = results.items.find((item) => item.code === 'early')!;
    const disabled = await w.request(w.hr.id, 'PUT', `/api/tenant/employment/probation-results/${early.id}`, {
      ifMatch: early.revision,
      body: { enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);

    await w.decide(id, person, 'approve', { selfEvaluation: '自评' });
    const view = await w.instance(id);
    const task = w.pending(view).find((t) => t.assigneeUserId === w.manager.userId)!;
    const blocked = await w.taskAction(w.manager.userId, task.id, 'approve', view.revision, {
      fields: { regularizationOpinion: 'early', regularizationDate: '2026-10-15' },
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(await w.get(id)).toMatchObject({ status: 'in_review', regularizationOpinion: null });
    expect((await w.instance(id)).status).toBe('running');
    expect((await w.probationDetail(person.employeeId, '2026-10-15')).regularizationBusinessId).toBeNull();
  });
});
