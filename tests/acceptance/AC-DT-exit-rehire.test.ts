/**
 * R2-T09b DEC-863① 退休同时返聘豁免（规格 `30` RT-R3：“退休同时返聘…账号不关闭，未转交的管理角色保留”）：
 * 退休且同时返聘的人，DT-R4 创建时强校验与 DT-R5 落地清空都不适用——负责人 / 直接上级身份保留、不写清空记录、
 * 不进检查离职退休人员列表；离职、不返聘的退休、实习结束仍按原规则拦截 / 清空。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dutyExitWorld, TODAY } from './AC-DT-exit-support.js';
import { withRehire } from './AC-RT-rehire-support.js';

const database = useTestDb();
const world = async (label: string) =>
  withRehire(database().db, await dutyExitWorld(database().db, label, TODAY), TODAY);
const EFFECTIVE = '2026-10-21';

describe('RT-R3 / DT-R4 退休同时返聘不被强校验拦截', () => {
  it('直接退休同时返聘：持有未转交的负责人 / 直接上级身份也能直接生效，职责与账号原样保留', async () => {
    const x = await world('rehire-direct');
    const org = await x.headedOrg('合成负责人组织');
    const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
    const accounts = await x.accountLinks();

    const created = await x.createdRehire(x.rehireBody('2026-10-04', 'direct'));

    expect(created.status).toBe('effective');
    expect(await x.headOf(org.id)).toBe(x.employee.id);
    expect(await x.managerOf(subordinate.id, '2026-10-08')).toBe(x.employee.id);
    expect(await x.accountLinks()).toEqual(accounts);
    expect(await x.exitRecords()).toEqual([]);
  });

  it('对照：不返聘的直接退休仍被 DT-R4 拦下（409，整单不留痕）', async () => {
    const x = await world('rehire-contrast-direct');
    await x.headedOrg('合成负责人组织');
    const before = await x.writes();
    await x.expectRejected(await x.tryDirect('retirement', '2026-10-04'));
    expect(await x.writes()).toEqual(before);
  });
});

describe('RT-R3 / DT-R5 退休同时返聘落地不清空', () => {
  it('申请退休同时返聘：落地后负责人 / 上级保留，无清空记录，也不在检查离职退休人员列表里', async () => {
    const x = await world('rehire-apply');
    const org = await x.headedOrg('合成负责人组织');
    const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
    const draft = await x.createdRehire(x.rehireBody('2026-10-20', 'application'));
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    await x.approve(draft, `${TODAY}T02:00:00Z`);

    expect(await x.activate(draft.id, EFFECTIVE)).toMatchObject({ outcome: 'effective' });

    expect(await x.headOf(org.id)).toBe(x.employee.id);
    // 组织建立时的首个版本本来就没有负责人；清空会在生效日起另写一个空负责人版本
    const versions = await x.orgVersions(org.id);
    expect(versions.filter((row) => row.start >= EFFECTIVE).map((row) => row.head)).not.toContain(null);
    expect(versions.at(-1)?.head).toBe(x.employee.id);
    expect(await x.managerOf(subordinate.id, EFFECTIVE)).toBe(x.employee.id);
    expect(await x.exitRecords()).toEqual([]);
    x.setNow(`${EFFECTIVE}T02:00:00Z`);
    expect((await x.departed()).items).toEqual([]);
  });

  it('退休当天（E′）仍持有职责，也不进检查离职退休人员列表', async () => {
    const x = await world('rehire-on-day');
    await x.headedOrg('合成负责人组织');
    await x.createdRehire(x.rehireBody('2026-10-04', 'direct'));
    // 直接退休当场生效：E′ = 今天，退休记录只覆盖这一天
    expect((await x.departed()).items).toEqual([]);
  });

  it('对照：同样的申请退休但不返聘，落地被清空并进检查列表', async () => {
    const x = await world('rehire-contrast-apply');
    const org = await x.headedOrg('合成负责人组织');
    const exit = await x.approvedApplication('retirement', '2026-10-20', TODAY);
    await x.activate(exit.id, EFFECTIVE);
    expect((await x.orgVersions(org.id)).at(-1)).toEqual({ start: EFFECTIVE, head: null });
    x.setNow(`${EFFECTIVE}T02:00:00Z`);
    expect((await x.departed()).items).toEqual([expect.objectContaining({ kind: 'retirement', dutyCount: 1 })]);
  });
});
