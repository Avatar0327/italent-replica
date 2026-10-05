/**
 * AC-TEN-06 恢复对账与审批（PR #60 astra 复审 P2-6，DEC-098 / DEC-123）：备份里有指派给异常管理员的在途异常待办；
 * 现网随后交接并停用该异常管理员。恢复对账不得让流程继续指向停用账号，也不得把异常待办留给停用账号——
 * 流程改指现网的异常管理员，待办按 DEC-123 接管；做不到的列入 problems 并阻止开放。
 */
import { openRestoredTenant, restoreTenant } from '@italent/api';
import { exportTenantBackup, getUser, setUserStatus, sql, withTenant } from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const handles: { close(): Promise<void> }[] = [];

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

afterAll(async () => {
  for (const handle of handles) await handle.close();
});

describe('AC-TEN-06 恢复对账：异常管理员与在途异常待办（DEC-098 / 123）', () => {
  it('现网已交接并停用的异常管理员：恢复库流程改指现网异常管理员，其在途异常待办被接管，开放成功', async () => {
    const w = await approvalWorld(database().db, 'restore-exception');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    let view = await w.submit(draft);
    const pending = (v: InstanceView) => v.tasks.filter((t) => t.status === 'pending');
    view = await w.json(await w.taskAction(s.outHead.userId, pending(view)[0]!.id, 'approve', view.revision));
    expect(pending(view)[0]).toMatchObject({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true });

    const backup = await exportTenantBackup(w.db, { tenantId: w.tenant.id, codeVersion: 'approval' }, cmd());

    const successor = await w.member('现网接任的异常管理员');
    const handed = await w.request(w.hr.id, 'POST', '/api/tenant/approval/exception-admins/handover', {
      ifMatch: 0,
      body: { fromUserId: w.exceptionAdmin, toUserId: successor },
    });
    expect(handed.status, await handed.clone().text()).toBe(200);
    const account = await getUser(w.db, w.exceptionAdmin);
    await setUserStatus(
      w.db,
      { userId: w.exceptionAdmin, status: 'disabled', expectedRevision: account!.revision },
      cmd(),
    );

    const handle = await createTestDb();
    handles.push(handle);
    const isolated = handle.db;
    const report = await restoreTenant(
      isolated,
      { backup, live: w.db, attachments: { sha256: async () => null } },
      cmd(),
      w.clock,
    );
    expect(report.ok, JSON.stringify(report.reconciliation)).toBe(true);

    const state = await withTenant(isolated, w.tenant.id, async (tx) => ({
      admins: rowsOf<{ exception_admin_user_id: string }>(
        await tx.execute(sql`SELECT v.exception_admin_user_id FROM approval_processes p
          JOIN approval_process_versions v ON v.tenant_id = p.tenant_id AND v.id = p.current_version_id
          WHERE p.status = 'active'`),
      ),
      tasks: rowsOf<{ assignee_user_id: string }>(
        await tx.execute(sql`SELECT assignee_user_id::text FROM approval_tasks
          WHERE status = 'pending' AND is_exception_admin AND instance_id = ${view.id}::uuid`),
      ),
    }));
    expect(state.admins.map((r) => r.exception_admin_user_id)).not.toContain(w.exceptionAdmin);
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]!.assignee_user_id).not.toBe(w.exceptionAdmin);

    const opened = await openRestoredTenant(isolated, { tenantId: w.tenant.id, live: w.db, backup }, cmd(), w.clock);
    expect(opened.status).toBe('active');
  });
});
