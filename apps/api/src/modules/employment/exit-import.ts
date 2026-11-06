/**
 * F-139a 历史离职人员导入：预览与导入服务（docs/08_设计/F-139_历史离职人员导入_设计.md §3～§7）。
 * 一行 = 建人员档案 + 入职段（direct hire，生效日 H）+ 离职段（kind=leave，生效日 E = L + 1，直接落为 effective）。
 * 预览与导入共用 assessImportRows：先收齐全部行错误与编制提示，再整批一次写入；任何一行有错，整批零写入。
 * 离职段不走生效链：不触发 onEffective、不排账号任务、不写 exit_effects / employment_activation_attempts（§5）。
 */
import { randomUUID } from 'node:crypto';
import { exitRequests, sql, type Tx } from '@italent/db';
import {
  BLACKLIST_NOTE_MAX,
  BLACKLIST_REASON_CODES,
  duplicateEmployeeNoRows,
  EXIT_IMPORT_BUTTON,
  EXIT_IMPORT_ROW_LIMIT,
  exitImportEffectiveDate,
  tenantLocalDate,
  validateExitImportBlacklist,
  validateExitImportDates,
  type ExitDictionaryKind,
  type ExitImportIssue,
} from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { rawImportRows, recordOperationLog } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { importedTenureExcesses, type ImportedTenureSegment } from '../establishment/employment-check.js';
import { lockOrganizationSettings } from '../org/locks.js';
import { employmentCapacityContext } from '../permission/module-capacity-authorization.js';
import type { ModuleScope } from '../permission/scope-types.js';
import { addBlacklistEntry } from './blacklist.js';
import { auditEmployment, EMPLOYEE_OBJECT, requireEmploymentWrite } from './context.js';
import { createEmployee } from './employees.js';
import { dutyTransferTiming, selectedStaffOf } from './exit-application.js';
import { capacityVisible } from './exit-cancel-intervals.js';
import { assertExitDictionaryEnabled } from './exit-dictionaries.js';
import { validateNewEmploymentReferences } from './references.js';
import { lockEmploymentBusiness, lockEmploymentEmployee, rowsOf } from './record-store.js';
import { appendEmploymentState, createEmploymentBusiness, materializeEmploymentRecord } from './write-service.js';
import { emptyPresetFields, type EmploymentContext } from './types.js';
import { auditActor } from '../../system-actor.js';

/**
 * 请求行的结构层只管类型与未知字段（z.strictObject，未知字段仍整体 400）；空白、超长这类行内容问题不在这里挡，
 * 否则一个空姓名会让整批只报英文 zod 文案、后面的行也没机会预校验（F-139a 第 2 轮 P2-1），交给 shapeIssues 逐行汇报。
 * 可选字段允许 null（设计 §2.2 的请求形状），解析时统一当作未填（P2-2）。
 */
const loose = z.string().nullish();
const rowSchema = z.strictObject({
  rowNo: z.int().min(1).max(1_000_000).nullish(),
  employeeNo: loose,
  name: loose,
  entryDate: loose,
  departmentCode: loose,
  lastWorkDate: loose,
  positionCode: loose,
  postCode: loose,
  exitTypeCode: loose,
  exitReasonCode: loose,
  exitDestinationCode: loose,
  addToBlacklist: z.boolean().nullish(),
  blacklistReason: loose,
  blacklistExpiryDate: loose,
  blacklistNote: loose,
});
const bodySchema = z.strictObject({ rows: z.array(rowSchema).min(1), confirmed: z.boolean().nullish() });

/** 规范化后的行：字符串已 trim，null 与缺省一律为 undefined；必填字段缺失时为空串，由 shapeIssues 逐行汇报。 */
export interface ImportRowInput {
  readonly rowNo: number;
  readonly employeeNo: string;
  readonly name: string;
  readonly entryDate: string;
  readonly departmentCode: string;
  readonly lastWorkDate: string;
  readonly positionCode?: string;
  readonly postCode?: string;
  readonly exitTypeCode?: string;
  readonly exitReasonCode?: string;
  readonly exitDestinationCode?: string;
  readonly addToBlacklist?: boolean;
  readonly blacklistReason?: string;
  readonly blacklistExpiryDate?: string;
  readonly blacklistNote?: string;
}
export interface ExitImportBody {
  readonly rows: readonly ImportRowInput[];
  readonly confirmed: boolean;
}

