/**
 * BE-6b 在途实习转正处理（DEC-593②③，31 IN-R7 / IN-R8，设计 §5.1 步骤 0b / 1、§8B）：
 * ② “离职同步取消待入职”开关（标未证，默认关）：开 = 一并作废结束日之后的待入职（审批通过未生效的实习转正）；
 *    关且存在 = 保存前先返回需确认；
 * ③① 实习期到期不自动结束实习；③② 转正申请晚批有效，转正日期早于审批通过日时补到原定日期、任职不断档；
 * ③③ 直接实习转正自动作废在途申请（与生效链步骤 1 同一作废实现），申请方式再提仍 409；
 * ③④ 对有转正在途的人结束实习：先确认（不是 409、不是静默作废），确认后作废申请并结束实习。
 * 经离职管理正常发起的离职仍按 §8B 拦截（结束实习路径才是例外）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { endWorld, strictCapacity, type EndWorld } from './AC-INTERN-end-support.js';
import { names } from './AC-IN-BE6a-support.js';

const testDb = useTestDb();
const WILL_BE_VOIDED = '此人有转正申请在审批中，结束实习将作废该申请，确定？';
const END = { endDate: '2026-09-30' };

/** 审批中的转正申请（计划转正日 10-20）与它的审批实例。 */
async function reviewing(w: EndWorld, label: string) {
  const intern = await w.hire(label, 'intern');
  const applicationId = await w.applyRegularization(intern.employee.id, '2026-10-20');
  return { intern, applicationId, instance: (await w.instanceOf(applicationId))! };
}

/** 审批通过、尚未生效的转正申请（待入职，计划转正日 10-20）。 */
async function pendingEntry(w: EndWorld, label: string) {
  const world = await reviewing(w, label);
  expect(await w.approveAt(world.applicationId, '2026-10-01T01:00:00Z')).toBe('approved');
  return world;
}

describe('AC-INTERN-end-10 DEC-593④ 结束实习遇转正审批中：先确认，确认后作废申请', () => {
  it('不带确认：409 CONFIRMATION_REQUIRED 并给出提示语与将作废的申请；什么都不写', async () => {
    const w = await endWorld(testDb().db, 'end-reg-confirm');
    const { intern, applicationId, instance } = await reviewing(w, '审批中合成实习生');
    const response = await w.terminate(intern.employee.id, END);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        message: WILL_BE_VOIDED,
        details: {
          reason: 'CONFIRMATION_REQUIRED',
          warnings: [{ reason: 'INTERN_REGULARIZATION_WILL_BE_VOIDED', businessId: applicationId, state: 'in_review' }],
        },
      },
    });
    expect(await w.timeline(intern.employee.id)).toHaveLength(1);
    expect(await w.statusOf(applicationId)).toBe('in_review');
    expect(await w.instanceOf(applicationId)).toMatchObject({ id: instance.id, status: 'running' });
    expect(await w.pendingTasks(instance.id)).toHaveLength(1);
  });

  it('带确认重提：结束实习并作废申请（状态 voided、实例 cancelled、待办消失、站内消息、审计 / outbox）', async () => {
    const w = await endWorld(testDb().db, 'end-reg-voided');
    const { intern, applicationId, instance } = await reviewing(w, '确认作废合成实习生');
    const business = await w.terminateOk(intern.employee.id, { ...END, confirmed: true });
    expect(business.status).toBe('effective');
    expect(await w.statusOf(applicationId)).toBe('voided');
    expect(await w.instanceOf(applicationId)).toMatchObject({ id: instance.id, status: 'cancelled' });
    expect(await w.pendingTasks(instance.id)).toEqual([]);
    expect((await w.notices(instance.id)).map((row) => row.template)).toContain('application_voided_by_exit');
    const [audit] = await w.audits(applicationId, 'employment.business.voided_by_exit');
    expect(audit!.after).toMatchObject({ exitBusinessId: business.id, kind: 'intern_regularization' });
    expect(await w.outboxCount(applicationId, 'employment.business.voided_by_exit')).toBe(1);
    // 转正申请没有变成转正：不进“已转正 / 转正中”，进“已离职”
    expect(await w.view('converted')).toEqual([]);
    expect(await w.view('converting')).toEqual([]);
    expect(names(await w.view('left'))).toEqual([intern.name]);
  });

  it('结束日在将来：确认后保存为待生效；申请到生效日才作废（生效链步骤 1），此前审批照常', async () => {
    const w = await endWorld(testDb().db, 'end-reg-future');
    const { intern, applicationId } = await reviewing(w, '将来作废合成实习生');
    const business = await w.terminateOk(intern.employee.id, { endDate: '2026-10-10', confirmed: true });
    expect(business.status).toBe('approved');
    expect(await w.statusOf(applicationId)).toBe('in_review');
    await w.runScheduler('2026-10-11T01:00:00Z');
    expect(await w.statusOf(business.id)).toBe('effective');
    expect(await w.statusOf(applicationId)).toBe('voided');
  });

  it('草稿 / 已驳回的转正申请不是“在途审批”：不需要确认，随生效链作废', async () => {
    const w = await endWorld(testDb().db, 'end-reg-draft');
    const intern = await w.hire('草稿合成实习生', 'intern');
    const draft = await w.session.business(
      intern.employee.id,
      { kind: 'intern_regularization', mode: 'application', effectiveDate: '2026-10-20', fields: {} },
      await w.revision(intern.employee.id),
    );
    await w.terminateOk(intern.employee.id, END);
    expect(await w.statusOf(draft.id)).toBe('voided');
  });

  it('经离职管理正常发起的离职仍按 §8B 拦截（审批中、计划日 ≤ 最后工作日）→ 409 EXIT_REGULARIZATION_IN_FLIGHT', async () => {
    const w = await endWorld(testDb().db, 'end-reg-8b');
    const { intern } = await reviewing(w, '八B合成实习生');
    const response = await w.session.request('POST', `/exits/employees/${intern.employee.id}`, {
      ifMatch: await w.revision(intern.employee.id),
      body: { mode: 'direct', lastWorkDate: '2026-10-25', fields: {} },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'EXIT_REGULARIZATION_IN_FLIGHT' } } });
    expect(await w.leaves(intern.employee.id)).toBe(0);
  });
});

