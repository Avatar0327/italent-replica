/**
 * EV-R5 评价表锁的判定函数（拆分方案 B4）：评价表被“进行中（已发布）且已有提名人员（apply_count > 0）”的活动引用后，评分方式、
 * 满分、通过分数、总分计算规则、评分项区域全部锁定（规格 24 EV-R5；设计 §3.2：409 `FORM_LOCKED`）。
 * 本 PR 还没有活动表，判定恒为 false；B6 把它接到“已发布且 apply_count > 0 的活动环节引用本评价表”（拆分方案 B6 行），
 * 通过 `registerFormLock` 登记真实判定（测试也用它验证接线）。
 */
import type { Tx } from '@italent/db';

export type FormLockCheck = (tx: Tx, tenantId: string, formId: string) => Promise<boolean>;

const NEVER_LOCKED: FormLockCheck = async () => false;
let check: FormLockCheck = NEVER_LOCKED;

/** 登记（或以 null 撤销，回到恒 false）真实的锁判定。 */
export function registerFormLock(next: FormLockCheck | null): void {
  check = next ?? NEVER_LOCKED;
}

export function formLockedByActivities(tx: Tx, tenantId: string, formId: string): Promise<boolean> {
  return check(tx, tenantId, formId);
}
