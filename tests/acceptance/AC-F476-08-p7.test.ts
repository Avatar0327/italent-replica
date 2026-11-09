/**
 * AC-F476-08（P7 部分）：试用期考核（试用中 / 转正两类）与意向退休申请，逐类型走“办理 → 修改 → 两条路径读取”。
 * 两条路径 = 模块自有详情（/probation-assessments/:id、/retirement-intentions/:id）与审批中心实例详情，
 * 且“第二条路径”是真正不同的入口，不是同一个详情接口重复读。
 * 红点：旧实现自有详情永远读现值（B），审批中心只读通用快照；缺份 / 缺扩展没有统一的失败闭合。
 * 留给其他片：任职 / 离职 / 退休（P4）、合同 / 员工子集 / 兼职（P5）、Offer（P6）、IDP（P8）、交接与清单收口（P9）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { intentionWorld } from './AC-RT-intention-support.js';
import {
  EMPLOYMENT,
  E1,
  E2,
  REASON_A,
  REASON_B,
  SELF_A,
  SELF_B,
  centerRead,
  handledAssessment,
  ownRead,
  rejectedIntention,
  sabotageCopies,
} from './AC-F476-p7-support.js';

const testDb = useTestDb();
const PROBATION = { managerRating: 'exceeds', regularizationOpinion: 'early', regularizationDate: '2026-10-15' };
const REGULARIZATION = { managerRating: 'exceeds', regularizationOpinion: 'normal' };

describe('AC-F476-08 考核（试用中 / 转正）办理 → 修改 → 两路径', () => {
  it.each([
    ['probation', PROBATION, { managerRating: 'below', regularizationDate: '2026-10-20' }],
    ['regularization', REGULARIZATION, { managerRating: 'below' }],
  ] as const)('%s：经理的“已办”在自有详情与审批中心都读办理时的值，发起人读现值', async (type, evaluation, later) => {
    const s = await handledAssessment(testDb().db, `f476p7-08-${type}`, type, evaluation, later);
    const live = await s.w.get(s.id);
    // 自有详情
    const own = await ownRead(s.w, s.w.manager.userId, s.path);
    expect(own.status).toBe(200);
    expect(own.mode).toBe('frozen');
    expect(own.body).toMatchObject({ selfEvaluation: SELF_A, managerRating: 'exceeds', assessmentType: type });
    expect(own.body.regularizationOpinion).toBe(evaluation.regularizationOpinion);
    // 流程事实读现值：状态与并发版本号不被办理份盖掉
    expect(own.body).toMatchObject({ status: 'approved', revision: live.revision });
    // 审批中心（独立入口）
    const center = await centerRead(s.w, s.w.manager.userId, s.instanceId);
    expect(center.mode).toBe('frozen');
    expect(center.values).toMatchObject({ selfEvaluation: SELF_A, managerRating: 'exceeds' });
    // 发起人（HR）读现值 B，来源 live
    const hr = await ownRead(s.w, s.w.hr.id, s.path);
    expect(hr.mode).toBe('live');
    expect(hr.body).toMatchObject({ selfEvaluation: SELF_B, managerRating: 'below' });
    expect((await centerRead(s.w, s.w.hr.id, s.instanceId)).mode).toBe('live');
  });

  it('员工（自评节点已办）读到自评办理那一刻的版本：当时经理还没评价，之后的评价不倒灌', async () => {
    const s = await handledAssessment(testDb().db, 'f476p7-08-employee', 'probation', PROBATION, {
      managerRating: 'below',
      regularizationDate: '2026-10-20',
    });
    const own = await ownRead(s.w, s.person.userId, s.path);
    expect(own.mode).toBe('frozen');
    expect(own.body.selfEvaluation).toBe(SELF_A);
    expect(own.body.managerRating ?? null).toBeNull();
    expect(own.body.regularizationOpinion ?? null).toBeNull();
  });

  it('缺份：自有详情与审批中心都 503，不退回现值；其他人的份不受影响（DEC-807）', async () => {
    const s = await handledAssessment(testDb().db, 'f476p7-08-missing', 'probation', PROBATION, {
      managerRating: 'below',
      regularizationDate: '2026-10-20',
    });
    await sabotageCopies(s.w, s.w.manager.userId, 'delete');
    expect((await ownRead(s.w, s.w.manager.userId, s.path)).status).toBe(503);
    expect((await centerRead(s.w, s.w.manager.userId, s.instanceId)).status).toBe(503);
    expect((await ownRead(s.w, s.person.userId, s.path)).mode).toBe('frozen');
  });

  it('缺扩展内容（旧份没有考核专用内容）：自有详情与审批中心同样 503，不拿通用快照 / 现值顶替', async () => {
    const s = await handledAssessment(testDb().db, 'f476p7-08-noext', 'probation', PROBATION, {
      managerRating: 'below',
      regularizationDate: '2026-10-20',
    });
    await sabotageCopies(s.w, s.w.manager.userId, 'null-ext');
    expect((await ownRead(s.w, s.w.manager.userId, s.path)).status).toBe(503);
    expect((await centerRead(s.w, s.w.manager.userId, s.instanceId)).status).toBe(503);
  });
});

describe('AC-F476-08 意向退休申请办理 → 修改 → 两路径', () => {
  it('上级驳回后 HR 改日期 / 原因并刷新快照：上级的“已办”读办理时的 A + E1，发起人读现值 B + E2', async () => {
    const s = await rejectedIntention(testDb().db, 'f476p7-08-intention');
    const own = await ownRead(s.w, s.w.manager.userId, s.path);
    expect(own.status).toBe(200);
    expect(own.mode).toBe('frozen');
    expect(own.body).toMatchObject({
      intendedDate: '2030-03-01',
      reason: REASON_A,
      expectedDateSnapshot: E1,
      status: 'rejected',
    });
    const center = await centerRead(s.w, s.w.manager.userId, s.instanceId);
    expect(center.mode).toBe('frozen');
    expect(center.values).toMatchObject({ intendedDate: '2030-03-01', reason: REASON_A, expectedDateSnapshot: E1 });
    const hr = await ownRead(s.w, s.w.hr.id, s.path);
    expect(hr.mode).toBe('live');
    expect(hr.body).toMatchObject({ intendedDate: '2030-04-01', reason: REASON_B, expectedDateSnapshot: E2 });
    const live = await s.w.get(s.id);
    expect(own.body.revision).toBe(live.revision);
  });

  it('不同意（终态）后自有详情仍标明来源 frozen，且两条路径一致', async () => {
    const w = await intentionWorld(testDb().db, 'f476p7-08-disagree');
    const created = await w.create({ intendedDate: '2030-05-01', reason: REASON_A });
    await w.act(created.id, 'submit');
    const instance = await w.instance(created.id);
    await w.decide(created.id, 'disagree');
    const path = `${EMPLOYMENT}/retirement-intentions/${created.id}`;
    const own = await ownRead(w, w.manager.userId, path);
    expect(own).toMatchObject({ status: 200, mode: 'frozen' });
    expect(own.body).toMatchObject({ status: 'disapproved', intendedDate: '2030-05-01', reason: REASON_A });
    const center = await centerRead(w, w.manager.userId, instance.id);
    expect(center.mode).toBe('frozen');
    expect(center.values).toMatchObject({ intendedDate: '2030-05-01', reason: REASON_A });
    expect((await ownRead(w, w.hr.id, path)).mode).toBe('live');
  });

  it('缺份与缺扩展：自有详情与审批中心都 503', async () => {
    for (const mode of ['delete', 'null-ext'] as const) {
      const s = await rejectedIntention(testDb().db, `f476p7-08-int-${mode}`);
      await sabotageCopies(s.w, s.w.manager.userId, mode);
      expect((await ownRead(s.w, s.w.manager.userId, s.path)).status, mode).toBe(503);
      expect((await centerRead(s.w, s.w.manager.userId, s.instanceId)).status, mode).toBe(503);
    }
  });
});
