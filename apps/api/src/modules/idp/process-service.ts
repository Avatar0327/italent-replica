/**
 * 发展计划流程与子流程的写入（docs/02_业务建模/28 IDP-R1 / R2 / R5；Q-M0-115②；口径 K-04 / K-06 / K-08 / K-24）。
 * 子流程是流程的组成部分：整组提交（带 id 的是原有段，不带的是新增段，缺席的段删除），顺序即数组顺序。
 * 嵌套写权限按实际变化在事务内判定（新增段 create、改动的字段 update、删掉的段 delete），未改动的段不要求编辑权。
 */
import { and, eq, idpProcesses, idpSubProcesses, idpTemplateNodeSettings, sql, type Tx } from '@italent/db';
import {
  type IdpApprovalType,
  referencedProcessChangeViolation,
  SUB_PROCESS_FIELDS,
  startRuleViolation,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { requireCreatable, requireEditable, requireNestedWrite } from './access.js';
import type { ProcessCreate, ProcessPatch, SubProcessInput } from './input.js';
import {
  loadProcess,
  loadSubProcessRows,
  processReferenced,
  type ProcessView,
  type SubProcessView,
  subProcessView,
} from './read-model.js';
import {
  audit,
  bumped,
  conflict,
  created,
  invalid,
  requireApprovalProcess,
  requireOrg,
  requireRevision,
  type WriteContext,
} from './write-support.js';

type Deps = Pick<TenantRouteDeps, 'authorize'>;
type SubProcessRow = typeof idpSubProcesses.$inferSelect;
type SubFields = Omit<SubProcessInput, 'id' | 'seq'>;

/** 调整顺序时先把原有段整体挪开，避免逐行更新撞（流程, seq）唯一约束。 */
const SEQ_SHIFT = 1000;

/** 审计快照不带说明文本（派生值，与 fixedDate 同一门禁，DEC-309④：不能经审计绕过字段权限）。 */
const subAudit = (view: SubProcessView) => {
  const { ruleText: _ruleText, ...fields } = view;
  return fields;
};

const processRecord = (view: ProcessView) => {
  const { subProcesses: _subProcesses, referenced: _referenced, ...record } = view;
  return record;
};

function fieldsOf(input: SubProcessInput): SubFields {
  const { id: _id, seq: _seq, ...fields } = input;
  return fields;
}

/** 开启规则自洽（IDP-R2）；违规 400。 */
function validateRules(subs: readonly SubProcessInput[]): void {
  subs.forEach((sub, index) => {
    const violation = startRuleViolation(sub, index);
    if (violation) invalid(`第 ${index + 1} 个子流程：${violation}`, { index });
  });
}

/** 子流程行上与输入对应的字段（比较是否改动用）。 */
function rowFields(row: SubProcessRow): SubFields {
  return {
    name: row.name,
    category: row.category as SubFields['category'],
    approvalType: row.approvalType as SubFields['approvalType'],
    approvalProcessId: row.approvalProcessId,
    endNoticeTemplate: row.endNoticeTemplate,
    startMode: row.startMode as SubFields['startMode'],
    startTimeType: row.startTimeType as SubFields['startTimeType'],
    fixedDate: row.fixedDate,
    referencePoint: row.referencePoint as SubFields['referencePoint'],
    startFrom: row.startFrom as SubFields['startFrom'],
    days: row.days,
  };
}

function changedFields(before: SubFields, after: SubFields): Record<string, unknown> {
  return Object.fromEntries(
    // 省略新增的可选字段时保留原值，旧客户端不需要提交或取得该字段的编辑权。
    SUB_PROCESS_FIELDS.filter((field) => after[field] !== undefined && before[field] !== after[field]).map((field) => [
      field,
      after[field],
    ]),
  );
}

export async function createProcess(tx: Tx, deps: Deps, ctx: WriteContext, input: ProcessCreate) {
  requireCreatable(ctx.scope, 'process', input.orgId);
  await requireOrg(tx, ctx.tenantId, input.orgId);
  validateRules(input.subProcesses);
  for (const sub of input.subProcesses) {
    if (sub.id) invalid('新建流程的子流程不能带标识');
    await requireNestedWrite(tx, deps, ctx, 'subProcess', 'create', fieldsOf(sub));
    await requireApprovalProcess(tx, ctx.tenantId, sub.approvalProcessId, sub.approvalType as IdpApprovalType);
  }
  const [row] = await tx
    .insert(idpProcesses)
    .values({
      tenantId: ctx.tenantId,
      name: input.name,
      orgId: input.orgId,
      publicDown: input.publicDown,
      enabled: input.enabled,
      ...created(ctx),
      updatedAt: ctx.now,
    })
    .returning({ id: idpProcesses.id });
  const id = row!.id;
  await insertSubProcesses(
    tx,
    ctx,
    id,
    input.subProcesses.map((sub, index) => ({ index, input: sub })),
  );
  const after = (await loadProcess(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'process', 'create', id, { before: null, after: processRecord(after), orgId: after.orgId });
  for (const sub of after.subProcesses) {
    await audit(tx, ctx, 'subProcess', 'create', sub.id, { before: null, after: subAudit(sub), orgId: after.orgId });
  }
  return after;
}

async function insertSubProcesses(
  tx: Tx,
  ctx: WriteContext,
  processId: string,
  items: readonly { index: number; input: SubProcessInput }[],
) {
  for (const { index, input } of items) {
    await tx.insert(idpSubProcesses).values({
      tenantId: ctx.tenantId,
      processId,
      seq: index + 1,
      ...fieldsOf(input),
      ...created(ctx),
    });
  }
}

/** 行锁 → 存在 → 可编辑（范围外 404，仅向下公开可见 403）→ revision。 */
async function lockProcess(tx: Tx, ctx: WriteContext, id: string) {
  const P = idpProcesses;
  const [row] = await tx
    .select()
    .from(P)
    .where(and(eq(P.tenantId, ctx.tenantId), eq(P.id, id)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', '发展计划流程不存在');
  await requireEditable(tx, ctx, ctx.scope, 'process', row);
  requireRevision(ctx, row.revision, '发展计划流程');
  return row;
}

export async function updateProcess(tx: Tx, deps: Deps, ctx: WriteContext, id: string, patch: ProcessPatch) {
  const row = await lockProcess(tx, ctx, id);
  const before = (await loadProcess(tx, ctx.tenantId, id))!;
  if (patch.orgId !== undefined && patch.orgId !== row.orgId) {
    requireCreatable(ctx.scope, 'process', patch.orgId);
    await requireOrg(tx, ctx.tenantId, patch.orgId);
  }
  if (patch.subProcesses) await replaceSubProcesses(tx, deps, ctx, id, patch.subProcesses, before.orgId);
  const P = idpProcesses;
  await tx
    .update(P)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.orgId === undefined ? {} : { orgId: patch.orgId }),
      ...(patch.publicDown === undefined ? {} : { publicDown: patch.publicDown }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...bumped(ctx),
    })
    .where(and(eq(P.tenantId, ctx.tenantId), eq(P.id, id)));
  const after = (await loadProcess(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'process', 'update', id, {
    before: processRecord(before),
    after: processRecord(after),
    orgId: after.orgId,
  });
  return after;
}

interface SubProcessPlan {
  readonly rows: readonly SubProcessRow[];
  readonly removed: readonly SubProcessRow[];
  readonly added: readonly { index: number; input: SubProcessInput }[];
  readonly changes: readonly {
    row: SubProcessRow;
    fields: SubFields;
    changed: Record<string, unknown>;
    index: number;
  }[];
}

/**
 * 整组替换子流程：IDP-R5 被模板引用时不能改顺序 / 增删 / 改开启方式（409 IDP_PROCESS_REFERENCED）；已在模板里配置了
 * 节点按钮的段不能换审批流程（409 IDP_NODE_SETTINGS_EXIST，K-28）。只对真正变化的段写入与审计。
 */
async function replaceSubProcesses(
  tx: Tx,
  deps: Deps,
  ctx: WriteContext,
  processId: string,
  next: readonly SubProcessInput[],
  orgId: string,
) {
  // 先锁子流程行再判断节点配置：并发写节点配置的模板事务对子流程行持共享锁，提交后这里才读得到（K-28）
  const rows = await loadSubProcessRows(tx, ctx.tenantId, processId, true);
  validateRules(next);
  if (await processReferenced(tx, ctx.tenantId, processId)) {
    const violation = referencedProcessChangeViolation(
      rows.map((r) => ({ id: r.id, startMode: r.startMode as SubFields['startMode'] })),
      next,
    );
    if (violation) conflict('IDP_PROCESS_REFERENCED', violation);
  }
  const plan = planSubProcesses(rows, next);
  const reordered = plan.changes.some((c) => c.row.seq !== c.index + 1);
  if (!plan.removed.length && !plan.added.length && !reordered && !plan.changes.some((c) => keys(c.changed))) return;
  await checkSubProcessChanges(tx, deps, ctx, plan, next);
  await applySubProcessChanges(tx, ctx, processId, plan, orgId);
}

/** 按标识对齐原有段：带 id 的须属于本流程且不重复；缺席的段删除，不带 id 的段新增。 */
function planSubProcesses(rows: readonly SubProcessRow[], next: readonly SubProcessInput[]): SubProcessPlan {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const added: { index: number; input: SubProcessInput }[] = [];
  const changes: SubProcessPlan['changes'][number][] = [];
  next.forEach((sub, index) => {
    if (!sub.id) return void added.push({ index, input: sub });
    const row = byId.get(sub.id);
    if (!row || seen.has(sub.id)) invalid('子流程不属于本流程或重复出现');
    seen.add(sub.id);
    changes.push({ row, fields: fieldsOf(sub), changed: changedFields(rowFields(row), fieldsOf(sub)), index });
  });
  return { rows, removed: rows.filter((r) => !seen.has(r.id)), added, changes };
}

/** 嵌套写权限（流程的“子流程”字段 + 按实际变化逐段，显式清空同样算改动）、节点配置一致性、审批流程引用。 */
async function checkSubProcessChanges(
  tx: Tx,
  deps: Deps,
  ctx: WriteContext,
  plan: SubProcessPlan,
  next: readonly SubProcessInput[],
) {
  await requireNestedWrite(tx, deps, ctx, 'process', 'update', { subProcesses: next });
  if (plan.removed.length) await requireNestedWrite(tx, deps, ctx, 'subProcess', 'delete');
  // DEC-309④-2：重排（含增删导致的顺序变化）改的是子流程自身的顺序，须有子流程编辑权
  if (plan.changes.some((c) => c.row.seq !== c.index + 1))
    await requireNestedWrite(tx, deps, ctx, 'subProcess', 'update');
  for (const item of plan.added) {
    await requireNestedWrite(tx, deps, ctx, 'subProcess', 'create', fieldsOf(item.input));
    const fields = fieldsOf(item.input);
    await requireApprovalProcess(tx, ctx.tenantId, fields.approvalProcessId, fields.approvalType as IdpApprovalType);
  }
  for (const change of plan.changes) {
    if (!keys(change.changed)) continue;
    await requireNestedWrite(tx, deps, ctx, 'subProcess', 'update', change.changed);
    if ('approvalProcessId' in change.changed && (await hasNodeSettings(tx, ctx.tenantId, change.row.id))) {
      conflict('IDP_NODE_SETTINGS_EXIST', '子流程已在模板中配置了节点按钮，不能更换审批流程，请先清除节点配置');
    }
    if ('approvalProcessId' in change.changed || 'approvalType' in change.changed) {
      const { approvalProcessId, approvalType } = change.fields;
      await requireApprovalProcess(tx, ctx.tenantId, approvalProcessId, approvalType as IdpApprovalType);
    }
  }
}

async function applySubProcessChanges(
  tx: Tx,
  ctx: WriteContext,
  processId: string,
  plan: SubProcessPlan,
  orgId: string,
) {
  const S = idpSubProcesses;
  for (const row of plan.removed) {
    await tx.delete(S).where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, row.id)));
    await audit(tx, ctx, 'subProcess', 'delete', row.id, {
      before: subAudit(subProcessView(row, row.seq - 1)),
      after: null,
      orgId,
    });
  }
  await tx
    .update(S)
    .set({ seq: sql`${S.seq} + ${SEQ_SHIFT}` })
    .where(and(eq(S.tenantId, ctx.tenantId), eq(S.processId, processId)));
  for (const change of plan.changes) {
    await tx
      .update(S)
      .set({ ...change.fields, seq: change.index + 1 })
      .where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, change.row.id)));
  }
  await insertSubProcesses(tx, ctx, processId, plan.added);
  const after = await loadSubProcessRows(tx, ctx.tenantId, processId);
  const beforeViews = new Map(plan.rows.map((r) => [r.id, subProcessView(r, r.seq - 1)]));
  for (const [index, row] of after.entries()) {
    const view = subProcessView(row, index);
    const previous = beforeViews.get(row.id);
    if (!previous) {
      await audit(tx, ctx, 'subProcess', 'create', row.id, { before: null, after: subAudit(view), orgId });
    } else if (JSON.stringify(previous) !== JSON.stringify(view)) {
      const change = { before: subAudit(previous), after: subAudit(view), orgId };
      await audit(tx, ctx, 'subProcess', 'update', row.id, change);
    }
  }
}

