import { ApiError, type ApiClient } from '../client.js';
import { messages } from './messages.js';

/** F-120 本人命令结果摘要（docs/08_设计/F-120_本人命令结果查询_路由声明.md「返回结构」）。 */
export interface CommandResult {
  commandId: string;
  status: 'succeeded' | 'failed';
  commandType: string | null;
  businessType: string | null;
  businessId: string | null;
  revision: number | null;
  httpStatus: number | null;
  completedAt: string;
}
/** 内核按它落定结果未知的命令：成功放开锁，确定失败保留输入可改正重提，查不到保持只读。 */
export type ResultVerdict =
  | { status: 'succeeded'; businessId?: string }
  | { status: 'failed'; httpStatus: number | null }
  | { status: 'pending' };

export const commandResultPath = (commandId: string) => `/api/tenant/commands/${encodeURIComponent(commandId)}/result`;

// 缺省字段按 null 处理（设计「缺失时」列），类型不符才算无效。
const nullable = (value: unknown, type: 'string' | 'number') => value == null || typeof value === type;
/** 按真实接口形状校验；命令 ID 不是本次查询的一律当作无效回执（迟到 / 串号回执不能落到当前命令上）。 */
export function parseCommandResult(raw: unknown, commandId: string): CommandResult {
  const result = raw as Partial<CommandResult> | null;
  const valid =
    result?.commandId === commandId &&
    (result.status === 'succeeded' || result.status === 'failed') &&
    nullable(result.businessId, 'string') &&
    nullable(result.businessType, 'string') &&
    (result.revision == null || Number.isSafeInteger(result.revision)) &&
    (result.httpStatus == null || Number.isSafeInteger(result.httpStatus));
  if (!valid) throw new Error(messages.invalidReceipt);
  return result as CommandResult;
}

/** 唯一的结果查询入口（附件、实习、调动、审批共用）。 */
export async function readCommandResult(client: Pick<ApiClient, 'request'>, commandId: string, signal?: AbortSignal) {
  const raw = await client.request<unknown>(commandResultPath(commandId), { signal });
  return parseCommandResult(raw, commandId);
}

/**
 * F-120 三分支：200 succeeded → 交给 confirm 按业务读回核对（返回业务 ID，抛错即保持锁定）；
 * 200 failed → 确定失败；404 → 不是确定结论（可能仍在处理），保持“结果待确认”。其余查询错误原样抛出，内核保持只读。
 */
export async function queryCommandResult(
  client: Pick<ApiClient, 'request'>,
  commandId: string,
  confirm: (result: CommandResult) => Promise<string | undefined>,
): Promise<ResultVerdict> {
  let result: CommandResult;
  try {
    result = await readCommandResult(client, commandId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { status: 'pending' };
    throw error;
  }
  if (result.status === 'failed') return { status: 'failed', httpStatus: result.httpStatus ?? null };
  return { status: 'succeeded', businessId: await confirm(result) };
}
