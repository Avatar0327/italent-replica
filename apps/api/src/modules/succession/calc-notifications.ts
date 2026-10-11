/** §1.5 / §8.4：通知表即持久化 outbox，只存引用；没有用户可见内容或冻结计数。 */
import { and, eq, sql, type Db, type Tx, withTenant, successionNotifications as notifications } from '@italent/db';
import type { CalcRun } from './calc-contract.js';
import { rowsOf } from './read-sql.js';

export async function enqueueCalcDone(tx: Tx, run: CalcRun, now: Date): Promise<void> {
  if (!run.requestedBy) return;
  await tx.execute(sql`INSERT INTO succession_notifications
    (tenant_id,run_id,recipient_user_id,kind,command_id,created_at)
    SELECT ${run.tenantId}::uuid,${run.id}::uuid,${run.requestedBy}::uuid,
      'calc_done',${run.commandId},${now.toISOString()}::timestamptz
    WHERE succession_calc_user_active(${run.tenantId}::uuid,${run.requestedBy}::uuid)
    ON CONFLICT (tenant_id,subject_id,recipient_user_id,kind) DO NOTHING`);
}
export type CalcNotification = typeof notifications.$inferSelect;
/** 队列游标只供可信消费者；用户读取另走 B3b 的当前权限投影。新一轮从头扫描以包含已知失败重试。 */
export async function pendingCalcNotifications(
  tx: Tx,
  tenantId: string,
  after?: { createdAt: Date; id: string },
): Promise<CalcNotification[]> {
  return tx
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        sql`${notifications.state} IN ('pending','failed')`,
        after
          ? sql`(${notifications.createdAt},${notifications.id}) >
              (${after.createdAt.toISOString()}::timestamptz,${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(notifications.createdAt, notifications.id)
    .limit(200);
}
/** 仅在渠道已按通知 id 回查并给出确切结论后调用；旧 attempt 的回执不能覆盖新一次投递。 */
export async function settleCalcNotification(
  tx: Tx,
  tenantId: string,
  id: string,
  attemptNo: number,
  state: 'sent' | 'failed' | 'unknown',
  now: Date,
): Promise<void> {
  await tx
    .update(notifications)
    .set({ state, sentAt: state === 'sent' ? now : null })
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.id, id),
        eq(notifications.attemptNo, attemptNo),
        eq(notifications.state, 'unknown'),
      ),
    );
}
/** 调用方按 (createdAt,id) 有界拉取 pending/failed。投递器必须以通知 id 去重，并在发送前按当前权限
 * 投影（B3b），内容仅 run/batch ID 与可见计数。没有投递器不标 sent。
 * 先持久标 unknown 再外发；崩溃/超时保持 unknown，只能经渠道回查确认，禁止直接重发。 */
export async function deliverCalcNotification(
  db: Db,
  tenantId: string,
  id: string,
  deliver: (notice: CalcNotification) => Promise<'sent' | 'failed' | 'unknown'>,
  now = new Date(),
): Promise<void> {
  const where = and(eq(notifications.tenantId, tenantId), eq(notifications.id, id));
  const notice = await withTenant(db, tenantId, async (tx) => {
    const [row] = await tx.select().from(notifications).where(where).for('update');
    if (!row || !['pending', 'failed'].includes(row.state)) return;
    const active = await tx.execute(
      sql`SELECT succession_calc_user_active(${tenantId}::uuid,${row.recipientUserId}::uuid) AS active`,
    );
    if (!rowsOf<{ active: boolean }>(active)[0]?.active) return;
    const [claimed] = await tx
      .update(notifications)
      .set({ state: 'unknown', attemptNo: row.attemptNo + 1 })
      .where(where)
      .returning();
    return claimed;
  });
  if (!notice) return;
  let state: 'sent' | 'failed' | 'unknown' = 'unknown';
  try {
    state = await deliver(notice);
  } catch {
    /* 投递结果未知，不能假记 failed 再重发。 */
  }
  await withTenant(db, tenantId, (tx) => settleCalcNotification(tx, tenantId, id, notice.attemptNo, state, now));
}