/** 请求体解析：行数超限先于逐行校验（400 BATCH_LIMIT_EXCEEDED）；缺省 rowNo = 数组下标 + 1，按 rowNo 升序处理。 */
export function parseExitImportBody(raw: unknown): ExitImportBody {
  if (rawImportRows(raw, 'rows').length > EXIT_IMPORT_ROW_LIMIT)
    throw new AppError('VALIDATION_FAILED', `单次最多导入 ${EXIT_IMPORT_ROW_LIMIT} 行`, {
      reason: 'BATCH_LIMIT_EXCEEDED',
      limit: EXIT_IMPORT_ROW_LIMIT,
    });
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', parsed.error.issues);
  const rows = parsed.data.rows.map((row, index) => normalizeRow(row, index));
  if (new Set(rows.map((row) => row.rowNo)).size !== rows.length)
    throw new AppError('VALIDATION_FAILED', '行号不能重复', { reason: 'DUPLICATE_ROW_NO' });
  return { rows: rows.sort((a, b) => a.rowNo - b.rowNo), confirmed: parsed.data.confirmed === true };
}

type RawRow = z.infer<typeof rowSchema>;
const trimmed = (value: string | null | undefined) => (typeof value === 'string' ? value.trim() : undefined);
const optionalText = (key: string, value: string | null | undefined) =>
  trimmed(value) === undefined ? {} : { [key]: trimmed(value) };

function normalizeRow(row: RawRow, index: number): ImportRowInput {
  return {
    rowNo: row.rowNo ?? index + 1,
    employeeNo: trimmed(row.employeeNo) ?? '',
    name: trimmed(row.name) ?? '',
    entryDate: trimmed(row.entryDate) ?? '',
    departmentCode: trimmed(row.departmentCode) ?? '',
    lastWorkDate: trimmed(row.lastWorkDate) ?? '',
    ...optionalText('positionCode', row.positionCode),
    ...optionalText('postCode', row.postCode),
    ...optionalText('exitTypeCode', row.exitTypeCode),
    ...optionalText('exitReasonCode', row.exitReasonCode),
    ...optionalText('exitDestinationCode', row.exitDestinationCode),
    ...(row.addToBlacklist === null || row.addToBlacklist === undefined ? {} : { addToBlacklist: row.addToBlacklist }),
    ...optionalText('blacklistReason', row.blacklistReason),
    ...optionalText('blacklistExpiryDate', row.blacklistExpiryDate),
    ...optionalText('blacklistNote', row.blacklistNote),
  };
}

/** [字段, 中文名, 最大长度, 是否必填]：必填缺失、可选填了空白、超长，都按行汇报（P2-1）。 */
const SHAPE_RULES: readonly [keyof ImportRowInput, string, number, boolean][] = [
  ['employeeNo', '工号', 100, true],
  ['name', '姓名', 200, true],
  ['entryDate', '入职日期', 32, true],
  ['departmentCode', '部门编码', 100, true],
  ['lastWorkDate', '最后工作日', 32, true],
  ['positionCode', '职位编码', 100, false],
  ['postCode', '岗位编码', 100, false],
  ['exitTypeCode', '离职类型', 100, false],
  ['exitReasonCode', '离职原因', 100, false],
  ['exitDestinationCode', '离职去向', 100, false],
];
const NOTE_RULES: readonly [keyof ImportRowInput, string, number][] = [
  ['blacklistReason', '加黑原因', 100],
  ['blacklistExpiryDate', '加黑到期日', 32],
  ['blacklistNote', '加黑说明', BLACKLIST_NOTE_MAX],
];

