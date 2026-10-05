import { pgErrorCode, and, eq, contractRecords, sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { checkScope, lockEmployee, revision, rowsOf, type ContractContext } from './context.js';
import { settings } from './configuration.js';
import { fieldsSchema, parse, uuid, type ContractCommand } from './input.js';
import { createCommand, deleteContract, portfolioRevision } from './service.js';
export const importSchema = z.strictObject({
  mode: z.enum(['add', 'edit', 'change', 'initialize']),
  rows: z
    .array(
      z.strictObject({
        employeeId: uuid,
        fields: fieldsSchema,
        originalEffectiveDate: z.iso.date().optional(),
        revision: z.int().min(1).optional(),
      }),
    )
    .min(1)
    .max(10000),
  revisions: z.record(uuid, z.int().min(0)).default({}),
});
type Input = z.infer<typeof importSchema>;
class PreviewRollback extends Error {}
export interface ImportError {
  row: number;
  code: string;
  message: string;
  details?: unknown;
}

async function initializePeople(tx: Tx, ctx: ContractContext, input: Input, ids: string[]) {
  if (input.mode !== 'initialize') return;
  const deleting: (typeof contractRecords.$inferSelect)[] = [];
  for (const employeeId of ids) {
    if (!Object.hasOwn(input.revisions, employeeId))
      throw new AppError('VALIDATION_FAILED', '初始化须携带每个人的合同集合版本');
    revision(input.revisions[employeeId]!, await portfolioRevision(tx, ctx.tenantId, employeeId));
    const records = await tx
      .select()
      .from(contractRecords)
      .where(
        and(
          eq(contractRecords.tenantId, ctx.tenantId),
          eq(contractRecords.employeeId, employeeId),
          eq(contractRecords.deleted, false),
        ),
      );
    for (const record of records) await checkScope(tx, ctx, record.employeeId, record.createdBy);
    // 未完成申请不能在初始化后悄然重新生成已删除合同。
    const pending = rowsOf(
      await tx.execute(sql`SELECT id FROM contract_requests WHERE tenant_id=${ctx.tenantId}
      AND employee_id=${employeeId}::uuid AND status IN ('in_review','approved','returned') LIMIT 1`),
    );
    if (pending.length) throw new AppError('CONFLICT', '存在未完成合同申请，不能初始化');
    deleting.push(...records);
  }
  // 所有人员的整个替换集合先验权，再统一删除；后续行失败仍由外层事务整体回滚。
  for (const record of deleting) await deleteContract(tx, ctx, record);
}
/** 编辑/变更必须先定位原合同；不能用人员新建范围替代合同维护范围。 */
async function importTarget(
  tx: Tx,
  ctx: ContractContext,
  input: Input,
  row: Input['rows'][number],
  config: Awaited<ReturnType<typeof settings>>,
) {
  if (input.mode !== 'edit' && input.mode !== 'change') return undefined;
  const candidates = await tx
    .select()
    .from(contractRecords)
    .where(
      and(
        eq(contractRecords.tenantId, ctx.tenantId),
        eq(contractRecords.employeeId, row.employeeId),
        eq(contractRecords.deleted, false),
        sql`status<>'void'`,
      ),
    );
  const keys = input.mode === 'change' ? ['typeId', 'effectiveDate'] : config.uniqueFields;
  const matches = candidates.filter((c) =>
    keys.every((k) => {
      const value =
        k === 'employeeId'
          ? row.employeeId
          : k === 'effectiveDate' && input.mode === 'change'
            ? row.originalEffectiveDate
            : row.fields[k as keyof typeof row.fields];
      return value !== undefined && c[k as keyof typeof c] === value;
    }),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
export async function checkImportScope(tx: Tx, ctx: ContractContext, input: Input) {
  const config = await settings(tx, ctx.tenantId);
  for (const row of input.rows) {
    const target = await importTarget(tx, ctx, input, row, config);
    if (!target && ['edit', 'change'].includes(input.mode)) {
      // 未匹配的行只能按当前人员范围检查；有权时仍由预览/CSV 返回行级错误。
      await checkScope(tx, ctx, row.employeeId);
    } else await checkScope(tx, ctx, row.employeeId, target?.createdBy);
  }
}

async function applyRows(tx: Tx, ctx: ContractContext, input: Input, errors: ImportError[]) {
  const ids = [...new Set(input.rows.map((r) => r.employeeId))].sort();
  for (const id of ids) {
    await lockEmployee(tx, ctx, id);
  }
  await checkImportScope(tx, ctx, input);
  await initializePeople(tx, ctx, input, ids);
  const config = await settings(tx, ctx.tenantId);
  const results = [];
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]!;
    try {
      results.push(
        await tx.transaction(async (sub) => {
          const target = await importTarget(sub, ctx, input, row, config);
          if (!target && ['edit', 'change'].includes(input.mode))
            throw new AppError('VALIDATION_FAILED', '唯一键未匹配到唯一原合同');
          if (target && row.revision === undefined)
            throw new AppError('VALIDATION_FAILED', '编辑与变更导入须携带原合同 revision');
          const command: ContractCommand = {
            operation: target ? 'change' : 'create',
            mode: 'direct',
            employeeId: row.employeeId,
            fields: row.fields,
            ...(target ? { targetId: target.id } : {}),
          };
          return createCommand(
            sub,
            { ...ctx, expectedRevision: target ? row.revision! : 0 },
            command,
            false,
            input.mode === 'edit',
          );
        }),
      );
    } catch (error) {
      if (pgErrorCode(error) === '23505') {
        errors.push({ row: i + 1, code: 'CONFLICT', message: '合同唯一键重复' });
      } else {
        if (!(error instanceof AppError)) throw error;
        errors.push({ row: i + 1, code: error.code, message: error.message, details: error.details });
      }
    }
  }
  return results;
}
export async function previewImport(tx: Tx, ctx: ContractContext, raw: unknown, enforcePreviewLimit = true) {
  const input = parse(importSchema, raw);
  if (enforcePreviewLimit && input.rows.length > 3000)
    throw new AppError('VALIDATION_FAILED', '超过 3000 条请直接导入');
  const errors: ImportError[] = [];
  try {
    await tx.transaction(async (sub) => {
      await applyRows(sub, ctx, input, errors);
      throw new PreviewRollback();
    });
  } catch (error) {
    if (!(error instanceof PreviewRollback)) throw error;
  }
  return { valid: !errors.length, count: input.rows.length, errors };
}
export async function importContracts(tx: Tx, ctx: ContractContext, raw: unknown) {
  const input = parse(importSchema, raw);
  // 整批先演练并回滚，所有行通过后再写；外层命令事务保证失败时整批回滚。
  const preview = await previewImport(tx, ctx, input, false);
  if (!preview.valid) throw importFailure('导入校验失败', preview);
  const errors: ImportError[] = [];
  const items = await applyRows(tx, ctx, input, errors);
  if (errors.length) throw importFailure('导入失败', { errors });
  return { items, count: items.length };
}
function importFailure(message: string, result: { errors: ImportError[] }) {
  const conflict = result.errors.some((e) => ['CONFLICT', 'REVISION_CONFLICT'].includes(e.code));
  return new AppError(conflict ? 'CONFLICT' : 'VALIDATION_FAILED', message, result);
}
export function errorsCsv(errors: readonly ImportError[]) {
  return (
    '\uFEFF行号,错误码,原因\r\n' +
    errors
      .map((e) => [String(e.row), e.code, e.message].map((v) => `"${v.replaceAll('"', '""')}"`).join(','))
      .join('\r\n')
  );
}
