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
  type Tx,
} from '@italent/db';
import { ENTRY_STATUS } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { lockPendingEntry } from '../employment/employee-status.js';
import { entryCaseContext } from '../employment/entry-case.js';
import { entryLifecyclePort, type EntryCaseWriteRef } from '../employment/onboarding-entry-port.js';
import type { EmploymentContext } from '../employment/types.js';
import { withdrawPersonnelData } from '../personnel/subset-withdraw.js';
import { auditTask, collectionReceipt } from './collection-tasks.js';
import { taskFilter } from './collection-submit-store.js';

export interface CollectionWithdrawContext extends EmploymentContext {
  readonly authorize: Authorizer;
}

export interface CollectionWithdrawTarget extends EntryCaseWriteRef {
  readonly taskId: string;
}

/** 候选人真实性复核端口：真实现随候选人真实性契约开通；内部验收传合成桩。 */
export interface CandidateIdentityPort {
  verify(tx: Tx, subject: { tenantId: string; taskId: string; employeeId: string }): Promise<boolean>;
}

export interface CollectionWithdrawReceipt {
  readonly id: string;
  readonly revision: number;
  readonly status: 'withdrawn';
  readonly notificationStatus: 'unavailable';
}

const MAX_REMARK = 200;
const refused = (reason: string, message: string) => new AppError('CONFLICT', message, { reason });

function cleanRemark(value: string): string {
  const remark = value.trim();
  if (!remark || remark.length > MAX_REMARK)
    throw new AppError('VALIDATION_FAILED', `撤回备注必填，且不超过 ${MAX_REMARK} 字`);
  return remark;
}

/** 曾提交值从普通读、协作及通知投影撤下：版本行保留，值收回为空壳（设计 §4.1 第 7 条）。 */
async function redactSubmissions(tx: Tx, tenantId: string, taskId: string) {
  await tx
    .update(submissions)
    .set({ values: { profileRevision: 0, profile: {}, subsets: [] } })
    .where(and(eq(submissions.tenantId, tenantId), eq(submissions.taskId, taskId)));
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
  const { record } = await lockPendingEntry(
    tx,
    { ...ctx, expectedRevision: target.businessRevision },
    target.businessId,
  );
  // 候选人身份复核先于一切 §4.1 动作，也先于状态类提示，避免未验证者探测阶段状态
  if (!(await identity.verify(tx, { tenantId: ctx.tenantId, taskId: target.taskId, employeeId: target.employeeId })))
    throw new AppError('FORBIDDEN', '候选人身份未通过，不能撤回');
  if (record.entryStatus !== ENTRY_STATUS.cancelled)
    throw refused('ENTRY_NOT_CANCELLED', '只有已取消的待入职可以撤回采集');
  // 只有新增入职可撤回；重聘 / 返聘的个人资料来自历史任职，不得清空
  if (record.kind !== 'hire') throw refused('COLLECTION_WITHDRAW_REHIRE', '重聘或返聘入职不可撤回');
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
  await redactSubmissions(tx, ctx.tenantId, task.id);
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
