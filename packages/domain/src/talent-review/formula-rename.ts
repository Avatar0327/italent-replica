/**
 * 改名守卫的往返校验（F-082 契约 §3.1 第 4 步）：被引用字段改名后，引用它的每个 bound 公式都必须能原样重提——
 * 用改名后的名称渲染出全文和逐处绑定，再按输入管道（checkInputLimits + bindFormula，全字段可见、带全部绑定证明）重新绑定，
 * 结果逐字等于原规范文本。不然保存时校验过的“渲染文本可原样重提”就在改名之后被打破（超长、词数过多、`A.B` 之类改变结构）。
 */
import { checkInputLimits } from '../expression/index.js';
import { bindFormula, renderFormula } from './formula-binding.js';

export type RenameBreakReason = 'TOO_LONG' | 'TOO_MANY_TOKENS' | 'NOT_PARSEABLE';
export type RenameRoundTrip = { readonly ok: true } | { readonly ok: false; readonly reason: RenameBreakReason };

/** fields：租户全部盘点字段，其中被改名的字段已是新名称。 */
export function checkRenameRoundTrip(
  stored: string,
  fields: readonly { readonly id: string; readonly name: string }[],
): RenameRoundTrip {
  const rendered = renderFormula(stored, { binding: 'bound', visibleFields: fields });
  if (!rendered.ok) return { ok: false, reason: 'NOT_PARSEABLE' };
  const limits = checkInputLimits(rendered.text);
  if (!limits.ok) return { ok: false, reason: limits.reason };
  // 全部引用都带证明，不会有新输入，目录版本不参与比较
  const bound = bindFormula(rendered.text, {
    visibleFields: fields,
    proofs: rendered.bindings,
    catalogVersion: { current: 0, submitted: 0 },
  });
  return bound.ok && bound.stored === stored ? { ok: true } : { ok: false, reason: 'NOT_PARSEABLE' };
}
