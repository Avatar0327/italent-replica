/**
 * 取出 PostgreSQL 错误的 SQLSTATE（如 23P01 排除约束冲突）。
 * Drizzle 会把驱动错误包在 cause 里，PGlite 与 postgres-js 的错误对象都带 `code` 字段。
 */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
