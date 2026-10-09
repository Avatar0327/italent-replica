/**
 * R3-T07 PR-B 审计（DEC-216 / DEC-197；PR 描述矩阵“审计”行）：计划、目标、任务、关键信息、干预的写入与业务同事务记数据
 * 变更日志；查询按 IDP 对象权限、范围（计划员工 / 关键信息员工归属）与字段权限裁剪；删除计划留快照。
 */
import { randomUUID } from 'node:crypto';
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, PLAN_NOW } from './AC-IDP-plan-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';

const testDb = useTestDb();

describe('计划侧审计', () => {
  it('写入都记日志；查看按 IDP 范围（计划员工）与字段权限裁剪；删除留快照', async () => {
    const w = await planWorld(testDb().db, 'idp-audit');
    const pw = await permissionWorldOf(w);
    let plan = await w.startedPlan();
    plan = await w.addGoal(plan, w.employee.userId, { name: '审计目标' });
    await w.ok(
      await w.http(w.hrUser, 'POST', '/api/tenant/idp/tutorships', {
        ifMatch: 0,
        body: {
          tutorEmployeeId: w.manager.employeeId,
          tuteeEmployeeId: w.employee.employeeId,
          startDate: '2026-01-01',
          endDate: '2026-06-30',
        },
      }),
      201,
    );
    const deleted = await w.createPlan({ name: '将被删除的计划' });
    await w.ok(await w.http(w.hrUser, 'DELETE', `/api/tenant/idp/plans/${deleted.id}`, { ifMatch: deleted.revision }));

    const all = auditApi(w.db, PLAN_NOW);
    for (const objectType of [IDP_OBJECTS.plan.code, IDP_OBJECTS.goal.code, IDP_OBJECTS.tutorship.code]) {
      const { items } = await all.dataChanges(w.as(w.hrUser), { objectType, limit: '50' });
      expect(items.length, objectType).toBeGreaterThan(0);
      for (const item of items) expect(item.app).toBe('个人发展计划');
    }

    const audit = auditApi(w.db, PLAN_NOW, { authorize: undefined });
    const viewer = await memberWithAdminRole(pw, 'audit_admin', `idp-paudit-${randomUUID().slice(0, 4)}`);
    const query = { objectType: IDP_OBJECTS.plan.code, limit: '50' };
    const op = await idpOperator(pw, { hidden: { plan: ['tutorEmployeeId'] }, user: viewer.user });
    expect((await audit.dataChanges(op.as, query)).items).toEqual([]);
    await op.setOrg(w.dept);
    const { items } = await audit.dataChanges(op.as, query);
    expect(new Set(items.map((i) => i.objectId))).toEqual(new Set([plan.id, deleted.id]));
    const removal = items.find((i) => i.objectId === deleted.id && i.operation === 'delete')!;
    const detail = await audit.dataChange(op.as, removal.id);
    expect(detail.before).toMatchObject({ name: '将被删除的计划', employeeId: w.employee.employeeId });
    expect(JSON.stringify(detail)).not.toContain(w.manager.employeeId);

    const otherOrg = await w.org('审计范围外');
    await op.setOrg(otherOrg);
    expect((await audit.dataChanges(op.as, query)).items).toEqual([]);
  });
});
