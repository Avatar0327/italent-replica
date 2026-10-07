import { fieldKey, fieldLeaves } from './fields.js';
import type { ApprovalDetail, ApprovalLog } from './types.js';

/** 日志标识：接口给 id 用 id，否则用序号；两者都没有的日志不参与字段收缩比较。 */
export function logKey(log: ApprovalLog): string {
  return log.id ?? (log.seq === undefined ? '' : `seq:${log.seq}`);
}
/** 日志里受权限裁剪的字段名集合（X-13 / DEC-119）；没有字段名数组的日志返回 null。 */
export function logFields(log: ApprovalLog): readonly string[] | null {
  const fields = log.detail.fields;
  return Array.isArray(fields) ? fields.map(String).sort() : null;
}
/**
 * DEC-288 ④：字段集合版本——表单叶子路径、原值路径、编辑元数据、详情日志的字段名集合与隐藏标志任一变化，
 * 展示层整体卸载重建，不做局部合并。revision、状态、动作不属于披露集合。
 */
export function disclosureVersion(detail: ApprovalDetail): string {
  const leaves = fieldLeaves(detail.form.values)
    .map((leaf) => fieldKey(leaf.path))
    .sort();
  const originals = detail.form.originals
    ? fieldLeaves(detail.form.originals)
        .map((leaf) => fieldKey(leaf.path))
        .sort()
    : [];
  const logs = detail.logs.map((log) => `${logKey(log)}:${(logFields(log) ?? ['*']).join(',')}`).sort();
  return JSON.stringify([
    detail.id,
    detail.recordsHidden,
    detail.form.editMode,
    [...detail.form.editableFields].sort(),
    leaves,
    originals,
    logs,
  ]);
}
/** 已展示过的日志字段名（详情自带日志 ∪ 已加载分页行），用于识别同一日志字段名缩减。 */
export function knownLogFields(detail: ApprovalDetail, rows: readonly ApprovalLog[]): Map<string, readonly string[]> {
  const known = new Map<string, readonly string[]>();
  for (const log of [...detail.logs, ...rows]) {
    const key = logKey(log);
    const fields = logFields(log);
    if (!key || !fields) continue;
    const seen = known.get(key) ?? [];
    known.set(key, [...new Set([...seen, ...fields])]);
  }
  return known;
}
/** DEC-277 / DEC-288：同一日志的字段名集合缩小即字段收紧信号（撤权后服务端裁掉字段名）。 */
export function logFieldsShrank(known: ReadonlyMap<string, readonly string[]>, items: readonly ApprovalLog[]): boolean {
  return items.some((log) => {
    const seen = known.get(logKey(log));
    const fields = logFields(log);
    return Boolean(seen && fields && seen.some((field) => !fields.includes(field)));
  });
}
