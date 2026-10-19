/**
 * R2 BE-8b1 第 10 条 / DEC-631：撤销离职后自动从黑名单移除。
 * 订阅 #432 的 onCancelled 端口，与撤销同事务；只移出这笔离职写入的有效名单行（employment_blacklist.exit_request_id 匹配），
 * 走 BE-8a 移出的同一套 SQL（status = removed、removed_at / removed_by）。名单行已被手动移出、已过期，或不是这笔离职写的：
 * 不动并写审计 exit.blacklist.revoke_skipped，撤销照常完成。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { findEffectiveBlacklistEntry } from '../../apps/api/src/modules/employment/blacklist.js';
import { blacklistExitWorld, DUE_LAST_WORK_DATE, TODAY } from './AC-EXIT-blacklist-support.js';

const database = useTestDb();
const world = (label: string) => blacklistExitWorld(database().db, label);
type World = Awaited<ReturnType<typeof world>>;
/** 再入职保存时 assertNotBlacklisted 用的同一个判定：撤销后员工已回到在职，rehire 会先报“须先离职”，所以直接问拦截判定。 */
const blockedByBlacklist = async (x: World, employeeId: string) =>
  (await withTenant(x.db, x.tenantId, (tx) => findEffectiveBlacklistEntry(tx, x.tenantId, employeeId, TODAY))) !==
  undefined;
/** 名单行的移出操作人：行上的 removed_by 与 blacklist.remove 审计的 actor_user_id（系统记为空，AGENTS §10 不得冒用真实用户）。 */
const removal = async (x: World, entryId: string) => {
  const [row] = await x.sqlRows<{ removedBy: string | null; actor: string | null }>(sql`
    SELECT b.removed_by::text AS "removedBy",
      (SELECT a.actor_user_id::text FROM audit_events a WHERE a.tenant_id = b.tenant_id AND a.object_id = b.id::text
        AND a.action = 'blacklist.remove' ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1) AS actor
    FROM employment_blacklist b WHERE b.tenant_id = ${x.tenantId} AND b.id = ${entryId}::uuid`);
  return row!;
};
const actorOf = async (x: World, objectId: string, action: string) =>
  (
    await x.sqlRows<{ actor: string | null }>(sql`SELECT actor_user_id::text AS actor FROM audit_events
      WHERE tenant_id = ${x.tenantId} AND object_id = ${objectId} AND action = ${action} ORDER BY occurred_at, id`)
  ).map((row) => row.actor);
const MANUAL = { addToBlacklist: true, blacklistReason: 'integrity' };

