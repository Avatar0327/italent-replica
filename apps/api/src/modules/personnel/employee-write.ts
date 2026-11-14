import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_FIELDS, PERSONNEL_OBJECT } from '@italent/domain';
import { AppError } from '../../errors.js';
import { audit, assertRevision, camel, insert, lockPerson, rows, type PersonnelContext, type Row } from './store.js';
import { requireEnabledIdentityTypes } from './identity-types.js';
import { normalizeDailyWageStandard, normalizeRetirementRange, validateDates } from './validation.js';
import { validateAttachments } from './attachments.js';
import { mergeCustomFields, type PersonnelCustomFields } from './custom-fields.js';

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
  input: Row,
  checkRevision = true,
) {
  // customFields 只在人员 PATCH 里带；其他调用方（子集同步、任职钩子）不带，整版沿用上一版（F-474-6c）。
  const { customFields: customPatch = {}, ...patch } = input as Row & { customFields?: PersonnelCustomFields };
  const person = await lockPerson(tx, ctx, employeeId);
  await validateAttachments(tx, ctx, employeeId, patch);
  const previous = await employeeSnapshot(tx, ctx, employeeId);
  if (checkRevision) assertRevision(ctx.expectedRevision, Number(previous?.revision ?? 0));
  const before = Object.fromEntries(
    EMPLOYEE_FIELDS.map((f) => [f.code, previous?.[f.code] ?? (f.code === 'name' ? person.name : null)]),
  );
  const after = { ...before, ...patch };
  // 所有可信写入与 HTTP 写入共用金额边界，审计中的新值与数据库中的规范值一致。
  if (Object.hasOwn(patch, 'dailyWageStandard'))
    after.dailyWageStandard = normalizeDailyWageStandard(patch.dailyWageStandard);
  after.displayName = after.engName ? `${after.name}（${after.engName}）` : after.name;
  validateDates(after);
  normalizeRetirementRange(after, patch);
  // A-9：个人身份只能取字典启用编码（只在本次写入带了新值时校验，已停用的旧值不挡其他字段的编辑）
  if (typeof patch.identityType === 'string') await requireEnabledIdentityTypes(tx, ctx.tenantId, [patch.identityType]);
  if (after.confirmRehireUserId) {
    const [person] = rows(
      await tx.execute(sql`SELECT user_id FROM permission_user_person_links
      WHERE tenant_id=${ctx.tenantId} AND user_id=${after.confirmRehireUserId}::uuid LIMIT 1`),
    );
    if (!person) throw new AppError('VALIDATION_FAILED', '重聘关联用户不属于本租户');
  }
  const custom = await mergeCustomFields(
    tx,
    ctx.tenantId,
    (previous?.customFields ?? {}) as PersonnelCustomFields,
    customPatch,
  );
  const revision = Number(previous?.revision ?? 0) + 1;
  await insert(tx, 'personnel_employee_versions', {
    ...after,
    customFields: JSON.stringify(custom.merged),
    id: randomUUID(),
    employeeId,
    tenantId: ctx.tenantId,
    revision,
    previousVersionId: previous?.id ?? null,
    commandId: ctx.commandId,
    createdBy: ctx.userId,
    createdAt: ctx.now.toISOString(),
  });
  // 审计只记变化的自定义字段 ID，前值取上一版；字段权限裁剪由审计读取端按 customFields.<id> 完成。
  const changed = Object.keys(custom.after).length > 0;
  await audit(
    tx,
    ctx,
    PERSONNEL_OBJECT,
    employeeId,
    employeeId,
    revision,
    changed ? { ...before, customFields: custom.before } : before,
    changed ? { ...after, customFields: custom.after } : after,
  );
  return revision;
}
