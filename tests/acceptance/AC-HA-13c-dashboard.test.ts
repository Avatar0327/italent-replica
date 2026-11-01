/**
 * AC-HA-13c 人事流程看板（规格 35 B51，R2 BE-13c）：四个模块 24 个组件的口径、数字 = 明细、筛选、范围与授权。
 * 夹具全部走真实接口（setNow 控制发起 / 审批时刻），期望值是手写的实例 / 任务 / 业务单据 ID 集合。
 *
 * 时间轴（租户时区 Asia/Shanghai，T01:00Z = 当地 09:00；asOf = 2026-10-20，默认发起时间窗口 09-21～10-20）：
 *   已通过调动  业务日期  发起        完成            说明
 *   A          10-01    10-05       10-06           晚提交（发起 > 业务日期）
 *   B          10-05    10-05       10-05 13:00     发起 = 业务日期、完成 = 业务日期：都不算晚
 *   C          10-05    10-02       10-05           完成 = 业务日期：不算晚审批
 *   D          10-05    10-02       10-07           晚审批（完成 > 业务日期且发起 < 业务日期）
 *   E          10-15    09-21       09-22           窗口起点当天发起：计入
 *   OUT        09-20    09-20       09-21           窗口前一天发起：不计
 *   在途调动 F 业务日期 10-10（已过期）发起 10-12（等待 8 天）；G 10-25 发起 10-16（4 天，当前审批人已离职）；
 *   L 10-20（= 今天，不算过期）发起 10-17（3 天，不算超过 3 天）；W 发起 10-08、10-09 撤回（已完结）；
 *   退休 R（类别“其他”）业务日期 10-01 发起 10-03 在途：不进 6 类核心流程的组件。
 *   不走流程：直接调动（10-10）、直接离职（审批人离职那张，10-17）、直接新建合同（10-10）计入业务总量。
 *   ④ 的业务单据按提交 / 办理时刻的当地日期落入发起时间窗口（直接办理 = 保存时刻，Offer / 合同 = 创建时刻），
 *   在途 / 撤回 / 作废的不算业务总量；Offer 审批中（O4，10-19 提交）、被否决（O5）的也不算。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { presetSeeAllTargets, STANDARD_PROFILES, type HrProcessComponentCode } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { installApprovalFallbacks, type InstanceView, type Person } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { offerApprovalWorld } from './AC-OF-BE14a3-support.js';
import { PROCESS_BASE, processClient, sorted, type ProcessClient } from './AC-HA-13c-support.js';

const database = useTestDb();
const AS_OF = '2026-10-20';
const OBJECT = 'TenantBase.HrProcessDashboard';
const at = (date: string, hour = '01') => `${date}T${hour}:00:00.000Z`;
const TRANSFER = 'category=transfer';

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

type World = Awaited<ReturnType<typeof offerApprovalWorld>>;
interface Flow {
  readonly instance: string;
  readonly task: string;
  readonly business: string;
}

async function buildWorld(w: World) {
  // 流程在 09-01 发布，早于全部发起时刻
  w.setNow(at('2026-09-01'));
  const x = await w.org('一级组织X');
  const x2 = await w.org('X下属部门', x);
  const y = await w.org('一级组织Y');
  const y2 = await w.org('Y下属部门', y);
  const xHead = await w.person('X负责人', x);
  await w.setOrgRoles(x, { head: xHead.employeeId });
  const boss = await w.person('直线经理', x);
  const leaver = await w.person('将离职的经理', x);
  const subject = (name: string, dept: string, manager: Person = boss) =>
    w.person(name, dept, { directManagerId: manager.employeeId });
  const s = {
    a: await subject('甲', x2),
    b: await subject('乙', x2),
    c: await subject('丙', x2),
    d: await subject('丁', y),
    e: await subject('戊', y),
    out: await subject('窗外', x),
    f: await subject('过期', x2),
    g: await subject('经理已离职', x, leaver),
    l: await subject('今天到期', x2),
    w: await subject('撤回', x),
    direct: await subject('直接调动', y),
    retire: await subject('退休', x),
  };
  await installExitSeeds(w.db, w.tenant.id);
  await w.publishedProcess({
    nodes: [{ key: 'mgr', name: '直线经理审批', approver: { type: 'object_field', value: 'direct_manager' } }],
  });
  await w.publishedProcess({
    approvalType: 'retirement',
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'RetireProcess' }] },
    nodes: [
      { key: 'head', name: '部门负责人审批', approver: { type: 'department', value: 'latest_record_department_head' } },
    ],
  });

  async function submitted(person: Person, to: string, businessDate: string, submitAt: string) {
    w.setNow(submitAt);
    const business = await w.application(person.employeeId, { departmentId: to }, { effectiveDate: businessDate });
    const view = await w.submit(business);
    return { view, business: business.id };
  }
  async function approved(person: Person, to: string, businessDate: string, submitAt: string, doneAt: string) {
    const { view, business } = await submitted(person, to, businessDate, submitAt);
    const task = w.pending(view)[0]!;
    expect(task.assigneeUserId).toBe(boss.userId);
    w.setNow(doneAt);
    const done = await w.json<InstanceView>(await w.taskAction(boss.userId, task.id, 'approve', view.revision));
    expect(done.status).toBe('approved');
    return { instance: view.id, task: task.id, business } satisfies Flow;
  }
  async function pending(person: Person, to: string, businessDate: string, submitAt: string) {
    const { view, business } = await submitted(person, to, businessDate, submitAt);
    return { instance: view.id, task: w.pending(view)[0]!.id, business } satisfies Flow;
  }
  async function create(person: Person, body: Record<string, unknown>) {
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${person.employeeId}`),
    );
    return w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${person.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body,
      }),
      201,
    );
  }

  const flows = {
    a: await approved(s.a, x, '2026-10-01', at('2026-10-05'), at('2026-10-06')),
    b: await approved(s.b, x, '2026-10-05', at('2026-10-05'), at('2026-10-05', '05')),
    c: await approved(s.c, x, '2026-10-05', at('2026-10-02'), at('2026-10-05')),
    d: await approved(s.d, y2, '2026-10-05', at('2026-10-02'), at('2026-10-07')),
    e: await approved(s.e, y2, '2026-10-15', at('2026-09-21'), at('2026-09-22')),
    out: await approved(s.out, x2, '2026-09-20', at('2026-09-20'), at('2026-09-21')),
    f: await pending(s.f, x, '2026-10-10', at('2026-10-12')),
    g: await pending(s.g, x2, '2026-10-25', at('2026-10-16')),
    l: await pending(s.l, x, '2026-10-20', at('2026-10-17')),
    w: await pending(s.w, x2, '2026-10-09', at('2026-10-08')),
  };
  w.setNow(at('2026-10-09'));
  const withdrawn = await w.detail(flows.w.instance);
  await w.json(await w.instanceAction(w.hr.id, flows.w.instance, 'withdraw', withdrawn.revision));
  // 退休（“其他”类别）：在途、已过期、等待很久，但不属于 6 类核心流程
  w.setNow(at('2026-10-03'));
  const retire = await create(s.retire, {
    kind: 'retirement',
    mode: 'application',
    lastWorkDate: '2026-10-01',
    fields: {},
  });
  const retireView = await w.submit(retire);
  // 不走流程的直接调动：计入调动业务总量
  w.setNow(at('2026-10-10'));
  const direct = await create(s.direct, {
    kind: 'transfer',
    mode: 'direct',
    effectiveDate: '2026-10-10',
    fields: { departmentId: y2 },
  });
  // G 的当前审批人离职（直接离职，不走流程）：任务仍在其名下
  w.setNow(at('2026-10-17'));
  const exit = await create(leaver, { kind: 'leave', mode: 'direct', lastWorkDate: '2026-10-17', fields: {} });
  expect(w.pending(await w.detail(flows.g.instance)).map((t) => t.assigneeUserId)).toEqual([leaver.userId]);

  // Offer：O1 走审批并通过；O2 不走审批；O3 窗口前创建
  w.setNow(at('2026-09-20'));
  const o3 = await w.offer(w.applicant);
  w.setNow(at('2026-10-02'));
  const o1 = await w.offer(w.applicant);
  expect((await w.submitRaw(o1)).status).toBe(200);
  const o1View = await w.instance(o1.id);
  w.setNow(at('2026-10-03'));
  await w.decide(o1View, w.head, 'approve');
  const o2 = await w.offer(w.applicant);

  // 合同：直接新建（不走流程）+ 申请新建（走兜底流程）
  const master = async (kind: string, name: string) =>
    (
      await w.json<{ id: string }>(
        await w.request(w.hr.id, 'POST', `/api/tenant/contracts/master-data/${kind}`, {
          ifMatch: 0,
          body: { code: randomUUID(), name },
        }),
        201,
      )
    ).id;
  const type = await master('types', '劳动合同');
  const company = await master('companies', '合成法人公司');
  await installApprovalFallbacks(w.db, w.tenant.id, w.hr.id, ['contract_create']);
  const contract = async (person: Person, mode: string, effectiveDate: string, endDate: string) => {
    const fields = { typeId: type, companyId: company, effectiveDate, endDate, termType: 'fixed', termMonths: 24 };
    await w.json(
      await w.request(w.hr.id, 'POST', '/api/tenant/contracts/commands', {
        ifMatch: 0,
        body: {
          operation: 'create',
          mode,
          employeeId: person.employeeId,
          fields: { ...fields, signingDate: '2026-10-01' },
        },
      }),
      201,
    );
  };
  w.setNow(at('2026-10-10'));
  await contract(s.a, 'direct', '2026-10-10', '2028-10-09');
  w.setNow(at('2026-10-12'));
  await contract(s.b, 'application', '2026-10-12', '2028-10-11');
  const contractRequests = await withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ id: string; employee: string }>(
      await tx.execute(sql`SELECT id::text AS id, employee_id::text AS employee FROM contract_requests
        WHERE tenant_id=${w.tenant.id} ORDER BY created_at`),
    ),
  );
  const contractOf = (person: Person) => contractRequests.find((row) => row.employee === person.employeeId)!.id;
  const contractInstance = (
    await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ id: string; status: string }>(
        await tx.execute(sql`SELECT id::text AS id, status FROM approval_instances
          WHERE tenant_id=${w.tenant.id} AND approval_category='contract'`),
      ),
    )
  )[0]!;
  // 兜底流程的审批人 = 发起人（HR），在 10-12 当天同意
  const contractView = await w.detail(contractInstance.id);
  const contractTask = w.pending(contractView)[0]!;
  const contractDone = await w.taskAction(
    contractTask.assigneeUserId,
    contractTask.id,
    'approve',
    contractView.revision,
  );
  expect((await w.json<InstanceView>(contractDone)).status).toBe('approved');

  // Offer O4：窗口内提交、仍在审批中；O5：窗口内提交、被否决。两张都不算 Offer 业务总量（规格 35 ④“已审批通过或已生效”）
  w.setNow(at('2026-10-19'));
  const o4 = await w.offer(w.applicant);
  expect((await w.submitRaw(o4)).status).toBe(200);
  const o4Instance = (await w.instance(o4.id)).id;
  const o5 = await w.offer(w.applicant);
  expect((await w.submitRaw(o5)).status).toBe(200);
  const o5View = await w.instance(o5.id);
  await w.decide(o5View, w.head, 'disagree');
  expect((await w.get(o5.id)).approvalStatus).toBe('disapproved');
  expect((await w.get(o4.id)).approvalStatus).toBe('approving');

  w.setNow(at(AS_OF));
  return {
    org: { x, x2, y, y2 },
    boss,
    leaver,
    s,
    flows,
    retire: retireView.id,
    direct: direct.id,
    exit: exit.id,
    offers: { o1, o2, o3, o1Instance: o1View.id, o4, o4Instance, o5, o5Instance: o5View.id },
    company,
    contracts: { direct: contractOf(s.a), application: contractOf(s.b), instance: contractInstance.id },
  };
}

let w: World;
let f: Awaited<ReturnType<typeof buildWorld>>;
let board: ProcessClient;

beforeAll(async () => {
  w = await offerApprovalWorld(database().db, 'ha13c');
  f = await buildWorld(w);
  board = processClient(w.db, { tenant: w.tenant.id, user: w.hr.id }, { now: () => new Date(at(AS_OF)) });
}, 600_000);

const instances = (...keys: (keyof typeof f.flows)[]) => keys.map((key) => f.flows[key].instance);

describe('AC-HA-13c 外壳：默认时段、组件目录', () => {
  it('不带参数：asOf = 租户当地今天，发起时间默认近 30 天；24 个组件按规格编号返回', async () => {
    const overview = await board.overview();
    expect(overview).toMatchObject({ asOf: AS_OF, from: '2026-09-21', to: AS_OF, hasDataPermission: true });
    expect(overview.components.map((c) => c.no)).toEqual([
      ...['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map((n) => `7.2.${n}`),
      ...['11', '12', '13', '14', '15', '16', '17', '18', '19'].map((n) => `7.2.${n}`),
      ...['20', '21', '22', '23', '24'].map((n) => `7.1.${n}`),
    ]);
  });
});

describe('AC-HA-13c ① 在途流程监控（只统计 6 类核心流程）', () => {
  it('7.2.01 共发起 / 在途：窗口内的核心流程；退休（其他）与窗口前发起的不计', async () => {
    const offers = [f.offers.o1Instance, f.offers.o4Instance, f.offers.o5Instance];
    const all = [...instances('a', 'b', 'c', 'd', 'e', 'f', 'g', 'l', 'w'), ...offers, f.contracts.instance];
    await board.expectComponent('inFlightCount', { all, hits: [...instances('f', 'g', 'l'), f.offers.o4Instance] });
    await board.expectComponent(
      'inFlightCount',
      {
        all: instances('a', 'b', 'c', 'd', 'e', 'f', 'g', 'l', 'w'),
        hits: instances('f', 'g', 'l'),
      },
      TRANSFER,
    );
    // 窗口起点放宽一天，窗口前一天发起的 OUT 随即计入
    const wider = await board.detail('inFlightCount', 'from=2026-09-20');
    expect(wider.map((item) => item.id)).toContain(f.flows.out.instance);
    expect((await board.detail('inFlightCount')).map((item) => item.id)).not.toContain(f.retire);
  });

  it('7.2.02 在途异常：当前审批人已离职 / 业务已过期（业务日期 < 今天），业务日期 = 今天不算过期', async () => {
    await board.expectComponent('inFlightAbnormal', { all: instances('f', 'g') });
    await board.expectGroup('inFlightAbnormal', { group: 'approverLeft' }, instances('g'));
    await board.expectGroup('inFlightAbnormal', { group: 'expired' }, instances('f'));
  });

  it('7.2.03 等待超过 3 天，副值超过 7 天：等待恰为 3 天不计', async () => {
    await board.expectComponent('inFlightWaiting', { all: instances('f', 'g'), hits: instances('f') });
  });

  it('7.2.04 当前审批人 × 类别', async () => {
    await board.expectGroup('inFlightByApprover', { group: f.boss.userId, series: 'transfer' }, instances('f', 'l'));
    await board.expectGroup('inFlightByApprover', { group: f.leaver.userId, series: 'transfer' }, instances('g'));
  });

  it('7.2.05 在途明细 14 列', async () => {
    const items = await board.detail('inFlightList');
    expect(sorted(items.map((item) => item.id))).toEqual(sorted([...instances('f', 'g', 'l'), f.offers.o4Instance]));
    const g = items.find((item) => item.id === f.flows.g.instance)!;
    expect(g).toMatchObject({
      instanceId: f.flows.g.instance,
      title: '调动申请',
      category: 'transfer',
      currentNode: '直线经理审批',
      currentApproverUserId: f.leaver.userId,
      approverStatus: 'left',
      departmentId: f.org.x,
      directManagerId: f.leaver.employeeId, // G 的直线经理是将离职的经理（夹具第 71 行）
      initiatorUserId: w.hr.id,
      startedAt: at('2026-10-16'),
      arrivedAt: at('2026-10-16'),
      businessDate: '2026-10-25',
      abnormalTypes: ['approverLeft'],
      waitBucket: 'gt3',
      approvedCount: 0,
    });
    const byId = (id: string) => items.find((item) => item.id === id)!;
    expect([byId(f.flows.f.instance), byId(f.flows.l.instance)].map((i) => [i.abnormalTypes, i.waitBucket])).toEqual([
      [['expired'], 'gt7'],
      [[], 'le3'],
    ]);
    expect(byId(f.flows.f.instance).approverStatus).toBe('active');
  });

  it('流程所属部门筛选：只看该部门的流程', async () => {
    const component = await board.component('inFlightCount', `departmentId=${f.org.x2}`);
    const hits = await board.detail('inFlightCount', `departmentId=${f.org.x2}`, { hit: true });
    expect({ hits: component.hits, ids: sorted(hits.map((i) => i.id)) }).toEqual({
      hits: 2,
      ids: sorted(instances('f', 'l')),
    });
  });
});

describe('AC-HA-13c ② 流程时效（只统计已通过）', () => {
  it('7.2.06 按发起周：流程平均耗时 = AVG(完成 − 发起)，单位天', async () => {
    const row = await board.expectComponent('durationByWeek', { all: instances('a', 'b', 'c', 'd', 'e') }, TRANSFER);
    expect(row.average).toBe(2.03);
    expect(row.groups.map((g) => [g.key, g.count, g.average])).toEqual([
      ['2026-09-21', 1, 1],
      ['2026-09-28', 2, 4],
      ['2026-10-05', 2, 0.58],
    ]);
    await board.expectGroup('durationByWeek', { group: '2026-09-28' }, instances('c', 'd'), TRANSFER);
  });

  it('7.2.07 按类别：不限 6 类，Offer / 合同各自成组', async () => {
    await board.expectGroup('durationByCategory', { group: 'transfer' }, instances('a', 'b', 'c', 'd', 'e'));
    await board.expectGroup('durationByCategory', { group: 'offer' }, [f.offers.o1Instance]);
    await board.expectGroup('durationByCategory', { group: 'contract' }, [f.contracts.instance]);
    expect((await board.detail('durationByCategory')).map((i) => i.id)).not.toContain(f.flows.w.instance);
  });

  it('7.2.08 / 09 任务平均耗时 = AVG(任务完成 − 任务到达)：按节点、按审批人（附审批计数）', async () => {
    const tasks = (['a', 'b', 'c', 'd', 'e'] as const).map((key) => f.flows[key].task);
    // 节点组键 = 流程版本 + 节点键（第 2 轮），取概览给出的组键钻取
    const { groups } = await board.component('taskDurationByNode', TRANSFER);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    const node = await board.expectGroup('taskDurationByNode', { group: group!.key }, tasks, TRANSFER);
    expect([node?.label, node?.average, group!.key.endsWith(':mgr')]).toEqual(['直线经理审批', 2.03, true]);
    const approver = await board.expectGroup('taskDurationByApprover', { group: f.boss.userId }, tasks, TRANSFER);
    expect([approver?.count, approver?.average]).toEqual([5, 2.03]);
  });

  it('7.2.10 按二级组织：子部门上溯到一级组织', async () => {
    const x = await board.expectGroup('durationByOrg', { group: f.org.x }, instances('a', 'b', 'c'), TRANSFER);
    const y = await board.expectGroup('durationByOrg', { group: f.org.y }, instances('d', 'e'), TRANSFER);
    expect([x?.average, y?.average]).toEqual([1.39, 3]);
  });
});

describe('AC-HA-13c ③ 流程质量（已通过、6 类核心流程）', () => {
  it('7.2.11 不合规 = 晚提交 + 晚审批，按发起周', async () => {
    const row = await board.expectComponent(
      'nonCompliantByWeek',
      { all: instances('a', 'b', 'c', 'd', 'e'), hits: instances('a', 'd') },
      TRANSFER,
    );
    expect(row.groups.map((g) => [g.key, g.count, g.hits])).toEqual([
      ['2026-09-21', 1, 0],
      ['2026-09-28', 2, 1],
      ['2026-10-05', 2, 1],
    ]);
  });

  it('7.2.12 / 13 晚提交（发起 > 业务日期，等于不算）：按类别、按发起人', async () => {
    await board.expectComponent('lateSubmitByCategory', { all: instances('a') });
    await board.expectGroup('lateSubmitByCategory', { group: 'transfer' }, instances('a'));
    await board.expectGroup('lateSubmitByInitiator', { group: w.hr.id }, instances('a'));
  });

  it('7.2.14 / 15 晚审批（完成 > 业务日期且发起 < 业务日期，完成 = 业务日期不算）：按类别、按审批人', async () => {
    await board.expectComponent('lateApprovalByCategory', { all: instances('d') });
    await board.expectGroup('lateApprovalByApprover', { group: f.boss.userId }, [f.flows.d.task]);
  });

  it('7.2.16～19 发起 / 完成 − 业务日期 平均天数，及按类别拆分', async () => {
    const all = instances('a', 'b', 'c', 'd', 'e');
    expect((await board.expectComponent('submitLag', { all }, TRANSFER)).average).toBe(-5.2);
    expect((await board.expectComponent('approveLag', { all }, TRANSFER)).average).toBe(-3.2);
    expect((await board.expectGroup('submitLagByCategory', { group: 'transfer' }, all))?.average).toBe(-5.2);
    expect((await board.expectGroup('approveLagByCategory', { group: 'transfer' }, all))?.average).toBe(-3.2);
    // 不限类别时 Offer、合同也在内（其业务日期分别 = 入职日期、合同生效日期）
    const everything = await board.detail('submitLag');
    expect(sorted(everything.map((i) => i.id))).toEqual(sorted([...all, f.offers.o1Instance, f.contracts.instance]));
  });
});

describe('AC-HA-13c ④ 流程应用（审批占比 = 审批总量 ÷ 业务总量，不走流程的业务计入业务总量）', () => {
  const businesses = (...keys: (keyof typeof f.flows)[]) => keys.map((key) => f.flows[key].business);

  it('7.1.21 调动：窗口内提交 / 办理、已通过 / 已生效的调动；直接调动计入业务总量，不计审批总量', async () => {
    const row = await board.expectComponent('transferApprovalRate', {
      all: [...businesses('a', 'b', 'c', 'd', 'e'), f.direct],
      hits: businesses('a', 'b', 'c', 'd', 'e'),
    });
    expect(row.rate).toBe(0.8333);
    await board.expectGroup('transferApprovalRate', { group: f.org.x }, businesses('a', 'b', 'c'));
    await board.expectGroup('transferApprovalRate', { group: f.org.y }, [...businesses('d', 'e'), f.direct]);
  });

  it('7.1.22 离职：直接离职计入业务总量；退休不算离职', async () => {
    const row = await board.expectComponent('exitApprovalRate', { all: [f.exit], hits: [] });
    expect(row.rate).toBe(0);
  });

  it('7.1.23 转正：没有转正业务时业务总量为 0，占比为空', async () => {
    const row = await board.expectComponent('regularizationApprovalRate', { all: [], hits: [] });
    expect(row.rate).toBeNull();
  });

  it('7.1.20 Offer：窗口内创建的 Offer，按录用部门；窗口前创建的、审批中的、被否决的不计', async () => {
    const row = await board.expectComponent('offerApprovalRate', {
      all: [f.offers.o1.id, f.offers.o2.id],
      hits: [f.offers.o1.id],
    });
    expect(row.rate).toBe(0.5);
    await board.expectGroup('offerApprovalRate', { group: w.department }, [f.offers.o1.id, f.offers.o2.id]);
    const unhit = await board.detail('offerApprovalRate', '', { hit: false });
    expect(unhit.map((item) => item.id)).toEqual([f.offers.o2.id]);
  });

  it('7.1.24 合同：按签约公司，直接新建计入业务总量', async () => {
    await board.expectComponent('contractApprovalRate', {
      all: [f.contracts.direct, f.contracts.application],
      hits: [f.contracts.application],
    });
    await board.expectGroup('contractApprovalRate', { group: f.company }, [
      f.contracts.direct,
      f.contracts.application,
    ]);
  });
});

describe('AC-HA-13c 范围与授权', () => {
  const scoped = (scope: ModuleScope) => {
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => scope,
      authorize: async (request) => authorize(request),
      fields: async () => new Set(),
    });
    return processClient(w.db, { tenant: w.tenant.id, user: w.hr.id }, { now: () => new Date(at(AS_OF)), authorize });
  };
  const management = (orgIds: string[]): ModuleScope => ({
    ...EMPTY_SCOPE,
    hasDataPermission: true,
    orgIds,
    terms: [
      {
        dimension: 'management',
        orgIds,
        personIds: [],
        personQuery: { kind: 'organization', tenantId: w.tenant.id, asOf: AS_OF },
      },
    ],
  });

  it('管理单元范围：审批可见 ∩ 人事分析范围，发起人本人也只看到范围内员工的流程', async () => {
    const yOnly = scoped(management([f.org.y, f.org.y2]));
    await yOnly.expectComponent('durationByCategory', { all: instances('d', 'e') }, TRANSFER);
    await yOnly.expectComponent('inFlightCount', { all: instances('d', 'e'), hits: [] }, TRANSFER);
    await yOnly.expectComponent('transferApprovalRate', {
      all: [f.flows.d.business, f.flows.e.business, f.direct],
      hits: [f.flows.d.business, f.flows.e.business],
    });
  });

  it('范围为空（默认）：全部组件为 0，hasDataPermission = false，不退回“全部”', async () => {
    const nobody = scoped({ ...EMPTY_SCOPE });
    const overview = await nobody.overview();
    expect(overview.hasDataPermission).toBe(false);
    expect(overview.components.map((c) => c.total)).toEqual(overview.components.map(() => 0));
    expect(await nobody.detail('inFlightList')).toEqual([]);
  });

  it('不是参与人、也没有审批管理员按钮：看不到别人发起的流程（不扩大审批可见面）', async () => {
    const stranger = await w.member('旁人');
    const denyAdmin: Authorizer = (request) =>
      !(request.action === 'object.button' && /#admin(Transfer|Intervene)@/.test(String(request.resource)));
    const other = processClient(
      w.db,
      { tenant: w.tenant.id, user: stranger },
      {
        now: () => new Date(at(AS_OF)),
        authorize: denyAdmin,
      },
    );
    await other.expectComponent('inFlightCount', { all: [], hits: [] });
    // 同一授权器下的发起人 HR 仍看到自己发起的
    const initiator = processClient(
      w.db,
      { tenant: w.tenant.id, user: w.hr.id },
      {
        now: () => new Date(at(AS_OF)),
        authorize: denyAdmin,
      },
    );
    await initiator.expectComponent(
      'inFlightCount',
      {
        all: instances('a', 'b', 'c', 'd', 'e', 'f', 'g', 'l', 'w'),
        hits: instances('f', 'g', 'l'),
      },
      TRANSFER,
    );
    // Offer 由申请人发起，HR 不是参与人：管理员按钮被拒后看不到
    expect((await initiator.detail('inFlightCount')).map((i) => i.id)).not.toContain(f.offers.o1Instance);
  });

  it('403 / 400 / 404', async () => {
    const denied: Authorizer = (request) => !(request.action === 'object.view' && request.resource === OBJECT);
    const blocked = processClient(
      w.db,
      { tenant: w.tenant.id, user: w.hr.id },
      {
        now: () => new Date(at(AS_OF)),
        authorize: denied,
      },
    );
    expect((await blocked.get(PROCESS_BASE)).status).toBe(403);
    expect((await blocked.get(`${PROCESS_BASE}/components/inFlightList`)).status).toBe(403);
    for (const query of ['asOf=2026-02-30', 'category=nope', 'from=2026-10-10&to=2026-10-01', 'departmentId=x'])
      expect((await board.get(`${PROCESS_BASE}?${query}`)).status, query).toBe(400);
    expect((await board.get(`${PROCESS_BASE}/components/inFlightList?hit=maybe`)).status).toBe(400);
    expect((await board.get(`${PROCESS_BASE}/components/nope`)).status).toBe(404);
  });

  it('授权项“人事分析 - 人事流程看板 查看”默认给人事模块预置管理员（DEC-415）', () => {
    const profile = (code: string) => STANDARD_PROFILES.find((item) => item.code === code)!;
    for (const code of ['standard_org_system_admin', 'standard_hr_admin'])
      expect(profile(code).objects.map((object) => object.objectCode)).toContain(OBJECT);
    const seeAll = (code: string) => presetSeeAllTargets(profile(code)).map((target) => target.targetCode);
    expect(seeAll('standard_org_system_admin')).toContain(OBJECT);
    expect(seeAll('standard_hr_admin')).toContain(OBJECT);
    expect(seeAll('standard_hr_specialist')).not.toContain(OBJECT);
  });
});

/** 编译期核对：用到的组件编码都在目录里。 */
export const USED_CODES: readonly HrProcessComponentCode[] = ['inFlightCount', 'contractApprovalRate'];
