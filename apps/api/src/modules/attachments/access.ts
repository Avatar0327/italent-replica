/**
 * F-479 用途守卫（设计 §4.1）。S1 只有一个用途 exit.handwritten_application，守卫走员工自助的“离职申请”入口：
 * - 写变体：绑定员工 + Exit.Self 按钮 + TenantBase.SelfExit.attachmentRefs 可编辑；每次写命令在事务内、查台账前复核
 *   （撤权后重放同键也得 403，不把旧命令当权限凭证）。
 * - 读变体：绑定员工 + Exit.Self 按钮 + attachmentRefs 可查看；缺按钮 / 未绑定 → 403，缺字段查看权 → 404（不暴露存在性）。
 * 其他入口（HR、经理、审批）不经这里，临时文件对它们不可见。
 */
import { type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { requireApplicationAccess } from '../employee-self-service/application-access.js';
import type { SelfAccess } from '../employee-self-service/access.js';
import { getModuleViewableFieldsInTransaction } from '../permission/module-access.js';

export const ATTACHMENT_FIELD = 'attachmentRefs';
export const attachmentNotFound = () => new AppError('NOT_FOUND', '附件不存在');

/** 写：Exit.Self 按钮 + attachmentRefs 可编辑（叠加授权器逐字段判 object.create）。 */
export async function requireAttachmentWrite(tx: Tx, self: SelfAccess): Promise<void> {
  await requireApplicationAccess(tx, self, 'exit', 'create', { [ATTACHMENT_FIELD]: [] });
}

/** 读：Exit.Self 按钮（403）+ attachmentRefs 可查看（404）。 */
export async function requireAttachmentRead(tx: Tx, self: SelfAccess): Promise<void> {
  await requireApplicationAccess(tx, self, 'exit');
  const visible = await getModuleViewableFieldsInTransaction(self.deps, self.ctx, EMPLOYMENT_OBJECT, tx);
  if (!visible?.has(ATTACHMENT_FIELD)) throw attachmentNotFound();
}
