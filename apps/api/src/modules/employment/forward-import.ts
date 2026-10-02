import { sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { assertRevision } from './context.js';
import { AppError } from '../../errors.js';
import { normalizeBusinessPatch, normalizeEmploymentInput } from './fields.js';
import { editEmploymentRecord } from './record-edit.js';
import { lockEmploymentEmployee, rowsOf } from './record-store.js';
import { createEmploymentBusiness } from './write-service.js';
import type { EmploymentContext } from './types.js';

const schema = z.strictObject({
  items: z
    .array(
      z.discriminatedUnion('operation', [
        z.strictObject({ operation: z.literal('create'), business: z.unknown() }),
        z.strictObject({
          operation: z.literal('edit'),
          id: z.uuid(),
          revision: z.number().int().positive(),
          patch: z.unknown(),
        }),
      ]),
    )
    .min(1)
    .max(100),
  updateLaterEmployment: z.enum(['是', '否', '']).nullable().optional(),
});

export function normalizeEmploymentImport(input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '任职导入批次不合法', parsed.error.issues);
  const edited = parsed.data.items.filter((item) => item.operation === 'edit').map((item) => item.id);
  if (new Set(edited).size !== edited.length) throw new AppError('VALIDATION_FAILED', '批次不能重复编辑同一任职记录');
  return parsed.data;
}

/** 07 A6/A7：结构化导入核心端口；模板/人员导入界面接入时复用，批次整体提交。 */
export async function importEmploymentRecords(tx: Tx, ctx: EmploymentContext, employeeId: string, raw: unknown) {
  const input = normalizeEmploymentImport(raw);
  await lockEmploymentEmployee(tx, ctx, employeeId, ctx.expectedRevision);
  await validateImportRevisions(tx, ctx, employeeId, input);
  const options = { forwardUpdate: input.updateLaterEmployment !== '否' };
  const results = [];
  for (const item of input.items) {
    if (item.operation === 'create') {
      const business = normalizeEmploymentInput(ctx, item.business);
      if (business.mode !== 'direct' || !['transfer', 'regularization', 'org_adjustment'].includes(business.kind)) {
        throw new AppError('VALIDATION_FAILED', '任职新增导入仅支持直接调动、转正、组织调整');
      }
      const employee = await lockEmploymentEmployee(tx, ctx, employeeId);
      results.push(
        await createEmploymentBusiness(
          tx,
          { ...ctx, expectedRevision: employee.revision },
          employeeId,
          business,
          options,
        ),
      );
    } else {
      // 已在员工锁下校验整批原 revision；这里仅承接本事务前项产生的版本变化。
      const revision = await importRecordRevision(tx, ctx, employeeId, item.id);
      results.push(
        await editEmploymentRecord(
          tx,
          { ...ctx, expectedRevision: revision },
          item.id,
          normalizeBusinessPatch(item.patch),
          'import',
          options,
        ),
      );
    }
  }
  const employee = await lockEmploymentEmployee(tx, ctx, employeeId);
  return { items: results, revision: employee.revision };
}

async function importRecordRevision(tx: Tx, ctx: EmploymentContext, employeeId: string, id: string) {
  const [owner] = rowsOf<{ revision: number }>(
    await tx.execute(sql`
    SELECT revision FROM employment_business_objects WHERE tenant_id=${ctx.tenantId}
      AND employee_id=${employeeId}::uuid AND id=${id}::uuid LIMIT 1
  `),
  );
  if (!owner) throw new AppError('NOT_FOUND', '导入编辑目标不属于此员工');
  return owner.revision;
}

async function validateImportRevisions(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: ReturnType<typeof normalizeEmploymentImport>,
) {
  for (const item of input.items) {
    if (item.operation === 'edit') {
      assertRevision(item.revision, await importRecordRevision(tx, ctx, employeeId, item.id));
    }
  }
}
