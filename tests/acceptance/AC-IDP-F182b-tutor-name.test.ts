import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { IDP, planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
type Row = { id: string; tutorEmployeeId: string | null; tutorName: string | null };

describe('F-182b / DEC-611 参与人列表的最小指导人姓名披露', () => {
  it('无人事查看权的本人及指导人可读姓名；无关计划不入列', async () => {
    const w = await planWorld(testDb().db, 'idp-f182b-name');
    const own = await w.startedPlan();
    const unrelated = await w.start(
      await w.createPlan(
        { name: '无关计划', tutorRole: 'other', tutorEmployeeId: w.manager.employeeId },
        w.hrUser,
        w.outsider,
      ),
    );
    const personnel = `/api/tenant/employment/employees/${w.manager.employeeId}`;
    expect((await w.realHttp(w.employee.userId, 'GET', personnel)).status).toBe(403);
    const list = (user: string) => w.realHttp(user, 'GET', `${IDP}/my-plans`);
    const mine = await w.ok<{ items: Row[] }>(await list(w.employee.userId));
    expect(mine.items.map((row) => row.id)).toEqual([own.id]);
    expect(mine.items[0]).toMatchObject({ tutorEmployeeId: w.manager.employeeId, tutorName: '经理甲' });
    const tutored = await w.ok<{ items: Row[] }>(await list(w.manager.userId));
    expect(tutored.items.find((row) => row.id === own.id)).toHaveProperty('tutorName', '经理甲');
    const other = await w.ok<{ items: Row[] }>(await list(w.outsider.userId));
    expect(other.items.map((row) => row.id)).toEqual([unrelated.id]);
    expect(other.items[0]).toMatchObject({ tutorEmployeeId: w.manager.employeeId, tutorName: '经理甲' });
    expect((await w.realHttp(w.employee.userId, 'GET', personnel)).status).toBe(403);
  });

  it('只因在办待办入列的非关系人，指导人 ID 与姓名均明确为 null', async () => {
    const w = await planWorld(testDb().db, 'idp-f182b-pending');
    const plan = await w.startedPlan();
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM permission_user_person_links WHERE employee_id=${w.manager.employeeId}::uuid`),
    );
    await w.ok(await w.submitRaw(plan, 1, w.employee.userId));
    const result = await w.ok<{ items: Row[] }>(await w.realHttp(w.exceptionAdmin, 'GET', `${IDP}/my-plans`));
    const row = result.items.find((item) => item.id === plan.id);
    expect(row).toHaveProperty('tutorEmployeeId', null);
    expect(row).toHaveProperty('tutorName', null);
  });
});