function shapeIssues(row: ImportRowInput): RowIssue[] {
  const issue = (field: string, message: string): RowIssue => ({ field, reason: 'VALIDATION_FAILED', message });
  const issues: RowIssue[] = [];
  for (const [field, label, max, required] of SHAPE_RULES) {
    const value = row[field] as string | undefined;
    if (value === undefined) {
      if (required) issues.push(issue(field, `${label}不能为空`));
    } else if (value === '') {
      issues.push(issue(field, required ? `${label}不能为空` : `${label}不能是空白（不填请留空或传 null）`));
    } else if (value.length > max) issues.push(issue(field, `${label}不能超过 ${max} 个字符`));
  }
  for (const [field, label, max] of NOTE_RULES) {
    const value = row[field] as string | undefined;
    if (value !== undefined && value.length > max) issues.push(issue(field, `${label}不能超过 ${max} 个字符`));
  }
  return issues;
}

/**
 * 入口权限链（设计 §7，预览与导入同一份）：任职功能权由 readContext 判过，这里补人员新增权、导入按钮、字段写权，
 * 并要求显式“看全部”范围（DEC-121：新员工尚无任职鉴权字段）。命令内由 exitImportGuard 用事务内授权器再过一遍。
 */
export async function requireExitImportAccess(
  ctx: EmploymentContext,
  rows: readonly ImportRowInput[],
  employeeScope: ModuleScope | undefined,
): Promise<void> {
  if (!ctx.authorize) return;
  await requireEmploymentWrite(ctx, 'create', { code: 'x', name: 'x' }, undefined, EMPLOYEE_OBJECT);
  await requireEmploymentWrite(ctx, 'create', writtenFields(rows), EXIT_IMPORT_BUTTON);
  if (ctx.scope && !ctx.scope.all) throw new AppError('FORBIDDEN', '批量导入历史离职人员需要“全部数据”范围');
  // 人员对象的范围与任职记录分开配置（scope-resolver 按对象编码匹配“看全部”），POST /employees 看的是人员对象的范围；
  // 缺失按未配置处理（fail-closed，硬规则 1）。
  if (!employeeScope?.all) throw new AppError('FORBIDDEN', '批量导入历史离职人员需要人员对象的“全部数据”范围');
}

/**
 * 字段写权按本批实际写入的字段判（设计 §5.1 第 3 条）：部门、入职日期、最后工作日必有；可选字段只要有一行填了就要有写权。
 * 导入字段与权限字段编码不同的做了映射：离职原因 → reasonCode，离职去向 → whereaboutsCode，职位 / 岗位 → positionId / postId。
 */
function writtenFields(rows: readonly ImportRowInput[]) {
  const given = (pick: (row: ImportRowInput) => unknown) =>
    rows.some((row) => pick(row) !== undefined && pick(row) !== '');
  const fields: Record<string, string> = { departmentId: 'x', lastWorkDate: 'x' };
  const optional: [string, (row: ImportRowInput) => unknown][] = [
    ['positionId', (row) => row.positionCode],
    ['postId', (row) => row.postCode],
    ['exitTypeCode', (row) => row.exitTypeCode],
    ['reasonCode', (row) => row.exitReasonCode],
    ['whereaboutsCode', (row) => row.exitDestinationCode],
    ['blacklistNote', (row) => row.blacklistNote],
  ];
  for (const [code, pick] of optional) if (given(pick)) fields[code] = 'x';
  if (rows.some((row) => row.addToBlacklist === true))
    for (const code of ['addToBlacklist', 'blacklistReason', 'blacklistExpiryDate']) fields[code] = 'x';
  return { kind: 'hire', mode: 'direct', effectiveDate: '2000-01-01', fields };
}

// ---- 评估 ------------------------------------------------------------------------------------------------

export interface RowIssue extends ExitImportIssue {
  readonly disabledOn?: string;
}
export interface ImportWarning {
  readonly reason: 'ESTABLISHMENT_EXCEEDED';
  readonly capacityId: string;
  readonly departmentId: string;
  readonly positionId: string | null;
  readonly from: string;
  readonly to: string;
  readonly peak: number | null;
  readonly limit: number | null;
}
interface ResolvedRow {
  readonly departmentId: string;
  readonly positionId: string | null;
  readonly postId: string | null;
}
export interface RowAssessment {
  readonly row: ImportRowInput;
  readonly errors: RowIssue[];
  readonly warnings: ImportWarning[];
  /** 本行在编制对象范围外不可见的超编数：只用于本行的确认审计，批级总数在 ImportAssessment.hiddenCount。 */
  readonly hidden: number;
  readonly resolved?: ResolvedRow;
}
export interface ImportAssessment {
  readonly rows: RowAssessment[];
  readonly hiddenCount: number;
}

