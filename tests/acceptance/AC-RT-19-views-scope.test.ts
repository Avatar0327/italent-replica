/**
 * R2-T04 BE-5d1 / AC-RT-19：五视图与详情的范围与字段裁剪（设计 §10.2、§12.1；DEC-177）。
 * 范围外的员工 / 退休单不出现、不计入总数（分页前过滤）；字段按任职记录 / 人员对象的字段权裁剪，无权的键缺席。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const ASOF = '2026-10-15';

async function world(label: string) {
  const x = await retirementWorld(database().db, label, TODAY);
  const other = await x.otherUser();
  const asOther = x.asUser(other.id);

  /** 员工与任职业务都由 other 创建（使用用户维度的范围按创建者判断）。 */
  async function theirs(name: string, expected: string) {
    const created = await x.employeeAs(other.id, name);
    const employee = await x.session.getEmployee(created.id);
    const hire = await asOther('POST', `/employees/${created.id}/businesses`, {
      ifMatch: employee.revision,
      body: withLoginEmail(created.id, {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: x.from.id },
      }),
    });
    expect(hire.status, await hire.clone().text()).toBe(201);
    await x.setExpectedRetirement(expected, created.id);
    const draft = await asOther('POST', `/retirements/employees/${created.id}`, {
      ifMatch: (await x.session.getEmployee(created.id)).revision,
      body: { mode: 'application', lastWorkDate: '2026-10-25' },
    });
    expect(draft.status, await draft.clone().text()).toBe(201);
    return { employeeId: created.id, billId: ((await draft.json()) as { id: string }).id };
  }
  async function mine(name: string, expected: string) {
    const { employee } = await x.hired(name);
    await x.setExpectedRetirement(expected, employee.id);
    const draft = await x.createdRetire(employee.id, {
      kind: 'retirement',
      mode: 'application',
      lastWorkDate: '2026-10-25',
      fields: {},
    });
    return { employeeId: employee.id, billId: draft.id };
  }
  async function view(name: string, api = x.session.request, query = '') {
    const response = await api('GET', `/retirements?view=${name}&asOf=${ASOF}${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { items: { id?: string; employeeId: string }[]; total: number };
  }
  return { x, other, theirs, mine, view };
}

describe('AC-RT-19 视图范围（分页前过滤）', () => {
  it('范围外员工 / 退休单不出现、不计入总数；详情范围外 404；看全部的人两边都见', async () => {
    const w = await world('rt19-scope');
    const mine = await w.mine('本人创建', '2026-10-20');
    const theirs = await w.theirs('他人创建', '2026-10-21');
    const hr = w.x.restricted(denyButtons(), w.other.id);

    const upcoming = await w.view('upcoming', hr);
    expect(upcoming.items.map((item) => item.employeeId)).toEqual([theirs.employeeId]);
    expect(upcoming.total).toBe(1);
    const all = await w.view('all', hr, '&pageSize=1');
    expect(all.items.map((item) => item.id)).toEqual([theirs.billId]);
    expect(all.total).toBe(1);

    expect((await hr('GET', `/retirements/${theirs.billId}`)).status).toBe(200);
    const outside = await hr('GET', `/retirements/${mine.billId}`);
    expect(outside.status).toBe(404);
    expect(await outside.clone().text()).not.toContain('本人创建');

    const full = await w.view('upcoming');
    expect(full.items.map((item) => item.employeeId).sort()).toEqual([mine.employeeId, theirs.employeeId].sort());
    expect(full.total).toBe(2);
    expect((await w.view('all')).total).toBe(2);
  });

  it('范围为空 fail-closed：不在任何范围内的人五个视图都是空', async () => {
    const w = await world('rt19-empty');
    await w.mine('本人创建', '2026-10-20');
    const nobody = w.x.restricted(denyButtons(), '00000000-0000-4000-8000-000000000001');
    for (const name of ['upcoming', 'overdue', 'processing', 'completed', 'all'])
      expect(await w.view(name, nobody), name).toMatchObject({ items: [], total: 0 });
  });

  it('没有任职记录查看权 403', async () => {
    const w = await world('rt19-perm');
    const made = await w.mine('本人创建', '2026-10-20');
    const deny: Authorizer = (request) => request.action !== 'object.view';
    const none = w.x.restricted(deny);
    expect((await none('GET', `/retirements?view=all&asOf=${ASOF}`)).status).toBe(403);
    expect((await none('GET', `/retirements/${made.billId}`)).status).toBe(403);
  });
});

describe('AC-RT-19 字段裁剪', () => {
  it('无退休类型 / 是否同时返聘字段权 → 两键缺席；无预计退休日期字段权 → P 与到期天数缺席（不是 null）', async () => {
    const w = await world('rt19-fields');
    const made = await w.mine('裁剪员工', '2026-10-20');
    const base = [
      'id',
      'employeeId',
      'status',
      'revision',
      'lastWorkDate',
      'effectiveDate',
      'name',
      'code',
      'createdAt',
    ];
    const sighted = w.x.restricted(denyButtons(), undefined, [
      ...base,
      'retireType',
      'reEmployed',
      'expectedRetirementDate',
    ]);
    const blind = w.x.restricted(denyButtons(), undefined, base);

    const withFields = (await w.view('all', sighted)).items[0]!;
    expect(withFields).toMatchObject({ id: made.billId, reEmployed: false });
    expect(withFields).toHaveProperty('retireType');
    const trimmed = (await w.view('all', blind)).items[0]!;
    for (const key of ['retireType', 'reEmployed', 'expectedRetirementDate']) expect(trimmed).not.toHaveProperty(key);

    const person = (await w.view('upcoming', sighted)).items[0]!;
    expect(person).toMatchObject({
      employeeId: made.employeeId,
      expectedRetirementDate: '2026-10-20',
      daysToRetirement: 5,
    });
    const hidden = (await w.view('upcoming', blind)).items[0]!;
    for (const key of ['expectedRetirementDate', 'daysToRetirement']) expect(hidden).not.toHaveProperty(key);
  });
});
