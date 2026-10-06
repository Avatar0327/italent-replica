import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';

const db = useTestDb();
it('P2-9 旧草稿含未实现的合同条件也不能发布，旧已发布流程不能以空值误匹配', async () => {
  const w = await contractWorld(db().db, 'f016-old-condition');
  const ctx = {
    tenantId: w.session.tenant.id,
    userId: w.session.user.id,
    timezone: 'Asia/Shanghai',
    now: new Date('2026-10-01T01:00:00Z'),
    commandId: randomUUID(),
    expectedRevision: 0,
  };
  const preset = PRESET_PROCESSES.find((p) => p.approvalType === 'contract_create')!;
  const draft = await withTenant(w.db, ctx.tenantId, (tx) =>
    createProcess(
      tx,
      ctx,
      { code: 'LEGACY_UNSUPPORTED', approvalType: 'contract_create' },
      {
        ...preset.definition,
        exceptionAdminUserId: ctx.userId,
        conditions: { items: [{ no: 1, field: 'employee.name', operator: 'is_empty', value: null }], expression: '1' },
      },
    ),
  );
  await expect(
    withTenant(w.db, ctx.tenantId, (tx) => publishProcess(tx, { ...ctx, expectedRevision: draft.revision }, draft.id)),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  // 升级前已发布的配置：不能把不提供的 employee.name 当成真正的空值选中它。
  await withTenant(w.db, ctx.tenantId, async (tx) => {
    await tx.execute(
      sql`UPDATE approval_process_versions SET status='published',
        published_by=${ctx.userId}, published_at=now() WHERE id=${draft.latestVersion.id}::uuid`,
    );
    await tx.execute(sql`UPDATE approval_processes SET current_version_id=${draft.latestVersion.id}::uuid
      WHERE id=${draft.id}::uuid`);
  });
  const response = await w.request('POST', '/commands', {
    ifMatch: 0,
    body: { operation: 'create', mode: 'application', employeeId: w.employee.id, fields: w.fields },
  });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain('APPROVAL_CONDITION_UNSUPPORTED');
});
