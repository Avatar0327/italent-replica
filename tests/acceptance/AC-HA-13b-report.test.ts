/**
 * BE-13b / B54 流动情况报表六个页签（规格 35“流动情况各报表的算法”）：默认本年（asOf = 2026-10-06 → 2026 年）。
 * - AC-HA-13b-07 期初 / 期末各按日期取时点人数，不用“上月期末 + 入职 − 离职”推算（10 月期初 ≠ 9 月期末）；
 * - AC-HA-13b-08 流入 / 流出按任职记录开始日期取数（离职记录始于最后工作日次日），只算内部员工 + 实习生；
 * - AC-HA-13b-09 流出合计 = BE-12b 人事看板“本年离职”；
 * - AC-HA-13b-10 组织编制无数据源，返回 unavailable；
 * - 授权与数据范围：AC-HA-13b-11 / AC-HA-05。
 */
import { HR_MOVEMENT_OBJECT, HR_MOVEMENT_REPORT_OBJECT, presetSeeAllTargets, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { ids, managementScope, restrictedAuthorizer } from './AC-HA-13a-support.js';
import {
  MOVEMENT_BASE as BASE,
  movementClient,
  movementWorld,
  type MovementReport,
  type MovementWorld,
} from './AC-HA-13b-support.js';

const database = useTestDb();
const AS_OF = 'asOf=2026-10-06';

const table = (report: MovementReport, key: string) => report.tables!.find((item) => item.key === key)!;
const row = (report: MovementReport, tableKey: string, rowKey: string) =>
  table(report, tableKey).rows.find((item) => item.key === rowKey)?.cells;

describe('AC-HA-13b B54 流动情况报表', () => {
  let w: MovementWorld;
  let c: ReturnType<typeof movementClient>;
  beforeAll(async () => {
    w = await movementWorld(database().db);
    c = movementClient(w.db, w.who);
  }, 600_000);

  it('流动统计：一级组织 × 年初 / 入职 / 调动 / 离职 / 年底 / 净增长 / 绝对增长率 / 累计变动量', async () => {
    const report = await c.report('flow', AS_OF);
    expect({ year: report.year, kind: report.kind }).toEqual({ year: 2026, kind: 'table' });
    expect(table(report, 'flow').columns.map((column) => column.key)).toEqual([
      'yearStart',
      'hires',
      'transfers',
      'exits',
      'yearEnd',
      'netGrowth',
      'growthRate',
      'totalChange',
    ]);
    // 甲部（含甲一组）：年初 老员工 / 一月底 / 退休 / 转正 / 组织调整；离职 一月底、三十天、退休（外部人员不计）
    expect(row(report, 'flow', w.A.id)).toEqual({
      yearStart: 5,
      hires: 2,
      transfers: 1,
      exits: 3,
      yearEnd: 4,
      netGrowth: -1,
      growthRate: -0.2222,
      totalChange: 6,
    });
    expect(row(report, 'flow', w.B.id)).toEqual({
      yearStart: 0,
      hires: 2,
      transfers: 0,
      exits: 1,
      yearEnd: 1,
      netGrowth: 1,
      growthRate: 2,
      totalChange: 3,
    });
    expect(table(report, 'flow').summary.cells).toMatchObject({
      yearStart: 5,
      hires: 6,
      transfers: 1,
      exits: 5,
      yearEnd: 6,
    });
    // 按组织层级下钻：甲部的下级
    const drill = await c.report('flow', `${AS_OF}&parentId=${w.A.id}`);
    expect(row(drill, 'flow', w.A1.id)).toMatchObject({ yearStart: 0, transfers: 1, exits: 0, yearEnd: 1 });
    expect(row(drill, 'flow', w.B.id)).toBeUndefined();
  });

  it('AC-HA-13b-07：各月入离职——期初 / 期末按日取数，10 月期初 ≠ 9 月期末；asOf 之后的月份为 null', async () => {
    const report = await c.report('monthly', AS_OF);
    const monthly = table(report, 'monthly');
    expect(monthly.rows.map((item) => item.key)).toEqual(
      Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`),
    );
    expect(row(report, 'monthly', '2026-02')).toEqual({ opening: 6, hires: 2, exits: 1, closing: 6, rate: 0.1667 });
    expect(row(report, 'monthly', '2026-09')).toEqual({ opening: 6, hires: 1, exits: 1, closing: 5, rate: 0.1818 });
    expect(row(report, 'monthly', '2026-10')).toEqual({ opening: 6, hires: 1, exits: 0, closing: 6, rate: 0 });
    expect(row(report, 'monthly', '2026-11')).toEqual({
      opening: null,
      hires: null,
      exits: null,
      closing: null,
      rate: null,
    });
  });

  it('各机构入离职：一级机构 × 期初 / 入职 / 离职 / 期末 / 离职率（指定年、月）', async () => {
    const report = await c.report('institution', `${AS_OF}&year=2026&month=4`);
    expect(report.month).toBe(4);
    // 三十天离职 3/31 最后工作日 → 4/1 生效：4 月期初在职、4 月离职
    expect(row(report, 'institution', w.A.id)).toEqual({ opening: 5, hires: 0, exits: 1, closing: 4, rate: 0.2222 });
    // 三十一天离职 4/1 最后工作日：4/1 仍在职（期初），4/2 生效
    expect(row(report, 'institution', w.B.id)).toEqual({ opening: 2, hires: 0, exits: 1, closing: 1, rate: 0.6667 });
    expect((await c.get(`${BASE}/reports/institution?${AS_OF}&year=2026&month=13`)).status).toBe(400);
  });

  it('AC-HA-13b-08：流入——职务序列 × 合计 / 性别 / 学历 / 年龄 / 平均年龄（内部 + 实习，按入职记录开始日）', async () => {
    const report = await c.report('inflow', AS_OF);
    expect(row(report, 'inflow', w.S1.id)).toMatchObject({
      total: 1,
      'gender:男': 1,
      'education:bachelor': 1,
      'age:25to30': 1,
      averageAge: 30,
    });
    // 无序列：十月一日 / 三十一天 / 实习生 / 范围外 / 底层夹具员工（外部人员不计）
    expect(row(report, 'inflow', 'none')).toMatchObject({ total: 5, averageAge: null });
    expect(table(report, 'inflow').summary.cells).toMatchObject({ total: 6 });
  });

  it('AC-HA-13b-08 / 09：流出——离职类型 × 原因、职务序列 × 属性；合计 = 人事看板“本年离职”', async () => {
    const { T, R } = w;
    const report = await c.report('outflow', AS_OF);
    expect(report.tables!.map((item) => item.key)).toEqual(['reasons', 'sequences']);
    expect(row(report, 'reasons', `${T.vol}|${R.pay}`)).toEqual({ count: 1 });
    expect(row(report, 'reasons', `${T.vol}|${R.dev}`)).toEqual({ count: 1 });
    expect(row(report, 'reasons', `${T.vol}|none`)).toEqual({ count: 1 });
    expect(row(report, 'reasons', `${T.inv}|none`)).toEqual({ count: 1 }); // 去年离职不进本年
    expect(row(report, 'reasons', 'retirement|none')).toEqual({ count: 1 });
    expect(table(report, 'reasons').summary.cells).toEqual({ count: 5 });
    expect(row(report, 'sequences', w.S1.id)).toMatchObject({
      total: 1,
      'gender:男': 1,
      'education:bachelor': 1,
      'tenure:under6m': 1,
      averageTenure: 0,
      [`type:${T.vol}`]: 1,
      [`reason:${R.dev}`]: 1,
      keyPerson: 0,
    });
    expect(row(report, 'sequences', 'none')).toMatchObject({ total: 4, keyPerson: 1, 'type:retirement': 1 });

    const dashboard = (await (await c.get(`/api/tenant/analytics/hr-dashboard?${AS_OF}`)).json()) as {
      indicators: { code: string; value: number | null }[];
    };
    const leaves = dashboard.indicators.find((item) => item.code === 'leavesThisYear')!.value;
    expect(table(report, 'sequences').summary.cells.total).toBe(leaves);
    expect(leaves).toBe(5);
  });

  it('AC-HA-13b-10：组织编制无数据源 → unavailable；year 晚于 asOf 所在年 → 400；未知页签 → 404', async () => {
    const report = await c.report('establishment', AS_OF);
    expect({ kind: report.kind, tables: report.tables }).toEqual({ kind: 'unavailable', tables: null });
    expect((await c.get(`${BASE}/reports/flow?${AS_OF}&year=2027`)).status).toBe(400);
    expect((await c.get(`${BASE}/reports/nope?${AS_OF}`)).status).toBe(404);
  });

  it('AC-HA-13b-11：没有对象“查看”→ 403，两个对象互不放行', async () => {
    const paths: [string, string[]][] = [
      [HR_MOVEMENT_OBJECT, [`${BASE}?${AS_OF}`, `${BASE}/components/6.25?${AS_OF}&group=2026-10`]],
      [HR_MOVEMENT_REPORT_OBJECT, [`${BASE}/reports/flow?${AS_OF}`, `${BASE}/reports/establishment`]],
    ];
    for (const [object, denied] of paths) {
      const limited = movementClient(w.db, w.who, restrictedAuthorizer({ deny: object }));
      for (const path of denied) expect((await limited.get(path)).status, `${object} ${path}`).toBe(403);
      for (const [other, allowed] of paths)
        if (other !== object) expect((await limited.get(allowed[0]!)).status, `${object} → ${other}`).toBe(200);
    }
  });

  it('AC-HA-05：管理单元范围只统计范围内人员（范围外部门的离职不计），数字 = 明细', async () => {
    const { p } = w;
    const scope = managementScope(w.tenantId, [w.A.id, w.A1.id, w.B.id]);
    const limited = movementClient(w.db, w.who, restrictedAuthorizer({ scope }));
    await limited.expectCount(BASE, '6.29', ids(p.lastYear, p.jan31, p.m30, p.m31, p.retired), AS_OF);
    await limited.expectCount(BASE, '6.26', ids(p.intern), AS_OF, 'hire:2026-02');
    await limited.expectCount(BASE, '6.25', ids(p.old, p.oct1, p.intern, p.reg, p.orgAdj), AS_OF, '2026-10');
    const report = await limited.report('flow', AS_OF);
    expect(
      table(report, 'flow')
        .rows.map((item) => item.key)
        .sort(),
    ).toEqual([w.A.id, w.B.id].sort());
    expect(table(report, 'flow').summary.cells).toMatchObject({ exits: 4 });
  });

  it('AC-HA-05：空范围（默认）全为 0，hasDataPermission = false，不退回“全部”', async () => {
    const limited = movementClient(w.db, w.who, restrictedAuthorizer({ scope: { ...EMPTY_SCOPE } }));
    expect((await limited.board(BASE, AS_OF)).hasDataPermission).toBe(false);
    await limited.expectCount(BASE, '6.29', [], AS_OF);
    await limited.expectCount(BASE, '6.25', [], AS_OF, '2026-10');
    const report = await limited.report('outflow', AS_OF);
    expect(report.hasDataPermission).toBe(false);
    expect(table(report, 'reasons')).toMatchObject({ rows: [], summary: { cells: { count: 0 } } });
  });

  it('AC-HA-13b-11：两个授权项默认给人事模块预置管理员看全部（DEC-415），人事专员只有对象查看权', () => {
    const profile = (code: string) => STANDARD_PROFILES.find((item) => item.code === code)!;
    const seeAll = (code: string) => presetSeeAllTargets(profile(code)).map((target) => target.targetCode);
    for (const object of [HR_MOVEMENT_OBJECT, HR_MOVEMENT_REPORT_OBJECT]) {
      for (const code of ['standard_org_system_admin', 'standard_hr_admin', 'standard_hr_specialist'])
        expect(
          profile(code).objects.map((item) => item.objectCode),
          `${code} ${object}`,
        ).toContain(object);
      expect(seeAll('standard_org_system_admin')).toContain(object);
      expect(seeAll('standard_hr_admin')).toContain(object);
      expect(seeAll('standard_hr_specialist')).not.toContain(object);
    }
  });
});
