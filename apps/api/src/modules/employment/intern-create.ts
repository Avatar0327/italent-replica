/**
 * 新增实习生一体写入（R2 BE-R2d4c；差距表 B38 / A48；31 IN-R1；补证 R2f1「新增实习生时合同协议终止日期必填」；DEC-662）：
 * POST /interns 一个请求、一个命令 ID、一个事务内完成 建档 + 绑定用户（新增）或沿用重聘候选（rehire-matches 返回的 employeeId，
 * 不再建档）→ 创建 hire / rehire 实习任职 → 写入合同协议；任一步失败整体回滚。
 * 入职日 ≤ 租户今天：在同事务内经合同模块端口生成正式合同（起始日 = 入职日），进“实习中”；
 * 入职日在未来：走待入职通道，合同写入待入职合同（entry-pending-contract.ts，终止日经 EntryOptions.pendingContract），
 * 回执 view = pendingEntry——原站未来入职实习生的视图归属未取证，保守保持现状（只在待入职列表，不进四个实习视图），PR“未验证”。
 */
import { tenantLocalDate } from '@italent/domain';
import type { Tx } from '@italent/db';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { provisionEmployeeUser } from '../permission/user-provisioning.js';
import { verifyIds } from '../contracts/configuration.js';
import { normalizeEmploymentInput } from './fields.js';
import {
  commandContext,
  requireEmploymentScope,
  requireEmploymentWrite,
  scopedGuard,
  EMPLOYEE_OBJECT,
} from './context.js';
import { createEmployee, employeeName } from './employees.js';
import { entryContractSchema, generateEntryContract, requireContractCreateAccess } from './entry-contract.js';
import { lockEmploymentEmployee } from './record-store.js';
import type { EntryOptions } from './employee-status.js';
import type { BusinessKind, EmploymentContext, NormalizedEmploymentInput } from './types.js';
import { createEmploymentBusiness, latestTimelineRecord, sequenceViolation } from './write-service.js';

/** 起始日 = 入职日（不接受请求指定）；终止日必填（R2f1）。 */
const internContract = entryContractSchema.omit({ effectiveDate: true }).extend({ endDate: z.iso.date() });

export const internCreateInput = z
  .strictObject({
    kind: z.enum(['hire', 'rehire']),
    /** 重聘：rehire-matches 返回的候选人员。 */
    employeeId: z.uuid().optional(),
    /** 新增：工号与姓名；登录邮箱与 POST /employees 同口径，入职必填（DEC-140）。 */
    code: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    loginEmail: z.email().max(320).optional(),
    effectiveDate: z.iso.date(),
    formId: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).default({}),
    customFields: z.record(z.string(), z.unknown()).default({}),
    contract: internContract,
  })
  .superRefine((input, ctx) => {
    const rehire = input.kind === 'rehire';
    const bad = rehire
      ? input.employeeId === undefined || input.code !== undefined || input.name !== undefined
      : input.employeeId !== undefined || input.code === undefined || input.name === undefined;
    if (bad)
      ctx.addIssue({
        code: 'custom',
        message: rehire ? '重聘只能给 employeeId，不能给工号 / 姓名' : '新增须给工号和姓名，不能给 employeeId',
      });
  });
export type InternCreateInput = z.infer<typeof internCreateInput>;

/** 回执里的合同摘要：正式合同有合同 ID；待入职合同还不是合同模块的合同，id 为 null。 */
export interface InternContractSummary {
  readonly stage: 'formal' | 'pending';
  readonly id: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly companyId: string | null;
}

export interface InternCreateReceipt {
  /** = businessId：命令结果摘要提取器（command-result）只认 id / kind / revision，保持其通用而不为本回执适配。 */
  readonly id: string;
  readonly revision: number;
  readonly employeeId: string;
  readonly businessId: string;
  /** 实际保存的任职类型：重聘候选为退休时是 retire_rehire。 */
  readonly kind: 'hire' | 'rehire' | 'retire_rehire';
  /** 服务端判定的视图归属：入职已生效 = interning；未来入职 = pendingEntry（待入职列表）。 */
  readonly view: 'interning' | 'pendingEntry';
  readonly contract: InternContractSummary;
}

