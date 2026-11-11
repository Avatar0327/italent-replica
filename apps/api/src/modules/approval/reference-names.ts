/**
 * F-474-3b 返工 P2-2：审批详情里引用字段的名称（单一入口，接在 employmentTypeNames 之后）。
 * 只给表单里已下发（已过字段裁剪）的 ID / 编码并列附名称：当前值与原值各自附，ID 与编码本身不改；
 * 所有查询带租户条件，查不到（停用 / 删除 / 跨租户）一律为 null，前端显示占位而不回落成 ID。
 * 披露口径（假设，见 PR 描述）：名称随已下发的 ID 一同呈现，与 F-323a 人员类别取名同口径，不再叠加组织模块的范围判断。
 */
import { sql, type Tx } from '@italent/db';
import { TRANSFER_REASONS, TRANSFER_TYPES, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { employeeName } from '../employment/employees.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { rowsOf } from './context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPARTMENT_KEYS = ['departmentId'] as const;
const PERSON_KEYS = ['directManagerId', 'dottedManagerId'] as const;
// 原因 / 调动类型是调动字典；离职等业务的 reasonCode 属于别的字典，所以只对调动单取名。
const CODE_KEYS = { reasonCode: 'reasons', transferTypeCode: 'types' } as const;

interface FormShape {
  values: Record<string, unknown>;
  originals?: Record<string, unknown>;
}

const stringsOf = (records: readonly Record<string, unknown>[], keys: readonly string[]) =>
  new Set(
    records.flatMap((record) =>
      keys.map((key) => record[key]).filter((v): v is string => typeof v === 'string' && !!v),
    ),
  );

async function dictionaryNames(tx: Tx, tenantId: string, kind: 'reasons' | 'types', codes: ReadonlySet<string>) {
  const names = new Map<string, string>(
    (kind === 'reasons' ? TRANSFER_REASONS : TRANSFER_TYPES).map((entry) => [entry.code, entry.name]),
  );
  if (!codes.size) return names;
  const table = sql.raw(kind === 'reasons' ? 'transfer_reasons' : 'transfer_types');
  // 历史单据保留当时的名称：租户覆盖项不论后来是否停用都参与取名
  for (const row of rowsOf<{ code: string; name: string }>(
    await tx.execute(sql`SELECT code,name FROM ${table}
      WHERE tenant_id=${tenantId} AND code IN (${sql.join(
        [...codes].map((code) => sql`${code}`),
        sql`,`,
      )})`),
  ))
    names.set(row.code, row.name);
  return names;
}

async function departmentNames(tx: Tx, ctx: TenantContext & { now: Date }, ids: ReadonlySet<string>) {
  const names = new Map<string, string>();
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  for (const id of ids) {
    if (!UUID.test(id)) continue;
    const [org] = await loadOrgSnapshot(tx, ctx.tenantId, today, undefined, { id, includeDisabled: true });
    if (org) names.set(id, org.name);
  }
  return names;
}

async function personNames(tx: Tx, tenantId: string, ids: ReadonlySet<string>) {
  const names = new Map<string, string>();
  for (const id of ids) {
    if (!UUID.test(id)) continue;
    try {
      names.set(id, await employeeName(tx, tenantId, id));
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
    }
  }
  return names;
}

export async function referenceNames<T extends { form: FormShape }>(
  tx: Tx,
  ctx: TenantContext & { now: Date },
  approvalType: string,
  view: T,
): Promise<T> {
  const records = [view.form.values, ...(view.form.originals ? [view.form.originals] : [])];
  const isTransfer = approvalType === 'transfer';
  const codeKinds = isTransfer ? (Object.entries(CODE_KEYS) as [keyof typeof CODE_KEYS, 'reasons' | 'types'][]) : [];
  const departments = await departmentNames(tx, ctx, stringsOf(records, DEPARTMENT_KEYS));
  const people = await personNames(tx, ctx.tenantId, stringsOf(records, PERSON_KEYS));
  const dictionaries = new Map<string, Map<string, string>>();
  for (const [key, kind] of codeKinds)
    dictionaries.set(key, await dictionaryNames(tx, ctx.tenantId, kind, stringsOf(records, [key])));
  const named = (record: Record<string, unknown>) => {
    const result = { ...record };
    const attach = (key: string, names: ReadonlyMap<string, string>) => {
      const value = record[key];
      // 已带名称的不覆盖：已办读取里的名称是办理时冻结的标签，不能被当前名称顶掉（F-476 P6）
      if (typeof value === 'string' && value && !Object.hasOwn(record, `${key}Name`))
        result[`${key}Name`] = names.get(value) ?? null;
    };
    for (const key of DEPARTMENT_KEYS) attach(key, departments);
    for (const key of PERSON_KEYS) attach(key, people);
    for (const [key] of codeKinds) attach(key, dictionaries.get(key)!);
    return result;
  };
  return {
    ...view,
    form: {
      ...view.form,
      values: named(view.form.values),
      ...(view.form.originals ? { originals: named(view.form.originals) } : {}),
    },
  };
}
