/**
 * AC-HA-06（35 §2.1b，DEC-763③，F-467）团队人事看板：按负责部门 + 汇报关系取数，和人事看板（2.1）是两张不同的看板。
 * 固定造数（租户今天 = 2026-10-01，期望一律手写 ID 集合与数字）：
 *   负责人 L（在“另一部门”，负责“负责部门”）；甲在负责部门、乙在其子组（部门内）；丙是 L 的直线下属（部门外），
 *   丁是丙的直线下属（隔级）；戊只是 L 的虚线下属、己与 L 无关、庚在负责部门但已离职——这三人都不在团队范围内。
 *   甲同时是 L 的直线下属（部门内 + 汇报链两条路径命中，只算一次）。
 */
import { sql } from '@italent/db';
import { HR_STRUCTURE_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { orgVersion } from './AC-APV-F318c-support.js';
import {
  boardClient,
  ids,
  restrictedAuthorizer,
  STRUCTURE_BASE,
  structureWorld,
  type StructureWorld,
} from './AC-HA-13a-support.js';

const TEAM_BASE = '/api/tenant/analytics/team-dashboard';
const AS_OF = 'asOf=2026-10-01';
const database = useTestDb();

async function buildWorld() {
  const w = await structureWorld(database().db, 'ha06-team');
  const led = await w.org('负责部门');
  const ledChild = await w.org('负责部门子组', led);
  const other = await w.org('其他部门');
  const third = await w.org('另一部门');
  const hire = (name: string, date: string, department: { id: string }, fields: Record<string, unknown> = {}) =>
    w.hire(name, { date, department, fields });
  const leader = await hire('负责人', '2015-01-01', third);
  const asLeader = { directManagerId: leader.id };
  const p = {
    leader,
    a: await hire('甲', '2020-01-01', led, asLeader),
    b: await hire('乙', '2026-08-01', ledChild),
    c: await hire('丙', '2024-03-01', other, asLeader),
    e: await hire('戊', '2024-01-01', other, { dottedManagerId: leader.id }),
    f: await hire('己', '2021-01-01', other),
    g: await hire('庚', '2022-01-01', led),
  };
  const d = await hire('丁', '2025-06-01', third, { directManagerId: p.c.id });
  await orgVersion({ db: w.db, tenant: { id: w.tenantId } }, led.id, { personInChargeId: leader.id });
  const leave = await w.session.business(
    p.g.id,
    { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-15', fields: {} },
    (await w.session.getEmployee(p.g.id)).revision,
  );
  expect(leave.status).toBe('effective');
  return { w, led, ledChild, other, third, p: { ...p, d } };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

/** 入职时自动建的账号（DEC-140）经 permission_user_person_links 绑定到人员档案。 */
async function userOf(w: StructureWorld, employeeId: string) {
  const rows = await w.sqlRows<{ userId: string }>(
    sql`SELECT user_id::text AS "userId" FROM permission_user_person_links
      WHERE tenant_id=${w.tenantId} AND employee_id=${employeeId}::uuid`,
  );
  if (!rows[0]) throw new Error(`人员 ${employeeId} 没有绑定账号`);
  return rows[0].userId;
}

describe('AC-HA-06 团队人事看板', () => {
  let x: World;
  let lead: ReturnType<typeof boardClient>;
  beforeAll(async () => {
    x = await buildWorld();
    lead = boardClient(x.w.db, { tenant: x.w.tenantId, user: await userOf(x.w, x.p.leader.id) });
  }, 300_000);

  it('① 负责人只看到本人 + 负责部门内 + 汇报链（含隔级）的在职员工，数字 = 明细；虚线下属 / 无关人员 / 离职人员不在内', async () => {
    const team = ids(x.p.leader, x.p.a, x.p.b, x.p.c, x.p.d);
    expect((await lead.board(TEAM_BASE, AS_OF)).hasDataPermission).toBe(true);
    await lead.expectCount(TEAM_BASE, '6.01', team, AS_OF);
    await lead.expectCount(TEAM_BASE, '6.03', team, AS_OF); // 平均值类按样本数核对
    const segments: [string, { id: string }][] = [
      ['10yplus', x.p.leader],
      ['5to10y', x.p.a],
      ['under6m', x.p.b],
      ['2to5y', x.p.c],
      ['1to2y', x.p.d],
    ];
    for (const [group, person] of segments) await lead.expectCount(TEAM_BASE, '6.08', ids(person), AS_OF, group);
    const average = await lead.component(TEAM_BASE, '6.03', AS_OF);
    expect(average.value).toBe(4.5); // 手算：(11.7 + 6.7 + 0.1 + 2.5 + 1.3) / 5，司龄 = 天数 / 365 向下取 1 位
    const shown = (await lead.detail(TEAM_BASE, '6.01', AS_OF)).ids;
    for (const outsider of [x.p.e, x.p.f, x.p.g]) expect(shown).not.toContain(outsider.id);
  });

  it('① 只给 6.01 / 6.03 / 6.08 三项，不多给别的指标；别的编码明细 404', async () => {
    const codes = (await lead.board(TEAM_BASE, AS_OF)).components.map((item) => item.code);
    expect(codes).toEqual(['6.01', '6.03', '6.08']);
    expect((await lead.get(`${TEAM_BASE}/components/6.02?${AS_OF}`)).status).toBe(404);
  });

  it('① 部门筛选只在团队范围内再收窄：负责部门含子组 → 甲乙；其他部门 → 只有丙（戊、己在该部门但不在范围）', async () => {
    await lead.expectCount(TEAM_BASE, '6.01', ids(x.p.a, x.p.b), `${AS_OF}&departmentId=${x.led.id}`);
    await lead.expectCount(TEAM_BASE, '6.01', ids(x.p.c), `${AS_OF}&departmentId=${x.other.id}`);
  });

  it('② 没有下属也不负责部门的员工直接调接口：200，只有本人', async () => {
    const lonely = boardClient(x.w.db, { tenant: x.w.tenantId, user: await userOf(x.w, x.p.f.id) });
    await lonely.expectCount(TEAM_BASE, '6.01', ids(x.p.f), AS_OF);
    expect((await lonely.board(TEAM_BASE, AS_OF)).hasDataPermission).toBe(true);
  });

  it('③ A1 直链回归：没有任何看板授权 / 没有菜单的普通员工直接访问，也只得本人', async () => {
    const nothing = boardClient(
      x.w.db,
      { tenant: x.w.tenantId, user: await userOf(x.w, x.p.f.id) },
      restrictedAuthorizer({ deny: HR_STRUCTURE_OBJECT, scope: { all: false } as never }),
    );
    await nothing.expectCount(TEAM_BASE, '6.01', ids(x.p.f), AS_OF);
  });

  it('④ 同时有看全部范围的负责人，团队看板不按角色范围放大（人事看板口径的人数更多）', async () => {
    const user = await userOf(x.w, x.p.leader.id);
    const admin = boardClient(x.w.db, { tenant: x.w.tenantId, user }, restrictedAuthorizer({}));
    await admin.expectCount(TEAM_BASE, '6.01', ids(x.p.leader, x.p.a, x.p.b, x.p.c, x.p.d), AS_OF);
    // 对照：同一个人在 B49 人员结构分析（按角色范围 = 全部）里看到全租户在职的 7 人
    await admin.expectCount(STRUCTURE_BASE, '6.01', ids(x.p.leader, x.p.a, x.p.b, x.p.c, x.p.d, x.p.e, x.p.f), AS_OF);
  });

  it('空范围 fail-closed：没有绑定人员档案的账号 → 全为 0、hasDataPermission = false，不退回全部', async () => {
    const unbound = boardClient(x.w.db, x.w.who); // 夹具的管理员账号没有绑定人员档案
    const board = await unbound.board(TEAM_BASE, AS_OF);
    expect(board.hasDataPermission).toBe(false);
    await unbound.expectCount(TEAM_BASE, '6.01', [], AS_OF);
    expect(board.components.find((item) => item.code === '6.03')!.value).toBeNull();
  });

  it('跨租户：不是该租户成员 → 403；别的租户的负责人在自己租户只看到自己的团队（本人 + 直属下属）', async () => {
    const stranger = boardClient(x.w.db, { tenant: x.w.tenantId, user: (await other(x)).leaderUser });
    expect((await stranger.get(`${TEAM_BASE}?${AS_OF}`)).status).toBe(403);
    const mine = boardClient(x.w.db, { tenant: (await other(x)).tenantId, user: (await other(x)).leaderUser });
    await mine.expectCount(TEAM_BASE, '6.01', (await other(x)).team, AS_OF);
  });
});

let otherWorld: Promise<{ tenantId: string; leaderUser: string; team: string[] }> | undefined;
function other(x: World) {
  otherWorld ??= (async () => {
    const w = await structureWorld(x.w.db, 'ha06-other');
    const dept = await w.org('别租户部门');
    const leader = await w.hire('别租户负责人', { date: '2020-01-01', department: dept });
    const report = await w.hire('别租户员工', {
      date: '2020-01-01',
      department: dept,
      fields: { directManagerId: leader.id },
    });
    return { tenantId: w.tenantId, leaderUser: await userOf(w, leader.id), team: ids(leader, report) };
  })();
  return otherWorld;
}

/** P2-1：离职的中间经理只作穿越，不进结果；仍指向他的在职下属还在上级的汇报链里。 */
describe('AC-HA-06 汇报链穿过离职的中间经理', () => {
  it('A → B（已离职）→ C（在职）：概览三项与 6.01 明细包含 C、不包含 B', async () => {
    const w = await structureWorld(database().db, 'ha06-chain');
    const dept = await w.org('链路部门');
    const hire = (name: string, date: string, fields: Record<string, unknown> = {}) =>
      w.hire(name, { date, department: dept, fields });
    const a = await hire('链顶', '2015-01-01');
    const b = await hire('中间经理', '2021-01-01', { directManagerId: a.id });
    const c = await hire('隔级下属', '2024-03-01', { directManagerId: b.id });
    const leave = await w.session.business(
      b.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-15', fields: {} },
      (await w.session.getEmployee(b.id)).revision,
    );
    expect(leave.status).toBe('effective');
    const top = boardClient(w.db, { tenant: w.tenantId, user: await userOf(w, a.id) });
    // 链顶不负责任何部门：能看到 C 只可能是沿 B 的汇报线穿过去的
    await top.expectCount(TEAM_BASE, '6.01', ids(a, c), AS_OF);
    await top.expectCount(TEAM_BASE, '6.03', ids(a, c), AS_OF);
    await top.expectCount(TEAM_BASE, '6.08', ids(a), AS_OF, '10yplus');
    await top.expectCount(TEAM_BASE, '6.08', ids(c), AS_OF, '2to5y');
    expect((await top.detail(TEAM_BASE, '6.01', AS_OF)).ids).not.toContain(b.id);
  }, 300_000);
});
