/** 权限模块的请求解析：If-Match（revision）、JSON 体校验、路径参数格式。 */
import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError } from '../../errors.js';

const IF_MATCH = /^(?:W\/)?"?(\d{1,9})"?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const OBJECT_CODE = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/;

/** 写请求必须携带对象 revision（AGENTS.md §10「并发」）。 */
export function ifMatch(c: Context): number {
  const match = IF_MATCH.exec(c.req.header('if-match')?.trim() ?? '');
  if (!match) throw new AppError('REVISION_REQUIRED', '写请求必须在 If-Match 中携带 revision');
  return Number(match[1]);
}

export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '请求体不合法', parsed.error.issues);
  return parsed.data;
}

/** 路径里的对象 ID；格式不对与不存在同样处理为 404，不泄露存在性。 */
export function idParam(c: Context, name: string): string {
  const value = c.req.param(name) ?? '';
  if (!UUID.test(value)) throw new AppError('NOT_FOUND', '对象不存在');
  return value;
}

export function objectCodeParam(c: Context): string {
  const value = c.req.param('objectCode') ?? '';
  if (!OBJECT_CODE.test(value)) throw new AppError('NOT_FOUND', '对象不存在');
  return value;
}

export function etag(c: Context, revision: number): void {
  c.header('ETag', `"${revision}"`);
}

export const revisionConflict = (expected: number, actual: number | undefined) =>
  new AppError('REVISION_CONFLICT', '对象已被他人修改，请刷新后重试', { expected, actual });
