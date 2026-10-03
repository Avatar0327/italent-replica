import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_FIELDS, PERSONNEL_OBJECT } from '@italent/domain';
import { AppError } from '../../errors.js';
import { audit, assertRevision, camel, insert, lockPerson, rows, type PersonnelContext, type Row } from './store.js';
import { validateDates } from './validation.js';
import { validateAttachments } from './attachments.js';

export async function employeeSnapshot(tx: Tx, ctx: PersonnelContext, employeeId: string) {
  const [previous] = rows(
    await tx.execute(sql`SELECT * FROM personnel_employee_versions
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid ORDER BY revision DESC LIMIT 1`),
  );
  return previous ? camel(previous) : null;
}
/** All call sites lock the unique employee entity first, including subset reflection and employment hooks. */
export async function appendEmployee(
  tx: Tx,
  ctx: PersonnelContext,
  employeeId: string,
  patch: Row,
  checkRevision = true,
) {
  const person = await lockPerson(tx, ctx, employeeId);
  await validateAttachments(tx, ctx, employeeId, patch);
  const previous = await employeeSnapshot(tx, ctx, employeeId);
  if (checkRevision) assertRevision(ctx.expectedRevision, Number(previous?.revision ?? 0));
  const before = Object.fromEntries(
    EMPLOYEE_FIELDS.map((f) => [f.code, previous?.[f.code] ?? (f.code === 'name' ? person.name : null)]),
  );
  const after = { ...before, ...patch };
  after.displayName = after.engName ? `${after.name}（${after.engName}）` : after.name;
  validateDates(after);
  if (after.confirmRehireUserId) {
    const [person] = rows(
      await tx.execute(sql`SELECT user_id FROM permission_user_person_links
      WHERE tenant_id=${ctx.tenantId} AND user_id=${after.confirmRehireUserId}::uuid LIMIT 1`),
    );
    if (!person) throw new AppError('VALIDATION_FAILED', '重聘关联用户不属于本租户');
  }
  const revision = Number(previous?.revision ?? 0) + 1;
  await insert(tx, 'personnel_employee_versions', {
    ...after,
    id: randomUUID(),
    employeeId,
    tenantId: ctx.tenantId,
    revision,
    previousVersionId: previous?.id ?? null,
    commandId: ctx.commandId,
    createdBy: ctx.userId,
    createdAt: ctx.now.toISOString(),
  });
  await audit(tx, ctx, PERSONNEL_OBJECT, employeeId, employeeId, revision, before, after);
  return revision;
}
