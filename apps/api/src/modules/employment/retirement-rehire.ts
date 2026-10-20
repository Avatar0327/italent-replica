/**
 * 退休同时返聘（R2-T04 §8，BE-5b）：请求结构与创建时校验、预览、生效时生成返聘（runSteps R-2）。
 * - 入口：同一个 POST retirements/employees/:id 带 reEmployed + rehire（结构与 POST employees/:id/businesses kind=retire_rehire
 *   一致，不接受 loginEmail / pendingEntry / 返聘日：沿用原账号，返聘日只由退休最终生效日 E′ 经 retireRehireStartDate 算出）。
 * - 创建：结构校验（锁前）→ 业务干跑（返聘部门 / 职位在返聘日可用、黑名单）→ 计划随扩展行落库（jsonb，固定 schema 的待执行命令载荷）。
 * - 生效：退休落地、合同终止之后，在同一保存点内用受信上下文创建 retire_rehire 直接业务（经 write-service 的顺序 / 新周期 /
 *   黑名单 / 编制 / 部门校验）并生成返聘合同；任一步失败整个退休生效失败，不出现“已退休、未返聘”的半套。
 */
import { exitEffects, sql, type Tx } from '@italent/db';
import { resolveLateLeave, retireRehireStartDate, tenantLocalDate } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { generateContractForBusiness } from '../contracts/ports.js';
import { ruleRejection } from './activation-checks.js';
import { assertNotBlacklisted } from './blacklist.js';
import {
  auditEmployment,
  commandContext,
  requireEmploymentScope,
  requireEmploymentWrite,
  scopedGuard,
  type ScopedCommandGuard,
} from './context.js';
import { assertProbationTerms, probationTerms } from './entry-options.js';
import { entryContractSchema, requireContractCreateAccess, type EntryContract } from './entry-contract.js';
import { parseEmploymentInput } from './fields.js';
import type { ExitOptions } from './exit-initiation.js';
import { rowsOf, type LockedEmploymentBusiness } from './record-store.js';
import type { CustomFields, EmploymentContext, PresetFields } from './types.js';
import { createEmploymentBusiness, validateNewCycleEmployment } from './write-service.js';

/** 返聘计划里的入职控制项：没有 pendingEntry（返聘直接生效，不走待入职）。 */
const rehireEntry = z.strictObject({ probation: z.boolean().optional(), ...probationTerms });
/** 返聘合同：生效日不由请求给出（起始日 = 返聘日 R，顺延时跟着变）。 */
const rehireContract = entryContractSchema.omit({ effectiveDate: true });

const rehireEnvelope = z.strictObject({
  fields: z.record(z.string(), z.unknown()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  formId: z.string().optional(),
  entry: rehireEntry.optional(),
  contract: rehireContract.optional(),
});

/** 落库的返聘计划（retirement_requests.rehire_plan）：字段已按任职业务规范化，不含日期。 */
export interface RehirePlan {
  readonly fields: Partial<PresetFields>;
  readonly customFields: CustomFields;
  readonly formId: string;
  readonly entry: {
    readonly probation?: boolean;
    readonly probationMonths?: number;
    readonly probationEndDate?: string;
  };
  readonly contract?: Omit<EntryContract, 'effectiveDate'>;
}

const invalid = (message: string, reason: string, extra: object = {}) =>
  new AppError('VALIDATION_FAILED', message, { reason, ...extra });

/** 通用入口 POST employees/:id/businesses 不接受同时返聘（专用入口才有，设计 §8.2）。 */
export function assertNoRehireKeys(body: unknown): void {
  if (body !== null && typeof body === 'object' && ['reEmployed', 'rehire'].some((key) => Object.hasOwn(body, key)))
    throw invalid('同时返聘只能经退休专用入口办理', 'RETIREMENT_REHIRE_USE_ENDPOINT');
}

/** 专用入口请求体：取出 reEmployed / rehire，其余交给退休通用解析。 */
export function splitRehireOptions(body: unknown): { rawInput: unknown; reEmployed?: unknown; rehire?: unknown } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { rawInput: body };
  const { reEmployed, rehire, ...rawInput } = body as Record<string, unknown>;
  return { rawInput, ...(reEmployed === undefined ? {} : { reEmployed }), ...(rehire === undefined ? {} : { rehire }) };
}

/**
 * 返聘计划的计划返聘日：按创建 / 预览当天的迟到判定得到退休最终生效日 E′，再取 E′ + 1。
 * 生效时以真实 E′（可能因再次迟到而更晚）重算，所以这里的值只用于干跑与预览。
 */
export function plannedRehireStartDate(ctx: EmploymentContext, lastWorkDate: string): string {
  const { effectiveDate } = resolveLateLeave({ lastWorkDate, executionDate: tenantLocalDate(ctx.now, ctx.timezone) });
  return retireRehireStartDate(effectiveDate);
}

