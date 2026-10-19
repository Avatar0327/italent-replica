/**
 * 离职申请的发起方式与字段子集（R2-T03 §4B，DEC-283 预留）：hr / self（本人）/ manager（经理代发）。
 * self / manager 只能走子集（原因 personal / family、去向三选一、手写申请附件），HR 字段一律 400 而不是静默忽略；
 * 身份关系（本人绑定、直线经理、租户开关）由本文件校验，入口按钮归 F-020。
 */
import { sql, type Tx } from '@italent/db';
import {
  EXIT_MANAGER_INITIATION_KEY,
  EXIT_SELF_REASON_CODES,
  EXIT_SELF_WHEREABOUTS_CODES,
  tenantLocalDate,
} from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { currentPersons } from '../permission/scope-persons.js';
import { normalizedUuid } from './fields.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export type ExitInitiation = 'hr' | 'self' | 'manager';

const code = z.string().trim().min(1).max(100);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** 请求体里的 exit 区块（通用入口与专用入口同形）；不含 initiation：HTTP 入口的发起方式由路由固定。 */
export const exitOptionsSchema = z.strictObject({
  reasonCode: code.optional(),
  whereaboutsCode: code.optional(),
  exitTypeCode: code.optional(),
  attachmentRefs: z.array(normalizedUuid).max(20).optional(),
  handoverEmployeeId: normalizedUuid.optional(),
  addToBlacklist: z.boolean().optional(),
  compensationAmount: z.number().min(0).max(1e11).optional(),
  nonCompeteAmount: z.number().min(0).max(1e11).optional(),
  lastPayDate: day.optional(),
  socialInsuranceEndMonth: month.optional(),
  annualLeaveSettled: z.boolean().optional(),
  taxPeriod: month.optional(),
  taxYear: z.int().min(1900).max(9999).optional(),
  employerName: z.string().trim().min(1).max(200).optional(),
  actualLeaveDate: day.optional(),
  /** 职责转交计划（§5.7）：结构由 transfer/linkage/input.ts 的 normalizeLinkage 校验，只允许 dutyTransfer 区块。 */
  dutyTransfer: z.unknown().optional(),
  /** §8 在途调动确认令牌。 */
  pendingTransferAck: z.string().max(200).optional(),
});
export type ExitOptions = z.infer<typeof exitOptionsSchema>;

const HR_ONLY: readonly (keyof ExitOptions)[] = [
  'exitTypeCode',
  'handoverEmployeeId',
  'addToBlacklist',
  'compensationAmount',
  'nonCompeteAmount',
  'lastPayDate',
  'socialInsuranceEndMonth',
  'annualLeaveSettled',
  'taxPeriod',
  'taxYear',
  'employerName',
  'actualLeaveDate',
  'dutyTransfer',
];

/** 路由用：从通用任职入口的请求体取出 exit 区块，其余交给任职字段校验。 */
export function splitExitOptions(body: unknown): { rawInput: unknown; exit: ExitOptions } {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !('exit' in body))
    return { rawInput: body, exit: {} };
  const { exit, ...rawInput } = body as Record<string, unknown>;
  const parsed = exitOptionsSchema.safeParse(exit);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '离职字段不合法', parsed.error.issues);
  return { rawInput, exit: parsed.data };
}

const reject = (reason: string, message: string, details: object = {}) =>
  new AppError('VALIDATION_FAILED', message, { reason, ...details });