describe('AC-INTERN-end-11 DEC-593② 离职同步取消待入职', () => {
  it('开关开启：待入职（审批通过未生效）随结束实习作废，无需确认', async () => {
    const w = await endWorld(testDb().db, 'end-pending-on');
    const { intern, applicationId } = await pendingEntry(w, '开关开合成实习生');
    const business = await w.terminateOk(intern.employee.id, { ...END, cancelPendingEntry: true });
    expect(business.status).toBe('effective');
    expect(await w.statusOf(applicationId)).toBe('voided');
    expect(await w.view('converting')).toEqual([]);
  });

  it('开关默认关且存在待入职：先 409 需确认（说明将一并作废），带确认重提后作废', async () => {
    const w = await endWorld(testDb().db, 'end-pending-off');
    const { intern, applicationId } = await pendingEntry(w, '开关关合成实习生');
    const first = await w.terminate(intern.employee.id, END);
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({
      error: {
        details: {
          reason: 'CONFIRMATION_REQUIRED',
          warnings: [{ reason: 'INTERN_REGULARIZATION_WILL_BE_VOIDED', businessId: applicationId, state: 'approved' }],
        },
      },
    });
    expect(await w.timeline(intern.employee.id)).toHaveLength(1);
    expect(await w.statusOf(applicationId)).toBe('approved');
    await w.terminateOk(intern.employee.id, { ...END, confirmed: true });
    expect(await w.statusOf(applicationId)).toBe('voided');
  });

  it('开关开启但另有审批中的申请：审批中的仍要确认（开关只管待入职）', async () => {
    const w = await endWorld(testDb().db, 'end-pending-mixed');
    const { intern } = await reviewing(w, '混合合成实习生');
    const response = await w.terminate(intern.employee.id, { ...END, cancelPendingEntry: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'CONFIRMATION_REQUIRED' } } });
  });

  it('没有待入职时开关无影响', async () => {
    const w = await endWorld(testDb().db, 'end-pending-none');
    const intern = await w.hire('无待入职合成实习生', 'intern');
    expect((await w.terminate(intern.employee.id, { ...END, cancelPendingEntry: true })).status).toBe(201);
  });

  it('待入职计划转正日不晚于结束日：转正会先于结束落地，拒绝结束实习（确认也不放行）', async () => {
    const w = await endWorld(testDb().db, 'end-pending-due');
    const { intern } = await pendingEntry(w, '先转正合成实习生');
    const response = await w.terminate(intern.employee.id, { endDate: '2026-10-25', confirmed: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: 'INTERN_REGULARIZATION_DUE_BEFORE_END_DATE' } },
    });
    expect(await w.leaves(intern.employee.id)).toBe(0);
  });
});

