/**
 * F-326 S5 / 00 补充：异常管理员交接重发（republishWithExceptionAdmin）是“原样复制既有版本”，来源（变量 / 矩阵）
 * 已按影响清单停用后不得再因引用校验 422；与 #687 修 newVersion 同一做法。交接（handover）与恢复（restore 对账）
 * 两个入口各自走真实接口，不直接改库造状态。
 */
import { restoreTenant } from '@italent/api';
import { exportTenantBackup, getUser, setUserStatus, sql, withTenant } from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import {
  APPROVAL,
  counter,
  matrix,
  matrixSource,
  matrixStatus,
  references,
  s4World,
  variable,
  variableCommand,
  varSource,
  type S4World,
} from './AC-APV-F326-S4-support.js';
import type { ProcessView } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const handle of handles) await handle.close();
});
// 整库备份 / 恢复逐表进行，耗时随表数增长，单独放宽且仍有上限
const RESTORE_TIMEOUT = { timeout: 90_000 };

/** 来源停用（按影响清单确认）后，流程仍以停用的来源发布着；返回流程。 */
const cases = [
  {
    name: '变量停用',
    async setup(w: S4World) {
      const v = await variable(w);
      const process = await w.publishedProcess({ nodes: [counter([varSource('public_variable', v.id)])] });
      return { process, disable: () => disableVariable(w, v), enable: () => enableVariable(w, v.id) };
    },
  },
  {
    name: '矩阵停用',
    async setup(w: S4World) {
      const m = await matrix(w, { rows: [{ cond: [], role: [w.head.userId] }] });
      const process = await w.publishedProcess({ nodes: [counter([matrixSource(m, m.roleId)])] });
      return { process, disable: () => disableMatrix(w, m), enable: () => enableMatrix(w, m.id) };
    },
  },
];

async function disableVariable(w: S4World, v: { id: string; revision: number }) {
  const { total } = await references(w, 'variables', v.id);
  const response = await variableCommand(w, v, 'disable', { acknowledgedReferenceCount: total });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function enableVariable(w: S4World, id: string) {
  const current = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${APPROVAL}/variables/${id}`));
  const response = await variableCommand(w, { id, revision: current.revision }, 'enable');
  expect(response.status, await response.clone().text()).toBe(200);
}
async function disableMatrix(w: S4World, m: { id: string; revision: number }) {
  const { total } = await references(w, 'matrices', m.id);
  const response = await matrixStatus(w, m, 'disable', { acknowledgedReferenceCount: total });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function enableMatrix(w: S4World, id: string) {
  const current = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${APPROVAL}/matrices/${id}`));
  const response = await matrixStatus(w, { id, revision: current.revision }, 'enable');
  expect(response.status, await response.clone().text()).toBe(200);
}

async function currentAdmin(w: S4World, db: Parameters<typeof withTenant>[0], processId: string) {
  const rows = await withTenant(db, w.tenant.id, async (tx) =>
    rowsOf<{ exception_admin_user_id: string }>(
      await tx.execute(sql`SELECT v.exception_admin_user_id::text FROM approval_processes p
        JOIN approval_process_versions v ON v.tenant_id=p.tenant_id AND v.id=p.current_version_id
        WHERE p.tenant_id=${w.tenant.id} AND p.id=${processId}::uuid`),
    ),
  );
  return rows[0]!;
}

describe('AC-APV-F326-S5 异常管理员交接重发不被失效来源挡住（交接入口）', () => {
  it.each(cases)('$name：交接成功，新版本仍引用该来源，只替换异常管理员', async (item) => {
    const w = await s4World(database().db, 'handover-stale');
    const { process, disable } = await item.setup(w);
    await disable();
    const successor = await w.member('合成接任人');
    const handed = await w.request(w.hr.id, 'POST', `${APPROVAL}/exception-admins/handover`, {
      ifMatch: 0,
      body: { fromUserId: w.exceptionAdmin, toUserId: successor },
    });
    expect(handed.status, await handed.clone().text()).toBe(200);
    const view = await w.json<ProcessView>(await w.request(w.hr.id, 'GET', `${APPROVAL}/processes/${process.id}`));
    expect(view.currentVersion?.exceptionAdminUserId).toBe(successor);
    expect(view.currentVersion?.versionNo).toBe(2);
    expect(view.currentVersion?.nodes.map((node) => node.approvers)).toEqual(
      process.currentVersion?.nodes.map((node) => node.approvers),
    );
  });
});

describe('AC-APV-F326-S5 异常管理员交接重发不被失效来源挡住（恢复入口）', RESTORE_TIMEOUT, () => {
  it.each(cases)('$name：恢复对账改指现网异常管理员，不报 EXCEPTION_ADMIN_HANDOVER_FAILED', async (item) => {
    const w = await s4World(database().db, 'restore-stale');
    const { process, disable, enable } = await item.setup(w);
    await disable();
    const backup = await exportTenantBackup(w.db, { tenantId: w.tenant.id, codeVersion: 'approval' }, cmd());

    // 现网：先恢复来源再交接（来源停用时交接本身也应成功，这里不依赖它），然后停用旧异常管理员
    await enable();
    const successor = await w.member('现网接任的异常管理员');
    const handed = await w.request(w.hr.id, 'POST', `${APPROVAL}/exception-admins/handover`, {
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
    const report = await restoreTenant(
      handle.db,
      { backup, live: w.db, attachments: { sha256: async () => null } },
      cmd(),
      w.clock,
    );
    expect(report.ok, JSON.stringify(report.reconciliation)).toBe(true);
    expect((await currentAdmin(w, handle.db, process.id)).exception_admin_user_id).toBe(successor);
  });
});
