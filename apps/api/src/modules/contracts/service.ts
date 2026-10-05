import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  contractRecords,
  contractRequests,
  contractChanges,
  contractPortfolios,
  sql,
  type Tx,
} from '@italent/db';
import { CONTRACT_FIELDS, tenantLocalDate, addDays } from '@italent/domain';
import { AppError } from '../../errors.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { validateCustomValue } from '../employment/fields.js';
import { audit, checkFields, checkScope, lockEmployee, revision, rowsOf, type ContractContext } from './context.js';
import { settings, verifyIds } from './configuration.js';
import { commandSchema, parse, type ContractCommand, type ContractFields } from './input.js';

export type Contract = typeof contractRecords.$inferSelect;
export type ContractRequest = typeof contractRequests.$inferSelect;
function assertOperationState(operation: string, before: Contract) {
  const statuses = ['renew', 'edit'].includes(operation) ? ['valid', 'terminated'] : ['valid'];
  if (before.approvalStatus !== 'effective' || !statuses.includes(before.status))
    throw new AppError('CONFLICT', '当前合同状态不允许该操作');
}
/** DEC-167：编辑是更正版本，不是续签；终止原因在版本间保留，不能用改日期抹掉护栏。 */
function correctedState(
  before: Contract,
  data: { endDate: string | null; actualTerminationDate: string | null },
  today: string,
) {
  const preserved = {
    status: before.status,
    actualTerminationDate: before.actualTerminationDate,
    terminationReason: before.terminationReason,
  };
  if (before.status !== 'terminated') return { ...preserved, actualTerminationDate: data.actualTerminationDate };
  const extended = before.endDate !== null && data.endDate !== null && data.endDate > before.endDate;
  const restore = before.terminationReason === 'expiry' && extended && data.endDate! > today;
  const changedActual = data.actualTerminationDate !== before.actualTerminationDate;
  const futureEnd = data.endDate !== before.endDate && (data.endDate === null || data.endDate > today);
  if ((!restore && (changedActual || futureEnd)) || (restore && changedActual && data.actualTerminationDate !== null)) {
    throw new AppError('CONFLICT', '该终止原因不允许通过编辑导入改变终止状态', {
      reason: 'CONTRACT_TERMINATION_PROTECTED',
      terminationReason: before.terminationReason ?? 'unknown',
    });
  }
  return restore ? { status: 'valid', actualTerminationDate: null, terminationReason: null } : preserved;
}
export async function loadContract(tx: Tx, tenantId: string, id: string) {
  const [record] = await tx
    .select()
    .from(contractRecords)
    .where(and(eq(contractRecords.tenantId, tenantId), eq(contractRecords.id, id), eq(contractRecords.deleted, false)));
  if (!record) throw new AppError('NOT_FOUND', '合同不存在');
  return record;
}
export async function loadRequest(tx: Tx, tenantId: string, id: string) {
  const [request] = await tx
    .select()
    .from(contractRequests)
    .where(and(eq(contractRequests.tenantId, tenantId), eq(contractRequests.id, id)));
  if (!request) throw new AppError('NOT_FOUND', '合同申请不存在');
  return request;
}
export async function portfolioRevision(tx: Tx, tenantId: string, employeeId: string) {
  const [p] = await tx
    .select()
    .from(contractPortfolios)
    .where(and(eq(contractPortfolios.tenantId, tenantId), eq(contractPortfolios.employeeId, employeeId)));
  return p?.revision ?? 0;
}
async function bumpPortfolio(tx: Tx, ctx: ContractContext, employeeId: string) {
  await tx
    .insert(contractPortfolios)
    .values({ tenantId: ctx.tenantId, employeeId, revision: 1 })
    .onConflictDoUpdate({
      target: [contractPortfolios.tenantId, contractPortfolios.employeeId],
      set: { revision: sql`${contractPortfolios.revision}+1` },
    });
}
export function businessFields(value: Contract | ContractRequest) {
  return { ...Object.fromEntries(CONTRACT_FIELDS.map((key) => [key, value[key]])), customFields: value.customFields };
}
export async function prepare(tx: Tx, ctx: ContractContext, raw: unknown, correction = false) {
  const input = parse(commandSchema, raw);
  await lockEmployee(tx, ctx, input.employeeId);
  const before = input.targetId ? await loadContract(tx, ctx.tenantId, input.targetId) : null;
  if (before && before.employeeId !== input.employeeId) throw new AppError('NOT_FOUND', '合同不存在');
  await checkScope(tx, ctx, input.employeeId, before?.createdBy);
  await checkFields(ctx, input.operation === 'create' ? 'create' : 'update', input.fields);
  revision(ctx.expectedRevision, before?.revision ?? 0);
  if ((input.operation === 'create') === !!before) throw new AppError('VALIDATION_FAILED', '合同操作与目标不匹配');
  if (before) assertOperationState(correction ? 'edit' : input.operation, before);
  if (input.operation === 'renew' && input.fields.typeId && input.fields.typeId !== before!.typeId) {
    throw new AppError('VALIDATION_FAILED', '续签不能修改合同类型');
  }
  if (input.operation === 'terminate' && !input.fields.actualTerminationDate) {
    throw new AppError('VALIDATION_FAILED', '终止必须填写实际终止时间');
  }
  if (input.operation === 'terminate' && Object.keys(input.fields).some((k) => k !== 'actualTerminationDate')) {
    throw new AppError('VALIDATION_FAILED', '终止操作只接受实际终止时间');
  }
  if (input.operation === 'terminate' && input.fields.actualTerminationDate! < before!.effectiveDate) {
    throw new AppError('VALIDATION_FAILED', '实际终止时间不能早于合同生效日期');
  }
  const config = await settings(tx, ctx.tenantId);
  const inherited = before ? businessFields(before) : {};
  // 新的一次签订不沿用上一次的签订日与试用期，调用方明确填写的值仍保留。
  if (input.operation === 'renew')
    Object.assign(inherited, {
      signingDate: null,
      probationStartDate: null,
      probationEndDate: null,
    });
  const merged = { ...inherited, ...input.fields };
  if (!merged.typeId || !merged.companyId || !merged.effectiveDate) {
    throw new AppError('VALIDATION_FAILED', '合同类型、法人公司、生效日期必填');
  }
  // 校验继承后的完整载荷，防止未授权引用、自定义字段或日期经批量和导入旁路写入。
  const normalized = parse(commandSchema, { ...input, fields: merged }).fields;
  const typeId = normalized.typeId!;
  await validateReferences(tx, ctx, input, normalized, config, before);
  const signingCount =
    input.operation === 'change' || input.operation === 'terminate'
      ? before!.signingCount
      : await nextSigningCount(tx, ctx, input.employeeId, typeId, config.accumulateRehire);
  const termType =
    input.fields.termType ??
    (['create', 'renew'].includes(input.operation) && config.indefiniteTypeIds.includes(typeId) && signingCount >= 3
      ? 'indefinite'
      : (normalized.termType ?? 'fixed'));
  const effectiveDate = normalized.effectiveDate!;
  const endDate = termType === 'indefinite' ? null : (normalized.endDate ?? null);
  if ((termType === 'fixed' && !endDate) || (endDate && endDate <= effectiveDate)) {
    throw new AppError('VALIDATION_FAILED', '合同终止日期必须晚于生效日期');
  }
  if (
    normalized.probationStartDate &&
    normalized.probationEndDate &&
    normalized.probationEndDate < normalized.probationStartDate
  ) {
    throw new AppError('VALIDATION_FAILED', '试用期结束日期不能早于开始日期');
  }
  if (input.operation === 'renew' && !input.fields.effectiveDate) {
    throw new AppError('VALIDATION_FAILED', '续签必须填写新的生效日期');
  }
  let number = input.fields.number;
  if (input.operation === 'terminate') number = before!.number;
  else if (config.autoNumber) {
    number =
      input.operation === 'change' && effectiveDate <= before!.effectiveDate
        ? before!.number
        : (number ?? `CT-${randomUUID()}`);
  }
  if (!number) throw new AppError('VALIDATION_FAILED', '合同编号必填');
  const data = preparedFields(input, normalized, { number, typeId, termType, effectiveDate, endDate, signingCount });
  return { input, before, data };
}
function preparedFields(
  input: ContractCommand,
  normalized: ContractFields,
  values: {
    number: string;
    typeId: string;
    termType: string;
    effectiveDate: string;
    endDate: string | null;
    signingCount: number;
  },
) {
  const { number, typeId, termType, effectiveDate, endDate, signingCount } = values;
  const data = {
    number,
    typeId,
    companyId: normalized.companyId!,
    termType,
    termMonths: termType === 'fixed' ? (normalized.termMonths ?? null) : null,
    signingDate: normalized.signingDate ?? null,
    effectiveDate,
    endDate,
    signingCount,
    actualTerminationDate:
      input.operation === 'terminate'
        ? normalized.actualTerminationDate!
        : input.operation === 'renew'
          ? null
          : (normalized.actualTerminationDate ?? null),
    probationStartDate: normalized.probationStartDate ?? null,
    probationEndDate: normalized.probationEndDate ?? null,
    probationSalary: normalized.probationSalary ?? null,
    regularSalary: normalized.regularSalary ?? null,
    employmentRecordId: normalized.employmentRecordId ?? null,
    sourceCode: normalized.sourceCode ?? null,
    customFields: normalized.customFields ?? {},
  };
  return data;
}
async function validateReferences(
  tx: Tx,
  ctx: ContractContext,
  input: ContractCommand,
  normalized: ContractFields,
  config: Awaited<ReturnType<typeof settings>>,
  before: Contract | null,
) {
  const typeId = normalized.typeId!;
  await verifyIds(tx, ctx.tenantId, 'contract_types', [typeId]);
  await verifyIds(tx, ctx.tenantId, 'contract_companies', [normalized.companyId!]);
  for (const [id, value] of Object.entries(normalized.customFields ?? {})) {
    const [definition] = rowsOf<{ value_type: string }>(
      await tx.execute(sql`SELECT value_type
      FROM employment_custom_field_objects WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid
        AND object_type='contract'`),
    );
    if (!definition) throw new AppError('VALIDATION_FAILED', '合同自定义字段不存在');
    validateCustomValue(value, definition.value_type);
  }
  if (normalized.employmentRecordId) {
    const [record] = rowsOf(
      await tx.execute(sql`SELECT id FROM employment_records WHERE tenant_id=${ctx.tenantId}
      AND id=${normalized.employmentRecordId}::uuid AND employee_id=${input.employeeId}::uuid`),
    );
    if (!record) throw new AppError('VALIDATION_FAILED', '任职记录不属于该员工');
  }
  await checkScope(tx, ctx, input.employeeId, before?.createdBy);
  // DEC-164①：历史补录按合同生效日的任职判断，不按操作当天的离职状态判断。
  const current = await findCurrentRecord(tx, ctx.tenantId, input.employeeId, normalized.effectiveDate!);
  const [exit] =
    current && ['leave', 'retirement'].includes(current.kind)
      ? rowsOf<{ lastWorkDate: string }>(
          await tx.execute(sql`SELECT
        coalesce(last_work_date,start_date-1)::text AS "lastWorkDate" FROM employment_records
        WHERE tenant_id=${ctx.tenantId} AND id=${current.id}::uuid`),
        )
      : [];
  if (
    exit &&
    normalized.effectiveDate! > exit.lastWorkDate &&
    !config.postExitTypeIds.includes(typeId) &&
    input.operation !== 'terminate'
  )
    throw new AppError('VALIDATION_FAILED', '该合同类型不允许离职或退休后签订');
}
async function nextSigningCount(tx: Tx, ctx: ContractContext, employeeId: string, typeId: string, accumulate: boolean) {
  const [count] = rowsOf<{ count: number }>(
    await tx.execute(sql`SELECT coalesce(max(signing_count),0)::int AS count
    FROM contract_records WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid
      AND type_id=${typeId}::uuid AND NOT deleted AND status<>'void'
      AND (${accumulate} OR effective_date >= coalesce((SELECT max(entry_date) FROM employment_cycles
        WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid
          AND entry_date<=${tenantLocalDate(ctx.now, ctx.timezone)}::date),'0001-01-01'::date))`),
  );
  return (count?.count ?? 0) + 1;
}
/** 合同申请只保存载荷，审批通过与生效分离（DEC-125，同任职申请）。 */
export async function createCommand(
  tx: Tx,
  ctx: ContractContext,
  raw: unknown,
  systemInitiated = false,
  correction = false,
) {
  const { input, before, data } = await prepare(tx, ctx, raw, correction);
  if (correction && before) {
    data.number = input.fields.number ?? before.number;
    data.actualTerminationDate = correctedState(
      before,
      data,
      tenantLocalDate(ctx.now, ctx.timezone),
    ).actualTerminationDate;
  }
  // 同一源合同只允许一张未完成申请；员工锁将批量、单条、调度的检查串行化。
  if (before) {
    const [pending] = rowsOf(
      await tx.execute(sql`SELECT id FROM contract_requests WHERE tenant_id=${ctx.tenantId}
      AND target_id=${before.id}::uuid AND status IN ('in_review','approved','returned') LIMIT 1`),
    );
    if (pending) throw new AppError('CONFLICT', '该合同已有未完成申请');
  }
  const [request] = await tx
    .insert(contractRequests)
    .values({
      ...data,
      tenantId: ctx.tenantId,
      employeeId: input.employeeId,
      operation: correction ? 'edit' : input.operation,
      mode: input.mode,
      targetId: before?.id ?? null,
      targetRevision: before?.revision ?? null,
      status: input.mode === 'application' ? 'in_review' : 'approved',
      createdBy: ctx.userId,
      systemInitiated,
      createdAt: ctx.now,
    })
    .returning();
  await audit(tx, ctx, 'contract.request.create', request!.id, null, request);
  if (input.mode === 'application') {
    const { startOrResume } = await import('../approval/engine.js');
    await startOrResume(tx, ctx, { businessType: 'contract', businessId: request!.id });
    return request!;
  }
  const dueDate = input.operation === 'terminate' ? data.actualTerminationDate! : data.effectiveDate;
  return dueDate <= tenantLocalDate(ctx.now, ctx.timezone) ? applyRequest(tx, ctx, request!) : request!;
}
export async function applyRequest(tx: Tx, ctx: ContractContext, request: ContractRequest): Promise<Contract> {
  await lockEmployee(tx, ctx, request.employeeId);
  const latest = await loadRequest(tx, ctx.tenantId, request.id);
  if (latest.status === 'effective') return loadContract(tx, ctx.tenantId, latest.resultId!);
  if (latest.status !== 'approved') throw new AppError('CONFLICT', '合同申请尚未审批通过');
  const before = latest.targetId ? await loadContract(tx, ctx.tenantId, latest.targetId) : null;
  if (before) {
    await assertSourceRevision(tx, ctx, latest, before);
    assertOperationState(latest.operation, before);
  }
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const due = latest.operation === 'terminate' ? latest.actualTerminationDate! : latest.effectiveDate;
  if (due > today) throw new AppError('CONFLICT', '合同尚未到生效日期');
  const data = { ...businessFields(latest), signingCount: latest.signingCount };
  const correction = latest.operation === 'edit' ? correctedState(before!, latest, today) : null;
  let result: Contract;
  if (latest.operation === 'terminate') {
    result = await setContractState(tx, ctx, before!, 'terminated', latest.actualTerminationDate);
  } else {
    if (['change', 'edit'].includes(latest.operation)) {
      await setContractState(
        tx,
        ctx,
        before!,
        latest.operation === 'edit' || latest.effectiveDate <= before!.effectiveDate ? 'void' : 'terminated',
        latest.operation === 'edit' || latest.effectiveDate <= before!.effectiveDate
          ? before!.actualTerminationDate
          : addDays(latest.effectiveDate, -1),
        latest.operation === 'edit' ? before!.terminationReason : 'change',
      );
    }
    const id = randomUUID();
    const inserted = {
      ...latest,
      ...data,
      id,
      status: 'valid',
      terminationReason: null,
      ...correction,
      approvalStatus: 'effective',
      revision: 1,
      previousContractId: before?.id ?? null,
      rootContractId: before?.rootContractId ?? id,
      versionNo: (before?.versionNo ?? 0) + 1,
      createdAt: ctx.now,
    };
    const {
      operation: _operation,
      mode: _mode,
      targetId: _target,
      targetRevision: _revision,
      resultId: _result,
      systemInitiated: _system,
      ...values
    } = inserted;
    const [saved] = await tx.insert(contractRecords).values(values).returning();
    result = saved!;
    if (['change', 'edit'].includes(latest.operation)) {
      const current = await checkScope(tx, { ...ctx, scope: undefined }, latest.employeeId);
      await tx.insert(contractChanges).values({
        tenantId: ctx.tenantId,
        employeeId: latest.employeeId,
        organizationId: current?.fields.departmentId ?? null,
        beforeContractId: before!.id,
        afterContractId: result.id,
        requestId: latest.id,
        createdAt: ctx.now,
      });
    }
    await audit(tx, ctx, 'contract.create', result.id, null, result);
  }
  await tx
    .update(contractRequests)
    .set({ status: 'effective', resultId: result.id, revision: latest.revision + 1 })
    .where(eq(contractRequests.id, latest.id));
  await bumpPortfolio(tx, ctx, latest.employeeId);
  await audit(tx, ctx, 'contract.request.effective', latest.id, latest, { status: 'effective', resultId: result.id });
  return result;
}
/** 自动到期是同一业务版本的状态变化，不能使已审批的续签失效；其余 revision 变化仍拒绝。 */
async function assertSourceRevision(tx: Tx, ctx: ContractContext, request: ContractRequest, before: Contract) {
  if (request.targetRevision === before.revision) return;
  if (
    request.operation === 'renew' &&
    before.revision === request.targetRevision! + 1 &&
    before.status === 'terminated' &&
    before.actualTerminationDate === before.endDate
  ) {
    const [expiry] = rowsOf(
      await tx.execute(sql`SELECT id FROM contract_outbox
      WHERE tenant_id=${ctx.tenantId} AND object_id=${before.id}::uuid
        AND command_id=${`ct-job:expire:${before.id}`} AND event_type='contract.state'
        AND (payload->'before'->>'revision')::int=${request.targetRevision}
        AND (payload->'after'->>'revision')::int=${before.revision} LIMIT 1`),
    );
    if (expiry) return;
  }
  revision(request.targetRevision!, before.revision);
}
export async function setContractState(
  tx: Tx,
  ctx: ContractContext,
  before: Contract,
  status: string,
  actualTerminationDate: string | null,
  terminationReason = status === 'terminated'
    ? before.endDate && actualTerminationDate === before.endDate
      ? 'expiry'
      : 'early'
    : before.terminationReason,
) {
  const [after] = await tx
    .update(contractRecords)
    .set({ status, actualTerminationDate, terminationReason, revision: before.revision + 1 })
    .where(
      and(
        eq(contractRecords.tenantId, ctx.tenantId),
        eq(contractRecords.id, before.id),
        eq(contractRecords.revision, before.revision),
      ),
    )
    .returning();
  if (!after) throw new AppError('REVISION_CONFLICT', '合同已变更');
  await bumpPortfolio(tx, ctx, before.employeeId);
  await audit(tx, ctx, 'contract.state', before.id, before, after);
  return after;
}
export async function deleteContract(tx: Tx, ctx: ContractContext, before: Contract) {
  await tx
    .update(contractRecords)
    .set({ deleted: true, revision: before.revision + 1 })
    .where(eq(contractRecords.id, before.id));
  await bumpPortfolio(tx, ctx, before.employeeId);
  await audit(tx, ctx, 'contract.delete', before.id, before, null);
}
export async function batchCommands(
  tx: Tx,
  ctx: ContractContext,
  entries: { revision: number; command: ContractCommand }[],
) {
  if (!entries.length || entries.length > 100) throw new AppError('VALIDATION_FAILED', '批量合同操作限 1～100 条');
  const normalized = entries.map((row) => ({ ...row, command: parse(commandSchema, row.command) }));
  const ids = [...new Set(normalized.map((row) => row.command.employeeId))].sort();
  for (const id of ids) await lockEmployee(tx, ctx, id);
  const result = [];
  for (const row of normalized)
    result.push(await createCommand(tx, { ...ctx, expectedRevision: row.revision }, row.command));
  return { items: result };
}
