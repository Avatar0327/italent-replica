/**
 * F-480 第 6 轮（DEC-832①，用户定口径；取代第 4 轮的 DEC-830①）：实习生只在【转正日】计一次入职，
 * 实习开始日永远不算入职——未转正的在职实习生、实习期内没转正就离职的人始终不计入职，档案“首次入职日期”留空；
 * 转正后看板“入职”、人员流动“流入”按转正日计一次，首次入职日期取转正日；追溯查询期末早于转正日同样不计。
 * 租户今天 = 2026-10-01。期望值一律是手写的人员 ID 集合，不拿实现自己的谓词当参照。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { boardClient, ids, structureWorld } from './AC-HA-13a-support.js';
import { dashboardClient } from './AC-HA-BE12b-support.js';
import { MOVEMENT_BASE, movementClient } from './AC-HA-13b-support.js';
import { employeeJoins } from '../../apps/api/src/modules/personnel/employee-read.js';

const db = useTestDb();
const AS_OF = 'asOf=2026-10-01';

async function world() {
  const w = await structureWorld(db().db, 'dec830');
  const org = await w.org('合成转正计数部门');
  const person = async (name: string, hireDate: string) => {
    const e = await w.session.employee(name);
    const hire = await w.session.business(
      e.id,
      { kind: 'hire', mode: 'direct', effectiveDate: hireDate, fields: { employType: 'intern', departmentId: org.id } },
      e.revision,
    );
    return { e, hire };
  };
  const regularize = (p: Awaited<ReturnType<typeof person>>, date: string) =>
    w.session.business(
      p.e.id,
      { kind: 'intern_regularization', mode: 'direct', effectiveDate: date, fields: { departmentId: org.id } },
      p.hire.employeeRevision,
    );
  // 去年入职的实习生，今天（本月）转正
  const crossYear = await person('跨年转正', '2025-11-01');
  await regularize(crossYear, '2026-10-01');
  // 今年 2 月入职，9 月转正（同一年内两个日期）
  const sameYear = await person('同年转正', '2026-02-01');
  await regularize(sameYear, '2026-09-01');
  // 尚未转正的在职实习生
  const stillIntern = await person('未转正实习生', '2026-09-15');
  // 实习结束未转正就离职
  const leaver = await person('未转正离职', '2026-03-01');
  await w.session.business(
    leaver.e.id,
    { kind: 'leave', mode: 'direct', lastWorkDate: '2026-05-31' },
    (await w.session.getEmployee(leaver.e.id)).revision,
  );
  return { w, crossYear: crossYear.e, sameYear: sameYear.e, stillIntern: stillIntern.e, leaver: leaver.e };
}

describe('DEC-832①：实习生只在转正日计一次入职', () => {
  it('AC-EMP-F480-20：人事看板本年 / 本月入职——数字与明细同源，只在转正日计一次，未转正者（在职 / 离职）不计', async () => {
    const x = await world();
    const clock = () => new Date('2026-10-01T01:00:00Z');
    const d = dashboardClient(db().db, x.w.who, { now: clock });
    // 本年入职：跨年转正（转正日 10-01）、同年转正（只计 9-01 一次，不因 2-01 重复）；
    // 未转正在职实习生（9-15 入职）、未转正离职者（3-01 入职）不计（原期望含这两人）
    await d.expectIndicator('entriesThisYear', [x.crossYear.id, x.sameYear.id]);
    // 本月入职：只有 10-01 转正的人
    await d.expectIndicator('entriesThisMonth', [x.crossYear.id]);
    // 追溯口径：期末早于转正日的视图里转正还没发生，一律不计（原期望 [sameYear, leaver] / [sameYear]）
    await d.expectIndicator('entriesThisYear', [], '2026-08-31');
    await d.expectIndicator('entriesThisMonth', [], '2026-02-28');
    await d.expectIndicator('entriesThisYear', [x.sameYear.id], '2026-09-30');
  });

  it('AC-EMP-F480-21：人员流动流入——6.26 当月入职、流入报表合计与看板同源', async () => {
    const x = await world();
    const c = boardClient(db().db, x.w.who);
    await c.expectCount(MOVEMENT_BASE, '6.26', ids(x.crossYear), AS_OF, 'hire:2026-10');
    await c.expectCount(MOVEMENT_BASE, '6.26', ids(x.sameYear), AS_OF, 'hire:2026-09'); // 原含 stillIntern
    await c.expectCount(MOVEMENT_BASE, '6.26', [], AS_OF, 'hire:2026-03'); // 未转正离职者不计（原 ids(leaver)）
    await c.expectCount(MOVEMENT_BASE, '6.26', [], AS_OF, 'hire:2026-02'); // 同年转正者的实习开始日不计
    // 流入报表（按职务序列分行）：两人都无序列，合计各计一次（与看板同源；原合计 4）
    const report = await movementClient(db().db, x.w.who).report('inflow', AS_OF);
    const summary = report.tables!.find((item) => item.key === 'inflow')!.summary.cells;
    expect(summary).toMatchObject({ total: 2 });
  });

  it('AC-EMP-F480-22：档案首次入职日期——转正者取转正日；未转正实习生、未转正离职者为空', async () => {
    const x = await world();
    const expected = {
      [x.crossYear.id]: '2026-10-01',
      [x.sameYear.id]: '2026-09-01',
      [x.stillIntern.id]: null, // 原为实习开始日 2026-09-15
      [x.leaver.id]: null, // 原为实习开始日 2026-03-01
    };
    for (const [id, firstEntryDate] of Object.entries(expected)) {
      const response = await x.w.call('GET', `/api/tenant/personnel/employees/${id}`);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json(), id).toMatchObject({ firstEntryDate });
    }
  });

  it('AC-EMP-F480-25：追溯查询——期末早于转正日时不计入职、首次入职日期为空；期末到转正日当天起才计', async () => {
    const x = await world();
    const clock = () => new Date('2026-10-01T01:00:00Z');
    const d = dashboardClient(db().db, x.w.who, { now: clock });
    // 跨年转正者转正日 10-01：期末 09-30 前后一天，本年 / 去年底口径都不计
    await d.expectIndicator('entriesThisYear', [x.sameYear.id], '2026-09-30');
    await d.expectIndicator('entriesThisYear', [x.crossYear.id, x.sameYear.id], '2026-10-01');
    const c = boardClient(db().db, x.w.who);
    await c.expectCount(MOVEMENT_BASE, '6.26', [], 'asOf=2026-09-30', 'hire:2026-10');
    await c.expectCount(MOVEMENT_BASE, '6.26', [], 'asOf=2026-08-31', 'hire:2026-09');
    // 首次入职日期按期末取：转正日之前为空，当天起取转正日
    const firstEntry = async (employeeId: string, asOf: string) => {
      const ctx = { now: new Date('2026-10-01T01:00:00Z'), timezone: 'Asia/Shanghai' } as never;
      const rows = await x.w.sqlRows<{ first: string | null }>(
        sql`SELECT cycles.first_entry_date::text AS first FROM employment_employees e ${employeeJoins(ctx, asOf)}
          WHERE e.tenant_id=${x.w.tenantId} AND e.id=${employeeId}::uuid`,
      );
      return rows[0]!.first;
    };
    expect(await firstEntry(x.crossYear.id, '2026-09-30')).toBeNull(); // 转正日 10-01 之前；原为实习开始日 2025-11-01
    expect(await firstEntry(x.crossYear.id, '2026-10-01')).toBe('2026-10-01');
    expect(await firstEntry(x.sameYear.id, '2026-08-31')).toBeNull(); // 原为实习开始日 2026-02-01
    expect(await firstEntry(x.sameYear.id, '2026-09-01')).toBe('2026-09-01');
    expect(await firstEntry(x.stillIntern.id, '2026-12-31')).toBeNull(); // 未转正者无论期末多晚都为空
  });
});
