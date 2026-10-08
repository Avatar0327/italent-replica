/**
 * AC-TEN-06 恢复对账与审批（PR #60 astra 复审 P2-6，DEC-098 / DEC-123）：备份里有指派给异常管理员的在途异常待办；
 * 现网随后交接并停用该异常管理员。恢复对账不得让流程继续指向停用账号，也不得把异常待办留给停用账号——
 * 流程改指现网的异常管理员，待办按 DEC-123 接管；做不到的列入 problems 并阻止开放。
 * 同一场景另验 P2-4：导入时显式写入的 employment_state_events.event_seq 之后，序列已推进（同日排序依赖它）。
 */
import { openRestoredTenant, restoreTenant } from '@italent/api';
import { exportTenantBackup, getUser, setUserStatus, sql, withTenant } from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  approvalWorld,
  grantFieldAccess,
  permissionAdmin,
  TRANSFER_NODES,
  transferScene,
  type InstanceView,
} from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const handles: { close(): Promise<void> }[] = [];

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

afterAll(async () => {
  for (const handle of handles) await handle.close();
});

// 整库备份 / 恢复按全部租户表逐表进行，耗时随表数增长（R3-T03 新增 23 张表后逼近默认 30s），单独放宽且仍有上限
const RESTORE_TIMEOUT = { timeout: 90_000 };