const DICTIONARIES: readonly [keyof ImportRowInput, ExitDictionaryKind, string][] = [
  ['exitTypeCode', 'types', '离职类型'],
  ['exitReasonCode', 'reasons', '离职原因'],
  ['exitDestinationCode', 'whereabouts', '离职去向'],
];

/** 预览与导入共用：逐行收齐错误；整批无错才评估编制。不写任何数据。 */
export async function assessImportRows(
  tx: Tx,
  ctx: EmploymentContext,
  rows: readonly ImportRowInput[],
): Promise<ImportAssessment> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const duplicated = duplicateEmployeeNoRows(rows);
  const assessed: RowAssessment[] = [];
  for (const row of rows) assessed.push(await assessRow(tx, ctx, row, today, duplicated.has(row.rowNo)));
  if (assessed.some((item) => item.errors.length > 0)) return { rows: assessed, hiddenCount: 0 };
  return withEstablishment(tx, ctx, assessed);
}

async function assessRow(
  tx: Tx,
  ctx: EmploymentContext,
  row: ImportRowInput,
  today: string,
  duplicate: boolean,
): Promise<RowAssessment> {
  const errors: RowIssue[] = shapeIssues(row);
  const bad = new Set(errors.map((issue) => issue.field));
  // 每个校验只在它依赖的字段合法时跑；其余照常往下走，让整批一次收齐（P2-1）
  const dateIssues = bad.has('entryDate') || bad.has('lastWorkDate') ? [] : validateExitImportDates(row, today);
  errors.push(...dateIssues);
  const datesOk = !bad.has('entryDate') && !bad.has('lastWorkDate') && dateIssues.length === 0;
  if (!bad.has('employeeNo')) {
    if (await employeeNoExists(tx, ctx.tenantId, row.employeeNo))
      errors.push({ field: 'employeeNo', reason: 'EMPLOYEE_NO_EXISTS', message: '工号已存在' });
    if (duplicate) errors.push({ field: 'employeeNo', reason: 'DUPLICATE_IN_BATCH', message: '同一批里工号重复' });
  }
  const resolved = bad.has('departmentCode')
    ? undefined
    : await resolveCodes(tx, ctx.tenantId, row, datesOk ? row.entryDate : undefined, errors);
  // 日期本身不合法时，依赖日期的部门区间 / 设立日校验没有意义，跳过（每行只报最前面的问题）
  if (datesOk && resolved)
    await collect(
      errors,
      () =>
        validateNewEmploymentReferences(
          tx,
          ctx,
          { ...emptyPresetFields(), ...fieldsOf(resolved) },
          row.entryDate,
          undefined,
          false,
          false,
          exitImportEffectiveDate(row.lastWorkDate),
        ),
      undefined,
      undefined,
      'departmentCode',
    );
  for (const [field, kind, label] of DICTIONARIES) {
    const value = row[field] as string | undefined;
    if (value) await collect(errors, () => assertExitDictionaryEnabled(tx, ctx.tenantId, kind, value), field, label);
  }
  errors.push(...blacklistIssues(row, datesOk));
  return { row, errors, warnings: [], hidden: 0, ...(resolved ? { resolved } : {}) };
}

function blacklistIssues(row: ImportRowInput, datesOk: boolean): ExitImportIssue[] {
  const issues = datesOk ? validateExitImportBlacklist(row, exitImportEffectiveDate(row.lastWorkDate)) : [];
  const reasons: readonly string[] = BLACKLIST_REASON_CODES;
  if (row.addToBlacklist && row.blacklistReason && !reasons.includes(row.blacklistReason))
    issues.push({ field: 'blacklistReason', reason: 'VALIDATION_FAILED', message: '黑名单原因不在可选范围内' });
  return issues;
}

