/**
 * F-480 第 5 轮（rf480_4 P2-1）+ 第 6 轮（DEC-832①）：撤销（删除）转正后，转正周期作为追加数据仍保留，
 * 但转正已不在时间轴上——这个人回到“未转正实习生”：入职 / 流入不计、首次入职日期为空；
 * 删除后改到更晚日期重新转正，则新转正日之前不计（0）、之后按新转正日计一次。
 * 走真实删除入口 DELETE /businesses/:id；期望值手写。
 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { dashboardClient } from './AC-HA-BE12b-support.js';
import { boardClient, ids } from './AC-HA-13a-support.js';
import { MOVEMENT_BASE, movementClient } from './AC-HA-13b-support.js';
import { internWorld } from './AC-EMP-F480-support.js';

const db = useTestDb();

async function revokedWorld(label: string) {
  const w = await internWorld(db().db, label);
  const { e } = await w.intern('2026-02-01');
  const reg = await w.regularize(e.id, { date: '2026-09-01' });
  const removed = await w.remove(await w.saved(reg.id));
  expect(removed.status, await removed.clone().text()).toBe(200);
  const dash = dashboardClient(db().db, w.who, { now: () => new Date('2026-10-01T01:00:00Z') });
  const board = boardClient(db().db, w.who);
  const firstEntryDate = async () => {
    const response = await w.api.request('GET', `/api/tenant/personnel/employees/${e.id}`, w.who);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { firstEntryDate: string | null }).firstEntryDate;
  };
  return { w, e, dash, board, firstEntryDate };
}

it('AC-EMP-F480-23：删除转正后回到未转正——看板入职数字与明细、流入数字 / 总数 / 明细 / 报表合计均为 0，首次入职日期为空', async () => {
  const x = await revokedWorld('revoke-restore');
  // 第 5 轮原期望：入职 / 流入各计实习开始日 1 次、首次入职日期 2026-02-01；DEC-832① 起整体翻为 0 / null
  await x.dash.expectIndicator('entriesThisYear', [], '2026-10-01');
  await x.dash.expectIndicator('entriesThisMonth', [], '2026-02-28');
  await x.board.expectCount(MOVEMENT_BASE, '6.26', [], 'asOf=2026-10-01', 'hire:2026-02');
  await x.board.expectCount(MOVEMENT_BASE, '6.26', [], 'asOf=2026-10-01', 'hire:2026-09'); // 已撤销的转正日不计
  const report = await movementClient(db().db, x.w.who).report('inflow', 'asOf=2026-10-01');
  expect(report.tables!.find((table) => table.key === 'inflow')!.summary.cells).toMatchObject({ total: 0 });
  expect(await x.firstEntryDate()).toBeNull();
});

it('AC-EMP-F480-24：删除后改到更晚日期重新转正——新转正日之前不计（0），之后按新转正日计一次', async () => {
  const x = await revokedWorld('revoke-redo');
  await x.w.regularize(x.e.id, { date: '2026-09-15' });
  // 追溯期末 09-10：新转正日未到（已撤销的 09-01 不得生效，实习开始日也不计）→ 0；原期望 [e]（按实习开始日）
  await x.dash.expectIndicator('entriesThisYear', [], '2026-09-10');
  await x.dash.expectIndicator('entriesThisMonth', [], '2026-09-10');
  // 期末 10-01：按新转正日 09-15 计一次
  await x.dash.expectIndicator('entriesThisYear', [x.e.id], '2026-10-01');
  await x.dash.expectIndicator('entriesThisMonth', [x.e.id], '2026-09-30');
  await x.board.expectCount(MOVEMENT_BASE, '6.26', ids(x.e), 'asOf=2026-10-01', 'hire:2026-09');
  await x.board.expectCount(MOVEMENT_BASE, '6.26', [], 'asOf=2026-10-01', 'hire:2026-02');
  expect(await x.firstEntryDate()).toBe('2026-09-15');
});
