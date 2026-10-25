/** DEC-057 / DEC-686：运行错误不回显设计器中指定账号的来源配置。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';

const database = useTestDb();
it('指定审批人失效导致提交失败时，只返回节点错误，不带配置账号', async () => {
  const w = await approvalWorld(database().db, 'f318a-error-disclosure');
  const s = await transferScene(w);
  await w.publishedProcess({
    nodes: [
      {
        key: 'one',
        kind: 'countersign',
        approvers: [{ type: 'specified', value: s.manager.userId }],
        transitionRule: { type: 'all' },
      },
    ],
  });
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
    WHERE tenant_id=${w.tenant.id} AND user_id=${s.manager.userId}`),
  );
  const response = await w.submitRaw(
    await w.application(s.subject.employeeId, { departmentId: s.to }),
    s.subject.userId,
  );
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.error.details.reason).toBe('APPROVAL_FIRST_NODE_EMPTY');
  expect(JSON.stringify(body)).not.toContain(s.manager.userId);
});
