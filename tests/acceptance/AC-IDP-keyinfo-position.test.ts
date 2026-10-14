/**
 * R3-T07 PR-B 第 2 轮 P2-8：轮岗职位也受管理单元限制（IDP-R21；PR-A K-35）。职位按其所属组织判断是否在操作人
 * IDP 范围内：新建 / 修改带范围外职位 404、记录不变；范围外职位的既有记录与范围外部门一样，直接读取、列表、计划详情都
 * 不可见（第 2 轮第 2 条的同一谓词）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const span = { startDate: '2026-01-01', endDate: '2026-06-30' };

async function positionIn(w: PlanWorld, orgId: string) {
  const post = await w.ok<{ id: string }>(
    await w.http(w.hrUser, 'POST', '/api/tenant/job/posts', {
      ifMatch: 0,
      body: { name: '合成职务', code: randomUUID(), startDate: '2020-01-01' },
    }),
    201,
  );
  const position = await w.ok<{ id: string }>(
    await w.http(w.hrUser, 'POST', '/api/tenant/job/positions', {
      ifMatch: 0,
      body: { name: '合成职位', code: randomUUID(), postId: post.id, orgId, startDate: '2020-01-01' },
    }),
    201,
  );
  return position.id;
}

describe('P2-8：轮岗职位的管理单元校验', () => {
  it('新建 / 修改带范围外职位 404；范围外职位的记录读取、列表、计划详情都不可见', async () => {
    const w = await planWorld(testDb().db, 'idp-ki-position');
    const pw = await permissionWorldOf(w);
    const otherOrg = await w.org('范围外部门');
    const inside = await positionIn(w, w.dept);
    const outside = await positionIn(w, otherOrg);
    const hr = await idpOperator(pw, { orgId: w.dept });
    const base = { employeeId: w.employee.employeeId, orgId: w.dept, ...span };

    const denied = await hr.request('POST', '/work-shifts', { ifMatch: 0, body: { ...base, positionId: outside } });
    expect(denied.status).toBe(404);
    const created = await w.ok<{ id: string; revision: number }>(
      await hr.request('POST', '/work-shifts', { ifMatch: 0, body: { ...base, positionId: inside } }),
      201,
    );
    const moved = await hr.request('PATCH', `/work-shifts/${created.id}`, {
      ifMatch: created.revision,
      body: { positionId: outside },
    });
    expect(moved.status).toBe(404);
    expect(await w.ok(await hr.request('GET', `/work-shifts/${created.id}`))).toMatchObject({ positionId: inside });

    // 全权夹具建一条范围外职位的记录：范围内 HR 看不到
    const hidden = await w.ok<{ id: string }>(
      await w.http(w.hrUser, 'POST', '/api/tenant/idp/work-shifts', {
        ifMatch: 0,
        body: { ...base, startDate: '2026-02-01', positionId: outside },
      }),
      201,
    );
    expect((await hr.request('GET', `/work-shifts/${hidden.id}`)).status).toBe(404);
    const list = (await (await hr.request('GET', '/work-shifts')).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toEqual([created.id]);
    const plan = await w.startedPlan();
    const detail = await w.ok<PlanView>(await hr.request('GET', `/plans/${plan.id}`));
    expect(detail.keyInfo?.workShifts?.map((r) => r.id)).toEqual([created.id]);
  });
});