describe('AC-TEN-06 恢复对账：异常管理员与在途异常待办（DEC-098 / 123）', RESTORE_TIMEOUT, () => {
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
    // 真实授权器下替代人须能覆盖该实例（任职记录的查看与数据范围）才接得了手；授权在备份之后、只存在于现网
    const world = await permissionAdmin(w);
    await grantFieldAccess(world, successor, { view: ['employeeId', 'departmentId', 'effectiveDate'] });
    const profiles = (await (
      await world.api.request('GET', '/api/tenant/permission/profiles', world.asAdmin)
    ).json()) as {
      items: { id: string }[];
    };
    const seeAll = await world.api.request(
      'PUT',
      `/api/tenant/permission/profiles/${profiles.items.at(-1)!.id}/data-scopes/TenantBase`,
      { ...world.asAdmin, ifMatch: 0, body: { targetKind: 'app', targetCode: '', seeAll: true } },
    );
    expect(seeAll.status, await seeAll.clone().text()).toBe(200);
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

    // P2-4：导入时显式写入了 event_seq（同日任职排序依赖它），序列须推进到已导入最大值之后
    const [seq] = await isolated.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
      return rowsOf<{ max: string | null; next: string }>(
        await tx.execute(sql`SELECT (SELECT max(event_seq) FROM employment_state_events)::text AS max,
          nextval(pg_get_serial_sequence('employment_state_events', 'event_seq'))::text AS next`),
      );
    });
    expect(seq?.max).not.toBeNull();
    expect(BigInt(seq!.next)).toBeGreaterThan(BigInt(seq!.max!));

    const opened = await openRestoredTenant(isolated, { tenantId: w.tenant.id, live: w.db, backup }, cmd(), w.clock);
    expect(opened.status).toBe('active');
  });

  it('接不了手（现网替代人在真实授权下覆盖不了该实例）：列入 problems，租户保持隔离，不能开放', async () => {
    const w = await approvalWorld(database().db, 'restore-exception-blocked');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    const submitted = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const first = submitted.tasks.find((t) => t.status === 'pending')!;
    await w.json(await w.taskAction(s.outHead.userId, first.id, 'approve', submitted.revision));
    const backup = await exportTenantBackup(w.db, { tenantId: w.tenant.id, codeVersion: 'approval' }, cmd());
    const successor = await w.member('没有授权的接任人');
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
    const input = { backup, live: w.db, attachments: { sha256: async () => null } };
    const report = await restoreTenant(handle.db, input, cmd(), w.clock);
    expect(report.ok).toBe(false);
    expect(report.reconciliation.problems).toEqual([
      expect.objectContaining({ reason: 'EXCEPTION_TASK_TAKEOVER_FAILED', userId: w.exceptionAdmin }),
    ]);
    await expect(
      openRestoredTenant(handle.db, { tenantId: w.tenant.id, live: w.db, backup }, cmd(), w.clock),
    ).rejects.toEqual(expect.objectContaining({ reason: 'RESTORE_NOT_VERIFIED' }));
  });

  it.each([
    ['后还有节点', false],
    ['为最后节点', true],
  ] as const)(
    'P2-N2：会签中接任人已同意、异常管理员席位待办（会签%s）→ 恢复不推进流转，列入 problems',
    async (_position, last) => {
      const w = await approvalWorld(database().db, `restore-joint-${last ? 'last' : 'mid'}`);
      const s = await transferScene(w);
      await w.setOrgRoles(s.to, { hrbp: null });
      const joint = {
        key: 'joint',
        name: '调入部门会签',
        kind: 'countersign' as const,
        approvers: ['record_department_head', 'record_department_hrbp'] as const,
        transitionRule: { type: 'all' as const },
      };
      const first = { key: 'out_head', name: '调出负责人审批', approver: 'latest_record_department_head' as const };
      const final = { key: 'final', name: '调出负责人确认', approver: 'latest_record_department_head' as const };
      await w.publishedProcess({ nodes: last ? [first, joint] : [first, joint, final] });
      const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
      const submitted = await w.submit(draft);
      const pendingOf = (v: InstanceView) => v.tasks.filter((t) => t.status === 'pending');
      let view = await w.json<InstanceView>(
        await w.taskAction(s.outHead.userId, pendingOf(submitted)[0]!.id, 'approve', submitted.revision),
      );
      const own = pendingOf(view).find((t) => t.assigneeUserId === s.inHead.userId)!;
      view = await w.json<InstanceView>(await w.taskAction(s.inHead.userId, own.id, 'approve', view.revision));
      expect(view.currentNodeKey).toBe('joint');
      expect(pendingOf(view)).toEqual([
        expect.objectContaining({ assigneeUserId: w.exceptionAdmin, nodeKey: 'joint' }),
      ]);

      const backup = await exportTenantBackup(w.db, { tenantId: w.tenant.id, codeVersion: 'joint' }, cmd());

      // 现网：接任人 = 已在会签中同意的调入负责人（真实授权下可覆盖该实例），交接并停用原异常管理员
      const world = await permissionAdmin(w);
      await grantFieldAccess(world, s.inHead.userId, { view: ['employeeId', 'departmentId', 'effectiveDate'] });
      const profiles = (await (
        await world.api.request('GET', '/api/tenant/permission/profiles', world.asAdmin)
      ).json()) as {
        items: { id: string }[];
      };
      const seeAll = await world.api.request(
        'PUT',
        `/api/tenant/permission/profiles/${profiles.items.at(-1)!.id}/data-scopes/TenantBase`,
        { ...world.asAdmin, ifMatch: 0, body: { targetKind: 'app', targetCode: '', seeAll: true } },
      );
      expect(seeAll.status, await seeAll.clone().text()).toBe(200);
      const handed = await w.request(w.hr.id, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: s.inHead.userId },
      });
      expect(handed.status, await handed.clone().text()).toBe(200);
      const account = await getUser(w.db, w.exceptionAdmin);
      await setUserStatus(
        w.db,
        { userId: w.exceptionAdmin, status: 'disabled', expectedRevision: account!.revision },
        cmd(),
      );

      // 现网：停用触发接管、合并席位并重新结算（会签为最后节点时业务获批并生效）。真 PostgreSQL 上这一步曾因延迟约束在切回
      // 平台角色后才执行而失败（platform-command.ts 离开租户上下文前就地执行延迟约束）。
      const liveBusiness = await w.business(draft.id);
      expect(liveBusiness.status).toBe(last ? 'effective' : 'in_review');

      const handle = await createTestDb();
      handles.push(handle);
      const input = { backup, live: w.db, attachments: { sha256: async () => null } };
      const report = await restoreTenant(handle.db, input, cmd(), w.clock);
      expect(report.ok).toBe(false);
      expect(report.reconciliation.problems).toEqual([
        expect.objectContaining({ reason: 'EXCEPTION_TASK_TAKEOVER_FAILED', userId: w.exceptionAdmin }),
      ]);
      const state = await withTenant(handle.db, w.tenant.id, async (tx) => ({
        instance: rowsOf<{ status: string; current_node_key: string }>(
          await tx.execute(sql`SELECT status, current_node_key FROM approval_instances WHERE id = ${view.id}::uuid`),
        )[0],
        nodes: rowsOf<{ node_key: string }>(
          await tx.execute(sql`SELECT DISTINCT node_key FROM approval_tasks WHERE instance_id = ${view.id}::uuid`),
        ).map((r) => r.node_key),
        business: rowsOf<{ status: string }>(
          await tx.execute(sql`SELECT state AS status FROM employment_state_events
          WHERE business_id = ${draft.id}::uuid ORDER BY event_seq DESC LIMIT 1`),
        )[0],
      }));
      expect(state.instance).toEqual({ status: 'running', current_node_key: 'joint' });
      expect(state.nodes.sort()).toEqual(['joint', 'out_head']);
      expect(state.business?.status).toBe('in_review');
      await expect(
        openRestoredTenant(handle.db, { tenantId: w.tenant.id, live: w.db, backup }, cmd(), w.clock),
      ).rejects.toEqual(expect.objectContaining({ reason: 'RESTORE_NOT_VERIFIED' }));
    },
  );
});