/** 解析后的写入计划：入口鉴权、命令内复核与执行共用同一份，不各自再算一遍。 */
export interface InternCreatePlan {
  readonly input: InternCreateInput;
  /** 任职业务请求体（鉴权按它的原始字段，同通用新增入口）与归一化后的写入值。 */
  readonly request: object;
  readonly business: NormalizedEmploymentInput;
  /** 入职日在租户今天之后：走待入职通道。 */
  readonly pending: boolean;
}

const PENDING_CONTRACT_KEYS = ['endDate', 'companyId'];

export function planInternCreate(ctx: EmploymentContext, input: InternCreateInput): InternCreatePlan {
  const employType = input.fields.employType;
  if (employType !== undefined && employType !== 'intern')
    throw new AppError('VALIDATION_FAILED', '新增实习生的用工类型只能是实习', { reason: 'INTERN_EMPLOY_TYPE' });
  // 终止日必须晚于起始日（= 入职日），与正式合同服务及其库约束同口径，待入职合同同样按此校验；
  // 校验失败码沿用平台的 VALIDATION_FAILED（400，AGENTS.md §10 无 422），与“早于”同一 reason
  if (input.contract.endDate <= input.effectiveDate)
    throw new AppError('VALIDATION_FAILED', '合同终止日期必须晚于入职日期', { reason: 'INTERN_CONTRACT_DATE_INVALID' });
  // 终止日必填，与“无固定期限”矛盾（合同服务会把无固定期限的终止日置空）
  if (input.contract.termType === 'indefinite')
    throw new AppError('VALIDATION_FAILED', '实习合同必须填写终止日期，不能选无固定期限', {
      reason: 'INTERN_CONTRACT_TERM_CONFLICT',
    });
  const pending = input.effectiveDate > tenantLocalDate(ctx.now, ctx.timezone);
  const extra = Object.keys(input.contract).filter((key) => !PENDING_CONTRACT_KEYS.includes(key));
  if (pending && extra.length)
    throw new AppError('VALIDATION_FAILED', '入职日在未来时合同只记终止日期和合同公司，其余合同字段办理入职时再填', {
      reason: 'INTERN_PENDING_CONTRACT_FIELDS',
      fields: extra,
    });
  const request = {
    kind: input.kind,
    mode: 'direct',
    effectiveDate: input.effectiveDate,
    ...(input.formId === undefined ? {} : { formId: input.formId }),
    fields: { ...input.fields, employType: 'intern' },
    customFields: input.customFields,
  };
  return { input, request, business: normalizeEmploymentInput(ctx, request), pending };
}

/** 入口与命令内复核共用的权限判定：人员新增权（看全部，DEC-121）+ 任职新增权与字段权；合同权限另在命令内复核。 */
export async function requireInternCreateWrite(
  employeeCtx: EmploymentContext,
  ctx: EmploymentContext,
  plan: InternCreatePlan,
) {
  const { input, business } = plan;
  const profile = input.kind === 'hire' ? { code: input.code, name: input.name } : {};
  await requireEmploymentWrite(employeeCtx, 'create', profile, 'Employee.Create', EMPLOYEE_OBJECT, {
    commandOnly: input.kind === 'rehire',
  });
  // 新员工尚无任职鉴权字段，仅显式看全部范围可创建；重聘判定带出离职人员信息，同一门槛（同 rehire-matches）
  requireEmploymentScope(employeeCtx);
  await requireEmploymentWrite(ctx, 'create', plan.request, 'Employment.Create');
  requireEmploymentScope(ctx, input.employeeId, business.fields.departmentId);
}

/**
 * 命令内复核（#199 / DEC-385③）：首次执行、同键重放、失败回查三个出口都按当前授权在命令事务内重过——
 * 人员 / 任职写权与范围（同入口），以及合同对象的字段创建权、“新建”按钮和（重聘时）对该员工的合同范围。
 */
export function internCreateGuard(
  deps: TenantRouteDeps,
  employeeCtx: EmploymentContext,
  ctx: EmploymentContext,
  plan: InternCreatePlan,
) {
  return scopedGuard({
    before: async (tx) => {
      const scopedEmployee = await commandContext(tx, deps, employeeCtx);
      const scoped = await commandContext(tx, deps, ctx);
      await requireInternCreateWrite(scopedEmployee, scoped, plan);
      if (plan.pending) return;
      const owner = { employeeId: plan.input.employeeId ?? null, effectiveDate: plan.input.effectiveDate };
      await requireContractCreateAccess(tx, deps, scoped, owner, plan.input.contract);
    },
  });
}

