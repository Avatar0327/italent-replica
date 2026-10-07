/** 人才标准接口的请求解析：If-Match revision、分页、路径与查询参数（UUID 小写规范化，DEC-194）。 */
import { isUuid } from '@italent/db';
import { TALENT_DIMENSION_TYPES, type TalentDimensionType } from '@italent/domain';
import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantEnv } from '../../tenant-context.js';

export function revision(c: Context): number {
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(c.req.header('if-match')?.trim() ?? '');
  if (!match) throw new AppError('REVISION_REQUIRED', '写请求必须在 If-Match 中携带 revision');
  return Number(match[1]);
}

export function requireNew(expectedRevision: number): void {
  if (expectedRevision !== 0) throw new AppError('REVISION_CONFLICT', '新建对象的 revision 必须为 0');
}

export async function parseBody<T>(c: Context<TenantEnv>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', parsed.error.issues);
  return parsed.data;
}

export function uuidParam(c: Context, name = 'id'): string {
  const value = c.req.param(name) ?? '';
  if (!isUuid(value)) throw new AppError('VALIDATION_FAILED', '对象标识必须为 UUID');
  return value.toLowerCase();
}

export function uuidQuery(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  if (!isUuid(value)) throw new AppError('VALIDATION_FAILED', `${name} 必须为 UUID`);
  return value.toLowerCase();
}

export function booleanQuery(c: Context, name: string): boolean | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  if (value !== 'true' && value !== 'false') throw new AppError('VALIDATION_FAILED', `${name} 必须为 true 或 false`);
  return value === 'true';
}

export function typeQuery(c: Context): TalentDimensionType | undefined {
  const value = c.req.query('type');
  if (value === undefined || value === '') return undefined;
  if (!(TALENT_DIMENSION_TYPES as readonly string[]).includes(value)) {
    throw new AppError('VALIDATION_FAILED', '指标类型不合法');
  }
  return value as TalentDimensionType;
}

export function nameQuery(c: Context): string | undefined {
  const value = c.req.query('name')?.trim();
  if (!value) return undefined;
  if (value.length > 200) throw new AppError('VALIDATION_FAILED', '名称过长');
  return value;
}

export function pageQuery(c: Context) {
  const page = queryInteger(c, 'page', 1, 1_000_000);
  const pageSize = queryInteger(c, 'pageSize', 50, 200);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

function queryInteger(c: Context, name: string, fallback: number, maximum: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new AppError('VALIDATION_FAILED', `${name} 必须为正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AppError('VALIDATION_FAILED', `${name} 超出允许范围`);
  }
  return value;
}
