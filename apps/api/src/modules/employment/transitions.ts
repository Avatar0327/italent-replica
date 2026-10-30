import { reverseCarriedEstablishment, assertReleasedEstablishment } from '../establishment/carried-transfer.js';
import { postponeLateTransfer } from './late-transfer.js';
import { activationFailureOf, assertEstablishmentCapacity } from './activation-checks.js';
import { lockTransferBusiness } from './transfer-locks.js';
import { assertEmploymentDepartmentAvailable } from './references.js';
import { personnelHooks } from './personnel-hooks.js';
import { employeeStatusHooks } from './status-hooks.js';
import { randomUUID } from 'node:crypto';
import { sql, type Db, type Tx } from '@italent/db';
import { resolveLateExecution, tenantLocalDate } from '@italent/domain';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import { assertRegularizationNotPropagated } from './employee-status.js';
import { releasePendingContract } from './entry-pending-contract.js';
import { clearPendingProbation } from './entry-probation.js';
import { assertProbationProcessesIdle } from './probation-guard.js';
import { retireRehireActivationDecision } from './retire-rehire-eligibility.js';
import {
  activationPredecessors,
  PREDECESSOR_FAILED,
  recordActivationAttempt,
  unresolvedPredecessor,
} from './activation-store.js';
import { assertPredecessorsSettled, blockingPredecessors } from './linkage-dependency.js';
import { auditEmployment } from './context.js';
import { confirmExit } from './exit-confirmation.js';
import { restoreAfterExitDeletion } from './exit-restore.js';
import { activateExit, activateIfDue } from './exit-activation.js';
import { isExitKind, loadExitRequest, requireExitGate, saveAck } from './exit-gate.js';
import { findPredecessor, loadEmploymentRecord, snapshotFields } from './read-model.js';
import { resolveEffectiveInheritance } from './inheritance.js';
import {
  bumpEmploymentBusiness,
  camelRow,
  insertEmploymentRow,
  lockEmploymentBusiness,
  rowsOf,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { isDetachedRecord, loadPlannedEffectiveDate, removeEmploymentTimeline } from './timeline.js';
import { assertNoLinkedChanges, assertNoPendingApplication, assertRestoredPredecessor } from './deletion-guards.js';
import type {
  BusinessKind,
  EmploymentBusiness,
  EmploymentContext,
  EmploymentRecord,
  EmploymentState,
} from './types.js';
import { assertRequiredTransferFields } from '../transfer/required-fields.js';
import { requireEmployeeTransferBusiness } from '../transfer/employee-policy.js';
import { assertTransferLinkageSubmittable } from '../transfer/linkage/service.js';
import {
  appendEmploymentState,
  assertBusinessSequence,
  materializeEmploymentRecord,
  NEW_CYCLE_KINDS,
  requireSavedBusiness,
} from './write-service.js';

const ACTIONS = ['submit', 'approve', 'reject', 'disapprove', 'withdraw', 'revoke', 'activate', 'delete'] as const;
/**
 * 只追加一条状态事件的动作。撤回回到草稿（AC-TRF-28）；驳回可在同一申请上修改重提（DEC-053）；审批沿「不同意」
 * 流转到结束则办结为“未通过”、不生效（DEC-144，F-003 第二轮）；HR 撤销未审批完成的申请置“作废”，不生成任职，
 * 之后只能删除（R1-T11，AC-TRF-07 / W-224）。
 */
const STATE_AFTER = {
  submit: 'in_review',
  reject: 'rejected',
  disapprove: 'disapproved',
  withdraw: 'draft',
  revoke: 'voided',
} as const satisfies Partial<Record<(typeof ACTIONS)[number], EmploymentState>>;

export interface EmploymentTransitionInput {
  readonly id: string;
  readonly action: (typeof ACTIONS)[number];
  /** 离职提交时的在途调动确认令牌（R2-T03 §8）；其他业务不接受。 */
  readonly ack?: string;
  /**
   * 只有离职撤销入口（exit-cancel.ts cancelExit，已按 §6B 做区间变化校验）传入：通用 revoke / delete 对离职单一律 409
   * USE_EXIT_CANCEL，不留绕过 §6B 的删除路径（设计 §4 / §18.1 末段）。
   */
  readonly cancelling?: true;
  /** F-140 替代：恢复守卫以同事务后继离职的最终生效日截止。 */
  readonly restoreUntil?: string;
}

/** 可信审批 / 定时任务调用入口；审批动作只经审批中心（R1-T07），到期生效由 R1-T08 定时任务经 activate 端口落地。 */
export async function runEmploymentTransition(
  db: Db,
  ctx: EmploymentContext,
  input: EmploymentTransitionInput,
): Promise<CommandResult> {
  return runCommand(db, ctx, {
    id: ctx.commandId,
    fingerprint: { operation: 'employment.transition', input, expectedRevision: ctx.expectedRevision },
    execute: async (tx, commandId) => ({
      status: 200,
      body: await transitionEmployment(tx, { ...ctx, commandId }, input),
    }),
  });
}

/**
 * 审批中心最后节点通过后同事务调用（R1-T07）：审批通过 ≠ 生效，只有生效日已到才落地并向后更新。
 * 离职：先过 HR 字段复核，写 approved 事件与 confirmed 阶段（最后节点通过当日写编制预减时点 R 与预减台账），
 * 生效日已到则在审批事务内进入生效链（R2-T03 §5.3，审批结论不受落地失败影响）；其余业务 DEC-195② 迟到审批同样按实际执行日对齐联动。
 */
async function approveBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  exitRow: Awaited<ReturnType<typeof loadExitRequest>>,
) {
  // 离职类型只对离职必填；退休不要求（R2-T04 §3.3）
  if (exitRow && business.payload.kind === 'leave') assertExitHrFields(exitRow);
  await appendEmploymentState(tx, ctx, business, 'approved');
  if (!exitRow) return approveEmploymentBusiness(tx, { ...ctx, deferredExecution: true }, business);
  const { effectiveDate, mode } = business.payload;
  await confirmExit(tx, ctx, {
    id: business.id,
    employeeId: business.employeeId,
    effectiveDate,
    mode,
    kind: business.payload.kind === 'retirement' ? 'retirement' : 'leave',
  });
  await activateIfDue(tx, ctx, business.id);
}

