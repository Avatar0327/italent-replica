/**
 * F-493 历史离职人员导入：提交侧（设计 §3、§4.1、§6.1）。
 * 提交只做三件事：校验权限、把批次与逐行明细落库（形状错与同文件重复邮箱的行当场 failed）、提交后唤醒执行器。
 * 读库的判定与写入在执行器里（exit-import-worker.ts / exit-import-row.ts），请求内不跑。
 */
import { exitImportBatches, exitImportRows, afterTransactionCommit, type Db, type Tx } from '@italent/db';
import { duplicateEmailRows, EXIT_IMPORT_BUTTON, PERSONNEL_OBJECT, SUBSETS, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { personnelCreationScope } from '../permission/scope-resolver.js';
import type { ModuleScope } from '../permission/scope-types.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { authorize } from '../personnel/access.js';
import { auditEmployment, EMPLOYEE_OBJECT, requireEmploymentWrite } from './context.js';
import { educationPatch, profilePatch } from './exit-import-row.js';
import { shapeErrors, type ExitImportBody, type ImportRowInput, type RowError } from './exit-import-shape.js';
import type { EmploymentContext } from './types.js';

export { parseExitImportBody, type ExitImportBody, type ImportRowInput } from './exit-import-shape.js';

const ROW_GROUP = 200;

/**
 * 入口权限链（设计 §6.1）：任职功能权由 readContext 判过，这里补人员新增权、导入按钮、任职字段写权，
 * 并要求任职与人员对象都有显式“看全部”范围（DEC-121：新员工尚无任职鉴权字段）。
 * 档案更新权与教育新增权在事务内另判（requireExitImportProfileAccess）。
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
  // 人员对象的范围与任职记录分开配置，缺失按未配置处理（fail-closed，硬规则 1）。
  if (!employeeScope?.all) throw new AppError('FORBIDDEN', '批量导入历史离职人员需要人员对象的“全部数据”范围');
}

/**
 * 字段写权按本批实际写入的字段判（设计 §6.1）：部门、入职日期、最后工作日必有；可选列只要有一行填了就要有写权。
 * 导入列与权限字段编码不同的做了映射：职位 / 岗位 / 职级 → positionId / postId / levelId，离职原因 → reasonCode，
 * 离职去向 → whereaboutsCode；工作地点 → place。
 */
function writtenFields(rows: readonly ImportRowInput[]) {
  const given = (pick: (row: ImportRowInput) => string | null) => rows.some((row) => pick(row) !== null);
  const fields: Record<string, string> = { departmentId: 'x', lastWorkDate: 'x' };
  const optional: [string, (row: ImportRowInput) => string | null][] = [
    ['positionId', (row) => row.positionName],
    ['postId', (row) => row.postName],
    ['levelId', (row) => row.levelName],
    ['place', (row) => row.place],
    ['exitTypeCode', (row) => row.exitTypeName],
    ['reasonCode', (row) => row.exitReasonName],
    ['whereaboutsCode', (row) => row.whereaboutsName],
  ];
  for (const [code, pick] of optional) if (given(pick)) fields[code] = 'x';
  return { kind: 'hire', mode: 'direct', effectiveDate: '2000-01-01', fields };
}

/** 档案更新写权按本批非空列的并集判（电子邮件每行必有）；教育新增权按教育写入计划的实际字段并集判。 */
function profileWrites(rows: readonly ImportRowInput[]) {
  const fields: Record<string, string> = { email: 'x' };
  for (const row of rows) for (const key of Object.keys(profilePatch(row))) fields[key] = 'x';
  const education: Record<string, string> = {};
  for (const row of rows) for (const key of Object.keys(educationPatch(row) ?? {})) education[key] = 'x';
  return [
    { objectCode: PERSONNEL_OBJECT, operation: 'update' as const, payload: fields },
    ...(Object.keys(education).length
      ? [{ objectCode: SUBSETS.education.objectCode, operation: 'create' as const, payload: education }]
      : []),
  ];
}

/**
 * 档案与教育的写权（命令事务内，用事务内授权器）：与档案 PATCH / 教育 POST 同判，且范围必须显式“看全部”
 * （导入的新人员不在任何现有范围内，设计 §6.1）。任一缺失 403，零写入。
 */
export async function requireExitImportProfileAccess(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  rows: readonly ImportRowInput[],
): Promise<void> {
  if (!ctx.authorize) return;
  const authorizer = authorizeInTransaction(deps.authorize, tx);
  for (const { objectCode, operation, payload } of profileWrites(rows)) {
    let scope = await resolveModuleScopeInTransaction(deps, ctx, tx, objectCode);
    // DEC-082：创建人规则只授予旧记录读写权，教育新增仍须落在当前管理范围内
    if (operation === 'create')
      scope = await personnelCreationScope(
        tx,
        { ...ctx, appCode: 'TenantBase', asOf: tenantLocalDate(ctx.now, ctx.timezone) },
        scope,
      );
    const access = { ...ctx, authorizer, objectCode, scope };
    await authorize(authorizer, access, operation, payload, operation);
    if (!scope.all) throw new AppError('FORBIDDEN', '批量导入历史离职人员需要人员档案的“全部数据”范围');
  }
}

export interface ExitImportReceipt {
  readonly batchId: string;
  readonly status: 'queued';
  readonly total: number;
}

/** 提交时就能判的行错误：形状错优先；同文件重复邮箱（c 类）只给没有形状错的行（设计 §3.3）。 */
function submitErrors(rows: readonly ImportRowInput[]): Map<number, RowError[]> {
  const errors = new Map(rows.map((row) => [row.rowNo, shapeErrors(row)]));
  const mailable = rows.filter((row) => !errors.get(row.rowNo)!.some((e) => e.column === 'C'));
  for (const rowNo of duplicateEmailRows(mailable))
    if (errors.get(rowNo)!.length === 0) errors.set(rowNo, [{ column: 'C', reason: 'EMAIL_DUPLICATE_IN_FILE' }]);
  return errors;
}

/** 命令内：批次 + 明细 + 审计同事务写入，提交后（不等待）唤醒执行器；同键重放不经此函数，所以不会重复唤醒。 */
export async function submitExitImport(
  tx: Tx,
  ctx: EmploymentContext,
  body: ExitImportBody,
  wake: (db: Db) => void,
): Promise<{ status: 202; body: ExitImportReceipt }> {
  const [batch] = await tx
    .insert(exitImportBatches)
    .values({
      tenantId: ctx.tenantId,
      commandId: ctx.commandId,
      submittedBy: ctx.userId,
      fileName: body.fileName,
      total: body.rows.length,
    })
    .returning({ id: exitImportBatches.id });
  const batchId = batch!.id;
  const errors = submitErrors(body.rows);
  for (let at = 0; at < body.rows.length; at += ROW_GROUP)
    await tx.insert(exitImportRows).values(
      body.rows.slice(at, at + ROW_GROUP).map((row) => {
        const rowErrors = errors.get(row.rowNo)!;
        return {
          ...row,
          tenantId: ctx.tenantId,
          batchId,
          status: rowErrors.length ? 'failed' : 'pending',
          errors: rowErrors,
        };
      }),
    );
  const prefailed = [...errors.values()].filter((list) => list.length > 0).length;
  await auditEmployment(tx, ctx, 'employment.exit_import.submitted', 'exit-import', batchId, null, {
    total: body.rows.length,
    prefailed,
  });
  afterTransactionCommit(tx, `exit-import:${ctx.tenantId}:${batchId}`, async (db) => wake(db));
  return { status: 202, body: { batchId, status: 'queued', total: body.rows.length } };
}
