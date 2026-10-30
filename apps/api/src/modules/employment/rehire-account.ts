/**
 * F-328 / DEC-707：离职后重聘（合并人员）沿用原人员与原账号（docs/02_业务建模/30「F-328」节）。
 * 重聘入职落地的同一事务里：登录用户名改为员工联系邮箱（无联系邮箱不改）；紧挨着的前一段离职若由本规则自动停用了账号，
 * 登记恢复请求，提交后由离职账号任务启用（DEC-684 同一持久任务；入职日未到时任务按 terminal 判定等到当天）。
 * 人工停用的账号不认领（DEC-685③）；不碰激活状态。退休返聘（retire_rehire）不在本单范围。
 */
import { eq, exitAccountTasks, permissionUserPersonLinks, sql, type Tx } from '@italent/db';
import { changeRehireLoginEmail } from '../permission/user-provisioning.js';
import { consumeAccountAfterCommit, saveTask, taskKey } from './exit-account-store.js';
import { rowsOf } from './record-store.js';
import type { EmployeeStatusHookContext, EmploymentRecordEvent } from './status-hooks.js';

export async function applyRehireAccount(tx: Tx, ctx: EmployeeStatusHookContext, event: EmploymentRecordEvent) {
  if (event.kind !== 'rehire') return;
  const [link] = await tx
    .select({ userId: permissionUserPersonLinks.userId })
    .from(permissionUserPersonLinks)
    .where(eq(permissionUserPersonLinks.employeeId, event.employeeId));
  if (!link) return;
  const [person] = rowsOf<{ email: string | null; leaveId: string | null }>(
    await tx.execute(sql`
      SELECT (SELECT NULLIF(btrim(v.email), '') FROM personnel_employee_versions v
          WHERE v.tenant_id=me.tenant_id AND v.employee_id=me.employee_id ORDER BY v.revision DESC LIMIT 1) AS email,
        (SELECT r.id FROM employment_timeline t
          JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
          WHERE t.tenant_id=me.tenant_id AND t.employee_id=me.employee_id
            AND (t.start_date, t.sort_order) < (me.start_date, me.sort_order)
          ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1) AS "leaveId"
      FROM employment_timeline me WHERE me.tenant_id=${ctx.tenantId} AND me.record_id=${event.recordId}::uuid`),
  );
  const renamed = person?.email ? await changeRehireLoginEmail(tx, ctx, link.userId, person.email) : null;
  if (!person?.leaveId) return;
  const [task] = await tx.select().from(exitAccountTasks).where(taskKey(ctx.tenantId, person.leaveId)).for('update');
  if (!task || task.userId !== link.userId) return;
  const write = { ...ctx, expectedRevision: task.revision };
  // 改名使账号 revision +1：本规则停用时记下的 revision 一并前移，否则恢复判定会当成人工改动而不再认领
  const autoRevision =
    renamed && task.autoRevision === renamed.beforeRevision ? renamed.afterRevision : task.autoRevision;
  await saveTask(tx, write, task, { restoreRequested: true, commandId: ctx.commandId, autoRevision });
  consumeAccountAfterCommit(tx, write, task.businessId);
}
