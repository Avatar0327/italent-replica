/** F-326 S2：租户级变量配置，读写均由调用者的租户事务承载。 */
import { count, getTableColumns, or } from 'drizzle-orm';
import {
  and,
  approvalProcessNodes,
  approvalProcessVersions,
  approvalVariables,
  asc,
  eq,
  inArray,
  sql,
  transactionLockLedger,
  type Tx,
} from '@italent/db';
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
import { assertReferencesAcknowledged } from './source-usages.js';
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
export { selection as variableSelection };
export type { VariableRow };
const byId = (tenantId: string, id: string) => and(eq(table.tenantId, tenantId), eq(table.id, id));

export type VariableLockMode = 'share' | 'update';

/**
 * F-326-L §3.3 变量行取锁的唯一入口（锁序的最后一层）：一个事务只取一批，按 id 升序，同一变量只有一种最终模式（update 压过 share）。
 * 台账（事务槽位，保存点成功并入外层、回滚丢弃）记录已持有的模式；第二次调用只能重入已持有的子集，
 * 要 update 而台账里只有 share（SHARE→UPDATE 升级）、或要台账之外的变量，都是程序错误：抛错并让整个事务回滚（fail-closed），
 * 不能悄悄再取一批——两个事务各取一批会互等成环。
 */
export async function lockVariableBatch(
  tx: Tx,
  ctx: { readonly tenantId: string },
  rows: readonly { readonly id: string; readonly mode: VariableLockMode }[],
): Promise<void> {
  const wanted = new Map<string, VariableLockMode>();
  for (const { id, mode } of rows) if (mode === 'update' || !wanted.has(id)) wanted.set(id, mode);
  if (!wanted.size) return;
  const ledger = transactionLockLedger(tx);
  const ids = [...wanted.keys()].sort();
  if (!ledger.empty()) {
    const missing = await absentFrom(
      tx,
      ctx,
      ids.filter((id) => !ledger.held(id)),
    );
    for (const id of ids) {
      const held = ledger.held(id);
      // 不存在的变量没有行可锁：交给调用方随后的读取抛原业务错误（APPROVAL_VARIABLE_NOT_FOUND），不算台账程序错误
      if (!held && missing.has(id)) continue;
      if (!held || (wanted.get(id) === 'update' && held !== 'update'))
        throw new Error(`自动变量锁台账：事务内已取过变量锁，不得再取 ${held ? '升级' : '新增'}的变量 ${id}`);
    }
    return;
  }
  for (const id of ids) {
    const query = tx.select({ id: table.id }).from(table).where(byId(ctx.tenantId, id));
    const locked = await (wanted.get(id) === 'update' ? query.for('update') : query.for('share'));
    // 只登记查询实际返回的行：没取到行（变量不存在）不能记成已持锁
    if (locked.length) ledger.record(id, wanted.get(id)!);
  }
}

/** 不加锁地查出 ids 里在本租户下不存在的变量。 */
async function absentFrom(tx: Tx, ctx: { readonly tenantId: string }, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const found = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.tenantId, ctx.tenantId), inArray(table.id, [...ids])));
  const present = new Set(found.map((row) => row.id));
  return new Set(ids.filter((id) => !present.has(id)));
}

/** 本事务新建的变量行天然被本事务独占：记为 update，后续收尾可以在这个集合内动作（台账只认已持有的锁）。 */
export function recordCreatedVariable(tx: Tx, id: string): void {
  transactionLockLedger(tx).record(id, 'update');
}

