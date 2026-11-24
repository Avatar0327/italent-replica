import { requireManagerBusinessReferences } from './manager-business-references.js';
import { requireManagerReferenceValues } from './manager-references.js';
import {
  existingTransferEmployees,
  lockTransferHeads,
  lockTransferParticipants,
  sealTransferLocks,
  transferLocksCover,
} from '../employment/transfer-locks.js';
import { sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { employmentApprovalHooks } from '../employment/approval-hooks.js';
import { withEstablishmentConfirmation } from '../employment/activation-checks.js';
import { auditEmployment, requireEmploymentWrite } from '../employment/context.js';
import { readEmploymentSettings } from '../employment/configuration.js';
import { normalizeEmploymentInput } from '../employment/fields.js';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import { loadEmploymentBusiness } from '../employment/read-model.js';
import { transitionEmployment } from '../employment/transitions.js';
import { prepareInheritance } from '../employment/inheritance.js';
import { createEmploymentBusiness, requireSavedBusiness } from '../employment/write-service.js';
import type { EmploymentBusinessPatch, EmploymentContext, NormalizedEmploymentInput } from '../employment/types.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import {
  requireTransferSource,
  requireManagerBusinessSource,
  transferDirectActions,
  type TransferInitiator,
} from './access.js';
import { readTransferCatalog, readTransferSettings, resolveTransferForm } from './configuration.js';
import { requireEmployeeTransferFields } from './employee-policy.js';
import { dutySubordinateIds, normalizeLinkage, type LinkageOptions } from './linkage/input.js';
import { saveNewTransferLinkage } from './linkage/service.js';
import type { LinkageAccess } from './linkage/access.js';
import { hasLinkage } from './linkage/store.js';
import { holdTransferDraft, occupiesDraftSlot, releaseTransferDraft } from './draft-slot.js';

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
  // F-026：非严格控编超编的确认标记（控制键，不是任职字段；不进字段权限校验）。
  confirmed: z.boolean().optional(),
  // R1-T10：是否变更合同、调整薪资、试岗、交接、调整兼职、转交职责（input.ts 细校验）。
  linkage: z.unknown().optional(),
});
export interface TransferInput {
  readonly initiator: TransferInitiator;
  readonly transferTypeCode: string;
  readonly reasonCode?: string;
  readonly submit: boolean;
  /** F-026：客户端已确认非严格控编超编提示；缺省 false。 */
  readonly confirmed: boolean;
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
  if (input.initiator !== 'hr' && linkage?.esign)
    throw new AppError('VALIDATION_FAILED', '此入口不能设置电子签署', { reason: 'TRANSFER_LINKAGE_NOT_ALLOWED' });
  if (input.initiator === 'employee' && hasLinkage(linkage))
    throw new AppError('VALIDATION_FAILED', '本人调动申请不能设置联动业务', { reason: 'TRANSFER_LINKAGE_NOT_ALLOWED' });
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
  // DEC-205：本人入口复用 HR 表单；旧 Personal 标识保持兼容，但不能用于他人入口或直接调动。
  if (
    (employment.formId.startsWith('TenantBase.Personal') && input.initiator !== 'employee') ||
    (input.initiator !== 'hr' && input.mode !== 'application')
  )
    throw new AppError('VALIDATION_FAILED', '表单与调动入口不匹配', { reason: 'TRANSFER_FORM_ENTRY_MISMATCH' });
  await resolveTransferForm(tx, ctx.tenantId, employment.formId);
  if (input.initiator === 'employee')
    await requireEmployeeTransferFields(
      tx,
      ctx,
      employment.effectiveDate,
      employment.fields,
      ctx.selfServiceEmployeeId,
    );
  const writable = Object.fromEntries(
    Object.entries(input).filter(([key]) => !['submit', 'linkage', 'confirmed'].includes(key)),
  );
  return {
    writable,
    initiator: input.initiator,
    transferTypeCode: input.transferTypeCode,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    submit: input.submit,
    confirmed: input.confirmed === true,
    employment,
    linkage,
  };
}

export async function requireTransferWrite(ctx: EmploymentContext, input: TransferInput): Promise<void> {
  await requireEmploymentWrite(ctx, 'create', input.writable);
}

