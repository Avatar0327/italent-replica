/**
 * R2-T04 BE-5d1 / AC-RT-18：退休五视图口径（设计 §10.1 asOf 语义、§10.2 谓词）。
 * 固定夹具：每个边界写死期望视图与行（P = asOf、P = asOf + N、P = asOf − 1、P < 周期入职日、撤销前后的历史查询、
 * 返聘后再次临近退休、草稿 / 驳回只在“全部”）；随机夹具：SQL ≡ 纯函数 classifyRetirement（独立按夹具元数据建事实）。
 * 只断言两套实现相等不算覆盖（设计 §10.2 测试要求），所以固定夹具的期望值是手写的 ID 列表。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { addDays, classifyRetirement, RETIREMENT_VIEWS, type RetirementBillFacts } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/employment/read-model.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import { retirementWorld } from './AC-RT-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const ASOF = '2026-10-15';
const HIRE = '2026-09-01';

interface ViewItem {
  id?: string;
  employeeId: string;
  [key: string]: unknown;
}
interface ViewPage {
  items: ViewItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 夹具元数据：每个员工在各时点的在职区间与退休单（供随机对照独立建事实，不读库）。 */
interface Scenario {
  employeeId: string;
  /** 在职区间 [from, to)，to 缺省 = 至今；staff 为周期标签。 */
  spans: { from: string; to?: string; staff: 1 | 2; entry: string }[];
  bills: {
    id: string;
    staff: 1 | 2;
    state: string;
    createdOn: string;
    submittedOn: string | null;
    effective: string;
  }[];
  expected: string | null;
}

const ids = (page: ViewPage) => page.items.map((item) => item.id ?? item.employeeId);

