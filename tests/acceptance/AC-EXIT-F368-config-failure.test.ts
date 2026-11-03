/**
 * F-368（DEC-663、DEC-674）：自动发起交接时流程配置预检失败（如异常管理员就是离职员工本人且没有可接替的直线经理），
 * 与 NO_HANDLER 同口径落持久的“未发起”记录：HR 看得到原因与提示，配置修好后从 F-305 的重新提交入口重提即可，
 * 不再只留一条 launch_failed 审计、没有 requestId 可重提。离职审批照常通过。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  loadProcess,
  newVersion,
  publishProcess,
  replaceDraft,
} from '../../apps/api/src/modules/approval/definitions.js';
import { handoverWorld, TODAY } from './AC-EXIT-handover-support.js';

const database = useTestDb();
const SELF = 'APPROVAL_EXCEPTION_ADMIN_SELF';
type HandoverWorld = Awaited<ReturnType<typeof handoverWorld>>;

async function world(label: string) {
  const x = await handoverWorld(database().db, `f368-${label}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  return x;
}
/** 换异常管理员后重新发布交接流程（两步：新草稿 → 替换 → 发布）。 */
async function setExceptionAdmin(x: HandoverWorld, userId: string) {
  const [process] = await x.sqlRows<{ id: string }>(sql`SELECT id FROM approval_processes
    WHERE tenant_id=${x.tenantId} AND code='AAA_EXIT_HANDOVER'`);
  await withTenant(x.db, x.tenantId, async (tx) => {
    const ctx = {
      tenantId: x.tenantId,
      userId: x.processAdmin.id,
      timezone: 'Asia/Shanghai',
      now: new Date(`${TODAY}T03:00:00Z`),
      commandId: randomUUID(),
      expectedRevision: 0,
    };
    const current = await loadProcess(tx, x.tenantId, process!.id);
    const draft = await newVersion(tx, { ...ctx, expectedRevision: current.revision }, current.id);
    const changed = await replaceDraft(tx, { ...ctx, expectedRevision: draft.revision }, current.id, {
      ...draft.latestVersion,
      exceptionAdminUserId: userId,
    });
    await publishProcess(tx, { ...ctx, expectedRevision: changed.revision }, current.id);
  });
}
const rowsOfExit = (x: HandoverWorld, exitId: string) =>
  x.sqlRows<{ id: string; revision: number; state: string; reason: string | null; items: number }>(sql`
    SELECT r.id, r.revision, r.state, r.not_launched_reason AS reason,
      (SELECT count(*)::int FROM exit_handover_request_items i WHERE i.tenant_id=r.tenant_id AND i.request_id=r.id)
        AS items
    FROM exit_handover_requests r WHERE r.tenant_id=${x.tenantId} AND r.exit_request_id=${exitId}::uuid`);
async function resubmit(x: HandoverWorld, id: string, revision: number, key = randomUUID()) {
  return x.session.request('POST', `/exit-handover-requests/${id}/resubmit`, {
    ifMatch: revision,
    idempotencyKey: key,
    body: {},
  });
}

describe('F-368 发起预检失败落持久未发起记录', () => {
  it('异常管理员是离职本人且无人可接替：落 not_launched（读模型 / 提示 / 审计），离职审批通过，不留 launch_failed', async () => {
    const x = await world('self');
    await setExceptionAdmin(x, x.leaverUserId);
    const { draft, approved } = await x.approvedApplication(x.employee.id);
    expect((await x.business(draft.id)).status).toBe('approved');
    expect(approved).toBeTruthy();
    const [row] = await rowsOfExit(x, draft.id);
    expect(row).toMatchObject({ state: 'not_launched', reason: SELF, items: 0 });
    expect(await x.handoverInstanceCount()).toBe(0);
    const status = await x.statusOf(draft.id);
    expect(status.status).toBe('not_launched');
    expect(status.request).toMatchObject({
      id: row!.id,
      notLaunchedReason: SELF,
      hint: expect.stringContaining('异常管理员'),
    });
    expect(await x.auditActions(row!.id, 'exit_handover.not_launched')).toHaveLength(1);
    expect(await x.auditActions(draft.id, 'exit_handover.launch_failed')).toEqual([]);
    // 调度补跑不重复造单
    await x.runScheduler(`${TODAY}T02:30:00Z`);
    expect(await rowsOfExit(x, draft.id)).toEqual([row]);
  });

  it('配置未修好前重提仍 409 并回原因，记录不变；修好配置后重提成功，一张单一个实例，重复提交不再新建', async () => {
    const x = await world('resubmit');
    await setExceptionAdmin(x, x.leaverUserId);
    const { draft } = await x.approvedApplication(x.employee.id);
    const [row] = await rowsOfExit(x, draft.id);
    const stillBroken = await resubmit(x, row!.id, row!.revision);
    expect(stillBroken.status).toBe(409);
    expect(await stillBroken.json()).toMatchObject({ error: { details: { reason: SELF } } });
    expect(await rowsOfExit(x, draft.id)).toEqual([row]);
    expect(await x.handoverInstanceCount()).toBe(0);
    // 修好配置
    await setExceptionAdmin(x, x.exceptionAdmin.id);
    const key = randomUUID();
    const fixed = await resubmit(x, row!.id, row!.revision, key);
    expect(fixed.status, await fixed.clone().text()).toBe(200);
    const after = await rowsOfExit(x, draft.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: row!.id, state: 'in_progress', reason: null });
    expect(after[0]!.items).toBeGreaterThan(0);
    expect(await x.handoverInstanceCount()).toBe(1);
    expect((await x.statusOf(draft.id)).status).toBe('in_progress');
    // 同键重放取回首次回执；换键重提被拒；实例仍只有一个
    expect(await (await resubmit(x, row!.id, row!.revision, key)).json()).toEqual(await fixed.json());
    expect((await resubmit(x, row!.id, row!.revision)).status).toBe(409);
    expect(await x.handoverInstanceCount()).toBe(1);
    expect(await x.auditActions(row!.id, 'exit_handover.resubmit')).toHaveLength(1);
  });
});