/** 29 PB-R9 / AC-PB-03：转正申请在提交时判互斥（草稿照常保存），自己不拦自己。 */
async function assertRegularizationSubmittable(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  if (business.payload.kind !== 'regularization') return;
  await assertProbationProcessesIdle(tx, ctx, {
    employeeId: business.employeeId,
    action: 'apply',
    businessId: business.id,
  });
}

/** 同事务编排端口；审批中心（R1-T07）对操作者、节点与参与人规则负责。 */
export async function transitionEmployment(
  tx: Tx,
  ctx: EmploymentContext,
  input: EmploymentTransitionInput,
): Promise<EmploymentBusiness> {
  if (!input || !ACTIONS.includes(input.action)) throw new AppError('VALIDATION_FAILED', '任职状态动作不合法');
  if (['submit', 'approve', 'activate'].includes(input.action)) await lockTransferBusiness(tx, ctx, input.id);
  const business = await lockEmploymentBusiness(tx, ctx, input.id);
  const gatedExit =
    isExitKind(business.payload.kind) && !ctx.trustedExit ? await exitGateFor(tx, ctx, business, input) : null;
  assertTransition(business, input.action);
  // 调动业务的员工侧校验留在主函数里：F-039 按调用邻近度探测 transfer write，下沉一层会被判为口径变弱
  if (input.action === 'submit') await requireEmployeeTransferBusiness(tx, ctx, input.id);
  if (input.action === 'submit') await assertRegularizationSubmittable(tx, ctx, business);
  if (input.action === 'submit' && business.payload.kind === 'retire_rehire')
    await assertBusinessSequence(tx, ctx, business.employeeId, business.payload);
  if (input.action === 'submit' || input.action === 'approve') {
    const { payload } = business;
    // DEC-195② / DEC-272：审批通过时已过计划生效日的调动改到批准当天（共用判定函数，起点是 §5.0A 计划生效日，D-8）。
    const effectiveDate =
      input.action === 'approve' && payload.kind === 'transfer'
        ? resolveLateExecution({
            plannedEffectiveDate: await loadPlannedEffectiveDate(tx, ctx.tenantId, business.id, payload.effectiveDate),
            executionDate: tenantLocalDate(ctx.now, ctx.timezone),
          }).effectiveDate
        : payload.effectiveDate;
    const predecessor = await findPredecessor(tx, ctx.tenantId, business.employeeId, effectiveDate);
    const { fields } = await resolveEffectiveInheritance(
      tx,
      ctx,
      { ...payload, effectiveDate },
      {
        staffId: payload.selectedStaffId ?? predecessor?.staffId ?? '',
        predecessor,
      },
    );
    // DEC-196：保存草稿之后组织可能已停用；提交与审批须在停用共用锁内复查。
    if (payload.kind === 'transfer')
      await assertEmploymentDepartmentAvailable(tx, ctx, fields.departmentId, effectiveDate);
    assertRequiredTransferFields(payload.kind, payload.formSnapshot, { ...fields });
    // DEC-183：变更合同遇同类型在途未来合同，提交即 409。
    if (payload.kind === 'transfer') await assertTransferLinkageSubmittable(tx, ctx, business.id);
    await assertEstablishmentCapacity(tx, ctx, {
      businessId: business.id,
      employeeId: business.employeeId,
      kind: payload.kind,
      effectiveDate,
      departmentId: fields.departmentId,
      positionId: fields.positionId,
      fields,
    });
  }
  const released = ['delete', 'withdraw', 'revoke', 'reject', 'disapprove'].includes(input.action)
    ? await reverseCarriedEstablishment(tx, ctx, business.id)
    : [];
  if (input.action === 'delete') {
    const previous = await deleteEmploymentBusiness(tx, ctx, business, input.cancelling === true, input.restoreUntil);
    const { kind, effectiveDate } = business.payload;
    await personnelHooks.sync(tx, ctx, business.employeeId, business.id, kind, effectiveDate);
    // 前一条的结束日随删除恢复，其同步履历也要同事务跟着变（AC-TRF-08）。
    if (previous) await personnelHooks.sync(tx, ctx, business.employeeId, previous.id, previous.kind, previous.date);
  } else if (input.action === 'approve') {
    await approveBusiness(tx, ctx, business, gatedExit?.row);
  } else if (input.action === 'activate' && gatedExit?.row) {
    await activateExitPort(tx, ctx, business.id);
  } else if (input.action === 'activate') {
    if (tenantLocalDate(ctx.now, ctx.timezone) < business.payload.effectiveDate) {
      throw new AppError('CONFLICT', '尚未到任职生效日期', { reason: 'EFFECTIVE_DATE_NOT_REACHED' });
    }
    // R1-T08：定时任务与 HR 重试经此端口按队列逐条落地（activation-service.ts）；前序未落地时不得越过它（DEC-108 / 112）；
    // 前序因区间内含本业务而记 REBUILD_REQUIRED、且无跨对象联动依赖时例外（设计 §2.5）。
    await assertPredecessorsSettled(tx, ctx, business.employeeId, business.id);
    await postponeLateTransfer(tx, ctx, business);
    // materialize 同事务完成向后更新、审计与 outbox。
    await materializeEmploymentRecord(tx, ctx, business);
    await appendEmploymentState(tx, ctx, business, 'effective');
  } else {
    const state = STATE_AFTER[input.action];
    await appendEmploymentState(tx, ctx, business, state);
  }
  await assertReleasedEstablishment(tx, ctx, business.id, business.employeeId, released);
  // 一条命令只增加一次业务 revision；approve→effective 的两条状态事件不各自递增头版本。
  await bumpEmploymentBusiness(tx, ctx, business);
  return requireSavedBusiness(tx, ctx, business.id);
}

