/**
 * F-328 / DEC-707：离职后重聘（合并人员）沿用原人员与原账号（docs/02_业务建模/30「F-328」节）。
 * 重聘入职落地的同一事务里：登录用户名改为员工联系邮箱（无联系邮箱不改）；紧挨着的前一段离职若由本规则自动停用了账号，
 * 登记恢复请求（DEC-684 同一持久任务）。入职日已到时在本事务内启用，启用失败整单回滚（返工 P1-1）；
 * 入职日未到、账号同属其他租户或本租户另有到期停用时，交回提交后的离职账号任务（入职日到了再启用）。
 * 重聘失效（删除、改期替换、取消入职）时撤回恢复请求，已自动启用的账号按离职事实重新停用（返工 P2-1 / P2-2）。
 * 人工停用 / 人工改过的账号不认领（DEC-685③、DEC-711 c）；不碰激活状态。退休返聘（retire_rehire）不在本单范围。
 */
import { eq, exitAccountTasks, permissionUserPersonLinks, sql, type Tx } from '@italent/db';
import { ENTRY_STATUS, tenantLocalDate } from '@italent/domain';
import { changeRehireLoginEmail, enableRehireAccount } from '../permission/user-provisioning.js';
import { consumeAccountAfterCommit, saveTask, taskKey, type AccountTask } from './exit-account-store.js';
import { facts, type EnterTenant } from './exit-account-worker.js';
import { rowsOf } from './record-store.js';
import type { EmployeeStatusHookContext, EmploymentRecordEvent } from './status-hooks.js';

type RehireEvent = Pick<EmploymentRecordEvent, 'employeeId' | 'kind' | 'effectiveDate'>;

async function boundUser(tx: Tx, employeeId: string) {
  const [link] = await tx
    .select({ userId: permissionUserPersonLinks.userId })
    .from(permissionUserPersonLinks)
    .where(eq(permissionUserPersonLinks.employeeId, employeeId));
  return link?.userId ?? null;
}

const lockTask = async (tx: Tx, tenantId: string, businessId: string) =>
  (await tx.select().from(exitAccountTasks).where(taskKey(tenantId, businessId)).for('update'))[0];

export async function applyRehireAccount(tx: Tx, ctx: EmployeeStatusHookContext, event: EmploymentRecordEvent) {
  if (event.kind !== 'rehire') return;
  const userId = await boundUser(tx, event.employeeId);
  if (!userId) return;
  const [person] = rowsOf<{ email: string | null; leaveId: string | null; cancelled: boolean }>(
    await tx.execute(sql`
      SELECT (SELECT NULLIF(btrim(v.email), '') FROM personnel_employee_versions v
          WHERE v.tenant_id=me.tenant_id AND v.employee_id=me.employee_id ORDER BY v.revision DESC LIMIT 1) AS email,
        (SELECT r.id FROM employment_timeline t
          JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
          WHERE t.tenant_id=me.tenant_id AND t.employee_id=me.employee_id
            AND (t.start_date, t.sort_order) < (me.start_date, me.sort_order)
          ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1) AS "leaveId",
        COALESCE((SELECT s.entry_status FROM employment_record_status(me.tenant_id, me.record_id) s)
          = ${ENTRY_STATUS.cancelled}, false) AS cancelled
      FROM employment_timeline me WHERE me.tenant_id=${ctx.tenantId} AND me.record_id=${event.recordId}::uuid`),
  );
  // 编辑已取消的待入职（仍是取消状态）也会经这里落地：取消的重聘不沿用账号
  if (person?.cancelled) return;
  const renamed = person?.email ? await changeRehireLoginEmail(tx, ctx, userId, person.email) : null;
  if (!person?.leaveId) return;
  const task = await lockTask(tx, ctx.tenantId, person.leaveId);
  if (!task || task.userId !== userId) return;
  const write = { ...ctx, expectedRevision: task.revision };
  // 改名使账号 revision +1：本规则停用时记下的 revision 一并前移，否则恢复判定会当成人工改动而不再认领
  const autoRevision =
    renamed && task.autoRevision === renamed.beforeRevision ? renamed.afterRevision : task.autoRevision;
  const requested = await saveTask(tx, write, task, { restoreRequested: true, commandId: ctx.commandId, autoRevision });
  if (requested && event.effectiveDate <= tenantLocalDate(ctx.now, ctx.timezone)) await enableNow(tx, ctx, requested);
  consumeAccountAfterCommit(tx, write, task.businessId);
}

