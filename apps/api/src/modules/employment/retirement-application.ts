/**
 * 退休申请的专有部分（R2-T04 §3.2）：退休不另写创建流程，与离职共用 createExitApplication / requireExitGate / activateExit，
 * 这里只有退休的差异——字段限制、创建时冻结预计退休日期 P 并派生退休类型、薄扩展行 retirement_requests。
 */
import { retirementRequests, sql, type Tx } from '@italent/db';
import { deriveRetireType, RETIREMENT_EXIT_KEYS } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ExitOptions } from './exit-initiation.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

/** 退休专有的创建入参。5a 为空；同时返聘（reEmployed / rehire）在 5b 加入。 */
export type RetirementCreateInput = Record<string, never>;

/** 请求里出现了离职专用字段（离职类型 / 原因 / 去向 / 结算 / 实际离岗日）→ 400；退休只收交接人、加黑、职责转交计划。 */
export function assertRetirementFields(exit: ExitOptions): void {
  const extra = Object.entries(exit)
    .filter(([key, value]) => value !== undefined && !(RETIREMENT_EXIT_KEYS as readonly string[]).includes(key))
    .map(([key]) => key);
  if (extra.length)
    throw new AppError('VALIDATION_FAILED', '退休申请不能填写离职专用字段', {
      reason: 'RETIREMENT_FIELD_NOT_ALLOWED',
      fields: extra,
    });
}

/** 创建后不可改的退休键（c1，§5）：是否同时返聘与返聘计划。 */
export const RETIREMENT_IMMUTABLE_KEYS = ['reEmployed', 'rehire'] as const;

export function assertRetirementImmutableKeys(raw: unknown): void {
  if (raw === null || typeof raw !== 'object') return;
  const found = RETIREMENT_IMMUTABLE_KEYS.filter((key) => Object.hasOwn(raw, key));
  if (found.length)
    throw new AppError('VALIDATION_FAILED', '是否同时返聘与返聘计划创建后不能修改', {
      reason: 'RETIREMENT_FIELD_IMMUTABLE',
      fields: found,
    });
}

/** 人员当前（最新版本）的预计退休日期；调用方已持员工行锁。 */
async function expectedRetirementDateOf(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const [row] = rowsOf<{ expected: string | null }>(
    await tx.execute(sql`SELECT expected_retirement_date::text AS expected FROM personnel_employee_versions
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid ORDER BY revision DESC LIMIT 1`),
  );
  return row?.expected ?? null;
}

/** 预览用：创建时将冻结的 P 与按它派生的退休类型（只读，不写）。 */
export async function previewRetirement(tx: Tx, ctx: EmploymentContext, employeeId: string, lastWorkDate: string) {
  const expected = await expectedRetirementDateOf(tx, ctx, employeeId);
  return { expectedRetirementDate: expected, retireType: deriveRetireType(lastWorkDate, expected) };
}

/**
 * 写退休薄扩展行（§3.2 第 6 步，在 exit_requests 之后、生效之前）：冻结 P（DEC-638 A-3）并派生退休类型。
 * 任何失败抛出 → 整个命令回滚（业务头、exit_requests、审计、命令台账都不留）。
 */
export async function writeRetirementExtension(
  tx: Tx,
  ctx: EmploymentContext,
  business: { readonly id: string; readonly employeeId: string; readonly lastWorkDate: string },
  _input: RetirementCreateInput,
) {
  const expected = await expectedRetirementDateOf(tx, ctx, business.employeeId);
  await tx.insert(retirementRequests).values({
    tenantId: ctx.tenantId,
    businessId: business.id,
    employeeId: business.employeeId,
    expectedRetirementDate: expected,
    retireType: deriveRetireType(business.lastWorkDate, expected),
  });
}

/** 退休生效顺延后按快照 P 重新派生退休类型（§3.5 / §4.3 R-1）；返回 { 旧, 新 }，不变时返回 null。 */
export async function rederiveRetireType(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  lastWorkDate: string,
): Promise<{ before: string | null; after: string | null } | null> {
  const [row] = rowsOf<{ expected: string | null; type: string | null }>(
    await tx.execute(sql`SELECT expected_retirement_date::text AS expected, retire_type AS type
      FROM retirement_requests WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid`),
  );
  if (!row) throw new AppError('CONFLICT', '退休扩展行缺失', { reason: 'NOT_PENDING' });
  const after = deriveRetireType(lastWorkDate, row.expected);
  if (after === row.type) return null;
  await tx.execute(sql`UPDATE retirement_requests SET retire_type=${after} WHERE tenant_id=${ctx.tenantId}
    AND business_id=${businessId}::uuid`);
  return { before: row.type, after };
}

export async function loadRetirementRequest(tx: Tx, tenantId: string, businessId: string) {
  const [row] = rowsOf<{ expectedRetirementDate: string | null; retireType: string | null; reEmployed: boolean }>(
    await tx.execute(sql`SELECT expected_retirement_date::text AS "expectedRetirementDate",
      retire_type AS "retireType", re_employed AS "reEmployed" FROM retirement_requests
      WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid`),
  );
  return row;
}
