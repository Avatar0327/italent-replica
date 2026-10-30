/**
 * R2-T04 BE-5b / AC-RT-01、AC-RT-22②：退休同时返聘（设计 §8）。
 * 同一个 POST retirements/employees/:id 带 reEmployed + rehire；退休生效时（activateExit 保存点内）在合同端口之后生成
 * kind=retire_rehire 的直接业务，返聘日 R = E′ + 1（DEC-637 A-1，退休记录只覆盖 E′ 当天）；顺延使 E′ 变化时 R 跟着变（DEC-638 A-15）。
 * 夹具里的日期都按口径手算（今天 2026-10-06）：L = 10-04 → 计划 E = 10-05 已过 → 当场生效并顺延为 E′ = 10-06、R = 10-07。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { blacklistApi } from './AC-DM-R2-blacklist-support.js';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { seedLegacyOrgDeactivation } from './AC-TRF-activation-support.js';
import { rehireWorld } from './AC-RT-rehire-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => rehireWorld(database().db, label, TODAY);

describe('AC-RT-01 / AC-RT-22② 直接退休同时返聘（L 已过，当场生效）', () => {
  it('退休记录只覆盖 E′ 当天，返聘日 = E′ + 1，新周期 retire_rehire；账号、组织负责人不变；合同旧的终止于 L′、新的起始于 R', async () => {
    const x = await world('rt01-direct');
    const master = await x.contractMaster();
    const oldContract = await x.createContract(master.typeId);
    await x.setHead(x.from, x.employee.id);
    const accountsBefore = await x.accountLinks();
    const plan = x.rehirePlan({ contract: x.contractPlan(master) });

    const created = await x.createdRehire(x.rehireBody('2026-10-04', 'direct', plan));

    // AC-RT-22②：生效读到的返聘计划已写好（同一请求内先写扩展行、随后当场生效）
    expect(created.status).toBe('effective');
    const extension = (await x.extension(created.id))!;
    expect(extension.re_employed).toBe(true);
    expect(extension.rehire_plan).toMatchObject({ fields: { departmentId: x.to.id }, entry: { probation: false } });
    expect(extension.rehire_business_id).toBeTruthy();

    const timeline = await x.timeline();
    expect(timeline.map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['retirement', '2026-10-06'],
      ['retire_rehire', '2026-10-07'],
    ]);
    expect(timeline[1]!.valid).toBe('[2026-10-06,2026-10-07)');
    expect(timeline[2]!.record_id).toBe(extension.rehire_business_id);
    expect(await x.cycles()).toEqual([
      { entry_type: 'hire', entry_date: '2026-09-01' },
      { entry_type: 'retire_rehire', entry_date: '2026-10-07' },
    ]);

    // 账号与登录关联不变；未转交的组织角色仍属本人（RT-R3）
    expect(await x.accountLinks()).toEqual(accountsBefore);
    expect(await x.headOf(x.from.id)).toBe(x.employee.id);

    // 旧合同终止于 L′ = 10-05；返聘合同由合同端口按返聘日 R 生成（R 在未来：已批准的直接新建，到期由合同调度落地）
    expect((await x.contractStarts()).map((row) => [row.id, row.status, row.effective_date, row.actual])).toEqual([
      [oldContract.id, 'terminated', '2026-01-01', '2026-10-05'],
    ]);
    const requests = (await x.contractRequestsOf()).filter((row) => row.effective_date === '2026-10-07');
    expect(requests).toEqual([
      { id: expect.any(String), operation: 'create', status: 'approved', mode: 'direct', effective_date: '2026-10-07' },
    ]);

    // 台账与审计
    expect((await x.rehireEffects(created.id)).map((row) => row.target_id)).toEqual([extension.rehire_business_id]);
    const [audit] = await x.audits(created.id, 'employment.retirement.rehired');
    expect(audit!.after).toMatchObject({
      rehireBusinessId: extension.rehire_business_id,
      rehireDate: '2026-10-07',
      rehireContractId: requests[0]!.id,
      initiatorUserId: x.session.user.id,
    });
    expect(await x.audits(created.id, 'employment.retirement.effective')).toHaveLength(1);
  });

  it('申请退休：审批通过后迟到执行，E′ 顺延，返聘日跟着顺延（R 一律由 E′ 算出，不另存）', async () => {
    const x = await world('rt01-postponed');
    const draft = await x.createdRehire(x.rehireBody('2026-10-15', 'application'));
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect((await x.approve(draft, `${TODAY}T02:00:00Z`)).status).toBe('approved');
    expect((await x.extension(draft.id))!.rehire_business_id).toBeNull();

    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ activated: [draft.id], failed: [] });
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['retirement', '2026-10-18'],
      ['retire_rehire', '2026-10-19'],
    ]);
    expect((await x.audits(draft.id, 'employment.retirement.rehired'))[0]!.after).toMatchObject({
      rehireDate: '2026-10-19',
    });
  });

  it('审批最后节点同意且 E 已到：审批事务内生效并生成返聘（审批触发入口）', async () => {
    const x = await world('rt01-approval');
    const draft = await x.createdRehire(x.rehireBody('2026-10-05', 'application'));
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect((await x.approve(draft, `${TODAY}T02:00:00Z`)).status).toBe('effective');
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['retirement', '2026-10-06'],
      ['retire_rehire', '2026-10-07'],
    ]);
    expect((await x.extension(draft.id))!.rehire_business_id).toBeTruthy();
  });

  it('返聘计划带试用期：返聘任职写试用期第 1 版，开始日 = 返聘日', async () => {
    const x = await world('rt01-probation');
    const plan = x.rehirePlan({ entry: { probation: true, probationMonths: 3 } });
    const created = await x.createdRehire(x.rehireBody('2026-10-04', 'direct', plan));
    const rehireId = (await x.extension(created.id))!.rehire_business_id!;
    expect(
      await x.sqlRows(sql`SELECT version_no, has_probation, months, start_date::text AS start_date
        FROM employment_probation_versions WHERE tenant_id=${x.session.tenant.id} AND business_id=${rehireId}::uuid`),
    ).toEqual([{ version_no: 1, has_probation: true, months: 3, start_date: '2026-10-07' }]);
  });

  it('不同时返聘的退休不生成返聘；reEmployed = false 等同不填', async () => {
    const x = await world('rt01-plain');
    const created = await x.createdRehire({ mode: 'direct', lastWorkDate: '2026-10-04', reEmployed: false });
    expect(created.status).toBe('effective');
    expect(await x.extension(created.id)).toMatchObject({ re_employed: false, rehire_plan: null });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement']);
    expect(await x.rehireEffects(created.id)).toEqual([]);
  });
});

describe('AC-RT-22② 创建时校验（结构与业务），失败整单不留痕', () => {
  let structureCase = 0;
  const plan = (x: Awaited<ReturnType<typeof world>>) => x.rehirePlan();

  it.each([
    ['rehire 没有 reEmployed', (p: object) => ({ rehire: p })],
    ['reEmployed = true 没有 rehire', () => ({ reEmployed: true })],
    ['reEmployed = false 却带 rehire', (p: object) => ({ reEmployed: false, rehire: p })],
    [
      'rehire 带 loginEmail（沿用原账号）',
      (p: object) => ({ reEmployed: true, rehire: { ...p, loginEmail: 'a@example.com' } }),
    ],
    [
      'rehire.entry 带 pendingEntry',
      (p: object) => ({ reEmployed: true, rehire: { ...p, entry: { pendingEntry: true } } }),
    ],
    [
      'rehire.entry 试用期月数没有“有试用期”',
      (p: object) => ({ reEmployed: true, rehire: { ...p, entry: { probation: false, probationMonths: 3 } } }),
    ],
    [
      'rehire 带 effectiveDate（返聘日只由 E′ 决定）',
      (p: object) => ({ reEmployed: true, rehire: { ...p, effectiveDate: '2026-12-01' } }),
    ],
  ])('%s → 400，前后读取逐项相等', async (_name, build) => {
    const x = await world(`rt22-structure-${(structureCase += 1)}`);
    const before = await x.stateOf(x.employee.id);
    const response = await x.postRehire({ mode: 'direct', lastWorkDate: '2026-10-04', ...build(plan(x)) });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });

  it('返聘部门在返聘日 R 已停用（创建时干跑）→ 400，前后读取逐项相等', async () => {
    const x = await world('rt22-business');
    await seedLegacyOrgDeactivation(x, '2026-10-07', x.to);
    const before = await x.stateOf(x.employee.id);
    const response = await x.postRehire(x.rehireBody('2026-10-04', 'direct'));
    expect(await x.reason(response)).toMatchObject({
      status: 400,
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });

  it('员工当前在黑名单：创建时 409 EMPLOYEE_BLACKLISTED，不留任何写入', async () => {
    const x = await world('rt22-blacklisted');
    await blacklistApi(x.session).added({ employeeId: x.employee.id, reason: 'instability' });
    const before = await x.stateOf(x.employee.id);
    const response = await x.postRehire(x.rehireBody('2026-10-04', 'direct'));
    expect(await x.reason(response)).toMatchObject({ status: 409, reason: 'EMPLOYEE_BLACKLISTED' });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });

  it('字段权按 Employment.Create：没有该按钮 403；有退休按钮也不行', async () => {
    const x = await world('rt22-create-button');
    const before = await x.stateOf(x.employee.id);
    const response = await x.postRehire(
      x.rehireBody('2026-10-04', 'direct'),
      x.employee.id,
      x.restricted(denyButtons('Employment.Create')),
    );
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    // 对照：普通退休（不返聘）不要求 Employment.Create
    const plain = await x.postRehire(
      { mode: 'application', lastWorkDate: '2026-10-20' },
      x.employee.id,
      x.restricted(denyButtons('Employment.Create')),
    );
    expect(plain.status, await plain.clone().text()).toBe(201);
  });

  it('合同授权按发起人重验：没有合同“新建”按钮 403，不留任何写入', async () => {
    const x = await world('rt22-contract-button');
    const master = await x.contractMaster();
    const before = await x.stateOf(x.employee.id);
    const response = await x.postRehire(
      x.rehireBody('2026-10-04', 'direct', x.rehirePlan({ contract: x.contractPlan(master) })),
      x.employee.id,
      x.restricted(denyButtons('create')),
    );
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });

  it('预览含返聘校验：返回返聘日，部门不可用时给 blockers 而不抛错', async () => {
    const x = await world('rt22-preview');
    const ok = await x.session.request('POST', `/retirements/employees/${x.employee.id}/preview`, {
      body: { lastWorkDate: '2026-10-04', reEmployed: true, rehire: x.rehirePlan() },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ rehire: { startDate: '2026-10-07', blockers: [] } });
    const bad = await x.session.request('POST', `/retirements/employees/${x.employee.id}/preview`, {
      body: {
        lastWorkDate: '2026-10-04',
        reEmployed: true,
        rehire: x.rehirePlan({ departmentId: '00000000-0000-4000-8000-000000000001' }),
      },
    });
    expect(bad.status, await bad.clone().text()).toBe(200);
    expect(((await bad.json()) as { rehire: { blockers: unknown[] } }).rehire.blockers).not.toHaveLength(0);
  });
});
