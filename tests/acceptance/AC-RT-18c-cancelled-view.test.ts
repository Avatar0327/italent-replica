/**
 * R2-T04 F-277 / AC-RT-18c：退休视图 view=cancelled（撤销的退休记录，设计 §12.1 5d1 行、第 357 行）。
 * 形态与口径同离职撤销视图（#432）：行集合 = 存在撤销记录（exit_cancellations）的退休单，按撤销时间倒序，
 * 返回 cancellation{id, reason, case, stateBefore, revision, createdAt}；不按 asOf 过滤；权限链同五视图
 * （readPageContext → 分页前 DEC-177 范围过滤 → 字段裁剪）。固定夹具逐行写死期望。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';
import { retireBody } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';

interface Row {
  id: string;
  employeeId: string;
  status?: string;
  cancellation: Record<string, unknown>;
}

async function world(label: string) {
  const x = await retirementCancelWorld(database().db, label, TODAY);
  async function view(api = x.session.request, query = '') {
    const response = await api('GET', `/retirements?view=cancelled${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { items: Row[]; total: number; asOf: string };
  }
  return { x, view };
}

describe('AC-RT-18c view=cancelled 固定夹具', () => {
  it('撤销前不出现；撤销后只在 cancelled（按撤销时间倒序）并带撤销信息；离职的撤销记录不出现（kind 隔离）', async () => {
    const { x, view } = await world('rt18c-fixed');
    const second = await x.newcomer('第二人');
    const third = await x.newcomer('第三人');
    const fourth = await x.newcomer('第四人');
    const approved = await x.directRetire('2026-10-25');
    const process = await x.createdRetire(second.id, retireBody('2026-10-20', 'application'));
    const kept = await x.directRetire('2026-10-26', undefined, third.id);
    const leave = await x.directLeave('2026-10-27', undefined, fourth.id);

    expect((await view()).items).toEqual([]);

    await x.retireCancelled(approved.id, { reason: '录入有误' });
    await x.retireCancelled(process.id, { reason: '不办了' });
    await x.cancelled(leave.id, { reason: '离职撤销' });

    const page = await view();
    expect(page.total).toBe(2);
    // 后撤销的在前
    expect(page.items.map((item) => item.id)).toEqual([process.id, approved.id]);
    expect(page.items.map((item) => item.id)).not.toContain(kept.id);
    expect(page.items[0]).toMatchObject({
      id: process.id,
      employeeId: second.id,
      status: 'deleted',
      cancellation: { reason: '不办了', case: 'process_voided', stateBefore: 'draft', revision: 1 },
    });
    expect(page.items[1]).toMatchObject({
      id: approved.id,
      employeeId: x.employee.id,
      status: 'voided',
      cancellation: { reason: '录入有误', case: 'approved_voided', stateBefore: 'approved', revision: 1 },
    });
    expect(page.items[0]!.cancellation).toHaveProperty('id');
    expect(page.items[0]!.cancellation).toHaveProperty('createdAt');
    expect(page.items[0]).not.toHaveProperty('exitTypeCode');
    // 改撤销原因后视图读到新值
    const patched = await x.session.request('PATCH', `/retirements/cancellations/${page.items[1]!.cancellation.id}`, {
      ifMatch: 1,
      body: { reason: '更正' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await view()).items[1]!.cancellation).toMatchObject({ reason: '更正', revision: 2 });
    // 离职撤销视图仍只有离职的那一条
    const exits = await x.session.request('GET', '/exits?view=cancellations');
    expect(((await exits.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([leave.id]);
  });

  it('已撤销的退休不能 restore（409），撤销记录不可删，仍留在 cancelled；asOf 不过滤；分页 total 不变', async () => {
    const { x, view } = await world('rt18c-restore');
    const retire = await x.directRetire('2026-10-25');
    await x.retireCancelled(retire.id);
    const restore = await x.session.request('POST', `/retirements/${retire.id}/restore`, { ifMatch: 1, body: {} });
    expect(await x.reason(restore)).toMatchObject({ status: 409, reason: 'EXIT_RESTORE_NOT_SUPPORTED' });

    expect((await view()).items.map((item) => item.id)).toEqual([retire.id]);
    // 与五视图一致回显 asOf；cancelled 不按 asOf 过滤（#432 撤销视图无 asOf）
    const early = await view(x.session.request, '&asOf=2020-01-01');
    expect(early).toMatchObject({ total: 1, asOf: '2020-01-01' });
    const beyond = await view(x.session.request, '&pageSize=1&page=2');
    expect(beyond).toMatchObject({ items: [], total: 1 });
  });
});

describe('AC-RT-18c 范围与字段', () => {
  it('范围外的撤销单不出现、total 同口径；无查看权 403；范围为空 fail-closed', async () => {
    const { x, view } = await world('rt18c-scope');
    const other = await x.otherUser();
    const asOther = x.asUser(other.id);
    const created = await x.employeeAs(other.id, '他人创建');
    const employee = await x.session.getEmployee(created.id);
    const hire = await asOther('POST', `/employees/${created.id}/businesses`, {
      ifMatch: employee.revision,
      body: withLoginEmail(created.id, {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: x.other.id },
      }),
    });
    expect(hire.status, await hire.clone().text()).toBe(201);
    const draft = await asOther('POST', `/retirements/employees/${created.id}`, {
      ifMatch: (await x.session.getEmployee(created.id)).revision,
      body: { mode: 'application', lastWorkDate: '2026-10-25' },
    });
    expect(draft.status, await draft.clone().text()).toBe(201);
    const theirs = ((await draft.json()) as { id: string }).id;
    const mine = await x.directRetire('2026-10-25');
    await x.retireCancelled(theirs);
    await x.retireCancelled(mine.id);

    const hr = x.restricted(denyButtons(), other.id);
    const visible = await view(hr);
    expect(visible.items.map((item) => item.id)).toEqual([theirs]);
    expect(visible.total).toBe(1);
    expect((await view(hr, '&pageSize=1')).total).toBe(1);
    expect((await view()).total).toBe(2);

    const nobody = x.restricted(denyButtons(), '00000000-0000-4000-8000-000000000001');
    expect(await view(nobody)).toMatchObject({ items: [], total: 0 });
    const none = x.restricted((request) => request.action !== 'object.view');
    expect((await none('GET', '/retirements?view=cancelled')).status).toBe(403);
  });

  it('字段权裁剪：无状态 / 创建时间字段权 → cancellation.stateBefore / case / createdAt 缺席；无退休专有字段权 → 缺席', async () => {
    const { x, view } = await world('rt18c-fields');
    const retire = await x.directRetire('2026-10-25');
    await x.retireCancelled(retire.id, { reason: '裁剪' });
    const base = ['id', 'employeeId', 'revision', 'name', 'code'];
    const sighted = x.restricted(denyButtons(), undefined, [
      ...base,
      'status',
      'createdAt',
      'retireType',
      'reEmployed',
    ]);
    const blind = x.restricted(denyButtons(), undefined, base);

    const full = (await view(sighted)).items[0]!;
    expect(full).toMatchObject({
      id: retire.id,
      status: 'voided',
      reEmployed: false,
      cancellation: { reason: '裁剪', case: 'approved_voided', stateBefore: 'approved' },
    });
    expect(full.cancellation).toHaveProperty('createdAt');
    const trimmed = (await view(blind)).items[0]!;
    expect(trimmed).toMatchObject({ id: retire.id, cancellation: { reason: '裁剪', revision: 1 } });
    for (const key of ['status', 'reEmployed', 'retireType']) expect(trimmed).not.toHaveProperty(key);
    for (const key of ['stateBefore', 'case', 'createdAt']) expect(trimmed.cancellation).not.toHaveProperty(key);
  });
});
