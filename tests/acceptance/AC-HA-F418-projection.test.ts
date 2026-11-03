/** DEC-791①：预增 / 预减计有效业务笔数；真实 HTTP 写入与 B54 / 3.1.36 读取。 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { movementClient, movementWorld, type MovementWorld } from './AC-HA-13b-support.js';
import { managementScope, restrictedAuthorizer } from './AC-HA-13a-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const DAY = '2026-10-06';

describe('AC-HA-F418 编制业务投影', () => {
  let w: MovementWorld;
  beforeAll(async () => {
    w = await movementWorld(database().db);
  }, 600_000);
  const name = (value: string) => `${value}-${uniqueSuffix()}`;
  async function setup(extra: Record<string, unknown> = {}) {
    const A = await w.org(name('投影甲'));
    const B = await w.org(name('投影乙'));
    const response = await w.call('POST', '/api/tenant/establishment/schemes', {
      ifMatch: 0,
      body: {
        name: name('投影方案'),
        periodType: 'annual',
        maintenanceMode: 'local',
        startDate: '2026-01-01',
        ...extra,
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const scheme = (await response.json()) as { id: string };
    async function capacity(orgId: string, periodStart = '2026-01-01', localCapacity = 10) {
      const response = await w.call('POST', '/api/tenant/establishment/capacities', {
        ifMatch: 0,
        body: { orgId, schemeId: scheme.id, periodStart, localCapacity, strictControl: false },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string };
    }
    const a = await capacity(A.id);
    const b = await capacity(B.id);
    return { A, B, a, b, capacity };
  }
  async function cells(id: string, client = movementClient(w.db, w.who), day = DAY) {
    const report = await client.report('establishment', `asOf=${day}`);
    return report.tables![0]!.rows.find((row) => row.key === id)!.cells;
  }
  async function both(id: string, expected: Record<string, number | null>) {
    expect(await cells(id), 'B54 预增预减与公式').toMatchObject(expected);
    const { actual, ...columns } = expected;
    const group = await movementClient(w.db, w.who).group('3.1.36', `asOf=${DAY}`, id);
    expect(group, '3.1.36 与 B54 同源').toMatchObject({
      ...columns,
      ...(actual === undefined ? {} : { count: actual }),
    });
  }

  it('AC-HA-F418-01 A→B→A：同一员工的两笔未来业务各算一次', async () => {
    const s = await setup();
    const p = await w.hire(name('往返'), '2026-02-01', s.A);
    await w.transfer(p.id, '2026-10-15', s.B);
    await w.transfer(p.id, '2026-11-15', s.A);
    await both(s.a.id, { actual: 1, pendingIn: 1, pendingOut: 1, vacancy: 9, executionRate: 0.1 });
    await both(s.b.id, { actual: 0, pendingIn: 1, pendingOut: 1, vacancy: 10, executionRate: 0 });
  });

  it('AC-HA-F418-02 调入 2 人、调出 2 人，两列各 2', async () => {
    const s = await setup();
    for (const [from, to] of [
      [s.A, s.B],
      [s.B, s.A],
    ]) {
      for (let i = 0; i < 2; i++) {
        const p = await w.hire(name('双向'), '2026-02-01', from!);
        await w.transfer(p.id, '2026-10-15', to!);
      }
    }
    await both(s.a.id, { actual: 2, pendingIn: 2, pendingOut: 2, vacancy: 8, executionRate: 0.2 });
  });

  it('AC-HA-F418-03 同一单据的载荷 / 快照与重复读取不重复计数', async () => {
    const s = await setup();
    const p = await w.hire(name('单据去重'), '2026-02-01', s.A);
    await w.transfer(p.id, '2026-10-15', s.B);
    for (let i = 0; i < 2; i++) await both(s.b.id, { pendingIn: 1, pendingOut: 0 });
  });

  it('AC-HA-F418-04 跨周期只归生效所在周期，周期末与下一周期首日不串期', async () => {
    const s = await setup();
    const p = await w.hire(name('跨期'), '2026-02-01', s.A);
    await w.transfer(p.id, '2026-12-31', s.B);
    await w.transfer(p.id, '2027-01-01', s.A);
    await both(s.a.id, { pendingIn: 0, pendingOut: 1 });
    await both(s.b.id, { pendingIn: 1, pendingOut: 0 });
  });

  it('AC-HA-F418-05 驳回 / 撤回业务退出投影', async () => {
    const s = await setup();
    for (const action of ['reject', 'withdraw'] as const) {
      const p = await w.hire(name(action), '2026-02-01', s.A);
      const application = await w.x.apply(p.id, '2026-10-15', { departmentId: s.B.id });
      if (action === 'reject') await w.x.rejectInReview(application.id);
      else {
        const business = await w.x.business(application.id);
        const response = await w.x.session.request('POST', `/businesses/${application.id}/withdraw`, {
          ifMatch: business.revision,
          body: {},
        });
        expect(response.status, await response.clone().text()).toBe(200);
      }
    }
    await both(s.a.id, { pendingIn: 0, pendingOut: 0 });
    await both(s.b.id, { pendingIn: 0, pendingOut: 0 });
  });

  it('AC-HA-F418-06 已确认未生效离职计预减，实有在最后工作日前仍保留', async () => {
    const s = await setup();
    const p = await w.hire(name('离职预减'), '2026-02-01', s.A);
    await w.x.directLeave('2026-10-20', undefined, p.id);
    await both(s.a.id, { actual: 1, pendingIn: 0, pendingOut: 1, vacancy: 10, executionRate: 0 });
  });

  it('AC-HA-F418-07 未来改挂后的组织窗口计入上级预增，同一业务跨两段只计一次', async () => {
    const s = await setup();
    const child = await w.org(name('未来改挂'));
    const p = await w.hire(name('窗口投影'), '2026-02-01', s.B);
    await w.transfer(p.id, '2026-10-15', child);
    const moved = await w.call('PATCH', `/api/tenant/org/organizations/${child.id}`, {
      ifMatch: child.revision,
      body: { effectiveDate: '2026-10-20', addEmployment: false, parents: { admin: { parentId: s.A.id } } },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    await both(s.a.id, { actual: 0, pendingIn: 1, pendingOut: 0, vacancy: 9, executionRate: 0.1 });
  });

  it('AC-HA-F418-08 零编制不除零，缺编可为负，空集两列为零', async () => {
    const s = await setup();
    const Z = await w.org(name('零编制'));
    const z = await s.capacity(Z.id, '2026-01-01', 0);
    await both(z.id, { actual: 0, pendingIn: 0, pendingOut: 0, vacancy: 0, executionRate: null });
    await w.hire(name('超编'), '2026-02-01', Z);
    await both(z.id, { actual: 1, pendingIn: 0, pendingOut: 0, vacancy: -1, executionRate: null });
  });

  it('AC-HA-F418-09 可见上级编制不授予范围外员工可见性', async () => {
    const s = await setup();
    const hidden = await w.org(name('隐藏子部门'), s.A);
    const p = await w.hire(name('隐藏员工'), '2026-02-01', hidden);
    await w.transfer(p.id, '2026-10-15', s.B);
    const scoped = movementClient(w.db, w.who, restrictedAuthorizer({ scope: managementScope(w.tenantId, [s.A.id]) }));
    expect(await cells(s.a.id, scoped)).toMatchObject({ actual: 0, pendingIn: 0, pendingOut: 0, vacancy: 10 });
  });
  it('AC-HA-F418-10 复用占编范围：不匹配人员条件的未来调动不计', async () => {
    const s = await setup({ occupancyRanges: [{ employmentType: 'intern' }] });
    const p = await w.hire(name('非占编人员'), '2026-02-01', s.A);
    await w.transfer(p.id, '2026-10-15', s.B);
    await both(s.a.id, { actual: 1, pendingIn: 0, pendingOut: 0 });
    await both(s.b.id, { actual: 0, pendingIn: 0, pendingOut: 0 });
  });

  it('AC-HA-F418-11 调入批准才占、调出提交即释放，两列各自服从现有时机', async () => {
    const s = await setup();
    const p = await w.hire(name('时机'), '2026-02-01', s.A);
    const settings = await w.call('PUT', '/api/tenant/establishment/settings', {
      ifMatch: 0,
      body: { transferIn: 'approved', transferOut: 'submitted', effectiveDate: DAY },
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    const application = await w.x.apply(p.id, '2026-10-15', { departmentId: s.B.id });
    await both(s.a.id, { pendingOut: 1 });
    await both(s.b.id, { pendingIn: 0 });
    await w.x.approveInReview(application.id);
    await both(s.b.id, { pendingIn: 1 });
  });
});
