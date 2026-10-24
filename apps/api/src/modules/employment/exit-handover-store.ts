/**
 * 离职交接申请的读取与写入原语（R2 BE-8b2）：申请行、事项行的加载 / 插入 / 状态迁移，全部在调用方的租户事务内。
 * 业务规则（发起判断、办理权限、终止）在 exit-handover.ts，审批回调在 exit-handover-adapter.ts。
 */
import { sql, type Tx } from '@italent/db';
import type { HandoverEndReason, HandoverNotLaunchedReason, HandoverRequestState } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { HandoverItemView } from './exit-handover-items.js';
import { rowsOf } from './record-store.js';

export interface HandoverRequestRow {
  readonly id: string;
  readonly exitRequestId: string;
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly initiatorUserId: string | null;
  readonly state: HandoverRequestState;
  readonly endReason: HandoverEndReason | null;
  readonly notLaunchedReason: HandoverNotLaunchedReason | null;
  readonly approvalInstanceId: string | null;
  readonly revision: number;
}

export interface HandoverItemRow {
  readonly id: string;
  readonly category: string;
  readonly sequenceNo: number;
  readonly todoType: 'work_handover' | 'other';
  readonly title: string;
  readonly formRef: string | null;
  readonly remark: string | null;
  readonly done: boolean;
  readonly handoverPerson: string | null;
  readonly revision: number;
}

const REQUEST_COLUMNS = sql`id, exit_request_id AS "exitRequestId", employee_id AS "employeeId",
  department_id AS "departmentId", initiator_user_id AS "initiatorUserId", state, end_reason AS "endReason",
  not_launched_reason AS "notLaunchedReason", approval_instance_id AS "approvalInstanceId", revision`;

export async function loadHandoverRequest(tx: Tx, tenantId: string, id: string, lock = false) {
  const [row] = rowsOf<HandoverRequestRow>(
    await tx.execute(sql`SELECT ${REQUEST_COLUMNS} FROM exit_handover_requests
      WHERE tenant_id = ${tenantId} AND id = ${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  if (!row) throw new AppError('NOT_FOUND', '离职交接申请不存在');
  return row;
}

/** 某离职业务最新的一张交接申请（进行中 / 已完成优先，其次最近终止的）；没有返回 null。 */
export async function latestHandoverOfExit(tx: Tx, tenantId: string, exitId: string) {
  const [row] = rowsOf<HandoverRequestRow>(
    await tx.execute(sql`SELECT ${REQUEST_COLUMNS} FROM exit_handover_requests
      WHERE tenant_id = ${tenantId} AND exit_request_id = ${exitId}::uuid
      ORDER BY (state = 'terminated'), created_at DESC, id LIMIT 1`),
  );
  return row ?? null;
}

/** 进行中 / 已完成的那一张（部分唯一索引保证至多一张）。 */
export async function liveHandoverOfExit(tx: Tx, tenantId: string, exitId: string) {
  const row = await latestHandoverOfExit(tx, tenantId, exitId);
  return row && row.state !== 'terminated' ? row : null;
}

export async function listRequestItems(tx: Tx, tenantId: string, requestId: string) {
  return rowsOf<HandoverItemRow>(
    await tx.execute(sql`SELECT id, category, sequence_no AS "sequenceNo", todo_type AS "todoType", title,
      form_ref AS "formRef", remark, done, handover_person AS "handoverPerson", revision
      FROM exit_handover_request_items WHERE tenant_id = ${tenantId} AND request_id = ${requestId}::uuid
      ORDER BY sequence_no, id`),
  );
}

export async function insertHandoverRequest(
  tx: Tx,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly exitRequestId: string;
    readonly employeeId: string;
    readonly departmentId: string | null;
    readonly initiatorUserId: string;
    readonly commandId: string;
    readonly now: Date;
    readonly items: readonly HandoverItemView[];
  },
) {
  const now = input.now.toISOString();
  await tx.execute(sql`INSERT INTO exit_handover_requests(id, tenant_id, exit_request_id, employee_id, department_id,
    initiator_user_id, state, revision, command_id, created_at, updated_at)
    VALUES (${input.id}::uuid, ${input.tenantId}, ${input.exitRequestId}::uuid, ${input.employeeId}::uuid,
    ${input.departmentId}::uuid, ${input.initiatorUserId}::uuid, 'in_progress', 1, ${input.commandId},
    ${now}::timestamptz, ${now}::timestamptz)`);
  await insertRequestItems(tx, input);
}

/** 未发起没有事项；首次成功启动时才冻结设置，已终止重提沿用原事项快照与办理记录。 */
export async function insertRequestItems(
  tx: Tx,
  input: {
    readonly tenantId: string;
    readonly id: string;
    readonly now: Date;
    readonly items: readonly HandoverItemView[];
  },
) {
  const now = input.now.toISOString();
  for (const item of input.items)
    await tx.execute(sql`INSERT INTO exit_handover_request_items(id, tenant_id, request_id, category, sequence_no,
      todo_type, title, form_ref, remark, created_at, updated_at)
      VALUES (gen_random_uuid(), ${input.tenantId}, ${input.id}::uuid, ${item.category}, ${item.sequenceNo},
      ${item.todoType}, ${item.title}, ${item.formRef}, ${item.remark}, ${now}::timestamptz, ${now}::timestamptz)`);
}

/** 交接未发起的持久记录（DEC-663）：没有事项、没有审批实例；至多一张（部分唯一索引兜底）。 */
export async function insertNotLaunchedRequest(
  tx: Tx,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly exitRequestId: string;
    readonly employeeId: string;
    readonly departmentId: string | null;
    readonly initiatorUserId: string | null;
    readonly reason: HandoverNotLaunchedReason;
    readonly commandId: string;
    readonly now: Date;
  },
) {
  const now = input.now.toISOString();
  await tx.execute(sql`INSERT INTO exit_handover_requests(id, tenant_id, exit_request_id, employee_id, department_id,
    initiator_user_id, state, not_launched_reason, revision, command_id, created_at, updated_at)
    VALUES (${input.id}::uuid, ${input.tenantId}, ${input.exitRequestId}::uuid, ${input.employeeId}::uuid,
    ${input.departmentId}::uuid, ${input.initiatorUserId}::uuid, 'not_launched', ${input.reason}, 1,
    ${input.commandId}, ${now}::timestamptz, ${now}::timestamptz)`);
}

/** 状态迁移（revision + 1）；终止同时写原因，离开 not_launched 时清掉未发起原因。 */
export async function moveHandoverRequest(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly commandId: string; readonly now: Date },
  row: HandoverRequestRow,
  next: { readonly state: HandoverRequestState; readonly endReason?: HandoverEndReason },
) {
  await tx.execute(sql`UPDATE exit_handover_requests SET state = ${next.state}, end_reason = ${next.endReason ?? null},
    not_launched_reason = NULL, revision = revision + 1, command_id = ${ctx.commandId},
    updated_at = ${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id = ${ctx.tenantId} AND id = ${row.id}::uuid`);
}

export async function linkHandoverInstance(tx: Tx, tenantId: string, requestId: string, instanceId: string) {
  await tx.execute(sql`UPDATE exit_handover_requests SET approval_instance_id = ${instanceId}::uuid
    WHERE tenant_id = ${tenantId} AND id = ${requestId}::uuid`);
}
