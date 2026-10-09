/**
 * R3-T07 PR-B 第 4 轮 R3-2（DEC-321 / DEC-197）：流程干预审计要能经生产审计查询接口读到——`audit_admin` 加 IDP 计划
 * 对象的字段查看权、范围内的用户，在数据变更日志列表与详情里看到批量催办、单计划跳转、批量终止三类记录，含动作与
 * 原因；范围外的审计查看人仍看不到（列表不含、详情 404）。
 */
import { randomUUID } from 'node:crypto';
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, PLAN_NOW, type PlanView, type Receipt } from './AC-IDP-plan-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';
const PLAN = IDP_OBJECTS.plan.code;

const items = (plan: PlanView) => [{ id: plan.id, revision: plan.revision }];

describe('R3-2：干预审计经审计查询接口可读', () => {
  it('催办 / 跳转 / 终止三条记录在列表与详情里带动作与原因；范围外不可见', async () => {
    const w = await planWorld(testDb().db, 'idp-iv-audit');
    const pw = await permissionWorldOf(w);
    let plan = await w.startedPlan();
    const urged = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('urge', { items: items(plan), reason: '催一下' }),
    );
    expect(urged.receipts).toEqual([expect.objectContaining({ status: 200 })]);
    plan = await w.readPlan(plan.id);
    await w.ok(
      await w.http(w.hrUser, 'POST', `${IDP}/plans/${plan.id}/jump`, {
        ifMatch: plan.revision,
        body: { toNodeKey: 'approve_plan', reason: '线下已确认' },
      }),
    );
    plan = await w.readPlan(plan.id);
    const ended = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('terminate', { items: items(plan), reason: '计划作废' }),
    );
    expect(ended.receipts).toEqual([expect.objectContaining({ status: 200 })]);

    const audit = auditApi(w.db, PLAN_NOW, { authorize: undefined });
    const viewer = await memberWithAdminRole(pw, 'audit_admin', `idp-iva-${randomUUID().slice(0, 4)}`);
    const inside = await idpOperator(pw, { orgId: w.dept, user: viewer.user });
    const list = await audit.dataChanges(inside.as, { objectType: PLAN, limit: '50' });
    const interventions = list.items.filter(
      (item) => item.objectId === plan.id && item.changes.some((c) => c.field === 'intervention'),
    );
    const byAction = new Map(
      interventions.map((item) => [item.changes.find((c) => c.field === 'intervention')!.to, item]),
    );
    expect([...byAction.keys()].sort(), JSON.stringify(list.items.map((i) => i.changes))).toEqual([
      'jump',
      'terminate',
      'urge',
    ]);
    for (const [action, reason] of [
      ['urge', '催一下'],
      ['jump', '线下已确认'],
      ['terminate', '计划作废'],
    ] as const) {
      const item = byAction.get(action)!;
      expect(item.changes, action).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'reason', to: reason })]),
      );
      const detail = await audit.dataChange(inside.as, item.id);
      expect(detail.after, action).toMatchObject({ intervention: action, reason });
    }

    // 范围外：另一名审计管理员的 IDP 范围在别的组织
    const outsiderViewer = await memberWithAdminRole(pw, 'audit_admin', `idp-ivo-${randomUUID().slice(0, 4)}`);
    const outside = await idpOperator(pw, { orgId: await w.org('范围外组织'), user: outsiderViewer.user });
    const hiddenList = await audit.dataChanges(outside.as, { objectType: PLAN, limit: '50' });
    expect(hiddenList.items.filter((i) => i.objectId === plan.id)).toEqual([]);
    for (const item of byAction.values()) {
      expect((await audit.get(`/data-changes/${item.id}`, outside.as)).status).toBe(404);
    }
  });
});