/** 按发起方式选字段子集并校验；返回补缺省后的 exit（self / manager 的原因缺省 personal）。 */
export function applyInitiationSubset(
  initiation: ExitInitiation,
  mode: 'application' | 'direct',
  exit: ExitOptions,
): ExitOptions {
  if (initiation === 'hr') return exit;
  if (mode !== 'application') throw reject('EXIT_DIRECT_ONLY_HR', '本人申请与经理代发只能走离职申请');
  const extra = HR_ONLY.filter((key) => exit[key] !== undefined);
  if (extra.length)
    throw reject('EXIT_FIELD_NOT_ALLOWED_FOR_INITIATION', '该发起方式不能填写 HR 字段', { fields: extra });
  const reasonCode = exit.reasonCode ?? 'personal';
  if (!(EXIT_SELF_REASON_CODES as readonly string[]).includes(reasonCode))
    throw reject('EXIT_REASON_NOT_ALLOWED', '离职原因只能选个人原因或家庭原因');
  // TODO(需取证 Q-M0-91)：去向是否必填原站截图未标注，暂按必填实现（设计 §4B）
  if (!exit.whereaboutsCode) throw reject('EXIT_WHEREABOUTS_REQUIRED', '请选择离职后去向');
  if (!(EXIT_SELF_WHEREABOUTS_CODES as readonly string[]).includes(exit.whereaboutsCode))
    throw reject('EXIT_WHEREABOUTS_NOT_ALLOWED', '离职后去向不在可选范围');
  return { ...exit, reasonCode };
}

/**
 * self / manager 只能提交最后工作日与 exit 子集：任职字段、自定义字段、表单选择、生效日一律 400（员工信息由服务端读取、只读带出）。
 * 否则调用方可改写部门 / 地点，污染申请快照与流程匹配输入（§4B）。
 */
export function assertBusinessInputSubset(
  initiation: ExitInitiation,
  input: {
    readonly fields?: object;
    readonly customFields?: object;
    readonly formId?: string;
    readonly effectiveDate?: string;
  },
): void {
  if (initiation === 'hr') return;
  const extra = [
    ...(Object.keys(input.fields ?? {}).length ? ['fields'] : []),
    ...(Object.keys(input.customFields ?? {}).length ? ['customFields'] : []),
    ...(input.formId === undefined ? [] : ['formId']),
    ...(input.effectiveDate === undefined ? [] : ['effectiveDate']),
  ];
  if (extra.length)
    throw reject('EXIT_FIELD_NOT_ALLOWED_FOR_INITIATION', '该发起方式只能提交最后工作日与离职申请字段', {
      fields: extra,
    });
}

async function boundEmployee(tx: Tx, ctx: EmploymentContext): Promise<string | undefined> {
  const [row] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`SELECT employee_id AS "employeeId" FROM permission_user_person_links
      WHERE tenant_id=${ctx.tenantId} AND user_id=${ctx.userId}::uuid`),
  );
  return row?.employeeId;
}

async function managerInitiationEnabled(tx: Tx, ctx: EmploymentContext): Promise<boolean> {
  // 系统值由 F-020 seed；没有系统行 / 覆盖时按关闭处理（fail-closed）
  const [row] = rowsOf<{ value: unknown }>(
    await tx.execute(sql`SELECT value FROM tenant_setting_overrides
      WHERE tenant_id=${ctx.tenantId} AND key=${EXIT_MANAGER_INITIATION_KEY} AND active`),
  );
  return row?.value === true;
}

/** self：员工须等于本人绑定；manager：开关开启，且当前用户是被离职人今天在岗主职记录的直线经理。 */
export async function assertInitiatorRelation(
  tx: Tx,
  ctx: EmploymentContext,
  initiation: ExitInitiation,
  employeeId: string,
): Promise<void> {
  if (initiation === 'hr') return;
  const bound = await boundEmployee(tx, ctx);
  if (initiation === 'self') {
    if (bound !== employeeId.toLowerCase()) throw new AppError('FORBIDDEN', '只能为绑定的本人发起离职');
    return;
  }
  if (!(await managerInitiationEnabled(tx, ctx)))
    throw new AppError('FORBIDDEN', '本租户未开启经理代发离职', { reason: 'EXIT_MANAGER_INITIATION_DISABLED' });
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const [team] = rowsOf<{ found: number }>(
    await tx.execute(sql`SELECT 1 AS found FROM (${currentPersons(ctx.tenantId, today)}) p
      WHERE p.employee_id=${employeeId}::uuid AND p.service_type='primary' AND p.kind NOT IN ('leave','retirement')
        AND p.direct_manager_id IS NOT NULL AND p.direct_manager_id=${bound ?? null}::uuid LIMIT 1`),
  );
  if (!team) throw new AppError('NOT_FOUND', '员工不存在');
}
