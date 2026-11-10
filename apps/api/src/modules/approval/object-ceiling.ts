/**
 * 办理份里附带对象的披露上限（F-476 P5 第 2 轮 P1，设计 §5.2「办理时不可见，后来授权也不补露」）。
 * 引擎在办理份上记的 disclosure_ceiling 只覆盖 snapshot.fieldObjectCode；业务 provider 一并冻结的、属于另一个字段对象的
 * 展示材料（如兼职申请里的员工头）由 provider 用这里的函数另存办理人对该对象的可见字段，已办读取时与当前字段权取交集。
 * DEC-834④ 只豁免当前数据范围，不豁免字段上限。
 */
import type { Tx } from '@italent/db';
import type { ApprovalContext } from './context.js';

/** 办理人对 objectCode 的办理时可见字段（排序保存）；null = 不受字段权限约束；未注入字段权解析时按看不到（fail-closed）。 */
export async function handlingCeilingOf(
  tx: Tx,
  ctx: Pick<ApprovalContext, 'userId' | 'fields'>,
  objectCode: string,
): Promise<string[] | null> {
  if (!ctx.fields) return [];
  const viewable = await ctx.fields.viewable(tx, ctx.userId, objectCode);
  return viewable ? [...viewable].sort() : null;
}

/** 读回保存的上限：null = 不受约束；缺键（DEC-402 不兼容旧份，正常不会出现）按看不到处理。 */
export function storedCeiling(stored: readonly string[] | null | undefined): ReadonlySet<string> | null {
  return stored === null ? null : new Set(stored ?? []);
}
