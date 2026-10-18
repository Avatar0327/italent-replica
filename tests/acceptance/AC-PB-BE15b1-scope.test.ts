/**
 * BE-15b1 数据范围（路由规则 2、3）：考核按考核对象员工 / 创建时的主职部门裁剪；范围外与不存在是同一个 404「考核记录不存在」，
 * 列表按范围过滤，批量发起时范围外的人只在他自己的回执里失败。范围用空范围（EMPTY_SCOPE）在命令事务内直接判定。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createAssessments, parseAssessmentBatch } from '../../apps/api/src/modules/employment/assessment.js';
import {
  listAssessments,
  loadAssessment,
  requireAssessmentInScope,
} from '../../apps/api/src/modules/employment/assessment-store.js';
import { employmentScopePredicate } from '../../apps/api/src/modules/employment/context.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { assessmentWorld } from './AC-PB-BE15b1-support.js';

const testDb = useTestDb();

describe('考核的数据范围', () => {
  it('空范围：详情 / 修改前置判范围与不存在同一个 404；列表为空；批量发起逐人失败', async () => {
    const w = await assessmentWorld(testDb().db, 'scope');
    const person = await w.probationer('范围员工');
    const id = await w.launch('probation', person);
    const ctx = {
      tenantId: w.tenant.id,
      userId: w.hr.id,
      timezone: 'Asia/Shanghai',
      now: w.clock(),
      commandId: randomUUID(),
      expectedRevision: 0,
      scope: EMPTY_SCOPE,
    };
    const other = await w.probationer('范围外发起');
    const revision = await w.employeeRevision(other.employeeId);
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      const row = await loadAssessment(tx, w.tenant.id, id);
      const outOfScope = await requireAssessmentInScope(tx, ctx, row).catch((error: unknown) => error);
      const missing = await loadAssessment(tx, w.tenant.id, randomUUID()).catch((error: unknown) => error);
      expect(outOfScope).toMatchObject({ code: 'NOT_FOUND', message: '考核记录不存在' });
      expect(missing).toMatchObject({ code: 'NOT_FOUND', message: (outOfScope as Error).message });

      const listed = await listAssessments(
        tx,
        w.tenant.id,
        {},
        employmentScopePredicate(EMPTY_SCOPE, sql`a.employee_id`, sql`a.department_id`),
        { limit: 50, offset: 0 },
      );
      expect(listed).toEqual([]);

      const receipt = await createAssessments(
        tx,
        ctx,
        parseAssessmentBatch({
          assessmentType: 'probation',
          assessmentName: '范围外',
          assessmentDate: '2026-10-01',
          items: [{ employeeId: other.employeeId, revision }],
        }),
      );
      expect(receipt.items[0]).toMatchObject({ status: 'failed', assessmentId: null, error: { code: 'NOT_FOUND' } });
    });
  });
});
