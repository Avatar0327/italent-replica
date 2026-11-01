/**
 * BE-13b 第 2 轮返工回归（审查 P2-1～P2-8、F-431）：每条用例在自己新建的组织 / 人员上造数，用部门筛选互相隔离；
 * 期望值一律手写。夹具底座沿用 AC-HA-13b-support 的 movementWorld（租户今天 = 2026-10-06）。
 * - P2-1（DEC-729）：B54 流出按最后工作日归年、归月，流出合计 = BE-12b 人事看板“本年离职”（年界 12-31、最后工作日 = asOf）；
 *   B50 是否在职仍按离职生效日（最后工作日 + 1）；
 * - P2-2：3.1.36 与“组织编制统计”取编制模块的组织编制（本级 / 含下级）与同一时点的实有人员（含下级），
 *   预增员 / 预减员 / 缺编数 / 执行率整列为 null（按组织汇总的读接口尚未抽出，F-418）；
 * - P2-3：B54 调动只计内部员工 + 实习生；P2-4：清空的职务序列不回落到任职底表旧值；
 * - P2-5：月表页尾 = 各月行之和；P2-6：asOf 合法边界不 500；P2-7：全表组织行 = 单筛该组织；
 * - P2-8：离职类型 / 原因列由租户字典展开，未使用的启用项为 0；
 * - F-431：① 一级机构 = 行政树根下直属组织（不按机构类型）；② 6.32 窗口 = 近 12 个自然月（含 asOf 所在月）。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { ids } from './AC-HA-13a-support.js';
import {
  MOVEMENT_BASE as BASE,
  movementClient,
  movementWorld,
  type MovementGroup,
  type MovementReport,
  type MovementWorld,
} from './AC-HA-13b-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const AS_OF = 'asOf=2026-10-06';

const table = (report: MovementReport, key: string) => report.tables!.find((item) => item.key === key)!;
const row = (report: MovementReport, tableKey: string, rowKey: string) =>
  table(report, tableKey).rows.find((item) => item.key === rowKey)?.cells;
type EstablishmentGroup = MovementGroup & Record<string, unknown>;

describe('AC-HA-13b 第 2 轮返工回归', () => {
  let w: MovementWorld;
  let c: ReturnType<typeof movementClient>;
  beforeAll(async () => {
    w = await movementWorld(database().db);
    c = movementClient(w.db, w.who);
  }, 600_000);

  const named = (name: string) => `${name}-${uniqueSuffix()}`;
  async function leavesThisYear(asOf: string) {
    const response = await c.get(`/api/tenant/analytics/hr-dashboard?asOf=${asOf}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { indicators: { code: string; value: number | null }[] };
    return body.indicators.find((item) => item.code === 'leavesThisYear')!.value;
  }
  /** B54 三处流出合计：流出统计合计、流动统计离职合计、各月离职行之和。 */
  async function outflowTotals(asOf: string) {
    const outflow = await c.report('outflow', `asOf=${asOf}`);
    const flow = await c.report('flow', `asOf=${asOf}`);
    const monthly = table(await c.report('monthly', `asOf=${asOf}`), 'monthly');
    return {
      outflow: table(outflow, 'sequences').summary.cells.total,
      reasons: table(outflow, 'reasons').summary.cells.count,
      flow: table(flow, 'flow').summary.cells.exits,
      monthly: monthly.rows.reduce((sum, item) => sum + (item.cells.exits ?? 0), 0),
    };
  }

  it('P2-1：上一年 12-31 为最后工作日的离职归上一年；B54 流出合计 = 人事看板本年离职', async () => {
    const Y = await w.org(named('年界部'));
    const person = await w.hire('年界离职', '2025-01-01', Y);
    await w.leave(person.id, '2025-12-31', { type: w.T.vol });
    const scoped = `${AS_OF}&departmentId=${Y.id}`;
    // 2026 年：不进本年离职 / 1 月离职；年初（2026-01-01 时点）已不在职
    expect(row(await c.report('flow', scoped), 'flow', Y.id)).toBeUndefined();
    expect(row(await c.report('monthly', scoped), 'monthly', '2026-01')).toMatchObject({ opening: 0, exits: 0 });
    expect(table(await c.report('outflow', scoped), 'sequences').summary.cells.total).toBe(0);
    // 2025 年：归 12 月
    const last = await c.report('monthly', `${scoped}&year=2025`);
    expect(row(last, 'monthly', '2025-12')).toMatchObject({ exits: 1 });
    expect(table(await c.report('outflow', `${scoped}&year=2025`), 'sequences').summary.cells.total).toBe(1);
    // B50 仍按生效日：2026-01-01 生效，计 2026-01 离职
    await c.expectCount(BASE, '6.26', ids(person), scoped, 'exit:2026-01');
    const leaves = await leavesThisYear('2026-10-06');
    expect(await outflowTotals('2026-10-06')).toEqual({
      outflow: leaves,
      reasons: leaves,
      flow: leaves,
      monthly: leaves,
    });
  });

  it('P2-1：最后工作日 = asOf 当天计入 B54 流出，与人事看板本年离职一致', async () => {
    // 夹具：一月底离职 1/31、三十天离职 3/31 是最后工作日
    for (const asOf of ['2026-01-31', '2026-03-31']) {
      const leaves = await leavesThisYear(asOf);
      expect(await outflowTotals(asOf), asOf).toEqual({
        outflow: leaves,
        reasons: leaves,
        flow: leaves,
        monthly: leaves,
      });
    }
    expect(await leavesThisYear('2026-01-31')).toBe(1);
    const january = await c.report('monthly', 'asOf=2026-01-31');
    expect(row(january, 'monthly', '2026-01')).toMatchObject({ exits: 1 });
  });

  it('P2-2：有组织编制时 3.1.36 与组织编制统计取本级 / 含下级编制与实有人员（含下级），其余列 null', async () => {
    const G = await w.org(named('编制部'));
    const G1 = await w.org(named('编制组'), G);
    const inG = await w.hire('编制部员工', '2026-02-01', G);
    const inG1 = await w.hire('编制组员工', '2026-02-01', G1);
    const call = (method: string, path: string, body?: unknown) =>
      w.call(method, path, { ifMatch: 0, ...(body ? { body } : {}) });
    const scheme = await call('POST', '/api/tenant/establishment/schemes', {
      name: named('合成编制方案'),
      periodType: 'annual',
      startMonth: 1,
      maintenanceMode: 'local',
      subdivision: 'none',
      startDate: '2026-01-01',
    });
    expect(scheme.status, await scheme.clone().text()).toBe(201);
    const schemeId = ((await scheme.json()) as { id: string }).id;
    const capacity = async (orgId: string, localCapacity: number) => {
      const response = await call('POST', '/api/tenant/establishment/capacities', {
        orgId,
        schemeId,
        periodStart: '2026-01-01',
        localCapacity,
        strictControl: false,
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string };
    };
    const capG = await capacity(G.id, 10);
    const capG1 = await capacity(G1.id, 3);
    const read = await call('GET', `/api/tenant/establishment/capacities/${capG.id}?asOf=2026-10-06`);
    expect(((await read.json()) as { localCapacity: number }).localCapacity).toBe(10);

    const scoped = `${AS_OF}&departmentId=${G.id}`;
    const actual = (await c.group('6.25', scoped, '2026-10'))!.count;
    expect(actual).toBe(2);
    const empty = { pendingIn: null, pendingOut: null, vacancy: null, executionRate: null };
    const component = await c.component(BASE, '3.1.36', scoped);
    expect(component.kind).toBe('table');
    const groups = (component.groups ?? []) as unknown as EstablishmentGroup[];
    expect(groups.find((g) => g.key === capG.id)).toMatchObject({
      orgId: G.id,
      localCapacity: 10,
      inclusiveCapacity: 13,
      count: actual,
      ...empty,
    });
    expect(groups.find((g) => g.key === capG1.id)).toMatchObject({ localCapacity: 3, inclusiveCapacity: 3, count: 1 });
    await c.expectCount(BASE, '3.1.36', ids(inG, inG1), scoped, capG.id);

    const report = await c.report('establishment', scoped);
    expect(report.kind).toBe('table');
    expect(row(report, 'establishment', capG.id)).toEqual({
      localCapacity: 10,
      inclusiveCapacity: 13,
      actual,
      ...empty,
    });
    expect(row(report, 'establishment', capG1.id)).toMatchObject({ localCapacity: 3, actual: 1 });
  });

  it('P2-3：B54 / 6.27 调动只计内部员工与实习生，外部人员调动不计', async () => {
    const K1 = await w.org(named('调出部'));
    const K2 = await w.org(named('调入部'));
    const inner = await w.hire('内部调动', '2026-01-05', K1);
    const intern = await w.hire('实习调动', '2026-01-05', K1, { employType: 'intern' });
    const outer = await w.hire('外部调动', '2026-01-05', K1, { employType: 'external' });
    for (const person of [inner, intern, outer]) await w.transfer(person.id, '2026-09-01', K2);
    const scoped = `${AS_OF}&departmentId=${K2.id}`;
    expect(table(await c.report('flow', scoped), 'flow').summary.cells.transfers).toBe(2);
    await c.expectCount(BASE, '6.27', ids(inner, intern), scoped);
  });

  it('P2-4：任职记录清空职务序列后离职，流出统计归入“空”，不回落到旧序列', async () => {
    const D = await w.org(named('清空序列部'));
    const S2 = await w.sequence(named('清空前序列'));
    const person = await w.x.session.employee('清空序列');
    const hired = await w.x.session.business(
      person.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-02-01',
        fields: { employType: 'internal', departmentId: D.id, sequenceId: S2.id },
      },
      person.revision,
    );
    const patched = await w.x.session.request('PATCH', `/records/${hired.id}`, {
      ifMatch: hired.revision,
      body: { fields: { sequenceId: null } },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await w.x.session.record(hired.id)).fields.sequenceId).toBeNull();
    await w.leave(person.id, '2026-05-01', { type: w.T.vol });
    const report = await c.report('outflow', `${AS_OF}&departmentId=${D.id}`);
    expect(row(report, 'sequences', S2.id)).toBeUndefined();
    expect(row(report, 'sequences', 'none')).toMatchObject({ total: 1 });
  });

  it('P2-5 / P2-7：同一人年内跨部门两段任职——月表页尾 = 各月行之和，全表组织行 = 单筛该组织', async () => {
    const P = await w.org(named('首段部'));
    const Q = await w.org(named('重聘部'));
    const person = await w.hire('年内重聘', '2026-01-05', P);
    await w.leave(person.id, '2026-03-31', { type: w.T.vol });
    await w.x.session.business(
      person.id,
      { kind: 'rehire', mode: 'direct', effectiveDate: '2026-06-01', fields: { departmentId: Q.id } },
      (await w.x.session.getEmployee(person.id)).revision,
    );
    await w.leave(person.id, '2026-09-30', { type: w.T.inv });

    for (const filter of [AS_OF, `${AS_OF}&departmentId=${P.id}`, `${AS_OF}&departmentId=${Q.id}`]) {
      const monthly = table(await c.report('monthly', filter), 'monthly');
      const shown = monthly.rows.filter((item) => item.cells.opening !== null);
      const sum = (key: string) => shown.reduce((total, item) => total + item.cells[key]!, 0);
      const sums = { opening: sum('opening'), hires: sum('hires'), exits: sum('exits'), closing: sum('closing') };
      expect(monthly.summary.cells, filter).toMatchObject(sums);
      const average = (sums.opening + sums.closing) / 2;
      expect(monthly.summary.cells.rate, filter).toBe(average ? Math.round((sums.exits / average) * 1e4) / 1e4 : 0);
      expect(monthly.rows.slice(10).map((item) => item.cells.hires)).toEqual([null, null]);
    }
    const onlyQ = table(await c.report('monthly', `${AS_OF}&departmentId=${Q.id}`), 'monthly').summary.cells;
    expect(onlyQ).toMatchObject({ hires: 1, exits: 1 });
    const onlyP = table(await c.report('monthly', `${AS_OF}&departmentId=${P.id}`), 'monthly').summary.cells;
    expect(onlyP).toMatchObject({ hires: 1, exits: 1 });

    const full = await c.report('flow', AS_OF);
    for (const org of [P, Q]) {
      const single = table(await c.report('flow', `${AS_OF}&departmentId=${org.id}`), 'flow');
      expect(row(full, 'flow', org.id), org.id).toEqual(single.summary.cells);
      expect(single.summary.cells).toMatchObject({ hires: 1, exits: 1 });
    }
    for (const month of [3, 6, 9]) {
      const filters = `${AS_OF}&year=2026&month=${month}`;
      const whole = await c.report('institution', filters);
      for (const org of [P, Q]) {
        const single = await c.report('institution', `${filters}&departmentId=${org.id}`);
        expect(row(whole, 'institution', org.id) ?? null, `${month} 月 ${org.id}`).toEqual(
          row(single, 'institution', org.id) ?? null,
        );
      }
    }
  });

  it('P2-6：asOf 合法边界 0001-01-02 / 9999-12-01 不得 500；算不了近 12 个月的看板明确 400', async () => {
    const status = async (path: string) => {
      const response = await c.get(path);
      const body = (await response.json()) as { error?: { code: string } };
      return { status: response.status, code: body.error?.code };
    };
    expect(await status(`${BASE}?asOf=0001-01-02`)).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await status(`${BASE}/components/6.25?asOf=0001-01-02&group=0001-01`)).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(await status(`${BASE}?asOf=9999-12-01`)).toEqual({ status: 200, code: undefined });
    for (const asOf of ['0001-01-02', '9999-12-01'])
      for (const report of ['monthly', 'flow', 'institution'])
        expect(await status(`${BASE}/reports/${report}?asOf=${asOf}`), `${report} ${asOf}`).toEqual({
          status: 200,
          code: undefined,
        });
    const months = await c.report('monthly', 'asOf=9999-12-01');
    expect(row(months, 'monthly', '9999-12')).toMatchObject({ exits: 0 });
    const first = await c.report('monthly', 'asOf=0001-01-02');
    expect(table(first, 'monthly').rows.map((item) => item.key)[0]).toBe('0001-01');
    expect(row(first, 'monthly', '0001-02')?.opening).toBeNull();
    // 9999-12 的期末 = asOf 当天，月份键四位年份
    expect((await c.groups('6.25', 'asOf=9999-12-01')).at(-1)?.key).toBe('9999-12');
  });

  it('P2-8：离职类型 / 原因列由租户字典展开，启用但未使用的类型、原因列为 0', async () => {
    const created: Record<string, string> = {};
    for (const kind of ['types', 'reasons'] as const) {
      const code = `unused_${kind}_${uniqueSuffix()}`;
      const response = await w.x.session.request('POST', `/exits/dictionaries/${kind}`, {
        ifMatch: 0,
        body: { code, name: `合成未使用${kind === 'types' ? '类型' : '原因'}`, enabled: true },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      created[kind] = code;
    }
    const report = await c.report('outflow', AS_OF);
    const sequences = table(report, 'sequences');
    const keys = sequences.columns.map((column) => column.key);
    expect(keys).toContain(`type:${created.types}`);
    expect(keys).toContain(`reason:${created.reasons}`);
    expect(sequences.summary.cells[`type:${created.types}`]).toBe(0);
    expect(sequences.summary.cells[`reason:${created.reasons}`]).toBe(0);
    for (const item of sequences.rows) expect(item.cells[`type:${created.types}`]).toBe(0);
  });

  it('F-431 ①：一级机构 = 行政树根下的直属组织，根下直属的“部门”类型也单列，不上溯“机构”', async () => {
    const top = await w.org(named('直属部门'));
    const company = await w.x.session.org(named('下级机构'), {
      establishedOn: '2000-01-01',
      broadType: '机构',
      parents: { admin: { parentId: top.id } },
    });
    const person = await w.hire('机构下员工', '2026-04-03', company);
    const filters = `${AS_OF}&year=2026&month=4`;
    expect(row(await c.report('institution', filters), 'institution', top.id)).toMatchObject({ hires: 1 });
    expect(row(await c.report('institution', filters), 'institution', company.id)).toBeUndefined();
    expect(row(await c.report('flow', AS_OF), 'flow', top.id)).toMatchObject({ hires: 1 });
    await c.expectCount(BASE, '6.26', ids(person), `${AS_OF}&departmentId=${top.id}`, 'hire:2026-04');
  });

  it('F-431 ②：6.32 窗口 = 近 12 个自然月（含 asOf 所在月），司龄 ≤ 0.083 年', async () => {
    const F = await w.org(named('早离部'));
    // asOf 2026-11-15 → 2025-12～2026-11；按离职生效日（最后工作日 + 1）判窗口
    const before = await w.hire('窗口外', '2025-10-30', F); // 最后工作日 11-29 → 11-30 生效，30 天
    const edge = await w.hire('窗口首日', '2025-10-31', F); // 最后工作日 11-30 → 12-01 生效，30 天
    const over = await w.hire('超一个月', '2025-11-01', F); // 最后工作日 12-02，31 天
    await w.leave(before.id, '2025-11-29', { type: w.T.vol });
    await w.leave(edge.id, '2025-11-30', { type: w.T.vol });
    await w.leave(over.id, '2025-12-02', { type: w.T.vol });
    await c.expectCount(BASE, '6.32', ids(edge), `asOf=2026-11-15&departmentId=${F.id}`);
    await c.expectCount(BASE, '6.29', ids(edge, over), `asOf=2026-11-15&departmentId=${F.id}`);
  });
});
