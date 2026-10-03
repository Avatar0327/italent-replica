import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { PersonnelContext, Row } from './store.js';
import { insert, rows } from './store.js';

const ATTACHMENT_FIELDS = new Set([
  'idPhoto',
  'idFront',
  'idBack',
  'attachmentId',
  'educationCertificate',
  'degreeCertificate',
]);

export async function validateAttachments(
  tx: Tx,
  ctx: PersonnelContext,
  employeeId: string,
  values: Row,
): Promise<void> {
  const ids = Object.entries(values)
    .filter(([field, value]) => ATTACHMENT_FIELDS.has(field) && typeof value === 'string')
    .map(([, value]) => value as string);
  if (!ids.length) return;
  const found = rows(
    await tx.execute(sql`SELECT id FROM personnel_attachments WHERE tenant_id=${ctx.tenantId}
      AND employee_id=${employeeId}::uuid AND status IN ('registered','uploaded')
      AND id=ANY(${`{${ids.join(',')}}`}::uuid[])`),
  );
  if (new Set(found.map((row) => String(row.id))).size !== new Set(ids).size)
    throw new AppError('VALIDATION_FAILED', '附件未登记或不属于当前租户与员工');
}

export async function registerAttachment(
  tx: Tx,
  ctx: PersonnelContext,
  employeeId: string,
  input: { purpose: string; filename: string; contentType: string; byteSize: number; sha256: string },
) {
  const row = {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    employeeId,
    ...input,
    status: 'registered',
    createdBy: ctx.userId,
    createdAt: ctx.now.toISOString(),
  };
  await insert(tx, 'personnel_attachments', row);
  return row;
}
