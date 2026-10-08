import { reverseCarriedEstablishment, assertReleasedEstablishment } from '../establishment/carried-transfer.js';
import { postponeLateTransfer } from './late-transfer.js';
import { activationFailureOf, assertEstablishmentCapacity } from './activation-checks.js';
import { lockTransferBusiness } from './transfer-locks.js';
import { assertEmploymentDepartmentAvailable } from './references.js';
import { personnelHooks } from './personnel-hooks.js';
import { randomUUID } from 'node:crypto';
import { sql, type Db, type Tx } from '@italent/db';
import { resolveLateExecution, tenantLocalDate } from '@italent/domain';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import { assertRegularizationNotPropagated } from './employee-status.js';
import {
  activationPredecessors,
  PREDECESSOR_FAILED,
  recordActivationAttempt,
  unresolvedPredecessor,
} from './activation-store.js';
import { assertPredecessorsSettled, blockingPredecessors } from './linkage-dependency.js';
import { auditEmployment } from './context.js';
import { findPredecessor, loadEmploymentRecord } from './read-model.js';
import { resolveEffectiveInheritance } from './inheritance.js';
import {
  bumpEmploymentBusiness,
  camelRow,
  insertEmploymentRow,
  lockEmploymentBusiness,
  rowsOf,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { removeEmploymentTimeline } from './timeline.js';
import { assertNoLinkedChanges, assertNoPendingApplication, assertRestoredPredecessor } from './deletion-guards.js';
import type { EmploymentBusiness, EmploymentContext, EmploymentState } from './types.js';
import { assertRequiredTransferFields } from '../transfer/required-fields.js';
import { requireEmployeeTransferBusiness } from '../transfer/employee-policy.js';
import { assertTransferLinkageSubmittable } from '../transfer/linkage/service.js';
import {
  appendEmploymentState,
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

/** 同事务编排端口；审批中心（R1-T07）对操作者、节点与参与人规则负责。 */
export async function transitionEmployment(
  tx: Tx,
  ctx: EmploymentContext,
  input: EmploymentTransitionInput,
): Promise<EmploymentBusiness> {
  if (!input || !ACTIONS.includes(input.action)) throw new AppError('VALIDATION_FAILED', '任职状态动作不合法');
  if (['submit', 'approve', 'activate'].includes(input.action)) await lockTransferBusiness(tx, ctx, input.id);
  const business = await lockEmploymentBusiness(tx, ctx, input.id);
  assertTransition(business, input.action);
  if (input.action === 'submit') await requireEmployeeTransferBusiness(tx, ctx, input.id);
  if (input.action === 'submit' || input.action === 'approve') {
    const { payload } = business;
    // DEC-195② / DEC-272：审批通过时已过计划生效日的调动改到批准当天（共用判定函数）。
    const effectiveDate =
      input.action === 'approve' && payload.kind === 'transfer'
        ? resolveLateExecution({
            plannedEffectiveDate: payload.effectiveDate,
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
    const previous = await deleteEmploymentBusiness(tx, ctx, business);
    const { kind, effectiveDate } = business.payload;
    await personnelHooks.sync(tx, ctx, business.employeeId, business.id, kind, effectiveDate);
    // 前一条的结束日随删除恢复，其同步履历也要同事务跟着变（AC-TRF-08）。
    if (previous) await personnelHooks.sync(tx, ctx, business.employeeId, previous.id, previous.kind, previous.date);
  } else if (input.action === 'approve') {
    // R1-T07：只由审批中心在最后一个节点通过后同事务调用；审批通过 ≠ 生效，只有生效日已到才落地并向后更新。
    await appendEmploymentState(tx, ctx, business, 'approved');
    // DEC-195②：迟到审批同样按实际执行日对齐联动。
    await approveEmploymentBusiness(tx, { ...ctx, deferredExecution: true }, business);
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

function assertTransition(business: LockedEmploymentBusiness, action: EmploymentTransitionInput['action']): void {
  const permitted = {
    // DEC-053：驳回后在同一申请上修改并重提，或撤回为草稿。
    submit: business.payload.mode === 'application' && ['draft', 'rejected'].includes(business.state),
    approve: business.payload.mode === 'application' && business.state === 'in_review',
    reject: business.payload.mode === 'application' && business.state === 'in_review',
    // F-003 第二轮（DEC-144）：审批沿「不同意」流转到结束，申请办结为“未通过”，不能再提交或撤回，只能删除。
    disapprove: business.payload.mode === 'application' && business.state === 'in_review',
    withdraw: business.payload.mode === 'application' && ['in_review', 'rejected'].includes(business.state),
    // `08` §6：流程尚未审批完成才能撤销；审批通过（含未生效）与直接业务只能删除任职。
    revoke: business.payload.mode === 'application' && ['in_review', 'rejected'].includes(business.state),
    activate: business.payload.mode === 'application' && business.state === 'approved',
    delete: ['draft', 'rejected', 'disapproved', 'voided', 'approved', 'effective'].includes(business.state),
  };
  if (!permitted[action]) throw new AppError('CONFLICT', '当前状态不允许此动作', { state: business.state, action });
}

/** 返回时间轴上的前一条（已生效记录被删时），供调用方同步其投影。 */
async function deleteEmploymentBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
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
    if (!record) throw new AppError('SERVICE_UNAVAILABLE', '生效业务没有可读取的任职记录');
    const [raw] = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT * FROM employment_records
        WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${business.employeeId}::uuid
          AND id = ${business.id}::uuid LIMIT 1
      `),
    );
    if (!raw) throw new AppError('SERVICE_UNAVAILABLE', '任职记录删除快照不可用');
    await assertNoPendingApplication(tx, ctx, { ...record, id: business.id });
    await assertNoLinkedChanges(tx, ctx, record);
    await assertRegularizationNotPropagated(tx, ctx, business);
    await insertEmploymentRow(tx, 'employment_record_tombstones', {
      id: randomUUID(),
      tenantId: ctx.tenantId,
      employeeId: business.employeeId,
      recordId: business.id,
      commandId: ctx.commandId,
      createdAt: ctx.now.toISOString(),
    });
    const opensCycle = NEW_CYCLE_KINDS.includes(business.payload.kind);
    const point = await removeEmploymentTimeline(tx, ctx, business.employeeId, business.id, opensCycle);
    if (point) {
      await assertRestoredPredecessor(tx, ctx, record, { previousId: point.recordId, window: point.window });
      const kept = await loadEmploymentRecord(tx, ctx.tenantId, point.recordId, point.window.from);
      if (kept) previous = { id: kept.id, kind: kept.kind, date: kept.effectiveDate };
    }
    await auditEmployment(
      tx,
      ctx,
      'employment.record.delete',
      'employment-record',
      business.id,
      {
        ...deletionSnapshot(raw),
        payloadVersionId: business.payload.id,
        ...record.fields,
        // 删除前镜像取最新记录快照上的状态（DEC-216；底表行只是首个版本，PR #93 首审 P2-3）
        employeeStatus: record.employeeStatus,
        entryStatus: record.entryStatus,
        ...Object.fromEntries(Object.entries(record.customFields).map(([key, value]) => [`custom:${key}`, value])),
      },
      null,
    );
  }
  await appendEmploymentState(tx, ctx, business, 'deleted');
  await auditEmployment(tx, ctx, 'employment.business.delete', 'employment-business', business.id, before, null);
  return previous;
}

function deletionSnapshot(raw: Record<string, unknown>): Record<string, unknown> {
  const { customFields, ...snapshot } = camelRow(raw);
  const custom = customFields as Readonly<Record<string, unknown>>;
  return { ...snapshot, ...Object.fromEntries(Object.entries(custom).map(([id, value]) => [`custom:${id}`, value])) };
}