/**
 * 审批通过日已到生效日则立即生效（AC-TRF-05）；未到则停在「审批通过」，只存申请单（DEC-125），由 R1-T08 定时任务
 * 到期落地（AC-TRF-06）。同员工排在它前面的待生效业务尚未落地时也不立即生效，交给定时任务按序处理（DEC-108）；
 * 前序生效失败未修正时记“因前序业务失败挂起”（DEC-112）。迟到落地区间内另有记录时（DEC-278③，设计 §2.3）审批动作
 * 本身成功、申请停在审批通过，同事务记一次生效失败 REBUILD_REQUIRED 交 HR。
 */
async function approveEmploymentBusiness(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  if (tenantLocalDate(ctx.now, ctx.timezone) < business.payload.effectiveDate) return;
  const { item, before: predecessors } = await activationPredecessors(tx, ctx, business.employeeId, business.id);
  const rehireDecision = item && (await retireRehireActivationDecision(tx, ctx, item));
  if (rehireDecision) {
    await recordActivationAttempt(tx, ctx, item, { ...rehireDecision, trigger: 'approval' }, { bumpRevision: false });
    return;
  }
  const before = await blockingPredecessors(tx, ctx, predecessors, business.id);
  try {
    await postponeLateTransfer(tx, ctx, business);
  } catch (error) {
    const failure = activationFailureOf(error);
    if (!failure || !item) throw error;
    // 本命令结束时统一递增一次业务 revision，失败记录不另行递增。
    await recordActivationAttempt(
      tx,
      ctx,
      item,
      { outcome: 'failed', trigger: 'approval', ...failure },
      { bumpRevision: false },
    );
    return;
  }
  if (!before.length) {
    await materializeEmploymentRecord(tx, ctx, business);
    await appendEmploymentState(tx, ctx, business, 'effective');
    return;
  }
  const blocker = unresolvedPredecessor(before);
  if (item && blocker) {
    // 本命令结束时统一递增一次业务 revision，挂起记录不另行递增。
    await recordActivationAttempt(
      tx,
      ctx,
      item,
      { outcome: 'suspended', trigger: 'approval', reason: PREDECESSOR_FAILED, blockedBy: blocker.failedId },
      { bumpRevision: false },
    );
  }
}

