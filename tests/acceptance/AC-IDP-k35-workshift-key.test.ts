/**
 * DEC-318 K-35 / D-063：轮岗判重键 = 员工 + 轮岗部门 + 职位 + 职务 + 起止时间（原站“轮岗部门 + 职位 + 职务 + 起止”，
 * 复刻另补“员工”，🟡）。职务（postId）是轮岗记录的字段，可空；空值参与判重（两条都不填职务按同一个键）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';
const span = { startDate: '2026-01-01', endDate: '2026-06-30' };

async function post(w: PlanWorld, name: string) {
  return (
    await w.ok<{ id: string }>(
      await w.http(w.hrUser, 'POST', '/api/tenant/job/posts', {
        ifMatch: 0,
        body: { name, code: randomUUID(), startDate: '2020-01-01' },
      }),
      201,
    )
  ).id;
}

describe('K-35：轮岗判重键含职务', () => {
  it('同员工、部门、职位、起止：职务不同可并存，职务相同 409；都不填职务也按同一个键', async () => {
    const w = await planWorld(testDb().db, 'idp-k35');
    const [a, b] = [await post(w, '职务甲'), await post(w, '职务乙')];
    const create = (extra: Record<string, unknown>) =>
      w.http(w.hrUser, 'POST', `${IDP}/work-shifts`, {
        ifMatch: 0,
        body: { employeeId: w.employee.employeeId, orgId: w.dept, ...span, ...extra },
      });
    const first = await w.ok<{ postId: string | null }>(await create({ postId: a }), 201);
    expect(first.postId).toBe(a);
    await w.ok(await create({ postId: b }), 201);
    expect(await errorOf(await create({ postId: a }))).toMatchObject({
      status: 409,
      reason: 'IDP_WORK_SHIFT_DUPLICATE',
    });
    await w.ok(await create({}), 201);
    expect(await errorOf(await create({}))).toMatchObject({ status: 409, reason: 'IDP_WORK_SHIFT_DUPLICATE' });
  });
});