const world = async () => {
  const x = await retirementWorld(database().db, 'rt18-views', TODAY);
  const names = new Map<string, Scenario>();

  async function person(name: string, expected: string | null) {
    const { employee } = await x.hired(name);
    if (expected) await x.setExpectedRetirement(expected, employee.id);
    const scenario: Scenario = {
      employeeId: employee.id,
      spans: [{ from: HIRE, staff: 1, entry: HIRE }],
      bills: [],
      expected,
    };
    names.set(name, scenario);
    return scenario;
  }
  /** 草稿 / 审批中 / 已批准未生效：创建日 = 今天。 */
  async function retire(s: Scenario, kind: 'draft' | 'review' | 'approved', lastWorkDate: string) {
    const created =
      kind === 'draft'
        ? await x.createdRetire(s.employeeId, { kind: 'retirement', mode: 'application', lastWorkDate, fields: {} })
        : kind === 'review'
          ? await x.submittedRetire(lastWorkDate, s.employeeId)
          : await x.directRetire(lastWorkDate, undefined, s.employeeId);
    s.bills.push({
      id: created.id,
      staff: 1,
      state: kind === 'draft' ? 'draft' : kind === 'review' ? 'in_review' : 'approved',
      createdOn: TODAY,
      submittedOn: kind === 'draft' ? null : TODAY,
      effective: addDays(lastWorkDate, 1),
    });
    return created;
  }
  /** 审批通过并生效：E′ = 审批日（L = E′ − 1）。 */
  async function retired(s: Scenario, effectiveDate: string, staff: 1 | 2 = 1) {
    const draft = await x.submittedRetire(addDays(effectiveDate, -1), s.employeeId);
    const done = await x.approve(draft, `${effectiveDate}T02:00:00Z`);
    expect(done.status).toBe('effective');
    s.bills.push({
      id: draft.id,
      staff,
      state: 'effective',
      createdOn: TODAY,
      submittedOn: TODAY,
      effective: effectiveDate,
    });
    s.spans[s.spans.length - 1]!.to = effectiveDate;
    return draft;
  }
  const force = (businessId: string, state: string) =>
    x.sqlRows(sql`INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,state,
        event_no,command_id)
      SELECT p.tenant_id,p.employee_id,p.business_id,p.id,${state},
        (SELECT coalesce(max(e.event_no),0)+1 FROM employment_state_events e
          WHERE e.tenant_id=p.tenant_id AND e.business_id=p.business_id),${`force-${randomUUID()}`}
      FROM employment_payload_versions p WHERE p.tenant_id=${x.session.tenant.id} AND p.business_id=${businessId}::uuid
      ORDER BY p.version_no DESC LIMIT 1`);

  const get = async (path: string) => x.session.request('GET', path);
  async function view(name: string, query = '', asOf = ASOF) {
    const response = await get(`/retirements?view=${name}&asOf=${asOf}${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as ViewPage;
  }
  const ids = (page: ViewPage) => page.items.map((item) => item.id ?? item.employeeId);

  return { x, names, person, retire, retired, force, get, view, ids };
};
type World = Awaited<ReturnType<typeof world>>;

/** 固定夹具（asOf = 2026-10-15，N = 30 → 即将窗口 [10-15, 11-14]）。 */
async function fixture(w: World) {
  const { x } = w;
  const s = {
    upLow: await w.person('P等于asOf', '2026-10-15'),
    upHigh: await w.person('P等于asOf加N', '2026-11-14'),
    beyond: await w.person('P超出一天', '2026-11-15'),
    over: await w.person('P早于asOf一天', '2026-10-14'),
    atEntry: await w.person('P等于入职日', HIRE),
    beforeEntry: await w.person('P早于入职日', '2026-08-31'),
    noP: await w.person('P为空', null),
    review: await w.person('审批中', '2026-10-20'),
    approved: await w.person('已批准未生效', '2026-10-10'),
    draft: await w.person('草稿', '2026-10-10'),
    rejected: await w.person('已驳回', '2026-10-12'),
    done: await w.person('已完成', '2026-10-05'),
    cancel: await w.person('将被撤销', '2026-10-13'),
    rehire: await w.person('返聘', '2026-09-19'),
    late: await w.person('晚提交', '2026-10-20'),
  };
  const bill = {
    review: await w.retire(s.review, 'review', '2026-10-20'),
    approved: await w.retire(s.approved, 'approved', '2026-10-25'),
    draft: await w.retire(s.draft, 'draft', '2026-10-25'),
    rejectedDraft: await w.retire(s.rejected, 'review', '2026-10-25'),
    done: await w.retired(s.done, '2026-10-06'),
    cancel: await w.retired(s.cancel, '2026-10-10'),
    old: await w.retired(s.rehire, '2026-09-20'),
    late: await w.retire(s.late, 'draft', '2026-10-30'),
  };
  await w.force(bill.rejectedDraft.id, 'rejected');
  s.rejected.bills[0]!.state = 'rejected';
  // 返聘：旧周期已生效退休，2026-10-01 重新入职（第二个周期），P 改为新周期内的 10-20
  const employee = await x.session.getEmployee(s.rehire.employeeId);
  const rehired = await x.session.request('POST', `/employees/${s.rehire.employeeId}/businesses`, {
    ifMatch: employee.revision,
    body: { kind: 'retire_rehire', mode: 'direct', effectiveDate: '2026-10-01', fields: { departmentId: x.from.id } },
  });
  expect(rehired.status, await rehired.clone().text()).toBe(201);
  s.rehire.spans.push({ from: '2026-10-01', staff: 2, entry: '2026-10-01' });
  await x.setExpectedRetirement('2026-10-20', s.rehire.employeeId);
  s.rehire.expected = '2026-10-20';
  // 晚提交：草稿 10-06 创建，10-08 提交
  const draftLate = bill.late;
  const lateRevision = (await x.business(draftLate.id)).revision;
  await x.atDay('2026-10-08', async () => {
    const response = await x.session.request('POST', `/businesses/${draftLate.id}/submit`, {
      ifMatch: lateRevision,
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });
  s.late.bills[0]!.state = 'in_review';
  s.late.bills[0]!.submittedOn = '2026-10-08';
  return { s, bill };
}

/** 夹具里模拟“撤销已生效退休”（5a′ 合入前的内部端口）：状态 deleted，时间轴恢复在职。 */
async function cancelRetirement(w: World, scenario: Scenario, businessId: string) {
  const { x } = w;
  await withTenant(database().db, x.session.tenant.id, async (tx) => {
    const [head] = rowsOf<{ revision: number }>(
      await tx.execute(sql`SELECT revision FROM employment_business_objects
        WHERE tenant_id=${x.session.tenant.id} AND id=${businessId}::uuid`),
    );
    await transitionEmployment(
      tx,
      {
        tenantId: x.session.tenant.id,
        userId: x.session.user.id,
        timezone: x.session.tenant.timezone,
        now: new Date(`${TODAY}T03:00:00Z`),
        commandId: randomUUID(),
        expectedRevision: Number(head!.revision),
      },
      { id: businessId, action: 'delete', cancelling: true },
    );
  });
  scenario.bills.find((b) => b.id === businessId)!.state = 'deleted';
  scenario.spans[0]!.to = undefined;
}

describe('AC-RT-18 五视图固定夹具（asOf = 10-15，N = 30）', () => {
  let w: World;
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    w = await world();
    f = await fixture(w);
  });

  it('即将退休：含两端 [asOf, asOf + N]，按 P 升序；已有流程中 / 生效退休单的、草稿以外的排除', async () => {
    const page = await w.view('upcoming');
    expect(w.ids(page)).toEqual([
      f.s.upLow.employeeId, // P = asOf
      f.s.rehire.employeeId, // 返聘新周期 P = 10-20（旧周期 effective 不排除）
      f.s.upHigh.employeeId, // P = asOf + N
    ]); // P = 10-20 的“审批中”“晚提交”两人在 asOf 时已有流程中的单，排除
    expect(page.total).toBe(3);
    expect(page.items[0]).toMatchObject({ expectedRetirementDate: '2026-10-15', daysToRetirement: 0 });
    expect(page.items[2]).toMatchObject({ expectedRetirementDate: '2026-11-14', daysToRetirement: 30 });
  });

  it('upcomingDays 改变窗口上端：29 → P = asOf + 30 出局；1 → 只剩 P = asOf', async () => {
    expect(w.ids(await w.view('upcoming', '&upcomingDays=29'))).not.toContain(f.s.upHigh.employeeId);
    expect(w.ids(await w.view('upcoming', '&upcomingDays=1'))).toEqual([f.s.upLow.employeeId]);
  });

  it('过期未退休：P < asOf 且 P ≥ 周期入职日；P = 入职日仍算，P < 入职日排除；P 升序', async () => {
    const page = await w.view('overdue');
    expect(w.ids(page)).toEqual([
      f.s.atEntry.employeeId, // 09-01 = 入职日
      f.s.draft.employeeId, // 10-10 草稿不排除
      f.s.rejected.employeeId, // 10-12 驳回不排除
      f.s.over.employeeId, // 10-14 = asOf − 1
    ]);
    expect(page.items[0]).toMatchObject({ daysToRetirement: -44 });
    expect(w.ids(page)).not.toContain(f.s.beforeEntry.employeeId);
    expect(w.ids(page)).not.toContain(f.s.noP.employeeId);
    expect(w.ids(page)).not.toContain(f.s.approved.employeeId);
    expect(w.ids(page)).not.toContain(f.s.review.employeeId);
  });

  it('退休中：流程中（审批中 / 已批准未生效），按最后工作日升序；草稿、驳回不在', async () => {
    expect(w.ids(await w.view('processing'))).toEqual([f.bill.review.id, f.bill.approved.id, f.bill.late.id]);
  });

  it('已完成：E′ ≤ asOf 的 effective，按最后工作日降序；被撤销的不在（撤销前另测）', async () => {
    expect(w.ids(await w.view('completed'))).toEqual([f.bill.cancel.id, f.bill.done.id, f.bill.old.id]);
  });

  it('全部：创建 ≤ asOf 的全部退休单含草稿 / 驳回', async () => {
    const page = await w.view('all');
    expect([...w.ids(page)].sort()).toEqual(
      Object.values(f.bill)
        .map((b) => b.id)
        .sort(),
    );
    expect(page.total).toBe(Object.keys(f.bill).length);
  });

  it('asOf 早于创建日：单不存在于任何单据视图；晚提交的单在提交前只在“全部”，提交后进“退休中”', async () => {
    for (const name of ['processing', 'all']) expect((await w.view(name, '', '2026-10-05')).items).toEqual([]);
    // 已完成只看 E′ ≤ asOf（夹具里“返聘”的旧单 E′ = 09-20 是倒填的生效日）
    expect(w.ids(await w.view('completed', '', '2026-10-05'))).toEqual([f.bill.old.id]);
    const lateId = f.bill.late.id;
    expect(w.ids(await w.view('processing', '', '2026-10-07'))).not.toContain(lateId);
    expect(w.ids(await w.view('all', '', '2026-10-07'))).toContain(lateId);
    expect(w.ids(await w.view('upcoming', '', '2026-10-07'))).toContain(f.s.late.employeeId);
    expect(w.ids(await w.view('processing', '', '2026-10-09'))).toContain(lateId);
    expect(w.ids(await w.view('upcoming', '', '2026-10-09'))).not.toContain(f.s.late.employeeId);
  });

  it('撤销前后的历史查询（§10.1 反例 1）：撤销前 asOf=15 只在“已完成”；撤销后只在“过期未退休”', async () => {
    const who = f.s.cancel.employeeId;
    const before = await Promise.all(RETIREMENT_VIEWS.map((name) => w.view(name)));
    const inViews = (employeeId: string, billId: string) =>
      RETIREMENT_VIEWS.filter((_, index) => ids(before[index]!).some((id) => id === employeeId || id === billId));
    expect(inViews(who, f.bill.cancel.id)).toEqual(['completed', 'all']);

    await cancelRetirement(w, f.s.cancel, f.bill.cancel.id);

    const after = await Promise.all(RETIREMENT_VIEWS.map((name) => w.view(name)));
    const inViewsAfter = RETIREMENT_VIEWS.filter((_, index) =>
      ids(after[index]!).some((id) => id === who || id === f.bill.cancel.id),
    );
    // 员工按 P = 10-13 < 15 进“过期未退休”；被撤销的单只在“全部”（deleted），不在已完成 / 退休中
    expect(inViewsAfter).toEqual(['overdue', 'all']);
    expect(ids(after[RETIREMENT_VIEWS.indexOf('completed')]!)).not.toContain(f.bill.cancel.id);
    expect(ids(after[RETIREMENT_VIEWS.indexOf('overdue')]!)).toContain(who);
  });

  it('非法参数 400：未知 view / 大小写不符的 Cancelled / asOf 格式 / upcomingDays 越界', async () => {
    for (const query of [
      '?view=bogus',
      '?view=Cancelled',
      '',
      '?view=all&asOf=2026-13-40',
      '?view=all&asOf=20261015',
      '?view=upcoming&upcomingDays=0',
      '?view=upcoming&upcomingDays=366',
      '?view=upcoming&upcomingDays=1.5',
    ])
      expect((await w.get(`/retirements${query}`)).status, query).toBe(400);
  });

  it('upcomingDays 缺省读租户配置 retirement.upcoming_days', async () => {
    const api = tenantApi(database().db);
    const who = { tenant: w.x.session.tenant.id, user: w.x.session.user.id };
    const current = await api.request('GET', '/api/tenant/settings/retirement.upcoming_days', who);
    const { revision } = (await current.json()) as { revision: number };
    const put = await api.request('PUT', '/api/tenant/settings/retirement.upcoming_days', {
      ...who,
      ifMatch: revision,
      body: { value: 1 },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    expect(w.ids(await w.view('upcoming'))).toEqual([f.s.upLow.employeeId]);
    // 请求参数优先于租户配置
    expect(w.ids(await w.view('upcoming', '&upcomingDays=30'))).toContain(f.s.upHigh.employeeId);
  });

  it('详情：退休单返回退休专有列；离职单 / 不存在同一个 404', async () => {
    const response = await w.get(`/retirements/${f.bill.old.id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      id: f.bill.old.id,
      employeeId: f.s.rehire.employeeId,
      status: 'effective',
      reEmployed: false,
    });
    expect((await w.get(`/retirements/${randomUUID()}`)).status).toBe(404);
  });
});