/** 校验函数用内部字段名（departmentId 等）或只给原因码；导入请求里对应的是下面这些字段。 */
const REASON_FIELD: Readonly<Record<string, string>> = {
  EMPLOYMENT_DEPARTMENT_DISABLED: 'departmentCode',
  ENTRY_BEFORE_DEPARTMENT_FOUNDED: 'entryDate',
};
const INTERNAL_FIELD: Readonly<Record<string, string>> = {
  departmentId: 'departmentCode',
  positionId: 'positionCode',
  postId: 'postCode',
  effectiveDate: 'entryDate',
};

/**
 * 把引用 / 字典校验抛出的业务错误转成行错误；组织调整暂停是整租户状态，不属于某一行，原样抛出。
 * 每条行错误都带导入请求里的字段名：显式 field > 原因码映射 > 内部字段名映射 > fallback。
 */
async function collect(
  errors: RowIssue[],
  run: () => Promise<unknown>,
  field?: string,
  label?: string,
  fallback?: string,
) {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const details = (error.details ?? {}) as { reason?: string; disabledOn?: string; field?: string };
    if (details.reason === 'ORG_ADJUSTMENT_EXECUTING') throw error;
    const where =
      field ??
      (details.reason ? REASON_FIELD[details.reason] : undefined) ??
      (details.field ? (INTERNAL_FIELD[details.field] ?? details.field) : undefined) ??
      fallback;
    errors.push({
      ...(where ? { field: where } : {}),
      reason: details.reason ?? error.code,
      message: label ? `${label}：${error.message}` : error.message,
      ...(details.disabledOn ? { disabledOn: details.disabledOn } : {}),
    });
  }
}

async function employeeNoExists(tx: Tx, tenantId: string, employeeNo: string) {
  const found = rowsOf(
    await tx.execute(sql`SELECT 1 FROM employment_employees WHERE tenant_id=${tenantId}
      AND lower(code)=lower(${employeeNo}) LIMIT 1`),
  );
  return found.length > 0;
}

/**
 * 业务编码 → 稳定对象 ID（DEC-060）。多个版本时取覆盖入职日的那一版，其次取最近起点；
 * 职位必须挂在本行部门下。找不到给 REFERENCE_NOT_FOUND，不猜。
 */
async function resolveCodes(
  tx: Tx,
  tenantId: string,
  row: ImportRowInput,
  asOf: string | undefined,
  errors: RowIssue[],
): Promise<ResolvedRow | undefined> {
  const on = asOf ?? '9999-12-31';
  const [department] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT org_id::text AS id FROM org_versions WHERE tenant_id=${tenantId}
      AND code=${row.departmentCode}
      ORDER BY (start_date <= ${on}::date AND ${on}::date <= stop_date) DESC, start_date DESC LIMIT 1`),
  );
  if (!department) errors.push(notFound('departmentCode', '部门编码'));
  let positionId: string | null = null;
  let postId: string | null = null;
  if (row.positionCode) {
    const [position] = rowsOf<{ id: string; orgId: string }>(
      await tx.execute(sql`SELECT object_id::text AS id, org_id::text AS "orgId" FROM job_position_versions
        WHERE tenant_id=${tenantId} AND code=${row.positionCode}
        ORDER BY (start_date <= ${on}::date AND ${on}::date <= stop_date) DESC, start_date DESC LIMIT 1`),
    );
    if (!position || (department && position.orgId !== department.id))
      errors.push(notFound('positionCode', '职位编码', position ? '职位不属于该部门' : undefined));
    else positionId = position.id;
  }
  if (row.postCode) {
    const [post] = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT object_id::text AS id FROM job_post_versions
        WHERE tenant_id=${tenantId} AND code=${row.postCode}
        ORDER BY (start_date <= ${on}::date AND ${on}::date <= stop_date) DESC, start_date DESC LIMIT 1`),
    );
    if (!post) errors.push(notFound('postCode', '岗位编码'));
    else postId = post.id;
  }
  if (!department || errors.some((e) => e.reason === 'REFERENCE_NOT_FOUND')) return undefined;
  return { departmentId: department.id, positionId, postId };
}

