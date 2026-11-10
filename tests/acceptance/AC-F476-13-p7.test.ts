/**
 * AC-F476-13（P7 部分）：考核两类与意向退休，办理份的原值从正确版本捕获：
 * - 未来生效 / 批准不等于生效：审批通过时自动生成的转正任职记录（未来日期）不覆盖考核已办内容，
 *   主数据（试用信息 / 人事版本链）接口仍读现值，不被办理份替换；
 * - 原子回调对照：办理份、业务回调（生成转正记录 / 回写状态）、日志在同一事务——回调被拒则一份都不留，修好后重办才有份；
 * - 意向退休通过只记录（A-6）：不写人事字段；办理时的预计退休日期快照不被后来的人事现值冒充。
 * 留给其他片：任职全部子类型与离职 / 退休（P4）、合同四操作 / 兼职两操作（P5，在审）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { assessmentWorld } from './AC-PB-BE15b1-support.js';
import { intentionWorld } from './AC-RT-intention-support.js';
import {
  E1,
  E2,
  EMPLOYMENT,
  REASON_A,
  SELF_A,
  centerRead,
  copiesOf,
  copyCount,
  handledAssessment,
  ownRead,
} from './AC-F476-p7-support.js';

const testDb = useTestDb();
const EARLY = { managerRating: 'exceeds', regularizationOpinion: 'early', regularizationDate: '2026-10-15' };

describe('AC-F476-13 考核：批准不等于生效，办理份捕获办理那一刻的版本', () => {
  it('提前转正（未来生效日）：经理已办读 2026-10-15；HR 事后改成 10-20，主数据仍是已生成的转正记录（不补生成）', async () => {
    const s = await handledAssessment(testDb().db, 'f476p7-13-early', 'probation', EARLY, {
      regularizationDate: '2026-10-20',
    });
    const frozen = await ownRead(s.w, s.w.manager.userId, s.path);
    expect(frozen.mode).toBe('frozen');
    expect(frozen.body).toMatchObject({ regularizationOpinion: 'early', regularizationDate: '2026-10-15' });
    // 考核现值已改，但转正记录不补生成（PB-R6）：主数据接口读的是已生成的转正业务，不是办理份也不是 HR 新值
    const live = await s.w.get(s.id);
    expect(live.regularizationDate).toBe('2026-10-20');
    expect(live.regularizationBusinessId).toBe(s.before.regularizationBusinessId);
    const master = await s.w.probationDetail(s.person.employeeId, '2026-10-01');
    expect(master.regularizationBusinessId).toBe(s.before.regularizationBusinessId);
    expect(master.regularizationDate).toBe('2026-10-15');
    // 批准不等于生效：转正任职记录的生效日是审批通过时按当时意见定的 10-15，HR 事后改的 10-20 不生成新记录
    const dates = master.records.filter((record) => record.kind === 'regularization').map((r) => r.effectiveDate);
    expect(dates).toEqual(['2026-10-15']);
    // 未来生效日（10-15）之前：任职状态时间线上，10-01 的当前状态仍是试用（2）；10-15 当天才变为正式（3）
    const statusAt = (date: string) => master.records.filter((record) => record.effectiveDate <= date).at(-1);
    expect(statusAt('2026-10-01')).toMatchObject({ kind: 'hire', employeeStatus: 2 });
    expect(statusAt('2026-10-15')).toMatchObject({ kind: 'regularization', employeeStatus: 3 });
    // 转正业务的生效日就是 10-15，不是批准当天（2026-10-01）
    expect(master.records.filter((record) => record.kind === 'regularization')).toHaveLength(1);
  });

  it('办理份在审批通过回调之前捕获：不含回调才生成的转正业务编号（自动生成业务不覆盖已办内容）', async () => {
    const s = await handledAssessment(testDb().db, 'f476p7-13-before-callback', 'probation', EARLY, {
      managerRating: 'below',
    });
    const copies = await copiesOf(s.w, s.instanceId);
    const manager = copies.find((copy) => copy.actor_user_id === s.w.manager.userId)!;
    expect(manager.text).toMatch(/"regularizationOpinion"\s*:\s*"early"/);
    expect(s.before.regularizationBusinessId).not.toBeNull();
    expect(manager.text).not.toContain(s.before.regularizationBusinessId!);
    expect(manager.text).toContain(SELF_A);
  });

  it('转正考核：正常转正办理后 HR 改成提前转正，经理已办仍读“正常转正”，转正记录不变', async () => {
    const s = await handledAssessment(
      testDb().db,
      'f476p7-13-regularization',
      'regularization',
      { managerRating: 'meets', regularizationOpinion: 'normal' },
      { regularizationOpinion: 'early', regularizationDate: '2026-10-18' },
    );
    const frozen = await ownRead(s.w, s.w.manager.userId, s.path);
    expect(frozen.mode).toBe('frozen');
    expect(frozen.body).toMatchObject({ assessmentType: 'regularization', regularizationOpinion: 'normal' });
    expect(frozen.body.regularizationDate ?? null).toBeNull();
    expect((await centerRead(s.w, s.w.manager.userId, s.instanceId)).values).toMatchObject({
      regularizationOpinion: 'normal',
    });
    expect((await s.w.get(s.id)).regularizationBusinessId).toBe(s.before.regularizationBusinessId);
  });
});

describe('AC-F476-13 原子回调对照（考核）', () => {
  it('转正记录生成被拒：办理、办理份、回调同事务回滚；修好后重新办理才有份，且是修好后的内容', async () => {
    const w = await assessmentWorld(testDb().db, 'f476p7-13-atomic');
    const person = await w.probationer('生成被拒');
    const id = await w.launch('probation', person);
    const results = async () =>
      (
        await w.json<{ items: { id: string; code: string; revision: number }[] }>(
          await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/probation-results`),
        )
      ).items.find((item) => item.code === 'early')!;
    const toggle = async (enabled: boolean) => {
      const early = await results();
      const response = await w.request(w.hr.id, 'PUT', `${EMPLOYMENT}/probation-results/${early.id}`, {
        ifMatch: early.revision,
        body: { enabled },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await toggle(false);
    await w.decide(id, person, 'approve', { selfEvaluation: SELF_A });
    const instanceId = (await w.instance(id)).id;
    expect(await copiesOf(w, instanceId)).toHaveLength(1); // 员工自评节点的份
    const total = await copyCount(w);

    const view = await w.instance(id);
    const task = w.pending(view).find((t) => t.assigneeUserId === w.manager.userId)!;
    const blocked = await w.taskAction(w.manager.userId, task.id, 'approve', view.revision, { fields: EARLY });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    // 一份都不多：任务仍待办、考核仍审批中、实例仍运行
    expect(await copyCount(w)).toBe(total);
    expect(await copiesOf(w, instanceId)).toHaveLength(1);
    expect(await w.get(id)).toMatchObject({ status: 'in_review', regularizationOpinion: null });
    expect(await ownRead(w, w.manager.userId, `${EMPLOYMENT}/probation-assessments/${id}`)).toMatchObject({
      mode: 'live', // 经理仍有待办 → 现值
    });

    await toggle(true);
    await w.decide(id, w.manager, 'approve', EARLY);
    const copies = await copiesOf(w, instanceId);
    expect(copies.map((copy) => copy.actor_user_id)).toEqual([person.userId, w.manager.userId]);
    expect(copies[1]!.text).toMatch(/"regularizationOpinion"\s*:\s*"early"/);
    expect(await ownRead(w, w.manager.userId, `${EMPLOYMENT}/probation-assessments/${id}`)).toMatchObject({
      mode: 'frozen',
    });
  });
});

describe('AC-F476-13 意向退休：通过只记录，办理时快照不被人事现值冒充', () => {
  it('通过 → 不写人事字段（版本链逐行不变）；之后人事预计退休日期变为 E2，已办仍读申请时的 E1', async () => {
    const w = await intentionWorld(testDb().db, 'f476p7-13-intention');
    const facts = { earliest: '2030-01-01', latest: '2031-12-31' };
    await w.setRetirement({ expected: E1, ...facts });
    const created = await w.create({ intendedDate: '2030-03-01', reason: REASON_A });
    await w.act(created.id, 'submit');
    const instance = await w.instance(created.id);
    const personnelBefore = await w.personnelState();
    await w.decide(created.id, 'approve');
    expect(await w.personnelState()).toEqual(personnelBefore); // A-6：批准不写人事字段
    expect((await w.get(created.id)).status).toBe('approved');

    await w.setRetirement({ expected: E2, ...facts });
    expect(JSON.stringify(await w.personnelState())).toContain(E2); // 主数据现值已是 E2
    const path = `${EMPLOYMENT}/retirement-intentions/${created.id}`;
    const own = await ownRead(w, w.manager.userId, path);
    expect(own.mode).toBe('frozen');
    expect(own.body).toMatchObject({ intendedDate: '2030-03-01', expectedDateSnapshot: E1, status: 'approved' });
    expect(JSON.stringify(own.body)).not.toContain(E2);
    expect((await centerRead(w, w.manager.userId, instance.id)).values).toMatchObject({ expectedDateSnapshot: E1 });
    const copies = await copiesOf(w, instance.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ handling_kind: 'human', action: 'approve' });
  });

  it('原子对照：版本号过期的办理（409）不留办理份；随后用新版本办理成功恰好一份', async () => {
    const w = await intentionWorld(testDb().db, 'f476p7-13-intention-409');
    const created = await w.create({ intendedDate: '2030-03-01', reason: REASON_A });
    await w.act(created.id, 'submit');
    const view = await w.instance(created.id);
    const task = w.pending(view).find((t) => t.assigneeUserId === w.manager.userId)!;
    const stale = await w.taskAction(w.manager.userId, task.id, 'approve', view.revision + 100, {
      comment: '合成意见',
    });
    expect(stale.status).toBe(409);
    expect(await copiesOf(w, view.id)).toHaveLength(0);
    expect((await w.get(created.id)).status).toBe('in_review');
    await w.decide(created.id, 'approve');
    expect(await copiesOf(w, view.id)).toHaveLength(1);
    expect((await w.get(created.id)).status).toBe('approved');
  });
});
