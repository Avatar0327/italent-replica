import { randomUUID } from 'node:crypto';

/** 最短有效长度：12 位十六进制 = 48 位随机，全量并行跑数千个对象也不会撞码（F-122）。 */
export const MIN_SUFFIX_LENGTH = 12;

/**
 * 测试里给带唯一约束的编码 / 邮箱 / 名称加后缀用。
 * 不要再对 randomUUID 截前几位当后缀（6～8 位）：24 位随机在 #305 的完整 CI 里撞过身份编码（409）。
 * 字段有长度上限时按上限传 length，但不得小于 MIN_SUFFIX_LENGTH（tests/guard-unique-suffix.test.ts 守卫）。
 */
export function uniqueSuffix(length = MIN_SUFFIX_LENGTH): string {
  if (!Number.isInteger(length) || length < MIN_SUFFIX_LENGTH) {
    throw new RangeError(`唯一后缀至少 ${MIN_SUFFIX_LENGTH} 位，收到 ${length}`);
  }
  let hex = '';
  while (hex.length < length) hex += randomUUID().replaceAll('-', '');
  return hex.slice(0, length);
}