/** 结构校验并规范化返聘计划（不读库；任职字段、试用期、合同字段各按各自的 schema）。 */
export function parseRehirePlan(raw: unknown, startDate: string): RehirePlan {
  const parsed = rehireEnvelope.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '返聘计划字段不合法', parsed.error.issues);
  const { entry = {}, contract, ...business } = parsed.data;
  assertProbationTerms(entry);
  const normalized = parseEmploymentInput({
    ...business,
    kind: 'retire_rehire',
    mode: 'direct',
    effectiveDate: startDate,
  });
  return {
    fields: normalized.fields,
    customFields: normalized.customFields,
    formId: normalized.formId,
    entry,
    ...(contract ? { contract } : {}),
  };
}

/**
 * 专用入口的 reEmployed + rehire 一致性与结构校验（§3.2 第 1 步，锁前）：两者同有同无；同时返聘与加黑互斥（§4.4）。
 * 返回 undefined 表示普通退休。
 */
export function resolveRehirePlan(
  ctx: EmploymentContext,
  input: { reEmployed?: unknown; rehire?: unknown },
  lastWorkDate: string,
  exit: ExitOptions,
): RehirePlan | undefined {
  const flag = z.boolean().safeParse(input.reEmployed ?? false);
  if (!flag.success) throw invalid('是否同时返聘必须是布尔值', 'RETIREMENT_REHIRE_PLAN_INVALID');
  if (flag.data !== (input.rehire !== undefined))
    throw invalid('是否同时返聘与返聘计划必须同时提供', 'RETIREMENT_REHIRE_PLAN_INCONSISTENT');
  if (!flag.data) return undefined;
  if (exit.addToBlacklist === true)
    throw invalid('同时返聘的退休不能同时加入黑名单', 'RETIREMENT_REHIRE_BLACKLIST_CONFLICT');
  return parseRehirePlan(input.rehire, plannedRehireStartDate(ctx, lastWorkDate));
}

/**
 * 返聘写的是新任职：字段按 Employment.Create 的字段创建权复核（退休入口本身不要求它），返聘部门在发起人的数据范围内。
 * 入口（事务外）与命令内（rehireGuard）共用这一处。
 */
export async function requireRehireWrite(ctx: EmploymentContext, employeeId: string, plan: RehirePlan) {
  await requireEmploymentWrite(
    ctx,
    'create',
    { fields: plan.fields, customFields: plan.customFields },
    'Employment.Create',
    undefined,
    { commandOnly: true },
  );
  if (plan.fields.departmentId !== undefined) requireEmploymentScope(ctx, employeeId, plan.fields.departmentId);
}

/**
 * 同时返聘创建的命令内复核（#199，DEC-385③）：在退休创建本身的复核之后，按当前授权重过返聘的字段权 / 部门范围，
 * 以及返聘合同的创建权（字段 / 按钮 / 对该员工的合同范围，起始日 = 计划返聘日，口径同办理入职带合同）。
 * 首次执行、同键重放、失败回查三个出口都经它；生效时不再重验（授权以发起人创建时为准，§8.3）。
 */
export function rehireGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  base: ScopedCommandGuard,
  employeeId: string,
  plan: RehirePlan,
  lastWorkDate: string,
): ScopedCommandGuard {
  return scopedGuard({
    ...base,
    before: async (tx) => {
      await base.before(tx);
      await requireRehireWrite(await commandContext(tx, deps, ctx), employeeId, plan);
      if (plan.contract)
        await requireContractCreateAccess(
          tx,
          deps,
          ctx,
          { employeeId, effectiveDate: plannedRehireStartDate(ctx, lastWorkDate) },
          plan.contract,
        );
    },
  });
}

const startInput = (plan: RehirePlan, startDate: string) =>
  parseEmploymentInput({
    kind: 'retire_rehire',
    mode: 'direct',
    effectiveDate: startDate,
    formId: plan.formId,
    fields: plan.fields,
    customFields: plan.customFields,
  });

/** 创建时的业务干跑（§3.2 第 6 步）：黑名单、返聘部门 / 职位 / 引用在返聘日可用；失败抛出，整个创建命令回滚。 */
export async function validateRehirePlan(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  plan: RehirePlan,
  lastWorkDate: string,
): Promise<void> {
  await assertNotBlacklisted(tx, ctx, employeeId);
  await validateNewCycleEmployment(tx, ctx, employeeId, startInput(plan, plannedRehireStartDate(ctx, lastWorkDate)));
}

/** 预览用：返聘日与创建会遇到的问题（只读，不抛业务拒绝；结构错误仍是 400）。 */
export async function previewRehire(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
  input: { reEmployed?: unknown; rehire?: unknown },
) {
  const plan = resolveRehirePlan(ctx, input, lastWorkDate, {});
  if (!plan) return undefined;
  const startDate = plannedRehireStartDate(ctx, lastWorkDate);
  try {
    await tx.transaction((savepoint) => validateRehirePlan(savepoint, ctx, employeeId, plan, lastWorkDate));
    return { startDate, blockers: [] };
  } catch (error) {
    const failure = ruleRejection(error);
    if (!failure) throw error;
    return { startDate, blockers: [{ reason: 'RETIREMENT_REHIRE_INVALID', ...failure.detail }] };
  }
}

