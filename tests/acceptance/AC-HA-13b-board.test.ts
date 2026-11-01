/**
 * BE-13b / B50 人员流动分析看板（规格 35“补充：BE-13…”B50）：近 12 个月（2025-11～2026-10，asOf = 2026-10-06）。
 * - AC-HA-13b-01 离职按生效日（最后工作日 + 1）归月，最后工作日当天仍在职（1/31 → 1 月期末、2 月期初都在职，计 2 月离职）；
 * - AC-HA-13b-02 离职率 = 离职 ÷ ((期初 + 期末) ÷ 2)，分母为 0 返回 0；
 * - AC-HA-13b-03 入职一个月内离职 = 司龄 ≤ 0.083 年（30 天计入、31 天不计）；
 * - AC-HA-13b-04 调动只算业务类型“调动”：转正带调动、组织调整引起的调动不计；
 * - AC-HA-13b-05 外部人员不计；AC-HA-13b-06 编制执行率无数据源，返回 unavailable / null；
 * - 每个组件：数字 = 明细条数 = 手写期望集合。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { ids } from './AC-HA-13a-support.js';
import { MOVEMENT_BASE as BASE, movementClient, movementWorld, type MovementWorld } from './AC-HA-13b-support.js';

const database = useTestDb();
const AS_OF = 'asOf=2026-10-06';

describe('AC-HA-13b B50 人员流动分析看板', () => {
  let w: MovementWorld;
  let c: ReturnType<typeof movementClient>;
  beforeAll(async () => {
    w = await movementWorld(database().db);
    c = movementClient(w.db, w.who);
  }, 600_000);

  it('看板列出 9 个组件（近 12 个月），编制统计表无数据源（AC-HA-13b-06）', async () => {
    const board = await c.board(BASE, AS_OF);
    expect(board.asOf).toBe('2026-10-06');
    expect(board.hasDataPermission).toBe(true);
    expect(board.components.map((item) => item.code)).toEqual([
      '6.25',
      '6.26',
      '6.27',
      '6.28',
      '6.29',
      '6.30',
      '6.31',
      '6.32',
      '3.1.36',
    ]);
    const establishment = board.components.find((item) => item.code === '3.1.36')!;
    expect({ kind: establishment.kind, value: establishment.value, groups: establishment.groups }).toEqual({
      kind: 'unavailable',
      value: null,
      groups: null,
    });
    const months = (await c.groups('6.25', AS_OF)).map((group) => group.key);
    expect(months).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
  });

  it('AC-HA-13b-01：6.25 期末人数按日取时点；最后工作日 1/31 当天仍在职，2 月期末不在', async () => {
    const { p } = w;
    await c.expectCount(BASE, '6.25', ids(p.old, p.jan31, p.retired, p.reg, p.orgAdj), AS_OF, '2026-01');
    await c.expectCount(BASE, '6.25', ids(p.old, p.retired, p.reg, p.orgAdj, p.intern, p.hidden), AS_OF, '2026-02');
    // 本月期末 = asOf 当天
    await c.expectCount(BASE, '6.25', ids(p.old, p.base, p.oct1, p.intern, p.reg, p.orgAdj), AS_OF, '2026-10');
    // 部门筛选含下级（老员工 5/1 调入甲一组）
    await c.expectCount(
      BASE,
      '6.25',
      ids(p.old, p.oct1, p.reg, p.orgAdj),
      `${AS_OF}&departmentId=${w.A.id}`,
      '2026-10',
    );
  });

  it('AC-HA-13b-01 / 05：6.26 入离职按月，离职归生效日所在月；外部人员不计', async () => {
    const { p } = w;
    await c.expectCount(BASE, '6.26', ids(p.intern, p.hidden), AS_OF, 'hire:2026-02');
    await c.expectCount(BASE, '6.26', ids(p.m30, p.m31), AS_OF, 'hire:2026-03');
    await c.expectCount(BASE, '6.26', ids(p.oct1), AS_OF, 'hire:2026-10');
    await c.expectCount(BASE, '6.26', [], AS_OF, 'hire:2026-01'); // 外部人员离职者 1/5 入职，不计
    await c.expectCount(BASE, '6.26', [], AS_OF, 'exit:2026-01'); // 1/31 是最后工作日，不算 1 月离职
    await c.expectCount(BASE, '6.26', ids(p.jan31), AS_OF, 'exit:2026-02');
    await c.expectCount(BASE, '6.26', ids(p.m30, p.m31), AS_OF, 'exit:2026-04');
    await c.expectCount(BASE, '6.26', [], AS_OF, 'exit:2026-05'); // 外部人员 5/10 离职，不计
    await c.expectCount(BASE, '6.26', ids(p.retired), AS_OF, 'exit:2026-07'); // 含退休
    await c.expectCount(BASE, '6.26', ids(p.lastYear), AS_OF, 'exit:2025-11');
  });

  it('AC-HA-13b-04：6.27 调动只算业务类型“调动”（按异动类型），转正 / 组织调整不计', async () => {
    const { p } = w;
    await c.expectCount(BASE, '6.27', ids(p.old), AS_OF);
    await c.expectCount(BASE, '6.27', ids(p.old), AS_OF, 'cross_department');
    expect((await c.group('6.27', AS_OF, 'cross_department'))?.label).toBe('跨部门调动');
    // 调动前后都在筛选范围外 → 不计
    await c.expectCount(BASE, '6.27', [], `${AS_OF}&departmentId=${w.B.id}`);
  });

  it('AC-HA-13b-02：6.28 离职率 = 离职 ÷ ((期初 + 期末) ÷ 2)，期初含当天离职生效的人', async () => {
    const { p } = w;
    await c.expectCount(BASE, '6.28', ids(p.jan31), AS_OF, '2026-02');
    expect(await c.group('6.28', AS_OF, '2026-02')).toMatchObject({ opening: 6, closing: 6, count: 1, rate: 0.1667 });
    // 期初 ≠ 上月期末：10/1 入职的人进 10 月期初
    expect(await c.group('6.28', AS_OF, '2026-09')).toMatchObject({ opening: 6, closing: 5, count: 1, rate: 0.1818 });
    expect(await c.group('6.28', AS_OF, '2026-10')).toMatchObject({ opening: 6, closing: 6, count: 0, rate: 0 });
    // 分母为 0：空部门各月都是 0，不是 null / NaN
    const empty = await c.groups('6.28', `${AS_OF}&departmentId=${w.E.id}`);
    expect(empty).toHaveLength(12);
    for (const group of empty) expect(group).toMatchObject({ opening: 0, closing: 0, count: 0, rate: 0 });
  });

  it('6.29 / 6.30：离职类型 → 原因 / 去向（近 12 个月，含去年 11 月；退休归“退休”）', async () => {
    const { p, T, R, W } = w;
    const all = ids(p.lastYear, p.jan31, p.m30, p.m31, p.retired, p.hidden);
    await c.expectCount(BASE, '6.29', all, AS_OF);
    await c.expectCount(BASE, '6.29', ids(p.jan31, p.m30, p.hidden), AS_OF, T.vol);
    await c.expectCount(BASE, '6.29', ids(p.lastYear, p.m31), AS_OF, T.inv);
    await c.expectCount(BASE, '6.29', ids(p.retired), AS_OF, 'retirement');
    await c.expectCount(BASE, '6.29', ids(p.jan31), AS_OF, `${T.vol}|${R.pay}`);
    await c.expectCount(BASE, '6.29', ids(p.m30), AS_OF, `${T.vol}|${R.dev}`);
    await c.expectCount(BASE, '6.29', ids(p.hidden), AS_OF, `${T.vol}|none`);
    expect(await c.group('6.29', AS_OF, `${T.vol}|${R.pay}`)).toMatchObject({ label: '薪酬', parent: T.vol });
    expect(await c.group('6.29', AS_OF, T.vol)).toMatchObject({ label: '主动离职', parent: null });
    await c.expectCount(BASE, '6.30', all, AS_OF);
    await c.expectCount(BASE, '6.30', ids(p.jan31), AS_OF, `${T.vol}|${W.peer}`);
    await c.expectCount(BASE, '6.30', ids(p.m30, p.hidden), AS_OF, `${T.vol}|none`);
  });

  it('6.31：离职人员司龄 6 段（算到最后工作日）', async () => {
    const { p } = w;
    await c.expectCount(BASE, '6.31', ids(p.m30, p.m31), AS_OF, 'under6m');
    await c.expectCount(BASE, '6.31', ids(p.lastYear, p.jan31, p.hidden), AS_OF, '6mto1y');
    await c.expectCount(BASE, '6.31', ids(p.retired), AS_OF, '1to2y');
    await c.expectCount(BASE, '6.31', [], AS_OF, '2to5y');
  });

  it('AC-HA-13b-03：6.32 入职一个月内离职 = 司龄 ≤ 0.083 年（30 天计入、31 天不计），按部门占比', async () => {
    const { p } = w;
    await c.expectCount(BASE, '6.32', ids(p.m30), AS_OF);
    await c.expectCount(BASE, '6.32', ids(p.m30), AS_OF, w.A.id);
    expect(await c.group('6.32', AS_OF, w.A.id)).toMatchObject({ count: 1, ratio: 1 });
    await c.expectCount(BASE, '6.32', [], AS_OF, w.B.id); // 3/1 → 4/1 共 31 天，不计
  });

  it('asOf 不合法 → 400；未知组件 → 404', async () => {
    expect((await c.get(`${BASE}?asOf=2026-13-01`)).status).toBe(400);
    expect((await c.get(`${BASE}/components/9.99?${AS_OF}`)).status).toBe(404);
    expect((await c.get(`${BASE}/components/3.1.36?${AS_OF}`)).status).toBe(404);
  });
});