/**
 * 预览只判请求里真正编辑的业务字段（生效日、原因、任职字段、自定义字段）。initiator / transferTypeCode / formId / mode
 * 是路由参数，由服务端固定或另行校验（表单与入口匹配、按钮），不是员工编辑的字段，不能拿它们判字段写权（第 3 轮 P2-3）。
 */
export async function requireTransferEditedWrite(ctx: EmploymentContext, input: TransferInput): Promise<void> {
  const { initiator: _initiator, transferTypeCode: _type, formId: _form, mode: _mode, ...edited } = input.writable;
  await requireEmploymentWrite(ctx, 'create', edited);
}

export async function transferTargetContext(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: TransferInput,
  departmentId: string | null,
): Promise<EmploymentContext> {
  await requireTransferSource(tx, ctx, employeeId, input.initiator);
  if (input.initiator === 'manager')
    await requireManagerReferenceValues(tx, ctx, input.employment.effectiveDate, input.employment.fields);
  const form = await resolveTransferForm(tx, ctx.tenantId, input.employment.formId);
  const settings = await readTransferSettings(tx, ctx.tenantId);
  return form.isStandard && settings.unrestrictTargetDepartment
    ? { ...ctx, transferTarget: { employeeId, departmentId } }
    : ctx;
}

export async function createTransfer(tx: Tx, ctx: EmploymentContext, employeeId: string, input: TransferInput) {
  if (input.initiator === 'employee') ctx = { ...ctx, selfServiceEmployeeId: employeeId };
  ctx = { ...ctx, managerTransfer: input.initiator === 'manager' };
  // F-008 / org/locks.ts：参与员工闭包 → 业务 → 组织 → 编制 → 审批实例；锁内重验关系/范围。
  const { linkage, linkageAccess } = input;
  await lockTransferParticipants(tx, ctx, employeeId, [
    ...(input.employment.fields.addedSubordinateIds ?? []),
    ...dutySubordinateIds(linkage),
  ]);
  await lockEmploymentEmployee(tx, ctx, employeeId, ctx.expectedRevision);
  const { confirmed } = input;
  input = { ...(await normalizeTransferInput(tx, ctx, { ...input.writable, submit: input.submit })), linkage };
  // 创建与随后的提交共用同一确认标记（F-026）：非严格控编超编先 409 CONFIRMATION_REQUIRED，整单回滚。
  ctx = withEstablishmentConfirmation(ctx, confirmed);
  const prepared = await prepareInheritance(tx, ctx, { ...input.employment, employeeId });
  const sourceContext = { ...ctx, transferTarget: undefined };
  ctx = await transferTargetContext(tx, sourceContext, employeeId, input, prepared.fields.departmentId);
  await requireTransferWrite(ctx, input);
  if (input.employment.mode === 'direct') await requireDirectTransfer(tx, ctx);
  const form = await resolveTransferForm(tx, ctx.tenantId, input.employment.formId);
  // F-181a：暂存按（经办人 × 员工）一份——暂存 / 提交先换掉自己旧的暂存单（同事务，失败整体回滚）。
  // 删旧单会推进员工版本；入口的 If-Match 已在上面的员工锁内核对过，这里改用推进后的版本继续创建。
  const slot = occupiesDraftSlot({ initiator: input.initiator, mode: input.employment.mode });
  if (slot && (await releaseTransferDraft(tx, ctx, employeeId)))
    ctx = { ...ctx, expectedRevision: (await lockEmploymentEmployee(tx, ctx, employeeId)).revision };
  const created = await createEmploymentBusiness(tx, ctx, employeeId, input.employment, {
    withEstablishment: input.writable.withEstablishment === true,
  });
  const metadata = {
    initiator: input.initiator,
    transferTypeCode: input.transferTypeCode,
    reasonCode: input.reasonCode ?? null,
    processCode: form.processCode,
    withEstablishment: input.writable.withEstablishment === true,
  };
  await tx.execute(sql`
    INSERT INTO transfer_requests(
      tenant_id,business_id,employee_id,initiator,transfer_type_code,reason_code,process_code,with_establishment)
    VALUES (${ctx.tenantId},${created.id}::uuid,${employeeId}::uuid,${metadata.initiator},
      ${metadata.transferTypeCode},${metadata.reasonCode},${metadata.processCode},${metadata.withEstablishment})
  `);
  await auditEmployment(tx, ctx, 'transfer.request.create', 'transfer-request', created.id, null, metadata);
  if (slot && !input.submit) await holdTransferDraft(tx, ctx, employeeId, created.id);
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

async function transferRequestEmployee(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const [request] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`
    SELECT employee_id AS "employeeId" FROM transfer_requests
    WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid
  `),
  );
  return request?.employeeId;
}

