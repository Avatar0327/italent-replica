/**
 * “模板是否被发展计划引用”的端口（IDP-R12，口径 K-25）。计划表随计划执行（PR-B）建立，届时登记判定函数；
 * 未登记前没有任何计划，模板一律未被引用。判定在调用方事务内执行，调用方已对模板行加锁。
 */
import type { Tx } from '@italent/db';

export type TemplateReferenceGuard = (tx: Tx, tenantId: string, templateId: string) => Promise<boolean>;

let guard: TemplateReferenceGuard | undefined;

export function registerTemplateReferenceGuard(next: TemplateReferenceGuard): void {
  guard = next;
}

export function templateReferencedByPlans(tx: Tx, tenantId: string, templateId: string): Promise<boolean> {
  return guard ? guard(tx, tenantId, templateId) : Promise.resolve(false);
}