const notFound = (field: string, label: string, message?: string): RowIssue => ({
  field,
  reason: 'REFERENCE_NOT_FOUND',
  message: message ?? `${label}不存在`,
});

/**
 * 编制评估（设计 §4.4）：每行按自己的 [H, E) 评估，同批其他行作为同批成员计入（区间不相交的行互不影响）。
 * 严格 / 非严格控编这里都只提示，由调用方要求 confirmed（DEC-258）。编制对象自己的数据范围不可见的，
 * 不返回 ID / 峰值 / 上限，只计入 hiddenCount（F-251）。
 */
async function withEstablishment(tx: Tx, ctx: EmploymentContext, assessed: RowAssessment[]): Promise<ImportAssessment> {
  const segments = assessed.map((item) => segmentOf(item));
  const capacityContext = await employmentCapacityContext(tx, ctx);
  let hiddenCount = 0;
  const rows: RowAssessment[] = [];
  for (const [index, item] of assessed.entries()) {
    const segment = segments[index]!;
    const excesses = await importedTenureExcesses(
      tx,
      ctx,
      segment,
      segments.filter((_, other) => other !== index),
    );
    const warnings: ImportWarning[] = [];
    let hidden = 0;
    for (const excess of excesses) {
      if (!(await capacityVisible(tx, capacityContext, excess))) {
        hidden += 1;
        continue;
      }
      warnings.push({
        reason: 'ESTABLISHMENT_EXCEEDED',
        capacityId: excess.capacityId,
        departmentId: segment.departmentId,
        positionId: excess.positionId ?? segment.positionId,
        from: segment.from,
        to: segment.until,
        peak: excess.peak ?? null,
        limit: excess.limit ?? null,
      });
    }
    hiddenCount += hidden;
    rows.push({ ...item, warnings, hidden });
  }
  return { rows, hiddenCount };
}

function segmentOf(item: RowAssessment): ImportedTenureSegment {
  const resolved = item.resolved!;
  return {
    key: `import-row:${item.row.rowNo}`,
    departmentId: resolved.departmentId,
    positionId: resolved.positionId,
    fields: { departmentId: resolved.departmentId, positionId: resolved.positionId, postId: resolved.postId },
    from: item.row.entryDate,
    until: exitImportEffectiveDate(item.row.lastWorkDate),
  } as ImportedTenureSegment;
}

// ---- 预览 ------------------------------------------------------------------------------------------------

export async function previewExitImport(tx: Tx, ctx: EmploymentContext, body: ExitImportBody) {
  const { rows, hiddenCount } = await assessImportRows(tx, ctx, body.rows);
  const failed = rows.filter((item) => item.errors.length > 0).length;
  const warned = rows.filter((item) => item.warnings.length > 0).length;
  return {
    rows: rows.map((item) => ({
      rowNo: item.row.rowNo,
      ok: item.errors.length === 0,
      errors: item.errors,
      warnings: item.warnings,
    })),
    hiddenCount,
    summary: { total: rows.length, ok: rows.length - failed, failed, warned },
  };
}

// ---- 导入 ------------------------------------------------------------------------------------------------

export interface ImportedRowReceipt {
  readonly rowNo: number;
  readonly employeeId: string;
  readonly hireBusinessId: string;
  readonly exitBusinessId: string;
}

/**
 * 命令内的整批导入。锁序（§6 步骤 0）：工号（升序）→ 组织设置 → 编制 → 业务；
 * 评估期间发现的任何问题都在写入前抛出，所以 400 / 409 都是零写入。
 */
