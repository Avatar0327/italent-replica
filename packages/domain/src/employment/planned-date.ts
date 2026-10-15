/**
 * 计划生效日（F-140 约束 1 / 2，DEC-499；DEC-431① 单一来源）：人工计划与系统实际执行日分开。
 * 每个载荷版本要么是人工写日期（新建、草稿 / 驳回 / 审批中修改、审批编辑、F-140b 的人工改期），计划 = 本版本日期；
 * 要么是系统派生（迟到顺延、向后更新、序列同步、状态传播），计划沿用上一版本。先后只看业务内单调的版本序号，
 * 不看事件时间戳或随机 ID（#100 第 7 轮 P2-01：同一事务的事件共用 created_at）。
 * SQL 侧由迁移 0130 的插入触发器维护 planned_effective_date，timeline.ts plannedEffectiveDate 读最新版本的该列，
 * 验收测试断言两边等价。
 */

export interface PlanVersion {
  /** 业务内单调递增的载荷版本序号（同一业务行锁下分配）。 */
  readonly versionNo: number;
  /** 本版本写入的生效日：人工版本是意图，派生版本是实际执行日。 */
  readonly effectiveDate: string;
  /** 人工写日期的版本；首版无论来源都视为人工。 */
  readonly manual: boolean;
}

export interface PlannedEffectiveDateInput {
  readonly versions: readonly PlanVersion[];
  /** 没有载荷版本时（如组织调整直接落地的记录）取的日期，通常为记录生效日。 */
  readonly fallback: string;
}

export function resolvePlannedEffectiveDate(input: PlannedEffectiveDateInput): string {
  const ordered = [...input.versions].sort((a, b) => a.versionNo - b.versionNo);
  let planned: string | null = null;
  ordered.forEach((version, index) => {
    if (index > 0 && ordered[index - 1]!.versionNo === version.versionNo)
      throw new RangeError(`载荷版本序号重复：${version.versionNo}`);
    if (planned === null || version.manual) planned = version.effectiveDate;
  });
  return planned ?? input.fallback;
}
