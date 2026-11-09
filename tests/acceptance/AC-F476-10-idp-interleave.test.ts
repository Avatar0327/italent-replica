/**
 * AC-F476-10（P8 IDP，第 1 轮审查返工 P2-4；真 PostgreSQL，普通角色）：办理份的捕获读取遇到关键信息并发改动，
 * 只保存一份“真实存在过的完整状态”，或返回 409 而不留份。
 * 屏障：测试会话在事务里对 idp_careers 取表锁并保持——捕获按（带教 → 职业发展 → 带教班）顺序读，读完带教 A 后
 * 卡在职业发展；此时同一事务把带教、职业发展都改成 B 并提交，捕获才继续。这是审查里“带教 A + 职业发展 B”的交错
 * （真实提交状态只有 AA、BA、BB，AB 从未完整存在）。PGlite 单连接无法并发，仅在设了 TEST_DATABASE_URL 时运行。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { IDP, planWorld } from './AC-IDP-plan-support.js';
import { copiesOfPlan, GOAL_A } from './AC-F476-idp-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const span = { startDate: '2026-01-01', endDate: '2026-06-30' };
const TUTOR_A = 'ZZ_带教备注A';
const TUTOR_B = 'ZZ_带教备注B';
const CAREER_A = 'ZZ_优势A';
const CAREER_B = 'ZZ_优势B';

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-F476-10 IDP：捕获读取与关键信息并发改动', () => {
  it('读完带教 A 后，带教、职业发展被一起改成 B 并提交：不保存“带教 A + 职业发展 B”', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-10-keyinfo');
    for (const [path, body] of [
      [
        '/tutorships',
        { tutorEmployeeId: w.manager.employeeId, tuteeEmployeeId: w.employee.employeeId, remark: TUTOR_A },
      ],
      ['/careers', { employeeId: w.employee.employeeId, strengths: CAREER_A }],
    ] as const) {
      await w.ok(await w.http(w.hrUser, 'POST', `${IDP}${path}`, { ifMatch: 0, body: { ...body, ...span } }), 201);
    }
    const plan = await w.startedPlan();
    await w.addGoal(plan, w.employee.userId, { name: GOAL_A });
    const { instance, task } = await w.pendingTask(plan, 1, w.employee.userId);

    let pending: Promise<Response> | undefined;
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`LOCK TABLE idp_careers IN ACCESS EXCLUSIVE MODE`);
      pending = w.taskAction(w.employee.userId, task.id, 'approve', instance.revision);
      await waitForBlocked(w.db, 1); // 捕获已读完带教（A），卡在职业发展
      await tx.execute(sql`UPDATE idp_tutorships SET remark = ${TUTOR_B} WHERE tenant_id = ${w.tenant.id}::uuid`);
      await tx.execute(sql`UPDATE idp_careers SET strengths = ${CAREER_B} WHERE tenant_id = ${w.tenant.id}::uuid`);
    });
    const response = await pending!;
    expect([200, 409], await response.clone().text()).toContain(response.status);

    const copies = await copiesOfPlan(w, plan.id);
    for (const copy of copies) {
      const state = [copy.text.includes(TUTOR_A), copy.text.includes(CAREER_A)];
      const other = [copy.text.includes(TUTOR_B), copy.text.includes(CAREER_B)];
      const whole =
        (state[0] && state[1] && !other[0] && !other[1]) || (other[0] && other[1] && !state[0] && !state[1]);
      expect(whole, `办理份是未曾完整存在过的组合：${JSON.stringify({ state, other })}`).toBe(true);
    }
    if (response.status === 409) {
      expect(copies, '409 时不得留办理份').toHaveLength(0);
      expect((await w.pendingTask(await w.readPlan(plan.id), 1, w.employee.userId)).task.id).toBe(task.id);
    }
  });
});