export async function importExits(tx: Tx, ctx: EmploymentContext, body: ExitImportBody) {
  for (const no of [...new Set(body.rows.map((row) => row.employeeNo.trim().toLowerCase()))].sort())
    await advisoryLock(tx, asUuid(ctx.tenantId), `:employee-no:${no}`);
  await lockOrganizationSettings(tx, ctx.tenantId);
  const { rows, hiddenCount } = await assessImportRows(tx, ctx, body.rows);
  const invalid = rows.filter((item) => item.errors.length > 0);
  if (invalid.length > 0)
    throw new AppError('IMPORT_ROWS_INVALID', '导入数据有误，整批未保存', {
      rows: invalid.map((item) => ({ rowNo: item.row.rowNo, errors: item.errors })),
    });
  const warned = rows.filter((item) => item.warnings.length > 0);
  if ((warned.length > 0 || hiddenCount > 0) && !body.confirmed)
    throw new AppError('CONFLICT', '导入后将超出设定编制，请确认', {
      reason: 'CONFIRMATION_REQUIRED',
      rows: warned.map((item) => ({ rowNo: item.row.rowNo, warnings: item.warnings })),
      hiddenCount,
    });
  const batchId = randomUUID();
  const receipts: ImportedRowReceipt[] = [];
  for (const item of rows) receipts.push(await writeRow(tx, ctx, batchId, item));
  await recordOperationLog(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    behavior: 'import',
    objectType: 'exit-import',
    successCount: receipts.length,
    failureCount: 0,
    items: receipts.map((receipt, rowIndex) => ({
      rowIndex,
      outcome: 'succeeded' as const,
      employeeId: receipt.employeeId,
      objectId: receipt.exitBusinessId,
      orgId: rows[rowIndex]!.resolved!.departmentId,
    })),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  return { batchId, rows: receipts };
}

/** 一行的写入（§6 步骤 2～8）：建档 → 入职 → 离职 → 离职扩展行 → 落地 → 可选加黑 → 自检。 */
async function writeRow(
  tx: Tx,
  ctx: EmploymentContext,
  batchId: string,
  item: RowAssessment,
): Promise<ImportedRowReceipt> {
  const { row } = item;
  const resolved = item.resolved!;
  const effectiveDate = exitImportEffectiveDate(row.lastWorkDate);
  const importCtx: EmploymentContext = { ...ctx, trustedExit: 'import', expectedRevision: 0 };
  // 步骤 2：只建人员档案，不开通账号（无 permission_user_person_links）
  const employee = await createImportedEmployee(tx, importCtx, row);
  const afterCreate = await lockEmploymentEmployee(tx, importCtx, employee.id);
  const hire = await createEmploymentBusiness(
    tx,
    { ...importCtx, expectedRevision: afterCreate.revision },
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: row.entryDate,
      fields: fieldsOf(resolved),
      customFields: {},
    },
    { importedTenure: { until: effectiveDate } },
  );
  const afterHire = await lockEmploymentEmployee(tx, importCtx, employee.id);
  const leave = await createEmploymentBusiness(
    tx,
    { ...importCtx, expectedRevision: afterHire.revision },
    employee.id,
    { kind: 'leave', mode: 'direct', lastWorkDate: row.lastWorkDate, fields: {}, customFields: {} },
  );
  await tx.insert(exitRequests).values({
    tenantId: ctx.tenantId,
    businessId: leave.id,
    employeeId: employee.id,
    staffId: await selectedStaffOf(tx, ctx, leave.id),
    mode: 'import',
    initiator: 'hr',
    initiatorUserId: ctx.userId,
    exitTypeCode: row.exitTypeCode ?? null,
    reasonCode: row.exitReasonCode ?? null,
    whereaboutsCode: row.exitDestinationCode ?? null,
    addToBlacklist: row.addToBlacklist === true,
    blacklistExpiryDate: row.addToBlacklist ? (row.blacklistExpiryDate ?? null) : null,
    blacklistReason: row.addToBlacklist ? (row.blacklistReason ?? null) : null,
    blacklistNote: row.addToBlacklist ? (row.blacklistNote ?? null) : null,
    batchId,
    dutyTransferTiming: await dutyTransferTiming(tx, ctx.tenantId),
    preReleaseDate: effectiveDate,
  });
  // 步骤 5：直接落为 effective 并物化时间线；不走 activateExit，所以不触发 onEffective / 账号 / 合同 / 交接
  // lockEmploymentBusiness 与落地阶段的 expectedRevision 都指业务 revision（与 exit-activation 同口径）；
  // 业务刚由本事务创建，revision 读出即可，没有他人并发的空间（员工行锁已持有）。
  const [head] = rowsOf<{ revision: number }>(
    await tx.execute(sql`SELECT revision FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${leave.id}::uuid`),
  );
  const settleCtx = { ...importCtx, expectedRevision: Number(head!.revision) };
  const locked = await lockEmploymentBusiness(tx, settleCtx, leave.id);
  await appendEmploymentState(tx, settleCtx, locked, 'effective');
  await materializeEmploymentRecord(tx, settleCtx, locked, { forwardUpdate: false, skipStatusPropagation: true });
  if (row.addToBlacklist) await blacklistRow(tx, ctx, row, employee.id, leave.id, effectiveDate);
  await assertOnlyImportedBusinesses(tx, ctx, employee.id);
  await auditImported(tx, ctx, batchId, row, employee.id, leave.id, effectiveDate);
  if (item.warnings.length > 0 || item.hidden > 0)
    await auditEmployment(
      tx,
      ctx,
      'employment.exit.over_capacity_confirmed',
      'exit-request',
      leave.id,
      null,
      { source: 'import', batchId, rowNo: row.rowNo, warnings: item.warnings, hiddenCount: item.hidden },
      undefined,
      undefined,
      { employeeId: employee.id },
    );
  return { rowNo: row.rowNo, employeeId: employee.id, hireBusinessId: hire.id, exitBusinessId: leave.id };
}