describe('DEC-631 撤销离职回收黑名单', () => {
  it('手动勾选 → 生效 → 撤销：名单无有效行（行保留为已移出），再入职保存不再被拦截', async () => {
    const x = await world('cancel-manual');
    const leave = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', MANUAL);
    expect(leave.status).toBe('effective');
    expect(await x.activeRows(x.employee.id)).toHaveLength(1);
    expect((await x.reasonOf(await x.rehire(x.employee.id))).reason).toBe('EMPLOYEE_BLACKLISTED');
    const cancelled = await x.cancelExit(leave.id);
    expect(cancelled.cancellation.case).toBe('record_deleted_reinstated');
    expect(await x.activeRows(x.employee.id)).toEqual([]);
    expect(await x.rows(x.employee.id)).toEqual([
      expect.objectContaining({ source: 'manual', status: 'removed', exitRequestId: leave.id }),
    ]);
    const removed = (await x.page.list('?status=removed')).items;
    expect(removed).toHaveLength(1);
    expect(await x.auditActions(leave.id, 'exit.blacklist.revoked')).toHaveLength(1);
    // 自动回收记系统操作人（行上 removed_by 与移出 / 回收审计的操作人都为空 = 系统）；撤销记录本身仍是发起撤销的 HR
    expect(await removal(x, removed[0]!.id)).toEqual({ removedBy: null, actor: null });
    expect(await actorOf(x, leave.id, 'exit.blacklist.revoked')).toEqual([null]);
    expect(await actorOf(x, leave.id, 'exit.request.cancel')).toEqual([x.session.user.id]);
    expect(await blockedByBlacklist(x, x.employee.id)).toBe(false);
  });

  it('自动规则命中 → 生效 → 撤销：同上（名单无有效行，再入职不再被拦截）', async () => {
    const x = await world('cancel-auto');
    await x.setAutoSwitch(true);
    await x.addRule([x.from.id]);
    const leave = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', { exitTypeCode: 'voluntary' });
    expect(await x.activeRows(x.employee.id)).toEqual([expect.objectContaining({ source: 'auto_rule' })]);
    await x.cancelExit(leave.id);
    expect(await x.activeRows(x.employee.id)).toEqual([]);
    expect(await x.rows(x.employee.id)).toEqual([
      expect.objectContaining({ source: 'auto_rule', status: 'removed', exitRequestId: leave.id }),
    ]);
    expect(await blockedByBlacklist(x, x.employee.id)).toBe(false);
  });

  it('本人另有一条黑名单页手动新增的行：撤销后那条仍有效，只留审计', async () => {
    const x = await world('cancel-other-row');
    // ① 先有页面新增的行：离职勾选加黑因重复被跳过，这笔离职没写过行
    const page = await x.page.added({ employeeId: x.employee.id, reason: 'resignation' });
    const leave = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', MANUAL);
    await x.cancelExit(leave.id);
    expect(await x.activeRows(x.employee.id)).toEqual([expect.objectContaining({ id: page.id, status: 'active' })]);
    expect((await x.auditActions(leave.id, 'exit.blacklist.revoke_skipped'))[0]!.after).toMatchObject({
      reason: 'NOT_WRITTEN_BY_EXIT',
      blacklistId: page.id,
    });
    expect(await blockedByBlacklist(x, x.employee.id)).toBe(true);
  });

  it('这笔离职的行已被手动移出、之后页面又新增了一条：撤销不动任何一条，页面那条仍有效', async () => {
    const x = await world('cancel-removed-then-readded');
    const leave = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', MANUAL);
    const [written] = (await x.page.list()).items;
    expect((await x.page.remove([{ id: written!.id, revision: written!.revision }])).status).toBe(200);
    const readded = await x.page.added({ employeeId: x.employee.id, reason: 'resignation' });
    await x.cancelExit(leave.id);
    const rows = await x.rows(x.employee.id);
    expect(rows.find((row) => row.id === written!.id)).toMatchObject({ status: 'removed', exitRequestId: leave.id });
    expect(rows.find((row) => row.id === readded.id)).toMatchObject({ status: 'active', exitRequestId: null });
    expect((await x.auditActions(leave.id, 'exit.blacklist.revoke_skipped'))[0]!.after).toMatchObject({
      reason: 'BLACKLIST_ALREADY_REMOVED',
      blacklistId: written!.id,
    });
    expect(await blockedByBlacklist(x, x.employee.id)).toBe(true);
  });

  it('这笔离职的行已过有效截止日期：不动（仍是过期的 active），审计留痕，撤销照常完成', async () => {
    const x = await world('cancel-expired');
    const leave = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', {
      ...MANUAL,
      blacklistExpiryDate: TODAY,
    });
    x.setNow('2026-10-08T01:00:00.000Z');
    const cancelled = await x.cancelExit(leave.id);
    expect(cancelled.status).toBeDefined();
    expect(await x.rows(x.employee.id)).toEqual([
      expect.objectContaining({ status: 'active', expiryDate: TODAY, exitRequestId: leave.id }),
    ]);
    expect((await x.auditActions(leave.id, 'exit.blacklist.revoke_skipped'))[0]!.after).toMatchObject({
      reason: 'BLACKLIST_EXPIRED',
    });
  });

  it('撤销未生效的离职（approved）：不进入回收，本人另有的手动新增行不变，也没有回收 / 跳过审计', async () => {
    const x = await world('cancel-approved');
    const page = await x.page.added({ employeeId: x.employee.id, reason: 'resignation' });
    const leave = await x.directLeave('2026-10-10', MANUAL);
    const cancelled = await x.cancelExit(leave.id);
    expect(cancelled.cancellation.case).toBe('approved_voided');
    expect(await x.rows(x.employee.id)).toEqual([expect.objectContaining({ id: page.id, status: 'active' })]);
    expect(await x.auditActions(leave.id, 'exit.blacklist.revoked')).toEqual([]);
    expect(await x.auditActions(leave.id, 'exit.blacklist.revoke_skipped')).toEqual([]);
  });

  it('黑名单页手动移出仍记实际操作的 HR（行 removed_by 与 blacklist.remove 审计）', async () => {
    const x = await world('manual-remove-actor');
    const entry = await x.page.added({ employeeId: x.employee.id, reason: 'resignation' });
    expect((await x.page.remove([{ id: entry.id, revision: entry.revision }])).status).toBe(200);
    expect(await removal(x, entry.id)).toEqual({ removedBy: x.session.user.id, actor: x.session.user.id });
  });
});
