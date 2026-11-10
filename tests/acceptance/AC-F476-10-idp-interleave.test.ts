/**
 * AC-F476-10（P8 IDP，第 1 轮审查返工 P2-4；真 PostgreSQL，普通角色）：办理份的捕获读取遇到关键信息并发改动，
 * 只保存一份“真实存在过的完整状态”，或返回 409 而不留份。
 * 屏障：测试会话在事务里对 idp_careers 取表锁并保持——捕获按（带教 → 职业发展 → 带教班）顺序读，读完带教 A 后
 * 卡在职业发展；此时同一事务把带教、职业发展都改成 B 并提交，捕获才继续。这是审查里“带教 A + 职业发展 B”的交错
 * （真实提交状态只有 AA、BA、BB，AB 从未完整存在）。PGlite 单连接无法并发，仅在设了 TEST_DATABASE_URL 时运行。
 * 第 2 轮返工：往返交错 AA→BA→BB→BA→AA→BA→BB。表锁只能在每张表第一次被读之前卡住捕获，卡不住第二次读，所以改在
 * 进程内拦截 drizzle 的 execute：捕获每条读职业发展 / 轮岗的 SELECT 执行前，测试在另一连接上真实提交下一步状态。
 * 第 3 轮返工：模板模块的修改只锁模板、不锁计划。捕获读完模块名 A 后，依次提交“模块名 → B”“优势 → B”，再读关键信息：
 * 真实状态只有 AA → BA → BB（模块名 × 优势），不得保存 AB。
 * 第 4 轮返工：阶段名称取子流程现值（PATCH /idp/processes/:id 可改已引用子流程的名称，只锁流程、不锁计划）。捕获读完
 * 阶段名 A 后，依次提交“子流程名 → B”“优势 → B”，再读关键信息：真实状态只有 AA → BA → BB（阶段名 × 优势）。
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
const MODULE_A = 'ZZ_关键信息模块A';
const MODULE_B = 'ZZ_关键信息模块B';
const STAGE_A = 'ZZ_阶段名A';
const STAGE_B = 'ZZ_阶段名B';

type World = Awaited<ReturnType<typeof planWorld>>;

async function seeded(label: string) {
  const w = await planWorld(testDb().db, label);
  // 办理份只存模板配置的展示列（第 5 轮 P2-1）：带教区块改为展示备注，A / B 状态才能从份里辨认（职业发展取缺省含优势项）
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE idp_template_modules SET key_info_fields = ARRAY['tutorship.remark']
      WHERE tenant_id = ${w.tenant.id}::uuid AND module_type = 'key_info'`),
  );
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

/** 拦截捕获的关键信息 SELECT：每条执行前，按顺序跑完下一段真实提交；返回拦截次数的读取函数。 */
function gateKeyInfoReads(owner: { execute: (query: unknown) => Promise<unknown> }, steps: (() => Promise<unknown>)[]) {
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
  return () => gated;
}

/** drizzle 的 execute 定义在会话 / 事务共同的原型上；取一个真实事务对象沿原型链找到它。 */
async function executeOwner(w: World): Promise<{ execute: (query: unknown) => Promise<unknown> }> {
  let owner: object | null = await withTenant(w.db, w.tenant.id, async (tx) => tx);
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'execute')) owner = Object.getPrototypeOf(owner);
  return owner as { execute: (query: unknown) => Promise<unknown> };
}

