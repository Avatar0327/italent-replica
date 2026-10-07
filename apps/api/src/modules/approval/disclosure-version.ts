/**
 * 披露版本（DEC-288 止损：后端兜底）。服务端为“当前查看人 × 审批实例”计算披露指纹：当前可见的表单字段集合、
 * 原值字段集合、日志 / 任务历史里可见的字段名集合与 recordsHidden。完整详情、历史每一页、写响应都带上它；
 * 客户端在后续读写请求里回传最后看到的版本（`x-disclosure-version`），当前披露更收紧时服务端拒绝并要求整页刷新。
 * 版本是自描述的（编码了集合本身），服务端无需保存会话状态即可做“子集”比较。纯函数，无 IO。
 */
export interface DisclosureVersion {
  /** 表单可见字段（节点表单 ∩ 字段查看权，含审批通过后的两项日期）。 */
  readonly fields: readonly string[];
  /** 展示的原值字段（受租户开关控制）。 */
  readonly originals: readonly string[];
  /** 日志 / 任务历史里可见的字段名（全部日志，不限最近 200 条；记录隐藏时为空）。 */
  readonly logFields: readonly string[];
  readonly hidden: boolean;
}

export const DISCLOSURE_VERSION_HEADER = 'x-disclosure-version';
const PREFIX = '1.';
const NAME = /^[\w.:-]{1,100}$/;

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function encodeDisclosureVersion(version: DisclosureVersion): string {
  const payload = JSON.stringify([
    sorted(version.fields),
    sorted(version.originals),
    sorted(version.logFields),
    version.hidden ? 1 : 0,
  ]);
  return `${PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

function names(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null;
  return value.every((item) => typeof item === 'string' && NAME.test(item)) ? sorted(value as string[]) : null;
}

/** 解码客户端回传的版本；格式不合法返回 null（由调用方按 400 处理）。 */
export function decodeDisclosureVersion(encoded: string): DisclosureVersion | null {
  if (!encoded.startsWith(PREFIX) || encoded.length > 16_384) return null;
  const body = encoded.slice(PREFIX.length);
  if (!body || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return null;
  const [fields, originals, logFields, hidden] = parsed as unknown[];
  const decoded = { fields: names(fields), originals: names(originals), logFields: names(logFields) };
  if (!decoded.fields || !decoded.originals || !decoded.logFields || (hidden !== 0 && hidden !== 1)) return null;
  return { fields: decoded.fields, originals: decoded.originals, logFields: decoded.logFields, hidden: hidden === 1 };
}

function shrank(seen: readonly string[], current: readonly string[]): boolean {
  const now = new Set(current);
  return seen.some((name) => !now.has(name));
}

/**
 * 当前披露是否比客户端看到的更收紧：任一集合不再是超集，或 recordsHidden 由 false 变 true。
 * 只放宽（字段只增、隐藏解除）不算收紧。
 */
export function disclosureTightened(seen: DisclosureVersion, current: DisclosureVersion): boolean {
  return (
    (!seen.hidden && current.hidden) ||
    shrank(seen.fields, current.fields) ||
    shrank(seen.originals, current.originals) ||
    shrank(seen.logFields, current.logFields)
  );
}
