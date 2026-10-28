/**
 * F-265 / F-266（#441 R1 后补-权限，DEC-654 批 4）：
 * F-265 退休生效重试 activation/retry 的命令内复核按退休权限校验（Employment.Retire），不再被按离职（Dimission）口径拒绝；
 * F-266 退休预览的预计退休日期 P 与退休类型按字段查看权裁剪（同退休详情 / 列表的路径表），预览其余字段不受影响。
 * 同一文件在 PGlite 与真 PostgreSQL（设了 TEST_DATABASE_URL，普通角色）下各跑一遍。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementWorld(database().db, label, TODAY);

/** 退休单生效失败（顺延区间内有未落地调动）→ 删除阻塞后停在待重试。 */
async function failedRetirement(label: string) {
  const x = await world(label);
  const retire = await x.directRetire('2026-10-15');
  const blocker = await x.transferIn('draft', '2026-10-17');
  expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [retire.id] });
  x.setNow('2026-10-18T02:00:00Z');
  const removed = await x.session.request('DELETE', `/businesses/${blocker.id}`, { ifMatch: blocker.revision });
  expect(removed.status, await removed.clone().text()).toBe(200);
  return { x, retire };
}

describe('F-265 退休生效重试按退休权限校验', () => {
  it('只有退休权（无离职权）的 HR 重试退休业务 → 200，退休生效', async () => {
    const { x, retire } = await failedRetirement('f265-retire-only');
    const hr = x.restricted(denyButtons('Employment.Dimission'));
    const response = await hr('POST', `/businesses/${retire.id}/activation/retry`, {
      ifMatch: (await x.business(retire.id)).revision,
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await x.business(retire.id)).status).toBe('effective');
  });

  it('只有离职权（无退休权）的 HR 重试退休业务 → 403，业务不变', async () => {
    const { x, retire } = await failedRetirement('f265-leave-only');
    const hr = x.restricted(denyButtons('Employment.Retire'));
    const response = await hr('POST', `/businesses/${retire.id}/activation/retry`, {
      ifMatch: (await x.business(retire.id)).revision,
      body: {},
    });
    expect(response.status).toBe(403);
    expect((await x.business(retire.id)).status).not.toBe('effective');
  });

  it('回归：离职重试仍按离职权（Dimission）校验，无离职权 → 403', async () => {
    const x = await world('f265-leave-regression');
    const leave = await x.directLeave('2026-10-15');
    const blocker = await x.transferIn('draft', '2026-10-17');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [leave.id] });
    x.setNow('2026-10-18T02:00:00Z');
    const removed = await x.session.request('DELETE', `/businesses/${blocker.id}`, { ifMatch: blocker.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const send = async (hr: ReturnType<typeof x.restricted>) =>
      hr('POST', `/businesses/${leave.id}/activation/retry`, {
        ifMatch: (await x.business(leave.id)).revision,
        body: {},
      });
    expect((await send(x.restricted(denyButtons('Employment.Dimission')))).status).toBe(403);
    expect((await x.business(leave.id)).status).not.toBe('effective');
    const allowed = await send(x.restricted(denyButtons('Employment.Retire')));
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect((await x.business(leave.id)).status).toBe('effective');
  });
});

describe('F-266 退休预览按字段查看权裁剪 P 与退休类型', () => {
  const OTHER_FIELDS = ['id', 'employeeId', 'kind', 'effectiveDate', 'status', 'revision', 'lastWorkDate'];

  async function preview(x: Awaited<ReturnType<typeof world>>, fields: readonly string[]) {
    await x.setExpectedRetirement('2026-10-20');
    const hr = x.restricted(denyButtons(), undefined, fields);
    const response = await hr('POST', `/retirements/employees/${x.employee.id}/preview`, {
      body: { lastWorkDate: '2026-10-15' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it('无 P / 退休类型字段查看权 → 响应不含这两个字段，其余字段照常', async () => {
    const x = await world('f266-hidden');
    const body = await preview(x, OTHER_FIELDS);
    expect(body).not.toHaveProperty('expectedRetirementDate');
    expect(body).not.toHaveProperty('retireType');
    expect(body).toMatchObject({ lastWorkDate: '2026-10-15', effectiveDate: '2026-10-16', blockers: [], ack: null });
    expect(body.warnings).toBeInstanceOf(Array);
  });

  it('只有其中一项的查看权 → 只保留那一项', async () => {
    const x = await world('f266-one');
    const onlyType = await preview(x, [...OTHER_FIELDS, 'retireType']);
    expect(onlyType).toMatchObject({ retireType: 'early' });
    expect(onlyType).not.toHaveProperty('expectedRetirementDate');
  });

  it('有权时值正确', async () => {
    const x = await world('f266-visible');
    const body = await preview(x, [...OTHER_FIELDS, 'expectedRetirementDate', 'retireType']);
    expect(body).toMatchObject({
      expectedRetirementDate: '2026-10-20',
      retireType: 'early',
      lastWorkDate: '2026-10-15',
      effectiveDate: '2026-10-16',
    });
  });
});
