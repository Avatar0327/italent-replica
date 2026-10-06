import { lockTransferParticipants } from '../employment/transfer-locks.js';
import { sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { employmentApprovalHooks } from '../employment/approval-hooks.js';
import { auditEmployment, requireEmploymentWrite } from '../employment/context.js';
import { readEmploymentSettings } from '../employment/configuration.js';
import { normalizeEmploymentInput } from '../employment/fields.js';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import { loadEmploymentBusiness } from '../employment/read-model.js';
import { transitionEmployment } from '../employment/transitions.js';
import { prepareInheritance } from '../employment/inheritance.js';
import { createEmploymentBusiness, requireSavedBusiness } from '../employment/write-service.js';
import type { EmploymentContext, NormalizedEmploymentInput } from '../employment/types.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { requireTransferSource, transferDirectActions, type TransferInitiator } from './access.js';
import { readTransferCatalog, readTransferSettings, resolveTransferForm } from './configuration.js';
import { dutySubordinateIds, normalizeLinkage, type LinkageOptions } from './linkage/input.js';
import { saveNewTransferLinkage } from './linkage/service.js';
import type { LinkageAccess } from './linkage/access.js';
import { hasLinkage } from './linkage/store.js';

const schema = z.strictObject({
  initiator: z.enum(['hr', 'manager', 'employee']),
  transferTypeCode: z.string().trim().min(1).max(100),
  reasonCode: z.string().trim().min(1).max(100).optional(),
  formId: z.string().trim().min(1).max(100).optional(),
  effectiveDate: z.string(),
  mode: z.enum(['direct', 'application']),
  fields: z.record(z.string(), z.unknown()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  submit: z.boolean().default(false),
  withEstablishment: z.boolean().optional(),
  // R1-T10：是否变更合同、调整薪资、试岗、交接、调整兼职、转交职责（input.ts 细校验）。
  linkage: z.unknown().optional(),
});
export interface TransferInput {
  readonly initiator: TransferInitiator;
  readonly transferTypeCode: string;
  readonly reasonCode?: string;
  readonly submit: boolean;
  readonly writable: Readonly<Record<string, unknown>>;
  readonly employment: NormalizedEmploymentInput;
  readonly linkage: LinkageOptions | null;
  /** 路由按当前权限解析的联动目标范围（linkage/access.ts）；内部调用方不传即为可信端口。 */
  readonly linkageAccess?: LinkageAccess;
}

export async function normalizeTransferInput(tx: Tx, ctx: EmploymentContext, raw: unknown): Promise<TransferInput> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '调动表单字段不合法', parsed.error.issues);
  const input = parsed.data;
  const linkage = input.linkage === undefined || input.linkage === null ? null : normalizeLinkage(input.linkage);
  // 12 附录：本人调动表单没有薪资、合同、试岗等区块，人事申请入口不能带联动。
  if (input.initiator === 'employee' && hasLinkage(linkage))
    throw new AppError('VALIDATION_FAILED', '本人调动申请不能设置联动业务', { reason: 'TRANSFER_LINKAGE_NOT_ALLOWED' });
  // TODO(需取证 Q-M0-18)：带编转移数量与分配规则未确认，明确拒绝。
  if (input.withEstablishment)
    throw new AppError('SERVICE_UNAVAILABLE', '带编调动分配规则尚待取证', { reason: 'WITH_ESTABLISHMENT_UNAVAILABLE' });
  if (input.formId === 'standard') throw new AppError('VALIDATION_FAILED', '调动接口必须选择真实表单');
  const catalog = await readTransferCatalog(tx, ctx.tenantId, input.effectiveDate);
  const type = catalog.types.find((item) => item.code === input.transferTypeCode);
  if (!type) throw new AppError('VALIDATION_FAILED', '调动类型在生效日不可用');
  if (
    input.reasonCode &&
    !catalog.reasons.some(
      (item) =>
        item.code === input.reasonCode && (!item.transferTypeCode || item.transferTypeCode === input.transferTypeCode),
    )
  )
    throw new AppError('VALIDATION_FAILED', '调动原因不适用于所选类型');
  const employment = normalizeEmploymentInput(ctx, {
    kind: 'transfer',
    mode: input.mode,
    effectiveDate: input.effectiveDate,
    formId:
      input.formId ??
      (input.initiator === 'employee' ? type.formId.replace('TenantBase.', 'TenantBase.Personal') : type.formId),
    fields: input.fields,
    customFields: input.customFields,
  });
  // 08 §10 / AC-TRF-23：人事申请入口只能使用 Personal 表单，不能借用 HR 按钮。
  if (
    employment.formId.startsWith('TenantBase.Personal') !== (input.initiator === 'employee') ||
    (input.initiator === 'employee' && input.mode !== 'application')
  )
    throw new AppError('VALIDATION_FAILED', '表单与调动入口不匹配', { reason: 'TRANSFER_FORM_ENTRY_MISMATCH' });
  await resolveTransferForm(tx, ctx.tenantId, employment.formId);
  // 联动选项不是任职对象字段，不进字段权限校验；合同部分按合同模块权限另行校验（linkage/routes.ts）。
  const writable = Object.fromEntries(Object.entries(input).filter(([key]) => !['submit', 'linkage'].includes(key)));
  return {
    writable,
    initiator: input.initiator,
    transferTypeCode: input.transferTypeCode,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    submit: input.submit,
    employment,
    linkage,
  };
}

export async function requireTransferWrite(ctx: EmploymentContext, input: TransferInput): Promise<void> {
  await requireEmploymentWrite(ctx, 'create', input.writable);
}