describe('AC-INTERN-end-12 DEC-593③① 实习期到期不自动结束实习', () => {
  it('带终止日期的实习协议到期：合同到期任务照常终止协议，但不产生任何离职，人员仍在实习中，转正申请继续审批', async () => {
    const w = await endWorld(testDb().db, 'end-no-auto');
    const { intern, applicationId } = await reviewing(w, '到期合成实习生');
    const agreement = await w.internAgreement(intern.employee.id, '2026-10-31');
    expect(await w.contractStatus(agreement.id)).toMatchObject({ status: 'valid', end_date: '2026-10-31' });
    // 协议终止日期已过：合同到期任务把协议终止（证明到期事件确实发生），任职调度也照常运行
    await w.sweepContracts('2026-11-15T01:00:00Z');
    expect((await w.contractStatus(agreement.id))!.status).not.toBe('valid');
    const run = await w.runScheduler('2026-11-15T01:00:00Z');
    expect(run.activated).toEqual([]);
    expect(await w.leaves(intern.employee.id)).toBe(0);
    expect(await w.timeline(intern.employee.id)).toHaveLength(1);
    expect(names(await w.view('interning'))).toEqual([intern.name]);
    expect(await w.view('left')).toEqual([]);
    expect(await w.statusOf(applicationId)).toBe('in_review');
  });
});

describe('AC-INTERN-end-13 DEC-593③② 转正申请晚批有效：补到原定转正日，任职不断档', () => {
  it('转正日 10-10 < 审批通过日 10-15：新主职从 10-10 起，原实习任职 10-09 结束，中间无断档', async () => {
    const w = await endWorld(testDb().db, 'end-late-approve');
    const intern = await w.hire('晚批合成实习生', 'intern');
    const applicationId = await w.applyRegularization(intern.employee.id, '2026-10-10');
    expect(await w.approveAt(applicationId, '2026-10-15T01:00:00Z')).toBe('effective');
    expect(await w.timeline(intern.employee.id)).toMatchObject([
      { kind: 'hire', start_date: '2026-09-01', valid: '[2026-09-01,2026-10-10)' },
      { kind: 'intern_regularization', start_date: '2026-10-10' },
    ]);
    const records = (await w.session.records(intern.employee.id, '2026-12-31')) as unknown as {
      kind: string;
      effectiveDate: string;
      stopDate: string;
      changeType: string | null;
      fields: Record<string, unknown>;
    }[];
    expect(records.find((record) => record.kind === 'hire')).toMatchObject({ stopDate: '2026-10-09' });
    expect(records.find((record) => record.kind === 'intern_regularization')).toMatchObject({
      effectiveDate: '2026-10-10',
      changeType: 'intern_regularization',
      fields: { employType: 'internal' },
    });
    expect(names(await w.view('converted'))).toEqual([intern.name]);
  });

  it('晚批后到期调度补落地（审批通过时尚未到日，随后调度在 10-12 才跑）：同样补到原定日期', async () => {
    const w = await endWorld(testDb().db, 'end-late-scheduler');
    const intern = await w.hire('晚跑合成实习生', 'intern');
    const applicationId = await w.applyRegularization(intern.employee.id, '2026-10-10');
    expect(await w.approveAt(applicationId, '2026-10-05T01:00:00Z')).toBe('approved');
    expect((await w.runScheduler('2026-10-12T01:00:00Z')).activated).toEqual([applicationId]);
    expect(await w.timeline(intern.employee.id)).toMatchObject([
      { kind: 'hire', valid: '[2026-09-01,2026-10-10)' },
      { kind: 'intern_regularization', start_date: '2026-10-10' },
    ]);
  });
});