export async function loadVariable(tx: Tx, tenantId: string, id: string, lock = false): Promise<VariableRow> {
  if (lock) await lockVariableBatch(tx, { tenantId }, [{ id, mode: 'update' }]);
  const [row] = await tx.select(selection).from(table).where(byId(tenantId, id));
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

/**
 * 来源列（设计 §5.5“人工 / 自动（流程名 · 节点名）”，DEC-941）：按来源版本联接现有流程版本与节点取名，只读不落列；
 * 名称取生成该变量的那个版本（不随后续版本改名漂移），版本或节点已不存在时为空。
 */
async function originNames(tx: Tx, tenantId: string, rows: VariableRow[]) {
  const versionIds = [...new Set(rows.flatMap((row) => (row.originVersionId ? [row.originVersionId] : [])))];
  if (!versionIds.length) return () => ({ originProcessName: null, originNodeName: null });
  const versions = await tx
    .select({ id: approvalProcessVersions.id, name: approvalProcessVersions.name })
    .from(approvalProcessVersions)
    .where(and(eq(approvalProcessVersions.tenantId, tenantId), inArray(approvalProcessVersions.id, versionIds)));
  const nodes = await tx
    .select({
      versionId: approvalProcessNodes.versionId,
      nodeKey: approvalProcessNodes.nodeKey,
      name: approvalProcessNodes.name,
    })
    .from(approvalProcessNodes)
    .where(and(eq(approvalProcessNodes.tenantId, tenantId), inArray(approvalProcessNodes.versionId, versionIds)));
  const processName = new Map(versions.map((version) => [version.id, version.name]));
  const nodeName = new Map(nodes.map((node) => [`${node.versionId}:${node.nodeKey}`, node.name]));
  return (row: VariableRow) => ({
    originProcessName: (row.originVersionId && processName.get(row.originVersionId)) ?? null,
    originNodeName: nodeName.get(`${row.originVersionId}:${row.originNodeKey}`) ?? null,
  });
}

async function variableViews(tx: Tx, tenantId: string, rows: VariableRow[]) {
  const originOf = await originNames(tx, tenantId, rows);
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
    origin: row.origin as 'manual' | 'auto',
    ...originOf(row),
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

/** 自动变量（S7a）的审计快照多带来源位置，人工变量保持原键集合，既有审计不变。 */
function snapshot(row: VariableRow) {
  const origin =
    row.origin === 'auto'
      ? {
          origin: row.origin,
          originProcessId: row.originProcessId,
          originVersionId: row.originVersionId,
          originNodeKey: row.originNodeKey,
          originSlot: row.originSlot,
        }
      : {};
  return {
    ...origin,
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
export async function auditVariable(
  tx: Tx,
  ctx: ApprovalContext,
  action: string,
  before: VariableRow | null,
  after: VariableRow,
  extra: Record<string, unknown> = {},
  afterOnly = false,
) {
  const kind = after.scope === 'public' ? 'public' : 'application';
  const objectType = `approval-${kind}-variable`;
  const eventType = `approval.${kind}_variable.${action}`;
  await auditApproval(tx, ctx, {
    action: eventType,
    objectType,
    objectId: after.id,
    before: before ? snapshot(before) : null,
    after: { ...snapshot(after), ...extra },
    ...(afterOnly ? { afterOnly: Object.keys(extra) } : {}),
  });
  await emitOutbox(tx, ctx, { objectType, objectId: after.id, eventType, revision: after.revision });
}
const audited = auditVariable;

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

/** S7a：自动变量只允许改名称、默认值与说明；编码、适用范围、来源不可改（DEC-858），人工变量的 origin 同样不可改。 */
function assertAutoVariableUnlocked(before: VariableRow, input: UpdateVariableInput) {
  // 来源是系统登记的，任何带 origin 的修改都拒绝（人工变量沿用原“字段不可改”，自动变量给专门的机读原因）
  if (input.origin !== undefined)
    throw approvalError(
      'VALIDATION_FAILED',
      before.origin === 'auto' ? 'APPROVAL_AUTO_VARIABLE_FIELD_LOCKED' : 'APPROVAL_VARIABLE_FIELD_LOCKED',
      '变量来源不可修改',
    );
  if (before.origin !== 'auto') return;
  const sameScopes =
    input.usageScopes === undefined ||
    (input.usageScopes.length === before.usageScopes.length &&
      input.usageScopes.every((scope) => before.usageScopes.includes(scope)));
  if ((input.code !== undefined && input.code !== before.code) || !sameScopes)
    throw approvalError(
      'VALIDATION_FAILED',
      'APPROVAL_AUTO_VARIABLE_FIELD_LOCKED',
      '自动生成的变量不可修改编码和适用范围',
    );
}

export async function updateVariable(tx: Tx, ctx: ApprovalContext, id: string, input: UpdateVariableInput) {
  // F-326-L §3.1：管理员只锁本变量，不在持有变量锁之后获取流程头、实例或业务锁。
  const before = await loadVariable(tx, ctx.tenantId, id, true);
  assertRevision(ctx.expectedRevision, before.revision);
  assertAutoVariableUnlocked(before, input);
  for (const key of ['code', 'scope', 'appId', 'dataType'] as const) {
    if (input[key] !== undefined && input[key] !== before[key])
      throw approvalError('VALIDATION_FAILED', 'APPROVAL_VARIABLE_FIELD_LOCKED', '编码、类型和归属不可修改');
  }
  const { acknowledgedReferenceCount, ...changes } = input;
  const previous = valuesOf(before);
  const value = validateVariableValues({ ...previous, ...changes } as VariableValues, previous);
  await checkPeople(tx, ctx, value, before.status === 'enabled');
  // F-326 §6：从公共变量的适用范围里去掉“流程”，等于让现有流程节点失去这个变量，须确认影响
  if (previous.usageScopes.includes('process') && !value.usageScopes.includes('process'))
    await assertReferencesAcknowledged(tx, ctx.tenantId, { kind: 'variable', id }, acknowledgedReferenceCount);
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

/** S7a：同一版本同一位置只能有一条未停用的自动变量；启用旧变量时位置已被新变量占用 → 409，给出占位者。 */
async function assertAutoSlotFree(tx: Tx, tenantId: string, row: VariableRow) {
  if (row.origin !== 'auto') return;
  const [taken] = await tx
    .select({ id: table.id, code: table.code, name: table.name })
    .from(table)
    .where(
      and(
        eq(table.tenantId, tenantId),
        eq(table.origin, 'auto'),
        eq(table.originVersionId, row.originVersionId!),
        eq(table.originNodeKey, row.originNodeKey!),
        eq(table.originSlot, row.originSlot!),
        sql`${table.status} <> 'disabled' AND ${table.id} <> ${row.id}`,
      ),
    )
    .limit(1);
  if (taken)
    throw approvalError('CONFLICT', 'APPROVAL_AUTO_VARIABLE_SLOT_TAKEN', '该位置已有启用的自动变量，请先停用后再启用', {
      occupiedBy: taken,
    });
}

export async function setVariableStatus(
  tx: Tx,
  ctx: ApprovalContext,
  id: string,
  action: 'enable' | 'disable',
  acknowledgedReferenceCount?: number,
) {
  const before = await loadVariable(tx, ctx.tenantId, id, true);
  assertRevision(ctx.expectedRevision, before.revision);
  const status = statusAfter(before.status as VariableStatus, action);
  if (!status) throw approvalError('CONFLICT', 'APPROVAL_VARIABLE_STATUS_INVALID', '当前状态不允许此操作');
  if (action === 'enable') {
    await checkPeople(tx, ctx, valuesOf(before), true);
    await assertAutoSlotFree(tx, ctx.tenantId, before);
  }
  // 停用不被引用挡住（设计 §6）：运行时按“没有人”走节点空人策略；但必须确认看过引用清单的总数
  if (action === 'disable')
    await assertReferencesAcknowledged(tx, ctx.tenantId, { kind: 'variable', id }, acknowledgedReferenceCount);
  await changeStatus(tx, ctx, before, status, action);
  return variableDetail(tx, ctx.tenantId, id);
}
