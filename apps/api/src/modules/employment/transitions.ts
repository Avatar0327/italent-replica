import { personnelHooks } from './personnel-hooks.js';
import { randomUUID } from 'node:crypto';
import { sql, type Db, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import { auditEmployment } from './context.js';
import { EmploymentError } from './errors.js';
import { loadEmploymentRecord } from './read-model.js';
import {
  bumpEmploymentBusiness,
  camelRow,
  insertEmploymentRow,
  lockEmploymentBusiness,
  rowsOf,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { removeLatestEmploymentTimeline } from './timeline.js';
import type { EmploymentBusiness, EmploymentContext } from './types.js';
import {
  appendEmploymentState,
  materializeEmploymentRecord,
  NEW_CYCLE_KINDS,
  requireSavedBusiness,
} from './write-service.js';

const ACTIONS = ['submit', 'approve', 'reject', 'withdraw', 'activate', 'delete'] as const;
export interface EmploymentTransitionInput {
  readonly id: string;
  readonly action: (typeof ACTIONS)[number];
}

/** 可信审批 / 定时任务调用入口；审批动作只经审批中心（R1-T07），生效到期由 R1-T08 调度。 */
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
  const business = await lockEmploymentBusiness(tx, ctx, input.id);
  assertTransition(business, input.action);
  if (input.action === 'delete') {
    await deleteEmploymentBusiness(tx, ctx, business);
    await personnelHooks.sync(
      tx,
      ctx,
      business.employeeId,
      business.id,
      business.payload.kind,
      business.payload.effectiveDate,
    );
  } else if (input.action === 'approve') {
    // R1-T07：只由审批中心在最后一个节点通过后同事务调用；审批通过 ≠ 生效，只有生效日已到才落地并向后更新。
    await appendEmploymentState(tx, ctx, business, 'approved');
    if (tenantLocalDate(ctx.now, ctx.timezone) >= business.payload.effectiveDate) {
      await materializeEmploymentRecord(tx, ctx, business);
      await appendEmploymentState(tx, ctx, business, 'effective');
    }
    // TODO(R1-T08)：提前审批保持 approved；由租户时区的调度器通过 activate 端口落地。
  } else if (input.action === 'activate') {
    if (tenantLocalDate(ctx.now, ctx.timezone) < business.payload.effectiveDate) {
      throw new AppError('CONFLICT', '尚未到任职生效日期', { reason: 'EFFECTIVE_DATE_NOT_REACHED' });
    }
    // TODO(R1-T08)：调度器调用此端口；materialize 同事务执行向后更新。
    await materializeEmploymentRecord(tx, ctx, business);
    await appendEmploymentState(tx, ctx, business, 'effective');
  } else {
    const state = input.action === 'submit' ? 'in_review' : input.action === 'reject' ? 'rejected' : 'draft';
    await appendEmploymentState(tx, ctx, business, state);
  }
  // 一条命令只增加一次业务 revision；approve→effective 的两条状态事件不各自递增头版本。
  await bumpEmploymentBusiness(tx, ctx, business);
  return requireSavedBusiness(tx, ctx, business.id);
}

function assertTransition(business: LockedEmploymentBusiness, action: EmploymentTransitionInput['action']): void {
  const permitted = {
    // DEC-053：驳回后在同一申请上修改并重提，或撤回为草稿。
    submit: business.payload.mode === 'application' && ['draft', 'rejected'].includes(business.state),
    approve: business.payload.mode === 'application' && business.state === 'in_review',
    reject: business.payload.mode === 'application' && business.state === 'in_review',
    withdraw: business.payload.mode === 'application' && ['in_review', 'rejected'].includes(business.state),
    activate: business.payload.mode === 'application' && business.state === 'approved',
    delete: ['draft', 'rejected', 'approved', 'effective'].includes(business.state),
  };
  if (!permitted[action]) throw new AppError('CONFLICT', '当前状态不允许此动作', { state: business.state, action });
}

async function deleteEmploymentBusiness(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
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
    await assertNoDependentApplication(tx, ctx, business, record.staffId);
    await insertEmploymentRow(tx, 'employment_record_tombstones', {
      id: randomUUID(),
      tenantId: ctx.tenantId,
      employeeId: business.employeeId,
      recordId: business.id,
      commandId: ctx.commandId,
      createdAt: ctx.now.toISOString(),
    });
    await removeLatestEmploymentTimeline(tx, ctx, business.employeeId, business.id);
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
        ...Object.fromEntries(Object.entries(record.customFields).map(([key, value]) => [`custom:${key}`, value])),
      },
      null,
    );
  }
  await appendEmploymentState(tx, ctx, business, 'deleted');
  await auditEmployment(tx, ctx, 'employment.business.delete', 'employment-business', business.id, before, null);
}

function deletionSnapshot(raw: Record<string, unknown>): Record<string, unknown> {
  const { customFields, ...snapshot } = camelRow(raw);
  const custom = customFields as Readonly<Record<string, unknown>>;
  return { ...snapshot, ...Object.fromEntries(Object.entries(custom).map(([id, value]) => [`custom:${id}`, value])) };
}

async function assertNoDependentApplication(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  staffId: string,
): Promise<void> {
  const [dependent] = rowsOf(
    await tx.execute(sql`
      SELECT 1 FROM employment_business_objects b
      JOIN LATERAL (
        SELECT mode, kind, effective_date, selected_staff_id FROM employment_payload_versions
        WHERE tenant_id = b.tenant_id AND employee_id = b.employee_id AND business_id = b.id
        ORDER BY version_no DESC LIMIT 1
      ) p ON TRUE
      JOIN LATERAL (
        SELECT state FROM employment_state_events
        WHERE tenant_id = b.tenant_id AND employee_id = b.employee_id AND business_id = b.id
        ORDER BY event_no DESC LIMIT 1
      ) s ON TRUE
      WHERE b.tenant_id = ${ctx.tenantId} AND b.employee_id = ${business.employeeId}::uuid
        AND b.id <> ${business.id}::uuid AND p.mode = 'application'
        AND p.kind NOT IN (${sql.join(
          NEW_CYCLE_KINDS.map((kind) => sql`${kind}`),
          sql`, `,
        )})
        AND p.effective_date >= ${business.payload.effectiveDate}::date
        AND (p.selected_staff_id IS NULL OR p.selected_staff_id = ${staffId}::uuid)
        AND s.state IN ('draft', 'in_review', 'approved') LIMIT 1
    `),
  );
  if (dependent) {
    // TODO(需取证 Q-M0-22)：后续同周期申请依赖的删除及回滚由 R1-T11 处理。
    throw new EmploymentError('EMPLOYMENT_FUTURE_VERSION_EXISTS', '存在依赖此任职周期的后续申请');
  }
}