const fieldsOf = (resolved: ResolvedRow) => ({
  departmentId: resolved.departmentId,
  ...(resolved.positionId ? { positionId: resolved.positionId } : {}),
  ...(resolved.postId ? { postId: resolved.postId } : {}),
});

/** 评估之后、写入之前别的事务抢先建了同工号：与预检同一原因码，整批回滚。 */
async function createImportedEmployee(tx: Tx, ctx: EmploymentContext, row: ImportRowInput) {
  try {
    return await createEmployee(tx, ctx, { code: row.employeeNo, name: row.name });
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONFLICT')
      throw new AppError('IMPORT_ROWS_INVALID', '导入数据有误，整批未保存', {
        rows: [
          {
            rowNo: row.rowNo,
            errors: [{ field: 'employeeNo', reason: 'EMPLOYEE_NO_EXISTS', message: '工号已存在' }],
          },
        ],
      });
    throw error;
  }
}

/** 手动勾选才加黑（§5）：日期 = 离职生效日、来源 manual、关联离职单；不跑自动规则。 */
async function blacklistRow(
  tx: Tx,
  ctx: EmploymentContext,
  row: ImportRowInput,
  employeeId: string,
  exitRequestId: string,
  effectiveDate: string,
) {
  await addBlacklistEntry(
    tx,
    { ...ctx, expectedRevision: 0 },
    {
      employeeId,
      reason: row.blacklistReason as (typeof BLACKLIST_REASON_CODES)[number],
      expiryDate: row.blacklistExpiryDate ?? null,
      note: row.blacklistNote ?? null,
    } as never,
    { source: 'manual', blacklistDate: effectiveDate, exitRequestId },
  );
}

/** 防御：新建的人员名下只应有入职与离职两条业务；多出来说明有别的流程介入，宁可整批回滚。 */
async function assertOnlyImportedBusinesses(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const [count] = rowsOf<{ n: string }>(
    await tx.execute(sql`SELECT count(*) AS n FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid`),
  );
  if (Number(count?.n) !== 2)
    throw new AppError('SERVICE_UNAVAILABLE', '导入结果自检未通过', { reason: 'INTERNAL_INVARIANT' });
}

async function auditImported(
  tx: Tx,
  ctx: EmploymentContext,
  batchId: string,
  row: ImportRowInput,
  employeeId: string,
  exitBusinessId: string,
  effectiveDate: string,
) {
  await auditEmployment(
    tx,
    ctx,
    'employment.exit.imported',
    'exit-request',
    exitBusinessId,
    null,
    { state: 'effective', mode: 'import', lastWorkDate: row.lastWorkDate, effectiveDate, batchId, rowNo: row.rowNo },
    undefined,
    undefined,
    { employeeId },
  );
}
