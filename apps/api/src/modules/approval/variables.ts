/** F-326 S2：租户级变量配置，读写均由调用者的租户事务承载。 */
import { count, getTableColumns, or } from 'drizzle-orm';
import { and, approvalVariables, asc, eq, inArray, sql, type Tx } from '@italent/db';
import {
  statusAfter,
  variableCodeOf,
  type VariableDataType,
  type VariableScope,
  type VariableStatus,
} from '@italent/domain';
import { requireNew } from '../job/context.js';
import { approvalError, assertRevision, auditApproval, emitOutbox, type ApprovalContext } from './context.js';
import { eligibleDesignerPeople } from './designer-people.js';
import {
  checkVariableCode,
  validateVariableValues,
  variablePersonIds,
  type CreateVariableInput,
  type UpdateVariableInput,
  type VariableQuery,
  type VariableValues,
} from './variable-input.js';

type VariableRow = typeof approvalVariables.$inferSelect;
const table = approvalVariables;
// 按 JSON 文本解码一次，避免驱动已经解码的字符串 "123" / "false" 再被 jsonb mapper 当数值或布尔解析。
const selection = {
  ...getTableColumns(table),
  defaultValue: sql<string | null>`${table.defaultValue}::text`.mapWith((value: string | null): unknown =>
    value === null ? null : JSON.parse(value),
  ),
};
const byId = (tenantId: string, id: string) => and(eq(table.tenantId, tenantId), eq(table.id, id));

export async function loadVariable(tx: Tx, tenantId: string, id: string, lock = false): Promise<VariableRow> {
  const query = tx.select(selection).from(table).where(byId(tenantId, id));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw approvalError('NOT_FOUND', 'APPROVAL_VARIABLE_NOT_FOUND', '变量不存在');
  return row;
}

function valuesOf(row: VariableRow): VariableValues {
  return {
    scope: row.scope as VariableScope,
    appId: row.appId,
    code: row.code,
    name: row.name,
    dataType: row.dataType as VariableDataType,
    defaultValue: row.defaultValue,
    usageScopes: row.usageScopes,
    description: row.description,
  };
}

async function variableViews(tx: Tx, tenantId: string, rows: VariableRow[]) {
  const userIds = [...new Set(rows.flatMap((row) => variablePersonIds(valuesOf(row))))];
  const people = userIds.length
    ? await eligibleDesignerPeople(tx, tenantId, { userIds, limit: userIds.length, offset: 0 })
    : [];
  const byUser = new Map(people.map((person) => [person.userId, person]));
  return rows.map((row) => ({
    ...valuesOf(row),
    id: row.id,
    status: row.status,
    revision: row.revision,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    people: variablePersonIds(valuesOf(row)).flatMap((id) => (byUser.has(id) ? [byUser.get(id)!] : [])),
  }));
}

export async function variableDetail(tx: Tx, tenantId: string, id: string) {
  const [view] = await variableViews(tx, tenantId, [await loadVariable(tx, tenantId, id)]);
  return view!;
}

export async function listVariables(tx: Tx, tenantId: string, query: VariableQuery) {
  const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const predicate = and(
    eq(table.tenantId, tenantId),
    eq(table.scope, query.scope),
    query.scope === 'application' ? eq(table.appId, query.appId!) : undefined,
    inArray(table.status, query.status === 'active' ? ['draft', 'enabled'] : ['disabled']),
    or(sql`${table.name} ILIKE ${pattern} ESCAPE '\\'`, sql`${table.code} ILIKE ${pattern} ESCAPE '\\'`),
  );
  const rows = await tx
    .select(selection)
    .from(table)
    .where(predicate)
    .orderBy(asc(table.code), asc(table.id))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await tx.select({ value: count() }).from(table).where(predicate);
  return {
    items: await variableViews(tx, tenantId, rows),
    total: total!.value,
    offset: query.offset,
    limit: query.limit,
  };
}

async function checkPeople(tx: Tx, ctx: ApprovalContext, value: VariableValues, enabled: boolean) {
  const ids = variablePersonIds(value);
  if (enabled && ['person', 'persons'].includes(value.dataType) && !ids.length)
    throw approvalError('CONFLICT', 'APPROVAL_VARIABLE_EMPTY', '人员类变量启用时默认值不得为空');
  if (!ids.length) return;
  const found = await eligibleDesignerPeople(tx, ctx.tenantId, { userIds: ids, limit: ids.length, offset: 0 });
  if (found.length !== ids.length)
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_VARIABLE_USER_INVALID', '默认值须为在职内部员工的活跃账号');
}

