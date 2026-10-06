/**
 * 对象操作日志（任务级）与失败命令审计的分类（docs/02_业务建模/20 §1、§3、§5 第 3 条；AGENTS.md §10「审计」）。
 * 原站组织员工的对象操作日志按“行为”记：批量编辑、导出、导入、Word 异步打印，详细信息为汇总（如「52条全部更新成功」）。
 */

export const AUDIT_BEHAVIORS = ['batch_update', 'import', 'export', 'download', 'print', 'purge'] as const;
export type AuditBehavior = (typeof AUDIT_BEHAVIORS)[number];

export const AUDIT_BEHAVIOR_LABELS: Readonly<Record<AuditBehavior, string>> = {
  batch_update: '批量编辑',
  import: '导入',
  export: '导出',
  download: '下载',
  print: '打印',
  purge: '日志清理',
};

export type AuditTaskResult = 'succeeded' | 'partial' | 'failed';

/** 任务结果与原站汇总文案：全部成功「N条全部更新成功」，部分成功「N条更新成功，M条失败」。 */
export function auditTaskSummary(
  behavior: AuditBehavior,
  counts: { readonly success: number; readonly failure: number },
): { readonly result: AuditTaskResult; readonly summary: string } {
  const verb = { batch_update: '更新', import: '导入', export: '导出', download: '下载', print: '打印', purge: '清理' }[
    behavior
  ];
  const result: AuditTaskResult = counts.failure === 0 ? 'succeeded' : counts.success === 0 ? 'failed' : 'partial';
  const total = counts.success + counts.failure;
  const summary =
    result === 'succeeded'
      ? `${total}条全部${verb}成功`
      : result === 'failed'
        ? `${total}条全部${verb}失败`
        : `${counts.success}条${verb}成功，${counts.failure}条失败`;
  return { result, summary };
}

/** 失败命令三类：业务失败（已确定回滚）/ 存储不可写 / 结果未知（可能已提交，须按原命令 ID 回查）。 */
export const COMMAND_FAILURE_OUTCOMES = ['business_failed', 'storage_unwritable', 'unknown'] as const;
export type CommandFailureOutcome = (typeof COMMAND_FAILURE_OUTCOMES)[number];

export const COMMAND_FAILURE_LABELS: Readonly<Record<CommandFailureOutcome, string>> = {
  business_failed: '业务失败',
  storage_unwritable: '存储不可写',
  unknown: '结果未知',
};
