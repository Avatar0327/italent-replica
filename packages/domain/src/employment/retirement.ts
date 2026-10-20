/**
 * 退休（R2-T04）的纯规则：退休类型派生与退休可写的扩展字段
 * （docs/08_设计/R2-T04_退休设计.md §3.5、§3.2，DEC-638 A-3）。
 */
import { addDays } from '../contracts/rules.js';

/** 退休类型：提前 / 正常 / 延迟（规格 RetireType）。 */
export const RETIRE_TYPES = ['early', 'normal', 'delayed'] as const;
export type RetireType = (typeof RETIRE_TYPES)[number];

/**
 * 由最后工作日 L 与创建时快照的预计退休日期 P 派生：L < P 提前、L = P 正常、L > P 延迟；P 为空无法判定。
 * 日期是租户业务日（YYYY-MM-DD），比较即字典序。
 */
export function deriveRetireType(lastWorkDate: string, expectedDate: string | null | undefined): RetireType | null {
  if (!expectedDate) return null;
  return lastWorkDate < expectedDate ? 'early' : lastWorkDate === expectedDate ? 'normal' : 'delayed';
}

/** 退休单可写的 exit 区块字段（§3.2）：交接人、加黑、职责转交计划；其余离职字段一律拒绝，在途调动确认令牌是门禁控制项。 */
export const RETIREMENT_EXIT_KEYS = [
  'handoverEmployeeId',
  'addToBlacklist',
  'dutyTransfer',
  'pendingTransferAck',
] as const;

/** 退休扩展字段（设计 §12.2）：退休类型、是否同时返聘、创建时快照的预计退休日期；都由系统写入，只可授查看。 */
export const RETIREMENT_REQUEST_FIELDS = ['retireType', 'reEmployed', 'expectedRetirementDate'] as const;

/**
 * 同时返聘的返聘任职生效日 R = 退休最终生效日 E′ + 1（DEC-637 A-1，设计 §8.1）：退休记录只覆盖 E′ 当天，次日接返聘。
 * 这是 R 的唯一来源——创建时预览 / 干跑、生效时生成、顺延后重算都只调它，不另存一份日期（DEC-638 A-15，DEC-431①）。
 */
export const retireRehireStartDate = (retirementEffectiveDate: string): string => addDays(retirementEffectiveDate, 1);