describe('AC-INTERN-end-14 DEC-593③③ 直接实习转正自动作废在途转正申请', () => {
  const direct = { effectiveDate: '2026-10-16', probation: false };

  it('审批中的申请：直接转正成功，申请作废（实例 cancel、待办消失、站内消息、审计 / outbox）', async () => {
    const w = await endWorld(testDb().db, 'end-direct-voids');
    const { intern, applicationId, instance } = await reviewing(w, '直接作废合成实习生');
    await w.regularizeOk(intern.employee.id, direct.effectiveDate, w.other.id);
    expect(await w.statusOf(applicationId)).toBe('voided');
    expect(await w.instanceOf(applicationId)).toMatchObject({ id: instance.id, status: 'cancelled' });
    expect(await w.pendingTasks(instance.id)).toEqual([]);
    const messages = await w.notices(instance.id);
    expect(messages.map((row) => row.template)).toEqual(messages.map(() => 'application_voided_by_regularization'));
    expect(messages.map((row) => row.recipient)).toContain(w.session.user.id);
    const [audit] = await w.audits(applicationId, 'employment.business.voided_by_regularization');
    expect(audit!.after).toMatchObject({ state: 'voided', kind: 'intern_regularization', stateBefore: 'in_review' });
    expect(await w.outboxCount(applicationId, 'employment.business.voided_by_regularization')).toBe(1);
    expect(names(await w.view('converted'))).toEqual([intern.name]);
    expect(await w.view('converting')).toEqual([]);
  });

  it('审批通过未生效的申请（待入职）：同样作废，只留直接转正这一条', async () => {
    const w = await endWorld(testDb().db, 'end-direct-voids-approved');
    const { intern, applicationId } = await pendingEntry(w, '直接作废待入职合成实习生');
    await w.regularizeOk(intern.employee.id, direct.effectiveDate, w.other.id);
    expect(await w.statusOf(applicationId)).toBe('voided');
    expect((await w.timeline(intern.employee.id)).filter((row) => row.kind === 'intern_regularization')).toHaveLength(
      1,
    );
  });

  it('直接转正失败（严格控编超编）时整单回滚：申请不被作废', async () => {
    const w = await endWorld(testDb().db, 'end-direct-rollback');
    await w.hire('占编合成员工', 'internal');
    const { intern, applicationId, instance } = await reviewing(w, '回滚合成实习生');
    await strictCapacity(w);
    const response = await w.regularize(intern.employee.id, { ...direct, departmentId: w.org.id });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect(await w.statusOf(applicationId)).toBe('in_review');
    expect(await w.instanceOf(applicationId)).toMatchObject({ id: instance.id, status: 'running' });
    expect(await w.pendingTasks(instance.id)).toHaveLength(1);
  });

  it('申请方式再提一条：仍 409 INTERN_REGULARIZATION_IN_PROGRESS', async () => {
    const w = await endWorld(testDb().db, 'end-second-application');
    const { intern, applicationId } = await reviewing(w, '二次申请合成实习生');
    const response = await w.session.request('POST', `/employees/${intern.employee.id}/businesses`, {
      ifMatch: await w.revision(intern.employee.id),
      body: { kind: 'intern_regularization', mode: 'application', effectiveDate: '2026-10-25', fields: {} },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: 'INTERN_REGULARIZATION_IN_PROGRESS' } },
    });
    expect(await w.statusOf(applicationId)).toBe('in_review');
  });
});

describe('AC-INTERN-end-15 第 1 轮返工 P2-3① 生效时复核：保存之后转正先落地，结束实习生效失败', () => {
  it('先保存未来日期的结束实习（确认），转正申请再审批落地，到结束日调度：结束实习被拒，不变 effective', async () => {
    const w = await endWorld(testDb().db, 'end-landed-before-effective');
    const intern = await w.hire('先落地合成实习生', 'intern');
    // 计划转正日 10-10 的申请在审批中：保存结束实习（结束日 10-20）时需确认，确认后申请仍在审批，生效时才作废
    const applicationId = await w.applyRegularization(intern.employee.id, '2026-10-10');
    const business = await w.terminateOk(intern.employee.id, { endDate: '2026-10-20', confirmed: true });
    expect(business.status).toBe('approved');
    expect(await w.approveAt(applicationId, '2026-10-12T01:00:00Z')).toBe('effective');
    const run = await w.runScheduler('2026-10-21T01:00:00Z');
    expect(run.activated).toEqual([]);
    expect(run.failed).toEqual([business.id]);
    expect(await w.statusOf(business.id)).toBe('approved');
    expect(await w.leaves(intern.employee.id)).toBe(0);
    expect((await w.attempts(business.id)).at(-1)).toMatchObject({ outcome: 'failed' });
  });
});

describe('AC-INTERN-end-16 第 1 轮返工 P2-2 直接转正作废超限：整单拒绝，不部分作废', () => {
  it('在途转正申请 1003 条（> VOID_LIMIT）：直接转正 409，申请 / 实例 / 待办 / 审计全部不变，不落地', async () => {
    const w = await endWorld(testDb().db, 'end-direct-too-many');
    const { intern, applicationId, instance } = await reviewing(w, '超限合成实习生');
    await w.bulkRegularizations(intern.employee.id, 1002);
    const before = await w.stateCounts(intern.employee.id);
    const revision = await w.revision(intern.employee.id);
    const response = await w.regularize(intern.employee.id, {
      effectiveDate: '2026-10-16',
      departmentId: w.org.id,
      probation: false,
    });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: 'EXIT_APPLICATIONS_TOO_MANY', limit: 1000 } },
    });
    expect(await w.stateCounts(intern.employee.id)).toEqual(before);
    expect(await w.statusOf(applicationId)).toBe('in_review');
    expect(await w.instanceOf(applicationId)).toMatchObject({ id: instance.id, status: 'running' });
    expect(await w.pendingTasks(instance.id)).toHaveLength(1);
    expect(await w.audits(applicationId, 'employment.business.voided_by_regularization')).toEqual([]);
    expect(await w.timeline(intern.employee.id)).toHaveLength(1);
    expect(await w.revision(intern.employee.id)).toBe(revision);
  });
});
