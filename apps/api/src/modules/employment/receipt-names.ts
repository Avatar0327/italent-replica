import type { Tx } from '@italent/db';
import type { CommandResult } from '../../commands.js';
import { employmentFormNames } from './employment-forms.js';
import { employmentTypeNames } from './employment-types.js';

/**
 * 回执里的字典显示值随命令保存（第 7 轮 P2-2，DEC-999）：用工形式、人员类别的名称原本在出口按字典现名补充，
 * 管理员改名后同键重放（直接 / 失败回查）的原文就与首次不同。现由带 receiptNames 标记的命令（调动单入口，DEC-1000）
 * 在命令事务里把整份回执涉及的编码 → 名称一并写进台账回执的保留键，出口先剥掉保留键，补名称时优先用保存的名称。
 * 只冻结名称：可见字段、范围外员工标识、前驱可见性仍在出口按当前授权与命令事务采用的范围裁剪（DEC-993）。
 * 保存的是整份回执（裁剪之前）的映射，出口只给裁剪后仍可见的编码补名称，不会多露出字段。
 */
export interface ReceiptNames {
  /** 用工形式编码 → 名称（命令执行时字典里没有该编码则为 null，与出口现查的口径一致）。 */
  readonly employmentForm: Readonly<Record<string, string | null>>;
  /** 人员类别标识 → 名称。 */
  readonly employmentType: Readonly<Record<string, string | null>>;
}

/** 台账回执里的保留键：不是任职字段，不会出现在执行体返回的业务对象里；出口一律先剥掉。 */
const RECEIPT_NAMES_KEY = '$receiptNames';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/** 收集已补名称的回执里每个编码对应的名称（按与出口相同的遍历：任何层级带字符串编码的对象）。 */
function namesOf(value: unknown, code: string, name: string, into: Record<string, string | null> = {}) {
  if (Array.isArray(value)) value.forEach((child) => namesOf(child, code, name, into));
  else if (isPlainObject(value)) {
    if (typeof value[code] === 'string') into[value[code]] = (value[name] as string | null | undefined) ?? null;
    Object.values(value).forEach((child) => namesOf(child, code, name, into));
  }
  return into;
}

/** 命令事务内：按本事务读到的字典名称给回执附上保留键（回执不是对象、或不含字典引用时原样返回）。 */
export async function withReceiptNames(tx: Tx, tenantId: string, result: CommandResult): Promise<CommandResult> {
  if (!isPlainObject(result.body)) return result;
  const named = await employmentTypeNames(tx, tenantId, await employmentFormNames(tx, tenantId, result.body));
  const names: ReceiptNames = {
    employmentForm: namesOf(named, 'employmentForm', 'employmentFormName'),
    employmentType: namesOf(named, 'employmentType', 'employmentTypeName'),
  };
  if (!Object.keys(names.employmentForm).length && !Object.keys(names.employmentType).length) return result;
  return { ...result, body: { ...result.body, [RECEIPT_NAMES_KEY]: names } };
}

/** 出口：剥掉保留键，交回业务回执与保存的名称（旧台账行没有保留键时 names 为 undefined，出口照旧现查）。 */
export function takeReceiptNames(body: unknown): { body: unknown; names?: ReceiptNames } {
  if (!isPlainObject(body) || !Object.hasOwn(body, RECEIPT_NAMES_KEY)) return { body };
  const { [RECEIPT_NAMES_KEY]: names, ...rest } = body;
  return { body: rest, names: names as ReceiptNames };
}