/**
 * activate 端口对离职：经 activateExit 单一编排器落地。端口语义同其他业务——不能越过前序、失败即拒绝（整个命令回滚，
 * 调度与 HR 重试走 activation-service 的队列循环，由它记生效尝试）。
 */
async function activateExitPort(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const result = await activateExit(tx, ctx, businessId, { trigger: 'retry' });
  if (result.outcome === 'effective') return;
  if (result.outcome === 'suspended')
    throw new AppError('CONFLICT', '前序业务生效失败，请先处理前序业务', {
      reason: PREDECESSOR_FAILED,
      blockedByBusinessId: result.blockedByBusinessId,
    });
  if (result.outcome === 'pending')
    throw new AppError('CONFLICT', '前序待生效业务尚未生效', {
      reason: 'ACTIVATION_PREDECESSOR_PENDING',
      blockedByBusinessId: result.blockedByBusinessId,
    });
  throw new AppError('CONFLICT', '离职生效条件不满足', {
    activationFailure: { reason: result.reason, detail: result.detail },
  });
}

/** 离职的门禁前置：提交 / 撤回 / 撤销 / 删除 / 生效端口各自的权限与前置条件；返回扩展行（没有行的可信造数保持 main 行为）。 */
async function exitGateFor(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  input: EmploymentTransitionInput,
) {
  const target = { employeeId: business.employeeId, business };
  const row = await loadExitRequest(tx, ctx.tenantId, business.id);
  if (input.action === 'submit') {
    const { ack } = await requireExitGate(tx, ctx, 'submit', target, input.ack);
    // 提交时按本次计算结果刷新（含集合已降为空 → 清除旧的超限标记 / 旧确认记录，DEC-626）；warning 随后按存下的记录给出
    // 没有扩展行的可信造数 / 升级前结构（loadExitRequest 返回 undefined）保持 main 行为：不写
    if (row) await saveAck(tx, ctx, business.id, ack);
  } else if (input.action === 'withdraw') await requireExitGate(tx, ctx, 'withdraw', target);
  else if (input.action === 'delete' || input.action === 'revoke')
    await requireExitGate(tx, ctx, 'cancel', {
      ...target,
      deleting: input.action === 'delete',
      ...(input.cancelling ? { cancelling: true } : {}),
      ...(input.cancelling && input.restoreUntil ? { rescheduling: true as const } : {}),
    });
  else if (input.action === 'activate') await requireExitGate(tx, ctx, 'retry', target);
  return { row };
}

