import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantEnv } from '../../tenant-context.js';

/** DELETE 历来忽略 reason 等随带字段（AC-EXIT-cancel-round2）；本次只读取并校验 confirmed。 */
export async function deleteConfirmed(c: Context<TenantEnv>): Promise<boolean | undefined> {
  if (!c.req.header('content-type')) return undefined;
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined);
  return splitConfirmed(body).confirmed;
}

/** 确认是命令控制项，和任职字段的校验、权限分开（F-026）。 */
export function splitConfirmed(body: unknown): { rawInput: unknown; confirmed: boolean | undefined } {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !('confirmed' in body))
    return { rawInput: body, confirmed: undefined };
  const { confirmed, ...rest } = body as Record<string, unknown>;
  if (typeof confirmed !== 'boolean') throw new AppError('VALIDATION_FAILED', 'confirmed 必须为布尔值');
  return { rawInput: rest, confirmed };
}