/** 每份办理份的（配置名 × 优势）须是 AA / BA / BB 之一，且 A、B 不同时出现。 */
function expectExistedPairs(copies: { text: string }[], [nameA, nameB]: readonly [string, string]) {
  for (const copy of copies) {
    const seen = { nameA: copy.text.includes(nameA), nameB: copy.text.includes(nameB) };
    const career = { a: copy.text.includes(CAREER_A), b: copy.text.includes(CAREER_B) };
    const existed = [
      seen.nameA && career.a, // AA
      seen.nameB && career.a, // BA
      seen.nameB && career.b, // BB
    ].some(Boolean);
    const exclusive = seen.nameA !== seen.nameB && career.a !== career.b;
    expect(existed && exclusive, `办理份是未曾完整存在过的组合：${JSON.stringify({ seen, career })}`).toBe(true);
  }
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
    const gated = gateKeyInfoReads(await executeOwner(w), steps);
    const response = await w.taskAction(w.employee.userId, task.id, 'approve', instance.revision);
    vi.restoreAllMocks();
    expect(gated(), '捕获没有经过关键信息读取').toBeGreaterThan(0);
    expect([200, 409], await response.clone().text()).toContain(response.status);
    const copies = await expectWholeCopies(w, plan.id);
    if (response.status === 409) {
      expect(await response.clone().text()).toContain('IDP_KEY_INFO_CHANGING');
      expect(copies, '409 时不得留办理份').toHaveLength(0);
    } else expect(copies.length, '200 时应留下办理份').toBeGreaterThan(0);
  });

  it('读完模块名 A 后依次提交“模块名 → B”“优势 → B”：不保存“模块名 A + 优势 B”（模板只锁模板）', async () => {
    const { w, plan, instance, task } = await seeded('f476-idp-10-template');
    const rename = (name: string) =>
      withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`UPDATE idp_template_modules SET name = ${name} WHERE tenant_id = ${w.tenant.id}::uuid
          AND template_id = ${plan.templateId}::uuid AND module_type = 'key_info'`),
      );
    await rename(MODULE_A);
    // 捕获读关键信息之前：模块名 → B 提交，再优势 → B 提交（AA → BA → BB）
    const gated = gateKeyInfoReads(await executeOwner(w), [
      async () => {
        await rename(MODULE_B);
        await commit(w, 'idp_careers', CAREER_B);
      },
    ]);
    const response = await w.taskAction(w.employee.userId, task.id, 'approve', instance.revision);
    vi.restoreAllMocks();
    expect(gated(), '捕获没有经过关键信息读取').toBe(1);
    expect([200, 409], await response.clone().text()).toContain(response.status);
    const copies = await copiesOfPlan(w, plan.id);
    expectExistedPairs(copies, [MODULE_A, MODULE_B]);
    if (response.status === 409) {
      expect(await response.clone().text()).toContain('IDP_KEY_INFO_CHANGING');
      expect(copies, '409 时不得留办理份').toHaveLength(0);
    } else expect(copies.length, '200 时应留下办理份').toBeGreaterThan(0);
  });

  it('读完阶段名 A 后依次提交“子流程名 → B”“优势 → B”：不保存“阶段名 A + 优势 B”（子流程只锁流程）', async () => {
    const { w, plan, instance, task } = await seeded('f476-idp-10-stage');
    // 被办理阶段（第 1 段）所属子流程的名称；真实入口是 PATCH /idp/processes/:id（process-service 只锁流程）
    const rename = (name: string) =>
      withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`UPDATE idp_sub_processes SET name = ${name} WHERE tenant_id = ${w.tenant.id}::uuid
          AND id = (SELECT sub_process_id FROM idp_plan_stages WHERE tenant_id = ${w.tenant.id}::uuid
            AND plan_id = ${plan.id}::uuid AND seq = 1)`),
      );
    await rename(STAGE_A);
    // 捕获读关键信息之前：子流程名 → B 提交，再优势 → B 提交（AA → BA → BB）
    const gated = gateKeyInfoReads(await executeOwner(w), [
      async () => {
        await rename(STAGE_B);
        await commit(w, 'idp_careers', CAREER_B);
      },
    ]);
    const response = await w.taskAction(w.employee.userId, task.id, 'approve', instance.revision);
    vi.restoreAllMocks();
    expect(gated(), '捕获没有经过关键信息读取').toBe(1);
    expect([200, 409], await response.clone().text()).toContain(response.status);
    const copies = await copiesOfPlan(w, plan.id);
    expectExistedPairs(copies, [STAGE_A, STAGE_B]);
    if (response.status === 409) {
      expect(await response.clone().text()).toContain('IDP_KEY_INFO_CHANGING');
      expect(copies, '409 时不得留办理份').toHaveLength(0);
    } else expect(copies.length, '200 时应留下办理份').toBeGreaterThan(0);
  });
});