/**
 * 当天重聘：启用与改名、任职链、账号任务同一提交边界（返工 P1-1）。判定沿用离职账号任务的事实（facts），
 * 本租户还有到期的停用任务时不启用；账号同属其他租户（须全局协调各租户的到期任务）或已被人工改过时，
 * 迁移函数不动账号，留给提交后的离职账号任务按原协议处理。
 */
async function enableNow(tx: Tx, ctx: EmployeeStatusHookContext, task: AccountTask) {
  if (task.autoRevision === null) return;
  const inTx: EnterTenant = (_tenantId, run) => run(tx);
  const plan = await facts(inTx, [{ id: ctx.tenantId, timezone: ctx.timezone }], task.userId, ctx.now);
  if (plan.some((f) => f.due) || !plan.some((f) => f.task.businessId === task.businessId && f.terminal)) return;
  const revision = await enableRehireAccount(tx, ctx, task.userId, task.autoRevision);
  if (revision === null) return;
  // 记下启用后的 revision：重聘失效时据此判断账号是否仍是本规则启用后的状态（人工改过不再认领）
  await saveTask(tx, { ...ctx, expectedRevision: task.revision }, task, {
    status: 'restored',
    restoreRequested: false,
    autoRevision: revision,
    reason: null,
    recipientUserIds: [],
  });
}

/**
 * 重聘失效（删除已生效重聘、改期 / 编辑换日期的替换、取消入职）时撤回本规则对前一段离职账号任务的恢复：
 * 未执行的恢复请求撤销；账号仍是本规则自动启用后的 revision 时，任务交回待办，提交后由离职账号任务按离职事实
 * 重新停用并记审计（DEC-711 d；登录名不回滚）。账号被人工改过（revision 不等）不认领，保留人工修改。
 */
export async function withdrawRehireAccount(tx: Tx, ctx: EmployeeStatusHookContext, event: RehireEvent) {
  if (event.kind !== 'rehire') return;
  const userId = await boundUser(tx, event.employeeId);
  if (!userId) return;
  // 删除时重聘记录已移出时间轴，按入职日找它之前最近一段带账号任务的离职
  const [leave] = rowsOf<{ businessId: string }>(
    await tx.execute(sql`SELECT k.business_id AS "businessId" FROM exit_account_tasks k
      JOIN employment_timeline t ON t.tenant_id=k.tenant_id AND t.record_id=k.business_id
      WHERE k.tenant_id=${ctx.tenantId} AND k.employee_id=${event.employeeId}::uuid AND k.user_id=${userId}::uuid
        AND t.start_date<=${event.effectiveDate}::date
      ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1`),
  );
  if (!leave) return;
  const task = await lockTask(tx, ctx.tenantId, leave.businessId);
  if (!task) return;
  const [account] = rowsOf<{ status: string; revision: number }>(
    await tx.execute(sql`SELECT status, revision FROM tenant_member_accounts(ARRAY[${userId}]::uuid[])`),
  );
  const reclaim = task.status === 'restored' && account?.status === 'active' && account.revision === task.autoRevision;
  if (!reclaim && !task.restoreRequested) return;
  const write = { ...ctx, expectedRevision: task.revision };
  const status = reclaim ? { status: 'pending' as const } : {};
  await saveTask(tx, write, task, { restoreRequested: false, commandId: ctx.commandId, ...status });
  if (reclaim) consumeAccountAfterCommit(tx, write, task.businessId);
}
