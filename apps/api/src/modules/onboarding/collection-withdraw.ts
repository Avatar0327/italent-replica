/**
 * 16a-2c 采集撤回受信内核（设计 R2-T01 §4.1 第 7 条 EN-R9、§5 撤回授权）。
 * 撤回授权绑定已取消阶段和原候选人，单次消费：消费 = 任务落到 withdrawn；恢复待入职、删除、已撤回时阶段 / 任务状态
 * 不再满足，自然失效。生产公开执行路由保持未注册，候选人真实性契约开通前只作内部验收（身份端口无生产实现）。
 * 整条流程在调用方事务里，任一步失败整体回滚。
 */
import {
  and,
  eq,
  onboardingCollectionSubmissions as submissions,
  onboardingCollectionTasks as tasks,
  sql,
  type Tx,
} from '@italent/db';
import { EMPLOYEE_STATUS, ENTRY_STATUS } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { lockPendingEntry } from '../employment/employee-status.js';
import { entryCaseContext } from '../employment/entry-case.js';
import { entryLifecyclePort, type EntryCaseWriteRef } from '../employment/onboarding-entry-port.js';
import type { EmploymentContext } from '../employment/types.js';
import { rows } from '../personnel/store.js';
import { withdrawPersonnelData } from '../personnel/subset-withdraw.js';
import { auditTask, collectionReceipt } from './collection-tasks.js';
import { taskFilter } from './collection-submit-store.js';

export interface CollectionWithdrawContext extends EmploymentContext {
  readonly authorize: Authorizer;
}

export interface CollectionWithdrawTarget extends EntryCaseWriteRef {
  readonly taskId: string;
}

/**
 * 撤回授权（设计 §5）：候选人真实性复核通过后签发，绑定用途、原候选人、任务与签发时的取消版本（业务头 id + revision）。
 * 内核在锁内逐项匹配，任一项不符即拒绝；消费 = 任务落到 withdrawn，同一授权不可再用。
 */
export interface CollectionWithdrawGrant {
  readonly purpose: 'collection_withdraw';
  readonly employeeId: string;
  readonly taskId: string;
  /** 取消发生在哪条业务头、取消后的 revision：改期恢复会换新业务头，旧授权的 id 对不上，同号 revision 也不能冒用。 */
  readonly cancelledBusinessId: string;
  readonly cancelledBusinessRevision: number;
}

/** 候选人真实性复核端口：真实现随候选人真实性契约开通；内部验收传合成桩。未通过返回 null。 */
export interface CandidateIdentityPort {
  verify(
    tx: Tx,
    subject: { tenantId: string; taskId: string; employeeId: string },
  ): Promise<CollectionWithdrawGrant | null>;
}

export interface CollectionWithdrawReceipt {
  readonly id: string;
  readonly revision: number;
  readonly status: 'withdrawn';
  readonly notificationStatus: 'unavailable';
}

const MAX_REMARK = 200;
const refused = (reason: string, message: string) => new AppError('CONFLICT', message, { reason });
const withdrawnRehire = () => refused('COLLECTION_WITHDRAW_REHIRE', '重聘或返聘入职不可撤回');

function cleanRemark(value: string): string {
  const remark = value.trim();
  if (!remark || remark.length > MAX_REMARK)
    throw new AppError('VALIDATION_FAILED', `撤回备注必填，且不超过 ${MAX_REMARK} 字`);
  return remark;
}

/** 授权在员工 / 业务头锁内与当前取消版本逐项匹配；改期恢复再取消会推进业务头 revision，旧授权随之失效。 */
function requireGrant(grant: CollectionWithdrawGrant, target: CollectionWithdrawTarget, cancelledRevision: number) {
  if (
    grant.purpose !== 'collection_withdraw' ||
    grant.employeeId !== target.employeeId ||
    grant.taskId !== target.taskId ||
    grant.cancelledBusinessId !== target.businessId ||
    grant.cancelledBusinessRevision !== cancelledRevision
  )
    throw new AppError('FORBIDDEN', '撤回授权与当前取消不符，请重新验证', {
      reason: 'COLLECTION_WITHDRAW_GRANT_STALE',
    });
}