/** confirmed 阶段前离职类型必须已补齐（§4B）：缺则最后节点同意 409，不改审批结论（整个命令回滚，HR 补齐后重提同意）。 */
function assertExitHrFields(row: { exitTypeCode: string | null }) {
  if (!row.exitTypeCode)
    throw new AppError('CONFLICT', '请先补齐离职类型后再同意', {
      reason: 'EXIT_HR_FIELDS_REQUIRED',
      fields: ['exitTypeCode'],
    });
}

/** 状态机：这份业务（模式 / 类型 / 状态）此刻允许哪些动作（写入口 assertTransition 与读口下发动作共用）。 */
export function transitionPermitted(
  business: { readonly state: string; readonly payload: { readonly mode: string; readonly kind: BusinessKind } },
  action: EmploymentTransitionInput['action'],
): boolean {
  const permitted = {
    // DEC-053：驳回后在同一申请上修改并重提，或撤回为草稿。
    submit: business.payload.mode === 'application' && ['draft', 'rejected'].includes(business.state),
    approve: business.payload.mode === 'application' && business.state === 'in_review',
    reject: business.payload.mode === 'application' && business.state === 'in_review',
    // F-003 第二轮（DEC-144）：审批沿「不同意」流转到结束，申请办结为“未通过”，不能再提交或撤回，只能删除。
    disapprove: business.payload.mode === 'application' && business.state === 'in_review',
    withdraw: business.payload.mode === 'application' && ['in_review', 'rejected'].includes(business.state),
    // `08` §6：流程尚未审批完成才能撤销；审批通过（含未生效）与直接业务只能删除任职。
    // 离职的撤销可作废审批通过未生效的单（approved_voided，设计 §7.1；入口只有 cancelExit，经 §6B）
    revoke:
      (business.payload.mode === 'application' && ['in_review', 'rejected'].includes(business.state)) ||
      (isExitKind(business.payload.kind) && business.state === 'approved'),
    // 离职的直接办理（保存即 approved）同样经 activate 端口到期落地（R2-T03 §3.2）
    activate:
      (business.payload.mode === 'application' || isExitKind(business.payload.kind)) && business.state === 'approved',
    delete: ['draft', 'rejected', 'disapproved', 'voided', 'approved', 'effective'].includes(business.state),
  };
  return permitted[action];
}

function assertTransition(business: LockedEmploymentBusiness, action: EmploymentTransitionInput['action']): void {
  if (!transitionPermitted(business, action))
    throw new AppError('CONFLICT', '当前状态不允许此动作', { state: business.state, action });
}