export async function transferTargetContext(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: TransferInput,
  departmentId: string | null,
): Promise<EmploymentContext> {
  await requireTransferSource(tx, ctx, employeeId, input.initiator);
  const form = await resolveTransferForm(tx, ctx.tenantId, input.employment.formId);
  const settings = await readTransferSettings(tx, ctx.tenantId);
  return form.isStandard && settings.unrestrictTargetDepartment
    ? { ...ctx, transferTarget: { employeeId, departmentId } }
    : ctx;
}

export async function createTransfer(tx: Tx, ctx: EmploymentContext, employeeId: string, input: TransferInput) {
  // F-008：先取员工锁，再重验关系/范围；业务写入沿用员工 → 业务 → 审批实例的顺序。
  const { linkage, linkageAccess } = input;
  await lockTransferParticipants(tx, ctx, employeeId, [
    ...(input.employment.fields.addedSubordinateIds ?? []),
    ...dutySubordinateIds(linkage),
  ]);
  await lockEmploymentEmployee(tx, ctx, employeeId, ctx.expectedRevision);
  input = { ...(await normalizeTransferInput(tx, ctx, { ...input.writable, submit: input.submit })), linkage };
  const prepared = await prepareInheritance(tx, ctx, { ...input.employment, employeeId });
  const sourceContext = { ...ctx, transferTarget: undefined };
  ctx = await transferTargetContext(tx, sourceContext, employeeId, input, prepared.fields.departmentId);
  await requireTransferWrite(ctx, input);
  if (input.employment.mode === 'direct') await requireDirectTransfer(tx, ctx);
  const form = await resolveTransferForm(tx, ctx.tenantId, input.employment.formId);
  const created = await createEmploymentBusiness(tx, ctx, employeeId, input.employment);
  const metadata = {
    initiator: input.initiator,
    transferTypeCode: input.transferTypeCode,
    reasonCode: input.reasonCode ?? null,
    processCode: form.processCode,
  };
  await tx.execute(sql`
    INSERT INTO transfer_requests(
      tenant_id,business_id,employee_id,initiator,transfer_type_code,reason_code,process_code)
    VALUES (${ctx.tenantId},${created.id}::uuid,${employeeId}::uuid,${metadata.initiator},
      ${metadata.transferTypeCode},${metadata.reasonCode},${metadata.processCode})
  `);
  await auditEmployment(tx, ctx, 'transfer.request.create', 'transfer-request', created.id, null, metadata);
  await saveNewTransferLinkage(
    tx,
    ctx,
    { businessId: created.id, employeeId, effectiveDate: created.effectiveDate, mode: input.employment.mode },
    linkage,
    linkageAccess,
  );
  if (input.employment.mode === 'application' && input.submit) {
    const context = { ...ctx, expectedRevision: created.revision };
    await transitionEmployment(tx, context, { id: created.id, action: 'submit' });
    await employmentApprovalHooks.submitted(tx, context, created.id);
    return { ...(await requireSavedBusiness(tx, context, created.id)), ...metadata };
  }
  return { ...created, ...metadata };
}

export async function requireDirectTransfer(tx: Tx, ctx: EmploymentContext) {
  ctx = { ...ctx, authorize: ctx.authorize ? authorizeInTransaction(ctx.authorize, tx) : undefined };
  const settings = await readEmploymentSettings(tx, ctx.tenantId);
  if (!settings.allowDirectTransfer)
    throw new AppError('CONFLICT', '本租户调动须走审批', { reason: 'DIRECT_TRANSFER_DISABLED' });
  const actions = await transferDirectActions(ctx, true);
  if (!actions.directList && !actions.directRow) throw new AppError('FORBIDDEN', '无权发起直接调动');
}

/** 同单操作按当前调用人的权限判断；原发起人类型仅是业务事实，不决定后续操作者的身份。 */
export async function transferBusinessContext(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  write = false,
  targetDepartmentId?: string | null,
) {
  const [request] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`
    SELECT employee_id AS "employeeId" FROM transfer_requests
    WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid
  `),
  );
  if (!request) return ctx;
  // F-008：等员工锁完成后才重验源范围，避免锁等待期间调出员工后沿用此前目标例外。
  if (write) {
    await lockTransferParticipants(tx, ctx, request.employeeId);
    await lockEmploymentEmployee(tx, ctx, request.employeeId);
  }
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  // 是否需要目标部门例外按写入口径判断；DEC-177 放宽的只是“看”（F-015），不能因可见就跳过 Switch 31 例外。
  const writable = await loadEmploymentBusiness(tx, ctx.tenantId, businessId, today, ctx.scope, 'write');
  if (writable && (targetDepartmentId === undefined || targetDepartmentId === writable.fields.departmentId)) return ctx;
  const business = await loadEmploymentBusiness(tx, ctx.tenantId, businessId, today);
  if (!business) throw new AppError('NOT_FOUND', '任职业务不存在');
  const form = await resolveTransferForm(tx, ctx.tenantId, business.formId);
  const settings = await readTransferSettings(tx, ctx.tenantId);
  if (!form.isStandard || !settings.unrestrictTargetDepartment) return ctx;
  for (const initiator of ['hr', 'employee', 'manager'] as const) {
    try {
      await requireTransferSource(tx, ctx, request.employeeId, initiator);
      return {
        ...ctx,
        transferTarget: {
          employeeId: request.employeeId,
          departmentId: targetDepartmentId === undefined ? business.fields.departmentId : targetDepartmentId,
          businessId,
        },
      };
    } catch (error) {
      if (!(error instanceof AppError) || !['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) throw error;
    }
  }
  if (writable || (await loadEmploymentBusiness(tx, ctx.tenantId, businessId, today, ctx.scope))) return ctx;
  throw new AppError('NOT_FOUND', '任职业务不存在');
}