/**
 * 曾入职判定读任职历史事实，不依赖履历同步开关：本人除这条待入职记录外，只要存在人员状态已越过“待入职”的
 * 任职记录（含离职后以 hire 开新周期的人），就不是新人，不得清档。须在员工锁内调用。
 */
async function requireNeverEmployed(tx: Tx, tenantId: string, employeeId: string, recordId: string) {
  const found = await tx.execute(sql`SELECT 1 FROM employment_records r
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    WHERE r.tenant_id=${tenantId} AND r.employee_id=${employeeId}::uuid AND r.id<>${recordId}::uuid
      AND COALESCE((SELECT p.employee_status FROM employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1), r.employee_status)<>${EMPLOYEE_STATUS.pendingEntry} LIMIT 1`);
  if (rows(found).length) throw withdrawnRehire();
}

export async function withdrawCollection(
  tx: Tx,
  ctx: CollectionWithdrawContext,
  target: CollectionWithdrawTarget,
  input: { readonly remark: string },
  identity: CandidateIdentityPort,
): Promise<CollectionWithdrawReceipt> {
  const remark = cleanRemark(input.remark);
  // 取锁顺序同采集写：员工 → 业务头 → 阶段 → 任务（§6.2）
  const { business, record } = await lockPendingEntry(
    tx,
    { ...ctx, expectedRevision: target.businessRevision },
    target.businessId,
  );
  // 候选人身份复核先于一切 §4.1 动作，也先于状态类提示，避免未验证者探测阶段状态
  const grant = await identity.verify(tx, {
    tenantId: ctx.tenantId,
    taskId: target.taskId,
    employeeId: target.employeeId,
  });
  if (!grant) throw new AppError('FORBIDDEN', '候选人身份未通过，不能撤回');
  requireGrant(grant, target, business.revision);
  if (record.entryStatus !== ENTRY_STATUS.cancelled)
    throw refused('ENTRY_NOT_CANCELLED', '只有已取消的待入职可以撤回采集');
  // 只有新增入职可撤回；重聘 / 返聘的个人资料来自历史任职，不得清空
  if (record.kind !== 'hire') throw withdrawnRehire();
  await requireNeverEmployed(tx, ctx.tenantId, target.employeeId, record.id);
  const lifecycle = entryCaseContext(ctx);
  const stage = await entryLifecyclePort().lockForWrite(tx, lifecycle, target, ['cancelled']);
  const [task] = await tx.select().from(tasks).where(taskFilter(ctx.tenantId, target.taskId)).for('update');
  if (!task || task.caseId !== stage.id) throw new AppError('NOT_FOUND', '采集任务不存在');
  if (task.status === 'withdrawn') throw refused('COLLECTION_ALREADY_WITHDRAWN', '采集已撤回');
  if (ctx.expectedRevision !== task.revision) throw new AppError('REVISION_CONFLICT', '采集任务已变更，请刷新后重提');
  const [submitted] = await tx
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.tenantId, ctx.tenantId), eq(submissions.taskId, task.id)))
    .limit(1);
  if (!submitted) throw refused('COLLECTION_NOTHING_TO_WITHDRAW', '该阶段没有可撤回的采集内容');

  await withdrawPersonnelData(tx, { ...ctx, expectedRevision: 0 }, target.employeeId, record.id, task.id);
  const revision = task.revision + 1;
  const [updated] = await tx
    .update(tasks)
    .set({
      status: 'withdrawn',
      revision,
      withdrawnAt: ctx.now,
      withdrawRemark: remark,
      nextRemindOn: null,
      updatedAt: ctx.now,
      updatedBy: lifecycle.userId,
    })
    .where(taskFilter(ctx.tenantId, task.id))
    .returning();
  await auditTask(
    tx,
    lifecycle,
    stage,
    'withdraw',
    task,
    { status: task.status, revision: task.revision },
    { status: 'withdrawn', revision, remark },
  );
  return { ...collectionReceipt(updated!), status: 'withdrawn' };
}
