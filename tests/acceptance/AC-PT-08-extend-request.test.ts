/**
 * AC-PT-08（延长申请四节点与结果，R2d）/ PB-33 / PB-34 / PB-38 / PB-62（docs/08_设计/R2-T05_兼职设计.md §4.3A / §4.4 / §4.5 / §9，PT-4c）：
 * 延长兼职申请经内部服务建立并提交，审批走真实审批中心接口。覆盖 E-1～E-6 在建 / 改 / 提交 / 审批编辑 / 落地各入口的拒绝形态、
 * 通过后只更新同一条记录的结束日（追加期限 source = extend，不新增记录）、原定结束日期不被回写、落地复核失败作废、离职作废。
 * 日期框架：今天 2026-10-01，主职 2020-01-01 入职；目标兼职默认 09-01～10-31（兼职部门）。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { grantFieldAccess, grantVisibleFields, permissionAdmin } from './AC-APV-support.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';

const database = useTestDb();
const world = (label: string, options: Parameters<typeof requestWorld>[2] = {}) =>
  requestWorld(database().db, `pt4c-ext-${label}`, options);

const conflict = (reason: string) => ({ code: 'CONFLICT', reason });

/** 把部门自 effectiveDate 起停用（组织入口，部门里没有人员 / 在途新增申请时成功）。 */
async function disableOrg(w: RequestWorld, orgId: string, effectiveDate: string) {
  const org = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/org/organizations/${orgId}`),
  );
  const response = await w.request(w.hr.id, 'PATCH', `/api/tenant/org/organizations/${orgId}`, {
    ifMatch: org.revision,
    body: { enabled: false, effectiveDate },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('PB-34 / PB-38：延长申请 → 四节点 → 同一条记录结束日更新', () => {
  it('节点顺序 主职HRBP → 主职负责人 → 兼职HRBP → 兼职负责人；通过前记录不变，通过后追加期限（extend），不新增记录', async () => {
    const w = await world('happy');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31', '合成延长备注');
    expect(created).toMatchObject({
      requestType: 'extend',
      state: 'draft',
      recordId: record,
      departmentId: w.side,
      startDate: '2026-09-01',
      endDate: '2026-12-31',
      remark: '合成延长备注',
    });
    expect((await w.load(created.id)).version).toMatchObject({
      serviceType: 'part_time',
      originalEndDate: '2026-10-31',
      baseTermNo: 1,
    });
    const submitted = await w.send(created.id, created.revision);
    expect(submitted.state).toBe('in_review');
    expect(await w.instance(created.id)).toMatchObject({
      approvalType: 'part_time_extend',
      title: '延长兼职申请',
      processCode: 'ExtendParttimeJobProcess',
    });
    await w.approveInOrder(created.id, w.order.extend, 3);
    // 末节点前记录没有变化
    expect((await w.terms(record)).map((term) => term.end_date)).toEqual(['2026-10-31']);
    await w.approveInOrder(created.id, w.order.extend.slice(3));

    expect((await w.instance(created.id)).status).toBe('approved');
    expect((await w.load(created.id)).state).toBe('effective');
    const events = await w.states(created.id);
    expect(events.map((row) => row.state)).toEqual(['draft', 'in_review', 'approved', 'effective']);
    expect(events.at(-1)!.record_id).toBe(record);
    // PB-34：同一条记录结束日更新，不新增记录；原定结束日期保持申请时的值
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: '2026-10-31', source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-12-31', source: 'extend', source_id: created.id },
    ]);
    expect((await w.partTimeRecords()).map((row) => row.id)).toEqual([record]);
    expect((await w.load(created.id)).version).toMatchObject({ endDate: '2026-12-31', originalEndDate: '2026-10-31' });
    expect(await w.auditActions(created.id)).toEqual(
      expect.arrayContaining([
        'part_time.request.create',
        'part_time.request.submit',
        'part_time.request.approved',
        'part_time.request.effective',
      ]),
    );
    expect(await w.auditActions(record)).toContain('employment.part_time.extended');
  });

  it('驳回后修改重提沿用原实例；撤回成草稿；不同意办结不落地', async () => {
    const w = await world('settle', { disagree: true });
    const record = await w.seedRecord();
    const a = await w.extend(record, '2026-12-31');
    await w.send(a.id, a.revision);
    await w.decide(a.id, w.approvers.pHrbp, 'reject');
    const rejected = await w.load(a.id);
    expect(rejected.state).toBe('rejected');
    const first = await w.instance(a.id);
    const edited = await w.update(a.id, rejected.revision, { endDate: '2026-11-30' });
    expect(edited).toMatchObject({ state: 'rejected', versionNo: 2, endDate: '2026-11-30' });
    const again = await w.send(a.id, edited.revision);
    expect(again.state).toBe('in_review');
    expect((await w.instance(a.id)).id).toBe(first.id);
    await w.approveInOrder(a.id, w.order.extend);
    expect((await w.terms(record)).at(-1)).toMatchObject({ end_date: '2026-11-30', source: 'extend' });

    const second = await w.seedRecord({ startDate: '2026-09-02' });
    const b = await w.extend(second, '2026-12-31');
    const submitted = await w.send(b.id, b.revision);
    const view = await w.instance(b.id);
    const response = await w.instanceAction(w.hr.id, view.id, 'withdraw', view.revision);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await w.load(b.id)).state).toBe('draft');
    expect(submitted.state).toBe('in_review');

    const third = await w.seedRecord({ startDate: '2026-09-03' });
    const c = await w.extend(third, '2026-12-31');
    await w.send(c.id, c.revision);
    await w.decide(c.id, w.approvers.pHrbp, 'disagree');
    expect((await w.load(c.id)).state).toBe('disapproved');
    expect(await w.terms(third)).toHaveLength(1);
  });
});

describe('F-247：延长填更早结束日 = 可确认警告，审批通过后按缩短后的结束日保存（DEC-635）', () => {
  const NOT_EXTENDED = { reason: 'PART_TIME_NOT_EXTENDED' };

  it('创建 / 提交回执都带警告；四个节点逐一同意（节点顺序不变）；落地追加期限 source = extend，原定结束日期记原值', async () => {
    const w = await world('shorten-happy');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-10-15');
    expect(created).toMatchObject({ state: 'draft', endDate: '2026-10-15', warnings: [NOT_EXTENDED.reason] });
    const submitted = await w.send(created.id, created.revision);
    expect(submitted).toMatchObject({ state: 'in_review', warnings: [NOT_EXTENDED.reason] });
    await w.approveInOrder(created.id, w.order.extend);
    expect((await w.load(created.id)).state).toBe('effective');
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: '2026-10-31', source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-10-15', source: 'extend', source_id: created.id },
    ]);
    expect((await w.load(created.id)).version).toMatchObject({ endDate: '2026-10-15', originalEndDate: '2026-10-31' });
    expect(await w.auditActions(record)).toContain('employment.part_time.extended');
  });

  it('缩短到今天之前：落地结果与结束申请一致（同一条记录追加期限，结束日为缩短值）', async () => {
    const w = await world('shorten-past');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const ended = await w.seedRecord({ startDate: '2026-09-02', endDate: '2026-10-31' });
    const extend = await w.extend(record, '2026-09-20');
    const end = await w.end(ended, '2026-09-20');
    for (const request of [extend, end]) {
      await w.send(request.id, request.revision);
      await w.approveInOrder(request.id, request.id === extend.id ? w.order.extend : w.order.end);
    }
    const shape = async (id: string) => (await w.terms(id)).map((term) => [term.term_no, term.end_date]);
    expect(await shape(record)).toEqual(await shape(ended));
    expect(await shape(record)).toEqual([
      [1, '2026-10-31'],
      [2, '2026-09-20'],
    ]);
  });

  it('修改草稿：改成更早结束日同样放行并带警告；改成等于原结束日 409，不追加版本', async () => {
    const w = await world('shorten-update');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    const saved = await w.update(created.id, created.revision, { endDate: '2026-10-20' });
    expect(saved).toMatchObject({ versionNo: 2, endDate: '2026-10-20', warnings: [NOT_EXTENDED.reason] });
    const before = await w.writes();
    expect(await w.rejected(() => w.update(created.id, saved.revision, { endDate: '2026-10-31' }))).toMatchObject(
      conflict('PART_TIME_NOT_EXTENDED'),
    );
    expect(await w.writes()).toEqual(before);
  });

  it('E-3 只在真正延长时校验：兼职部门自 11-20 起停用，缩短到 10-15 放行，延长到 11-20 仍拒绝', async () => {
    const w = await world('shorten-org');
    const lone = await w.org('缩短停用部门');
    const record = await w.seedRecord({ departmentId: lone, endDate: '2026-10-31' });
    await disableOrg(w, lone, '2026-10-10');
    expect((await w.extend(record, '2026-10-15')).warnings).toEqual([NOT_EXTENDED.reason]);
    expect(await w.rejected(() => w.extend(record, '2026-11-20'))).toMatchObject({
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
  });

  it('DEC-624 shortenOnly：主职审批中离职且计划日早于开始日（B-3），缩短放行（落地也不被作废）、延长仍拒绝', async () => {
    const w = await world('shorten-pending-exit');
    const record = await w.seedRecord({ startDate: '2026-10-20', endDate: '2026-10-31' });
    await w.pendingExit('2026-10-10');
    const rejected = await w.rejected(() => w.extend(record, '2026-12-31'));
    expect(rejected).toMatchObject(conflict('PART_TIME_AFTER_EXIT'));
    const shortened = await w.extend(record, '2026-10-25');
    expect(shortened.warnings).toContain(NOT_EXTENDED.reason);
    await w.send(shortened.id, shortened.revision);
    await w.approveInOrder(shortened.id, w.order.extend);
    expect((await w.load(shortened.id)).state).toBe('effective');
    expect((await w.terms(record)).at(-1)).toMatchObject({ end_date: '2026-10-25', source: 'extend' });
  });
});

describe('PB-33 / E-1～E-6：创建时的拒绝（当次无任何写入）', () => {
  it('E-1 无结束日 → PART_TIME_OPEN_ENDED；F-247 E-2 新结束日等于原结束日 → PART_TIME_NOT_EXTENDED（原站未取证，保守拦截）', async () => {
    const w = await world('rules-dates');
    const open = await w.seedRecord({ endDate: null });
    const record = await w.seedRecord({ startDate: '2026-09-02', endDate: '2026-10-31' });
    const before = await w.writes();
    expect(await w.rejected(() => w.extend(open, '2026-12-31'))).toMatchObject(conflict('PART_TIME_OPEN_ENDED'));
    expect(await w.rejected(() => w.extend(record, '2026-10-31'))).toMatchObject(conflict('PART_TIME_NOT_EXTENDED'));
    expect(await w.writes()).toEqual(before);
    const extended = await w.extend(record, '2026-11-01');
    expect(extended).toMatchObject({ state: 'draft', warnings: [] });
  });

  it('F-247 T-1：缩短到早于开始日期仍是 400 PART_TIME_END_BEFORE_START，不留申请头', async () => {
    const w = await world('rules-before-start');
    const record = await w.seedRecord({ startDate: '2026-09-02', endDate: '2026-10-31' });
    const before = await w.writes();
    expect(await w.rejected(() => w.extend(record, '2026-09-01'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'PART_TIME_END_BEFORE_START',
    });
    expect(await w.writes()).toEqual(before);
  });

  it('E-5 已结束的兼职（结束日已过）不能延长 → PART_TIME_ALREADY_ENDED', async () => {
    const w = await world('rules-ended');
    const ended = await w.seedRecord({ endDate: '2026-09-15' });
    const before = await w.writes();
    expect(await w.rejected(() => w.extend(ended, '2026-12-31'))).toMatchObject(conflict('PART_TIME_ALREADY_ENDED'));
    expect(await w.writes()).toEqual(before);
  });

  it('E-4 同一记录同时只能有一张未办结（草稿 / 审批中 / 驳回）的延长或结束申请；办结（作废）后可再建', async () => {
    const w = await world('rules-open');
    const record = await w.seedRecord();
    const first = await w.extend(record, '2026-12-31');
    const before = await w.writes();
    const inProgress = conflict('PART_TIME_REQUEST_IN_PROGRESS');
    expect(await w.rejected(() => w.extend(record, '2027-01-31'))).toMatchObject(inProgress);
    expect(await w.rejected(() => w.end(record, '2026-10-15'))).toMatchObject(inProgress);
    expect(await w.writes()).toEqual(before);
    // 审批中、驳回同样占位
    const submitted = await w.send(first.id, first.revision);
    expect(await w.rejected(() => w.extend(record, '2027-01-31'))).toMatchObject(inProgress);
    await w.decide(first.id, w.approvers.pHrbp, 'reject');
    expect(await w.rejected(() => w.extend(record, '2027-01-31'))).toMatchObject(inProgress);
    // 其他兼职记录不受影响
    const other = await w.seedRecord({ startDate: '2026-09-02' });
    expect((await w.extend(other, '2026-12-31')).state).toBe('draft');
    // 撤销（作废）后释放占位
    const rejected = await w.load(first.id);
    await w.revoke(first.id, rejected.revision);
    expect((await w.extend(record, '2027-01-31')).state).toBe('draft');
    expect(submitted.state).toBe('in_review');
  });

  it('E-3 延长段内兼职部门停用 → EMPLOYMENT_DEPARTMENT_DISABLED（400）；停用前一天为止可延长', async () => {
    const w = await world('rules-org');
    const lone = await w.org('延长停用部门');
    const record = await w.seedRecord({ departmentId: lone, endDate: '2026-10-31' });
    await disableOrg(w, lone, '2026-11-20');
    expect(await w.rejected(() => w.extend(record, '2026-11-20'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
    expect((await w.extend(record, '2026-11-19')).state).toBe('draft');
  });

  it('E-6 主职已离职（L = 09-15 已生效）：延长越过最后工作日 → PART_TIME_BEYOND_EXIT，创建不留申请头', async () => {
    const w = await world('rules-exit');
    await w.leave('2026-09-15');
    // 造数在离职之后：钩子不会截断它（真实路径里钩子会把它结束于 09-15）
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const before = await w.writes();
    expect(await w.rejected(() => w.extend(record, '2026-12-31'))).toMatchObject({
      ...conflict('PART_TIME_BEYOND_EXIT'),
      details: { reason: 'PART_TIME_BEYOND_EXIT', lastWorkDate: '2026-09-15' },
    });
    expect(await w.writes()).toEqual(before);
  });

  it('修改草稿 / 驳回中的延长申请同样整体重校验：越界当次拒绝，不追加版本；合法改动追加版本并重取原定结束日期', async () => {
    const w = await world('update');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    const before = await w.writes();
    expect(await w.rejected(() => w.update(created.id, created.revision, { endDate: '2026-10-31' }))).toMatchObject(
      conflict('PART_TIME_NOT_EXTENDED'),
    );
    expect(await w.rejected(() => w.update(created.id, created.revision, { endDate: null }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'PART_TIME_END_DATE_REQUIRED',
    });
    // 延长申请只能改结束日期与备注
    expect(await w.rejected(() => w.update(created.id, created.revision, { departmentId: w.primary }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'PART_TIME_FIELD_NOT_EDITABLE',
    });
    expect(await w.writes()).toEqual(before);
    const saved = await w.update(created.id, created.revision, { endDate: '2027-01-31', remark: '改后备注' });
    expect(saved).toMatchObject({ versionNo: 2, endDate: '2027-01-31', remark: '改后备注' });
    expect(await w.auditActions(created.id)).toContain('part_time.request.update');
  });

  it('提交时复核：草稿放着期间目标已结束（结束日已过）→ 提交 409 PART_TIME_ALREADY_ENDED，状态不变', async () => {
    const w = await world('submit-recheck');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    // 模拟草稿期间目标记录被其他入口改成已结束（直接写期限链）
    await w.appendTerm(record, 2, '2026-09-20', 'edit');
    expect(await w.rejected(() => w.send(created.id, created.revision))).toMatchObject(
      conflict('PART_TIME_ALREADY_ENDED'),
    );
    expect((await w.load(created.id)).state).toBe('draft');
  });
});

describe('审批编辑（延长申请预置不可编辑，租户改成可编辑后同样受校验；拒绝形态同 §4.3A 末）', () => {
  async function scene(editMode: 'separate' | 'with_approve', options: Parameters<typeof requestWorld>[2] = {}) {
    const w = await world(`edit-${editMode}`, { editMode, ...options });
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    const view = await w.instance(created.id);
    return { w, record, created, view, task: w.pending(view)[0]! };
  }
  const fingerprint = async (w: RequestWorld, id: string) => ({
    writes: await w.writes(),
    request: await w.load(id),
    logs: (await w.instance(id)).logs.map((log) => log.event),
  });

  it('独立编辑：E-2 / E-3 / 置空当次拒绝，版本 / 任务 / 实例 / 日志都不变；合法改动追加版本', async () => {
    const { w, created, view, task } = await scene('separate');
    const before = await fingerprint(w, created.id);
    const edit = (fields: Record<string, unknown>) =>
      w.taskAction(task.assigneeUserId, task.id, 'edit', view.revision, { fields });
    const refused = await edit({ endDate: '2026-10-31' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { reason: 'PART_TIME_NOT_EXTENDED' } },
    });
    const blank = await edit({ endDate: null });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toMatchObject({ error: { details: { reason: 'PART_TIME_END_DATE_REQUIRED' } } });
    expect(await fingerprint(w, created.id)).toEqual(before);
    const after = await w.instance(created.id);
    expect(after.revision).toBe(view.revision);
    expect(after.logs.some((log) => log.event === 'edit')).toBe(false);

    const ok = await edit({ endDate: '2026-11-30', requestRemark: '审批人改备注' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.load(created.id)).version).toMatchObject({
      versionNo: 2,
      endDate: '2026-11-30',
      remark: '审批人改备注',
      originalEndDate: '2026-10-31',
    });
  });

  it('编辑并同意：整个同意动作失败（任务未关闭、节点未推进）；通过后落地按编辑后的日期，原定结束日期不变', async () => {
    const { w, record, created, view, task } = await scene('with_approve');
    const before = await fingerprint(w, created.id);
    const denied = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields: { endDate: '2026-10-31' },
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { details: { reason: 'PART_TIME_NOT_EXTENDED' } } });
    expect(await fingerprint(w, created.id)).toEqual(before);
    const stuck = await w.instance(created.id);
    expect(stuck).toMatchObject({ status: 'running', currentNodeKey: view.currentNodeKey });
    expect(w.pending(stuck).map((item) => item.id)).toEqual([task.id]);

    const ok = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields: { endDate: '2026-11-30' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    await w.approveInOrder(created.id, w.order.extend.slice(1));
    expect((await w.terms(record)).at(-1)).toMatchObject({ end_date: '2026-11-30', source: 'extend' });
    expect((await w.load(created.id)).version).toMatchObject({ endDate: '2026-11-30', originalEndDate: '2026-10-31' });
  });

  it('F-247 编辑并同意把结束日改成更早：放行（原站可确认警告），节点推进，落地按缩短后的结束日', async () => {
    const { w, record, created, view, task } = await scene('with_approve');
    const ok = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields: { endDate: '2026-10-15' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    await w.approveInOrder(created.id, w.order.extend.slice(1));
    expect((await w.terms(record)).at(-1)).toMatchObject({ end_date: '2026-10-15', source: 'extend' });
    expect((await w.load(created.id)).version).toMatchObject({ endDate: '2026-10-15', originalEndDate: '2026-10-31' });
  });

  it('A-14 适配器第二层：节点开放了别的字段也不接（延长申请只能改结束日期与备注）→ 400 PART_TIME_FIELD_NOT_EDITABLE', async () => {
    const { w, created, view, task } = await scene('separate', { extraEditable: ['departmentId'] });
    const before = await w.writes();
    const response = await w.taskAction(task.assigneeUserId, task.id, 'edit', view.revision, {
      fields: { departmentId: w.primary },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'PART_TIME_FIELD_NOT_EDITABLE' } } });
    expect(await w.writes()).toEqual(before);
    expect((await w.load(created.id)).version.versionNo).toBe(1);
  });
});

describe('落地复核：按落地时数据，失败作废（审批结论保留）', () => {
  it('提交后目标兼职被其他入口改过期限（PB-40 同口径，直接写数据模拟）→ 末节点同意后作废 changed_since_submit，不落地', async () => {
    const w = await world('changed');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    await w.approveInOrder(created.id, w.order.extend, 3);
    await w.appendTerm(record, 2, '2026-11-15', 'edit');
    await w.approveInOrder(created.id, w.order.extend.slice(3));
    const view = await w.instance(created.id);
    expect(view.status).toBe('approved');
    expect((await w.states(created.id)).map((row) => [row.state, row.reason])).toEqual([
      ['draft', null],
      ['in_review', null],
      ['approved', null],
      ['voided', 'changed_since_submit'],
    ]);
    expect((await w.terms(record)).map((term) => term.end_date)).toEqual(['2026-10-31', '2026-11-15']);
    expect(await w.notices(view.id)).toEqual([
      { recipient: w.hr.id, template: 'part_time_request_voided', kind: 'message' },
    ]);
    expect(await w.auditActions(created.id)).toContain('part_time.request.voided');
  });

  it('E-3 落地时部门在延长段内已停用 → 作废 landing_rejected，审批结论保留，通知发起人', async () => {
    const w = await world('landing-org');
    // 专用兼职部门没有负责人 / HRBP 版本（组织入口按普通组织停用），兼职两个节点转异常管理员审批
    const lone = await w.org('落地停用部门');
    const record = await w.seedRecord({ departmentId: lone, endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    await w.approveInOrder(created.id, w.order.extend, 2);
    await disableOrg(w, lone, '2026-11-20');
    const admin = { userId: w.exceptionAdmin };
    await w.decide(created.id, admin, 'approve');
    await w.decide(created.id, admin, 'approve');
    const view = await w.instance(created.id);
    expect(view.status).toBe('approved');
    expect((await w.states(created.id)).at(-1)).toMatchObject({ state: 'voided', reason: 'landing_rejected' });
    expect(await w.terms(record)).toHaveLength(1);
    expect((await w.notices(view.id)).map((row) => row.template)).toEqual(['part_time_request_voided']);
  });

  it('PB-62：审批期间发起离职且计划日 < 记录开始日（B-3，F3）→ 末节点同意落地复核失败 landing_rejected', async () => {
    const w = await world('landing-pending-exit');
    const record = await w.seedRecord({ startDate: '2026-10-20', endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    await w.pendingExit('2026-10-10');
    await w.approveInOrder(created.id, w.order.extend);
    expect((await w.states(created.id)).at(-1)).toMatchObject({ state: 'voided', reason: 'landing_rejected' });
    expect(await w.terms(record)).toHaveLength(1);
  });
});

describe('PB-62 / AC-PT-09：离职落地作废在途延长申请', () => {
  it('延长申请审批期间员工离职落地 → 钩子先以 exit 作废，实例取消、待办消失；兼职记录被钩子截止，申请不落地', async () => {
    const w = await world('exit');
    const record = await w.seedRecord({ endDate: '2026-12-31' });
    const draft = await w.extend(record, '2027-01-31');
    const second = await w.seedRecord({ startDate: '2026-09-02', endDate: '2026-12-31' });
    const reviewing = await w.extend(second, '2027-01-31');
    await w.send(reviewing.id, reviewing.revision);
    const view = await w.instance(reviewing.id);
    await w.leave('2026-09-30');
    for (const request of [draft, reviewing])
      expect((await w.states(request.id)).at(-1), request.id).toMatchObject({ state: 'voided', reason: 'exit' });
    const closed = await w.detail(view.id);
    expect(closed.status).toBe('cancelled');
    expect(w.pending(closed)).toEqual([]);
    // 钩子把两条兼职结束于离职前一天；延长没有落地
    expect((await w.terms(second)).map((term) => [term.end_date, term.source])).toEqual([
      ['2026-12-31', 'create'],
      ['2026-09-30', 'exit'],
    ]);
  });
});

describe('真实授权器下的正常审批（快照字段编码须是任职记录权限目录里的编码）', () => {
  const ALL = MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code);

  it('有全部字段查看权 → 同意 200 并落地；缺 endDate 查看权 → 403 APPROVAL_BLIND_REVIEW 并转异常管理员', async () => {
    const w = await world('real');
    const admin = await permissionAdmin(w);
    const act = (user: string, task: string, revision: number) =>
      admin.api.request('POST', `/api/tenant/approval/tasks/${task}/approve`, {
        ...w.as(user),
        ifMatch: revision,
        body: { comment: '意见' },
      });
    await grantFieldAccess(admin, w.approvers.pHrbp.userId, { view: ALL, edit: [] });
    await grantVisibleFields(
      admin,
      w.approvers.pHead.userId,
      ALL.filter((code) => code !== 'endDate'),
    );
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31', '合成备注');
    await w.send(created.id, created.revision);
    let view = await w.instance(created.id);
    const first = await act(w.approvers.pHrbp.userId, w.pending(view)[0]!.id, view.revision);
    expect(first.status, await first.clone().text()).toBe(200);
    view = await w.instance(created.id);
    const blind = await act(w.approvers.pHead.userId, w.pending(view)[0]!.id, view.revision);
    expect(blind.status).toBe(403);
    expect(await blind.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_BLIND_REVIEW' } } });
    expect(w.pending(await w.instance(created.id)).map((task) => task.assigneeUserId)).toEqual([w.exceptionAdmin]);
  });
});
