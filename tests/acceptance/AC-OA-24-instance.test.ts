import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { adminScope, memberInstanceScope } from '../../apps/api/src/modules/approval/access.js';
import { registerScopeProvider, type ModuleScope } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { approvalWorld } from './AC-APV-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const MAIN = 'TenantBase.OrganizationApproval';
const all: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };

describe('AC-OA-24 审批实例可见性：主体组织按申请单对象范围判定', () => {
  it('管理员与成员接管使用同一对象范围，任职看全部不能放行范围外申请', async () => {
    const w = await approvalWorld(testDb().db, 'oa24');
    const subject = await w.org(`主体${uniqueSuffix()}`);
    const outside = await w.org(`范围外${uniqueSuffix()}`);
    const adjustmentId = randomUUID();
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`
      INSERT INTO org_adjustments(id, tenant_id, code, subject, effective_date, approval_subject_org_id, created_by)
      VALUES (${adjustmentId}, ${w.tenant.id}, ${uniqueSuffix()}, '合成申请', '2026-11-01', ${subject}, ${w.hr.id})`),
    );
    let scope: ModuleScope = EMPTY_SCOPE;
    let employmentScope = all;
    const queries: string[] = [];
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async (q) => {
        queries.push(q.objectCode ?? '');
        return q.objectCode === MAIN ? scope : employmentScope;
      },
      authorize: async () => true,
      fields: async () => new Set(),
    });
    const ctx = { tenantId: w.tenant.id, userId: w.hr.id, timezone: 'Asia/Shanghai' };
    const deps = { db: w.db, authorize, clock: w.clock } as Parameters<typeof adminScope>[0];
    // 尚无公开创建入口：以真实业务头 + 实例行投影执行生产谓词，不能启动占位适配器。
    const hits = (
      mode: 'admin' | 'member',
      businessId = adjustmentId,
      tenantId = w.tenant.id,
      businessType = 'org_adjustment',
    ) =>
      withTenant(w.db, w.tenant.id, async (tx) => {
        const predicate =
          mode === 'admin' ? await adminScope(deps, ctx, ['adminLogs']) : await memberInstanceScope(deps, ctx, tx);
        expect(predicate).not.toBeNull();
        return resultRows<{ hits: number }>(
          await tx.execute(sql`
        SELECT count(*)::int AS hits FROM (SELECT ${tenantId}::uuid AS tenant_id,
          ${businessId}::uuid AS business_id, ${businessType}::text AS business_type,
          NULL::uuid AS subject_employee_id) i WHERE ${predicate!}`),
        )[0]!.hits;
      });
    for (const mode of ['admin', 'member'] as const) {
      scope = EMPTY_SCOPE;
      employmentScope = all;
      expect(await hits(mode), '空申请单范围不能借任职看全部').toBe(0);
      scope = { orgIds: [outside], personIds: [], all: false, hasDataPermission: true };
      expect(await hits(mode), '主体组织范围外').toBe(0);
      scope = { ...scope, orgIds: [subject] };
      employmentScope = EMPTY_SCOPE;
      expect(await hits(mode), '主体在范围内不要求任职范围').toBe(1);
      expect(await hits(mode, adjustmentId, randomUUID()), '不得匹配其他租户').toBe(0);
      scope = all;
      expect(await hits(mode, randomUUID()), '看全部也不能放行不存在业务单').toBe(0);
      expect(await hits(mode, adjustmentId, w.tenant.id, 'employment'), '任职仍按任职范围').toBe(0);
      employmentScope = all;
      scope = EMPTY_SCOPE;
      expect(await hits(mode, adjustmentId, w.tenant.id, 'employment')).toBe(1);
    }
    expect(queries).toContain(MAIN);
  });
});