/**
 * 新增 = 建档；重聘 = 沿用候选。重聘在员工锁内统一复核：时间轴上员工当前最新一条（含未来待入职）必须是离职 / 退休，
 * 否则说明候选已被占用（已有待入职 / 重聘周期），按现有顺序规则拒绝；任职类型随结束类型选（退休后用 retire_rehire）。
 */
async function resolveEmployee(tx: Tx, context: EmploymentContext, input: InternCreateInput) {
  if (input.kind === 'hire') {
    const employee = await createEmployee(tx, context, { code: input.code!, name: input.name! });
    // 建档后员工行 revision 已不是 0，重新取锁读当前值
    const locked = await lockEmploymentEmployee(tx, context, employee.id);
    return { employeeId: employee.id, revision: locked.revision, kind: 'hire' as BusinessKind };
  }
  const locked = await lockEmploymentEmployee(tx, context, input.employeeId!, context.expectedRevision);
  const latest = await latestTimelineRecord(tx, context.tenantId, locked.id);
  const kind: BusinessKind = latest?.kind === 'retirement' ? 'retire_rehire' : 'rehire';
  const reason = sequenceViolation(latest?.kind, kind);
  if (reason) throw new AppError('CONFLICT', '任职业务前后顺序不合法', { reason });
  return { employeeId: locked.id, revision: locked.revision, kind };
}

/** 待入职合同：起始日 = 入职日，终止日必填；合同公司（可选）须是本租户的法人公司。 */
async function pendingEntry(tx: Tx, ctx: EmploymentContext, plan: InternCreatePlan): Promise<EntryOptions> {
  const { contract, effectiveDate } = plan.input;
  const companyId = contract.companyId ?? null;
  if (companyId) await verifyIds(tx, ctx.tenantId, 'contract_companies', [companyId]);
  return { pendingEntry: true, pendingContract: { startDate: effectiveDate, endDate: contract.endDate, companyId } };
}

export async function createInternEntry(
  tx: Tx,
  deps: TenantRouteDeps,
  context: EmploymentContext,
  plan: InternCreatePlan,
): Promise<InternCreateReceipt> {
  const { input, business, pending } = plan;
  const { employeeId, revision, kind } = await resolveEmployee(tx, context, input);
  const entry = pending ? await pendingEntry(tx, context, plan) : undefined;
  const created = await createEmploymentBusiness(
    tx,
    { ...context, expectedRevision: revision },
    employeeId,
    { ...business, kind },
    entry ? { entry } : {},
  );
  // 入职必须有登录账号（DEC-140）：与 POST /employees/:id/businesses 同一端口，缺邮箱整体回滚
  await provisionEmployeeUser(tx, context, {
    employeeId,
    loginEmail: input.loginEmail,
    displayName: await employeeName(tx, context.tenantId, employeeId),
    accountRequired: true,
  });
  // id / revision / kind 与任职业务回执同名，命令结果摘要（command-result summaryOf）据此定位业务（F-120）
  const base = {
    id: created.id,
    revision: created.revision,
    employeeId,
    businessId: created.id,
    kind: created.kind as InternCreateReceipt['kind'],
  };
  const { contract, effectiveDate } = input;
  if (pending)
    return {
      ...base,
      view: 'pendingEntry',
      contract: {
        stage: 'pending',
        id: null,
        startDate: effectiveDate,
        endDate: contract.endDate,
        companyId: contract.companyId ?? null,
      },
    };
  const formal = await generateEntryContract(tx, deps, context, { employeeId, effectiveDate }, contract);
  // 回执只取实际保存结果；合同服务按类型 / 累计规则把终止日置空时与“终止日必填”冲突，整单回滚而不是用请求值回填
  if (formal.endDate !== contract.endDate)
    throw new AppError('VALIDATION_FAILED', '合同未按所填终止日期保存（合同类型按无固定期限处理）', {
      reason: 'INTERN_CONTRACT_TERM_CONFLICT',
    });
  return {
    ...base,
    view: 'interning',
    contract: {
      stage: 'formal',
      id: 'resultId' in formal ? formal.resultId : formal.id,
      startDate: effectiveDate,
      endDate: formal.endDate,
      companyId: formal.companyId,
    },
  };
}
