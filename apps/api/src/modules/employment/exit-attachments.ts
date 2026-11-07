/**
 * F-479 S2：离职申请写入口里与附件有关的几步（从 exit-application.ts 拆出，保持两个写函数短小）。
 * 只有本人自助（bind=true）走绑定；其余出口（HR、经理、审批编辑）只比对，不同 400 且不写（设计 §2.4 R-2）。
 * 全部只能在命令 execute 内调用，守卫与台账重放路径不得调用（AC-ATT-24）。
 */
import type { Tx } from '@italent/db';
import { EXIT_CARRIER, assertRefsUnchanged, bindAttachmentRefs, refsOf } from '../attachments/binding.js';
import type { EmploymentContext } from './context.js';

/** 新建：本人带附件时按业务 ID 绑定并返回规范化列表；其余出口不带 / 为空才放行（入口已断言）。 */
export async function bindOnCreate(
  tx: Tx,
  ctx: EmploymentContext,
  bind: boolean | undefined,
  businessId: string,
  requested: unknown,
): Promise<string[] | undefined> {
  if (!bind || requested === undefined) return undefined;
  const actor = ctx.userId;
  return bindAttachmentRefs(tx, ctx, { carrier: EXIT_CARRIER, businessId, previous: [], next: requested, actor });
}

/** 权限链上的离职字段：本人自助带附件时含 attachmentRefs（字段查看 / 编辑权，AC-ATT-17），其余出口不含。 */
export function gateExit<T extends object>(bind: boolean | undefined, exit: T, requested: unknown): T {
  return bind && requested !== undefined ? { ...exit, attachmentRefs: requested } : exit;
}

interface WriteRefs {
  readonly bind: boolean | undefined;
  readonly businessId: string;
  readonly current: unknown;
  readonly nextRefs: unknown;
  /** 要写进扩展行的列值：绑定结果有变化时补 attachmentRefs。 */
  readonly values: Record<string, unknown>;
}

/** 编辑：本人走绑定（求差、封存分流）；其余出口只比对（不带 / 相同照常，不同 400）。 */
export async function writeRefs(tx: Tx, ctx: EmploymentContext, input: WriteRefs): Promise<void> {
  const previous = refsOf(input.current);
  if (input.nextRefs === undefined || !input.bind) return assertRefsUnchanged(previous, input.nextRefs);
  const bound = await bindAttachmentRefs(tx, ctx, {
    carrier: EXIT_CARRIER,
    businessId: input.businessId,
    previous,
    next: input.nextRefs,
    actor: ctx.userId,
  });
  if (bound.join() !== previous.map((id) => id.toLowerCase()).join()) input.values.attachmentRefs = bound;
}
