/**
 * R2-T09a 职责转交菜单：指定日期到期执行的失败路径（第 2 轮返工 P2-3 / P2-4 / P3-6；F-408④，DEC-726）。
 * - 到期前组织已停用：该条记失败、不改角色、不自动重试，同批另一条合法职责仍成功；
 * - 迟到执行：接收人资格按执行当日（租户时区）判断，组织新版本启用日仍取转交日期；
 * - 失败形态：仍为未完成、带失败原因；重跑不重试；菜单覆盖设置后清掉失败原因，到期正常执行。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { tenantApi } from './support/tenant-api.js';
import { headItem, menuWorld, subordinateItem, type MenuWorld } from './AC-DT-menu-support.js';

const database = useTestDb();
const world = (label: string) => menuWorld(database().db, label);
const LATER = '2026-10-20';

/** 经组织接口在 effectiveDate 起停用组织（真实 PATCH，不直接改表）。 */
async function disableOrg(x: MenuWorld, orgId: string, effectiveDate: string) {
  const as = { user: x.session.user.id, tenant: x.session.tenant.id };
  const api = tenantApi(database().db, { clock: () => new Date('2026-10-06T02:00:00Z') });
  const current = await api.request('GET', `/api/tenant/org/organizations/${orgId}`, as);
  const { revision } = (await current.json()) as { revision: number };
  const response = await api.request('PATCH', `/api/tenant/org/organizations/${orgId}`, {
    ...as,
    ifMatch: revision,
    body: { effectiveDate, enabled: false },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('F-408 到期前组织已停用（DEC-726，第 2 轮 P2-3）', () => {
  it('该条记失败、不生成组织新版本、不自动重试；同批下属转交照常成功', async () => {
    const x = await world('due-disabled');
    const org = await x.session.org('合成空组织', { establishedOn: '2026-01-01' });
    await x.setHead(org.id, x.employee.id);
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [headItem(org.id, receiver.id), subordinateItem(subordinate.id, receiver.id)],
    });
    await disableOrg(x, org.id, '2026-10-10');
    const versions = await x.orgVersions(org.id);

    await x.runScheduler(`${LATER}T02:00:00Z`);
    const rows = (await x.records()).items;
    const head = rows.find((row) => row.dutyType === 1)!;
    expect(head).toMatchObject({ status: 0, transferTime: null });
    expect(head.failure).toMatchObject({ code: 'VALIDATION_FAILED', rule: 'TRANSFER_ORG_DISABLED' });
    expect(await x.orgVersions(org.id)).toEqual(versions);
    expect(rows.find((row) => row.dutyType === 2)).toMatchObject({ status: 1, failure: null });
    expect(await x.managerOf(subordinate.id, LATER)).toBe(receiver.id);

    await x.runScheduler(`${LATER}T03:00:00Z`);
    expect((await x.records()).items).toEqual(rows);
    expect(await x.ledger(head.id)).toMatchObject({ attempts: 1, status: 0 });
  });
});

describe('F-408 迟到执行按执行日校验接收人（DT-R6，第 2 轮 P2-4）', () => {
  it('接收人在转交日期之后、执行日之前离职 / 退休：该条失败；同批其他接收人照常成功、启用日仍取转交日期', async () => {
    const x = await world('due-late');
    await x.setHead(x.from.id, x.employee.id);
    const left = await x.subordinateOf(x.employee.id, '下属甲');
    const retired = await x.subordinateOf(x.employee.id, '下属乙');
    const leaver = await x.peer('离职接收人');
    const retiree = await x.peer('退休接收人');
    const steady = await x.peer('在职接收人');
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [
        subordinateItem(left.id, leaver.id),
        subordinateItem(retired.id, retiree.id),
        headItem(x.from.id, steady.id),
      ],
    });

    // 调度延迟到 10-22：两名接收人最后工作日 = 转交日期，10-21 起不在职。
    x.setNow('2026-10-22T02:00:00Z');
    await x.effectiveExit(leaver.id, LATER);
    await x.effectiveRetire(retiree.id, LATER);
    await x.runScheduler('2026-10-22T02:00:00Z');

    const rows = (await x.records()).items;
    const failed = rows.filter((row) => row.dutyType === 2);
    expect(failed.map((row) => [row.status, row.failure?.rule])).toEqual([
      [0, 'TRANSFER_PERSON_NOT_ELIGIBLE'],
      [0, 'TRANSFER_PERSON_NOT_ELIGIBLE'],
    ]);
    expect(await x.managerOf(left.id, '2026-10-22')).toBe(x.employee.id);
    expect(await x.managerOf(retired.id, '2026-10-22')).toBe(x.employee.id);

    expect(rows.find((row) => row.dutyType === 1)).toMatchObject({ status: 1, failure: null, transferDate: LATER });
    expect((await x.orgVersions(x.from.id)).at(-1)).toEqual({ start: LATER, head: steady.id });
  });
});

describe('F-408 到期失败的形态与恢复（DEC-052，第 2 轮 P3-6）', () => {
  it('失败：未完成、带原因、次数 1；重跑不重试；菜单覆盖后清掉失败，到期正常执行', async () => {
    const x = await world('due-failure');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    const other = await x.peer('新接收人');
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(subordinate.id, receiver.id)],
    });
    x.setNow('2026-10-17T02:00:00Z');
    await x.effectiveExit(receiver.id, '2026-10-15');

    await x.runScheduler(`${LATER}T02:00:00Z`);
    const [failed] = (await x.records('tab=pending')).items;
    expect(failed).toMatchObject({ status: 0, transferTime: null, receiverId: receiver.id });
    expect(failed!.failure).toMatchObject({ code: 'VALIDATION_FAILED', rule: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
    expect(await x.ledger(failed!.id)).toMatchObject({ attempts: 1, failure: 'VALIDATION_FAILED' });
    expect(await x.managerOf(subordinate.id, LATER)).toBe(x.employee.id);

    await x.runScheduler(`${LATER}T05:00:00Z`);
    expect(await x.ledger(failed!.id)).toMatchObject({ attempts: 1 });
    expect((await x.records('tab=pending')).items).toEqual([failed]);

    x.setNow(`${LATER}T06:00:00Z`);
    const pending = (await x.duties(x.employee.id)).items[0]!.pending!;
    expect(pending.recordId).toBe(failed!.id);
    const retry = await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: '2026-10-25',
      items: [subordinateItem(subordinate.id, other.id, pending.revision)],
    });
    expect(retry.records[0]).toMatchObject({ id: failed!.id, status: 0, failure: null, receiverId: other.id });

    await x.runScheduler('2026-10-25T02:00:00Z');
    expect((await x.records('tab=completed')).items.map((row) => [row.id, row.receiverId])).toEqual([
      [failed!.id, other.id],
    ]);
    expect(await x.managerOf(subordinate.id, '2026-10-25')).toBe(other.id);
  });
});
