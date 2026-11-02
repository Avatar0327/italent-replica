/**
 * BE-13b 第 3 轮返工回归（两路审查并集，派单第三节）：每条用例在自己新建的组织 / 人员上造数，用部门筛选互相隔离；
 * 期望值一律手写。夹具底座沿用 AC-HA-13b-support 的 movementWorld（租户今天 = 2026-10-06）。
 * - 第 1 项：编制只取期间覆盖取数时点、方案在该时点有效的对象；已结束方案的历史对象不得让整板 / 明细 / 页签 404；
 * - 第 2 项：B54 年度各表按人数，同一员工窗口内多次离职只计一次、归入最后一次（最后工作日最晚、同日单据 id 最大）；
 *   月表按月累加，重聘同年多次离职时月表合计可大于年度合计；
 * - 第 3 项：空值用独立表示（分组键为 JSON 元组，空值不进任何编码列），字典里真实存在的 none / NONE 编码照常计数；
 * - 第 7 项：组织编制页签按所选 year 的取数时点（年底与 asOf 较早者）取编制与实有人员；
 * - 第 8 项：退休列用独立键，不与字典编码 retirement 合并；
 * - 第 9 项：编制多周期 / 月度方案 / 数据范围外组织，以及边界 asOf 下流入 / 流出 / 组织编制页签。
 * 第 1 项③、第 4 项（5000 个对象上限）在 AC-HA-13b-r3-limit：造数后整个租户的编制都超限，单独一个库。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { ids, managementScope, restrictedAuthorizer } from './AC-HA-13a-support.js';
import {
  groupKey as key,
  MOVEMENT_BASE as BASE,
  movementClient,
  movementWorld,
  type MovementReport,
  type MovementWorld,
} from './AC-HA-13b-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const AS_OF = 'asOf=2026-10-06';

const table = (report: MovementReport, key: string) => report.tables!.find((item) => item.key === key)!;
const row = (report: MovementReport, tableKey: string, rowKey: string) =>
  table(report, tableKey).rows.find((item) => item.key === rowKey)?.cells;
const rowKeys = (report: MovementReport, tableKey: string) => table(report, tableKey).rows.map((item) => item.key);
/** 分组 / 原因行的键：JSON 元组，空值是 null（不是字符串哨兵）。 */
const sumOf = (rows: readonly { cells: Record<string, number | null> }[], column: string) =>
  rows.reduce((total, item) => total + (item.cells[column] ?? 0), 0);

