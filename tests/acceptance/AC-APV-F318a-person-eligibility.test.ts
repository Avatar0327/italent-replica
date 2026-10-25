/** DEC-686①：依赖 F-304 对同一 assertFallbackUsers 的收紧，不在 F-318a 复制校验。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { uniqueSuffix } from './support/unique.js';
import { expect, it } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';

const database = useTestDb();
it.each(['external', 'departed'] as const)('指定人员保存拒绝 %s（F-304 依赖契约）', async (kind) => {
  const w = await approvalWorld(database().db, `f318a-eligibility-${kind}`);
  const s = await transferScene(w);
  if (kind === 'external') {
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`DELETE FROM permission_user_person_links
        WHERE tenant_id=${w.tenant.id} AND user_id=${s.manager.userId}`);
      await tx.execute(sql`UPDATE tenant_memberships
      SET user_type='external',business_identity='合成外部成员'
      WHERE tenant_id=${w.tenant.id} AND user_id=${s.manager.userId}`);
    });
  } else {
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.manager.employeeId}`),
    );
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.manager.employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-01', fields: {} },
      }),
      201,
    );
  }
  const response = await w.request(w.hr.id, 'POST', '/api/tenant/approval/processes', {
    ifMatch: 0,
    body: {
      code: `F318a_${uniqueSuffix()}`,
      approvalType: 'transfer',
      name: '合成来源流程',
      nodes: [{ key: 'one', approver: { type: 'specified', value: s.manager.userId } }],
    },
  });
  expect(response.status, await response.clone().text()).toBe(422);
});
