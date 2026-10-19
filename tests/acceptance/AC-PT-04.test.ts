/**
 * AC-PT-04 / PB-46（docs/08_设计/R2-T05_兼职设计.md §6.2 PT-R5，§10）：员工主职在 A、HR 只管兼职部门 B、兼职在 B →
 * HR 在兼职管理（六视图 / 详情 / 员工页签）可见该兼职，却看不到这名员工的主职记录；只管主职部门 A 的 HR 则可见该员工的全部兼职
 * （DEC-177 两项并集：记录部门 = 兼职部门 ∪ 员工当前主职部门）；两处都管不到的 HR 什么都看不到。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { restricted } from './AC-PT-http-support.js';
import { viewsWorld } from './AC-PT-views-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

async function setup(label: string) {
  const w = await viewsWorld(database().db, label);
  const recordId = await w.seedPartTime({ startDate: '2026-09-01', endDate: '2026-12-31' });
  const requestId = await w.seedRequest({ requestType: 'add', startDate: '2026-10-15' });
  return { w, recordId, requestId };
}

describe('AC-PT-04 主职在 A、HR 只管兼职部门 B', () => {
  it('兼职管理可见该兼职：六视图、员工页签、详情', async () => {
    const { w, recordId, requestId } = await setup('pt04-visible');
    const asHrOfB = restricted({ scope: w.scopeOf(w.partTimeOrg.id) });
    const send = w.getAs(asHrOfB);
    for (const name of ['ongoing', 'all']) {
      const body = await w.view(name, '', send);
      expect([name, w.idsOf(body)]).toEqual([name, [recordId]]);
      expect(body.total).toBe(1);
      // 主职部门不在 HR 范围内：行里看不到主职部门
      expect(body.items[0]).not.toHaveProperty('primaryDepartmentId');
    }
    expect(w.idsOf(await w.view('in_approval', '', send))).toEqual([requestId]);
    const tab = await w.ok(await w.as(asHrOfB)('GET', `/employees/${w.employeeId}/part-times`));
    expect(tab.items.map((item) => item.id)).toEqual([recordId]);
    const detail = await w.ok(await w.as(asHrOfB)('GET', `/part-times/${recordId}`));
    expect(detail).toMatchObject({
      id: recordId,
      employeeId: w.employeeId,
      fields: { departmentId: w.partTimeOrg.id },
    });
  });

  it('却看不到这名员工的主职记录：员工 / 时间轴 / 主职详情 404；申请详情的主职分组为空', async () => {
    const { w, recordId, requestId } = await setup('pt04-primary-hidden');
    const send = w.as(restricted({ scope: w.scopeOf(w.partTimeOrg.id) }));
    expect((await send('GET', `/employees/${w.employeeId}/records`)).status).toBe(404);
    expect((await send('GET', `/employees/${w.employeeId}`)).status).toBe(404);
    const [primary] = await w.records(w.employeeId);
    expect((await send('GET', `/records/${primary!.id}`)).status).toBe(404);
    const request = await w.ok<{ primary: unknown }>(await send('GET', `/part-time-requests/${requestId}`));
    expect(request.primary).toBeNull();
    // 兼职详情仍可见
    expect((await send('GET', `/part-times/${recordId}`)).status).toBe(200);
  });

  it('只管主职部门 A：看得到该员工的全部兼职（含兼职部门不在范围的）与主职部门', async () => {
    const { w, recordId } = await setup('pt04-primary-side');
    const elsewhere = await w.org(`别处部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    await w.moveSnapshot(recordId, elsewhere.id);
    const send = w.getAs(restricted({ scope: w.scopeOf(w.primaryOrg.id) }));
    const body = await w.view('all', '', send);
    expect(w.idsOf(body)).toEqual([recordId]);
    expect(body.items[0]).toMatchObject({
      primaryDepartmentId: w.primaryOrg.id,
      fields: { departmentId: elsewhere.id },
    });
    expect(
      (await w.as(restricted({ scope: w.scopeOf(w.primaryOrg.id) }))('GET', `/part-times/${recordId}`)).status,
    ).toBe(200);
  });

  it('A、B 都管不到的 HR：视图为空，详情 404（与不存在同码）', async () => {
    const { w, recordId } = await setup('pt04-neither');
    const elsewhere = await w.org(`无关部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    const send = w.as(restricted({ scope: w.scopeOf(elsewhere.id) }));
    expect((await w.view('all', '', w.getAs(restricted({ scope: w.scopeOf(elsewhere.id) })))).total).toBe(0);
    expect((await send('GET', `/part-times/${recordId}`)).status).toBe(404);
    expect((await send('GET', `/part-times/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).status).toBe(404);
  });
});