/** 返回时间轴上的前一条（已生效记录被删时），供调用方同步其投影。 */
async function deleteEmploymentBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  exitCancel = false,
  restoreUntil?: string,
): Promise<{ id: string; kind: string; date: string } | null> {
  const { fields, customFields, ...metadata } = business.payload;
  const before = {
    ...metadata,
    ...fields,
    ...Object.fromEntries(Object.entries(customFields).map(([id, value]) => [`custom:${id}`, value])),
    id: business.id,
    payloadVersionId: business.payload.id,
    revision: business.revision,
    state: business.state,
  };
  let previous: { id: string; kind: string; date: string } | null = null;
  if (business.state === 'effective') {
    const record = await loadEmploymentRecord(tx, ctx.tenantId, business.id, tenantLocalDate(ctx.now, ctx.timezone));
    // 被离职摘下的未来调动不在时间轴上（离职设计 §5.8）：记录与墓碑照常处理，没有区间可恢复，也没有生效中的下游可通知
    const detached = !record && (await isDetachedRecord(tx, ctx.tenantId, business.id));
    if (!record && !detached) throw new AppError('SERVICE_UNAVAILABLE', '生效业务没有可读取的任职记录');
    const [raw] = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT * FROM employment_records
        WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${business.employeeId}::uuid
          AND id = ${business.id}::uuid LIMIT 1
      `),
    );
    if (!raw) throw new AppError('SERVICE_UNAVAILABLE', '任职记录删除快照不可用');
    if (record) {
      await assertNoPendingApplication(tx, ctx, { ...record, id: business.id });
      await assertNoLinkedChanges(tx, ctx, record);
      await assertRegularizationNotPropagated(tx, ctx, business);
    }
    await insertEmploymentRow(tx, 'employment_record_tombstones', {
      id: randomUUID(),
      tenantId: ctx.tenantId,
      employeeId: business.employeeId,
      recordId: business.id,
      commandId: ctx.commandId,
      createdAt: ctx.now.toISOString(),
    });
    if (record) {
      const opensCycle = NEW_CYCLE_KINDS.includes(business.payload.kind);
      const point = await removeEmploymentTimeline(tx, ctx, business.employeeId, business.id, opensCycle);
      if (point && exitCancel)
        previous = await restoreAfterExitDeletion(tx, ctx, record, business, point, restoreUntil);
      else if (point) {
        await assertRestoredPredecessor(tx, ctx, record, { previousId: point.recordId, window: point.window });
        const kept = await loadEmploymentRecord(tx, ctx.tenantId, point.recordId, point.window.from);
        if (kept) previous = { id: kept.id, kind: kept.kind, date: kept.effectiveDate };
      }
    }
    await auditDeletedRecord(tx, ctx, business, raw, record);
    // R3-T05 设计 §5.4：删除已生效记录（如误办的离职）通知订阅方，是否恢复由订阅方按自己的口径决定
    if (record)
      await employeeStatusHooks.recordDeleted(tx, ctx, {
        employeeId: business.employeeId,
        recordId: business.id,
        kind: record.kind,
        effectiveDate: record.effectiveDate,
        lastWorkDate: business.payload.lastWorkDate,
        employeeStatus: record.employeeStatus,
      });
  }
  await appendEmploymentState(tx, ctx, business, 'deleted');
  await auditEmployment(tx, ctx, 'employment.business.delete', 'employment-business', business.id, before, null);
  // F-199：通用删除与专用 DELETE /pending-entries 共用此内核；待入职合同随业务一并清理并留审计（没有合同的不留）
  await releasePendingContract(tx, ctx, business.id, 'delete');
  // F-203：试用期行（F-188）同样在内核同事务清理，各入口不再各自补清
  await clearPendingProbation(tx, ctx, business.id);
  return previous;
}

/**
 * 被离职摘下的未来调动不在时间轴上，读不到记录视图：审计前镜像独立于时间轴，取最新记录快照版本（编辑后的值），
 * 版本 ID 与内容同出一行；还没有任何快照时才回退到底表（离职设计 §5.8，#410 第 1 轮 P2-3）。
 */
async function detachedSnapshot(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT * FROM employment_payload_versions WHERE tenant_id=${ctx.tenantId}
      AND business_id=${businessId}::uuid AND is_record_snapshot ORDER BY version_no DESC LIMIT 1`),
  );
  return row;
}

/** 删除已生效记录的审计（DEC-019）。 */
async function auditDeletedRecord(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  raw: Record<string, unknown>,
  record: EmploymentRecord | null,
) {
  const snapshot = record ? undefined : await detachedSnapshot(tx, ctx, business.id);
  const mirrored = record ?? (snapshot ? snapshotRecord(snapshot) : null);
  await auditEmployment(
    tx,
    ctx,
    'employment.record.delete',
    'employment-record',
    business.id,
    {
      ...deletionSnapshot(raw),
      payloadVersionId: snapshot ? String(snapshot.id) : business.payload.id,
      ...(mirrored
        ? {
            ...mirrored.fields,
            // 删除前镜像取最新记录快照上的状态（DEC-216；底表行只是首个版本，PR #93 首审 P2-3）
            employeeStatus: mirrored.employeeStatus,
            entryStatus: mirrored.entryStatus,
            ...Object.fromEntries(
              Object.entries(mirrored.customFields).map(([key, value]) => [`custom:${key}`, value]),
            ),
          }
        : {}),
    },
    null,
  );
}

function snapshotRecord(row: Record<string, unknown>) {
  return {
    fields: snapshotFields(row),
    customFields: (row.custom_fields ?? {}) as Readonly<Record<string, unknown>>,
    employeeStatus: Number(row.employee_status),
    entryStatus: row.entry_status === null ? null : Number(row.entry_status),
  };
}

function deletionSnapshot(raw: Record<string, unknown>): Record<string, unknown> {
  const { customFields, ...snapshot } = camelRow(raw);
  const custom = customFields as Readonly<Record<string, unknown>>;
  return { ...snapshot, ...Object.fromEntries(Object.entries(custom).map(([id, value]) => [`custom:${id}`, value])) };
}
