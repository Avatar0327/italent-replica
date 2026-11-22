import { and, eq, permissionUserPersonLinks, type OnboardingEntryCase, type Tx } from '@italent/db';
import { ENTRY_INFO_COLLECTION_PROCESS } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { revokeBySystem } from '../approval/actions.js';
import type { BusinessAdapter } from '../approval/adapters.js';
import type { ApprovalContext } from '../approval/context.js';
import { loadVersion } from '../approval/definitions.js';
import { activeInstanceOf } from '../approval/store.js';
import { loadRecusalFacts } from '../approval/subjects.js';
import type { EntryLifecycleContext } from '../employment/onboarding-entry-port.js';
import { COLLECTION, requireCollectionTarget } from './collection-access.js';
import {
  collectionApprovalVisibility,
  collectionApprovalFields,
  COLLECTION_VALUES,
} from './collection-approval-fields.js';
import { landApprovedSubmission } from './collection-submit.js';
import {
  latestCollectionSubmission,
  lockCollectionBinding,
  staleCollection,
  updateCollectionLanding,
} from './collection-submit-store.js';
import { closeCollectionTasks, loadCollectionTask } from './collection-tasks.js';

const businessType = 'entry_info_collection' as const;

async function currentApproval(tx: Tx, ctx: ApprovalContext, taskId: string) {
  const binding = await lockCollectionBinding(tx, ctx, taskId);
  const { stage, task, business } = binding;
  if (stage.state !== 'pending' || task.status !== 'in_review') return staleCollection();
  const submitted = await latestCollectionSubmission(tx, ctx.tenantId, taskId);
  const instance = await activeInstanceOf(tx, ctx.tenantId, businessType, taskId, false);
  if (
    !instance ||
    instance.status !== 'running' ||
    instance.id !== task.approvalInstanceId ||
    instance.businessVersion !== submitted.id ||
    submitted.employeeId !== stage.employeeId ||
    submitted.businessId !== stage.currentBusinessId ||
    submitted.caseRevision !== stage.revision ||
    submitted.businessRevision !== business.revision
  )
    return staleCollection();
  return { binding, submitted, instance };
}

async function guardDecision(tx: Tx, ctx: ApprovalContext, taskId: string, nodeKey?: string) {
  const current = await currentApproval(tx, ctx, taskId);
  const { submitted, instance } = current;
  const links = permissionUserPersonLinks;
  const [self] = await tx
    .select({ employeeId: links.employeeId })
    .from(links)
    .where(
      and(eq(links.tenantId, ctx.tenantId), eq(links.userId, ctx.userId), eq(links.employeeId, submitted.employeeId)),
    );
  const recusal = await loadRecusalFacts(tx, ctx.tenantId, instance);
  if (self || ctx.userId === instance.initiatorUserId || recusal.subjectUserIds.has(ctx.userId)) {
    throw new AppError('FORBIDDEN', '不能办理本人的采集审批', { reason: 'COLLECTION_SELF_REVIEW' });
  }
  const { handlingAuthorize } = ctx;
  if (!handlingAuthorize) throw new AppError('FORBIDDEN', '缺少采集审批的当前授权');
  const { foreignFields } = await collectionApprovalFields(tx, ctx, submitted);
  if (foreignFields.length) {
    const version = await loadVersion(tx, ctx.tenantId, instance.versionId);
    const node = version.nodes.find((node) => node.key === (nodeKey ?? instance.currentNodeKey));
    if (!node?.formFields.includes(COLLECTION_VALUES))
      throw new AppError('FORBIDDEN', '采集字段未配置在当前审批节点表单', { reason: 'APPROVAL_BLIND_REVIEW' });
  }
  const deps = { authorize: handlingAuthorize, clock: () => ctx.now };
  await requireCollectionTarget(tx, deps, ctx, submitted.businessId, 'read');
  const visible = collectionApprovalVisibility(tx, deps, ctx);
  for (const field of foreignFields) {
    if (!(await visible(field)))
      throw new AppError('FORBIDDEN', '采集审批含当前不可查看字段', { reason: 'APPROVAL_BLIND_REVIEW' });
  }
  return { ...current, authorize: handlingAuthorize };
}

async function endWithoutLanding(tx: Tx, ctx: ApprovalContext, taskId: string, status: 'returned' | 'closed') {
  const {
    binding: { stage, task },
    submitted,
  } = await currentApproval(tx, ctx, taskId);
  await updateCollectionLanding(
    tx,
    ctx,
    stage,
    task,
    status,
    submitted.id,
    status === 'returned' ? 'return' : 'disapprove',
  );
}

async function unavailable(): Promise<never> {
  throw new AppError('CONFLICT', '采集单由受信采集端口处理', { reason: 'ENTRY_INFO_COLLECTION_ACTION_UNAVAILABLE' });
}

export const collectionApprovalAdapter: BusinessAdapter = {
  async lock(tx, ctx, taskId) {
    await lockCollectionBinding(tx, ctx, taskId);
  },
  async snapshot(tx, ctx, taskId) {
    const submitted = await latestCollectionSubmission(tx, ctx.tenantId, taskId);
    const { values, foreignFields } = await collectionApprovalFields(tx, ctx, submitted);
    return {
      approvalType: businessType,
      businessType,
      businessId: taskId,
      businessDate: submitted.pendingDate,
      fieldObjectCode: COLLECTION,
      profileFields: [],
      subjectEmployeeId: submitted.employeeId,
      title: '入职前信息采集',
      values,
      foreignFields,
      originals: null,
      changedFields: Object.keys(values),
      conditionValues: { processCode: ENTRY_INFO_COLLECTION_PROCESS, 'record.departmentId': submitted.departmentId },
      latestDepartmentId: submitted.departmentId,
      recordDepartmentId: submitted.departmentId,
      version: submitted.id,
      processCode: ENTRY_INFO_COLLECTION_PROCESS,
    };
  },
  async beforeApprove(tx, ctx, id, nodeKey) {
    await guardDecision(tx, ctx, id, nodeKey);
  },
  async approved(tx, ctx, id) {
    const { binding, submitted, authorize } = await guardDecision(tx, ctx, id);
    await landApprovedSubmission(tx, ctx, authorize, binding, submitted);
  },
  rejected: (tx, ctx, id) => endWithoutLanding(tx, ctx, id, 'returned'),
  disapproved: (tx, ctx, id) => endWithoutLanding(tx, ctx, id, 'closed'),
  withdrawn: unavailable,
  resubmit: unavailable,
  edit: unavailable,
};

/** 阶段失效时同步收口审批待办。普通改期只关闭基于旧待入职版本的已提交采集。 */
export async function retireCollectionSubmission(
  tx: Tx,
  ctx: EntryLifecycleContext,
  stage: OnboardingEntryCase,
  replacement: boolean,
) {
  const task = await loadCollectionTask(tx, ctx.tenantId, stage.id);
  if (!task || (replacement && !['in_review', 'returned', 'rehire_pending'].includes(task.status))) return;
  if (task.approvalInstanceId && ['in_review', 'draft', 'returned'].includes(task.status)) {
    await revokeBySystem(
      tx,
      {
        ...ctx,
        userId: ctx.userId ?? SYSTEM_USER_ID,
        actorUserId: null,
        expectedRevision: 0,
      },
      task.approvalInstanceId,
      '待入职阶段已变更，采集审批终止',
    );
  }
  await closeCollectionTasks(tx, ctx, stage);
}
