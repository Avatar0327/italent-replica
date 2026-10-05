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
  if (input.mode === 'initialize') {
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
      for (const record of records) await deleteContract(tx, ctx, record);
      // 未完成申请不能在初始化后悄然重新生成已删除合同。
      const pending = await tx.execute(sql`SELECT id FROM contract_requests WHERE tenant_id=${ctx.tenantId}
        AND employee_id=${employeeId}::uuid AND status IN ('in_review','approved','returned') LIMIT 1`);
      const rows = rowsOf(pending);
      if (rows.length) throw new AppError('CONFLICT', '存在未完成合同申请，不能初始化');
    }
  }
}
async function applyRows(tx: Tx, ctx: ContractContext, input: Input, errors: ImportError[]) {
  const ids = [...new Set(input.rows.map((r) => r.employeeId))].sort();
  for (const id of ids) {
    await lockEmployee(tx, ctx, id);
    await checkScope(tx, ctx, id);
  }
  await initializePeople(tx, ctx, input, ids);
  const config = await settings(tx, ctx.tenantId);
  const results = [];
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]!;
    try {
      results.push(
        await tx.transaction(async (sub) => {
          let target: typeof contractRecords.$inferSelect | undefined;
          if (input.mode === 'edit' || input.mode === 'change') {
            const candidates = await sub
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
            if (matches.length !== 1) throw new AppError('VALIDATION_FAILED', '唯一键未匹配到唯一原合同');
            target = matches[0]!;
            if (row.revision === undefined)
              throw new AppError('VALIDATION_FAILED', '编辑与变更导入须携带原合同 revision');
          }
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