describe('AC-HA-13b 第 3 轮返工回归', () => {
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
  async function created<T = { id: string; revision: number }>(response: Response) {
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  }
  const dictionary = async (kind: 'types' | 'reasons', code: string, name: string) =>
    created(await w.x.session.request('POST', `/exits/dictionaries/${kind}`, { ifMatch: 0, body: { code, name } }));
  async function rehire(employeeId: string, date: string, department: { id: string }) {
    await w.x.session.business(
      employeeId,
      { kind: 'rehire', mode: 'direct', effectiveDate: date, fields: { departmentId: department.id } },
      (await w.x.session.getEmployee(employeeId)).revision,
    );
  }
  /** 合成编制方案（API 建），返回方案 ID。 */
  async function scheme(input: {
    periodType: 'annual' | 'quarterly' | 'monthly';
    startDate: string;
    stopDate?: string;
    maintenanceMode?: 'local' | 'inclusive';
  }) {
    const body = {
      name: named('合成编制方案'),
      startMonth: 1,
      subdivision: 'none',
      maintenanceMode: 'local',
      ...input,
    };
    const response = await w.call('POST', '/api/tenant/establishment/schemes', { ifMatch: 0, body });
    return (await created<{ id: string }>(response)).id;
  }
  async function capacity(orgId: string, schemeId: string, periodStart: string, localCapacity: number) {
    const body = { orgId, schemeId, periodStart, localCapacity, strictControl: false };
    const response = await w.call('POST', '/api/tenant/establishment/capacities', { ifMatch: 0, body });
    return (await created<{ id: string }>(response)).id;
  }
  const establishmentKeys = async (filters: string) => (await c.groups('3.1.36', filters)).map((g) => g.key).sort();

  it('第 3 项：空值独立表示——启用未用的 none / NONE 列为 0，真实使用计 1，停用仍出列，空原因不进编码列', async () => {
    const typeNone = await dictionary('types', 'none', '合成编码 none（类型）');
    await dictionary('reasons', 'NONE', '合成编码 NONE（原因）');
    const disabledCode = `ha13b_off_${uniqueSuffix()}`;
    const disabled = await dictionary('types', disabledCode, '合成待停用类型');
    expect(typeNone.id).toBeTruthy();

    const D = await w.org(named('空值部'));
    const blank = await w.org(named('空值独立部'), D);
    const empty = await w.hire('空类型空原因', '2026-02-03', blank);
    await w.leave(empty.id, '2026-04-10');
    const used = await w.hire('真实使用 none', '2026-02-03', D);
    // 原因按小写匹配字典：员工填 none，归入字典编码 NONE
    await w.leave(used.id, '2026-04-11', { type: 'none', reason: 'none' });
    const off = await w.hire('停用类型', '2026-02-03', D);
    await w.leave(off.id, '2026-04-12', { type: disabledCode });
    const put = await w.x.session.request('PUT', `/exits/dictionaries/types/${disabled.id}`, {
      ifMatch: disabled.revision,
      body: { enabled: false },
    });
    expect(put.status, await put.clone().text()).toBe(200);

    // 只有空值人员：启用但未使用的 none / NONE 列为 0
    const onlyBlank = table(await c.report('outflow', `${AS_OF}&departmentId=${blank.id}`), 'sequences');
    expect(onlyBlank.summary.cells).toMatchObject({ total: 1, 'type:none': 0, 'reason:NONE': 0 });
    expect(onlyBlank.columns.map((item) => item.key)).toEqual(expect.arrayContaining(['type:none', 'reason:NONE']));

    const outflow = await c.report('outflow', `${AS_OF}&departmentId=${D.id}`);
    const sequences = table(outflow, 'sequences');
    expect(sequences.summary.cells).toMatchObject({
      total: 3,
      'type:none': 1,
      'reason:NONE': 1,
      [`type:${disabledCode}`]: 1,
    });
    // 空原因不进任何编码列：原因列之和 = 填了原因的人数
    const reasonColumns = sequences.columns.filter((item) => item.key.startsWith('reason:'));
    expect(reasonColumns.reduce((total, item) => total + (sequences.summary.cells[item.key] ?? 0), 0)).toBe(1);
    const typeColumns = sequences.columns.filter((item) => item.key.startsWith('type:'));
    expect(typeColumns.reduce((total, item) => total + (sequences.summary.cells[item.key] ?? 0), 0)).toBe(2);
    // 原因表：空类型空原因、真实 none、停用类型各自一行
    const reasons = Object.fromEntries(table(outflow, 'reasons').rows.map((item) => [item.key, item.cells.count]));
    expect(reasons).toEqual({
      [key('leave', null, null)]: 1,
      [key('leave', 'none', 'none')]: 1,
      [key('leave', disabledCode, null)]: 1,
    });
    // 看板 6.29：空类型与编码 none 分属两组
    const scoped = `${AS_OF}&departmentId=${D.id}`;
    await c.expectCount(BASE, '6.29', ids(empty), scoped, key('leave', null));
    await c.expectCount(BASE, '6.29', ids(used), scoped, key('leave', 'none'));
    await c.expectCount(BASE, '6.29', ids(used), scoped, key('leave', 'none', 'none'));
    await c.expectCount(BASE, '6.29', ids(empty), scoped, key('leave', null, null));
    // 空值组排在最后
    const top = (await c.groups('6.29', scoped)).filter((g) => g.parent === null).map((g) => g.key);
    expect(top.at(-1)).toBe(key('leave', null));
  });

  it('第 8 项：退休列用独立键，与字典编码 retirement 分开计数', async () => {
    await dictionary('types', 'retirement', '合成编码 retirement（离职类型）');
    const D = await w.org(named('退休编码部'));
    const coded = await w.hire('类型编码 retirement', '2025-04-01', D);
    await w.leave(coded.id, '2026-05-20', { type: 'retirement' });
    const retiree = await w.hire('真实退休', '2025-04-01', D);
    await w.retire(retiree.id, '2026-05-21');

    const outflow = await c.report('outflow', `${AS_OF}&departmentId=${D.id}`);
    const sequences = table(outflow, 'sequences');
    expect(sequences.summary.cells).toMatchObject({ total: 2, 'type:retirement': 1, retirement: 1 });
    expect(sequences.columns.find((item) => item.key === 'retirement')?.label).toBe('退休');
    expect(rowKeys(outflow, 'reasons').sort()).toEqual(
      [key('leave', 'retirement', null), key('retirement', null)].sort(),
    );
    const scoped = `${AS_OF}&departmentId=${D.id}`;
    await c.expectCount(BASE, '6.29', ids(coded), scoped, key('leave', 'retirement'));
    await c.expectCount(BASE, '6.29', ids(retiree), scoped, key('retirement'));
  });

  it('第 2 项：跨年跨部门三次离职——年度各表按人数、归入最后一次离职；月表按月累加', async () => {
    const R = await w.org(named('重聘上级'));
    const P = await w.org(named('重聘甲'), R);
    const Q = await w.org(named('重聘乙'), R);
    const person = await w.hire('跨年跨部门重聘', '2025-08-12', P);
    await w.leave(person.id, '2025-12-31', { type: w.T.vol, reason: w.R.pay });
    await rehire(person.id, '2026-01-01', Q);
    await w.leave(person.id, '2026-03-31', { type: w.T.vol, reason: w.R.pay });
    await rehire(person.id, '2026-05-01', P);
    await w.leave(person.id, '2026-08-31', { type: w.T.inv, reason: w.R.dev });

    // 全租户联合断言：原因行和 = 原因合计 = 属性表合计 = 类型列 + 退休列之和 = 流动统计离职合计 = 本年离职
    const leaves = await leavesThisYear('2026-10-06');
    const outflow = await c.report('outflow', AS_OF);
    const reasons = table(outflow, 'reasons');
    const sequences = table(outflow, 'sequences');
    const typed = sequences.columns.filter((item) => item.key.startsWith('type:') || item.key === 'retirement');
    const flow = table(await c.report('flow', AS_OF), 'flow');
    expect({
      reasonRows: sumOf(reasons.rows, 'count'),
      reasonTotal: reasons.summary.cells.count,
      sequenceTotal: sequences.summary.cells.total,
      typeColumns: typed.reduce((total, item) => total + (sequences.summary.cells[item.key] ?? 0), 0),
      flowTotal: flow.summary.cells.exits,
      flowRows: sumOf(flow.rows, 'exits'),
    }).toEqual({
      reasonRows: leaves,
      reasonTotal: leaves,
      sequenceTotal: leaves,
      typeColumns: leaves,
      flowTotal: leaves,
      flowRows: leaves,
    });

    // 归属取 8/31 那次（被动离职 / 发展，甲部）
    const scoped = `${AS_OF}&departmentId=${R.id}`;
    const mine = await c.report('outflow', scoped);
    expect(Object.fromEntries(table(mine, 'reasons').rows.map((item) => [item.key, item.cells.count]))).toEqual({
      [key('leave', w.T.inv, w.R.dev)]: 1,
    });
    expect(table(mine, 'sequences').summary.cells).toMatchObject({
      total: 1,
      [`type:${w.T.inv}`]: 1,
      [`type:${w.T.vol}`]: 0,
      [`reason:${w.R.dev}`]: 1,
      [`reason:${w.R.pay}`]: 0,
    });
    const drill = await c.report('flow', `${AS_OF}&parentId=${R.id}`);
    expect(row(drill, 'flow', P.id)).toMatchObject({ exits: 1 });
    expect(row(drill, 'flow', Q.id)?.exits ?? 0).toBe(0);
    for (const [org, exits] of [
      [P, 1],
      [Q, 0],
    ] as const) {
      const single = table(await c.report('flow', `${AS_OF}&departmentId=${org.id}`), 'flow');
      expect(single.summary.cells.exits, org.id).toBe(exits);
    }
    // 月表：3 月、8 月各计 1，页尾 = 已到月份行之和 = 2（与年度合计 1 不等，契约如此）
    const monthly = table(await c.report('monthly', scoped), 'monthly');
    expect(monthly.rows.find((item) => item.key === '2026-03')?.cells.exits).toBe(1);
    expect(monthly.rows.find((item) => item.key === '2026-08')?.cells.exits).toBe(1);
    expect(monthly.summary.cells.exits).toBe(sumOf(monthly.rows, 'exits'));
    expect(monthly.summary.cells.exits).toBe(2);
    // 看板近 12 个月（按生效日 2026-01-01 / 04-01 / 09-01 三次）：6.29 只计一次，归被动离职 / 发展
    await c.expectCount(BASE, '6.29', ids(person), scoped);
    await c.expectCount(BASE, '6.29', ids(person), scoped, key('leave', w.T.inv));
    await c.expectCount(BASE, '6.29', ids(person), scoped, key('leave', w.T.inv, w.R.dev));
    await c.expectCount(BASE, '6.29', [], scoped, key('leave', w.T.vol));
  });

  it('第 7 项：组织编制页签按所选 year 的取数时点取编制与实有人员', async () => {
    const Y = await w.org(named('年度编制部'));
    const schemeId = await scheme({ periodType: 'annual', startDate: '2025-01-01' });
    const last = await capacity(Y.id, schemeId, '2025-01-01', 5);
    const now = await capacity(Y.id, schemeId, '2026-01-01', 8);
    const leaver = await w.hire('去年在职', '2025-03-01', Y);
    await w.leave(leaver.id, '2026-02-27');
    await w.hire('今年入职', '2026-03-02', Y);
    const scoped = `${AS_OF}&departmentId=${Y.id}`;

    const previous = await c.report('establishment', `${scoped}&year=2025`);
    expect(rowKeys(previous, 'establishment')).toEqual([last]);
    expect(row(previous, 'establishment', last)).toMatchObject({ localCapacity: 5, inclusiveCapacity: 5, actual: 1 });
    const current = await c.report('establishment', scoped);
    expect(rowKeys(current, 'establishment')).toEqual([now]);
    expect(row(current, 'establishment', now)).toMatchObject({ localCapacity: 8, inclusiveCapacity: 8, actual: 1 });
  });

  it('第 1 项②：过期方案与有效方案并存时只出有效方案的编制，过期对象不让看板 / 页签 404', async () => {
    const Y = await w.org(named('并存编制部'));
    await w.hire('并存编制员工', '2025-02-01', Y);
    const ended = await scheme({ periodType: 'annual', startDate: '2025-01-01', stopDate: '2025-12-31' });
    const old = await capacity(Y.id, ended, '2025-01-01', 4);
    const active = await scheme({ periodType: 'annual', startDate: '2026-01-01' });
    const now = await capacity(Y.id, active, '2026-01-01', 6);
    const scoped = `${AS_OF}&departmentId=${Y.id}`;

    expect(await establishmentKeys(scoped)).toEqual([now]);
    await c.expectCount(BASE, '3.1.36', [], scoped, old);
    const report = await c.report('establishment', scoped);
    expect(rowKeys(report, 'establishment')).toEqual([now]);
    // 上一年年底：过期方案当时有效，新方案尚未生效
    const previous = await c.report('establishment', `${scoped}&year=2025`);
    expect(rowKeys(previous, 'establishment')).toEqual([old]);
  });

  it('第 9 项：编制多周期（季度两期 + 年度）、月度方案只出覆盖 asOf 的那期，各一行不互相覆盖', async () => {
    const Y = await w.org(named('多周期编制部'));
    const person = await w.hire('多周期编制员工', '2026-01-05', Y);
    const quarterly = await scheme({ periodType: 'quarterly', startDate: '2026-01-01' });
    await capacity(Y.id, quarterly, '2026-07-01', 3);
    const q4 = await capacity(Y.id, quarterly, '2026-10-01', 4);
    const annual = await scheme({ periodType: 'annual', startDate: '2026-01-01' });
    const year = await capacity(Y.id, annual, '2026-01-01', 10);
    const monthly = await scheme({ periodType: 'monthly', startDate: '2026-01-01' });
    // 月度方案新建会自动补齐当年后续各月；先建十月再建九月，九月补齐时跳过已有的十月
    const october = await capacity(Y.id, monthly, '2026-10-01', 2);
    await capacity(Y.id, monthly, '2026-09-01', 1);
    const scoped = `${AS_OF}&departmentId=${Y.id}`;

    expect(await establishmentKeys(scoped)).toEqual([q4, year, october].sort());
    for (const id of [q4, year, october]) await c.expectCount(BASE, '3.1.36', ids(person), scoped, id);
    const report = await c.report('establishment', scoped);
    expect(rowKeys(report, 'establishment').sort()).toEqual([q4, year, october].sort());
    expect(row(report, 'establishment', q4)).toMatchObject({ localCapacity: 4, actual: 1 });
    expect(row(report, 'establishment', october)).toMatchObject({ localCapacity: 2, actual: 1 });
    expect(table(report, 'establishment').summary.cells).toMatchObject({ localCapacity: 16 });
  });

  it('第 9 项：数据范围外组织的编制不进 3.1.36 与组织编制页签', async () => {
    const inside = await w.org(named('范围内编制部'));
    const outside = await w.org(named('范围外编制部'));
    const schemeId = await scheme({ periodType: 'annual', startDate: '2026-01-01' });
    const mine = await capacity(inside.id, schemeId, '2026-01-01', 2);
    const hidden = await capacity(outside.id, schemeId, '2026-01-01', 9);
    const scoped = movementClient(
      w.db,
      w.who,
      restrictedAuthorizer({ scope: managementScope(w.tenantId, [inside.id]) }),
    );

    const groups = (await scoped.groups('3.1.36', AS_OF)).map((g) => g.key);
    expect(groups).toContain(mine);
    expect(groups).not.toContain(hidden);
    const report = await scoped.report('establishment', AS_OF);
    expect(rowKeys(report, 'establishment')).toContain(mine);
    expect(rowKeys(report, 'establishment')).not.toContain(hidden);
  });

  it('第 9 项：边界 asOf 下流入、流出、组织编制页签都 200', async () => {
    const statuses: Record<string, number> = {};
    const expected: Record<string, number> = {};
    for (const asOf of ['0001-01-02', '0001-12-31', '0099-02-28', '0100-03-01', '1899-01-01', '9999-12-01'])
      for (const code of ['inflow', 'outflow', 'establishment']) {
        const response = await c.get(`${BASE}/reports/${code}?asOf=${asOf}`);
        statuses[`${code}@${asOf}`] = response.status;
        expected[`${code}@${asOf}`] = 200;
      }
    expect(statuses).toEqual(expected);
  });

  it('第 1 项①：只有已结束的 2025 方案时，整板、6.25 明细、组织编制页签都 200 且无编制行', async () => {
    const Y = await w.org(named('历史编制部'));
    const ended = await scheme({ periodType: 'annual', startDate: '2025-01-01', stopDate: '2025-12-31' });
    const old = await capacity(Y.id, ended, '2025-01-01', 10);
    const scoped = `${AS_OF}&departmentId=${Y.id}`;
    for (const path of [`${BASE}?${AS_OF}`, `${BASE}/components/6.25?${AS_OF}&group=2026-10`]) {
      const response = await c.get(path);
      expect(response.status, `${path} ${await response.clone().text()}`).toBe(200);
    }
    expect(await establishmentKeys(scoped)).toEqual([]);
    expect((await c.groups('3.1.36', AS_OF)).map((g) => g.key)).not.toContain(old);
    const report = await c.report('establishment', AS_OF);
    expect(rowKeys(report, 'establishment')).not.toContain(old);
    expect(table(await c.report('establishment', scoped), 'establishment').rows).toEqual([]);
  });
});