const keys = (value: object) => Object.keys(value).length > 0;

async function hasNodeSettings(tx: Tx, tenantId: string, subProcessId: string): Promise<boolean> {
  const N = idpTemplateNodeSettings;
  const [row] = await tx
    .select({ id: N.subProcessId })
    .from(N)
    .where(and(eq(N.tenantId, tenantId), eq(N.subProcessId, subProcessId)))
    .limit(1);
  return row !== undefined;
}

/**
 * 被模板引用的流程不能删除（IDP-R5，409）；删除保留流程与各子流程的快照。级联删除子流程须有子流程删除权
 * （DEC-309④-2，不论子流程是否存在都要求，缺权整次 403），记入台账、重放复核。
 */
export async function deleteProcess(tx: Tx, deps: Deps, ctx: WriteContext, id: string) {
  await lockProcess(tx, ctx, id);
  await requireNestedWrite(tx, deps, ctx, 'subProcess', 'delete');
  if (await processReferenced(tx, ctx.tenantId, id)) {
    conflict('IDP_PROCESS_REFERENCED', '流程已被模板引用，不能删除');
  }
  const before = (await loadProcess(tx, ctx.tenantId, id))!;
  for (const sub of before.subProcesses) {
    await audit(tx, ctx, 'subProcess', 'delete', sub.id, { before: subAudit(sub), after: null, orgId: before.orgId });
  }
  const P = idpProcesses;
  await tx.delete(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.id, id)));
  await audit(tx, ctx, 'process', 'delete', id, { before: processRecord(before), after: null, orgId: before.orgId });
  return before;
}
