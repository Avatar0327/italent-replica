/** F-481 §6.2：调用方先持员工 / 业务锁；业务失败落 failed，数据库错误仍随调动回滚。 */
import { randomUUID } from 'node:crypto';
import { eq, and, esignTasks, esignTaskFiles, sql, type Tx } from '@italent/db';
import { esignExpiresAt, renderTemplateBody, tenantLocalDate, type EsignFailureReason } from '@italent/domain';
import { AppError } from '../../errors.js';
import { personnelHooks } from '../employment/personnel-hooks.js';
import { userOfPerson, isActiveAccount } from '../approval/resolver.js';
import { auditEmployment, employmentCreator } from '../employment/context.js';
import { loadEmploymentRecord } from '../employment/read-model.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { simulatedProvider } from './provider.js';
import { selectedTemplates } from './transfer-input.js';

export async function transferSignInitiator(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<string> {
  const [row] = rowsOf<{ userId: string | null }>(
    await tx.execute(sql`
    SELECT COALESCE((SELECT initiator_user_id FROM approval_instances
      WHERE tenant_id=${ctx.tenantId} AND business_type='employment' AND business_id=${businessId}::uuid
      ORDER BY created_at DESC, id DESC LIMIT 1),
      ${employmentCreator(ctx.tenantId, sql`${businessId}::uuid`, true)}) AS "userId"`),
  );
  if (!row?.userId) throw new AppError('SERVICE_UNAVAILABLE', '调动发起人不可读取');
  return row.userId;
}

export interface InitiateTransferSignInput {
  readonly businessId: string;
  readonly templateIds: readonly string[];
  readonly initiatorUserId: string;
  readonly origin: 'activation' | 'manual';
}
type SignFiles = (typeof esignTaskFiles.$inferSelect)[];

export async function initiateTransferSign(tx: Tx, ctx: EmploymentContext, input: InitiateTransferSignInput) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await loadEmploymentRecord(tx, ctx.tenantId, input.businessId, today);
  if (!record || record.kind !== 'transfer') throw new AppError('NOT_FOUND', '调动不存在');
  const [inProgress] = await tx
    .select({ id: esignTasks.id })
    .from(esignTasks)
    .where(
      and(
        eq(esignTasks.tenantId, ctx.tenantId),
        eq(esignTasks.businessId, input.businessId),
        eq(esignTasks.status, 'signing'),
      ),
    )
    .limit(1);
  if (inProgress) throw new AppError('CONFLICT', '已有签署中的任务', { reason: 'ESIGN_TASK_IN_PROGRESS' });
  const templates = await selectedTemplates(tx, ctx.tenantId, input.templateIds);
  const unavailable = input.templateIds.filter((id) => !templates.some((t) => t.id === id && t.status === 'enabled'));
  const employeeSignerUserId = await userOfPerson(tx, ctx.tenantId, record.employeeId);
  let failureReason: EsignFailureReason | null = unavailable.length ? 'TEMPLATE_UNAVAILABLE' : null;
  if (!failureReason && !employeeSignerUserId) failureReason = 'EMPLOYEE_NO_ACCOUNT';
  if (!failureReason && !(await isActiveAccount(tx, ctx.tenantId, input.initiatorUserId)))
    failureReason = 'INITIATOR_NO_ACCOUNT';
  const [settings] = rowsOf<{ validityDays: number; remind: boolean }>(
    await tx.execute(sql`
    SELECT validity_days AS "validityDays", remind_before_expiry AS remind FROM esign_scene_settings
    WHERE tenant_id=${ctx.tenantId} AND scene='transfer'`),
  );
  const validityDays = settings?.validityDays ?? 2;
  const id = randomUUID();
  const rendered = failureReason
    ? { files: [], failureReason: null }
    : await renderTransferFiles(tx, ctx, record, today, id, input.templateIds, templates);
  failureReason ??= rendered.failureReason;
  const [task] = await tx
    .insert(esignTasks)
    .values({
      id,
      tenantId: ctx.tenantId,
      scene: 'transfer',
      businessId: input.businessId,
      employeeId: record.employeeId,
      ownerDepartmentId: record.fields.departmentId,
      initiatorUserId: input.initiatorUserId,
      origin: input.origin,
      status: failureReason ? 'failed' : 'signing',
      currentNode: failureReason ? null : 'employee',
      employeeSignerUserId,
      validityDays,
      expiresAt: esignExpiresAt(ctx.now, validityDays),
      remindBeforeExpiry: settings?.remind ?? false,
      initiatedAt: ctx.now,
      failureReason,
      failureDetail: unavailable.length ? JSON.stringify({ templateIds: unavailable }) : null,
      provider: simulatedProvider.name,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await finishInitiation(tx, ctx, input, task!, rendered.files);
  return task!;
}

async function renderTransferFiles(
  tx: Tx,
  ctx: EmploymentContext,
  record: NonNullable<Awaited<ReturnType<typeof loadEmploymentRecord>>>,
  today: string,
  taskId: string,
  ids: readonly string[],
  templates: Awaited<ReturnType<typeof selectedTemplates>>,
): Promise<{ files: SignFiles; failureReason: EsignFailureReason | null }> {
  // 数据库错误不可转为业务失败；只有纯替换失败才记 RENDER_FAILED。
  const values = await transferVariables(tx, ctx, record, today);
  try {
    const files = ids.map((templateId, i) => {
      const template = templates.find((t) => t.id === templateId)!;
      return {
        tenantId: ctx.tenantId,
        taskId,
        seq: i + 1,
        templateId,
        templateName: template.name,
        content: renderTemplateBody(template.body, values),
      };
    });
    return { files, failureReason: null };
  } catch {
    return { files: [], failureReason: 'RENDER_FAILED' };
  }
}

async function finishInitiation(
  tx: Tx,
  ctx: EmploymentContext,
  input: InitiateTransferSignInput,
  task: typeof esignTasks.$inferSelect,
  files: SignFiles,
) {
  if (!task.failureReason) {
    await tx.insert(esignTaskFiles).values(files);
    await simulatedProvider.createEnvelope({
      tenantId: ctx.tenantId,
      taskId: task.id,
      files: files.map((f) => ({ seq: f.seq, name: f.templateName, content: f.content })),
      signers: [
        { node: 'employee', userId: task.employeeSignerUserId! },
        { node: 'enterprise', userId: input.initiatorUserId },
      ],
      expiresAt: task.expiresAt,
    });
  }
  await auditEmployment(
    tx,
    ctx,
    task.failureReason ? 'esign.task.failed' : 'esign.task.initiated',
    'esign-task',
    task.id,
    null,
    {
      businessId: input.businessId,
      templateIds: input.templateIds,
      origin: input.origin,
      failure_reason: task.failureReason,
    },
    undefined,
    undefined,
    { employeeId: task.employeeId, orgId: task.ownerDepartmentId },
  );
}

async function transferVariables(
  tx: Tx,
  ctx: EmploymentContext,
  record: NonNullable<Awaited<ReturnType<typeof loadEmploymentRecord>>>,
  today: string,
) {
  if (!ctx.tenantName) throw new AppError('SERVICE_UNAVAILABLE', '租户名称上下文不可用');
  const previous = record.previousRecordId
    ? await loadEmploymentRecord(tx, ctx.tenantId, record.previousRecordId, record.effectiveDate)
    : null;
  const [employee] = rowsOf<{ name: string; code: string | null }>(
    await tx.execute(sql`
    SELECT ${personnelHooks.currentName(ctx.tenantId, sql`e.id`, sql`e.name`)} AS name,e.code
    FROM employment_employees e
    WHERE e.tenant_id=${ctx.tenantId} AND e.id=${record.employeeId}::uuid`),
  );
  const [contract] = rowsOf<{ start: string; end: string | null }>(
    await tx.execute(sql`
    SELECT c.effective_date::text AS start,c.end_date::text AS end FROM transfer_linkage_runs r
    JOIN contract_records c ON c.tenant_id=r.tenant_id AND c.id=r.after_contract_id AND NOT c.deleted
    WHERE r.tenant_id=${ctx.tenantId} AND r.business_id=${record.id}::uuid`),
  );
  const nameOf = async (kind: 'org' | 'job_position', id: string | null | undefined) => {
    if (!id) return null;
    const column = kind === 'org' ? sql`org_id` : sql`object_id`;
    const [row] = rowsOf<{ name: string }>(
      await tx.execute(sql`SELECT name FROM ${sql.identifier(`${kind}_versions`)}
      WHERE tenant_id=${ctx.tenantId} AND ${column}=${id}::uuid AND start_date<=${record.effectiveDate}::date
      ORDER BY start_date DESC,version_no DESC LIMIT 1`),
    );
    return row?.name ?? null;
  };
  return {
    员工姓名: employee?.name,
    工号: employee?.code,
    调动生效日期: record.effectiveDate,
    调出部门: await nameOf('org', previous?.fields.departmentId),
    调入部门: await nameOf('org', record.fields.departmentId),
    调出职位: await nameOf('job_position', previous?.fields.positionId),
    调入职位: await nameOf('job_position', record.fields.positionId),
    新合同开始日期: contract?.start,
    新合同结束日期: contract?.end,
    发起日期: today,
    企业名称: ctx.tenantName,
  };
}
