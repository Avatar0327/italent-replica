/**
 * 生成任职资格子集的任职业务类型（QL-R15②，DEC-335② 🟡）：入职（含重聘、退休返聘）、转正（含实习转正）、调动；
 * 离职 / 退休 / 组织调整不生成。C1-4 任职同步与 C1-5 初始化共用同一份，两条路径对同一条记录的取舍一致。
 */
export const SYNCED_KINDS: ReadonlySet<string> = new Set([
  'hire',
  'rehire',
  'retire_rehire',
  'regularization',
  'intern_regularization',
  'transfer',
]);
