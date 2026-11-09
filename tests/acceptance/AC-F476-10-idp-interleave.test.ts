/**
 * AC-F476-10（P8 IDP，第 1 轮审查返工 P2-4；真 PostgreSQL，普通角色）：办理份的捕获读取遇到关键信息并发改动，
 * 只保存一份“真实存在过的完整状态”，或返回 409 而不留份。
 * 屏障：测试会话在事务里对 idp_careers 取表锁并保持——捕获按（带教 → 职业发展 → 带教班）顺序读，读完带教 A 后
 * 卡在职业发展；此时同一事务把带教、职业发展都改成 B 并提交，捕获才继续。这是审查里“带教 A + 职业发展 B”的交错
 * （真实提交状态只有 AA、BA、BB，AB 从未完整存在）。PGlite 单连接无法并发，仅在设了 TEST_DATABASE_URL 时运行。
 * 第 2 轮返工：往返交错 AA→BA→BB→BA→AA→BA→BB。表锁只能在每张表第一次被读之前卡住捕获，卡不住第二次读，所以改在
 * 进程内拦截 drizzle 的 execute：捕获每条读职业发展 / 轮岗的 SELECT 执行前，测试在另一连接上真实提交下一步状态。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDP, planWorld } from './AC-IDP-plan-support.js';
import { copiesOfPlan, GOAL_A } from './AC-F476-idp-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const span = { startDate: '2026-01-01', endDate: '2026-06-30' };
const TUTOR_A = 'ZZ_带教备注A';
const TUTOR_B = 'ZZ_带教备注B';
const CAREER_A = 'ZZ_优势A';
const CAREER_B = 'ZZ_优势B';

type World = Awaited<ReturnType<typeof planWorld>>;

async function seeded(label: string) {
  const w = await planWorld(testDb().db, label);
  for (const [path, body] of [
    ['/tutorships', { tutorEmployeeId: w.manager.employeeId, tuteeEmployeeId: w.employee.employeeId, remark: TUTOR_A }],
    ['/careers', { employeeId: w.employee.employeeId, strengths: CAREER_A }],
  ] as const) {
    await w.ok(await w.http(w.hrUser, 'POST', `${IDP}${path}`, { ifMatch: 0, body: { ...body, ...span } }), 201);
  }
  const plan = await w.startedPlan();
  await w.addGoal(plan, w.employee.userId, { name: GOAL_A });
  return { w, plan, ...(await w.pendingTask(plan, 1, w.employee.userId)) };
}

/** 每份办理份必须是某一时刻完整存在过的状态：全 A 或全 B（本用例里 AB / BA 没有成为最终读取对象的机会）。 */
async function expectWholeCopies(w: World, planId: string) {
  const copies = await copiesOfPlan(w, planId);
  for (const copy of copies) {
    const state = [copy.text.includes(TUTOR_A), copy.text.includes(CAREER_A)];
    const other = [copy.text.includes(TUTOR_B), copy.text.includes(CAREER_B)];
    const whole = (state[0] && state[1] && !other[0] && !other[1]) || (other[0] && other[1] && !state[0] && !state[1]);
    expect(whole, `办理份是未曾完整存在过的组合：${JSON.stringify({ state, other })}`).toBe(true);
  }
  return copies;
}

/** 在另一连接上真实提交一步：只改带教或职业发展的值。 */
const commit = (w: World, table: 'idp_tutorships' | 'idp_careers', value: string) =>
  withTenant(w.db, w.tenant.id, (tx) =>
    table === 'idp_tutorships'
      ? tx.execute(sql`UPDATE idp_tutorships SET remark = ${value} WHERE tenant_id = ${w.tenant.id}::uuid`)
      : tx.execute(sql`UPDATE idp_careers SET strengths = ${value} WHERE tenant_id = ${w.tenant.id}::uuid`),
  );

/** drizzle 的 execute 定义在会话 / 事务共同的原型上；取一个真实事务对象沿原型链找到它。 */
async function executeOwner(w: World): Promise<{ execute: (query: unknown) => Promise<unknown> }> {
  let owner: object | null = await withTenant(w.db, w.tenant.id, async (tx) => tx);
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'execute')) owner = Object.getPrototypeOf(owner);
  return owner as { execute: (query: unknown) => Promise<unknown> };
}

afterEach(() => vi.restoreAllMocks());

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-F476-10 IDP：捕获读取与关键信息并发改动', () => {
  it('读完带教 A 后，带教、职业发展被一起改成 B 并提交：不保存“带教 A + 职业发展 B”', async () => {
    const { w, plan, instance, task } = await seeded('f476-idp-10-keyinfo');

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

    const copies = await expectWholeCopies(w, plan.id);
    if (response.status === 409) {
      expect(copies, '409 时不得留办理份').toHaveLength(0);
      expect((await w.pendingTask(await w.readPlan(plan.id), 1, w.employee.userId)).task.id).toBe(task.id);
    }
  });

  it('往返交错 AA→BA→BB→BA→AA→BA→BB：两遍读到同样的 AB 也不得保存（AB 从未存在）', async () => {
    const { w, plan, instance, task } = await seeded('f476-idp-10-roundtrip');
    // 捕获每次读职业发展 / 轮岗之前依次推进一段：→BB、→AA、→BB（各经过中间态 BA）
    const steps = [
      [TUTOR_B, CAREER_B],
      [CAREER_A, TUTOR_A],
      [TUTOR_B, CAREER_B],
    ].map((values) => async () => {
      for (const value of values)
        await commit(w, value.startsWith('ZZ_带教') ? 'idp_tutorships' : 'idp_careers', value);
    });
    const owner = await executeOwner(w);
    const original = owner.execute;
    let gated = 0;
    vi.spyOn(owner, 'execute').mockImplementation(async function (this: unknown, query: unknown) {
      const text = (this as { dialect: { sqlToQuery: (q: unknown) => { sql: string } } }).dialect.sqlToQuery(query).sql;
      if (/^\s*SELECT/i.test(text) && /idp_careers|idp_work_shifts/.test(text) && steps.length) {
        gated += 1;
        await steps.shift()!();
      }
      return original.call(this, query);
    });
    const response = await w.taskAction(w.employee.userId, task.id, 'approve', instance.revision);
    vi.restoreAllMocks();
    expect(gated, '捕获没有经过关键信息读取').toBeGreaterThan(0);
    expect([200, 409], await response.clone().text()).toContain(response.status);
    const copies = await expectWholeCopies(w, plan.id);
    if (response.status === 409) {
      expect(await response.clone().text()).toContain('IDP_KEY_INFO_CHANGING');
      expect(copies, '409 时不得留办理份').toHaveLength(0);
    } else expect(copies.length, '200 时应留下办理份').toBeGreaterThan(0);
  });
});
