/** F-505 §5：已授权、已锁定的来源及其模板快照，在调用方事务内一次写齐。 */
import { randomUUID } from 'node:crypto';
import { esignTasks, esignTaskFiles, type Tx } from '@italent/db';
import { esignExpiresAt, renderTemplateBody, type EsignFailureReason, type EsignVariableValues } from '@italent/domain';
import { AppError } from '../../errors.js';
import { isActiveAccount, userOfPerson } from '../approval/resolver.js';
import { auditEmployment } from '../employment/context.js';
import type { EmploymentContext } from '../employment/types.js';
import { simulatedProvider } from './provider.js';
import { getSceneSettings } from './service.js';
import { signTaskSourceAudit, type TaskSource } from './task-source.js';

type Template = { readonly id: string; readonly name: string; readonly body: string };
export type PersonVariableField = 'name' | 'code';

interface InitiateSignTaskInput {
  readonly source: TaskSource;
  readonly employeeId: string;
  readonly ownerDepartmentId: string | null;
  readonly initiatorUserId: string;
  readonly origin: 'activation' | 'manual';
  readonly templateIds: readonly string[];
  readonly templates: readonly Template[];
  readonly loadVariables: () => Promise<EsignVariableValues>;
  readonly variableReadFields?: readonly PersonVariableField[];
  readonly unavailableTemplateIds?: readonly string[];
}

export async function initiateSignTask(tx: Tx, ctx: EmploymentContext, input: InitiateSignTaskInput) {
  const employeeSignerUserId = await userOfPerson(tx, ctx.tenantId, input.employeeId);
  const unavailable = input.unavailableTemplateIds ?? [];
  let failureReason: EsignFailureReason | null = unavailable.length ? 'TEMPLATE_UNAVAILABLE' : null;
  if (!failureReason && !employeeSignerUserId) failureReason = 'EMPLOYEE_NO_ACCOUNT';
  if (
    (input.source.scene !== 'transfer' || !failureReason) &&
    !(await isActiveAccount(tx, ctx.tenantId, input.initiatorUserId))
  ) {
    if (input.source.scene !== 'transfer') throw new AppError('FORBIDDEN', '发起人账号不可用');
    failureReason = 'INITIATOR_NO_ACCOUNT';
  }

  const settings = await getSceneSettings(tx, ctx.tenantId, input.source.scene);
  const id = randomUUID();
  // 先完成查询，再进入只捕获纯渲染异常的函数。
  const { files, failureReason: renderFailure } = failureReason
    ? { files: [], failureReason: null }
    : renderSignFiles(ctx.tenantId, id, input.templates, await input.loadVariables());
  failureReason ??= renderFailure;

  const [task] = await tx
    .insert(esignTasks)
    .values({
      ...input.source,
      id,
      tenantId: ctx.tenantId,
      employeeId: input.employeeId,
      ownerDepartmentId: input.ownerDepartmentId,
      initiatorUserId: input.initiatorUserId,
      origin: input.origin,
      status: failureReason ? 'failed' : 'signing',
      currentNode: failureReason ? null : 'employee',
      employeeSignerUserId,
      validityDays: settings.validityDays,
      remindBeforeExpiry: settings.remindBeforeExpiry,
      expiresAt: esignExpiresAt(ctx.now, settings.validityDays),
      initiatedAt: ctx.now,
      failureReason,
      failureDetail: unavailable.length ? JSON.stringify({ templateIds: unavailable }) : null,
      provider: simulatedProvider.name,
      variableReadFields: [...(input.variableReadFields ?? [])],
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();

  if (!failureReason) {
    await tx.insert(esignTaskFiles).values(files);
    await simulatedProvider.createEnvelope({
      tenantId: ctx.tenantId,
      taskId: id,
      files: files.map((file) => ({ seq: file.seq, name: file.templateName, content: file.content })),
      signers: [
        { node: 'employee', userId: employeeSignerUserId! },
        { node: 'enterprise', userId: input.initiatorUserId },
      ],
      expiresAt: task!.expiresAt,
    });
  }
  await auditEmployment(
    tx,
    ctx,
    failureReason ? 'esign.task.failed' : 'esign.task.initiated',
    'esign-task',
    id,
    null,
    {
      ...signTaskSourceAudit(task!),
      templateIds: input.templateIds,
      origin: input.origin,
      failure_reason: failureReason,
    },
    undefined,
    undefined,
    { employeeId: task!.employeeId, orgId: task!.ownerDepartmentId },
  );
  return task!;
}

function renderSignFiles(
  tenantId: string,
  taskId: string,
  templates: readonly Template[],
  variables: EsignVariableValues,
) {
  try {
    const files = templates.map((template, index) => ({
      tenantId,
      taskId,
      seq: index + 1,
      templateId: template.id,
      templateName: template.name,
      content: renderTemplateBody(template.body, variables),
    }));
    return { files, failureReason: null };
  } catch {
    return { files: [], failureReason: 'RENDER_FAILED' as const };
  }
}