/**
 * 返聘的受信上下文（只在编排器内构造，不对外暴露）：命令 ID 派生（与退休命令的审计 / 台账分开）、expectedRevision 取员工行在
 * 退休落地后的当前 revision（同事务内读，员工行已被编排器锁住，不比外部 revision）；去掉请求的授权器与数据范围——
 * 返聘的权限和范围已在创建时按发起人重验，生效可能由审批人 / 调度 / HR 重试触发，结果不能随触发者的范围变化。
 */
async function retirementRehireContext(tx: Tx, ctx: EmploymentContext, employeeId: string): Promise<EmploymentContext> {
  const [employee] = rowsOf<{ revision: number }>(
    await tx.execute(sql`SELECT revision FROM employment_employees WHERE tenant_id=${ctx.tenantId}
      AND id=${employeeId}::uuid`),
  );
  if (!employee) throw new AppError('NOT_FOUND', '员工不存在');
  const { tenantId, userId, timezone, now } = ctx;
  return {
    tenantId,
    userId,
    timezone,
    now,
    commandId: `${ctx.commandId}:rehire`,
    expectedRevision: Number(employee.revision),
  };
}

/** 返聘失败统一映射为生效失败（记 failed、HR 待办、可重试，DEC-052）；非业务规则拒绝（存储不可用等）原样抛出。 */
function rehireFailure(error: unknown): unknown {
  const failure = ruleRejection(error);
  if (!failure) return error;
  return new AppError('CONFLICT', '同时返聘生成失败，退休未生效', {
    activationFailure: { reason: 'RETIREMENT_REHIRE_FAILED', detail: failure.detail },
  });
}

export interface RehireOutcome {
  readonly rehireBusinessId: string;
  readonly startDate: string;
  readonly contractId: string | null;
}

/**
 * R-2（§8.3）：退休生效链保存点内，合同端口之后生成返聘。调用方保证 re_employed = true；
 * 返聘日 R = 最终生效日 E′ + 1，创建时记下的计划不含日期。
 */
export async function createRetirementRehire(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  plan: RehirePlan,
  retirementEffectiveDate: string,
): Promise<RehireOutcome> {
  const startDate = retireRehireStartDate(retirementEffectiveDate);
  try {
    const rehireCtx = await retirementRehireContext(tx, ctx, business.employeeId);
    const created = await createEmploymentBusiness(tx, rehireCtx, business.employeeId, startInput(plan, startDate), {
      entry: { ...plan.entry, pendingEntry: false },
    });
    const contract = plan.contract
      ? await generateContractForBusiness(
          tx,
          {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            timezone: ctx.timezone,
            now: ctx.now,
            commandId: rehireCtx.commandId,
            expectedRevision: 0,
          },
          { employeeId: business.employeeId, fields: { ...plan.contract, effectiveDate: startDate } },
        )
      : null;
    await recordRehire(tx, ctx, business, {
      rehireBusinessId: created.id,
      startDate,
      contractId: contract?.id ?? null,
    });
    return { rehireBusinessId: created.id, startDate, contractId: contract?.id ?? null };
  } catch (error) {
    throw rehireFailure(error);
  }
}

/** 回写返聘业务、记 exit_effects 台账与审计（动作 employment.retirement.rehired；原发起人记在 detail）。 */
async function recordRehire(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  outcome: RehireOutcome,
) {
  await tx.execute(sql`UPDATE retirement_requests SET rehire_business_id=${outcome.rehireBusinessId}::uuid
    WHERE tenant_id=${ctx.tenantId} AND business_id=${business.id}::uuid`);
  await tx.insert(exitEffects).values({
    tenantId: ctx.tenantId,
    businessId: business.id,
    employeeId: business.employeeId,
    phase: 'effective',
    kind: 'rehire_created',
    targetType: 'employment-business',
    targetId: outcome.rehireBusinessId,
    detail: { startDate: outcome.startDate, contractId: outcome.contractId },
    commandId: ctx.commandId,
    createdAt: ctx.now,
  });
  const [exit] = rowsOf<{ initiatorUserId: string }>(
    await tx.execute(sql`SELECT initiator_user_id AS "initiatorUserId" FROM exit_requests
      WHERE tenant_id=${ctx.tenantId} AND business_id=${business.id}::uuid`),
  );
  await auditEmployment(
    tx,
    ctx,
    'employment.retirement.rehired',
    'exit-request',
    business.id,
    null,
    {
      rehireBusinessId: outcome.rehireBusinessId,
      rehireDate: outcome.startDate,
      retirementEffectiveDate: business.payload.effectiveDate,
      contractId: outcome.contractId,
      initiatorUserId: exit?.initiatorUserId ?? null,
    },
    undefined,
    undefined,
    { employeeId: business.employeeId },
  );
}