describe('AC-RT-18 随机夹具：SQL ≡ 纯函数 classifyRetirement', () => {
  it('随机 asOf / upcomingDays / P：每个视图的行集合与顺序无关地相等', async () => {
    const w = await world();
    const f = await fixture(w);
    await cancelRetirement(w, f.s.cancel, f.bill.cancel.id);
    const all = [...w.names.values()];
    let seed = 20261015;
    const next = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed % n;
    };
    const dates = (count: number, from: string) => Array.from({ length: count }, (_, i) => addDays(from, i));
    const PROBE = dates(120, '2026-08-25');

    const seen = new Map<string, number>(RETIREMENT_VIEWS.map((name) => [name, 0]));
    for (let round = 0; round < 12; round += 1) {
      for (const s of all.filter(() => next(3) === 0)) {
        s.expected = next(8) === 0 ? null : PROBE[next(PROBE.length)]!;
        await w.x.setExpectedRetirement(s.expected, s.employeeId);
      }
      const asOf = addDays(TODAY, next(80));
      const upcomingDays = 1 + next(120);
      const expected = new Map<string, string[]>(RETIREMENT_VIEWS.map((name) => [name, []]));
      for (const s of all) {
        const span = s.spans.find((p) => p.from <= asOf && (!p.to || asOf < p.to));
        const bills: RetirementBillFacts[] = s.bills.map((b) => ({
          id: b.id,
          staffId: `staff-${b.staff}`,
          state: b.state,
          submitted: b.submittedOn !== null && b.submittedOn <= asOf,
          existed: b.createdOn <= asOf,
          effectiveDate: b.effective,
        }));
        const result = classifyRetirement({
          asOf,
          upcomingDays,
          person: {
            active: Boolean(span),
            staffId: span ? `staff-${span.staff}` : null,
            cycleEntryDate: span?.entry ?? null,
            expectedDate: s.expected,
          },
          bills,
        });
        if (result.person) expected.get(result.person)!.push(s.employeeId);
        for (const b of result.bills) for (const name of b.views) expected.get(name)!.push(b.id);
      }
      for (const name of RETIREMENT_VIEWS) {
        const page = await w.view(name, `&upcomingDays=${upcomingDays}&pageSize=100`, asOf);
        expect([...w.ids(page)].sort(), `${name} asOf=${asOf} N=${upcomingDays}`).toEqual(
          [...expected.get(name)!].sort(),
        );
        expect(page.total).toBe(expected.get(name)!.length);
        seen.set(name, seen.get(name)! + page.total);
      }
    }
    // 防空转：每个视图在随机轮次里都至少命中过行
    for (const [name, count] of seen) expect(count, name).toBeGreaterThan(0);
  });
});
