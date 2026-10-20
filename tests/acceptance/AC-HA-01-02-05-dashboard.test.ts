/**
 * BE-12b / AC-HA-01、AC-HA-02、AC-HA-05：人事看板 23 项指标（规格 35 §2.1，DEC-625 拆分后的 BE-12b）。
 * 固定夹具（租户今天 = 2026-10-06）：每个指标写手工期望的 ID 集合，至少一条正例 + 一条边界反例；
 * 每个指标都断言“数字 = 明细总数 = 明细条数 = 期望集合”（同一谓词，单一入口）。
 * 重点边界：未来 30 天含两端（第 30 天计入、第 31 天不计）、已撤销 / 草稿 / 驳回的离职与退休不计入“离职中”、
 * 本年入职 / 本年离职无论后来是否离职、已发起转正但未生效的仍计入“未来 30 天试用到期”。
 * 合同与 Offer 另见 AC-HA-BE12b-contract.test.ts、AC-HA-BE12b-offer.test.ts。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { presetSeeAllTargets, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { addPending, entryAction } from './AC-EN-BE2a-support.js';
import { dayAt } from './AC-EXIT-activation-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { draftRegularization, hire, regularizeAt, transition, type PbWorld } from './AC-PB-support.js';
import { retireBody, retirementWorld } from './AC-RT-support.js';
import { pinExitGate, tenantApi } from './support/tenant-api.js';
import { dashboardClient, INDICATORS, type DashboardClient } from './AC-HA-BE12b-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const OBJECT = 'TenantBase.HrDashboard';

type Kind = 'internal' | 'intern' | 'external';
interface Person {
  id: string;
  date: string;
  kind: Kind;
  dept: string;
  inService: boolean;
  manager: boolean;
  workDate: boolean;
}

async function buildWorld() {
  const db = database().db;
  const x = await retirementWorld(db, 'ha-12b', TODAY);
  const tenant = x.session.tenant.id;
  const user = x.session.user.id;
  const old = await x.session.org('早期部门', { establishedOn: '2020-01-01' });
  const pb = { db, session: x.session, org: x.from } as unknown as PbWorld;
  const entry = { db, session: x.session, org: x.from } as never;
  const roster: Person[] = [
    {
      id: x.employee.id,
      date: '2026-09-01',
      kind: 'internal',
      dept: x.from.id,
      inService: true,
      manager: false,
      workDate: false,
    },
  ];
  const person = (id: string) => roster.find((p) => p.id === id)!;

  /** 经路由直接入职；记入花名册（期望集合据此手工推导，不读实现）。 */
  async function join(name: string, o: { date?: string; kind?: Kind; dept?: { id: string }; manager?: string } = {}) {
    const employee = await x.session.employee(name);
    const dept = o.dept ?? (o.date && o.date < '2026-01-01' ? old : x.from);
    await x.session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: o.date ?? '2026-09-01',
        fields: {
          departmentId: dept.id,
          employType: o.kind ?? 'internal',
          ...(o.manager ? { directManagerId: o.manager } : {}),
        },
      },
      employee.revision,
    );
    roster.push({
      id: employee.id,
      date: o.date ?? '2026-09-01',
      kind: o.kind ?? 'internal',
      dept: dept.id,
      inService: true,
      manager: !!o.manager,
      workDate: false,
    });
    return employee;
  }
  /** 探针员工：probation 入职，同样记入花名册。 */
  async function probation(name: string, endDate: string) {
    const { employee } = await hire(pb, { date: '2026-09-01', months: 1, endDate, name });
    roster.push({
      id: employee.id,
      date: '2026-09-01',
      kind: 'internal',
      dept: x.from.id,
      inService: true,
      manager: false,
      workDate: false,
    });
    return employee;
  }
  const leftService = (id: string) => {
    person(id).inService = false;
  };

  /** 已生效的退休（seed 端口落地后补扩展行，同 gateWorld.effectiveExit）。 */
  async function effectiveRetirement(employeeId: string, lastWorkDate: string) {
    const previous = pinExitGate('seed');
    let created: { id: string; status: string };
    try {
      created = await x.createdLeave(employeeId, retireBody(lastWorkDate, 'direct'));
    } finally {
      pinExitGate(previous);
    }
    expect(created.status).toBe('effective');
    await x.sqlRows(sql`INSERT INTO exit_requests(tenant_id,business_id,employee_id,staff_id,initiator_user_id,mode,
        initiator,duty_transfer_timing)
      SELECT ${tenant},${created.id}::uuid,${employeeId}::uuid,c.id,${user}::uuid,'direct','hr','business_effective'
      FROM employment_cycles c WHERE c.tenant_id=${tenant} AND c.employee_id=${employeeId}::uuid
      ORDER BY c.entry_date DESC LIMIT 1`);
    return created;
  }
  const cancelExit = async (path: 'exits' | 'retirements', id: string) => {
    const response = await x.session.request('POST', `/${path}/${id}/cancel`, {
      ifMatch: (await x.business(id)).revision,
      body: { reason: '录入有误' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };

  // ---- 入职 / 离职（AC-HA-01 与指标 1–4、11、14）----
  const f = {
    mar: await join('三月入职六月离职', { date: '2026-03-10' }),
    dec: await join('去年底入职', { date: '2025-12-31' }),
    intern: await join('实习生', { date: '2026-05-01', kind: 'intern' }),
    external: await join('外部人员', { date: '2026-05-02', kind: 'external' }),
    oct1: await join('十月一日入职', { date: '2026-10-01' }),
    sep30: await join('九月三十日入职', { date: '2026-09-30' }),
    leaveSep: await join('九月底离职', { date: '2026-01-05' }),
    leaveOct: await join('十月离职', { date: '2026-01-06' }),
    leavePrev: await join('去年离职', { date: '2024-05-01' }),
    leaveIntern: await join('实习生离职', { date: '2026-02-01', kind: 'intern' }),
    leaveExternal: await join('外部人员离职', { date: '2026-02-02', kind: 'external' }),
    retired: await join('十月退休', { date: '2026-01-08' }),
  };
  for (const [employee, lastWorkDate] of [
    [f.mar, '2026-06-20'],
    [f.leaveSep, '2026-09-30'],
    [f.leaveOct, '2026-10-02'],
    [f.leavePrev, '2025-12-31'],
    [f.leaveIntern, '2026-08-15'],
    [f.leaveExternal, '2026-08-16'],
  ] as const) {
    await x.effectiveExit(employee.id, lastWorkDate);
    leftService(employee.id);
  }
  await effectiveRetirement(f.retired.id, '2026-10-04');
  leftService(f.retired.id);

  // ---- 待入职（指标 12）----
  const pendingA = await addPending(entry, '2026-10-20', '待入职甲');
  const pendingCancelled = await addPending(entry, '2026-10-22', '待入职已取消');
  const pendingPostponed = await addPending(entry, '2026-10-24', '待入职已延期');
  expect((await entryAction(entry, pendingCancelled.recordId, 'cancel', {})).status).toBe(200);
  expect(
    (await entryAction(entry, pendingPostponed.recordId, 'postpone', { effectiveDate: '2026-10-30' })).status,
  ).toBe(200);

  // ---- 离职中 / 退休中（指标 18）----
  const e = {
    lvReview: await join('离职审批中'),
    lvApproved: await join('离职通过未生效'),
    lvDraft: await join('离职草稿'),
    lvRejected: await join('离职驳回'),
    lvCancelled: await join('离职已撤销'),
    rtReview: await join('退休审批中'),
    rtApproved: await join('退休通过未生效'),
    rtDraft: await join('退休草稿'),
    rtCancelled: await join('退休已撤销'),
  };
  const exits = {
    lvReview: await x.submittedLeave('2026-10-20', e.lvReview.id),
    lvApproved: await x.directLeave('2026-10-25', undefined, e.lvApproved.id),
    lvDraft: await x.createdLeave(e.lvDraft.id, leaveBody('2026-10-25', 'application')),
    lvRejected: await x.submittedLeave('2026-10-21', e.lvRejected.id),
    lvCancelled: await x.submittedLeave('2026-10-22', e.lvCancelled.id),
    rtReview: await x.submittedRetire('2026-10-20', e.rtReview.id),
    rtApproved: await x.directRetire('2026-10-25', undefined, e.rtApproved.id),
    rtDraft: await x.createdRetire(e.rtDraft.id, retireBody('2026-10-25')),
    rtCancelled: await x.submittedRetire('2026-10-22', e.rtCancelled.id),
  };
  await x.sqlRows(sql`INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,state,
      event_no,command_id)
    SELECT p.tenant_id,p.employee_id,p.business_id,p.id,'rejected',
      (SELECT coalesce(max(s.event_no),0)+1 FROM employment_state_events s
        WHERE s.tenant_id=p.tenant_id AND s.business_id=p.business_id),${`force-${randomUUID()}`}
    FROM employment_payload_versions p WHERE p.tenant_id=${tenant} AND p.business_id=${exits.lvRejected.id}::uuid
    ORDER BY p.version_no DESC LIMIT 1`);
  await cancelExit('exits', exits.lvCancelled.id);
  await cancelExit('retirements', exits.rtCancelled.id);

  // ---- 调动中（指标 17）----
  const t = {
    review: await join('调动审批中'),
    approved: await join('调动通过未生效'),
    draft: await join('调动草稿'),
    rejected: await join('调动驳回'),
    done: await join('调动已生效'),
  };
  const transfers = {
    review: await x.transferIn('in_review', '2026-10-20', t.review.id),
    approved: await x.transferIn('approved', '2026-10-25', t.approved.id),
    draft: await x.transferIn('draft', '2026-10-25', t.draft.id),
    rejected: await x.transferIn('rejected', '2026-10-25', t.rejected.id),
  };
  const doneRevision = (await x.session.getEmployee(t.done.id)).revision;
  await x.session.business(
    t.done.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: x.to.id } },
    doneRevision,
  );
  person(t.done.id).dept = x.to.id;

  // ---- 试用到期 / 转正（指标 5、7、13、16；AC-HA-02）----
  const p = {
    ac02: await probation('AC-HA-02 已发起转正', '2026-10-26'),
    edgeIn: await probation('第30天到期', '2026-11-05'),
    edgeOut: await probation('第31天到期', '2026-11-06'),
    today: await probation('今天到期', '2026-10-06'),
    over: await probation('昨天已过期', '2026-10-05'),
    overOld: await probation('上月已过期', '2026-09-15'),
    regNow: await probation('本月已转正', '2026-10-31'),
    regPrev: await probation('上月已转正', '2026-10-31'),
    regFuture: await probation('转正通过未生效', '2026-10-15'),
    draft: await probation('转正草稿', '2026-10-10'),
    rejected: await probation('转正驳回', '2026-10-12'),
  };
  const submit = async (employeeId: string, effectiveDate: string) => {
    const draft = await draftRegularization(pb, employeeId, effectiveDate);
    expect((await transition(pb, draft, 'submit')).status).toBe(200);
    return draft;
  };
  const reg = {
    ac02: await submit(p.ac02.id, '2026-10-27'),
    now: await regularizeAt(pb, p.regNow.id, '2026-10-02'),
    prev: await regularizeAt(pb, p.regPrev.id, '2026-09-30'),
    future: await regularizeAt(pb, p.regFuture.id, '2026-10-20'),
    draft: await draftRegularization(pb, p.draft.id, '2026-10-12'),
    rejected: await submit(p.rejected.id, '2026-10-14'),
  };
  expect((await transition(pb, reg.rejected, 'reject')).status).toBe(200);

  // ---- 直线上级 / 参加工作日期（指标 20、21）----
  const manager = await join('直线上级本人');
  const subordinate = await join('有直线上级', { manager: manager.id });
  for (const employee of [manager, subordinate]) {
    await withTenant(db, tenant, (tx) =>
      appendEmployee(
        tx,
        {
          tenantId: tenant,
          userId: user,
          timezone: x.session.tenant.timezone,
          now: dayAt(TODAY),
          commandId: randomUUID(),
          expectedRevision: 0,
        } as never,
        employee.id,
        { workDate: '2015-07-01' },
        false,
      ),
    );
    person(employee.id).workDate = true;
  }

  // ---- 部门负责人 / HRBP（指标 22、23）：负责人须在组织生效日在职，所以这几个部门 2026-09-15 成立 ----
  const founded = { establishedOn: '2026-09-15' };
  const orgHead = await x.session.org('有负责人无HRBP', { ...founded, personInChargeId: manager.id });
  const orgHrbp = await x.session.org('有HRBP无负责人', { ...founded, hrbpId: manager.id });
  const orgBoth = await x.session.org('负责人与HRBP齐全', {
    ...founded,
    personInChargeId: manager.id,
    hrbpId: manager.id,
  });
  const orgNone = await x.session.org('两者皆空', founded);
  const orgDisabled = await x.session.org('已停用部门', founded);
  const disabling = await tenantApi(db, { clock: () => dayAt(TODAY) }).request(
    'PATCH',
    `/api/tenant/org/organizations/${orgDisabled.id}`,
    { tenant, user, ifMatch: orgDisabled.revision, body: { enabled: false, effectiveDate: '2026-10-01' } },
  );
  expect(disabling.status, await disabling.clone().text()).toBe(200);

  // ---- 待入职（分配到另一个部门，范围用例用）----
  const pendingB = await addPending({ db, session: x.session, org: x.to } as never, '2026-10-21', '待入职乙部门');

  return {
    x,
    db,
    tenant,
    user,
    roster,
    old,
    f,
    pending: { a: pendingA, cancelled: pendingCancelled, postponed: pendingPostponed, b: pendingB },
    exits,
    transfers,
    p,
    reg,
    manager,
    subordinate,
    t,
    orgs: { head: orgHead, hrbp: orgHrbp, both: orgBoth, none: orgNone, disabled: orgDisabled, old },
  };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

describe('BE-12b 人事看板 23 项指标', () => {
  let w: World;
  let board: DashboardClient;
  beforeAll(async () => {
    w = await buildWorld();
    board = dashboardClient(w.db, { tenant: w.tenant, user: w.user }, { now: () => dayAt(TODAY) });
  }, 600_000);

  /** 花名册推导：asOf 时在职（本夹具里的离职都是 TODAY 之前落地的，asOf = TODAY）。 */
  const inService = (kinds: readonly Kind[], dept?: string) =>
    ids(w.roster.filter((p) => p.inService && kinds.includes(p.kind) && (!dept || p.dept === dept)));
  const entered = (from: string, to: string) =>
    ids(w.roster.filter((p) => p.kind !== 'external' && p.date >= from && p.date <= to));

  it('接口返回 23 项指标，编码与序号固定；asOf 缺省取租户当地今天', async () => {
    const overview = await board.overview();
    expect(overview.asOf).toBe(TODAY);
    expect(overview.hasDataPermission).toBe(true);
    expect(overview.indicators.map((i) => [i.no, i.code, i.subject])).toEqual(INDICATORS.map((i) => [...i]));
    for (const indicator of overview.indicators) {
      expect(indicator.name).toBeTruthy();
      expect(typeof indicator.value).toBe('number');
    }
  });

  it('指标 1–2：截至 asOf 在职，按雇佣关系分正式 / 实习生；待入职、已离职、外部人员都不计', async () => {
    await board.expectIndicator('regularEmployees', inService(['internal']));
    await board.expectIndicator('interns', [w.f.intern.id]);
    const regular = (await board.detail('regularEmployees')).ids;
    for (const out of [w.f.mar, w.f.external, w.pending.a.employee, w.f.retired, w.f.leaveIntern])
      expect(regular).not.toContain(out.id);
  });

  it('指标 1 的 asOf 是时点：三月入职、六月离职的员工，3 月底和 7 月初分别在 / 不在在职名单里', async () => {
    expect((await board.detail('regularEmployees', '2026-03-31')).ids).toContain(w.f.mar.id);
    expect((await board.detail('regularEmployees', '2026-06-20')).ids).toContain(w.f.mar.id);
    expect((await board.detail('regularEmployees', '2026-06-21')).ids).not.toContain(w.f.mar.id);
    expect((await board.detail('regularEmployees', '2026-02-28')).ids).not.toContain(w.f.mar.id);
  });

  it('AC-HA-01：3 月入职、6 月离职的员工计入本年入职、本年离职；本月已入职只在 3 月计入', async () => {
    const mar = w.f.mar.id;
    expect((await board.detail('entriesThisYear')).ids).toContain(mar);
    expect((await board.detail('leavesThisYear')).ids).toContain(mar);
    expect((await board.detail('entriesThisMonth')).ids).not.toContain(mar);
    expect((await board.detail('leavesThisMonth')).ids).not.toContain(mar);
    // 3 月底：本月已入职有他；此时还没离职
    expect((await board.detail('entriesThisMonth', '2026-03-31')).ids).toContain(mar);
    expect((await board.detail('leavesThisYear', '2026-03-31')).ids).not.toContain(mar);
    // 6 月底：本月已离职有他；本月已入职没有
    expect((await board.detail('leavesThisMonth', '2026-06-30')).ids).toEqual([mar]);
    expect((await board.detail('entriesThisMonth', '2026-06-30')).ids).not.toContain(mar);
    expect((await board.detail('entriesThisMonth', '2026-04-01')).ids).not.toContain(mar);
  });

  it('指标 3 / 11：入职（内部 + 实习）无论后来是否离职；去年底、外部人员、待入职不计；本月只算 10 月', async () => {
    await board.expectIndicator('entriesThisYear', entered('2026-01-01', TODAY));
    await board.expectIndicator('entriesThisMonth', entered('2026-10-01', TODAY));
    expect(entered('2026-10-01', TODAY)).toEqual([w.f.oct1.id]);
    const year = (await board.detail('entriesThisYear')).ids;
    for (const out of [w.f.dec, w.f.external, w.pending.a.employee, w.f.leaveExternal])
      expect(year).not.toContain(out.id);
    expect(year).toContain(w.f.leaveSep.id);
    // 边界：9 月 30 日入职计本年、不计本月；asOf 之后才入职的不计
    expect(year).toContain(w.f.sep30.id);
    expect((await board.detail('entriesThisMonth')).ids).not.toContain(w.f.sep30.id);
    await board.expectIndicator('entriesThisMonth', entered('2026-09-01', '2026-09-30'), '2026-09-30');
    expect(entered('2026-09-01', '2026-09-30')).toContain(w.f.sep30.id);
    expect((await board.detail('entriesThisYear', '2026-09-29')).ids).not.toContain(w.f.sep30.id);
  });

  it('指标 4 / 14：本年（本月）离职按最后工作日，含离职与退休、内部 + 实习；去年底、外部人员不计', async () => {
    const { mar, leaveSep, leaveOct, leaveIntern, retired } = w.f;
    await board.expectIndicator(
      'leavesThisYear',
      [mar, leaveSep, leaveOct, leaveIntern, retired].map((p) => p.id),
    );
    await board.expectIndicator(
      'leavesThisMonth',
      [leaveOct, retired].map((p) => p.id),
    );
    const year = (await board.detail('leavesThisYear')).ids;
    expect(year).not.toContain(w.f.leavePrev.id);
    expect(year).not.toContain(w.f.leaveExternal.id);
    // 时点：asOf 之后才到的最后工作日不计
    await board.expectIndicator('leavesThisYear', [mar.id], '2026-06-30');
    await board.expectIndicator('leavesThisMonth', [mar.id], '2026-06-30');
    await board.expectIndicator('leavesThisMonth', [], '2026-07-31');
  });

  it('指标 12：待入职 = 当前待入职人数；已取消的不计，已延期的仍计', async () => {
    const { a, postponed, b } = w.pending;
    await board.expectIndicator(
      'pendingEntries',
      [a, postponed, b].map((p) => p.employee.id),
    );
    expect((await board.detail('pendingEntries')).ids).not.toContain(w.pending.cancelled.employee.id);
  });

  it('指标 18：离职中（含退休）= 流程中或审批通过未生效；草稿、驳回、已撤销的离职 / 退休单都不计', async () => {
    const { lvReview, lvApproved, rtReview, rtApproved } = w.exits;
    await board.expectIndicator('exitInProgress', ids([lvReview, lvApproved, rtReview, rtApproved]));
    const counted = (await board.detail('exitInProgress')).ids;
    for (const out of [w.exits.lvDraft, w.exits.lvRejected, w.exits.lvCancelled, w.exits.rtDraft, w.exits.rtCancelled])
      expect(counted).not.toContain(out.id);
    // 时点：提交发生在 asOf 之后的单据，asOf 当日不算在途
    await board.expectIndicator('exitInProgress', [], '2026-10-05');
  });

  it('指标 17：调动中 = 审批中或审批通过未生效；草稿、驳回、已生效的调动不计', async () => {
    const { review, approved } = w.transfers;
    await board.expectIndicator('transferInProgress', ids([review, approved]));
  });

  it('指标 5 / 7：试用到期按 [asOf, asOf+30] 含两端，已过期单独计；已转正的两边都不计', async () => {
    const { ac02, edgeIn, today, regFuture, draft, rejected, edgeOut, over, overOld } = w.p;
    await board.expectIndicator('probationExpiring30', ids([ac02, edgeIn, today, regFuture, draft, rejected]));
    await board.expectIndicator('probationOverdue', ids([over, overOld]));
    const soon = (await board.detail('probationExpiring30')).ids;
    // 第 30 天（11-05）计入、第 31 天（11-06）不计；到期日当天计入“未来 30 天”、不计“已过期”
    expect(soon).toContain(edgeIn.id);
    expect(soon).not.toContain(edgeOut.id);
    expect((await board.detail('probationOverdue')).ids).not.toContain(today.id);
    expect(soon).not.toContain(over.id);
    for (const regular of [w.p.regNow, w.p.regPrev]) {
      expect(soon).not.toContain(regular.id);
    }
  });

  it('AC-HA-02：已发起转正审批但未生效、试用期 20 天后到期，计入“未来 30 天试用到期”，也计入“转正中”', async () => {
    expect((await board.detail('probationExpiring30')).ids).toContain(w.p.ac02.id);
    expect((await board.detail('regularizationInProgress')).ids).toContain(w.reg.ac02.id);
    // 转正生效之后（status = 正式）就不再计入
    expect((await board.detail('probationExpiring30', '2026-10-06')).ids).toContain(w.p.ac02.id);
  });

  it('指标 13 / 16：本月已转正 = 本月转正生效；转正中 = 审批中或通过未生效，草稿、驳回不计', async () => {
    await board.expectIndicator('regularizedThisMonth', [w.p.regNow.id]);
    await board.expectIndicator('regularizationInProgress', [w.reg.ac02.id, w.reg.future]);
    // 上月 30 日生效的转正只在 9 月底计入
    await board.expectIndicator('regularizedThisMonth', [w.p.regPrev.id], '2026-09-30');
  });

  it('指标 20 / 21：在职人员（内部 + 实习）主职直线上级为空 / 参加工作日期为空', async () => {
    const staff = w.roster.filter((p) => p.inService && p.kind !== 'external');
    await board.expectIndicator('noDirectManager', ids(staff.filter((p) => !p.manager)));
    await board.expectIndicator('noWorkStartDate', ids(staff.filter((p) => !p.workDate)));
    expect((await board.detail('noDirectManager')).ids).not.toContain(w.subordinate.id);
    expect((await board.detail('noWorkStartDate')).ids).not.toContain(w.manager.id);
    expect((await board.detail('noWorkStartDate')).ids).not.toContain(w.f.mar.id);
  });

  it('指标 22 / 23：启用部门的负责人 / HRBP 为空；不含租户根组织，已停用的不计，时点生效', async () => {
    const { head, hrbp, none } = w.orgs;
    const base = [w.x.from, w.x.to, w.old];
    await board.expectIndicator('departmentNoHead', ids([...base, hrbp, none]));
    await board.expectIndicator('departmentNoHrbp', ids([...base, head, none]));
    expect((await board.detail('departmentNoHead')).ids).not.toContain(w.tenant);
    // 停用日（10-01）之前仍是启用部门；成立日（09-15）之前还不存在
    await board.expectIndicator('departmentNoHead', ids([...base, hrbp, none, w.orgs.disabled]), '2026-09-30');
    await board.expectIndicator('departmentNoHead', ids(base), '2026-09-14');
  });

  it('明细分页：pageSize 切片后互不重复、都属于全集，总数不随页变', async () => {
    const all = (await board.detail('entriesThisYear')).ids;
    const first = await board.page('entriesThisYear', undefined, '&page=1&pageSize=3');
    const second = await board.page('entriesThisYear', undefined, '&page=2&pageSize=3');
    expect([first.total, second.total]).toEqual([all.length, all.length]);
    const slice = [...first.items, ...second.items].map((item) => item.id);
    expect(slice).toHaveLength(6);
    expect(new Set(slice).size).toBe(6);
    for (const id of slice) expect(all).toContain(id);
  });

  it('参数与权限：asOf 非法 400、指标编码未知 404、没有“人事看板 查看”授权项 403', async () => {
    expect((await board.get('/api/tenant/analytics/hr-dashboard?asOf=2026-13-01')).status).toBe(400);
    expect((await board.get('/api/tenant/analytics/hr-dashboard/indicators/nope')).status).toBe(404);
    const denied: Authorizer = (request) => !(request.action === 'object.view' && request.resource === OBJECT);
    const blocked = dashboardClient(
      w.db,
      { tenant: w.tenant, user: w.user },
      { now: () => dayAt(TODAY), authorize: denied },
    );
    expect((await blocked.get('/api/tenant/analytics/hr-dashboard')).status).toBe(403);
    expect((await blocked.get('/api/tenant/analytics/hr-dashboard/indicators/interns')).status).toBe(403);
  });

  describe('AC-HA-05 数据范围', () => {
    const scoped = (scope: ModuleScope) => {
      const authorize: Authorizer = () => true;
      registerScopeProvider(authorize, {
        scope: async () => scope,
        authorize: async (request) => authorize(request),
        fields: async () => new Set(),
      });
      return dashboardClient(w.db, { tenant: w.tenant, user: w.user }, { now: () => dayAt(TODAY), authorize });
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
          personQuery: { kind: 'organization', tenantId: w.tenant, asOf: TODAY },
        },
      ],
    });

    it('HRBP 只能看管理单元内人员：人员类指标只统计范围内人员，组织类只统计范围内组织，数字 = 明细', async () => {
      const hrbp = scoped(management([w.x.from.id]));
      const regular = inService(['internal'], w.x.from.id);
      await hrbp.expectIndicator('regularEmployees', regular);
      // 范围外：早期部门的员工、已调去另一部门的员工
      const seen = (await hrbp.detail('regularEmployees')).ids;
      expect(seen).not.toContain(w.f.dec.id);
      expect(seen).not.toContain(w.t.done.id);
      expect(seen).toContain(w.x.employee.id);
      // 待入职按记录所在部门：另一部门的待入职看不到
      await hrbp.expectIndicator(
        'pendingEntries',
        [w.pending.a, w.pending.postponed].map((p) => p.employee.id),
      );
      await hrbp.expectIndicator('departmentNoHead', [w.x.from.id]);
      await hrbp.expectIndicator('departmentNoHrbp', [w.x.from.id]);
      // 范围外的单据不进“离职中 / 调动中 / 转正中”：这些单据的员工都在范围内部门，所以与全集一致，另一部门员工的不计
      await hrbp.expectIndicator(
        'exitInProgress',
        ids([w.exits.lvReview, w.exits.lvApproved, w.exits.rtReview, w.exits.rtApproved]),
      );
      const overview = await hrbp.overview();
      expect(overview.hasDataPermission).toBe(true);
      expect(overview.indicators.find((i) => i.code === 'regularEmployees')!.value).toBe(regular.length);
      // 同一批数据，全范围（管理员）看到的更多
      expect((await board.detail('regularEmployees')).ids.length).toBeGreaterThan(regular.length);
    });

    it('范围为空（默认）：所有指标都是 0，hasDataPermission = false，不会退回“全部”', async () => {
      const nobody = scoped({ ...EMPTY_SCOPE });
      const overview = await nobody.overview();
      expect(overview.hasDataPermission).toBe(false);
      expect(overview.indicators.map((i) => i.value)).toEqual(INDICATORS.map(() => 0));
      expect((await nobody.detail('regularEmployees')).ids).toEqual([]);
    });

    it('“使用用户”范围按创建人：只统计该用户创建的员工，换一个用户则全为 0', async () => {
      const own: ModuleScope = {
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: w.user }],
      };
      await scoped(own).expectIndicator('regularEmployees', inService(['internal']));
      const stranger: ModuleScope = { ...own, terms: [{ ...own.terms![0]!, creatorId: randomUUID() }] };
      await scoped(stranger).expectIndicator('regularEmployees', []);
    });
  });

  it('授权项：“人事分析 - 人事看板 查看”默认给人事模块预置管理员（DEC-415），人事专员只有对象查看权', () => {
    const profile = (code: string) => STANDARD_PROFILES.find((item) => item.code === code)!;
    for (const code of ['standard_org_system_admin', 'standard_hr_admin', 'standard_hr_specialist'])
      expect(profile(code).objects.map((object) => object.objectCode)).toContain(OBJECT);
    const seeAll = (code: string) => presetSeeAllTargets(profile(code)).map((target) => target.targetCode);
    expect(seeAll('standard_org_system_admin')).toContain(OBJECT);
    expect(seeAll('standard_hr_admin')).toContain(OBJECT);
    expect(seeAll('standard_hr_specialist')).not.toContain(OBJECT);
  });
});
