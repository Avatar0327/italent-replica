/**
 * 答卷计时审计的披露口径（DEC-405①，F-060 收尾）。库内保存完整快照（含 openedAt / pageStartedAt，删除前快照也在），
 * 审计查看只披露“事件存在”：
 * - 可见字段只有所属活动 / 评价关系 / 套卷、翻页次数与删除标记，耗时和能算出耗时的时间字段一律不展示；
 * - 建立 / 翻页事件的发生时间（= 打开 / 翻页时刻）模糊到租户当地日 00:00（见 audit/timing-time.ts），清除是管理员动作，不模糊。
 * 拆成独立小文件，审计查看与写入两边引用同一份，不互相依赖。
 */
export const TIMING_AUDIT_TYPE = 'survey360-sheet-timing';

export const TIMING_ACTIONS = {
  open: 'survey360.sheet-timing.open',
  page: 'survey360.sheet-timing.page',
  clear: 'survey360.sheet-timing.clear',
} as const;

/** 审计查看可见的字段白名单（不含任何时间字段）。 */
export const TIMING_AUDIT_FIELDS = ['activityId', 'relationId', 'questionnaireId', 'pageCount', 'deleted'] as const;

/** 发生时间等于计时时刻、披露时要模糊的动作。 */
export const TIMING_BLURRED_ACTIONS: readonly string[] = [TIMING_ACTIONS.open, TIMING_ACTIONS.page];