function snapshot(row: VariableRow) {
  return {
    code: row.code,
    name: row.name,
    dataType: row.dataType,
    defaultValue: row.defaultValue,
    usageScopes: row.usageScopes,
    description: row.description,
    status: row.status,
    appId: row.appId,
  };
}
async function audited(tx: Tx, ctx: ApprovalContext, action: string, before: VariableRow | null, after: VariableRow) {
  const kind = after.scope === 'public' ? 'public' : 'application';
  const objectType = `approval-${kind}-variable`;
  const eventType = `approval.${kind}_variable.${action}`;
  await auditApproval(tx, ctx, {
    action: eventType,
    objectType,
    objectId: after.id,
    before: before ? snapshot(before) : null,
    after: snapshot(after),
  });
  await emitOutbox(tx, ctx, { objectType, objectId: after.id, eventType, revision: after.revision });
}

export async function createVariable(tx: Tx, ctx: ApprovalContext, input: CreateVariableInput) {
  requireNew(ctx);
  checkVariableCode(input);
  const value = validateVariableValues({
    ...input,
    code: variableCodeOf(input.scope, input.codeSuffix),
    appId: input.appId ?? null,
    defaultValue: input.defaultValue ?? null,
    usageScopes: input.usageScopes ?? [],
    description: input.description ?? null,
  });
  await checkPeople(tx, ctx, value, input.enable);
  const [row] = await tx
    .insert(table)
    .values({
      ...value,
      tenantId: ctx.tenantId,
      status: 'draft',
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing({ target: [table.tenantId, table.code] })
    .returning(selection);
  if (!row) throw approvalError('CONFLICT', 'APPROVAL_VARIABLE_CODE_EXISTS', '变量编码已存在');
  await audited(tx, ctx, 'create', null, row);
  if (input.enable) await changeStatus(tx, ctx, row, 'enabled', 'enable');
  return variableDetail(tx, ctx.tenantId, row.id);
}

export async function updateVariable(tx: Tx, ctx: ApprovalContext, id: string, input: UpdateVariableInput) {
  // F-326-L §3.1：管理员只锁本变量，不在持有变量锁之后获取流程头、实例或业务锁。
  const before = await loadVariable(tx, ctx.tenantId, id, true);
  assertRevision(ctx.expectedRevision, before.revision);
  for (const key of ['code', 'scope', 'appId', 'dataType'] as const) {
    if (input[key] !== undefined && input[key] !== before[key])
      throw approvalError('VALIDATION_FAILED', 'APPROVAL_VARIABLE_FIELD_LOCKED', '编码、类型和归属不可修改');
  }
  const previous = valuesOf(before);
  const value = validateVariableValues({ ...previous, ...input } as VariableValues, previous);
  await checkPeople(tx, ctx, value, before.status === 'enabled');
  const [after] = await tx
    .update(table)
    .set({
      name: value.name,
      defaultValue: value.defaultValue,
      usageScopes: value.usageScopes,
      description: value.description,
      revision: before.revision + 1,
      updatedBy: ctx.userId,
      updatedAt: ctx.now,
    })
    .where(byId(ctx.tenantId, id))
    .returning(selection);
  await audited(tx, ctx, 'update', before, after!);
  return variableDetail(tx, ctx.tenantId, id);
}

async function changeStatus(tx: Tx, ctx: ApprovalContext, before: VariableRow, status: string, action: string) {
  const [after] = await tx
    .update(table)
    .set({
      status,
      revision: sql`${table.revision} + 1`,
      updatedBy: ctx.userId,
      updatedAt: ctx.now,
    })
    .where(byId(ctx.tenantId, before.id))
    .returning(selection);
  await audited(tx, ctx, action, before, after!);
}

export async function setVariableStatus(tx: Tx, ctx: ApprovalContext, id: string, action: 'enable' | 'disable') {
  const before = await loadVariable(tx, ctx.tenantId, id, true);
  assertRevision(ctx.expectedRevision, before.revision);
  const status = statusAfter(before.status as VariableStatus, action);
  if (!status) throw approvalError('CONFLICT', 'APPROVAL_VARIABLE_STATUS_INVALID', '当前状态不允许此操作');
  if (action === 'enable') await checkPeople(tx, ctx, valuesOf(before), true);
  // S4 前流程不能引用变量（设计 §8）；影响检查在 S4 与引用能力同时接入。
  await changeStatus(tx, ctx, before, status, action);
  return variableDetail(tx, ctx.tenantId, id);
}
