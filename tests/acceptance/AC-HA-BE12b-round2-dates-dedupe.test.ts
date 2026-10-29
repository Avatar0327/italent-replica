/**
 * BE-12b 返工第 1 轮（#475 审查 P2-1 / P2-3）：
 * P2-1 asOf 日期校验与运算边界：0000-01-01 等非法日期、超出可计算范围（9999-12-31 + 30 天）都是 400，不是 500；
 *      合法极值（0001-01-02、9999-12-01）两个接口都 200。
 * P2-3 按指标主体去重：年内离职后跨部门重聘的人，入职 / 离职指标只计一次（先按候选记录做范围过滤，再按主体 ID 去重），
 *      同部门重聘对照；范围里只看到其中一段记录的人也只计一次；明细分页的 ID 唯一。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { dayAt } from './AC-EXIT-activation-support.js';
import { gateWorld } from './AC-EXIT-gate-support.js';
import { dashboardClient, DASHBOARD_BASE, type DashboardClient } from './AC-HA-BE12b-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';

async function buildWorld() {
  const w = await gateWorld(database().db, 'ha-12b-r2', { today: TODAY });
  const { session } = w;
  async function person(name: string, hireDate: string, dept: { id: string }) {
    const employee = await session.employee(name);
    await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: hireDate,
        fields: { departmentId: dept.id, employType: 'internal' },
      },
      employee.revision,
    );
    return employee;
  }
  async function rehire(id: string, date: string, dept: { id: string }) {
    const employee = await session.getEmployee(id);
    await session.business(
      id,
      { kind: 'rehire', mode: 'direct', effectiveDate: date, fields: { departmentId: dept.id } },
      employee.revision,
    );
  }
  /** 一年内两段任职：2026-01-05 入职，03-31 离职，06-01 重聘，09-30 再离职。 */
  async function twoSpells(name: string, second: { id: string }) {
    const employee = await person(name, '2026-01-05', w.from);
    await w.effectiveExit(employee.id, '2026-03-31');
    await rehire(employee.id, '2026-06-01', second);
    await w.effectiveExit(employee.id, '2026-09-30');
    return employee;
  }
  const cross = await twoSpells('跨部门重聘', w.to);
  const same = await twoSpells('同部门重聘', w.from);
  const single = await person('只入职一次', '2026-02-01', w.from);
  return { w, cross, same, single };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

describe('BE-12b 返工 P2-1 asOf 校验与运算边界', () => {
  let board: DashboardClient;
  beforeAll(async () => {
    const x = await buildWorld();
    board = dashboardClient(
      database().db,
      { tenant: x.w.session.tenant.id, user: x.w.session.user.id },
      { now: () => dayAt(TODAY) },
    );
  }, 300_000);
  const paths = (asOf: string) => [
    `${DASHBOARD_BASE}?asOf=${asOf}`,
    `${DASHBOARD_BASE}/indicators/interns?asOf=${asOf}`,
  ];

  it.each(['0000-01-01', '0001-01-01', '9999-12-31', '9999-12-02', '2026-02-30', '10000-01-01'])(
    '非法或超出可计算范围的 asOf=%s：两个接口都是 400，不是 500',
    async (asOf) => {
      for (const path of paths(asOf)) expect((await board.get(path)).status, path).toBe(400);
    },
  );

  it.each(['0001-01-02', '9999-12-01'])('合法极值 asOf=%s：两个接口都是 200', async (asOf) => {
    for (const path of paths(asOf)) {
      const response = await board.get(path);
      expect(response.status, `${path} ${await response.clone().text()}`).toBe(200);
    }
  });
});

describe('BE-12b 返工 P2-3 按指标主体去重', () => {
  let x: World;
  let board: DashboardClient;
  beforeAll(async () => {
    x = await buildWorld();
    board = dashboardClient(
      database().db,
      { tenant: x.w.session.tenant.id, user: x.w.session.user.id },
      { now: () => dayAt(TODAY) },
    );
  }, 300_000);
  const scoped = (orgIds: string[]) => {
    const scope: ModuleScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      orgIds,
      terms: [
        {
          dimension: 'management',
          orgIds,
          personIds: [],
          personQuery: { kind: 'organization', tenantId: x.w.session.tenant.id, asOf: TODAY },
        },
      ],
    };
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => scope,
      authorize: async (request) => authorize(request),
      fields: async () => new Set(),
    });
    return dashboardClient(
      database().db,
      { tenant: x.w.session.tenant.id, user: x.w.session.user.id },
      { now: () => dayAt(TODAY), authorize },
    );
  };

  it('年内两次入职、两次离职的人（跨部门 / 同部门重聘）在入职、离职指标里各只计一次', async () => {
    const everyone = [x.cross.id, x.same.id, x.single.id];
    await board.expectIndicator('entriesThisYear', everyone);
    await board.expectIndicator('leavesThisYear', [x.cross.id, x.same.id]);
    // 本月（3 月 / 6 月）窗口里各只有一段记录，同样只计一次
    await board.expectIndicator('leavesThisMonth', [x.cross.id, x.same.id], '2026-03-31');
    await board.expectIndicator('entriesThisMonth', [x.cross.id, x.same.id], '2026-06-30');
  });

  it('范围先于去重：只管理其中一个部门时，各自按看到的记录计一次，不因另一段记录重复或丢失', async () => {
    // 部门 from：跨部门重聘者的首段、同部门重聘者的两段；部门 to：跨部门重聘者的第二段
    await scoped([x.w.from.id]).expectIndicator('entriesThisYear', [x.cross.id, x.same.id, x.single.id]);
    await scoped([x.w.to.id]).expectIndicator('entriesThisYear', [x.cross.id]);
    await scoped([x.w.to.id]).expectIndicator('leavesThisYear', [x.cross.id]);
  });

  it('明细分页：ID 唯一，切片拼起来等于全集', async () => {
    const all = (await board.detail('entriesThisYear')).ids;
    expect(new Set(all).size).toBe(all.length);
    const first = await board.page('entriesThisYear', undefined, '&page=1&pageSize=2');
    const second = await board.page('entriesThisYear', undefined, '&page=2&pageSize=2');
    const slice = [...first.items, ...second.items].map((item) => item.id);
    expect(first.total).toBe(3);
    expect(slice).toHaveLength(3);
    expect(new Set(slice).size).toBe(3);
  });
});
