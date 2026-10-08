/**
 * R3-T07 PR-B 关键信息维护的权限（PR 描述矩阵“带教 / 职业发展 / 轮岗”行，真实授权器；IDP-R21 / R22，K-35）：
 * 员工（带教双方）须在操作人 IDP 范围内、轮岗部门须在范围内，范围外 404；列表按范围裁剪；字段按对象字段权限裁剪；
 * 无按钮 403。负例前后比对不变。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

async function world(label: string) {
  const w = await planWorld(testDb().db, label);
  const pw = await permissionWorldOf(w);
  const otherOrg = await w.org('范围外部门');
  const stranger = await w.person('范围外员工', otherOrg);
  return { w, pw, otherOrg, stranger };
}

const span = { startDate: '2026-01-01', endDate: '2026-06-30' };

describe('关键信息：范围与字段', () => {
  it('范围内 HR 新建 / 查看 / 修改 / 删除轮岗；范围外员工或部门 404，列表不含', async () => {
    const { w, pw, otherOrg, stranger } = await world('idp-ki');
    const full = await idpOperator(pw, { orgId: w.dept });
    const hr = await idpOperator(pw, { orgId: w.dept, hidden: { workShift: ['mentorEmployeeId'] } });
    // 看不到导师字段的 HR 不能带着该字段新建（字段编辑权 403）
    const hiddenWrite = await hr.request('POST', '/work-shifts', {
      ifMatch: 0,
      body: { employeeId: w.employee.employeeId, orgId: w.dept, mentorEmployeeId: w.manager.employeeId, ...span },
    });
    expect(hiddenWrite.status).toBe(403);
    const created = await full.request('POST', '/work-shifts', {
      ifMatch: 0,
      body: { employeeId: w.employee.employeeId, orgId: w.dept, mentorEmployeeId: w.manager.employeeId, ...span },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const row = (await created.json()) as { id: string; revision: number };
    expect(row).toMatchObject({ mentorEmployeeId: w.manager.employeeId });
    const detail = (await (await hr.request('GET', `/work-shifts/${row.id}`)).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({ employeeId: w.employee.employeeId, orgId: w.dept, startDate: '2026-01-01' });
    expect(detail).not.toHaveProperty('mentorEmployeeId');

    for (const body of [
      { employeeId: stranger.employeeId, orgId: w.dept, ...span },
      { employeeId: w.employee.employeeId, orgId: otherOrg, ...span, startDate: '2026-02-01' },
    ]) {
      expect((await hr.request('POST', '/work-shifts', { ifMatch: 0, body })).status).toBe(404);
    }
    const patched = await hr.request('PATCH', `/work-shifts/${row.id}`, {
      ifMatch: row.revision,
      body: { endDate: '2026-05-31' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    // 改到范围外的部门：404，记录不变
    const moved = await hr.request('PATCH', `/work-shifts/${row.id}`, {
      ifMatch: row.revision + 1,
      body: { orgId: otherOrg },
    });
    expect(moved.status).toBe(404);

    const outside = await idpOperator(pw, { orgId: otherOrg });
    expect((await outside.request('GET', `/work-shifts/${row.id}`)).status).toBe(404);
    const list = (await (await outside.request('GET', '/work-shifts')).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
    expect((await outside.request('DELETE', `/work-shifts/${row.id}`, { ifMatch: row.revision + 1 })).status).toBe(404);

    const deleted = await hr.request('DELETE', `/work-shifts/${row.id}`, { ifMatch: row.revision + 1 });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect((await hr.request('GET', `/work-shifts/${row.id}`)).status).toBe(404);
  });

  it('带教：带教人或被带教人任一在范围外 404；无按钮 403；无身份 403', async () => {
    const { w, pw, stranger } = await world('idp-ki-tutor');
    const hr = await idpOperator(pw, { orgId: w.dept });
    const outsideTutor = await hr.request('POST', '/tutorships', {
      ifMatch: 0,
      body: { tutorEmployeeId: stranger.employeeId, tuteeEmployeeId: w.employee.employeeId, ...span },
    });
    expect(outsideTutor.status).toBe(404);
    const noButton = await idpOperator(pw, { orgId: w.dept, buttons: false });
    const denied = await noButton.request('POST', '/tutorships', {
      ifMatch: 0,
      body: { tutorEmployeeId: w.manager.employeeId, tuteeEmployeeId: w.employee.employeeId, ...span },
    });
    expect(denied.status).toBe(403);
    expect((await w.realHttp(w.employee.userId, 'GET', `${IDP}/tutorships`)).status).toBe(403);
    const list = (await (await hr.request('GET', '/tutorships')).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
  });
});
