import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { authorizeHead } from '../../apps/api/src/modules/org-adjustment/access.js';
import { headWorld, only } from './AC-OA-head-support.js';

const testDb = useTestDb();

describe('AC-OA-39 头授权判定（F-287，DEC-644 A-3；审批实例入口随 10c）', () => {
  it('当前审批人有按钮与字段权，但主体组织不在其申请单对象范围 → 拒绝，数据不变', async () => {
    const w = await headWorld(testDb().db, 'oa39');
    const view = await w.created();
    const approver = await w.member('当前审批人');
    const ctx = { tenantId: w.tenant.id, userId: approver, timezone: 'Asia/Shanghai' };
    const deps = { db: w.db, authorize: w.authorize, clock: w.clock };
    const judge = (actor: 'applicant' | 'current_approver') =>
      withTenant(w.db, w.tenant.id, (tx) =>
        authorizeHead(tx, deps, ctx, {
          actor,
          operation: 'update',
          fields: ['subject'],
          subjectOrgId: w.subject,
          rangeOrgIds: [w.a],
        }),
      );
    w.access.main = only(w.a);
    await expect(judge('current_approver')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(judge('applicant')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await w.stored(view.id)).toMatchObject({ subject: view.subject, revision: 1 });

    w.access.main = only(w.subject);
    await expect(judge('current_approver')).resolves.toBeUndefined();
    // 审批编辑另须 EditApprovalIngApply（取严），所选组织按审批人自己的组织范围
    w.access.deniedButtons.add('EditApprovalIngApply');
    await expect(judge('current_approver')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(judge('applicant')).resolves.toBeUndefined();
    w.access.deniedButtons.clear();
    w.access.org = only(w.b);
    await expect(judge('current_approver')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    w.access.org = only(w.a);
    w.access.deniedFields.add('subject');
    await expect(judge('current_approver')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