/** 取锁—复核—再取锁的上限：参与集合每轮都在涨说明有人持续改关系，放弃本次交还调用方刷新重试。 */
const LOCK_PLAN_ATTEMPTS = 4;

const planChanged = () =>
  new AppError('CONFLICT', '联动参与人员已变化，请刷新后重试', { reason: 'TRANSFER_LOCK_PLAN_CHANGED' });

/**
 * 同单写入口的“取锁阶段”（DEC-993 单入口；第 6 轮拆段，DEC-996）：只按单据找到发起员工，按锁序分两段取齐会阻塞的锁。
 * ① 员工段：参与员工闭包（含 extra 里请求新带入、且现存的下属）→ 发起员工行，取完重新规划；集合在取锁期间变大
 *   （如别人把某员工的虚线经理改成发起员工）就继续按 UUID 序补员工锁——这一段手上只有员工锁，不持任何业务头；
 * ② 业务头段：员工闭包取齐后统一锁各参与者的业务头（单人闭包也锁本单业务头，第 7 轮 P2-1），再规划一次；此时集合若又变大，
 *   不再回头等员工锁（那会在持业务头时等员工锁，逆序），直接 409 TRANSFER_LOCK_PLAN_CHANGED 放弃本事务，
 *   由重入（失败回查 / 客户端显式重提）重新规划。
 * 审批实例只在首次执行体里锁（重放 / 回查不到那一步），不在此预锁。两段取齐后封口：本函数返回后事务里不会再因新参与者等锁；
 * transferBusinessContext 'command' 阶段的取锁都是重入。本函数不读任何授权输入。
 * 请求点名但查无此人的新增下属不取锁、不在这里报错（第 5 轮 P2-3）：报错会抢在台账指纹比对之前，把同键异内容的 409 遮成 400；
 * 留给首次执行的业务校验（validateTransferSubordinates → 400 TRANSFER_PERSON_NOT_ELIGIBLE），那时授权与指纹都已判过。
 * 单据不是调动单时什么都不取。
 */
export async function lockTransferBusinessEmployee(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  extra: readonly string[] = [],
) {
  const employeeId = await transferRequestEmployee(tx, ctx, businessId);
  if (!employeeId) return;
  const present = await existingTransferEmployees(tx, ctx, extra);
  for (let attempt = 0; ; attempt += 1) {
    if (attempt === LOCK_PLAN_ATTEMPTS) throw planChanged();
    await lockTransferParticipants(tx, ctx, employeeId, present, { deferHeads: true });
    await lockEmploymentEmployee(tx, ctx, employeeId);
    if (await transferLocksCover(tx, ctx, employeeId, present)) break;
  }
  await lockTransferHeads(tx, ctx, businessId);
  if (!(await transferLocksCover(tx, ctx, employeeId, present))) throw planChanged();
  await sealTransferLocks(tx, ctx);
}

/** 同单操作按当前调用人的权限判断；原发起人类型仅是业务事实，不决定后续操作者的身份。 */
export async function transferBusinessContext(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  phase: 'read' | 'before-command' | 'command' = 'read',
  targetDepartmentId?: string | null,
  referenceChange?: EmploymentBusinessPatch,
) {
  const [request] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`
    SELECT employee_id AS "employeeId" FROM transfer_requests
    WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid
  `),
  );
  if (!request) return ctx;
  // F-008：等员工锁完成后才重验源范围，避免锁等待期间调出员工后沿用此前目标例外。
  if (phase === 'command') {
    await lockTransferParticipants(tx, ctx, request.employeeId);
    await lockEmploymentEmployee(tx, ctx, request.employeeId);
  }
  // 每次同单请求（包括命令缓存重放）都验权；首次执行仍在员工锁后复验。
  const manager = await requireManagerBusinessSource(tx, ctx, request.employeeId, phase !== 'read');
  // PATCH / submit 的缓存前检查与员工锁后复验共用此处；读取、撤回、删除不因目标撤权而受阻。
  if (manager && referenceChange !== undefined)
    await requireManagerBusinessReferences(tx, ctx, businessId, referenceChange);
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
