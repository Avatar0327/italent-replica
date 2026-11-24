import { ApiError, type ApiClient } from '../client.js';
import { messages } from './messages.js';

/** F-120 本人命令结果摘要（docs/08_设计/F-120_本人命令结果查询_路由声明.md「返回结构」）。 */
export interface CommandResult {
  commandId: string;
  status: 'succeeded' | 'failed' | 'not_executed';
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
  | { status: 'not_executed' }
  | { status: 'pending' };

export const commandResultPath = (commandId: string) => `/api/tenant/commands/${encodeURIComponent(commandId)}/result`;

// 缺省字段按 null 处理（设计「缺失时」列），类型不符才算无效。
const absent = (value: unknown) => value === null || value === undefined;
const nullable = (value: unknown, type: 'string' | 'number') => absent(value) || typeof value === type;
/** 按真实接口形状校验；命令 ID 不是本次查询的一律当作无效回执（迟到 / 串号回执不能落到当前命令上）。 */
export function parseCommandResult(raw: unknown, commandId: string): CommandResult {
  const result = raw as Partial<CommandResult> | null;
  const valid =
    result?.commandId === commandId &&
    (result.status === 'succeeded' || result.status === 'failed' || validRollback(result)) &&
    nullable(result.businessId, 'string') &&
    nullable(result.businessType, 'string') &&
    (absent(result.revision) || Number.isSafeInteger(result.revision)) &&
    (absent(result.httpStatus) || Number.isSafeInteger(result.httpStatus));
  if (!valid) throw new Error(messages.invalidReceipt);
  // 缺省字段统一成 null：调用方按 === null 判断，不能因字段缺失绕过版本核对。
  return {
    ...(result as CommandResult),
    commandType: result.commandType ?? null,
    businessType: result.businessType ?? null,
    businessId: result.businessId ?? null,
    revision: result.revision ?? null,
    httpStatus: result.httpStatus ?? null,
  };
}

function validRollback(result: Partial<CommandResult>) {
  return (
    result.status === 'not_executed' &&
    result.businessId === null &&
    result.businessType === null &&
    result.revision === null &&
    typeof result.httpStatus === 'number' &&
    result.httpStatus >= 500 &&
    result.httpStatus < 600 &&
    typeof result.completedAt === 'string' &&
    Number.isFinite(Date.parse(result.completedAt))
  );
}

/** 唯一的结果查询入口（附件、实习、调动、审批共用）。 */
export async function readCommandResult(client: Pick<ApiClient, 'request'>, commandId: string, signal?: AbortSignal) {
  const raw = await client.request<unknown>(commandResultPath(commandId), { signal });
  return parseCommandResult(raw, commandId);
}

/**
 * F-120 / F-537：成功交给 confirm 按业务读回核对，确定失败或未执行交给内核解锁。
 * 404 保持结果待确认；其余查询错误原样抛出，内核保持只读。
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
  if (result.status === 'not_executed') return { status: 'not_executed' };
  return { status: 'succeeded', businessId: await confirm(result) };
}
